/**
 * sweep_perils_mult.ts — focused sweep on perilsOnlyMult.
 *
 * Question: at what perilsOnlyMult does Perils-Only become a genuine ~50%
 * choice for a rational agent?
 *
 * Setup: player A is always Panther.  B and C always pass in the auction,
 * so A wins with whatever bid they choose.  A's bid is chosen by a simple
 * EV evaluator: for each bid option, simulate MC_ITER random-play hands
 * assuming A wins with that bid and pick the option with the highest
 * expected score.  All card play (including A's) is random throughout.
 *
 * This isolates the purely mechanical question — does Perils-Only gain
 * enough tricks with no lesser trump to justify its (optional) score bonus?
 * — from auction competition and play-skill effects.
 *
 * Run:              tsx sweep_perils_mult.ts
 * Quick smoke test: HANDS=20 ITER=10 tsx sweep_perils_mult.ts
 */
import { Rng, Player, run } from "../../core.js";
import { Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize,
  newState, playHand, playTricks, clockwise, Bid, PlayTricksParams,
} from "../panther.js";
import {
  reconstructBelief, sampleWorld, buildSimState, Belief,
} from "../mc_panther.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BONUS_SWEEP = [0, 5, 10, 15, 20];
const PANTHER: Player = "A";
// dealer = "C"  →  auction order [A, B, C];  A bids first and cannot pass.
const DEALER:  Player = "C";
const PLAYERS: Player[] = ["A", "B", "C"];

// ---------------------------------------------------------------------------
// AlwaysPassAnswerer — B and C fold immediately; random for card play
// ---------------------------------------------------------------------------
class AlwaysPassAnswerer implements Answerer {
  constructor(private rng: Rng) {}
  answer(req: Choice): any {
    if (req.key === "bid") {
      if ((req.options as any[]).includes("pass")) return "pass";
      // First bidder can't pass — shouldn't happen for B/C here, but be safe.
      return this.rng.choice(req.options);
    }
    return this.rng.choice(req.options);
  }
}

// ---------------------------------------------------------------------------
// EV evaluation of a single bid option.
// Assumes the evaluating player wins the auction with exactly this bid.
// ---------------------------------------------------------------------------
async function evalBidOption(
  bid: Bid,
  belief: Belief,
  player: Player,
  allPlayers: Player[],
  cfg: PantherConfig,
  rng: Rng,
  iters: number,
): Promise<number> {
  const hs = calcHandSize(cfg);
  let total = 0;
  for (let i = 0; i < iters; i++) {
    const world  = sampleWorld(belief, player, allPlayers, cfg, rng);
    const simRng = new Rng(rng.int(2 ** 30));
    const simSt  = buildSimState(belief, world, player, allPlayers, cfg, simRng);
    simSt.vars.trump = bid.perilsOnly ? null : bid.trump;

    const order = clockwise(allPlayers, belief.dealer);
    const seats: [Player, string][] = [];
    for (const p of order) {
      seats.push([p, `hand:${p}`]);
      if (p === player) seats.push([player, "crow"]);
    }
    simSt.vars.seats  = seats;
    simSt.vars.panther = player;

    const params: PlayTricksParams = {
      seats,
      lead:               seats.findIndex(([, z]) => z === `hand:${player}`),
      handSize:           hs,
      panther:            player,
      bid,
      trickNum:           0,
      partialPlays:       [],
      partialLed:         null,
      forcedFromPartials: null,
      won:                Object.fromEntries(allPlayers.map(p => [p, 0])) as Record<Player, number>,
      crowWon:            0,
    };
    const randomAns: Answerer = { answer: (req: Choice) => rng.choice(req.options) };
    const result = await run(playTricks(simSt, params, cfg), randomAns);
    total += result[player] ?? 0;
  }
  return total / iters;
}

// ---------------------------------------------------------------------------
// BidEvalAnswerer — EV-based bid choice for player A; random play
// ---------------------------------------------------------------------------
class BidEvalAnswerer implements Answerer {
  constructor(
    private player:     Player,
    private st:         ReturnType<typeof newState>,
    private allPlayers: Player[],
    private cfg:        PantherConfig,
    private rng:        Rng,
    private iterations: number,
  ) {}

  async answer(req: Choice): Promise<any> {
    // Only intercept bid decisions; everything else is random.
    if (req.key !== "bid" || req.options.length <= 1) return this.rng.choice(req.options);

    const log    = this.st.viewFor(this.player);
    const belief = reconstructBelief(log, this.player, this.allPlayers, this.cfg);

    let best      = req.options[0];
    let bestScore = -Infinity;

    for (const opt of req.options as (Bid | "pass")[]) {
      const s = opt === "pass"
        ? 0  // pass is never available for first bidder; treat as 0 if it appears
        : await evalBidOption(
            opt, belief, this.player, this.allPlayers,
            this.cfg, this.rng, this.iterations,
          );
      if (s > bestScore) { bestScore = s; best = opt; }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Per-hand record
// ---------------------------------------------------------------------------
interface HandRecord {
  bidTricks:  number;
  perilsOnly: boolean;
  success:    boolean;
}

// ---------------------------------------------------------------------------
// Run N hands, always with A as Panther
// ---------------------------------------------------------------------------
async function runHands(
  cfg:      PantherConfig,
  nHands:   number,
  mcIter:   number,
  seedBase: number,
): Promise<HandRecord[]> {
  const records: HandRecord[] = [];

  for (let h = 0; h < nHands; h++) {
    const rng   = new Rng(seedBase + h);
    const st    = newState(PLAYERS, rng);
    const mcRng = new Rng(rng.int(2 ** 30));

    const answerers = new Map<Player | null, Answerer>([
      [PANTHER, new BidEvalAnswerer(PANTHER, st, PLAYERS, cfg, mcRng, mcIter)],
      ["B",     new AlwaysPassAnswerer(new Rng(rng.int(2 ** 30)))],
      ["C",     new AlwaysPassAnswerer(new Rng(rng.int(2 ** 30)))],
      // Fallback (prank sub-choices, etc.) — random
      [null,    { answer: (req: Choice) => rng.choice(req.options) }],
    ]);

    const scores = await run(playHand(st, DEALER, cfg), answerers);

    // Pull the winning bid out of the event log (last Bid event = A's bid)
    const bidEvents = st.log.filter(e => e.type === "Bid");
    if (!bidEvents.length) continue;
    const last = bidEvents[bidEvents.length - 1];
    records.push({
      bidTricks:  last.payload.tricks as number,
      perilsOnly: last.payload.perilsOnly as boolean,
      success:    (scores[PANTHER] ?? 0) > 0,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
interface Stats {
  nHands:         number;
  poRate:         number;   // fraction of hands where A chose Perils-Only
  poSuccess:      number;   // Panther success rate | Perils-Only
  regSuccess:     number;   // Panther success rate | regular trump
  poAvgBid:       number;   // mean bid level for PO hands
  regAvgBid:      number;   // mean bid level for regular hands
  overallSuccess: number;
}

function computeStats(records: HandRecord[]): Stats {
  const n   = records.length;
  const po  = records.filter(r =>  r.perilsOnly);
  const reg = records.filter(r => !r.perilsOnly);
  const avg  = (rs: HandRecord[]) => rs.length ? rs.reduce((s, r) => s + r.bidTricks, 0) / rs.length : 0;
  const succ = (rs: HandRecord[]) => rs.length ? rs.filter(r => r.success).length / rs.length : 0;
  return {
    nHands:         n,
    poRate:         po.length / n,
    poSuccess:      succ(po),
    regSuccess:     succ(reg),
    poAvgBid:       avg(po),
    regAvgBid:      avg(reg),
    overallSuccess: succ(records),
  };
}

const pct = (x: number) => (x * 100).toFixed(1) + "%";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N_HANDS = parseInt(process.env.HANDS ?? "150");
  const MC_ITER = parseInt(process.env.ITER  ?? "15");

  console.log("Perils-Only Flat Bonus Sweep");
  console.log("Setup : A always Panther · B+C always pass · all play random");
  console.log(`Config: ${N_HANDS} hands / bonus  ·  ${MC_ITER} sim-iters per bid option`);
  console.log("=".repeat(72));

  const results: Array<{ bonus: number; stats: Stats }> = [];

  for (let bi = 0; bi < BONUS_SWEEP.length; bi++) {
    const bonus = BONUS_SWEEP[bi];
    const cfg: PantherConfig = { ...DEFAULT_CONFIG, perilsOnlyBonus: bonus };

    process.stdout.write(`\nbonus=+${bonus}  [running…]`);
    const records = await runHands(cfg, N_HANDS, MC_ITER, bi * 200_000 + 1);
    const s = computeStats(records);
    results.push({ bonus, stats: s });

    const poAvg  = s.poAvgBid  > 0 ? s.poAvgBid.toFixed(1)  : " -- ";
    const regAvg = s.regAvgBid > 0 ? s.regAvgBid.toFixed(1) : " -- ";
    console.log(
      `\rbonus=+${String(bonus).padStart(2)}:` +
      `  po_rate=${pct(s.poRate).padStart(6)}` +
      `  po_success=${pct(s.poSuccess).padStart(6)}` +
      `  reg_success=${pct(s.regSuccess).padStart(6)}` +
      `  po_avg_bid=${poAvg.padStart(4)}` +
      `  reg_avg_bid=${regAvg.padStart(4)}` +
      `  overall_success=${pct(s.overallSuccess).padStart(6)}`
    );
  }

  // -------------------------------------------------------------------------
  // Crossover analysis
  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log("Crossover analysis (po_rate → 50%)\n");

  let foundCrossover = false;
  for (let i = 0; i + 1 < results.length; i++) {
    const a = results[i], b = results[i + 1];
    if (a.stats.poRate <= 0.5 && b.stats.poRate >= 0.5) {
      const t     = (0.5 - a.stats.poRate) / (b.stats.poRate - a.stats.poRate);
      const xover = a.bonus + t * (b.bonus - a.bonus);
      console.log(`  po_rate crosses 50% between bonus=+${a.bonus} and bonus=+${b.bonus}`);
      console.log(`  → estimated crossover: bonus ≈ +${xover.toFixed(1)} pts`);
      foundCrossover = true;
    }
  }

  const last  = results[results.length - 1].stats.poRate;
  const first = results[0].stats.poRate;

  if (!foundCrossover) {
    if (last < 0.5) {
      console.log("  po_rate never reached 50% across the full sweep.");
      console.log("  → Perils-Only is unattractive even at bonus=+20.");
      console.log("  → Extend the sweep, or Perils-Only may need no bonus at all.");
    } else if (first > 0.5) {
      console.log("  po_rate already >50% at bonus=+0.");
      console.log("  → Perils-Only is naturally dominant — consider a flat penalty instead.");
    }
  }

  // EV delta table
  console.log("\nSuccess-rate delta  (po_success − reg_success):");
  for (const { bonus, stats: s } of results) {
    const delta = s.poSuccess - s.regSuccess;
    const bar   = delta >= 0 ? "+" + pct(delta) : pct(delta);
    console.log(`  bonus=+${String(bonus).padStart(2)}:  ${bar.padStart(8)}  ${delta >= 0 ? "← PO wins more often" : "← PO wins less often"}`);
  }
  console.log("\n(Success delta reflects trick-winning difficulty, independent of the bonus.)");
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
