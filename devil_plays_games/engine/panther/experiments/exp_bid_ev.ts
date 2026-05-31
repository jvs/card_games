/**
 * exp_bid_ev.ts — turn the trick distribution into a BID decision.
 *
 * A bid is only interesting if the optimal bid VARIES across hands. This lens
 * measures that. Per deal: choose oracle trump, play K times at fixed skill,
 * and estimate p_make(b) = P(realized >= b) for each bid b. Then score each bid:
 *
 *   own-EV(b)    = p · (b · scoreSuccess)                 (Panther's own points)
 *   margin-EV(b) = p · (b · scoreSuccess)
 *                  − (1 − p) · (b · scoreFailure)         (each opponent is paid
 *                                                          on failure, so failing
 *                                                          costs you in the race)
 *
 * We report the EV curves on the AVERAGE hand (is any high bid ever worth it?)
 * and, more importantly, the distribution of the per-hand OPTIMAL bid (do hands
 * separate, or does everyone want the same bid?). Flat optimum ⇒ the auction is
 * theater; spread optimum ⇒ a real decision.
 *
 * Oracle make-probs (full-deal info) — an upper bound on separation; a real
 * bidder seeing only its own hand would separate less.
 *
 * Run:  DEALS=500 PLAYOUTS=12 ITER=20 CHOOSE_ITER=40 tsx exp_bid_ev.ts O
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

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

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
    seats, lead: firstLeadSeat(seats, PANTHER, PLAYERS, cfg),
    handSize: hs, panther: PANTHER, bid,
    trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
    won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
  }, cfg), answerers);

  return st.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${PANTHER}` || e.payload.seat === "crow")
  ).length;
}

async function main() {
  const N = parseInt(process.env.DEALS ?? "500");
  const K = parseInt(process.env.PLAYOUTS ?? "12");
  const ITER = parseInt(process.env.ITER ?? "20");
  const CHOOSE_ITER = parseInt(process.env.CHOOSE_ITER ?? "40");
  const skill = (process.argv.slice(2).filter(a => !a.startsWith("--"))[0] as PlayerKind) ?? "O";
  const cfg = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);
  const kinds: Record<Player, PlayerKind> = { A: skill, B: skill, C: skill };
  const SUCC = cfg.scoreSuccess, FAIL = cfg.scoreFailure;

  console.log(`bid-EV lens — N=${N} × K=${K}, skill=${skill}${skill}${skill}, handSize=${hs}`);
  console.log(`scoring: success +${SUCC}×bid to Panther; failure +${FAIL}×bid to EACH Hunter`);
  console.log(`margin-EV(b) = p·${SUCC}b − (1−p)·${FAIL}b  (oracle make-probs)\n`);

  // p_make[b] per hand
  const pByHand: number[][] = []; // pByHand[hand][b]
  for (let d = 0; d < N; d++) {
    const dealSeed = d + 1;
    const choice = await chooseTrump(
      "oracle", cfg, PLAYERS, DEALER, PANTHER, dealSeed, false, CHOOSE_ITER, dealSeed * 7 + 1);
    const realized: number[] = [];
    for (let k = 0; k < K; k++) realized.push(await playOnce(cfg, dealSeed, kinds, choice, ITER, k));
    const p: number[] = [];
    for (let b = 0; b <= hs; b++) p[b] = realized.filter(r => r >= b).length / K;
    pByHand.push(p);
  }

  // Margin-EV under different FAILURE rules (success fixed at SUCC×bid):
  //   perBid : −(1−p)·FAIL·b   (current — penalty grows with bid)
  //   flatF  : −(1−p)·F        (constant penalty regardless of bid)
  type Rule = { name: string; margEV: (p: number, b: number) => number };
  const rules: Rule[] = [
    { name: `perBid×${FAIL}`, margEV: (p, b) => p * b * SUCC - (1 - p) * b * FAIL },
    { name: "flat10",        margEV: (p, b) => p * b * SUCC - (1 - p) * 10 },
    { name: "flat20",        margEV: (p, b) => p * b * SUCC - (1 - p) * 20 },
    { name: "flat30",        margEV: (p, b) => p * b * SUCC - (1 - p) * 30 },
  ];

  const optBid = (h: number[], ev: (p: number, b: number) => number) => {
    let best = 1, bestV = -Infinity;
    for (let b = 1; b <= hs; b++) { const v = ev(h[b], b); if (v > bestV) { bestV = v; best = b; } }
    return best;
  };

  // Margin-EV on the average hand, per rule.
  console.log("margin-EV on the AVERAGE hand, by failure rule:");
  console.log(`   b   p_make` + rules.map(r => r.name.padStart(9)).join(""));
  for (let b = 4; b <= hs; b++) {
    const p = mean(pByHand.map(h => h[b]));
    console.log(`   ${b}  ${(100 * p).toFixed(1).padStart(6)}%` +
      rules.map(r => r.margEV(p, b).toFixed(1).padStart(9)).join(""));
  }

  // Per-hand optimal-bid distribution per rule (the separation test).
  console.log("\nper-hand OPTIMAL bid distribution by failure rule (% of hands):");
  console.log(`   b ` + rules.map(r => r.name.padStart(9)).join(""));
  const hist: Record<string, number[]> = {};
  for (const r of rules) {
    hist[r.name] = new Array(hs + 1).fill(0);
    for (const h of pByHand) hist[r.name][optBid(h, r.margEV)]++;
  }
  for (let b = 0; b <= hs; b++) {
    if (rules.every(r => hist[r.name][b] === 0)) continue;
    console.log(`   ${b} ` + rules.map(r => (100 * hist[r.name][b] / N).toFixed(1).padStart(9)).join(""));
  }
  console.log("\nmean optimal bid:        " +
    rules.map(r => `${r.name}=${mean(pByHand.map(h => optBid(h, r.margEV))).toFixed(2)}`).join("  "));
  console.log("% hands wanting bid ≥7:  " +
    rules.map(r => `${r.name}=${(100 * pByHand.filter(h => optBid(h, r.margEV) >= 7).length / N).toFixed(1)}%`).join("  "));
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
