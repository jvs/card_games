/**
 * exp_story_mc.ts — story outcomes with trump selection, pass option, and
 * point-value MC.
 *
 * Two-phase design:
 *   Phase 1 — selection:
 *     Panther evaluates all (story × trump) combinations using SEL_ITER random
 *     rollouts each (3 stories × 5 trumps = 15 combinations × SEL_ITER rollouts).
 *     If the best E[Panther points] < PASS_EV, the Panther passes (hand skipped,
 *     0 pts to everyone). Otherwise plays the best (story, trump).
 *   Phase 2 — play:
 *     Panther maximizes E[Panther points | chosen story+trump].
 *     Hunters minimize E[Panther points].
 *     Both sides use realistic determinization (sample opponent hands).
 *     Inner rollout: all-random legal moves.
 *
 * Point schedule:
 *   Both Attack / Both Defend:
 *     large (+5 Panther):  ≥9 combined / ≤1 combined tricks
 *     medium (+2 Panther):  8 combined /  2 combined tricks
 *     small  (+1 Panther):  7 combined /  3 combined tricks
 *     fail   (+3 ea Hunter): otherwise
 *   Panther Defends (nil-only):
 *     nil    (+2 Panther):  Panther takes 0 tricks
 *     fail   (+5 ea Hunter): otherwise
 *
 * Env vars:
 *   DEALS=12000   total deals (passed + played)
 *   ITER=30       MC rollouts per card option
 *   SEL_ITER=30   random rollouts per (story × trump) combination
 *   PASS_EV=1.0   Panther passes if best EV < this threshold
 *
 * Run:  tsx exp_story_mc.ts
 *       DEALS=600 ITER=10 SEL_ITER=10 tsx exp_story_mc.ts   # smoke test
 */
import { Rng, Player, run, Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid, firstLeadSeat,
  StoryKind, StoryOutcome, ALL_STORIES, STORY_LABELS,
  storyOutcome, storyPoints, rolloutSync, deck as pantherDeck,
} from "./panther.js";
import { reconstructBelief, Belief } from "./mc_panther.js";
import { State, Card } from "./cards.js";
import { dealHand } from "./trump.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player   = "A";
const DEALER:  Player   = "C";

function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

// All trump options the Panther can declare.
const TRUMP_OPTIONS: { trump: string | null; label: string }[] = [
  { trump: "Spades",   label: "Spades"    },
  { trump: "Diamonds", label: "Diamonds"  },
  { trump: "Hearts",   label: "Hearts"    },
  { trump: "Clubs",    label: "Clubs"     },
  { trump: null,       label: "PerilsOnly"},
];

interface BidChoice { story: StoryKind; trump: string | null; }

// ---------------------------------------------------------------------------
// Phase 1: (story × trump) selection via random rollouts.
//
// Two pass-EV modes:
//   "fixed"     — compare best E[Panther pts] against a constant PASS_EV.
//   "estimated" — compute mean E[Hunter pts per Hunter] across ALL 15
//               combinations for this specific hand (free — same rollouts).
//               Semantics: bid only if you can beat what you'd earn as a
//               Hunter in a randomly-contracted game on this hand.
// ---------------------------------------------------------------------------
function selectBid(
  st:        State,
  seats:     [Player, string][],
  lead:      number,
  panther:   Player,
  cfg:       PantherConfig,
  rng:       Rng,
  nPerCombo: number,
  passMode:  "fixed" | "estimated",
  fixedPassEV: number,
): { bid: BidChoice; ev: number; passThreshold: number } | null {
  const hs = calcHandSize(cfg);
  let best: BidChoice | null = null;
  let bestEV = -Infinity;
  let sumHunterEV = 0;
  const nCombos = ALL_STORIES.length * TRUMP_OPTIONS.length;

  for (const story of ALL_STORIES) {
    for (const { trump } of TRUMP_OPTIONS) {
      let totalPanther = 0, totalHunter = 0;
      for (let i = 0; i < nPerCombo; i++) {
        const hands: Record<string, Card[]> = {};
        for (const [, zname] of seats) hands[zname] = [...st.z(zname).cards];
        const { pantherTricks, crowTricks } = rolloutSync(
          hands, seats, lead, 0, hs,
          [], null, null, trump, panther, rng,
        );
        const pts = storyPoints(pantherTricks, crowTricks, story);
        totalPanther += pts.panther;
        totalHunter  += pts.hunters;
      }
      const evP = totalPanther / nPerCombo;
      const evH = totalHunter  / nPerCombo;
      sumHunterEV += evH;
      if (evP > bestEV) { bestEV = evP; best = { story, trump }; }
    }
  }

  const passThreshold = passMode === "estimated"
    ? sumHunterEV / nCombos   // mean E[Hunter pts/Hunter] across all combinations
    : fixedPassEV;

  return bestEV > passThreshold && best !== null
    ? { bid: best, ev: bestEV, passThreshold }
    : null;
}

// ---------------------------------------------------------------------------
// Phase 2: MC answerer — E[Panther points] as value signal.
// Realistic determinization; synchronous answer().
// ---------------------------------------------------------------------------
class StoryMCAnswerer implements Answerer {
  private readonly deck: Card[];

  constructor(
    private player:     Player,
    private st:         State,
    private allPlayers: Player[],
    private cfg:        PantherConfig,
    private rng:        Rng,
    private story:      StoryKind,
    private iters:      number,
  ) {
    this.deck = pantherDeck(cfg);
  }

  answer(req: Choice): Card | string | number {
    if (req.options.length <= 1) return req.options[0];
    if (req.key !== "play") return this.rng.choice(req.options);

    const panther = this.st.vars.panther as Player;
    const trump   = this.st.vars.trump   as string | null;
    const seats   = this.st.vars.seats   as [Player, string][];

    const log    = this.st.viewFor(this.player);
    const belief = reconstructBelief(log, this.player, this.allPlayers, this.cfg);
    if (!belief.panther) return this.rng.choice(req.options);

    const fromZone = (req.meta?.seat as string) ?? `hand:${this.player}`;
    const options  = req.options as Card[];

    const scores = options.map(card =>
      this.evalCard(card, fromZone, belief, trump, seats, panther));

    const wantMax = this.player === panther;
    const best    = wantMax ? Math.max(...scores) : Math.min(...scores);
    return options[scores.indexOf(best)];
  }

  private evalCard(
    card: Card, fromZone: string, belief: Belief,
    trump: string | null, seats: [Player, string][], panther: Player,
  ): number {
    const hs       = calcHandSize(this.cfg);
    const authorSi = seats.findIndex(([, z]) => z === fromZone);
    const extPlays: [number, Card][] = [...belief.partialPlays, [authorSi, card]];
    const extLed   = belief.partialLed ?? (card.get("suit") as string);
    const cid      = cardId(card);

    const pool    = this.unknownPool(belief);
    const opSlots = this.allPlayers
      .filter(p => p !== this.player)
      .map(p => ({ zname: `hand:${p}` as string,
                   size:  Math.max(0, belief.opponentHandSizes[p] ?? 0) }));

    let total = 0;
    for (let i = 0; i < this.iters; i++) {
      const p = [...pool];
      this.rng.shuffle(p);
      const hands: Record<string, Card[]> = {};
      let off = 0;
      for (const { zname, size } of opSlots) {
        hands[zname] = p.slice(off, off + size);
        off += size;
      }
      hands[`hand:${this.player}`] = [...belief.myHand];
      hands["crow"]                = [...belief.crow];

      const h   = hands[fromZone];
      const idx = h.findIndex(c => cardId(c) === cid);
      if (idx >= 0) h.splice(idx, 1);

      const { pantherTricks, crowTricks } = rolloutSync(
        hands, seats,
        belief.lead, belief.trickNumber, hs,
        extPlays, extLed, belief.forcedFromPartials,
        trump, panther, this.rng,
      );

      const totalP = (belief.won[panther] ?? 0) + pantherTricks;
      const totalC = belief.crowWon + crowTricks;
      total += storyPoints(totalP, totalC, this.story).panther;
    }
    return total / this.iters;
  }

  private unknownPool(belief: Belief): Card[] {
    const known = new Set<string>();
    for (const c of belief.myHand)              known.add(cardId(c));
    for (const c of belief.crow)                known.add(cardId(c));
    for (const c of belief.completedTrickCards) known.add(cardId(c));
    for (const c of belief.currentTrickCards)   known.add(cardId(c));
    if (belief.knownWoods) for (const c of belief.knownWoods) known.add(cardId(c));
    return this.deck.filter(c => !known.has(cardId(c)));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N        = parseInt(process.env.DEALS    ?? "12000");
  const iters    = parseInt(process.env.ITER     ?? "30");
  const selIters = parseInt(process.env.SEL_ITER ?? "30");
  const passEV   = parseFloat(process.env.PASS_EV   ?? "1.0");
  const passMode = (process.env.PASS_MODE ?? "fixed") as "fixed" | "estimated";
  if (passMode !== "fixed" && passMode !== "estimated")
    throw new Error(`PASS_MODE must be "fixed" or "estimated"`);
  const cfg: PantherConfig = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);

  const passDesc = passMode === "estimated"
    ? "estimated (mean E[Hunter pts] across all 15 combos on this hand)"
    : `fixed (${passEV})`;
  console.log(`exp_story_mc — N=${N}, ITER=${iters}, SEL_ITER=${selIters}`);
  console.log(`Pass EV mode: ${passDesc}`);
  console.log(`Phase 1: ${selIters} random rollouts × ${ALL_STORIES.length} stories × ${TRUMP_OPTIONS.length} trumps = ` +
              `${selIters * ALL_STORIES.length * TRUMP_OPTIONS.length} rollouts/deal for selection`);
  console.log(`Phase 2: realistic flat MC, ${iters} sync rollouts/option`);
  console.log(`  Panther (A):    maximizes E[Panther points]`);
  console.log(`  Hunters (B, C): minimize  E[Panther points]\n`);

  const OUTCOMES: StoryOutcome[] = ["large", "medium", "small", "fail"];

  // Counters
  let passCount = 0;
  const chosen:      Record<StoryKind, number>                       = {} as any;
  const outcomes:    Record<StoryKind, Record<StoryOutcome, number>> = {} as any;
  const trumpChosen: Record<string, number> = {};
  // Per-story trump breakdown: trumpChosen[story][trumpLabel] = count
  const storyTrump:  Record<StoryKind, Record<string, number>>       = {} as any;
  for (const s of ALL_STORIES) {
    chosen[s] = 0;
    outcomes[s] = { large: 0, medium: 0, small: 0, fail: 0 };
    storyTrump[s] = {};
    for (const { label } of TRUMP_OPTIONS) storyTrump[s][label] = 0;
  }
  for (const { label } of TRUMP_OPTIONS) trumpChosen[label] = 0;

  // E[pts] accumulators — all N deals; passes count as 0.
  let sumPantherPts = 0, sumHunterPts = 0;
  // Distribution of per-hand pass thresholds (estimated mode).
  const thresholdHist: number[] = [];
  // Distribution of per-hand best EVs (for pass sensitivity).
  const bestEVHist:    number[] = [];

  for (let d = 0; d < N; d++) {
    if (d > 0 && d % 1000 === 0) process.stdout.write(`  ${d}/${N}…\n`);

    const seed = d + 1;
    const { st, seats } = dealHand(cfg, PLAYERS, DEALER, PANTHER, seed);
    st.emit("HandStart", { dealer: DEALER });
    st.vars.panther = PANTHER;
    st.vars.seats   = seats;

    const initialLead = firstLeadSeat(seats, PANTHER, PLAYERS, cfg);
    const selRng      = new Rng(seed * 9973 + 1);
    const selection   = selectBid(st, seats, initialLead, PANTHER, cfg,
                                  selRng, selIters, passMode, passEV);

    if (selection === null) {
      passCount++;
      if (passMode === "estimated") thresholdHist.push(0); // threshold was above bestEV
      continue;   // no points awarded; hand not played
    }

    const { story, trump } = selection.bid;
    if (passMode === "estimated") thresholdHist.push(selection.passThreshold);
    const trumpLabel = TRUMP_OPTIONS.find(t => t.trump === trump)!.label;

    st.vars.trump = trump;
    const bid: Bid = { tricks: 1, trump, perilsOnly: trump === null };
    st.emit("Bid", { player: PANTHER, ...bid });

    const answerers = new Map<Player | null, Answerer>();
    PLAYERS.forEach((p, i) =>
      answerers.set(p, new StoryMCAnswerer(
        p, st, PLAYERS, cfg,
        new Rng(seed * 1009 + i * 997 + 1), story, iters,
      )));
    answerers.set(null, {
      answer: (r: Choice) => new Rng(seed * 911 + 7).choice(r.options),
    });

    await run(
      playTricks(st, {
        seats, lead: initialLead, handSize: hs, panther: PANTHER,
        bid, trickNum: 0, partialPlays: [], partialLed: null,
        forcedFromPartials: null,
        won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
      }, cfg),
      answerers,
    );

    const tally: Record<string, number> = {};
    for (const e of st.log)
      if (e.type === "TrickWon")
        tally[e.payload.seat as string] = (tally[e.payload.seat as string] ?? 0) + 1;

    const pTricks = tally[`hand:${PANTHER}`] ?? 0;
    const cTricks = tally["crow"]             ?? 0;
    const oc      = storyOutcome(pTricks, cTricks, story);
    const pts     = storyPoints(pTricks, cTricks, story);

    chosen[story]++;
    outcomes[story][oc]++;
    trumpChosen[trumpLabel]++;
    storyTrump[story][trumpLabel]++;
    sumPantherPts += pts.panther;
    sumHunterPts  += pts.hunters;
  }

  const nPlayed = N - passCount;

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  const SL = 17;
  const SC =  9;

  function pantherPts(s: StoryKind, o: StoryOutcome): number {
    if (o === "fail") return 0;
    return s === "PantherDefends" ? 2 : (o === "large" ? 5 : o === "medium" ? 2 : 1);
  }
  function hunterPts(s: StoryKind, o: StoryOutcome): number {
    return o === "fail" ? (s === "PantherDefends" ? 5 : 3) : 0;
  }

  // --- per-story table ---
  console.log("Results — Panther chooses story + trump, with pass option:");
  const header = "Story".padEnd(SL) +
    ["P(ch|play)", "P(+5)", "P(+2)", "P(+1)", "P(fail)",
     "E[Pnth]", "E[Hntr]"].map(c => c.padStart(SC)).join("") + "    n";
  const rule = "─".repeat(header.length);
  console.log(header);
  console.log(rule);

  for (const story of ALL_STORIES) {
    const n = chosen[story];
    if (n === 0) {
      console.log(`${STORY_LABELS[story].padEnd(SL)}` + " ".repeat(SC * 7) + "      0");
      continue;
    }
    const oCounts = outcomes[story];
    const pCh   = n / nPlayed;
    const pLg   = oCounts.large  / n;
    const pMed  = oCounts.medium / n;
    const pSm   = oCounts.small  / n;
    const pFail = oCounts.fail   / n;
    const p5    = story === "PantherDefends" ? 0 : pLg;
    const p2    = pMed;   // medium = +2 for all stories
    const p1    = story === "PantherDefends" ? 0 : pSm;
    const eP    = OUTCOMES.reduce((s, o) => s + pantherPts(story, o) * oCounts[o] / n, 0);
    const eH    = OUTCOMES.reduce((s, o) => s + hunterPts(story, o)  * oCounts[o] / n, 0);

    const row = [pCh, p5, p2, p1, pFail, eP, eH]
      .map((v, i) => i < 5
        ? `${(100 * v).toFixed(1)}%`.padStart(SC)
        : v.toFixed(2).padStart(SC))
      .join("");
    console.log(`${STORY_LABELS[story].padEnd(SL)}${row}    ${n}`);
  }

  console.log(rule);

  // Overall rows (conditional on played, then including passes).
  const ePPlay = nPlayed > 0 ? sumPantherPts / nPlayed : 0;
  const eHPlay = nPlayed > 0 ? sumHunterPts  / nPlayed : 0;
  const ePAll  = sumPantherPts / N;
  const eHAll  = sumHunterPts  / N;
  const fmt = (v: number) => v.toFixed(2).padStart(SC);
  console.log(`${"Played deals".padEnd(SL)}` +
    " ".repeat(SC * 5) + fmt(ePPlay) + fmt(eHPlay) + `    ${nPlayed}`);
  console.log(`${"All deals (w/ pass)".padEnd(SL)}` +
    " ".repeat(SC * 5) + fmt(ePAll) + fmt(eHAll) + `    ${N}`);

  // --- pass summary ---
  console.log(`\nPass rate: ${(100 * passCount / N).toFixed(1)}%  (${passCount}/${N} deals,  pass mode: ${passDesc})`);

  // In estimated mode, report the distribution of per-hand thresholds.
  if (passMode === "estimated" && thresholdHist.length > 0) {
    const sorted = [...thresholdHist].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1,
                               Math.floor(p * sorted.length))];
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    console.log(`  Per-hand pass threshold (estimated mode, played deals only):`);
    console.log(`  mean=${mean.toFixed(3)}  ` +
      [10, 25, 50, 75, 90].map(p => `P${p}=${pct(p/100).toFixed(3)}`).join("  "));
  }

  // --- trump distribution ---
  console.log("\nTrump chosen (among played deals):");
  const trumpLine = TRUMP_OPTIONS
    .map(({ label }) => `${label}: ${(100 * (trumpChosen[label] ?? 0) / nPlayed).toFixed(1)}%`)
    .join("   ");
  console.log("  " + trumpLine);

  // --- per-story trump breakdown ---
  console.log("\nTrump breakdown per story (% of that story's played deals):");
  const tHeader = "Story".padEnd(SL) +
    TRUMP_OPTIONS.map(({ label }) => label.padStart(SC)).join("");
  console.log(tHeader);
  console.log("─".repeat(tHeader.length));
  for (const story of ALL_STORIES) {
    const n = chosen[story];
    if (n === 0) { console.log(`${STORY_LABELS[story].padEnd(SL)}  (none)`); continue; }
    const row = TRUMP_OPTIONS
      .map(({ label }) => `${(100 * (storyTrump[story][label] ?? 0) / n).toFixed(1)}%`.padStart(SC))
      .join("");
    console.log(`${STORY_LABELS[story].padEnd(SL)}${row}`);
  }
  console.log("─".repeat(tHeader.length));
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
