/**
 * exp_trump_choice.ts — how much is naming the trump worth to the Panther?
 *
 * For each deal we estimate the expected Panther tricks under every candidate
 * trump (all-random play). Then:
 *   baseline (no choice) = mean over candidates           — a randomly-set trump
 *   oracle   (best choice)= the candidate with the highest EV
 *   advantage             = oracle − baseline
 *
 * Winner's-curse guard: the argmax is chosen on one independent sample of
 * rollouts (A) and its value is reported from a SECOND, independent sample (B).
 * Picking and scoring on the same sample would cherry-pick the suit that got
 * lucky and inflate the advantage. The baseline (a mean, not a max) is unbiased
 * either way and is taken from sample B.
 *
 * Metric is trick count; the real payoff is threshold-shaped (meeting a bid),
 * so this is a proxy — a lower bound on how much trump choice can matter.
 *
 * Run:  DEALS=1000 ITER=60 tsx exp_trump_choice.ts [--allow-perils-only]
 */
import { Player } from "./core.js";
import { PantherConfig, DEFAULT_CONFIG, calcHandSize } from "./panther.js";
import { TrumpChoice, trumpCandidates, trumpLabel, evalTrump } from "./trump.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player = "A";
const DEALER: Player = "C";

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function se(xs: number[]) {
  const m = mean(xs), v = mean(xs.map(x => (x - m) ** 2));
  return Math.sqrt(v / xs.length);
}

async function main() {
  const N = parseInt(process.env.DEALS ?? "1000");
  const ITER = parseInt(process.env.ITER ?? "60");
  const allowPerilsOnly = process.argv.includes("--allow-perils-only");
  // Vary the perils count to test how much the super-trump suppresses trump-choice
  // leverage. Hold handSize constant by absorbing perils into the Woods
  // (woods = perils ⇒ 4×10 + perils − perils = 40 ⇒ handSize 10), so the only
  // thing changing is how many always-win cards sit above the chosen trump.
  const perils = parseInt(process.env.PERILS ?? "5");
  const cfg: PantherConfig = { ...DEFAULT_CONFIG, perilsCount: perils, woodsSize: perils };
  const hs = calcHandSize(cfg);
  const cands = trumpCandidates(allowPerilsOnly);

  console.log(`trump-choice experiment — N=${N}, rollouts/suit/sample=${ITER}, handSize=${hs}`);
  console.log(`candidates: ${cands.map(trumpLabel).join(", ")}  (all-random play)\n`);

  const advantages: number[] = [];
  const baselines: number[] = [];
  const oracles: number[] = [];
  const spreads: number[] = [];                       // best − worst per hand (sample B)
  const chosenCount: Record<string, number> = {};
  const suitEV: Record<string, number[]> = {};
  for (const c of cands) { chosenCount[trumpLabel(c)] = 0; suitEV[trumpLabel(c)] = []; }

  for (let d = 0; d < N; d++) {
    const dealSeed = d + 1;
    const seedA = dealSeed * 1_000_003;
    const seedB = dealSeed * 1_000_003 + 500_000_000; // disjoint from A's range

    const evA: number[] = [];
    const evB: number[] = [];
    for (let i = 0; i < cands.length; i++) {
      evA.push(await evalTrump(cfg, PLAYERS, DEALER, PANTHER, dealSeed, cands[i], ITER, seedA + i * 1_000));
      evB.push(await evalTrump(cfg, PLAYERS, DEALER, PANTHER, dealSeed, cands[i], ITER, seedB + i * 1_000));
    }

    // Pick on A, value on B.
    let argA = 0;
    for (let i = 1; i < cands.length; i++) if (evA[i] > evA[argA]) argA = i;

    const chosenVal = evB[argA];
    const baseline = mean(evB);
    advantages.push(chosenVal - baseline);
    baselines.push(baseline);
    oracles.push(chosenVal);
    spreads.push(Math.max(...evB) - Math.min(...evB));
    chosenCount[trumpLabel(cands[argA])]++;
    cands.forEach((c, i) => suitEV[trumpLabel(c)].push(evB[i]));
  }

  console.log(`baseline (random trump) : ${mean(baselines).toFixed(3)}  (of ${hs}; ~${(hs / 2).toFixed(1)} expected by symmetry)`);
  console.log(`oracle   (best trump)   : ${mean(oracles).toFixed(3)} ± ${se(oracles).toFixed(3)}`);
  console.log(`ADVANTAGE of choosing   : ${mean(advantages).toFixed(3)} ± ${se(advantages).toFixed(3)} tricks`);
  console.log(`per-hand spread best−worst: ${mean(spreads).toFixed(3)} (how much trump matters at all)\n`);

  console.log("per-suit population EV (should be ~equal by symmetry):");
  for (const c of cands) console.log(`  ${trumpLabel(c).padEnd(11)} ${mean(suitEV[trumpLabel(c)]).toFixed(3)}`);

  console.log("\nchosen-suit distribution:");
  for (const c of cands)
    console.log(`  ${trumpLabel(c).padEnd(11)} ${((100 * chosenCount[trumpLabel(c)]) / N).toFixed(1)}%`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
