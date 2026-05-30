/**
 * exp_trick_dist.ts — distribution of achievable Panther tricks PER HAND.
 *
 * Bidding is a tail decision conditioned on your own hand, so the mean is the
 * wrong statistic — we need the spread across hands. Per deal we:
 *   1. choose the trump with the random-rollout oracle, then
 *   2. play the hand K times at a fixed skill (equal both sides), recording
 *      each realized Panther-side trick count.
 * Per-hand EV = mean of those K. Across deals we report:
 *   - percentiles of per-hand EV  ("how good are the best hands")
 *   - pooled histogram of realized tricks
 *   - makeable-rate per bid b: P(realized >= b), and the fraction of HANDS
 *     where that probability clears 50% / 80% (i.e. hands you could bid b on).
 *
 * Metric is tricks; real payoff is points (threshold-shaped) — a proxy.
 *
 * Run:  DEALS=500 PLAYOUTS=10 ITER=20 CHOOSE_ITER=40 tsx exp_trick_dist.ts O [--allow-perils-only]
 */
import { Rng, Player, run, Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid, firstLeadSeat,
} from "./panther.js";
import { makePlayer, PlayerKind } from "./players.js";
import { TrumpChoice, dealHand, chooseTrump } from "./trump.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player = "A";
const DEALER: Player = "C";

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function pct(sorted: number[], p: number) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** One playout of a deal at the given skill under a fixed trump; returns
 *  Panther-side tricks. `salt` varies the seat RNGs across the K playouts. */
async function playOnce(
  cfg: PantherConfig, dealSeed: number, kinds: Record<Player, PlayerKind>,
  choice: TrumpChoice, iters: number, salt: number,
): Promise<number> {
  const hs = calcHandSize(cfg);
  const { st, seats } = dealHand(cfg, PLAYERS, DEALER, PANTHER, dealSeed);
  st.emit("HandStart", { dealer: DEALER });
  st.vars.trump = choice.perilsOnly ? null : choice.trump;
  const bid: Bid = { tricks: 1, trump: choice.trump, perilsOnly: choice.perilsOnly };
  st.emit("Bid", { player: PANTHER, ...bid });

  const answerers = new Map<Player | null, Answerer>();
  PLAYERS.forEach((p, i) =>
    answerers.set(p, makePlayer(kinds[p], p, st, PLAYERS, cfg,
      new Rng(dealSeed * 1009 + salt * 31 + i + 1), iters)));
  const fb = new Rng(dealSeed * 911 + salt * 13 + 7);
  answerers.set(null, { answer: (r: Choice) => fb.choice(r.options) });

  await run(playTricks(st, {
    seats,
    lead:               firstLeadSeat(seats, PANTHER, PLAYERS, cfg),
    handSize:           hs, panther: PANTHER, bid,
    trickNum:           0, partialPlays: [], partialLed: null, forcedFromPartials: null,
    won:                Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
  }, cfg), answerers);

  return st.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${PANTHER}` || e.payload.seat === "crow")
  ).length;
}

async function main() {
  const N = parseInt(process.env.DEALS ?? "500");
  const K = parseInt(process.env.PLAYOUTS ?? "10");
  const ITER = parseInt(process.env.ITER ?? "20");
  const CHOOSE_ITER = parseInt(process.env.CHOOSE_ITER ?? "40");
  const allowPerilsOnly = process.argv.includes("--allow-perils-only");
  const skillArg = (process.argv.slice(2).filter(a => !a.startsWith("--"))[0] as PlayerKind) ?? "O";
  const cfg = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);
  const kinds: Record<Player, PlayerKind> = { A: skillArg, B: skillArg, C: skillArg };

  console.log(`trick distribution — N=${N} deals × K=${K} playouts, skill=${skillArg}${skillArg}${skillArg}, handSize=${hs}`);
  console.log(`trump = random-rollout oracle (chooseIters=${CHOOSE_ITER}); equal skill both sides; perils-only ${allowPerilsOnly ? "on" : "off"}\n`);

  const perHandEV: number[] = [];
  const realizedHist = new Array(hs + 1).fill(0);
  let realizedTotal = 0;
  // makeable[b] over hands: prob(realized >= b) per hand
  const makeProbPerHand: Record<number, number[]> = {};
  for (let b = 0; b <= hs; b++) makeProbPerHand[b] = [];

  for (let d = 0; d < N; d++) {
    const dealSeed = d + 1;
    const choice = await chooseTrump(
      "oracle", cfg, PLAYERS, DEALER, PANTHER, dealSeed, allowPerilsOnly, CHOOSE_ITER, dealSeed * 7 + 1);

    const realized: number[] = [];
    for (let k = 0; k < K; k++)
      realized.push(await playOnce(cfg, dealSeed, kinds, choice, ITER, k));

    perHandEV.push(mean(realized));
    for (const r of realized) { realizedHist[r]++; realizedTotal++; }
    for (let b = 0; b <= hs; b++)
      makeProbPerHand[b].push(realized.filter(r => r >= b).length / K);
  }

  const sortedEV = [...perHandEV].sort((a, b) => a - b);
  console.log("per-hand expected tricks (oracle trump, skilled play):");
  console.log(`  mean ${mean(perHandEV).toFixed(2)}   ` +
    [10, 25, 50, 75, 90, 95, 99].map(p => `P${p}=${pct(sortedEV, p).toFixed(2)}`).join("  "));
  console.log(`  max-hand EV ${sortedEV[sortedEV.length - 1].toFixed(2)}\n`);

  console.log("pooled realized-trick histogram (over all playouts):");
  for (let t = 0; t <= hs; t++) {
    const frac = realizedHist[t] / realizedTotal;
    const bar = "#".repeat(Math.round(frac * 80));
    console.log(`  ${String(t).padStart(2)} ${(100 * frac).toFixed(1).padStart(5)}%  ${bar}`);
  }

  console.log("\nmakeable-rate per bid b:");
  console.log("   b   P(make)   hands≥50%   hands≥80%");
  for (let b = 5; b <= hs; b++) {
    const pooled = makeProbPerHand[b].length ? mean(makeProbPerHand[b]) : 0;
    const h50 = makeProbPerHand[b].filter(x => x >= 0.5).length / N;
    const h80 = makeProbPerHand[b].filter(x => x >= 0.8).length / N;
    console.log(`   ${b}  ${(100 * pooled).toFixed(1).padStart(6)}%  ${(100 * h50).toFixed(1).padStart(8)}%  ${(100 * h80).toFixed(1).padStart(8)}%`);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
