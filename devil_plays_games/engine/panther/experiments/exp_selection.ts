/**
 * exp_selection.ts — full scoring-vector test with free contract + trump selection.
 *
 * Scoring vector (candidate from exp_pricing sweep):
 *   Both Attack / Both Defend:  small=3  med=4  large=5
 *   Panther Defends (nil):      make=4
 *   Hunter fail reward (each):  1   (on any Panther fail)
 *
 * Setup:
 *   - No auction, no pass. Every deal the Panther evaluates all 15 (story × trump)
 *     combinations via random rollouts and picks argmax E[Panther points].
 *   - Both sides play realistic flat MC, signal = E[Panther points].
 *     Panther maximises; Hunters minimise.
 *   - Pranks active, N=5000+ deals.
 *
 * Report:
 *   1. Selection share: fraction of deals each contract is chosen.
 *   2. Per chosen contract: tier breakdown, make-rate, mean Panther pts.
 *   3. Envelope: mean Panther pts / mean Hunter pts across all deals.
 *   4. Trump split per chosen contract.
 *
 * Env vars:
 *   N=5000       deals
 *   SEL_ITER=30  random rollouts per combo for selection
 *   PLAY_ITER=30 MC rollouts per card option during play
 *
 * Run:  tsx exp_selection.ts
 *       N=200 tsx exp_selection.ts   # smoke test
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid,
  firstLeadSeat, buildSeats, deck, newState,
  StoryKind, StoryOutcome, ALL_STORIES, STORY_LABELS,
  storyOutcome, rolloutSync, deck as pantherDeck,
} from "../panther.js";
import { reconstructBelief, Belief } from "../mc_panther.js";
import { State, Card } from "../../cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player   = "A";
const DEALER:  Player   = "C";

function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

// ---------------------------------------------------------------------------
// Scoring vector
// ---------------------------------------------------------------------------
const V = { small: 3, med: 4, large: 5, nil: 4, fail: 1 } as const;

function tierPoints(tier: StoryOutcome, story: StoryKind): { panther: number; hunters: number } {
  if (story === "PantherDefends")
    return tier === "medium" ? { panther: V.nil, hunters: 0 } : { panther: 0, hunters: V.fail };
  if (tier === "fail") return { panther: 0, hunters: V.fail };
  return { panther: tier === "large" ? V.large : tier === "medium" ? V.med : V.small, hunters: 0 };
}

function evalSignal(pTricks: number, cTricks: number, story: StoryKind): number {
  return tierPoints(storyOutcome(pTricks, cTricks, story), story).panther;
}

// ---------------------------------------------------------------------------
// Trump options
// ---------------------------------------------------------------------------
const TRUMP_OPTIONS: { trump: string | null; label: string }[] = [
  { trump: "Spades",   label: "Spades"     },
  { trump: "Diamonds", label: "Diamonds"   },
  { trump: "Hearts",   label: "Hearts"     },
  { trump: "Clubs",    label: "Clubs"      },
  { trump: null,       label: "PerilsOnly" },
];

interface BidChoice { story: StoryKind; trump: string | null; }

// ---------------------------------------------------------------------------
// Deal
// ---------------------------------------------------------------------------
function dealCards(cfg: PantherConfig, seed: number): State {
  const hs = calcHandSize(cfg);
  const st = newState(PLAYERS, new Rng(seed));
  st.z("deck").cards = deck(cfg);
  st.shuffle("deck");
  for (const p of PLAYERS) st.deal("deck", `hand:${p}`, hs);
  st.deal("deck", "crow", hs);
  st.deal("deck", "woods", cfg.woodsSize);
  return st;
}

// ---------------------------------------------------------------------------
// Phase 1: select best (story × trump) via omniscient random rollouts.
// Signal = E[Panther points] under this scoring vector.
// ---------------------------------------------------------------------------
function selectBest(
  st: State, cfg: PantherConfig, rng: Rng, n: number,
): BidChoice {
  const hs    = calcHandSize(cfg);
  const seats = buildSeats(PLAYERS, PANTHER);
  const lead  = firstLeadSeat(seats, PANTHER, PLAYERS, cfg);
  let best: BidChoice = { story: ALL_STORIES[0], trump: null };
  let bestEV  = -Infinity;

  for (const story of ALL_STORIES) {
    for (const { trump } of TRUMP_OPTIONS) {
      let total = 0;
      for (let i = 0; i < n; i++) {
        const hands: Record<string, Card[]> = {};
        for (const [, z] of seats) hands[z] = [...st.z(z).cards];
        const { pantherTricks, crowTricks } = rolloutSync(
          hands, seats, lead, 0, hs, [], null, null, trump, PANTHER, rng);
        total += evalSignal(pantherTricks, crowTricks, story);
      }
      const ev = total / n;
      if (ev > bestEV) { bestEV = ev; best = { story, trump }; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Phase 2: MC answerer — E[Panther points] signal, realistic sampling.
// ---------------------------------------------------------------------------
class PointsMCAnswerer implements Answerer {
  private readonly deck: Card[];
  constructor(
    private player:  Player,
    private st:      State,
    private cfg:     PantherConfig,
    private rng:     Rng,
    private story:   StoryKind,
    private iters:   number,
  ) { this.deck = pantherDeck(cfg); }

  answer(req: Choice): Card | string | number {
    if (req.options.length <= 1) return req.options[0];
    if (req.key !== "play") return this.rng.choice(req.options);
    const panther = this.st.vars.panther as Player;
    const trump   = this.st.vars.trump   as string | null;
    const seats   = this.st.vars.seats   as [Player, string][];
    const belief  = reconstructBelief(
      this.st.viewFor(this.player), this.player, PLAYERS, this.cfg);
    if (!belief.panther) return this.rng.choice(req.options);
    const fromZone = (req.meta?.seat as string) ?? `hand:${this.player}`;
    const options  = req.options as Card[];
    const scores   = options.map(c =>
      this.evalCard(c, fromZone, belief, trump, seats, panther));
    const wantMax  = this.player === panther;
    const best     = wantMax ? Math.max(...scores) : Math.min(...scores);
    return options[scores.indexOf(best)];
  }

  private evalCard(card: Card, fromZone: string, belief: Belief,
      trump: string | null, seats: [Player, string][], panther: Player): number {
    const hs       = calcHandSize(this.cfg);
    const authorSi = seats.findIndex(([, z]) => z === fromZone);
    const extPlays: [number, Card][] = [...belief.partialPlays, [authorSi, card]];
    const extLed   = belief.partialLed ?? (card.get("suit") as string);
    const cid      = cardId(card);
    const pool     = this.unknownPool(belief);
    const opSlots  = PLAYERS
      .filter(p => p !== this.player)
      .map(p => ({ zname: `hand:${p}` as string,
                   size: Math.max(0, belief.opponentHandSizes[p] ?? 0) }));
    let total = 0;
    for (let i = 0; i < this.iters; i++) {
      const p = [...pool]; this.rng.shuffle(p);
      const hands: Record<string, Card[]> = {};
      let off = 0;
      for (const { zname, size } of opSlots) {
        hands[zname] = p.slice(off, off + size); off += size;
      }
      hands[`hand:${this.player}`] = [...belief.myHand];
      hands["crow"]                = [...belief.crow];
      const h   = hands[fromZone];
      const idx = h.findIndex(c => cardId(c) === cid);
      if (idx >= 0) h.splice(idx, 1);
      const { pantherTricks, crowTricks } = rolloutSync(
        hands, seats, belief.lead, belief.trickNumber, hs,
        extPlays, extLed, belief.forcedFromPartials, trump, panther, this.rng);
      const totalP = (belief.won[panther] ?? 0) + pantherTricks;
      const totalC = belief.crowWon + crowTricks;
      total += evalSignal(totalP, totalC, this.story);
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
  const N         = parseInt(process.env.N         ?? "5000");
  const SEL_ITER  = parseInt(process.env.SEL_ITER  ?? "30");
  const PLAY_ITER = parseInt(process.env.PLAY_ITER ?? "30");
  const cfg: PantherConfig = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);

  console.log(`exp_selection — N=${N}, SEL_ITER=${SEL_ITER}, PLAY_ITER=${PLAY_ITER}`);
  console.log(`Scoring: BA/BD small=${V.small}/med=${V.med}/large=${V.large};  PD nil=${V.nil};  Hunter fail=${V.fail}`);
  console.log(`Panther free choice of story+trump via MC; realistic MC play both sides.\n`);

  const OUTCOMES: StoryOutcome[] = ["large", "medium", "small", "fail"];

  // Counters
  const chosen:   Record<StoryKind, number> = {} as any;
  const tiers:    Record<StoryKind, Record<StoryOutcome, number>> = {} as any;
  const trumpCnt: Record<StoryKind, Record<string, number>> = {} as any;
  let totalPantherPts = 0, totalHunterPts = 0;

  for (const s of ALL_STORIES) {
    chosen[s]   = 0;
    tiers[s]    = { large: 0, medium: 0, small: 0, fail: 0 };
    trumpCnt[s] = {};
    for (const { label } of TRUMP_OPTIONS) trumpCnt[s][label] = 0;
  }

  const prog = Math.max(250, Math.floor(N / 20));
  for (let d = 0; d < N; d++) {
    if (d > 0 && d % prog === 0) process.stdout.write(`  ${d}/${N}…\n`);

    const seed   = d + 1;
    const st     = dealCards(cfg, seed);

    // Phase 1: pick best (story, trump) by E[Panther points]
    const bid  = selectBest(st, cfg, new Rng(seed * 9973 + 1), SEL_ITER);
    const { story, trump } = bid;
    const trumpLabel = TRUMP_OPTIONS.find(t => t.trump === trump)!.label;

    // Setup state for play
    const seats = buildSeats(PLAYERS, PANTHER);
    st.vars.seats   = seats;
    st.vars.panther = PANTHER;
    st.vars.trump   = trump;
    st.emit("HandStart", { dealer: DEALER });
    const bidObj: Bid = { tricks: 1, trump, perilsOnly: trump === null };
    st.emit("Bid", { player: PANTHER, ...bidObj });

    // Phase 2: play
    const answerers = new Map<Player | null, Answerer>();
    PLAYERS.forEach((p, i) =>
      answerers.set(p, new PointsMCAnswerer(
        p, st, cfg, new Rng(seed * 1009 + i * 997 + 1), story, PLAY_ITER)));
    answerers.set(null, {
      answer: (r: Choice) => new Rng(seed * 911 + 7).choice(r.options),
    });

    await run(playTricks(st, {
      seats, lead: firstLeadSeat(seats, PANTHER, PLAYERS, cfg),
      handSize: hs, panther: PANTHER, bid: bidObj,
      trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
      won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
    }, cfg), answerers);

    // Tally
    let pTricks = 0, cTricks = 0;
    for (const e of st.log) {
      if (e.type !== "TrickWon") continue;
      if (e.payload.seat === `hand:${PANTHER}`) pTricks++;
      else if (e.payload.seat === "crow")       cTricks++;
    }

    const tier = storyOutcome(pTricks, cTricks, story);
    const pts  = tierPoints(tier, story);

    chosen[story]++;
    tiers[story][tier]++;
    trumpCnt[story][trumpLabel]++;
    totalPantherPts += pts.panther;
    totalHunterPts  += pts.hunters;
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  console.log("=".repeat(70));
  console.log(`\nScoring vector:  small=${V.small}  med=${V.med}  large=${V.large}  nil=${V.nil}  fail→Hunter=${V.fail}\n`);

  // Selection shares
  console.log("Selection share (Panther's best contract per deal):");
  for (const s of ALL_STORIES) {
    console.log(`  ${STORY_LABELS[s].padEnd(16)} ${(100*chosen[s]/N).toFixed(1).padStart(5)}%  (n=${chosen[s]})`);
  }

  // Per-contract detail
  for (const s of ALL_STORIES) {
    const n = chosen[s];
    if (n === 0) continue;
    console.log(`\n─── ${STORY_LABELS[s]} (n=${n}, ${(100*n/N).toFixed(1)}% of deals) ───`);

    // Tiers
    const TIER_LABELS: Record<StoryOutcome, string> =
      s === "PantherDefends"
        ? { large: "—", medium: "nil (=0)", small: "—", fail: "fail (≥1)" }
        : s === "BothAttack"
          ? { large: "large (≥9)", medium: "med (=8)", small: "small (=7)", fail: "fail (≤6)" }
          : { large: "large (≤1)", medium: "med (=2)", small: "small (=3)", fail: "fail (≥4)" };

    const tierOrder: StoryOutcome[] =
      s === "PantherDefends" ? ["medium", "fail"] : ["large", "medium", "small", "fail"];

    let meanPts = 0;
    for (const tier of tierOrder) {
      if (TIER_LABELS[tier] === "—") continue;
      const cnt = tiers[s][tier];
      const p   = cnt / n;
      const se  = Math.sqrt(p*(1-p)/n);
      const reward = tierPoints(tier, s).panther || (tierPoints(tier, s).hunters * (-1));  // show Hunter reward as negative
      const rewardStr =
        tier === "fail"
          ? `→ Hunter +${V.fail} each`
          : `→ Panther +${tierPoints(tier, s).panther}`;
      console.log(
        `  ${TIER_LABELS[tier].padEnd(14)} ${(100*p).toFixed(1).padStart(6)}%  ±${(100*se).toFixed(1)}pp  ${rewardStr}`
      );
      meanPts += p * tierPoints(tier, s).panther;
    }
    const makeRate = 1 - tiers[s].fail / n;
    console.log(`  Make rate:      ${(100*makeRate).toFixed(1).padStart(6)}%`);
    console.log(`  Mean Pnth pts:  ${meanPts.toFixed(3).padStart(7)}`);
    console.log(`  Mean Hntr pts:  ${(tiers[s].fail / n * V.fail).toFixed(3).padStart(7)}  (each)`);

    // Trump split
    const trumpLine = TRUMP_OPTIONS
      .map(({ label }) => `${label.replace("PerilsOnly","PO")}: ${(100*(trumpCnt[s][label]??0)/n).toFixed(1)}%`)
      .join("  ");
    console.log(`  Trump:  ${trumpLine}`);
  }

  // Envelope
  const mPnth = totalPantherPts / N;
  const mHntr = totalHunterPts  / N;   // per Hunter
  console.log("\n" + "=".repeat(70));
  console.log(`\nEnvelope (Panther always plays its best contract):`);
  console.log(`  Mean Panther pts / deal:  ${mPnth.toFixed(3)}`);
  console.log(`  Mean Hunter pts  / deal:  ${mHntr.toFixed(3)}  (each Hunter)`);
  console.log(`  Gap (Pnth − Hntr):        ${(mPnth - mHntr).toFixed(3)}  ` +
              `(${mPnth > mHntr ? "Panther-favoured" : "Hunter-favoured"})`);
  console.log(`\n  Unconditional sweep predicted:`);
  console.log(`    BA envelope EV ≈ +0.726, Hunter ≈ +0.620  (3/4/5, nil=m, P=1, P*=1.09)`);
  console.log(`    Selection lifts above these — gap shows direction.`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
