/**
 * exp_hunter_debug.ts — isolates the Hunter strategy divergence.
 *
 * Hypothesis: in exp_balance.ts, BalanceMCAnswerer.evalCard uses
 *   signalFor(this.player, panther, ...) which returns the HUNTER's own pts
 *   (0 on Panther success, 1 on Panther fail), then wantMax=false minimises
 *   that signal — minimising Hunter earnings = wanting Panther to succeed.
 *
 * In exp_selection.ts, PointsMCAnswerer.evalCard uses
 *   evalSignal(...) which always returns the PANTHER's pts, then wantMax=false
 *   minimises Panther's pts = the Hunters are defending correctly.
 *
 * This script:
 *   1. Runs N deals with the auction harness to get (contract, trump, panther).
 *   2. Replays each deal TWICE with identical Panther behaviour:
 *        Run A: "balance" Hunter signal (Hunter's own pts, minimised) — buggy
 *        Run B: "selection" Hunter signal (Panther's pts, minimised) — correct
 *   3. Reports make-rate and Hunter-EV side by side.
 *   4. Deep-dives into one representative deal: at each Hunter decision, prints
 *      the legal options, both harnesses' score vectors, and the chosen card,
 *      so you can see whether they're actually defending or passively following.
 *   5. Prints a table confirming depth, wantMax, and signal values for both.
 *
 * Run:  tsx exp_hunter_debug.ts
 *       N=50 tsx exp_hunter_debug.ts   # faster
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid,
  firstLeadSeat, buildSeats, deck, newState, clockwise,
  StoryKind, StoryOutcome, ALL_STORIES,
  storyOutcome, rolloutSync, deck as pantherDeck,
} from "../panther.js";
import { reconstructBelief, Belief } from "../mc_panther.js";
import { State, Card } from "../../cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const DEALER_START = "C" as Player;
function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }
function cardStr(c: Card): string { return `${c.get("label")}${c.get("suit").toString()[0]}`; }

const TRUMP_OPTIONS: { trump: string | null; label: string }[] = [
  { trump: "Spades",   label: "Sp" }, { trump: "Diamonds", label: "Di" },
  { trump: "Hearts",   label: "He" }, { trump: "Clubs",    label: "Cl" },
  { trump: null,       label: "PO" },
];

// ---------------------------------------------------------------------------
// Scoring (same as exp_balance / exp_selection)
// ---------------------------------------------------------------------------
const V = { small: 3, med: 4, large: 5, nil: 4, fail: 1 } as const;

function tierPts(tier: StoryOutcome, story: StoryKind) {
  if (story === "PantherDefends")
    return tier === "medium" ? { panther: V.nil, hunters: 0 } : { panther: 0, hunters: V.fail };
  if (tier === "fail") return { panther: 0, hunters: V.fail };
  return { panther: tier === "large" ? V.large : tier === "medium" ? V.med : V.small, hunters: 0 };
}

// The two signal modes being compared.
type SignalMode = "balance-buggy" | "selection-correct";

function getSignal(mode: SignalMode, player: Player, panther: Player,
                   pT: number, cT: number, story: StoryKind): number {
  const pts = tierPts(storyOutcome(pT, cT, story), story);
  // BUGGY (exp_balance): Hunter sees its OWN pts; minimising → helps Panther.
  if (mode === "balance-buggy")
    return player === panther ? pts.panther : pts.hunters;
  // CORRECT (exp_selection): always Panther's pts; minimising → hurts Panther.
  return pts.panther;
}

// ---------------------------------------------------------------------------
// Instrumented MC answerer — supports both signal modes + optional logging.
// ---------------------------------------------------------------------------
interface DecisionRecord {
  hand: number; trick: number; player: Player; role: "Panther"|"Hunter";
  zname: string; options: string[]; scoresA: number[]; scoresB: number[];
  choiceA: string; choiceB: string; differ: boolean;
}

class DebugAnswerer implements Answerer {
  private readonly deck: Card[];
  constructor(
    private player:   Player,
    private st:       State,
    private cfg:      PantherConfig,
    private rng:      Rng,
    private story:    StoryKind,
    private iters:    number,
    private mode:     SignalMode,
    private log:      DecisionRecord[] | null,
    private handNum:  number,
  ) { this.deck = pantherDeck(cfg); }

  answer(req: Choice): Card | string | number {
    if (req.options.length <= 1) return req.options[0];
    if (req.key !== "play") return this.rng.choice(req.options);

    const panther  = this.st.vars.panther as Player;
    const trump    = this.st.vars.trump   as string | null;
    const seats    = this.st.vars.seats   as [Player, string][];
    const belief   = reconstructBelief(
      this.st.viewFor(this.player), this.player, PLAYERS, this.cfg);
    if (!belief.panther) return this.rng.choice(req.options);

    const fromZone = (req.meta?.seat as string) ?? `hand:${this.player}`;
    const options  = req.options as Card[];
    const scores   = options.map(c =>
      this.evalCard(c, fromZone, belief, trump, seats, panther, this.mode));

    const wantMax = this.player === panther;   // same in both harnesses
    const best    = wantMax ? Math.max(...scores) : Math.min(...scores);
    const chosen  = options[scores.indexOf(best)];

    // Optionally also compute "other harness" scores for logging.
    if (this.log && this.player !== panther) {
      const otherMode: SignalMode =
        this.mode === "balance-buggy" ? "selection-correct" : "balance-buggy";
      const scoresOther = options.map(c =>
        this.evalCard(c, fromZone, belief, trump, seats, panther, otherMode));
      const bestOther = Math.min(...scoresOther);
      const chosenOther = options[scoresOther.indexOf(bestOther)];

      const [scoresA, scoresB] = this.mode === "balance-buggy"
        ? [scores, scoresOther] : [scoresOther, scores];
      const [choiceA, choiceB] = this.mode === "balance-buggy"
        ? [cardStr(chosen), cardStr(chosenOther)]
        : [cardStr(chosenOther), cardStr(chosen)];

      this.log.push({
        hand: this.handNum,
        trick: belief.trickNumber,
        player: this.player,
        role: "Hunter",
        zname: fromZone,
        options: options.map(cardStr),
        scoresA: scoresA.map(x => Math.round(x * 1000) / 1000),
        scoresB: scoresB.map(x => Math.round(x * 1000) / 1000),
        choiceA,
        choiceB,
        differ: choiceA !== choiceB,
      });
    }
    return chosen;
  }

  private evalCard(card: Card, fromZone: string, belief: Belief,
      trump: string | null, seats: [Player, string][], panther: Player,
      mode: SignalMode): number {
    const hs       = calcHandSize(this.cfg);
    const authorSi = seats.findIndex(([, z]) => z === fromZone);
    const extPlays: [number, Card][] = [...belief.partialPlays, [authorSi, card]];
    const extLed   = belief.partialLed ?? (card.get("suit") as string);
    const cid      = cardId(card);
    const pool     = this.unknownPool(belief);
    const opSlots  = PLAYERS.filter(p => p !== this.player)
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
      const tP = (belief.won[panther] ?? 0) + pantherTricks;
      const tC = belief.crowWon + crowTricks;
      total += getSignal(mode, this.player, panther, tP, tC, this.story);
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
// Deal + auction helpers (minimal, copied from exp_balance)
// ---------------------------------------------------------------------------
function dealCards(cfg: PantherConfig, players: Player[], seed: number): State {
  const hs = calcHandSize(cfg);
  const st = newState(players, new Rng(seed));
  st.z("deck").cards = deck(cfg);
  st.shuffle("deck");
  for (const p of players) st.deal("deck", `hand:${p}`, hs);
  st.deal("deck", "crow", hs);
  st.deal("deck", "woods", cfg.woodsSize);
  return st;
}

function evalBid(player: Player, panther: Player, bid: {story: StoryKind; trump: string|null},
    st: State, cfg: PantherConfig, rng: Rng, n: number): number {
  const hs = calcHandSize(cfg); const seats = buildSeats(PLAYERS, panther);
  const lead = firstLeadSeat(seats, panther, PLAYERS, cfg);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const hands: Record<string, Card[]> = {};
    for (const [, z] of seats) hands[z] = [...st.z(z).cards];
    const { pantherTricks, crowTricks } = rolloutSync(
      hands, seats, lead, 0, hs, [], null, null, bid.trump, panther, rng);
    total += tierPts(storyOutcome(pantherTricks, crowTricks, bid.story), bid.story).panther;
  }
  return total / n;
}

function selectBid(player: Player, st: State, cfg: PantherConfig,
    rng: Rng, n: number): {story: StoryKind; trump: string|null} {
  let best = {story: ALL_STORIES[0], trump: null as string|null}, bestEV = -Infinity;
  for (const story of ALL_STORIES)
    for (const { trump } of TRUMP_OPTIONS) {
      const ev = evalBid(player, player, { story, trump }, st, cfg, rng, n);
      if (ev > bestEV) { bestEV = ev; best = { story, trump }; }
    }
  return best;
}

// Simple 0-pass auction for the diagnostic (all 3 always bid; left-of-dealer selects own)
function simpleAuction(st: State, cfg: PantherConfig, dealer: Player,
    seed: number): {panther: Player; story: StoryKind; trump: string|null} {
  const lod = clockwise(PLAYERS, dealer)[1];
  // lod evaluates all 3 players' bids from their own perspective (Panther EV).
  // lod always picks their own bid (Panther EV >> Hunter EV), so lod = Panther.
  const bid = selectBid(lod, st, cfg, new Rng(seed * 9973 + 1), 15);
  return { panther: lod, ...bid };
}

// Play a deal and return make result + Hunter pts.
async function playDeal(
  st: State, panther: Player, story: StoryKind, trump: string|null,
  cfg: PantherConfig, seed: number, iters: number,
  hunterMode: SignalMode, log: DecisionRecord[]|null, handNum: number,
): Promise<{made: boolean; hunterPts: number}> {
  const hs = calcHandSize(cfg);
  const seats = buildSeats(PLAYERS, panther);
  st.vars.seats = seats; st.vars.panther = panther; st.vars.trump = trump;
  st.emit("HandStart", { dealer: DEALER_START });
  const bid: Bid = { tricks: 1, trump, perilsOnly: trump === null };
  st.emit("Bid", { player: panther, ...bid });

  const answerers = new Map<Player|null, Answerer>();
  PLAYERS.forEach((p, i) => {
    // Panther always uses correct signal (same in both harnesses).
    // Hunter uses the specified mode.
    const mode: SignalMode = p === panther ? "selection-correct" : hunterMode;
    answerers.set(p, new DebugAnswerer(
      p, st, cfg, new Rng(seed * 1009 + i * 997 + 1),
      story, iters, mode, (log && p !== panther) ? log : null, handNum));
  });
  answerers.set(null, { answer: (r: Choice) => new Rng(seed * 911 + 7).choice(r.options) });

  await run(playTricks(st, {
    seats, lead: firstLeadSeat(seats, panther, PLAYERS, cfg),
    handSize: hs, panther, bid,
    trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
    won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
  }, cfg), answerers);

  let pT = 0, cT = 0;
  for (const e of st.log) {
    if (e.type !== "TrickWon") continue;
    if (e.payload.seat === `hand:${panther}`) pT++;
    else if (e.payload.seat === "crow") cT++;
  }
  const tier = storyOutcome(pT, cT, story);
  const pts  = tierPts(tier, story);
  const made = tier !== "fail";
  const hunterPts = pts.hunters;  // per Hunter
  return { made, hunterPts };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N     = parseInt(process.env.N    ?? "200");
  const ITERS = parseInt(process.env.ITER ?? "20");
  const cfg: PantherConfig = DEFAULT_CONFIG;

  console.log(`exp_hunter_debug — N=${N}, ITER=${ITERS}`);
  console.log(`Comparing two Hunter signal modes on the same deals.\n`);

  // --- Part 1: root-cause walkthrough ---
  console.log("=".repeat(68));
  console.log("ROOT CAUSE: signal function × wantMax direction");
  console.log("=".repeat(68));
  console.log(`
exp_balance.ts  BalanceMCAnswerer.evalCard (line ~237):
  total += signalFor(this.player, panther, tP, tC, this.story)
  For a Hunter:  signalFor returns  pts.HUNTERS  (= 0 on make, ${V.fail} on fail)
  wantMax = false  →  Hunter MINIMISES signal
  Minimising P(fail) × ${V.fail}  =  wanting Panther to SUCCEED  ← BUG

exp_selection.ts  PointsMCAnswerer.evalCard (line ~181):
  total += evalSignal(totalP, totalC, this.story)
  evalSignal always returns  pts.PANTHER  (= 3/4/5 on make, 0 on fail)
  wantMax = false  →  Hunter MINIMISES Panther's pts
  Minimising Panther pts  =  wanting Panther to FAIL  ← CORRECT

Consequence: in exp_balance, every Hunter plays like a second Panther.
Expected effect: make-rate jumps to ~99% (near the Panther's full ability).`);

  // --- Part 2: make-rate comparison ---
  console.log("\n" + "=".repeat(68));
  console.log(`MAKE-RATE COMPARISON  (N=${N} deals, same seeds, same Panther)`);
  console.log("=".repeat(68));

  let makeA = 0, makeB = 0;
  let hunterPtsA = 0, hunterPtsB = 0;
  let diffCount = 0;

  // We'll deep-dive the first deal where choices differ.
  let deepDiveLog: { A: DecisionRecord[]; B: DecisionRecord[] } | null = null;
  let deepDiveDeal = -1;
  let deepDiveInfo: { story: string; trump: string; panther: string } | null = null;

  let dealer = DEALER_START;
  for (let d = 0; d < N; d++) {
    const seed = d + 1;
    const st   = dealCards(cfg, PLAYERS, seed);

    // Get contract via simple auction (always 0-pass, lod selects own bid).
    const { panther, story, trump } = simpleAuction(st, cfg, dealer, seed);

    // Run A: buggy Hunter signal.
    const stA = dealCards(cfg, PLAYERS, seed);   // fresh identical deal
    const logA: DecisionRecord[] = [];
    const resA = await playDeal(stA, panther, story, trump, cfg, seed, ITERS,
                                "balance-buggy", logA, d);
    if (resA.made) makeA++;
    hunterPtsA += resA.hunterPts;

    // Run B: correct Hunter signal.
    const stB = dealCards(cfg, PLAYERS, seed);   // fresh identical deal
    const logB: DecisionRecord[] = [];
    const resB = await playDeal(stB, panther, story, trump, cfg, seed, ITERS,
                                "selection-correct", logB, d);
    if (resB.made) makeB++;
    hunterPtsB += resB.hunterPts;

    // Check for any choice differences.
    const anyDiff = logA.some((r, i) => logB[i] && r.choiceA !== logB[i]?.choiceA);
    if (anyDiff) diffCount++;
    if (anyDiff && deepDiveLog === null) {
      deepDiveLog = { A: logA, B: logB };
      deepDiveDeal = d + 1;
      const tl = TRUMP_OPTIONS.find(t => t.trump === trump)!.label;
      deepDiveInfo = { story, trump: tl, panther };
    }

    dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length] as Player;
  }

  const f = (n: number, tot: number) => `${(100*n/tot).toFixed(1)}%`;
  console.log(`\n  Harness          Make-rate   Hunter EV/deal   Deals w/ diff choice`);
  console.log("  " + "─".repeat(60));
  console.log(`  A (balance-buggy)   ${f(makeA,N).padStart(6)}    ${(hunterPtsA/N).toFixed(3).padStart(8)}         ${diffCount}/${N}`);
  console.log(`  B (selection-corr)  ${f(makeB,N).padStart(6)}    ${(hunterPtsB/N).toFixed(3).padStart(8)}`);
  console.log(`  Δ (A − B)          ${((makeA-makeB)*100/N).toFixed(1).padStart(7)}pp`);

  // --- Part 3: deep dive on one deal ---
  if (deepDiveLog) {
    const { A: logA, B: logB } = deepDiveLog;
    console.log("\n" + "=".repeat(68));
    console.log(`DEEP DIVE: deal ${deepDiveDeal}  (${deepDiveInfo!.story}/${deepDiveInfo!.trump}, Panther=${deepDiveInfo!.panther})`);
    console.log("  Shows each Hunter decision where the two harnesses computed different scores.");
    console.log("  signal-A = Hunter's own pts (0 or 1).  signal-B = Panther's pts (0–5).");
    console.log("  wantMax=false in BOTH → A minimises Hunter pts, B minimises Panther pts.");
    console.log("=".repeat(68));

    const maxRows = 8;
    let shown = 0;
    for (let i = 0; i < Math.min(logA.length, logB.length) && shown < maxRows; i++) {
      const rA = logA[i], rB = logB[i];
      if (rA.choiceA === rB.choiceA) continue;  // choices agree, skip
      shown++;
      const opts = rA.options.join(" ");
      console.log(`\n  Trick ${rA.trick}  ${rA.player} (${rA.zname})  options: ${opts}`);
      console.log(`  Harness A scores (Hunter's own pts, minimised):`);
      rA.options.forEach((o, j) => {
        const marker = o === rA.choiceA ? " ← A chooses (min Hunter pts)" : "";
        console.log(`    ${o.padEnd(6)}  ${String(rA.scoresA[j]).padStart(5)}${marker}`);
      });
      console.log(`  Harness B scores (Panther's pts, minimised):`);
      rA.options.forEach((o, j) => {
        const marker = o === rA.choiceB ? " ← B chooses (min Panther pts)" : "";
        console.log(`    ${o.padEnd(6)}  ${String(rA.scoresB[j]).padStart(5)}${marker}`);
      });
      const interp = rA.scoresA[rA.options.indexOf(rA.choiceA)] <
                     rA.scoresA[rA.options.indexOf(rA.choiceB)]
        ? `  A chose ${rA.choiceA} (lower Hunter pts = lower P(fail)) → helps Panther succeed.`
        : `  A chose ${rA.choiceA} (unexpectedly — scores may be near-equal).`;
      console.log(interp);
    }
    if (shown === 0) console.log("  (All decisions agreed on this deal — try a different seed.)");
  }

  // --- Part 4: additional sanity checks ---
  console.log("\n" + "=".repeat(68));
  console.log("SANITY CHECKS (single deal, Hunter B on trick 1)");
  console.log("=".repeat(68));
  const checkSeed = 1;
  const stCheck = dealCards(cfg, PLAYERS, checkSeed);
  const { panther: cp, story: cs, trump: ct } =
    simpleAuction(stCheck, cfg, DEALER_START, checkSeed);
  const stC2 = dealCards(cfg, PLAYERS, checkSeed);
  const cpSeats = buildSeats(PLAYERS, cp);
  stC2.vars.seats = cpSeats; stC2.vars.panther = cp; stC2.vars.trump = ct;
  stC2.emit("HandStart", { dealer: DEALER_START });
  stC2.emit("Bid", { player: cp, tricks: 1, trump: ct, perilsOnly: ct === null });

  const hunter = PLAYERS.find(p => p !== cp)!;
  const iters = ITERS;
  console.log(`\n  Deal 1: ${cs}/${TRUMP_OPTIONS.find(t=>t.trump===ct)!.label}, Panther=${cp}`);
  console.log(`  Checking Hunter ${hunter}:`);

  // Manually evaluate one card choice for Hunter under both modes.
  const belief = reconstructBelief(stC2.viewFor(hunter), hunter, PLAYERS, cfg);
  const pool = (function(b: Belief) {
    const known = new Set<string>();
    for (const c of [...b.myHand,...b.crow,...b.completedTrickCards,...b.currentTrickCards])
      known.add(cardId(c));
    return deck(cfg).filter(c => !known.has(cardId(c)));
  })(belief);

  console.log(`  ITER=${iters}, belief.panther=${belief.panther ?? "null"}`);
  console.log(`  Unknown pool size: ${pool.length}  (expected: 45 - myHand - crow = ${45-belief.myHand.length-belief.crow.length})`);
  console.log(`  belief.myHand: ${belief.myHand.map(cardStr).join(" ")}`);
  console.log(`  Is belief.panther === actual panther? ${belief.panther === cp}`);

  // Signal example for one card under both modes at trick 0.
  const exCard = belief.myHand[0];
  if (exCard) {
    const rng = new Rng(999);
    let totA = 0, totB = 0;
    for (let i = 0; i < 30; i++) {
      const p = [...pool]; rng.shuffle(p);
      const hands: Record<string,Card[]> = {};
      const opSlots = PLAYERS.filter(q=>q!==hunter).map(q=>({zname:`hand:${q}`,size:Math.max(0,belief.opponentHandSizes[q]??0)}));
      let off=0; for(const {zname,size} of opSlots){hands[zname]=p.slice(off,off+size);off+=size;}
      hands[`hand:${hunter}`]=[...belief.myHand]; hands["crow"]=[...belief.crow];
      const h=hands[`hand:${hunter}`]; const idx=h.findIndex(c=>cardId(c)===cardId(exCard)); if(idx>=0)h.splice(idx,1);
      const seats=cpSeats; const {pantherTricks,crowTricks}=rolloutSync(
        hands,seats,belief.lead,belief.trickNumber,calcHandSize(cfg),
        [...belief.partialPlays,[seats.findIndex(([,z])=>z===`hand:${hunter}`),exCard]],
        exCard.get("suit") as string,belief.forcedFromPartials,ct,cp,rng);
      const tP=(belief.won[cp]??0)+pantherTricks, tC=belief.crowWon+crowTricks;
      totA += getSignal("balance-buggy",   hunter, cp, tP, tC, cs);
      totB += getSignal("selection-correct",hunter, cp, tP, tC, cs);
    }
    console.log(`\n  Example card: ${cardStr(exCard)}  (30 rollouts)`);
    console.log(`  Signal A (balance-buggy,   Hunter's own pts): ${(totA/30).toFixed(3)}  → minimising = HELP Panther`);
    console.log(`  Signal B (selection-correct, Panther's pts ): ${(totB/30).toFixed(3)}  → minimising = HURT Panther`);
    console.log(`  (Signal A ≈ P(fail).  Signal B ≈ E[Panther pts].  Both minimised by Hunters.)`);
  }

  console.log("\n" + "=".repeat(68));
  console.log("SUMMARY");
  console.log("=".repeat(68));
  console.log(`Bug location: exp_balance.ts  BalanceMCAnswerer.evalCard  (the 'total +=' line)`);
  console.log(`  Current:  total += signalFor(this.player, panther, ...)  ← returns Hunter pts for Hunters`);
  console.log(`  Fix:      total += signalFor(panther,     panther, ...)  ← always Panther pts`);
  console.log(`  Or:       total += tierPts(storyOutcome(tP,tC,this.story),this.story).panther`);
  console.log(`  (Same one-word change that exp_selection makes: always report Panther's reward,`);
  console.log(`   then wantMax=false minimises Panther pts = actual defending.)`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
