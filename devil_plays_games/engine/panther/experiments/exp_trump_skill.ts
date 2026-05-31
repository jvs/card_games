/**
 * exp_trump_skill.ts — does the trump-choice edge grow or shrink as play
 * improves?
 *
 * The trump CHOOSER is held fixed (the random-rollout oracle); only the SEAT
 * SKILL varies, equally on both sides (Panther kind = both Hunter kinds). For
 * each deal we play the same hand twice at skill L — once under the oracle's
 * chosen trump, once under a baseline suit — paired on cards and on each seat's
 * RNG, so the only difference is the trump. Baseline rotates through the four
 * suits (unbiased mean-over-suits by symmetry, one hand per deal).
 *
 *   edge(L) = mean over deals of (oracle tricks − baseline tricks)
 *
 * RR should reproduce the all-random ~0.75 anchor.
 *
 * Run:  DEALS=400 ITER=20 CHOOSE_ITER=40 tsx exp_trump_skill.ts R M O [--allow-perils-only]
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid, firstLeadSeat,
} from "../panther.js";
import { makePlayer, PlayerKind } from "../players.js";
import { TrumpChoice, dealHand, chooseTrump } from "../trump.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player = "A";
const DEALER: Player = "C";
const SUITS = ["Spades", "Diamonds", "Hearts", "Clubs"];

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function se(xs: number[]) {
  const m = mean(xs), v = mean(xs.map(x => (x - m) ** 2));
  return Math.sqrt(v / xs.length);
}

/** Play one deal at the given per-seat skill under a fixed trump; return
 *  Panther-side tricks. Seat RNGs are seeded from dealSeed so two calls on the
 *  same deal differ only in the trump. */
async function playWith(
  cfg: PantherConfig, dealSeed: number, kinds: Record<Player, PlayerKind>,
  choice: TrumpChoice, iters: number,
): Promise<number> {
  const hs = calcHandSize(cfg);
  const { st, seats } = dealHand(cfg, PLAYERS, DEALER, PANTHER, dealSeed);
  st.emit("HandStart", { dealer: DEALER });
  st.vars.trump = choice.perilsOnly ? null : choice.trump;
  const bid: Bid = { tricks: 1, trump: choice.trump, perilsOnly: choice.perilsOnly };
  st.emit("Bid", { player: PANTHER, ...bid });

  const answerers = new Map<Player | null, Answerer>();
  PLAYERS.forEach((p, i) =>
    answerers.set(p, makePlayer(kinds[p], p, st, PLAYERS, cfg, new Rng(dealSeed * 31 + i + 1), iters)));
  const fb = new Rng(dealSeed * 911 + 7);
  answerers.set(null, { answer: (r: Choice) => fb.choice(r.options) });

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
  }, cfg), answerers);

  return st.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${PANTHER}` || e.payload.seat === "crow")
  ).length;
}

async function main() {
  const N = parseInt(process.env.DEALS ?? "400");
  const ITER = parseInt(process.env.ITER ?? "20");          // seat MC iterations
  const CHOOSE_ITER = parseInt(process.env.CHOOSE_ITER ?? "40"); // oracle rollouts/suit
  const allowPerilsOnly = process.argv.includes("--allow-perils-only");
  const skills = (process.argv.slice(2).filter(a => !a.startsWith("--")) as PlayerKind[]);
  const configs: PlayerKind[] = skills.length ? skills : ["R", "M", "O"];
  const cfg = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);

  console.log(`trump-edge vs skill — N=${N}, seatIters=${ITER}, chooseIters=${CHOOSE_ITER}, handSize=${hs}`);
  console.log(`chooser = random-rollout oracle (fixed); baseline = rotating suit; equal skill both sides`);
  console.log(`perils-only ${allowPerilsOnly ? "allowed" : "off"}\n`);
  console.log(`skill   baseline   oracle    EDGE`);

  for (const k of configs) {
    const kinds: Record<Player, PlayerKind> = { A: k, B: k, C: k };
    const edges: number[] = [], oracles: number[] = [], bases: number[] = [];
    for (let d = 0; d < N; d++) {
      const dealSeed = d + 1;
      const choice = await chooseTrump(
        "oracle", cfg, PLAYERS, DEALER, PANTHER, dealSeed, allowPerilsOnly, CHOOSE_ITER, dealSeed * 7 + 1);
      const baseChoice: TrumpChoice = { trump: SUITS[d % SUITS.length], perilsOnly: false };
      const oTricks = await playWith(cfg, dealSeed, kinds, choice, ITER);
      const bTricks = await playWith(cfg, dealSeed, kinds, baseChoice, ITER);
      oracles.push(oTricks); bases.push(bTricks); edges.push(oTricks - bTricks);
    }
    console.log(
      `  ${`${k}${k}${k}`.padEnd(6)}` +
      ` ${mean(bases).toFixed(3).padStart(8)}` +
      ` ${mean(oracles).toFixed(3).padStart(8)}` +
      `  ${mean(edges) >= 0 ? "+" : ""}${mean(edges).toFixed(3)} ± ${se(edges).toFixed(3)}`
    );
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
