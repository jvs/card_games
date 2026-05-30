/**
 * matchup.ts — run games with arbitrary R/M/O/S players in each seat.
 *
 * Three seats: one Panther (controls own hand + the Crow) and two Hunters.
 * Bidding is skipped; we deal, fix the Panther + trump, emit the public
 * declaration (so viewFor players know who the Panther is and what trump is),
 * and play out the hand. Metric is Panther-side trick count (own hand + Crow)
 * out of handSize — constant-sum, so the Hunters' combined share is the rest.
 *
 * Usage:
 *   tsx matchup.ts                 # grid: Panther {R,M,O,S} × Hunters {RR,MM,OO,SS}
 *   tsx matchup.ts M S S           # single matchup: Panther M, Hunters S and S
 *   tsx matchup.ts R S S           # your example: random Panther vs two suicidal Hunters
 *
 * Env: DEALS, ITER (MC iterations), TRUMP, LEAD (panther|crow|left-of-panther).
 */
import { Rng, Player, run, Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, FirstLeader, calcHandSize,
  playTricks, Bid, firstLeadSeat,
} from "./panther.js";
import { makePlayer, PlayerKind } from "./players.js";
import { TrumpPolicy, chooseTrump, dealHand } from "./trump.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player = "A";
const DEALER: Player = "C";
const HUNTERS: Player[] = PLAYERS.filter(p => p !== PANTHER); // [B, C]
const KINDS: PlayerKind[] = ["R", "M", "O", "S"];

interface Stats {
  n: number;
  pantherMean: number;
  pantherSE: number;
  hunterMeans: Record<Player, number>;
  majorityRate: number; // fraction of hands the Panther takes > half the tricks
}

function trickCounts(log: { type: string; payload: any }[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const e of log)
    if (e.type === "TrickWon") c[e.payload.seat as string] = (c[e.payload.seat as string] ?? 0) + 1;
  return c;
}

async function runMatchup(
  cfg: PantherConfig, pKind: PlayerKind, hKinds: [PlayerKind, PlayerKind],
  N: number, iters: number,
  trumpPolicy: TrumpPolicy, allowPerilsOnly: boolean, trumpIters: number,
): Promise<Stats> {
  const hs = calcHandSize(cfg);
  let sum = 0, sumsq = 0, majority = 0;
  const hunterSums: Record<Player, number> = { [HUNTERS[0]]: 0, [HUNTERS[1]]: 0 };

  for (let d = 0; d < N; d++) {
    const dealSeed = d + 1;
    const { st, seats } = dealHand(cfg, PLAYERS, DEALER, PANTHER, dealSeed);
    st.emit("HandStart", { dealer: DEALER });

    // Set this hand's trump per policy (oracle/random/fixed). Then publish the
    // declaration so the viewFor players know panther + trump.
    const choice = await chooseTrump(
      trumpPolicy, cfg, PLAYERS, DEALER, PANTHER, dealSeed, allowPerilsOnly, trumpIters, dealSeed * 7 + 1);
    st.vars.trump = choice.perilsOnly ? null : choice.trump;
    const bid: Bid = { tricks: 1, trump: choice.trump, perilsOnly: choice.perilsOnly };
    st.emit("Bid", { player: PANTHER, ...bid });

    // One answerer per seat; null catches RNG / prank sub-choices.
    const kindBy: Record<Player, PlayerKind> = {
      [PANTHER]: pKind, [HUNTERS[0]]: hKinds[0], [HUNTERS[1]]: hKinds[1],
    };
    const answerers = new Map<Player | null, Answerer>();
    PLAYERS.forEach((p, i) =>
      answerers.set(p, makePlayer(kindBy[p], p, st, PLAYERS, cfg, new Rng(dealSeed * 31 + i + 1), iters)));
    const fbRng = new Rng(dealSeed * 911 + 7);
    answerers.set(null, { answer: (r: Choice) => fbRng.choice(r.options) });

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

    const c = trickCounts(st.log);
    const pt = (c[`hand:${PANTHER}`] ?? 0) + (c["crow"] ?? 0);
    sum += pt; sumsq += pt * pt;
    if (pt > hs / 2) majority++;
    for (const h of HUNTERS) hunterSums[h] += c[`hand:${h}`] ?? 0;
  }

  const mean = sum / N;
  const variance = Math.max(0, sumsq / N - mean * mean);
  return {
    n: N,
    pantherMean: mean,
    pantherSE: Math.sqrt(variance / N),
    hunterMeans: Object.fromEntries(HUNTERS.map(h => [h, hunterSums[h] / N])),
    majorityRate: majority / N,
  };
}

function parseKind(s: string | undefined): PlayerKind | null {
  const k = (s ?? "").toUpperCase();
  return (KINDS as string[]).includes(k) ? (k as PlayerKind) : null;
}

async function main() {
  const N = parseInt(process.env.DEALS ?? "300");
  const iters = parseInt(process.env.ITER ?? "30");
  const lead = (process.env.LEAD as FirstLeader) ?? "panther";
  const cfg: PantherConfig = { ...DEFAULT_CONFIG, firstLeader: lead };
  const hs = calcHandSize(cfg);

  const allowPerilsOnly = process.argv.includes("--allow-perils-only");
  const trumpArg = process.argv.find(a => a.startsWith("--trump="));
  const trumpPolicy: TrumpPolicy = trumpArg
    ? trumpArg.slice("--trump=".length) : `fixed:${process.env.TRUMP ?? "Spades"}`;
  const trumpIters = parseInt(process.env.TRUMP_ITER ?? "40");

  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const p = parseKind(args[0]);
  const h1 = parseKind(args[1]);
  const h2 = parseKind(args[2] ?? args[1]); // "M S" → Hunters S,S

  const trumpDesc = trumpPolicy === "oracle"
    ? `oracle(iters=${trumpIters}${allowPerilsOnly ? ",+perilsOnly" : ""})` : trumpPolicy;
  console.log(`matchup — N=${N}, iters=${iters}, handSize=${hs}, trump=${trumpDesc}, lead=${lead}`);
  console.log(`seats: Panther=${PANTHER}, Hunters=${HUNTERS.join(",")}  (Panther side = own hand + Crow)\n`);

  if (p && h1 && h2) {
    // Single detailed matchup.
    const s = await runMatchup(cfg, p, [h1, h2], N, iters, trumpPolicy, allowPerilsOnly, trumpIters);
    console.log(`Panther ${p}  vs  Hunters ${h1},${h2}`);
    console.log(`  Panther tricks : ${s.pantherMean.toFixed(3)} ± ${s.pantherSE.toFixed(3)}  (of ${hs})`);
    console.log(`  Hunter tricks  : ` +
      HUNTERS.map(h => `${h}=${s.hunterMeans[h].toFixed(3)}`).join("  ") +
      `  (combined ${(hs - s.pantherMean).toFixed(3)})`);
    console.log(`  Panther > half : ${(100 * s.majorityRate).toFixed(1)}%`);
    return;
  }

  // Grid: Panther kind (rows) × symmetric Hunter pairs (cols). Cell = Panther tricks.
  const hunterPairs: [PlayerKind, PlayerKind][] = KINDS.map(k => [k, k]);
  console.log(`Grid — cell = mean Panther tricks (of ${hs}). Rows: Panther kind. Cols: both Hunters.\n`);
  const header = "Panther\\Hun  " + KINDS.map(k => `${k}${k}`.padStart(8)).join("");
  console.log(header);
  for (const pk of KINDS) {
    const cells: string[] = [];
    for (const hp of hunterPairs) {
      const s = await runMatchup(cfg, pk, hp, N, iters, trumpPolicy, allowPerilsOnly, trumpIters);
      cells.push(s.pantherMean.toFixed(2).padStart(8));
    }
    console.log(`   ${pk.padEnd(9)}` + cells.join(""));
  }
  console.log(`\n(Higher = better for the Panther. SE ≈ ${(2.0 / Math.sqrt(N)).toFixed(2)} per cell at this N.)`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
