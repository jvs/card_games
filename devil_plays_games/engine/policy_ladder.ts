/**
 * policy_ladder.ts — Panther skill decomposition.
 *
 * Runs five play policies on the same dealt hands to isolate exactly where
 * skill lives in the game.
 *
 * Policies (Hunters always random except "def"):
 *   random   — all seats uniform-random (pure luck baseline)
 *   indep    — Panther plays greedy per-seat, no cross-hand awareness
 *   coord    — Panther avoids competing with its own other seat;
 *              underleads into the stronger hand when opportunity exists
 *   perfect  — coord + leads into Hunter weak suits (full information)
 *   def      — Panther random, Hunters play greedy (defensive ceiling)
 *
 * Derived premia:
 *   single-hand skill  = indep   − random   (knowing how to play a hand)
 *   coordination       = coord   − indep    (value of cross-hand harmony)
 *   info premium       = perfect − coord    (value of seeing Hunter cards)
 *   hunter ceiling     = def     − random   (how much skilled Hunters cost Panther)
 *
 * Run:              tsx policy_ladder.ts
 * Quick smoke test: DEALS=30 tsx policy_ladder.ts
 */
import { Rng, Player, run } from "./core.js";
import { Answerer, Choice, Event } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, deck,
  newState, playTricks, clockwise, trickWinner, Bid, PlayTricksParams,
} from "./panther.js";
import { State, Card } from "./cards.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SUITS    = ["Spades", "Diamonds", "Hearts", "Clubs"] as const;
const PANTHER: Player = "A";
const DEALER:  Player = "C";
const PLAYERS: Player[] = ["A", "B", "C"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cloneDealt(src: State, cfg: PantherConfig, rng: Rng): State {
  const dst = newState(PLAYERS, rng);
  for (const p of PLAYERS) dst.z(`hand:${p}`).cards = [...src.z(`hand:${p}`).cards];
  dst.z("crow").cards  = [...src.z("crow").cards];
  dst.z("woods").cards = [...src.z("woods").cards];
  return dst;
}

/** Plays already made in the current (incomplete) trick. */
function currentTrickPlays(log: Event[]): Array<{ seat: string; card: Card }> {
  let lastWon = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === "TrickWon") { lastWon = i; break; }
  }
  return log.slice(lastWon + 1)
    .filter(e => e.type === "Played")
    .map(e => ({ seat: e.payload.seat as string, card: e.payload.card as Card }));
}

/** Standard greedy card choice for a single hand. */
function greedyPlay(cards: Card[], led: string | null, trump: string | null): Card {
  const tier = (c: Card) =>
    c.get("suit") === "Perils" ? 2 : (trump && c.get("suit") === trump ? 1 : 0);
  if (led === null) {
    return cards.slice().sort((a, b) =>
      tier(b) !== tier(a) ? tier(b) - tier(a) : b.get("rank") - a.get("rank")
    )[0];
  }
  const inSuit = cards.filter(c => c.get("suit") === led);
  if (inSuit.length) return inSuit.sort((a, b) => b.get("rank") - a.get("rank"))[0];
  return cards.slice().sort((a, b) => a.get("rank") - b.get("rank"))[0];
}

function lowestLegal(cards: Card[], led: string | null): Card {
  const inSuit = led ? cards.filter(c => c.get("suit") === led) : [];
  const pool   = inSuit.length ? inSuit : cards;
  return pool.slice().sort((a, b) => a.get("rank") - b.get("rank"))[0];
}

// ---------------------------------------------------------------------------
// Answerer factories
// ---------------------------------------------------------------------------
type AnswererFactory = (simSt: State, trump: string | null, rng: Rng) => Answerer;

/** Policy 1: all random. */
const makeRandom: AnswererFactory = (_simSt, _trump, rng) => ({
  answer: (req: Choice) => rng.choice(req.options),
});

/** Policy 2: greedy per-seat Panther, random Hunters. */
const makeIndep: AnswererFactory = (_simSt, trump, rng) => ({
  answer(req: Choice): any {
    if (req.key !== "play" || req.player !== PANTHER) return rng.choice(req.options);
    return greedyPlay(req.options as Card[], req.meta?.led ?? null, trump);
  },
});

/**
 * Policy 3: Coordinated Panther.
 * Two rules on top of greedy:
 *   (a) Don't compete: if the other Panther seat is currently winning the
 *       trick, dump the lowest legal card instead of fighting for it.
 *   (b) Underlead: when leading, if the other Panther seat holds a clearly
 *       stronger card in some suit, lead the weakest card in that suit from
 *       this seat — setting up the other seat to take the trick.
 */
class CoordinatedAnswerer implements Answerer {
  constructor(
    protected trump:  string | null,
    protected simSt: State,
    protected rng:   Rng,
  ) {}

  answer(req: Choice): any {
    if (req.key !== "play" || req.player !== PANTHER) return this.rng.choice(req.options);
    const cards  = req.options as Card[];
    const led    = (req.meta?.led  as string | null) ?? null;
    const mySeat = (req.meta?.seat as string);
    const other  = mySeat === `hand:${PANTHER}` ? "crow" : `hand:${PANTHER}`;

    // (a) Don't compete with ourselves
    if (led !== null) {
      const plays = currentTrickPlays(this.simSt.log);
      const otherPlay = plays.find(p => p.seat === other);
      if (otherPlay) {
        const seats = this.simSt.vars.seats as [Player, string][];
        const allPlays: [number, Card][] = plays
          .map(p => [seats.findIndex(([, z]) => z === p.seat), p.card] as [number, Card])
          .filter(([i]) => i >= 0);
        if (allPlays.length > 0) {
          const winIdx  = trickWinner(allPlays, this.trump);
          if (seats[winIdx]?.[1] === other) return lowestLegal(cards, led);
        }
      }
    }

    // (b) Underlead when leading
    if (led === null) {
      const otherCards = [...this.simSt.z(other).cards];
      const underlead  = this.findUnderlead(cards, otherCards);
      if (underlead !== null) return underlead;
    }

    return greedyPlay(cards, led, this.trump);
  }

  protected findUnderlead(myCards: Card[], otherCards: Card[]): Card | null {
    // For each plain suit: if other hand's best card clearly beats mine (rank
    // difference > 2) AND I hold a genuinely low card (rank ≤ 9), lead that
    // low card to hand the trick over to the other seat.
    for (const suit of SUITS) {
      const mine   = myCards.filter(c => c.get("suit") === suit);
      const theirs = otherCards.filter(c => c.get("suit") === suit);
      if (!mine.length || !theirs.length) continue;
      const myBest    = Math.max(...mine.map(c => c.get("rank")));
      const theirBest = Math.max(...theirs.map(c => c.get("rank")));
      if (theirBest > myBest + 2) {
        const low = mine.slice().sort((a, b) => a.get("rank") - b.get("rank"))[0];
        if (low.get("rank") <= 9) return low;
      }
    }
    return null;
  }
}

/**
 * Policy 4: Perfect-information Panther.
 * Adds one rule on top of coord: when leading, prefer the suit where the
 * Panther's best card beats the Hunters' best card in that suit (i.e., pick
 * the suit where Hunters are weakest, using full hand knowledge).
 */
class PerfectInfoAnswerer extends CoordinatedAnswerer {
  answer(req: Choice): any {
    if (req.key !== "play" || req.player !== PANTHER) return this.rng.choice(req.options);
    const led = (req.meta?.led as string | null) ?? null;

    if (led === null) {
      const lead = this.bestLeadVsHunters(req.options as Card[]);
      if (lead !== null) return lead;
    }
    return super.answer(req);
  }

  private bestLeadVsHunters(cards: Card[]): Card | null {
    const hunterCards = PLAYERS
      .filter(p => p !== PANTHER)
      .flatMap(p => [...this.simSt.z(`hand:${p}`).cards]);

    let bestCard: Card | null = null;
    let bestMargin = -Infinity;

    for (const suit of SUITS) {
      const mine = cards.filter(c => c.get("suit") === suit);
      if (!mine.length) continue;
      const myBest      = Math.max(...mine.map(c => c.get("rank")));
      const hunterBest  = hunterCards
        .filter(c => c.get("suit") === suit)
        .reduce((m, c) => Math.max(m, c.get("rank")), 0);
      // margin > 0 means we can win against Hunters in this suit
      const margin = myBest - hunterBest;
      if (margin > bestMargin) {
        bestMargin = margin;
        bestCard   = mine.slice().sort((a, b) => b.get("rank") - a.get("rank"))[0];
      }
    }
    return bestCard;
  }
}

/** Policy 5: Panther random, Hunters greedy (Hunter defensive ceiling). */
const makeDef: AnswererFactory = (_simSt, trump, rng) => ({
  answer(req: Choice): any {
    if (req.key !== "play") return rng.choice(req.options);
    if (req.player === PANTHER) return rng.choice(req.options);
    return greedyPlay(req.options as Card[], req.meta?.led ?? null, trump);
  },
});

const POLICY_NAMES    = ["random", "indep", "coord", "perfect", "def"] as const;
type  PolicyName      = (typeof POLICY_NAMES)[number];
const POLICY_LABELS: Record<PolicyName, string> = {
  random:  "random  (baseline)",
  indep:   "indep   (per-seat greedy)",
  coord:   "coord   (cross-hand aware)",
  perfect: "perfect (full info)",
  def:     "def     (greedy hunters)",
};

function makeFactory(name: PolicyName): AnswererFactory {
  if (name === "random")  return makeRandom;
  if (name === "indep")   return makeIndep;
  if (name === "coord")   return (simSt, trump, rng) => new CoordinatedAnswerer(trump, simSt, rng);
  if (name === "perfect") return (simSt, trump, rng) => new PerfectInfoAnswerer(trump, simSt, rng);
  return makeDef;
}

// ---------------------------------------------------------------------------
// Core simulation
// ---------------------------------------------------------------------------
async function simTricks(
  dealSt:  State,
  trump:   string | null,
  cfg:     PantherConfig,
  rng:     Rng,
  factory: AnswererFactory,
): Promise<number> {
  const hs     = calcHandSize(cfg);
  const simSt  = cloneDealt(dealSt, cfg, new Rng(rng.int(2 ** 30)));
  const simRng = new Rng(rng.int(2 ** 30));
  const ans    = factory(simSt, trump, simRng);

  const order = clockwise(PLAYERS, DEALER);
  const seats: [Player, string][] = [];
  for (const p of order) {
    seats.push([p, `hand:${p}`]);
    if (p === PANTHER) seats.push([PANTHER, "crow"]);
  }
  simSt.vars.trump   = trump;
  simSt.vars.seats   = seats;
  simSt.vars.panther = PANTHER;

  const bid: Bid = { tricks: 1, trump, perilsOnly: false };
  await run(playTricks(simSt, {
    seats,
    lead:               seats.findIndex(([, z]) => z === `hand:${PANTHER}`),
    handSize:           hs,
    panther:            PANTHER,
    bid,
    trickNum:           0,
    partialPlays:       [],
    partialLed:         null,
    forcedFromPartials: null,
    won:                Object.fromEntries(PLAYERS.map(p => [p, 0])) as Record<Player, number>,
    crowWon:            0,
  }, cfg), ans);

  return simSt.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${PANTHER}` || e.payload.seat === "crow")
  ).length;
}

// ---------------------------------------------------------------------------
// Run N deals × 4 suits × all policies
// Returns matrix[deal][suitIdx][policyIdx] = tricks won
// ---------------------------------------------------------------------------
async function runDeals(
  cfg:      PantherConfig,
  nDeals:   number,
  seedBase: number,
): Promise<number[][][]> {
  const hs       = calcHandSize(cfg);
  const matrix: number[][][] = [];
  const factories = POLICY_NAMES.map(makeFactory);

  for (let d = 0; d < nDeals; d++) {
    const rng = new Rng(seedBase + d);
    const st  = newState(PLAYERS, rng);
    st.z("deck").cards = deck(cfg);
    st.shuffle("deck");
    for (const p of PLAYERS) st.deal("deck", `hand:${p}`, hs);
    st.deal("deck", "crow", hs);
    st.deal("deck", "woods", cfg.woodsSize);

    const dealRow: number[][] = [];
    for (const suit of SUITS) {
      const suitRow: number[] = [];
      for (const factory of factories)
        suitRow.push(await simTricks(st, suit, cfg, rng, factory));
      dealRow.push(suitRow);
    }
    matrix.push(dealRow);
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
interface PolicyStats {
  name:         PolicyName;
  avgTricks:    number;
  stdTricks:    number;    // across all deal×suit combos
  successCurve: number[];  // [bidLevel-1] → P(tricks ≥ bidLevel)
  p50:          number;
}

function computeStats(matrix: number[][][], hs: number): PolicyStats[] {
  return POLICY_NAMES.map((name, pi) => {
    const all: number[] = matrix.flatMap(deal => deal.map(suit => suit[pi]));
    const n      = all.length;
    const avg    = all.reduce((s, x) => s + x, 0) / n;
    const std    = Math.sqrt(all.reduce((s, x) => s + (x - avg) ** 2, 0) / n);
    const curve  = Array.from({ length: hs }, (_, b) => all.filter(t => t >= b + 1).length / n);
    const p50    = (() => {
      for (let i = 0; i + 1 < curve.length; i++) {
        if (curve[i] >= 0.5 && curve[i + 1] < 0.5) {
          const t = (curve[i] - 0.5) / (curve[i] - curve[i + 1]);
          return (i + 1) + t;
        }
      }
      return curve[0] < 0.5 ? 0 : hs + 1;
    })();
    return { name, avgTricks: avg, stdTricks: std, successCurve: curve, p50 };
  });
}

/** Per-deal skill range: how many tricks separate perfect from random. */
function dealSkillRange(matrix: number[][][]): number {
  const skillIndices = [0, 1, 2, 3]; // random, indep, coord, perfect
  let total = 0, count = 0;
  for (const deal of matrix) {
    for (const suit of deal) {
      const vals = skillIndices.map(pi => suit[pi]);
      total += Math.max(...vals) - Math.min(...vals);
      count++;
    }
  }
  return total / count;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function printLadder(stats: PolicyStats[], skillRange: number): void {
  const hs  = stats[0].successCurve.length;
  const H   = "─".repeat(78);
  const fmt = (x: number) => x.toFixed(2);
  const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";

  const random = stats.find(s => s.name === "random")!;

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\nSUMMARY");
  console.log(H);
  console.log(
    "policy".padEnd(32) +
    "avg tricks".padStart(11) +
    "std".padStart(6) +
    "p50".padStart(7) +
    "Δ-random".padStart(10) +
    "  premium label"
  );
  console.log(H);

  const prevTricks: number[] = [];
  for (const s of stats) {
    const delta = s.avgTricks - random.avgTricks;
    const dStr  = (delta >= 0 ? "+" : "") + delta.toFixed(2);
    const label = POLICY_LABELS[s.name];
    console.log(
      label.padEnd(32) +
      fmt(s.avgTricks).padStart(11) +
      fmt(s.stdTricks).padStart(6) +
      fmt(s.p50).padStart(7) +
      dStr.padStart(10) +
      (s.name === "indep"   ? "  ← single-hand skill"   : "") +
      (s.name === "coord"   ? "  ← + coordination"       : "") +
      (s.name === "perfect" ? "  ← + info (Hunter hands)" : "") +
      (s.name === "def"     ? "  ← Hunter defensive ceiling" : "")
    );
    prevTricks.push(s.avgTricks);
  }
  console.log(H);

  const indep   = stats.find(s => s.name === "indep")!;
  const coord   = stats.find(s => s.name === "coord")!;
  const perfect = stats.find(s => s.name === "perfect")!;
  const def     = stats.find(s => s.name === "def")!;

  const singleHand = indep.avgTricks   - random.avgTricks;
  const coordPrem  = coord.avgTricks   - indep.avgTricks;
  const infoPrem   = perfect.avgTricks - coord.avgTricks;
  const hunterCeil = def.avgTricks     - random.avgTricks;

  console.log(`\nIncremental premia:`);
  console.log(`  single-hand skill : ${singleHand >= 0 ? "+" : ""}${singleHand.toFixed(3)} tricks/deal`);
  console.log(`  coordination      : ${coordPrem  >= 0 ? "+" : ""}${coordPrem.toFixed(3)} tricks/deal`);
  console.log(`  info premium      : ${infoPrem   >= 0 ? "+" : ""}${infoPrem.toFixed(3)} tricks/deal`);
  console.log(`  hunter ceiling    : ${hunterCeil >= 0 ? "+" : ""}${hunterCeil.toFixed(3)} tricks/deal`);
  console.log(`\nDeal-level skill range (perfect − random on the same deal): ${skillRange.toFixed(3)} tricks avg`);

  // ── Success Curve ────────────────────────────────────────────────────────
  console.log("\nSUCCESS CURVE  (fraction of deals where Panther wins ≥ bid tricks)");
  console.log(H);
  const pNames = POLICY_NAMES.map(n => n.padStart(8));
  console.log("Bid  " + pNames.join("  "));
  console.log(H);
  for (let b = 0; b < hs; b++) {
    const bid = b + 1;
    const cols = stats.map(s => pct(s.successCurve[b]).padStart(8));
    console.log(String(bid).padStart(3) + "  " + cols.join("  "));
  }
  console.log(H);

  // ── Trick distribution ───────────────────────────────────────────────────
  console.log("\nTRICK DISTRIBUTION  (P(Panther wins exactly k tricks))");
  console.log(H);
  console.log("  k  " + pNames.join("  "));
  console.log(H);
  for (let k = 0; k <= hs; k++) {
    const cols = stats.map(s => {
      const above = k < hs ? s.successCurve[k] : 0;  // P(≥k+1)
      const here  = (k > 0 ? s.successCurve[k - 1] : 1) - above;
      return pct(here).padStart(8);
    });
    console.log(String(k).padStart(3) + "  " + cols.join("  "));
  }
  console.log(H);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N_DEALS = parseInt(process.env.DEALS ?? "500");

  console.log("Panther Policy Ladder");
  console.log(`Config: default (handSize=${calcHandSize(DEFAULT_CONFIG)}, perils=${DEFAULT_CONFIG.perilsCount}, woods=${DEFAULT_CONFIG.woodsSize})`);
  console.log(`Deals: ${N_DEALS}  ×  4 trump suits = ${N_DEALS * 4} observations per policy`);
  console.log("(Hunters always random except in 'def'; PO excluded — studying regular play)");

  process.stdout.write("\nRunning...");
  const matrix = await runDeals(DEFAULT_CONFIG, N_DEALS, 1);
  process.stdout.write("\r           \r");

  const stats  = computeStats(matrix, calcHandSize(DEFAULT_CONFIG));
  const srange = dealSkillRange(matrix);

  console.log("═".repeat(78));
  printLadder(stats, srange);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
