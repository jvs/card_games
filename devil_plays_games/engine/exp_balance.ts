/**
 * exp_balance.ts — full-game balance check with the locked scoring vector.
 *
 * Scoring vector:
 *   Both Attack / Both Defend:  small=3  med=4  large=5
 *   Panther Defends (nil):      make=4
 *   Hunter fail reward (each):  1    (any Panther fail)
 *   Force-fed (all-pass):       double on make, single on fail
 *
 * Auction rules (full 3-player):
 *   0 passes  → left-of-dealer selects winning bid (may pick own)
 *   1 pass    → passer selects from the 2 active bids
 *   2 passes  → sole bidder wins automatically
 *   all pass  → left-of-dealer forced to bid; double Panther pts on make
 *
 * Realistic flat MC for every seat.  Dealer rotates.
 *
 * Primary output: per-player mean pts/deal — the rotation-symmetry check.
 * Also: contract selection + make-rates, auction-type distribution,
 * force-feed breakdown, table-level point flow.
 *
 * Env vars:  N=3000  ITER=20  SEL_ITER=20  PASS_EV=0.75
 * Run:  tsx exp_balance.ts
 *       N=300 tsx exp_balance.ts    # quick smoke test
 */
import { Rng, Player, run, Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid,
  firstLeadSeat, buildSeats, deck, newState, clockwise,
  StoryKind, StoryOutcome, ALL_STORIES, STORY_LABELS,
  storyOutcome, rolloutSync, deck as pantherDeck,
} from "./panther.js";
import { reconstructBelief, Belief } from "./mc_panther.js";
import { State, Card } from "./cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];
function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

// ---------------------------------------------------------------------------
// Scoring vector (locked)
// ---------------------------------------------------------------------------
const V = { small: 3, med: 4, large: 5, nil: 4, fail: 1 } as const;

function tierPts(tier: StoryOutcome, story: StoryKind): { panther: number; hunters: number } {
  if (story === "PantherDefends")
    return tier === "medium" ? { panther: V.nil, hunters: 0 } : { panther: 0, hunters: V.fail };
  if (tier === "fail") return { panther: 0, hunters: V.fail };
  return { panther: tier === "large" ? V.large : tier === "medium" ? V.med : V.small, hunters: 0 };
}

function signalFor(player: Player, panther: Player, pT: number, cT: number, story: StoryKind): number {
  const pts = tierPts(storyOutcome(pT, cT, story), story);
  return player === panther ? pts.panther : pts.hunters;
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
type     PlayerBid  = BidChoice | "pass";

interface AuctionResult {
  panther:     Player;
  contract:    BidChoice;
  doubled:     boolean;
  auctionType: "0pass" | "1pass" | "2pass" | "3pass";
}

// ---------------------------------------------------------------------------
// Deal
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
// evalBidForPlayer — omniscient random rollouts, new scoring signal.
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
    for (const [, z] of seats) hands[z] = [...st.z(z).cards];
    const { pantherTricks, crowTricks } = rolloutSync(
      hands, seats, lead, 0, hs, [], null, null, bid.trump, panther, rng);
    total += signalFor(player, panther, pantherTricks, crowTricks, bid.story);
  }
  return total / n;
}

// ---------------------------------------------------------------------------
// selectBidForPlayer — best (story × trump) for `player` as Panther.
// passEV=null → forced bid (no pass option).
// ---------------------------------------------------------------------------
function selectBidForPlayer(
  player: Player, st: State, allPlayers: Player[], cfg: PantherConfig,
  rng: Rng, n: number, passEV: number | null,
): { bid: BidChoice; ev: number } | null {
  let best: BidChoice | null = null;
  let bestEV = passEV ?? -Infinity;
  for (const story of ALL_STORIES) {
    for (const { trump } of TRUMP_OPTIONS) {
      const ev = evalBidForPlayer(player, player, { story, trump },
                                  st, allPlayers, cfg, rng, n);
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
  rng: Rng, n: number,
): AuctionResult {
  const lod     = clockwise(players, dealer)[1];
  const passers = players.filter(p => bids[p] === "pass");
  const bidders = players.filter(p => bids[p] !== "pass");

  if (passers.length === 3) {
    const forced = selectBidForPlayer(lod, st, players, cfg, rng, n, null)!;
    return { panther: lod, contract: forced.bid, doubled: true, auctionType: "3pass" };
  }
  if (passers.length === 2)
    return { panther: bidders[0], contract: bids[bidders[0]] as BidChoice,
             doubled: false, auctionType: "2pass" };

  if (passers.length === 1) {
    const passer = passers[0];
    const [b1, b2] = bidders;
    const ev1 = evalBidForPlayer(passer, b1, bids[b1] as BidChoice, st, players, cfg, rng, n);
    const ev2 = evalBidForPlayer(passer, b2, bids[b2] as BidChoice, st, players, cfg, rng, n);
    const [winner, contract] = ev1 >= ev2
      ? [b1, bids[b1] as BidChoice] : [b2, bids[b2] as BidChoice];
    return { panther: winner, contract, doubled: false, auctionType: "1pass" };
  }

  // 0 passes: left-of-dealer selects (own bid → Panther EV; others' → Hunter EV)
  let bestEV = -Infinity, winner = bidders[0];
  let contract = bids[bidders[0]] as BidChoice;
  for (const bidder of players) {
    const ev = evalBidForPlayer(lod, bidder, bids[bidder] as BidChoice,
                                st, players, cfg, rng, n);
    if (ev > bestEV) { bestEV = ev; winner = bidder; contract = bids[bidder] as BidChoice; }
  }
  return { panther: winner, contract, doubled: false, auctionType: "0pass" };
}

// ---------------------------------------------------------------------------
// MC answerer — E[Panther points] signal, realistic sampling.
// ---------------------------------------------------------------------------
class BalanceMCAnswerer implements Answerer {
  private readonly deck: Card[];
  constructor(
    private player:  Player,
    private st:      State,
    private players: Player[],
    private cfg:     PantherConfig,
    private rng:     Rng,
    private story:   StoryKind,
    private iters:   number,
  ) { this.deck = pantherDeck(cfg); }

  answer(req: Choice): Card | string | number {
    if (req.options.length <= 1) return req.options[0];
    if (req.key !== "play") return this.rng.choice(req.options);
    const panther  = this.st.vars.panther as Player;
    const trump    = this.st.vars.trump   as string | null;
    const seats    = this.st.vars.seats   as [Player, string][];
    const belief   = reconstructBelief(this.st.viewFor(this.player),
                                       this.player, this.players, this.cfg);
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
    const opSlots  = this.players.filter(p => p !== this.player)
      .map(p => ({ zname: `hand:${p}` as string,
                   size:  Math.max(0, belief.opponentHandSizes[p] ?? 0) }));
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
      total += signalFor(panther, panther, tP, tC, this.story);  // always Panther's pts; Hunters minimise it
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
  const N        = parseInt(process.env.N        ?? "3000");
  const ITER     = parseInt(process.env.ITER     ?? "20");
  const SEL_ITER = parseInt(process.env.SEL_ITER ?? "20");
  const PASS_EV  = parseFloat(process.env.PASS_EV ?? "0.75");
  const cfg: PantherConfig = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);

  console.log(`exp_balance — N=${N} hands, ITER=${ITER}, SEL_ITER=${SEL_ITER}, PASS_EV=${PASS_EV}`);
  console.log(`Vector: BA/BD small=${V.small}/med=${V.med}/large=${V.large}; PD nil=${V.nil}; Hunter fail=${V.fail}; force-fed doubles make`);
  console.log(`Realistic MC all seats. Dealer rotates.\n`);

  // ---- Accumulators ----
  const scores:        Record<Player, number>   = { A: 0, B: 0, C: 0 };
  const asPanther:     Record<Player, number>   = { A: 0, B: 0, C: 0 };
  const ptsAsPanther:  Record<Player, number>   = { A: 0, B: 0, C: 0 };
  const ptsAsHunter:   Record<Player, number>   = { A: 0, B: 0, C: 0 };

  const auctCount:  Record<string, number> = { "0pass": 0, "1pass": 0, "2pass": 0, "3pass": 0 };
  const storyCnt:   Record<StoryKind, number> = {} as any;
  const storyMake:  Record<StoryKind, number> = {} as any;
  const storyTiers: Record<StoryKind, Record<StoryOutcome, number>> = {} as any;
  const trumpCnt:   Record<StoryKind, Record<string, number>> = {} as any;
  let   totalPantherPts = 0, totalHunterPts = 0;
  let   ffPantherPts = 0, ffHunterPts = 0, ffCount = 0;

  for (const s of ALL_STORIES) {
    storyCnt[s]   = 0;
    storyMake[s]  = 0;
    storyTiers[s] = { large: 0, medium: 0, small: 0, fail: 0 };
    trumpCnt[s]   = {};
    for (const { label } of TRUMP_OPTIONS) trumpCnt[s][label] = 0;
  }

  const prog = Math.max(250, Math.floor(N / 12));
  let dealer = "C" as Player;

  for (let d = 0; d < N; d++) {
    if (d > 0 && d % prog === 0)
      process.stdout.write(`  ${d}/${N}  A=${scores.A} B=${scores.B} C=${scores.C}\n`);

    const seed = d + 1;
    const st   = dealCards(cfg, PLAYERS, seed);
    st.emit("HandStart", { dealer });

    // Bidding
    const bids: Record<Player, PlayerBid> = {} as any;
    for (let i = 0; i < PLAYERS.length; i++) {
      const p   = PLAYERS[i];
      const res = selectBidForPlayer(p, st, PLAYERS, cfg,
                                     new Rng(seed * 1009 + i * 997 + 1), SEL_ITER, PASS_EV);
      bids[p]   = res ? res.bid : "pass";
    }

    // Auction
    const auction = resolveAuction(bids, PLAYERS, dealer, st, cfg,
                                   new Rng(seed * 5003 + 3), SEL_ITER);
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
      answerers.set(p, new BalanceMCAnswerer(
        p, st, PLAYERS, cfg, new Rng(seed * 1009 + i * 997 + 13), contract.story, ITER)));
    answerers.set(null, { answer: (r: Choice) => new Rng(seed * 911 + 7).choice(r.options) });

    await run(playTricks(st, {
      seats, lead: firstLeadSeat(seats, panther, PLAYERS, cfg),
      handSize: hs, panther, bid,
      trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
      won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
    }, cfg), answerers);

    // Tally tricks
    let pT = 0, cT = 0;
    for (const e of st.log) {
      if (e.type !== "TrickWon") continue;
      if (e.payload.seat === `hand:${panther}`) pT++;
      else if (e.payload.seat === "crow")       cT++;
    }

    const tier     = storyOutcome(pT, cT, contract.story);
    const rawPts   = tierPts(tier, contract.story);
    const pts: Record<Player, number> = Object.fromEntries(PLAYERS.map(p => [p, 0]));
    if (rawPts.panther > 0) {
      pts[panther] = doubled ? rawPts.panther * 2 : rawPts.panther;
    } else {
      for (const p of PLAYERS) if (p !== panther) pts[p] = rawPts.hunters;
    }
    for (const p of PLAYERS) {
      scores[p] += pts[p];
      if (p === panther) { asPanther[p]++; ptsAsPanther[p] += pts[p]; }
      else ptsAsHunter[p] += pts[p];
    }

    storyCnt[contract.story]++;
    storyTiers[contract.story][tier]++;
    if (tier !== "fail") storyMake[contract.story]++;
    trumpCnt[contract.story][TRUMP_OPTIONS.find(t => t.trump === contract.trump)!.label]++;
    totalPantherPts += pts[panther];
    totalHunterPts  += (pts[PLAYERS.find(p => p !== panther && PLAYERS.indexOf(p) < PLAYERS.length)!] ?? 0);

    if (doubled) {
      ffCount++;
      ffPantherPts += pts[panther];
      ffHunterPts  += PLAYERS.filter(p => p !== panther).reduce((s, p) => s + pts[p], 0) / 2;
    }

    dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length] as Player;
  }

  // Fix Hunter pts: sum over both hunters and average
  // Recompute cleanly from score minus Panther pts
  const hunterPtsPerDeal = PLAYERS.reduce((sum, p) =>
    sum + (scores[p] - ptsAsPanther[p]), 0) / (2 * N);

  // =========================================================================
  // Output
  // =========================================================================
  const sep = "─".repeat(68);

  // --- 1. Per-player balance (primary) ---
  console.log("=".repeat(68));
  console.log("PER-PLAYER MEAN POINTS/DEAL  (rotation fairness check)");
  console.log(sep);
  console.log("  Player   Mean pts/deal   As Panther   Pts/deal as P   Pts/deal as H");
  console.log(sep);
  const means: number[] = [];
  for (const p of PLAYERS) {
    const mean    = scores[p] / N;
    means.push(mean);
    const nP      = asPanther[p];
    const mP      = nP > 0 ? ptsAsPanther[p] / nP : 0;
    const nH      = N - nP;
    const mH      = nH > 0 ? ptsAsHunter[p] / nH : 0;
    console.log(`  ${p}        ${mean.toFixed(3).padStart(10)}       ${String(nP).padStart(5)}           ${mP.toFixed(3).padStart(8)}       ${mH.toFixed(3).padStart(8)}`);
  }
  const spread = Math.max(...means) - Math.min(...means);
  // Rough SE: assume σ ≈ 1.5 pts (ballpark from previous runs)
  const se = 1.5 / Math.sqrt(N);
  console.log(sep);
  console.log(`  Max spread: ${spread.toFixed(3)}  (~${(spread/se).toFixed(1)} SE  — ` +
    `${spread / se > 3 ? "SIGNIFICANT" : spread / se > 2 ? "borderline" : "within noise"})`);

  // --- 2. Contract selection + make-rates ---
  console.log("\nCONTRACT SELECTION (deals played)");
  console.log(sep);
  console.log("  Contract         Chosen   Make%    Large    Med    Small    Fail    MeanPnth");
  console.log(sep);
  for (const s of ALL_STORIES) {
    const n  = storyCnt[s]; if (!n) continue;
    const t  = storyTiers[s];
    const ep = s === "PantherDefends"
      ? t.medium / n * V.nil
      : (t.large * V.large + t.medium * V.med + t.small * V.small) / n;
    const tierStr = s === "PantherDefends"
      ? `  ${(100*t.medium/n).toFixed(1)}%  ${" ".repeat(21)}`
      : `${(100*t.large/n).toFixed(1).padStart(7)}% ${(100*t.medium/n).toFixed(1).padStart(7)}% ${(100*t.small/n).toFixed(1).padStart(7)}%`;
    console.log(
      `  ${STORY_LABELS[s].padEnd(16)} ${(100*n/N).toFixed(1).padStart(5)}%  ` +
      `${(100*storyMake[s]/n).toFixed(1).padStart(5)}%  ` +
      tierStr +
      `  ${(100*t.fail/n).toFixed(1).padStart(7)}%   ${ep.toFixed(2).padStart(5)}`
    );
  }

  // --- 3. Trump split per contract ---
  console.log("\nTRUMP SPLIT PER CONTRACT  (% of deals that contract was chosen)");
  console.log(sep);
  const tHdr = "  Contract         " +
    TRUMP_OPTIONS.map(({ label }) => label.slice(0,4).padStart(8)).join("");
  console.log(tHdr);
  console.log(sep);
  for (const s of ALL_STORIES) {
    const n = storyCnt[s]; if (!n) continue;
    const row = TRUMP_OPTIONS.map(({ label }) =>
      `${(100*(trumpCnt[s][label]??0)/n).toFixed(1)}%`.padStart(8)).join("");
    console.log(`  ${STORY_LABELS[s].padEnd(16)} ${row}`);
  }

  // --- 4. Auction type distribution ---
  console.log("\nAUCTION TYPE DISTRIBUTION");
  console.log(sep);
  for (const [t, n] of Object.entries(auctCount))
    console.log(`  ${t.padEnd(8)} ${n.toString().padStart(5)}  (${(100*n/N).toFixed(1)}%)`);
  if (ffCount > 0) {
    console.log(`\n  Force-fed (3-pass): n=${ffCount}`);
    console.log(`    Mean Panther pts  : ${(ffPantherPts/ffCount).toFixed(3)}`);
    console.log(`    Mean Hunter pts ea: ${(ffHunterPts/ffCount).toFixed(3)}`);
  }

  // --- 5. Table-level point flow ---
  console.log("\nTABLE-LEVEL POINT FLOW (per deal)");
  console.log(sep);
  const meanPnth = totalPantherPts / N;
  console.log(`  Mean Panther pts / deal:        ${meanPnth.toFixed(3)}`);
  console.log(`  Mean Hunter pts  / deal (each): ${hunterPtsPerDeal.toFixed(3)}`);
  console.log(`  Total pts created / deal:       ${(meanPnth + 2*hunterPtsPerDeal).toFixed(3)}`);
  console.log(`  Gap (Pnth - Hntr):              ${(meanPnth - hunterPtsPerDeal).toFixed(3)}  ` +
    `(${meanPnth > hunterPtsPerDeal ? "Panther-favoured" : "Hunter-favoured"})`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
