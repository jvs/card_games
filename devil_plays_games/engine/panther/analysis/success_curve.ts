/**
 * success_curve.ts — Panther success curve and config lever sweep.
 *
 * For each dealt hand, simulate trick play under every trump option (4 suits
 * + Perils-Only) and record how many tricks the Panther wins.  Aggregate
 * across deals to get the success curve: at bid level B, what fraction of
 * deals does the Panther achieve ≥ B tricks?
 *
 * The same dealt cards are used for all 5 trump options, so suit-vs-PO
 * comparisons are free of deal-to-deal variance.
 *
 * Sections:
 *   1. Baseline (default config, random play + greedy-Panther play)
 *   2. Perils count sweep  (woodsSize = perilsCount → handSize stays 10)
 *   3. Woods size sweep    (perilsCount = 5)
 *   4. Cards-per-suit sweep (perilsCount = 5, woodsSize = 5)
 *
 * Run:              tsx success_curve.ts
 * Quick smoke test: DEALS=30 tsx success_curve.ts
 */
import { Rng, Player, run } from "../../core.js";
import { Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, deck,
  newState, playTricks, clockwise, Bid, PlayTricksParams,
} from "../panther.js";
import { State, Card } from "../../cards.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SUITS      = ["Spades", "Diamonds", "Hearts", "Clubs"] as const;
const TRUMP_KEYS = [...SUITS, "PO"] as const;
type  TrumpKey   = (typeof TRUMP_KEYS)[number];
const TRUMP_VAL: Record<TrumpKey, string | null> = {
  Spades: "Spades", Diamonds: "Diamonds", Hearts: "Hearts", Clubs: "Clubs", PO: null,
};

const PANTHER: Player = "A";
const DEALER:  Player = "C";   // clockwise → A leads first trick
const PLAYERS: Player[] = ["A", "B", "C"];

// ---------------------------------------------------------------------------
// Clone zone contents of a dealt state into a fresh simulation state
// ---------------------------------------------------------------------------
function cloneDealt(src: State, cfg: PantherConfig, rng: Rng): State {
  const dst = newState(PLAYERS, rng);
  for (const p of PLAYERS) dst.z(`hand:${p}`).cards = [...src.z(`hand:${p}`).cards];
  dst.z("crow").cards  = [...src.z("crow").cards];
  dst.z("woods").cards = [...src.z("woods").cards];
  return dst;
}

// ---------------------------------------------------------------------------
// Answerer factory
//   random  — uniform random over legal options for every player
//   greedy  — Panther leads/plays strongest available card; everyone else random
// ---------------------------------------------------------------------------
function makeAnswerer(
  policy: "random" | "greedy",
  trump:  string | null,
  rng:    Rng,
): Answerer {
  return {
    answer(req: Choice): any {
      if (policy === "random" || req.key !== "play" || req.player !== PANTHER)
        return rng.choice(req.options);
      const cards = req.options as Card[];
      const led   = (req.meta?.led as string | null) ?? null;
      const tier  = (c: Card) =>
        c.get("suit") === "Perils" ? 2 : (trump && c.get("suit") === trump ? 1 : 0);
      if (led === null) {
        // Leading: highest tier first, then highest rank within tier
        return cards.slice().sort((a, b) =>
          tier(b) !== tier(a) ? tier(b) - tier(a) : b.get("rank") - a.get("rank")
        )[0];
      }
      // Following: highest of led suit; otherwise shed lowest card
      const inSuit = cards.filter(c => c.get("suit") === led);
      if (inSuit.length) return inSuit.sort((a, b) => b.get("rank") - a.get("rank"))[0];
      return cards.slice().sort((a, b) => a.get("rank") - b.get("rank"))[0];
    },
  };
}

// ---------------------------------------------------------------------------
// Simulate one deal under one trump declaration; return Panther trick count
// ---------------------------------------------------------------------------
async function simTricks(
  dealSt: State,
  trump:  string | null,
  cfg:    PantherConfig,
  rng:    Rng,              // used only to derive sub-seeds
  policy: "random" | "greedy",
): Promise<number> {
  const hs      = calcHandSize(cfg);
  const simSt   = cloneDealt(dealSt, cfg, new Rng(rng.int(2 ** 30)));
  const playRng = new Rng(rng.int(2 ** 30));

  const order = clockwise(PLAYERS, DEALER);
  const seats: [Player, string][] = [];
  for (const p of order) {
    seats.push([p, `hand:${p}`]);
    if (p === PANTHER) seats.push([PANTHER, "crow"]);
  }
  simSt.vars.trump   = trump;
  simSt.vars.seats   = seats;
  simSt.vars.panther = PANTHER;

  const bid: Bid = { tricks: 1, trump, perilsOnly: trump === null };
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
  }, cfg), makeAnswerer(policy, trump, playRng));

  // Trick count is authoritative from the event log — independent of scoring.
  return simSt.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${PANTHER}` || e.payload.seat === "crow")
  ).length;
}

// ---------------------------------------------------------------------------
// Run N deals; return matrix[deal][trumpKeyIndex] → tricks won by Panther
// ---------------------------------------------------------------------------
async function runDeals(
  cfg:      PantherConfig,
  nDeals:   number,
  policy:   "random" | "greedy",
  seedBase: number,
): Promise<number[][]> {
  const hs     = calcHandSize(cfg);
  const matrix: number[][] = [];

  for (let d = 0; d < nDeals; d++) {
    const rng = new Rng(seedBase + d);
    const st  = newState(PLAYERS, rng);
    st.z("deck").cards = deck(cfg);
    st.shuffle("deck");
    for (const p of PLAYERS) st.deal("deck", `hand:${p}`, hs);
    st.deal("deck", "crow", hs);
    st.deal("deck", "woods", cfg.woodsSize);

    const row: number[] = [];
    for (const key of TRUMP_KEYS)
      row.push(await simTricks(st, TRUMP_VAL[key], cfg, rng, policy));
    matrix.push(row);
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// Build success curve from matrix
// ---------------------------------------------------------------------------
interface Curve {
  hs:       number;
  byKey:    Record<TrumpKey, number[]>;  // index b → P(tricks ≥ b+1)
  avgReg:   number[];
  po:       number[];
  gap:      number[];   // avgReg[b] − po[b]
  p50Reg:   number;     // interpolated bid level where avgReg crosses 50%
  p50PO:    number;
  gapSlope: number;     // pp per bid level (positive = gap widens at higher bids)
}

function buildCurve(matrix: number[][], hs: number): Curve {
  const n = matrix.length;

  const byKey = {} as Record<TrumpKey, number[]>;
  for (let ki = 0; ki < TRUMP_KEYS.length; ki++) {
    const key = TRUMP_KEYS[ki];
    byKey[key] = Array.from({ length: hs }, (_, b) =>
      matrix.filter(row => row[ki] >= b + 1).length / n
    );
  }

  const avgReg: number[] = Array.from({ length: hs }, (_, b) =>
    SUITS.reduce((s, k) => s + byKey[k][b], 0) / SUITS.length
  );
  const po  = byKey["PO"];
  const gap = avgReg.map((r, i) => r - po[i]);

  const p50Of = (curve: number[]) => {
    for (let i = 0; i + 1 < curve.length; i++) {
      if (curve[i] >= 0.5 && curve[i + 1] < 0.5) {
        const t = (curve[i] - 0.5) / (curve[i] - curve[i + 1]);
        return (i + 1) + t;
      }
    }
    return curve[0] < 0.5 ? 0 : hs + 1;
  };

  // Gap slope: linear regression over bid levels 2..(hs-1), skipping extremes
  const mid = gap.slice(1, hs - 1);
  const xs  = mid.map((_, i) => i + 2);
  const xm  = xs.reduce((s, x) => s + x, 0) / xs.length;
  const ym  = mid.reduce((s, y) => s + y, 0) / mid.length;
  const num = xs.reduce((s, x, i) => s + (x - xm) * (mid[i] - ym), 0);
  const den = xs.reduce((s, x)    => s + (x - xm) ** 2, 0);

  return {
    hs, byKey, avgReg, po, gap,
    p50Reg:   p50Of(avgReg),
    p50PO:    p50Of(po),
    gapSlope: den > 0 ? num / den : 0,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const fPct  = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";
const fPP   = (x: number) => ((x >= 0 ? "+" : "") + (x * 100).toFixed(1)).padStart(6) + "pp";
const fBid  = (x: number) => x.toFixed(2);

function gapShapeLabel(slope: number): string {
  const abs = Math.abs(slope * 100);  // pp per bid level
  if (abs < 0.4)  return `flat (${fPP(slope)}/level) → flat bonus is appropriate`;
  if (slope >  0) return `widens (+${(slope*100).toFixed(2)}pp/level) → multiplier compensates better at high bids`;
  return             `narrows (${(slope*100).toFixed(2)}pp/level) → bonus overcorrects at high bids`;
}

// ---------------------------------------------------------------------------
// Print full success-curve table (used for baseline)
// ---------------------------------------------------------------------------
function printFullCurve(curve: Curve, title: string): void {
  const H = "─".repeat(82);
  console.log(`\n${title}`);
  console.log(H);
  console.log(
    "Bid".padStart(4) + "  " +
    SUITS.map(s => s.slice(0, 2).padStart(6)).join("  ") +
    "  " + "AvgReg".padStart(7) +
    "  " + "PO".padStart(7) +
    "  " + "Gap".padStart(8)
  );
  console.log(H);
  for (let b = 0; b < curve.hs; b++) {
    const bid = b + 1;
    const star = (bid === Math.round(curve.p50Reg) || bid === Math.round(curve.p50PO)) ? " ←p50" : "";
    console.log(
      String(bid).padStart(4) + "  " +
      SUITS.map(s => fPct(curve.byKey[s][b]).padStart(6)).join("  ") +
      "  " + fPct(curve.avgReg[b]).padStart(7) +
      "  " + fPct(curve.po[b]).padStart(7) +
      "  " + fPP(curve.gap[b]).padStart(8) +
      star
    );
  }
  console.log(H);
  console.log(`p50 :  Avg-Regular = ${fBid(curve.p50Reg)}   Perils-Only = ${fBid(curve.p50PO)}   difference = ${(curve.p50Reg - curve.p50PO).toFixed(2)} bid levels`);
  console.log(`Gap :  ${gapShapeLabel(curve.gapSlope)}`);
}

// ---------------------------------------------------------------------------
// Config sweep: print one summary row per config point, then the
// Avg-Regular and PO sub-curves side by side for the full bid range.
// ---------------------------------------------------------------------------
function printSweepTable(
  entries: Array<{ label: string; cfg: PantherConfig; curve: Curve }>,
  title: string,
): void {
  const H = "─".repeat(70);
  console.log(`\n${"═".repeat(70)}`);
  console.log(title);
  console.log(`${"═".repeat(70)}`);

  // Summary table
  console.log(`\n${"label".padEnd(18)} ${"hs".padStart(3)}  ${"p50-Reg".padStart(7)}  ${"p50-PO".padStart(7)}  ${"gap@p50".padStart(8)}  gap-shape`);
  console.log(H);
  for (const { label, cfg, curve } of entries) {
    const hs  = calcHandSize(cfg);
    const idx = Math.round(curve.p50Reg) - 1;
    const gapAtP50 = (idx >= 0 && idx < curve.gap.length) ? curve.gap[idx] : 0;
    console.log(
      label.padEnd(18) + " " +
      String(hs).padStart(3) + "  " +
      fBid(curve.p50Reg).padStart(7) + "  " +
      fBid(curve.p50PO).padStart(7) + "  " +
      fPP(gapAtP50).padStart(8) + "  " +
      gapShapeLabel(curve.gapSlope)
    );
  }

  // Full curves per entry: Avg-Reg and PO only (suits omitted for brevity)
  console.log(`\nSuccess curves (Avg-Regular  |  Perils-Only):`);
  const maxHs = Math.max(...entries.map(e => e.curve.hs));
  const header = "Bid".padStart(4) + "  " +
    entries.map(e => e.label.slice(0, 14).padEnd(16)).join(" ");
  console.log(header);
  console.log(H);
  for (let b = 0; b < maxHs; b++) {
    const bid = b + 1;
    const cols = entries.map(({ curve }) => {
      if (b >= curve.hs) return "  --     --  ".padEnd(16);
      return (fPct(curve.avgReg[b]) + " | " + fPct(curve.po[b])).padEnd(16);
    });
    console.log(String(bid).padStart(4) + "  " + cols.join(" "));
  }
}

// ---------------------------------------------------------------------------
// Config sweep definitions
// ---------------------------------------------------------------------------

// Perils count: woodsSize = perilsCount keeps handSize = 10
const PERILS_SWEEP = [1, 2, 3, 4, 5].map(pc => ({
  label: `perils=${pc},woods=${pc}`,
  cfg:   { ...DEFAULT_CONFIG, perilsCount: pc, woodsSize: pc } as PantherConfig,
}));

// Woods size: perilsCount = 5 fixed; valid woodsSizes are ≡ 1 mod 4
const WOODS_SWEEP = [1, 5, 9].map(ws => ({
  label: `woods=${ws}`,
  cfg:   { ...DEFAULT_CONFIG, woodsSize: ws } as PantherConfig,
}));

// Cards per suit: perilsCount = 5, woodsSize = 5; handSize = cardsPerSuit
const SUITS_SWEEP = [7, 8, 9, 10, 11].map(cs => ({
  label: `suits=${cs}`,
  cfg:   { ...DEFAULT_CONFIG, cardsPerSuit: cs } as PantherConfig,
}));

// Validate all sweep configs at startup
for (const entry of [...PERILS_SWEEP, ...WOODS_SWEEP, ...SUITS_SWEEP]) {
  try { calcHandSize(entry.cfg); }
  catch (e) { throw new Error(`Config "${entry.label}" invalid: ${e}`); }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N_DEALS = parseInt(process.env.DEALS ?? "500");

  console.log("Panther Success Curve Analysis");
  console.log(`Deals per config: ${N_DEALS}   (set DEALS=N to change)`);
  console.log("Setup: A always Panther · play simulated for every trump option on the same dealt cards");

  // ── Section 1: Baseline ──────────────────────────────────────────────────
  console.log(`\n${"═".repeat(82)}`);
  console.log("SECTION 1 — Baseline success curve (default config)");
  console.log(`${"═".repeat(82)}`);
  console.log(`Config: perils=${DEFAULT_CONFIG.perilsCount}  woods=${DEFAULT_CONFIG.woodsSize}  cardsPerSuit=${DEFAULT_CONFIG.cardsPerSuit}  handSize=${calcHandSize(DEFAULT_CONFIG)}`);

  for (const policy of ["random", "greedy"] as const) {
    process.stdout.write(`\n[${policy} play — running ${N_DEALS} deals…]`);
    const matrix = await runDeals(DEFAULT_CONFIG, N_DEALS, policy, policy === "random" ? 1 : 1_000_001);
    const curve  = buildCurve(matrix, calcHandSize(DEFAULT_CONFIG));
    process.stdout.write("\r" + " ".repeat(50) + "\r");
    printFullCurve(curve, `Policy: ${policy}`);
  }

  // ── Section 2: Perils count sweep ────────────────────────────────────────
  process.stdout.write("\n[Perils sweep — running…]");
  const perilsEntries = await Promise.all(PERILS_SWEEP.map(async ({ label, cfg }, i) => {
    const matrix = await runDeals(cfg, N_DEALS, "random", 2_000_001 + i * 100_000);
    return { label, cfg, curve: buildCurve(matrix, calcHandSize(cfg)) };
  }));
  process.stdout.write("\r" + " ".repeat(50) + "\r");
  printSweepTable(perilsEntries, "SECTION 2 — Perils count sweep (woodsSize = perilsCount → handSize = 10)");

  // ── Section 3: Woods size sweep ──────────────────────────────────────────
  process.stdout.write("[Woods sweep — running…]");
  const woodsEntries = await Promise.all(WOODS_SWEEP.map(async ({ label, cfg }, i) => {
    const matrix = await runDeals(cfg, N_DEALS, "random", 3_000_001 + i * 100_000);
    return { label, cfg, curve: buildCurve(matrix, calcHandSize(cfg)) };
  }));
  process.stdout.write("\r" + " ".repeat(50) + "\r");
  printSweepTable(woodsEntries, "SECTION 3 — Woods size sweep (perilsCount = 5, cardsPerSuit = 10)");

  // ── Section 4: Cards-per-suit sweep ──────────────────────────────────────
  process.stdout.write("[Suit-size sweep — running…]");
  const suitsEntries = await Promise.all(SUITS_SWEEP.map(async ({ label, cfg }, i) => {
    const matrix = await runDeals(cfg, N_DEALS, "random", 4_000_001 + i * 100_000);
    return { label, cfg, curve: buildCurve(matrix, calcHandSize(cfg)) };
  }));
  process.stdout.write("\r" + " ".repeat(50) + "\r");
  printSweepTable(suitsEntries, "SECTION 4 — Cards-per-suit sweep (perilsCount = 5, woodsSize = 5)");
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
