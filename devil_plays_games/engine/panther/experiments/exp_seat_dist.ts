/**
 * exp_seat_dist.ts — trick-count distribution for each of the four seats.
 *
 * Produces a 4-row × 12-column table:
 *   Rows    : Panther-hand, Crow, Hunter-left, Hunter-right
 *   Columns : P(tricks=0) … P(tricks=10) as percentages, then Mean
 *
 * Settings:
 *   N = 20,000 independent deals × 1 playout each
 *   Trump : Perils Only (no named lesser trump)
 *   Play  : all four seats use random legal-move play
 *   Pranks: active (Cat, Devil, Hound, Snitch all fire normally)
 *
 * At N=20,000:
 *   SE of any probability ≤ 0.5/√20000 ≈ 0.004  (0.4 pp)
 *   SE of mean            ≤ σ/√20000  ≈ 0.015 tricks  (σ ≈ 2)
 *
 * Sanity check: the four means must sum to handSize (10). Printed at the foot
 * of the table; a WARNING is emitted if the sum drifts by more than 0.01.
 *
 * Fixed seats (Panther = A always; no auction):
 *   buildSeats(["A","B","C"], "A") → [A-hand, B-hand, Crow, C-hand]
 *   Hunter-left  = B  (first clockwise after Panther)
 *   Hunter-right = C  (second clockwise, after Crow in seat order)
 *
 * Run:  tsx exp_seat_dist.ts                    # Perils Only (default)
 *       TRUMP=Hearts tsx exp_seat_dist.ts        # named trump
 *       DEALS=5000   tsx exp_seat_dist.ts        # quick smoke test
 *       DEALS=5000 TRUMP=Hearts tsx exp_seat_dist.ts
 *
 * TRUMP env var: a suit name (Spades|Diamonds|Hearts|Clubs) or omit for Perils Only.
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid, firstLeadSeat,
  StoryKind, StoryOutcome, ALL_STORIES, STORY_LABELS, storyOutcome,
} from "../panther.js";
import { dealHand } from "../trump.js";

// ---------------------------------------------------------------------------
// Fixed seats — Panther is always A; B and C are the two Hunters.
// ---------------------------------------------------------------------------
const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER:   Player  = "A";
const DEALER:    Player  = "C";
const HUNTER_L:  Player  = "B";   // first clockwise after Panther
const HUNTER_R:  Player  = "C";   // second clockwise

const SUITS = ["Spades", "Diamonds", "Hearts", "Clubs"];

function parseTrump(env: string | undefined): Bid {
  if (!env || env === "PerilsOnly")
    return { tricks: 1, trump: null, perilsOnly: true };
  if (!SUITS.includes(env))
    throw new Error(`Unknown trump suit "${env}". Use Spades|Diamonds|Hearts|Clubs or omit for Perils Only.`);
  return { tricks: 1, trump: env, perilsOnly: false };
}

// ---------------------------------------------------------------------------
// Seat definitions — maps a label to the log key emitted by TrickWon.
// ---------------------------------------------------------------------------
interface SeatDef { label: string; logKey: string; }

const SEATS: SeatDef[] = [
  { label: "Panther-hand",  logKey: `hand:${PANTHER}`  },
  { label: "Crow",          logKey: "crow"              },
  { label: "Hunter-left",   logKey: `hand:${HUNTER_L}` },
  { label: "Hunter-right",  logKey: `hand:${HUNTER_R}` },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N    = parseInt(process.env.DEALS ?? "20000");
  const bid  = parseTrump(process.env.TRUMP);
  const cfg: PantherConfig = DEFAULT_CONFIG;
  const hs   = calcHandSize(cfg);   // 10 with default config

  const trumpDesc = bid.perilsOnly ? "Perils Only" : `trump=${bid.trump}`;
  console.log(
    `exp_seat_dist — N=${N} deals × 1 playout, ${trumpDesc}, ` +
    `all-random play, pranks active`
  );
  console.log(
    `handSize=${hs}  seats: Panther=${PANTHER}, ` +
    `Hunter-left=${HUNTER_L}, Hunter-right=${HUNTER_R}\n`
  );

  // hist[seatIdx][trickCount] = number of deals where that seat took that many tricks
  const hist: number[][] = SEATS.map(() => new Array(hs + 1).fill(0));
  // histSum[t] = number of deals where Panther-hand + Crow = t
  const histSum: number[] = new Array(hs + 1).fill(0);

  for (let d = 0; d < N; d++) {
    // Progress dots so the terminal isn't silent for 20 seconds.
    if (d > 0 && d % 2000 === 0) process.stdout.write(`  ${d}/${N}…\n`);

    const seed = d + 1;
    const { st, seats } = dealHand(cfg, PLAYERS, DEALER, PANTHER, seed);
    st.emit("HandStart", { dealer: DEALER });
    st.vars.trump = bid.perilsOnly ? null : bid.trump;
    st.emit("Bid", { player: PANTHER, ...bid });

    // One shared RNG per deal; all decisions (plays, Cat leaders, Devil swaps,
    // Snitch targets) draw from it in deterministic order. The deal seed and
    // play seed are separated by a large multiplier so they can't alias.
    const rng = new Rng(seed * 1_000_003 + 7);
    const ans: Answerer = { answer: (r: Choice) => rng.choice(r.options) };

    await run(
      playTricks(st, {
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
      }, cfg),
      ans,
    );

    // Tally per-seat trick counts directly from the TrickWon log events.
    const tally: Record<string, number> = {};
    for (const e of st.log)
      if (e.type === "TrickWon")
        tally[e.payload.seat as string] =
          (tally[e.payload.seat as string] ?? 0) + 1;

    for (let i = 0; i < SEATS.length; i++)
      hist[i][tally[SEATS[i].logKey] ?? 0]++;

    const pSum = (tally[SEATS[0].logKey] ?? 0) + (tally[SEATS[1].logKey] ?? 0);
    histSum[pSum]++;
  }

  // ---------------------------------------------------------------------------
  // Print the 4 × 12 table.
  //   Columns 0–10: probability as a percentage  (e.g. "12.3")
  //   Column 11:    mean trick count             (e.g. " 2.497")
  // ---------------------------------------------------------------------------
  const CW    = 6;    // width of each probability cell
  const LABEL = 13;   // width of the seat label column

  // Header row
  const trickHeaders = Array.from({ length: hs + 1 }, (_, t) => String(t).padStart(CW)).join("");
  const header = "Seat".padEnd(LABEL) + trickHeaders + "    Mean";
  const rule   = "─".repeat(header.length);

  console.log(header);
  console.log(rule);

  const means: number[] = [];
  for (let i = 0; i < SEATS.length; i++) {
    const h    = hist[i];
    const mean = h.reduce((s, c, t) => s + c * t, 0) / N;
    means.push(mean);
    const cells = h.map(c => (100 * c / N).toFixed(1).padStart(CW)).join("");
    console.log(`${SEATS[i].label.padEnd(LABEL)}${cells}    ${mean.toFixed(3)}`);
  }

  // Footer: means sum (the sanity check)
  const totalMean = means.reduce((a, b) => a + b, 0);
  console.log(rule);
  console.log(
    `${"Means sum".padEnd(LABEL)}` +
    " ".repeat(CW * (hs + 1)) +
    `    ${totalMean.toFixed(3)}  (expected ${hs})`
  );
  if (Math.abs(totalMean - hs) > 0.01)
    console.error("\nWARNING: means do not sum to handSize — possible bug in trick tallying.");

  // ---------------------------------------------------------------------------
  // Panther-side combined distribution: p + c.
  // ---------------------------------------------------------------------------
  console.log();
  const sumMean = histSum.reduce((s, c, t) => s + c * t, 0) / N;
  console.log("Panther-side (p+c):");
  console.log(header);
  console.log(rule);
  const sumCells = histSum.map(c => (100 * c / N).toFixed(1).padStart(CW)).join("");
  console.log(`${"Panther + Crow".padEnd(LABEL)}${sumCells}    ${sumMean.toFixed(3)}`);
  console.log(rule);

  // ---------------------------------------------------------------------------
  // Story outcome table — read off the histograms already in memory.
  // Thresholds are delegated to storyOutcome() in panther.ts (single source of
  // truth); this block never needs updating when thresholds change.
  //
  // Histogram-index → (pantherTricks, crowTricks) mapping:
  //   BothAttack / BothDefend : histSum[t], t = p+c → pass (t, 0)
  //   CrowAttacks / CrowDefends : hist[1][t], t = crow  → pass (0, t)
  //   PantherAttacks / PantherDefends : hist[0][t], t = panther → pass (t, 0)
  // storyOutcome only reads the argument it cares about, so the unused arg
  // is always 0 and causes no error.
  // ---------------------------------------------------------------------------
  // Histogram source per story: drive from ALL_STORIES so this block
  // stays correct whenever the story list changes.
  // BothAttack / BothDefend use the combined p+c histogram (histSum).
  // PantherDefends uses the Panther-hand histogram (hist[0]).
  const storyHistSrc: [StoryKind, number[]][] = ALL_STORIES.map(s => [
    s,
    s === "PantherDefends" ? hist[0] : histSum,
  ]);
  const STORY_OUTCOMES: StoryOutcome[] = ["large", "medium", "small", "fail"];

  const SL = 17;
  const SC =  9;
  console.log("\nStory outcomes (random play, Perils Only):");
  const sHeader = "Story".padEnd(SL) +
    STORY_OUTCOMES.map(o => `P(${o})`.padStart(SC)).join("");
  const sRule = "─".repeat(sHeader.length);
  console.log(sHeader);
  console.log(sRule);
  for (const [story, h] of storyHistSrc) {
    const tally: Record<StoryOutcome, number> = { large: 0, medium: 0, small: 0, fail: 0 };
    for (let t = 0; t < h.length; t++) {
      if (!h[t]) continue;
      // For PantherDefends, t is panther tricks → pass (t, 0).
      // For both-seat stories, t is p+c → pass (t, 0) (storyOutcome uses sum).
      tally[storyOutcome(t, 0, story)] += h[t];
    }
    const row = STORY_OUTCOMES.map(o =>
      `${(100 * tally[o] / N).toFixed(1)}%`.padStart(SC)).join("");
    console.log(`${STORY_LABELS[story].padEnd(SL)}${row}`);
  }
  console.log(sRule);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
