/**
 * sweep_panther.ts — parameter sweep to measure Panther balance.
 *
 * For each config in SWEEP_GRID, runs two agent pairing setups:
 *   mc_vs_random: one MC agent (player A) + two random opponents
 *   mc_vs_mc:     all three players use MC agents
 *
 * And two playout policies (random / greedy) so policy-dependence is visible
 * data rather than a hidden assumption.
 *
 * Balance metrics reported per config:
 *   bidSuccessRate    — fraction of hands Panther wins their bid
 *   avgWinningBid     — mean bid-tricks across all hands
 *   perilsOnlyRate    — fraction of hands Perils-Only is chosen
 *   perilsOnlySuccess — Panther success rate conditional on Perils-Only
 *   bidDistrib        — fraction of hands at each bid level
 *   trivialBidFlag    — true if >80% of bids land on the same level
 *
 * Run: tsx sweep_panther.ts
 * For a quick smoke test: HANDS=10 tsx sweep_panther.ts
 */
import { Rng, Player, run } from "./core.js";
import { Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize,
  newState, playHand, Bid,
} from "./panther.js";
import { MCAnswerer } from "./mc_panther.js";
import { RandomAnswerer } from "./core.js";

// ---------------------------------------------------------------------------
// Sweep grid — keep it small enough to finish in a few minutes.
// Each entry must satisfy (4×cardsPerSuit + perilsCount − woodsSize) % 4 = 0.
// ---------------------------------------------------------------------------
const SWEEP_GRID: Array<{ label: string; cfg: PantherConfig }> = [
  // Structural variations (handSize=10 baseline)
  { label: "baseline",           cfg: { ...DEFAULT_CONFIG } },
  { label: "fewer_perils",       cfg: { ...DEFAULT_CONFIG, perilsCount: 1, woodsSize: 1 } },
  { label: "smaller_woods",      cfg: { ...DEFAULT_CONFIG, woodsSize: 1, perilsCount: 1 } },
  { label: "shorter_game",       cfg: { ...DEFAULT_CONFIG, cardsPerSuit: 8, perilsCount: 5, woodsSize: 5 } },
  // Scoring variations (keep standard structure, vary multipliers)
  { label: "no_perils_bonus",    cfg: { ...DEFAULT_CONFIG, perilsOnlyMult: 1 } },
  { label: "big_perils_bonus",   cfg: { ...DEFAULT_CONFIG, perilsOnlyMult: 3 } },
  { label: "symmetric_scoring",  cfg: { ...DEFAULT_CONFIG, scoreSuccess: 10, scoreFailure: 10 } },
  { label: "low_failure_punish", cfg: { ...DEFAULT_CONFIG, scoreFailure: 2 } },
];

// Validate grid entries at startup
for (const { label, cfg } of SWEEP_GRID) {
  try { calcHandSize(cfg); }
  catch (e) { throw new Error(`SWEEP_GRID entry "${label}": ${e}`); }
}

// ---------------------------------------------------------------------------
// Per-hand statistics
// ---------------------------------------------------------------------------
interface HandRecord {
  bidTricks:    number;
  perilsOnly:   boolean;
  success:      boolean;
  pantherPlayer: Player;
}

function extractHandRecord(
  st: ReturnType<typeof newState>,
  handScores: Record<Player, number>,
): HandRecord {
  const bidEvent  = st.log.find(e => e.type === "Bid");
  const panther   = st.vars.panther as Player ?? st.players[0];

  if (!bidEvent) {
    // Forced winner with no competing bids — use defaults
    return { bidTricks: 1, perilsOnly: false, success: handScores[panther] > 0, pantherPlayer: panther };
  }

  const bid: Bid = {
    tricks:     bidEvent.payload.tricks as number,
    trump:      bidEvent.payload.trump as string | null,
    perilsOnly: bidEvent.payload.perilsOnly as boolean,
  };
  return {
    bidTricks:    bid.tricks,
    perilsOnly:   bid.perilsOnly,
    success:      handScores[panther] > 0,
    pantherPlayer: panther,
  };
}

// ---------------------------------------------------------------------------
// Run N hands with a given answerer factory, return per-hand records
// ---------------------------------------------------------------------------
async function runHands(
  players: Player[],
  cfg: PantherConfig,
  nHands: number,
  makeAnswerers: (st: ReturnType<typeof newState>) => Map<Player | null, Answerer>,
  seedBase: number,
): Promise<HandRecord[]> {
  const records: HandRecord[] = [];
  let dealer = players[0];

  for (let h = 0; h < nHands; h++) {
    const rng = new Rng(seedBase + h);
    const st = newState(players, rng);
    const answerers = makeAnswerers(st);
    const scores = await run(playHand(st, dealer, cfg), answerers);
    records.push(extractHandRecord(st, scores));
    dealer = players[(players.indexOf(dealer) + 1) % players.length];
  }
  return records;
}

// ---------------------------------------------------------------------------
// Compute balance statistics from hand records
// ---------------------------------------------------------------------------
interface BalanceStats {
  nHands:          number;
  bidSuccessRate:  number;
  avgWinningBid:   number;
  perilsOnlyRate:  number;
  perilsOnlySuccess: number;
  bidDistrib:      Record<number, number>;  // bid level → fraction
  trivialBidFlag:  boolean;
}

function computeStats(records: HandRecord[]): BalanceStats {
  if (!records.length) return {
    nHands: 0, bidSuccessRate: 0, avgWinningBid: 0,
    perilsOnlyRate: 0, perilsOnlySuccess: 0, bidDistrib: {}, trivialBidFlag: false,
  };

  const n = records.length;
  const successes     = records.filter(r => r.success).length;
  const perilsOnlyHands = records.filter(r => r.perilsOnly);
  const perilsOnlySucc  = perilsOnlyHands.filter(r => r.success).length;

  const bidCounts: Record<number, number> = {};
  let bidSum = 0;
  for (const r of records) {
    bidCounts[r.bidTricks] = (bidCounts[r.bidTricks] || 0) + 1;
    bidSum += r.bidTricks;
  }
  const bidDistrib: Record<number, number> = {};
  for (const [k, v] of Object.entries(bidCounts)) bidDistrib[Number(k)] = v / n;

  const topBidFraction = Math.max(...Object.values(bidCounts)) / n;

  return {
    nHands:          n,
    bidSuccessRate:  successes / n,
    avgWinningBid:   bidSum / n,
    perilsOnlyRate:  perilsOnlyHands.length / n,
    perilsOnlySuccess: perilsOnlyHands.length > 0 ? perilsOnlySucc / perilsOnlyHands.length : 0,
    bidDistrib,
    trivialBidFlag:  topBidFraction > 0.80,
  };
}

function formatStats(stats: BalanceStats): string {
  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  const distrib = Object.entries(stats.bidDistrib)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, v]) => `${k}:${pct(v)}`)
    .join(" ");
  return [
    `  n=${stats.nHands}`,
    `  bid_success=${pct(stats.bidSuccessRate)}`,
    `  avg_bid=${stats.avgWinningBid.toFixed(2)}`,
    `  perils_only=${pct(stats.perilsOnlyRate)}  (success_if_chosen=${pct(stats.perilsOnlySuccess)})`,
    `  bid_distrib: ${distrib}`,
    stats.trivialBidFlag ? "  *** TRIVIAL BID FLAG (>80% same bid level) ***" : "",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------
async function main() {
  const N_HANDS = parseInt(process.env.HANDS ?? "50");
  const MC_ITER = parseInt(process.env.ITER  ?? "30");
  const players: Player[] = ["A", "B", "C"];

  console.log(`Panther balance sweep — ${N_HANDS} hands/config, MC iterations=${MC_ITER}`);
  console.log("=".repeat(70));

  for (let gi = 0; gi < SWEEP_GRID.length; gi++) {
    const { label, cfg } = SWEEP_GRID[gi];
    const hs = calcHandSize(cfg);
    console.log(`\nConfig: ${label}`);
    console.log(`  perils=${cfg.perilsCount} cardsPerSuit=${cfg.cardsPerSuit} woods=${cfg.woodsSize} handSize=${hs}`);
    console.log(`  scoreSuccess=${cfg.scoreSuccess} scoreFailure=${cfg.scoreFailure} perilsOnlyMult=${cfg.perilsOnlyMult}`);

    for (const policy of ["random", "greedy"] as const) {
      // Distinct seedBase per (config, policy, pairing). Stride of 100000 keeps
      // per-hand seed ranges (seedBase + h) non-overlapping across all cells.
      const policyOff = policy === "greedy" ? 2 : 0;
      const baseRandom = (gi * 4 + policyOff + 0) * 100000 + 1;
      const baseMc     = (gi * 4 + policyOff + 1) * 100000 + 1;

      const mcVsRandom = await runHands(players, cfg, N_HANDS, (st) => {
        const gameRng = st.rng;
        const mcRng   = new Rng(gameRng.int(2 ** 30) + 999983);
        return new Map<Player | null, Answerer>([
          ["A", new MCAnswerer("A", st, players, cfg, mcRng, MC_ITER, policy)],
          [null, new RandomAnswerer(gameRng)],
        ]);
      }, baseRandom);

      const mcVsMc = await runHands(players, cfg, N_HANDS, (st) => {
        const gameRng = st.rng;
        const ans = new Map<Player | null, Answerer>();
        for (const p of players) {
          const pRng = new Rng(gameRng.int(2 ** 30) + players.indexOf(p) * 7919);
          ans.set(p, new MCAnswerer(p, st, players, cfg, pRng, MC_ITER, policy));
        }
        ans.set(null, { answer: (req: Choice) => gameRng.choice(req.options) });
        return ans;
      }, baseMc);

      console.log(`\n  policy=${policy}, MC vs Random:`);
      console.log(formatStats(computeStats(mcVsRandom)));
      console.log(`\n  policy=${policy}, MC vs MC:`);
      console.log(formatStats(computeStats(mcVsMc)));
    }

    console.log("-".repeat(70));
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
