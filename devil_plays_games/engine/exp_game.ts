/**
 * exp_game.ts — full 3-player competitive game simulation.
 *
 * Each player uses realistic flat MC throughout:
 *   Phase 1 (bidding):  evaluate all (story × trump) combinations, bid or pass.
 *   Phase 2 (auction):  selector chooses the winning bid per the auction rules.
 *   Phase 3 (play):     Panther maximizes, Hunters minimize E[Panther points].
 *
 * Auction rules:
 *   0 passes : left-of-dealer selects winning bid (may choose own).
 *   1 pass   : the passer selects from the 2 remaining bids.
 *   2 passes : the solo bidder wins automatically.
 *   all pass : left-of-dealer forced to bid; double pts on success.
 *
 * Selection evaluation uses omniscient random rollouts (fast, selection only).
 * Play uses realistic determinization MC (samples opponent hands).
 *
 * One-pass EV-gap: when exactly 1 player passes, they evaluate both active
 * bids as Hunter and record evA, evB, gap = evA - evB (signed).
 *
 * Env vars:
 *   HANDS=300     number of hands
 *   ITER=20       MC rollouts per card option (play)
 *   SEL_ITER=20   random rollouts per (story × trump) combo (selection)
 *   PASS_EV=0.75  pass if best EV < this threshold
 *
 * Run:  tsx exp_game.ts
 *       HANDS=10 ITER=5 SEL_ITER=5 tsx exp_game.ts   # smoke test
 */
import { Rng, Player, run, Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid,
  firstLeadSeat, buildSeats, deck, newState, clockwise,
  StoryKind, StoryOutcome, ALL_STORIES, STORY_LABELS,
  storyOutcome, storyPoints, rolloutSync, deck as pantherDeck,
} from "./panther.js";
import { reconstructBelief, Belief } from "./mc_panther.js";
import { State, Card } from "./cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];
function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TRUMP_OPTIONS: { trump: string | null; label: string; abbr: string }[] = [
  { trump: "Spades",   label: "Spades",     abbr: "Sp" },
  { trump: "Diamonds", label: "Diamonds",   abbr: "Di" },
  { trump: "Hearts",   label: "Hearts",     abbr: "He" },
  { trump: "Clubs",    label: "Clubs",      abbr: "Cl" },
  { trump: null,       label: "PerilsOnly", abbr: "PO" },
];
const STORY_ABBR: Record<StoryKind, string> = {
  BothAttack: "BA", BothDefend: "BD", PantherDefends: "PD",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface BidChoice  { story: StoryKind; trump: string | null; }
type     PlayerBid   = BidChoice | "pass";

interface PassEVData {
  passingPlayer: Player;
  bidA:   { bidder: Player; bid: BidChoice; ev: number };
  bidB:   { bidder: Player; bid: BidChoice; ev: number };
  gap:    number;   // evA - evB (signed; winner was chosen on sign)
  chosen: Player;
}

interface AuctionResult {
  panther:     Player;
  contract:    BidChoice;
  doubled:     boolean;
  auctionType: "0pass" | "1pass" | "2pass" | "3pass";
  passEVData?: PassEVData;
}

interface HandRecord {
  hand:    number;
  dealer:  Player;
  bids:    Record<Player, PlayerBid>;
  auction: AuctionResult;
  pTricks: number;
  cTricks: number;
  outcome: StoryOutcome;
  points:  Record<Player, number>;
}

// ---------------------------------------------------------------------------
// Deal cards — Panther-agnostic (Panther determined by auction).
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

// ---------------------------------------------------------------------------
// evalBidForPlayer — omniscient random rollouts.
//   player === panther  →  E[Panther pts]
//   player !== panther  →  E[Hunter pts for player]
// ---------------------------------------------------------------------------
function evalBidForPlayer(
  player: Player, panther: Player, bid: BidChoice,
  st: State, allPlayers: Player[], cfg: PantherConfig,
  rng: Rng, n: number,
): number {
  const hs    = calcHandSize(cfg);
  const seats = buildSeats(allPlayers, panther);
  const lead  = firstLeadSeat(seats, panther, allPlayers, cfg);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const hands: Record<string, Card[]> = {};
    for (const [, zname] of seats) hands[zname] = [...st.z(zname).cards];
    const { pantherTricks, crowTricks } = rolloutSync(
      hands, seats, lead, 0, hs, [], null, null, bid.trump, panther, rng);
    const pts = storyPoints(pantherTricks, crowTricks, bid.story);
    total += player === panther ? pts.panther : pts.hunters;
  }
  return total / n;
}

// ---------------------------------------------------------------------------
// selectBidForPlayer — best (story × trump) for player as Panther.
// Returns null if all combos < passEV. passEV=null → forced (no pass option).
// ---------------------------------------------------------------------------
function selectBidForPlayer(
  player: Player, st: State, allPlayers: Player[], cfg: PantherConfig,
  rng: Rng, nPerCombo: number, passEV: number | null,
): { bid: BidChoice; ev: number } | null {
  let best: BidChoice | null = null;
  let bestEV = passEV ?? -Infinity;
  for (const story of ALL_STORIES) {
    for (const { trump } of TRUMP_OPTIONS) {
      const ev = evalBidForPlayer(player, player, { story, trump },
                                  st, allPlayers, cfg, rng, nPerCombo);
      if (ev > bestEV) { bestEV = ev; best = { story, trump }; }
    }
  }
  return best !== null ? { bid: best, ev: bestEV } : null;
}

// ---------------------------------------------------------------------------
// resolveAuction
// ---------------------------------------------------------------------------
function resolveAuction(
  bids: Record<Player, PlayerBid>,
  players: Player[], dealer: Player,
  st: State, cfg: PantherConfig,
  rng: Rng, nRollouts: number,
): AuctionResult {
  const lod     = clockwise(players, dealer)[1];   // left-of-dealer
  const passers = players.filter(p => bids[p] === "pass");
  const bidders = players.filter(p => bids[p] !== "pass");

  // All passed → forced bid by left-of-dealer; double pts on make.
  if (passers.length === 3) {
    const forced = selectBidForPlayer(lod, st, players, cfg, rng, nRollouts, null)!;
    return { panther: lod, contract: forced.bid, doubled: true, auctionType: "3pass" };
  }

  // Two passed → solo bidder wins automatically.
  if (passers.length === 2) {
    return {
      panther:  bidders[0],
      contract: bids[bidders[0]] as BidChoice,
      doubled: false, auctionType: "2pass",
    };
  }

  // One passed → passer selects from 2 active bids (as Hunter, maximise own pts).
  if (passers.length === 1) {
    const passer = passers[0];
    const [b1, b2] = bidders;
    const bid1 = bids[b1] as BidChoice;
    const bid2 = bids[b2] as BidChoice;
    const ev1 = evalBidForPlayer(passer, b1, bid1, st, players, cfg, rng, nRollouts);
    const ev2 = evalBidForPlayer(passer, b2, bid2, st, players, cfg, rng, nRollouts);
    const useFirst  = ev1 >= ev2;
    const [winner, contract] = useFirst ? [b1, bid1] : [b2, bid2];
    return {
      panther: winner, contract, doubled: false, auctionType: "1pass",
      passEVData: {
        passingPlayer: passer,
        bidA: { bidder: b1, bid: bid1, ev: ev1 },
        bidB: { bidder: b2, bid: bid2, ev: ev2 },
        gap: ev1 - ev2,
        chosen: winner,
      },
    };
  }

  // No passes → left-of-dealer selects (own bid = Panther EV, others' = Hunter EV).
  let bestEV = -Infinity;
  let winner  = bidders[0];
  let contract = bids[bidders[0]] as BidChoice;
  for (const bidder of players) {
    const bid = bids[bidder] as BidChoice;
    const ev  = evalBidForPlayer(lod, bidder, bid, st, players, cfg, rng, nRollouts);
    if (ev > bestEV) { bestEV = ev; winner = bidder; contract = bid; }
  }
  return { panther: winner, contract, doubled: false, auctionType: "0pass" };
}

// ---------------------------------------------------------------------------
// StoryMCAnswerer — realistic flat MC, E[Panther pts] signal.
// Works for any Panther (reads st.vars.panther).
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
  ) { this.deck = pantherDeck(cfg); }

  answer(req: Choice): Card | string | number {
    if (req.options.length <= 1) return req.options[0];
    if (req.key !== "play") return this.rng.choice(req.options);
    const panther = this.st.vars.panther as Player;
    const trump   = this.st.vars.trump   as string | null;
    const seats   = this.st.vars.seats   as [Player, string][];
    const belief  = reconstructBelief(
      this.st.viewFor(this.player), this.player, this.allPlayers, this.cfg);
    if (!belief.panther) return this.rng.choice(req.options);
    const fromZone = (req.meta?.seat as string) ?? `hand:${this.player}`;
    const options  = req.options as Card[];
    const scores   = options.map(c =>
      this.evalCard(c, fromZone, belief, trump, seats, panther));
    const wantMax = this.player === panther;
    const best    = wantMax ? Math.max(...scores) : Math.min(...scores);
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
    const opSlots  = this.allPlayers
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
// Display helpers
// ---------------------------------------------------------------------------
function bidStr(b: PlayerBid): string {
  if (b === "pass") return "pass";
  return `${STORY_ABBR[b.story]}/${TRUMP_OPTIONS.find(t => t.trump === b.trump)!.abbr}`;
}
function outcStr(oc: StoryOutcome): string {
  return oc === "large" ? "+5" : oc === "medium" ? "+2" : oc === "small" ? "+1" : "fail";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N        = parseInt(process.env.HANDS    ?? "300");
  const iters    = parseInt(process.env.ITER     ?? "20");
  const selIters = parseInt(process.env.SEL_ITER ?? "20");
  const passEV   = parseFloat(process.env.PASS_EV ?? "0.75");
  const cfg: PantherConfig = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);

  console.log(`exp_game — ${N} hands, ITER=${iters}, SEL_ITER=${selIters}, PASS_EV=${passEV}`);
  console.log(`Players: A B C  |  realistic flat MC  |  full 3-player auction\n`);

  const scores: Record<Player, number> = { A: 0, B: 0, C: 0 };
  const records: HandRecord[] = [];
  const auctCount: Record<string, number> = { "0pass": 0, "1pass": 0, "2pass": 0, "3pass": 0 };
  let dealer = "C" as Player;

  // Header
  const row = (cells: string[]) => cells.join("");
  const HDR = row([
    " # ".padEnd(4),   "Dlr".padEnd(4),
    "Bid-A".padEnd(8), "Bid-B".padEnd(8), "Bid-C".padEnd(8),
    "Auct".padEnd(7),  "Pnth".padEnd(5),  "Contract".padEnd(10),
    "pT".padStart(3),  "cT".padStart(3),  " Outc".padEnd(7),
    "A".padStart(4),   "B".padStart(4),   "C".padStart(4),
    " SA".padStart(5), " SB".padStart(5), " SC".padStart(5),
  ]);
  console.log(HDR);
  console.log("─".repeat(HDR.length));

  let firstTo50Announced = false;

  for (let h = 0; h < N; h++) {
    if (h > 0 && h % 50 === 0)
      console.log(`  ── hand ${h}  A=${scores.A} B=${scores.B} C=${scores.C} ──`);

    const seed = h + 1;
    const st   = dealCards(cfg, PLAYERS, seed);
    st.emit("HandStart", { dealer });

    // Bidding
    const bids: Record<Player, PlayerBid> = {} as any;
    for (let i = 0; i < PLAYERS.length; i++) {
      const p    = PLAYERS[i];
      const pRng = new Rng(seed * 1009 + i * 997 + 1);
      const res  = selectBidForPlayer(p, st, PLAYERS, cfg, pRng, selIters, passEV);
      bids[p]    = res ? res.bid : "pass";
    }

    // Auction resolution
    const aRng  = new Rng(seed * 5003 + 3);
    const auction = resolveAuction(bids, PLAYERS, dealer, st, cfg, aRng, selIters);
    auctCount[auction.auctionType]++;

    const { panther, contract, doubled } = auction;
    const seats = buildSeats(PLAYERS, panther);
    st.vars.seats   = seats;
    st.vars.panther = panther;
    st.vars.trump   = contract.trump;
    const bid: Bid = { tricks: 1, trump: contract.trump, perilsOnly: contract.trump === null };
    st.emit("Bid", { player: panther, ...bid });

    // Play
    const answerers = new Map<Player | null, Answerer>();
    PLAYERS.forEach((p, i) =>
      answerers.set(p, new StoryMCAnswerer(
        p, st, PLAYERS, cfg, new Rng(seed * 1009 + i * 997 + 13), contract.story, iters)));
    answerers.set(null, { answer: (r: Choice) => new Rng(seed * 911 + 7).choice(r.options) });

    await run(playTricks(st, {
      seats, lead: firstLeadSeat(seats, panther, PLAYERS, cfg),
      handSize: hs, panther, bid,
      trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
      won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
    }, cfg), answerers);

    // Tally
    const tally: Record<string, number> = {};
    for (const e of st.log)
      if (e.type === "TrickWon")
        tally[e.payload.seat as string] = (tally[e.payload.seat as string] ?? 0) + 1;
    const pTricks = tally[`hand:${panther}`] ?? 0;
    const cTricks = tally["crow"]             ?? 0;

    // Score
    const oc  = storyOutcome(pTricks, cTricks, contract.story);
    const raw = storyPoints(pTricks, cTricks, contract.story);
    const pts: Record<Player, number> = Object.fromEntries(PLAYERS.map(p => [p, 0]));
    if (raw.panther > 0) {
      pts[panther] = doubled ? raw.panther * 2 : raw.panther;
    } else {
      for (const p of PLAYERS) if (p !== panther) pts[p] = raw.hunters;
    }
    for (const p of PLAYERS) scores[p] += pts[p];
    records.push({ hand: h + 1, dealer, bids, auction, pTricks, cTricks, outcome: oc, points: pts });

    // Row
    const cstr = `${STORY_ABBR[contract.story]}/${TRUMP_OPTIONS.find(t => t.trump === contract.trump)!.abbr}${doubled ? "x2" : ""}`;
    console.log(row([
      String(h + 1).padStart(3) + " ", dealer.padEnd(4),
      bidStr(bids.A).padEnd(8), bidStr(bids.B).padEnd(8), bidStr(bids.C).padEnd(8),
      auction.auctionType.padEnd(7), panther.padEnd(5), cstr.padEnd(10),
      String(pTricks).padStart(3), String(cTricks).padStart(3),
      (" " + outcStr(oc)).padEnd(7),
      String(pts.A).padStart(4), String(pts.B).padStart(4), String(pts.C).padStart(4),
      String(scores.A).padStart(5), String(scores.B).padStart(5), String(scores.C).padStart(5),
    ]));

    if (!firstTo50Announced && Math.max(...Object.values(scores)) >= 50) {
      const winner = PLAYERS.find(p => scores[p] >= 50)!;
      console.log(`  > ${winner} first reached 50 on hand ${h + 1}`);
      firstTo50Announced = true;
    }

    dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length] as Player;
  }

  // ===========================================================================
  // Summary
  // ===========================================================================
  console.log("\n" + "=".repeat(HDR.length));
  console.log("\nFinal scores after " + N + " hands:");
  for (const p of PLAYERS)
    console.log(`  ${p}: ${scores[p].toString().padStart(4)} pts  (${(scores[p]/N).toFixed(3)} pts/deal)`);

  console.log("\nAuction type distribution:");
  for (const [t, n] of Object.entries(auctCount))
    console.log(`  ${t.padEnd(7)} ${n.toString().padStart(4)}  (${(100*n/N).toFixed(1)}%)`);

  const storyCounts: Record<StoryKind, number> = {} as any;
  const storyOC: Record<StoryKind, Record<StoryOutcome, number>> = {} as any;
  for (const s of ALL_STORIES) { storyCounts[s] = 0; storyOC[s] = { large: 0, medium: 0, small: 0, fail: 0 }; }
  for (const r of records) { storyCounts[r.auction.contract.story]++; storyOC[r.auction.contract.story][r.outcome]++; }

  console.log("\nStory distribution:");
  console.log("  " + "Story".padEnd(16) + "n".padStart(5) +
    "P(fail)".padStart(9) + "E[Pnth]".padStart(9) + "E[Hntr]".padStart(9));
  for (const s of ALL_STORIES) {
    const n = storyCounts[s]; if (!n) continue;
    const oc = storyOC[s];
    const eP = (oc.large*5 + oc.medium*2 + oc.small*1) / n;
    const eH = oc.fail * (s === "PantherDefends" ? 5 : 3) / n;
    console.log("  " + STORY_LABELS[s].padEnd(16) + String(n).padStart(5) +
      `${(100*oc.fail/n).toFixed(1)}%`.padStart(9) +
      eP.toFixed(2).padStart(9) + eH.toFixed(2).padStart(9));
  }

  const trumpCounts: Record<string, number> = {};
  for (const { label } of TRUMP_OPTIONS) trumpCounts[label] = 0;
  for (const r of records)
    trumpCounts[TRUMP_OPTIONS.find(t => t.trump === r.auction.contract.trump)!.label]++;
  console.log("\nTrump distribution:");
  console.log("  " + TRUMP_OPTIONS.map(({ label }) =>
    `${label}: ${(100*(trumpCounts[label]??0)/N).toFixed(1)}%`).join("   "));

  const pCounts: Record<Player, number> = { A: 0, B: 0, C: 0 };
  for (const r of records) pCounts[r.auction.panther]++;
  console.log("\nPanther distribution:");
  for (const p of PLAYERS)
    console.log(`  ${p}: ${pCounts[p].toString().padStart(4)}  (${(100*pCounts[p]/N).toFixed(1)}%)`);

  // One-pass EV-gap
  const onePasses = records.filter(r => r.auction.passEVData);
  if (onePasses.length > 0) {
    const absGaps = onePasses.map(r => Math.abs(r.auction.passEVData!.gap)).sort((a, b) => a - b);
    const mean = absGaps.reduce((a, b) => a + b, 0) / absGaps.length;
    const pct  = (p: number) => absGaps[Math.min(absGaps.length-1, Math.floor(p*absGaps.length))];
    const evA  = onePasses.map(r => r.auction.passEVData!.bidA.ev);
    const evB  = onePasses.map(r => r.auction.passEVData!.bidB.ev);
    const mA = evA.reduce((a,b)=>a+b,0)/evA.length;
    const mB = evB.reduce((a,b)=>a+b,0)/evB.length;
    console.log(`\nOne-passer EV-gap (${onePasses.length} hands with exactly 1 pass):`);
    console.log(`  |gap|: mean=${mean.toFixed(3)}  P25=${pct(.25).toFixed(3)}  P50=${pct(.5).toFixed(3)}  P75=${pct(.75).toFixed(3)}  P90=${pct(.9).toFixed(3)}`);
    console.log(`  Mean Hunter EVs from passer's view: bidA=${mA.toFixed(3)}  bidB=${mB.toFixed(3)}`);
    // Largest-gap examples
    const top5 = [...onePasses]
      .sort((a, b) => Math.abs(b.auction.passEVData!.gap) - Math.abs(a.auction.passEVData!.gap))
      .slice(0, 5);
    console.log("  Top-5 largest-gap hands:");
    for (const r of top5) {
      const d = r.auction.passEVData!;
      console.log(`    hand ${String(r.hand).padStart(3)}  passer=${d.passingPlayer}  ` +
        `${bidStr(d.bidA.bid)}(${d.bidA.ev.toFixed(2)}) vs ${bidStr(d.bidB.bid)}(${d.bidB.ev.toFixed(2)})  ` +
        `gap=${Math.abs(d.gap).toFixed(3)}  chose=${d.chosen}  outcome=${outcStr(r.outcome)}`);
    }
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
