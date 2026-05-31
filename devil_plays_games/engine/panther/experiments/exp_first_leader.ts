/**
 * exp_first_leader.ts — does the Panther's edge come from leading first?
 *
 * All three seats play randomly. We deal each hand once and replay the SAME
 * deal under each opening-lead rule, so any difference is the lead rule alone:
 *
 *   panther          — Panther's own hand leads (rules-accurate default)
 *   crow             — the Crow leads (still Panther-controlled, so the Panther
 *                      still opens; only which Panther seat changes)
 *   left-of-panther  — a Hunter leads instead (removes the Panther's opening lead)
 *
 * Metric: average tricks taken by the Panther side (own hand + Crow) out of
 * handSize per hand. Panther + HunterB + HunterC = handSize, so the Hunters'
 * combined share is handSize − Panther.
 *
 * Run:  DEALS=2000 TRUMP=Spades tsx exp_first_leader.ts
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, FirstLeader, calcHandSize, deck, newState,
  playTricks, clockwise, Bid, firstLeadSeat,
} from "../panther.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player = "A";
const DEALER: Player = "C";
const SETTINGS: FirstLeader[] = ["panther", "crow", "left-of-panther"];

interface Tally { panther: number; hunters: number; pantherMajority: number; }

/** Play one all-random hand with the given opening-lead rule; return Panther
 *  tricks. `dealSeed` fixes the cards; `playSeed` fixes the random play, shared
 *  across settings so the comparison is paired on both. */
async function runHand(cfg: PantherConfig, dealSeed: number, playSeed: number): Promise<number> {
  const hs = calcHandSize(cfg);
  const st = newState(PLAYERS, new Rng(dealSeed));
  st.z("deck").cards = deck(cfg);
  st.shuffle("deck");
  for (const p of PLAYERS) st.deal("deck", `hand:${p}`, hs);
  st.deal("deck", "crow", hs);
  st.deal("deck", "woods", cfg.woodsSize);

  const order = clockwise(PLAYERS, DEALER);
  const seats: [Player, string][] = [];
  for (const p of order) {
    seats.push([p, `hand:${p}`]);
    if (p === PANTHER) seats.push([PANTHER, "crow"]);
  }
  const trump = process.env.TRUMP ?? "Spades";
  st.vars.trump = trump;
  st.vars.seats = seats;
  st.vars.panther = PANTHER;

  const bid: Bid = { tricks: 1, trump, perilsOnly: false };
  const playRng = new Rng(playSeed);
  const random: Answerer = { answer: (r: Choice) => playRng.choice(r.options) };

  await run(playTricks(st, {
    seats,
    lead:               firstLeadSeat(seats, PANTHER, PLAYERS, cfg),
    handSize:           hs,
    panther:            PANTHER,
    bid,
    trickNum:           0,
    partialPlays:       [],
    partialLed:         null,
    forcedFromPartials: null,
    won:                Object.fromEntries(PLAYERS.map(p => [p, 0])),
    crowWon:            0,
  }, cfg), random);

  return st.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${PANTHER}` || e.payload.seat === "crow")
  ).length;
}

async function main() {
  const N = parseInt(process.env.DEALS ?? "2000");
  const hs = calcHandSize(DEFAULT_CONFIG);
  console.log(`first-leader experiment — ${N} deals, all random, handSize=${hs}, trump=${process.env.TRUMP ?? "Spades"}`);
  console.log(`(naive seat-count share for the Panther's 2 of 4 seats = ${(hs / 2).toFixed(2)})\n`);

  const tallies: Record<FirstLeader, Tally> =
    Object.fromEntries(SETTINGS.map(s => [s, { panther: 0, hunters: 0, pantherMajority: 0 }])) as any;

  for (let d = 0; d < N; d++) {
    const dealSeed = d + 1;
    const playSeed = (d + 1) * 2654435761 % 2147483647; // shared across settings
    for (const s of SETTINGS) {
      const cfg = { ...DEFAULT_CONFIG, firstLeader: s };
      const pt = await runHand(cfg, dealSeed, playSeed);
      const t = tallies[s];
      t.panther += pt;
      t.hunters += hs - pt;
      if (pt > hs / 2) t.pantherMajority++;
    }
  }

  console.log("opening lead       Panther  Hunters   P>half");
  for (const s of SETTINGS) {
    const t = tallies[s];
    console.log(
      `  ${s.padEnd(16)} ${(t.panther / N).toFixed(3).padStart(7)}` +
      ` ${(t.hunters / N).toFixed(3).padStart(8)}` +
      ` ${((100 * t.pantherMajority) / N).toFixed(1).padStart(7)}%`
    );
  }

  const base = tallies["panther"].panther / N;
  console.log(`\nΔ Panther tricks vs default ("panther" leads):`);
  for (const s of SETTINGS)
    console.log(`  ${s.padEnd(16)} ${((tallies[s].panther / N) - base >= 0 ? "+" : "")}${((tallies[s].panther / N) - base).toFixed(3)}`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
