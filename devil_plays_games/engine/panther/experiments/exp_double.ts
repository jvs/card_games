/**
 * exp_double.ts — contested auction doubling duel.
 *
 * When exactly two players bid (1-pass case), each bidder may double the
 * fail-penalty on their own bid (fail now pays Hunters 2× instead of 1×;
 * success rewards unchanged at 3/4/5 / nil=4).
 *
 * Resolution:
 *   one doubles:  that player wins the seat, at doubled penalty.
 *   neither:      existing passer-selects rule (passer picks higher-fail bidder).
 *   both double:  passer picks the bidder with LOWER Panther-EV (more likely
 *                 to fail → 2× Hunter payout).
 *
 * Doubling decision: best-response iteration on the 4 pre-computed EVs
 *   pantherEV1, pantherEV2 (each bidder's Panther EV on their best contract)
 *   hunterEV12, hunterEV21 (each bidder's Hunter EV on the other's contract)
 * The equilibrium is analytic (no MC needed once EVs are estimated).
 *
 * All other auction mechanics unchanged (endogenous pass via iterated Hunter EV,
 * locked vector BA/BD 3/4/5; PD nil 4; base Hunter fail 1).
 *
 * Env vars:  N=3000  ITER=20  SEL_ITER=20
 * Run:  tsx exp_double.ts
 *       N=100 ITER=5 SEL_ITER=5 tsx exp_double.ts   # smoke test
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid,
  firstLeadSeat, buildSeats, deck, newState, clockwise,
  StoryKind, StoryOutcome, ALL_STORIES, STORY_LABELS,
  storyOutcome, rolloutSync, deck as pantherDeck,
} from "../panther.js";
import { reconstructBelief, Belief } from "../mc_panther.js";
import { State, Card } from "../../cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];
function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

// ---------------------------------------------------------------------------
// Scoring vector
// ---------------------------------------------------------------------------
const V = { small: 3, med: 4, large: 5, nil: 4, fail: 1 } as const;

function tierPts(tier: StoryOutcome, story: StoryKind): { panther: number; hunters: number } {
  if (story === "PantherDefends")
    return tier === "medium" ? { panther: V.nil, hunters: 0 } : { panther: 0, hunters: V.fail };
  if (tier === "fail") return { panther: 0, hunters: V.fail };
  return { panther: tier === "large" ? V.large : tier === "medium" ? V.med : V.small, hunters: 0 };
}
function signalPanther(pT: number, cT: number, story: StoryKind): number {
  return tierPts(storyOutcome(pT, cT, story), story).panther;
}

// ---------------------------------------------------------------------------
// Trumps
// ---------------------------------------------------------------------------
const TRUMP_OPTIONS: { trump: string | null; label: string }[] = [
  { trump: "Spades",   label: "Sp" }, { trump: "Diamonds", label: "Di" },
  { trump: "Hearts",   label: "He" }, { trump: "Clubs",    label: "Cl" },
  { trump: null,       label: "PO" },
];
interface BidChoice { story: StoryKind; trump: string | null; }
type     PlayerBid  = BidChoice | "pass";

// ---------------------------------------------------------------------------
// Deal + eval helpers (identical to exp_endogenous)
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

function evalBidForPlayer(player: Player, panther: Player, bid: BidChoice,
    st: State, cfg: PantherConfig, rng: Rng, n: number): number {
  const hs = calcHandSize(cfg);
  const seats = buildSeats(PLAYERS, panther);
  const lead  = firstLeadSeat(seats, panther, PLAYERS, cfg);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const hands: Record<string, Card[]> = {};
    for (const [, z] of seats) hands[z] = [...st.z(z).cards];
    const { pantherTricks, crowTricks } = rolloutSync(
      hands, seats, lead, 0, hs, [], null, null, bid.trump, panther, rng);
    const pts = tierPts(storyOutcome(pantherTricks, crowTricks, bid.story), bid.story);
    total += player === panther ? pts.panther : pts.hunters;
  }
  return total / n;
}

function selectBidForPlayer(player: Player, st: State, cfg: PantherConfig,
    rng: Rng, n: number, passEV: number | null): { bid: BidChoice; ev: number } | null {
  let best: BidChoice | null = null, bestEV = passEV ?? -Infinity;
  for (const story of ALL_STORIES)
    for (const { trump } of TRUMP_OPTIONS) {
      const ev = evalBidForPlayer(player, player, { story, trump }, st, cfg, rng, n);
      if (ev > bestEV) { bestEV = ev; best = { story, trump }; }
    }
  return best !== null ? { bid: best, ev: bestEV } : null;
}

function computeHunterEV(player: Player, bids: Record<Player, PlayerBid>,
    st: State, cfg: PantherConfig, dealer: Player, rng: Rng, n: number): number {
  const tentative: Record<Player, PlayerBid> = { ...bids, [player]: "pass" };
  const bidders = PLAYERS.filter(p => tentative[p] !== "pass");
  const lod     = clockwise(PLAYERS, dealer)[1];
  if (bidders.length === 0) {
    const forced = selectBidForPlayer(lod, st, cfg, new Rng(rng.int(2**30)), n, null)!;
    return evalBidForPlayer(player, lod, forced.bid, st, cfg, rng, n);
  }
  if (bidders.length === 1)
    return evalBidForPlayer(player, bidders[0], tentative[bidders[0]] as BidChoice, st, cfg, rng, n);
  const [b1, b2] = bidders;
  const ev1 = evalBidForPlayer(player, b1, tentative[b1] as BidChoice, st, cfg, rng, n);
  const ev2 = evalBidForPlayer(player, b2, tentative[b2] as BidChoice, st, cfg, rng, n);
  return Math.max(ev1, ev2);
}

// ---------------------------------------------------------------------------
// Doubling duel (contested, 1-pass case only)
//
// Given the 4 pre-estimated EVs, compute best-response equilibrium.
// Pure arithmetic — no additional MC needed.
//
// ev1(d1, d2): bidder1's expected pts for the given double decision pair.
//   d1=T, d2=F → B1 wins at fail×2
//   d1=F, d2=T → B2 wins at fail×2; B1 Hunter@2x
//   d1=T, d2=T → passer picks lower-EV bidder; loser Hunter@2x
//   d1=F, d2=F → passer picks lower-EV bidder; loser Hunter@1x
// In both "passer picks" cases, the picker goes to the lower-pantherEV bidder.
// ---------------------------------------------------------------------------
interface DoubleEquil {
  d1: boolean; d2: boolean;
  converged: boolean; rounds: number;
}

function computeDoubles(
  pantherEV1: number, pantherEV2: number,
  hunterEV12: number, hunterEV21: number,
): DoubleEquil {
  const pickedB1 = pantherEV1 <= pantherEV2;   // passer prefers bidder1 as Panther (more likely to fail)

  const ev1 = (d1: boolean, d2: boolean): number => {
    if ( d1 && !d2) return pantherEV1;                               // wins uncontested
    if (!d1 &&  d2) return 2 * hunterEV12;                          // loses; Hunter@2x
    const mult = (d1 && d2) ? 2 : 1;
    return pickedB1 ? pantherEV1 : mult * hunterEV12;                // passer picks
  };
  const ev2 = (d1: boolean, d2: boolean): number => {
    if ( d1 && !d2) return 2 * hunterEV21;                          // loses; Hunter@2x
    if (!d1 &&  d2) return pantherEV2;                               // wins uncontested
    const mult = (d1 && d2) ? 2 : 1;
    return !pickedB1 ? pantherEV2 : mult * hunterEV21;               // passer picks
  };

  let d1 = false, d2 = false;
  for (let round = 0; round < 6; round++) {
    const nd1 = ev1(true, d2) > ev1(false, d2);
    const nd2 = ev2(d1, true) > ev2(d1, false);
    if (nd1 === d1 && nd2 === d2) return { d1, d2, converged: true, rounds: round + 1 };
    d1 = nd1; d2 = nd2;
  }
  return { d1, d2, converged: false, rounds: 6 };
}

// ---------------------------------------------------------------------------
// Auction resolution (0/2/3-pass unchanged; 1-pass uses doubling duel)
// ---------------------------------------------------------------------------
interface AuctionResult {
  panther:     Player;
  contract:    BidChoice;
  doubled:     boolean;   // force-feed: Panther earns 2× on make
  failMult:    number;    // 1 or 2: Hunters earn failMult × V.fail on Panther fail
  auctionType: string;
  contested?:  {          // only present for 1-pass deals
    bidder1: Player; bidder2: Player; passer: Player;
    pantherEV1: number; pantherEV2: number;
    d1: boolean; d2: boolean;
    doubleCase: "neither" | "one" | "both";
    strongerWon: boolean;
    winnerEV: number; loserEV: number;
  };
}

function resolveAuction(
  bids: Record<Player, PlayerBid>,
  dealer: Player, st: State, cfg: PantherConfig, rng: Rng,
  pantherEVs: Record<Player, number>, bestBids: Record<Player, BidChoice>,
  n: number,
): AuctionResult {
  const lod     = clockwise(PLAYERS, dealer)[1];
  const passers = PLAYERS.filter(p => bids[p] === "pass");
  const bidders = PLAYERS.filter(p => bids[p] !== "pass");

  if (passers.length === 3) {
    const forced = selectBidForPlayer(lod, st, cfg, new Rng(rng.int(2**30)), n, null)!;
    return { panther: lod, contract: forced.bid, doubled: true, failMult: 1, auctionType: "3pass" };
  }
  if (passers.length === 2)
    return { panther: bidders[0], contract: bids[bidders[0]] as BidChoice,
             doubled: false, failMult: 1, auctionType: "2pass" };

  if (passers.length === 1) {
    // ---- Contested: doubling duel ----
    const passer = passers[0];
    const [b1, b2] = bidders;
    const bid1 = bids[b1] as BidChoice, bid2 = bids[b2] as BidChoice;
    const pev1 = pantherEVs[b1], pev2 = pantherEVs[b2];

    // Compute cross Hunter EVs.
    const hev12 = evalBidForPlayer(b1, b2, bid2, st, cfg, new Rng(rng.int(2**30)), n);
    const hev21 = evalBidForPlayer(b2, b1, bid1, st, cfg, new Rng(rng.int(2**30)), n);

    const { d1, d2 } = computeDoubles(pev1, pev2, hev12, hev21);

    let panther: Player, contract: BidChoice, failMult: number;
    let doubleCase: "neither" | "one" | "both";

    if (d1 && !d2) {
      panther = b1; contract = bid1; failMult = 2; doubleCase = "one";
    } else if (!d1 && d2) {
      panther = b2; contract = bid2; failMult = 2; doubleCase = "one";
    } else {
      // Passer picks lower-EV (higher P(fail)).
      const pickB1 = pev1 <= pev2;
      panther = pickB1 ? b1 : b2;
      contract = pickB1 ? bid1 : bid2;
      failMult = (d1 && d2) ? 2 : 1;
      doubleCase = (d1 && d2) ? "both" : "neither";
    }

    const stronger = pev1 >= pev2 ? b1 : b2;
    const winnerEV = panther === b1 ? pev1 : pev2;
    const loserEV  = panther === b1 ? pev2 : pev1;

    return {
      panther, contract, doubled: false, failMult, auctionType: "1pass",
      contested: {
        bidder1: b1, bidder2: b2, passer,
        pantherEV1: pev1, pantherEV2: pev2,
        d1, d2, doubleCase,
        strongerWon: panther === stronger,
        winnerEV, loserEV,
      },
    };
  }

  // 0 passes: lod selects (Panther EV >> Hunter EV → lod picks own bid)
  let best = -Infinity, winner = lod, contract = bids[lod] as BidChoice;
  for (const p of PLAYERS) {
    const ev = evalBidForPlayer(lod, p, bids[p] as BidChoice, st, cfg, rng, n);
    if (ev > best) { best = ev; winner = p; contract = bids[p] as BidChoice; }
  }
  return { panther: winner, contract, doubled: false, failMult: 1, auctionType: "0pass" };
}

// ---------------------------------------------------------------------------
// MC answerer (correct signal: always Panther's pts)
// ---------------------------------------------------------------------------
class MCAnswerer implements Answerer {
  private readonly deck: Card[];
  constructor(
    private player:  Player, private st: State, private cfg: PantherConfig,
    private rng: Rng, private story: StoryKind, private iters: number,
  ) { this.deck = pantherDeck(cfg); }

  answer(req: Choice): Card | string | number {
    if (req.options.length <= 1) return req.options[0];
    if (req.key !== "play") return this.rng.choice(req.options);
    const panther = this.st.vars.panther as Player;
    const trump   = this.st.vars.trump   as string | null;
    const seats   = this.st.vars.seats   as [Player, string][];
    const belief  = reconstructBelief(this.st.viewFor(this.player), this.player, PLAYERS, this.cfg);
    if (!belief.panther) return this.rng.choice(req.options);
    const fromZone = (req.meta?.seat as string) ?? `hand:${this.player}`;
    const options  = req.options as Card[];
    const scores   = options.map(c => this.evalCard(c, fromZone, belief, trump, seats, panther));
    const wantMax  = this.player === panther;
    const best     = wantMax ? Math.max(...scores) : Math.min(...scores);
    return options[scores.indexOf(best)];
  }

  private evalCard(card: Card, fromZone: string, belief: Belief,
      trump: string | null, seats: [Player, string][], panther: Player): number {
    const hs = calcHandSize(this.cfg);
    const authorSi = seats.findIndex(([, z]) => z === fromZone);
    const extPlays: [number, Card][] = [...belief.partialPlays, [authorSi, card]];
    const extLed = belief.partialLed ?? (card.get("suit") as string);
    const cid = cardId(card);
    const pool = this.unknownPool(belief);
    const opSlots = PLAYERS.filter(p => p !== this.player)
      .map(p => ({ zname: `hand:${p}` as string,
                   size: Math.max(0, belief.opponentHandSizes[p] ?? 0) }));
    let total = 0;
    for (let i = 0; i < this.iters; i++) {
      const p = [...pool]; this.rng.shuffle(p);
      const hands: Record<string, Card[]> = {};
      let off = 0;
      for (const { zname, size } of opSlots) { hands[zname] = p.slice(off, off + size); off += size; }
      hands[`hand:${this.player}`] = [...belief.myHand];
      hands["crow"]                = [...belief.crow];
      const h = hands[fromZone]; const idx = h.findIndex(c => cardId(c) === cid); if (idx >= 0) h.splice(idx, 1);
      const { pantherTricks, crowTricks } = rolloutSync(
        hands, seats, belief.lead, belief.trickNumber, hs,
        extPlays, extLed, belief.forcedFromPartials, trump, panther, this.rng);
      total += signalPanther((belief.won[panther]??0)+pantherTricks, belief.crowWon+crowTricks, this.story);
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
// Equilibrium bidding (same iteration as exp_endogenous)
// ---------------------------------------------------------------------------
function computeEquilibrium(st: State, cfg: PantherConfig, dealer: Player,
    seed: number, n: number): {
  bids: Record<Player, PlayerBid>;
  bestBids: Record<Player, BidChoice>;
  pantherEVs: Record<Player, number>;
} {
  const bestBids:   Record<Player, BidChoice> = {} as any;
  const pantherEVs: Record<Player, number>    = {} as any;
  for (let i = 0; i < PLAYERS.length; i++) {
    const p   = PLAYERS[i];
    const res = selectBidForPlayer(p, st, cfg, new Rng(seed * 1009 + i * 997 + 1), n, null)!;
    bestBids[p] = res.bid; pantherEVs[p] = res.ev;
  }
  let bids: Record<Player, PlayerBid> = Object.fromEntries(PLAYERS.map(p => [p, bestBids[p]]));
  const seen: string[] = [];
  for (let round = 0; round <= 8; round++) {
    const key = PLAYERS.map(p => bids[p] === "pass" ? "P" : "B").join("");
    if (seen.includes(key)) break;
    seen.push(key);
    const next: Record<Player, PlayerBid> = {} as any;
    for (let i = 0; i < PLAYERS.length; i++) {
      const p = PLAYERS[i];
      const hEV = computeHunterEV(p, bids, st, cfg, dealer,
                                  new Rng(seed * 7919 + round * 31 + i * 13), n);
      next[p] = pantherEVs[p] > hEV ? bestBids[p] : "pass";
    }
    if (!PLAYERS.some(p => (next[p] === "pass") !== (bids[p] === "pass"))) { bids = next; break; }
    bids = next;
  }
  return { bids, bestBids, pantherEVs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N        = parseInt(process.env.N        ?? "3000");
  const ITER     = parseInt(process.env.ITER     ?? "20");
  const SEL_ITER = parseInt(process.env.SEL_ITER ?? "20");
  const cfg: PantherConfig = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);

  console.log(`exp_double — N=${N}, ITER=${ITER}, SEL_ITER=${SEL_ITER}`);
  console.log(`Vector: BA/BD 3/4/5; PD nil=4; base Hunter fail=1; doubling doubles fail.\n`);

  // ---- Accumulators ----
  const scores:    Record<Player, number> = { A: 0, B: 0, C: 0 };
  const asPanther: Record<Player, number> = { A: 0, B: 0, C: 0 };
  const auctDist:  Record<string, number> = { "0pass":0, "1pass":0, "2pass":0, "3pass":0 };
  const storyCnt:  Record<StoryKind, number> = {} as any;
  const storymake: Record<StoryKind, number> = {} as any;
  const storyTier: Record<StoryKind, Record<StoryOutcome, number>> = {} as any;
  for (const s of ALL_STORIES) { storyCnt[s]=0; storymake[s]=0; storyTier[s]={large:0,medium:0,small:0,fail:0}; }
  let totalPnth = 0, totalHntr = 0;

  // Contested-auction stats
  interface ContRecord {
    d1: boolean; d2: boolean; doubleCase: "neither"|"one"|"both";
    strongerWon: boolean; winnerEV: number; loserEV: number;
    pantherFailed: boolean; passerPts: number; passer: Player;
  }
  const contRecords: ContRecord[] = [];

  const prog = Math.max(250, Math.floor(N/12));
  let dealer = "C" as Player;

  for (let d = 0; d < N; d++) {
    if (d > 0 && d % prog === 0)
      process.stdout.write(`  ${d}/${N}  A=${scores.A} B=${scores.B} C=${scores.C}\n`);

    const seed = d + 1;
    const st   = dealCards(cfg, seed);
    const { bids, bestBids, pantherEVs } = computeEquilibrium(st, cfg, dealer, seed, SEL_ITER);
    const ar = resolveAuction(bids, dealer, st, cfg, new Rng(seed*5003+3), pantherEVs, bestBids, SEL_ITER);
    auctDist[ar.auctionType]++;

    const { panther, contract, doubled, failMult } = ar;
    const seats = buildSeats(PLAYERS, panther);
    st.vars.seats = seats; st.vars.panther = panther; st.vars.trump = contract.trump;
    st.emit("HandStart", { dealer });
    const bid: Bid = { tricks: 1, trump: contract.trump, perilsOnly: contract.trump === null };
    st.emit("Bid", { player: panther, ...bid });
    asPanther[panther]++;

    const answerers = new Map<Player|null, Answerer>();
    PLAYERS.forEach((p, i) =>
      answerers.set(p, new MCAnswerer(p, st, cfg, new Rng(seed*1009+i*997+13), contract.story, ITER)));
    answerers.set(null, { answer: (r: Choice) => new Rng(seed*911+7).choice(r.options) });

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
    const tier = storyOutcome(pT, cT, contract.story);
    const raw  = tierPts(tier, contract.story);
    const pts: Record<Player, number> = Object.fromEntries(PLAYERS.map(p => [p, 0]));
    if (raw.panther > 0) {
      pts[panther] = doubled ? raw.panther * 2 : raw.panther;
    } else {
      for (const p of PLAYERS) if (p !== panther) pts[p] = raw.hunters * failMult;
    }
    for (const p of PLAYERS) scores[p] += pts[p];
    storyCnt[contract.story]++; storyTier[contract.story][tier]++;
    if (tier !== "fail") storymake[contract.story]++;
    totalPnth += pts[panther];
    totalHntr += PLAYERS.filter(p => p !== panther).reduce((s, p) => s + pts[p], 0) / 2;

    // Record contested stats
    if (ar.contested) {
      const c = ar.contested;
      const pantherFailed = tier === "fail";
      const passerPts = pts[c.passer];
      contRecords.push({ ...c, pantherFailed, passerPts });
    }

    dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length] as Player;
  }

  // =========================================================================
  // Output
  // =========================================================================
  const sep = "-".repeat(68);

  // 1. Auction distribution
  console.log("=".repeat(68));
  console.log("AUCTION-TYPE DISTRIBUTION");
  console.log(sep);
  for (const [t, n] of Object.entries(auctDist))
    console.log(`  ${t.padEnd(8)} ${n.toString().padStart(5)}  (${(100*n/N).toFixed(1)}%)`);
  console.log(`  Contested (1-pass): ${auctDist["1pass"]} deals (${(100*auctDist["1pass"]/N).toFixed(1)}%)`);

  // 2. Doubling duel stats
  const nC = contRecords.length;
  if (nC > 0) {
    const nBoth    = contRecords.filter(r => r.doubleCase === "both").length;
    const nOne     = contRecords.filter(r => r.doubleCase === "one").length;
    const nNeither = contRecords.filter(r => r.doubleCase === "neither").length;
    const nDoubled = (nOne * 1 + nBoth * 2);  // total individual double decisions = true
    const nSW      = contRecords.filter(r => r.strongerWon).length;
    const sumWEV   = contRecords.reduce((s, r) => s + r.winnerEV, 0);
    const sumLEV   = contRecords.reduce((s, r) => s + r.loserEV, 0);

    console.log("\nCONTESTED AUCTION — DOUBLING DUEL  (" + nC + " deals)");
    console.log(sep);
    console.log(`  Double decisions:  ${nDoubled} of ${2*nC} (${(100*nDoubled/(2*nC)).toFixed(1)}% per bidder-slot)`);
    console.log(`  Both doubled:      ${nBoth}  (${(100*nBoth/nC).toFixed(1)}%)`);
    console.log(`  One doubled:       ${nOne}   (${(100*nOne/nC).toFixed(1)}%)`);
    console.log(`  Neither doubled:   ${nNeither} (${(100*nNeither/nC).toFixed(1)}%)`);
    console.log();
    console.log(`  Stronger hand wins the seat: ${nSW}/${nC} = ${(100*nSW/nC).toFixed(1)}%`);
    console.log(`  Mean Panther EV of winner:   ${(sumWEV/nC).toFixed(3)}`);
    console.log(`  Mean Panther EV of loser:    ${(sumLEV/nC).toFixed(3)}`);
    // Break down by doubling case
    for (const dc of ["neither", "one", "both"] as const) {
      const sub = contRecords.filter(r => r.doubleCase === dc);
      if (sub.length === 0) continue;
      const sw = sub.filter(r => r.strongerWon).length;
      const wev = sub.reduce((s,r) => s+r.winnerEV, 0) / sub.length;
      const lev = sub.reduce((s,r) => s+r.loserEV, 0) / sub.length;
      console.log(`    [${dc.padEnd(7)}] n=${String(sub.length).padEnd(4)} ` +
        `stronger-wins=${(100*sw/sub.length).toFixed(1).padStart(5)}%  ` +
        `mean winner EV=${wev.toFixed(3)}  loser EV=${lev.toFixed(3)}`);
    }

    // 3. Both-doubled → third player picks
    const bothRecs = contRecords.filter(r => r.doubleCase === "both");
    if (bothRecs.length > 0) {
      const nFail = bothRecs.filter(r => r.pantherFailed).length;
      const sumPPts = bothRecs.reduce((s, r) => s + r.passerPts, 0);
      const sumAllPPts = contRecords.reduce((s, r) => s + r.passerPts, 0);
      console.log("\nBOTH-DOUBLED → THIRD-PLAYER PICKS  (" + bothRecs.length + " deals)");
      console.log(sep);
      console.log(`  Panther (third player's pick) then failed:  ${nFail}/${bothRecs.length} = ${(100*nFail/bothRecs.length).toFixed(1)}%`);
      console.log(`  Mean passer gain (both-doubled deals):      ${(sumPPts/bothRecs.length).toFixed(3)} pts/deal`);
      console.log(`  Mean passer gain (all contested deals):     ${(sumAllPPts/nC).toFixed(3)} pts/deal`);
      console.log(`  Expected passer gain if fail @ 2× penalty:  ${(nFail*2/bothRecs.length).toFixed(3)}`);
      const nonBothPPts = contRecords.filter(r => r.doubleCase !== "both").reduce((s,r) => s+r.passerPts, 0);
      const nNB = nC - bothRecs.length;
      if (nNB > 0) console.log(`  Mean passer gain (non-both-doubled):        ${(nonBothPPts/nNB).toFixed(3)} pts/deal`);
    }
  } else {
    console.log("\n  No contested auctions observed (all 0-pass or 2-pass).");
  }

  // 4. Per-player fairness
  const means = PLAYERS.map(p => scores[p] / N);
  const spread = Math.max(...means) - Math.min(...means);
  const se = 1.5 / Math.sqrt(N);
  console.log("\nPER-PLAYER MEAN POINTS/DEAL");
  console.log(sep);
  PLAYERS.forEach((p, i) => console.log(`  ${p}: ${means[i].toFixed(3)}  (as Panther: ${asPanther[p]})`));
  console.log(`  Max spread: ${spread.toFixed(3)}  (~${(spread/se).toFixed(1)} SE  — ${spread/se>3?"SIGNIFICANT":"within noise"})`);

  // 5. Contract mix
  console.log("\nCONTRACT MAKE-RATES");
  console.log(sep);
  for (const s of ALL_STORIES) {
    const n = storyCnt[s]; if (!n) continue;
    const eP = s === "PantherDefends"
      ? storyTier[s].medium * V.nil / n
      : (storyTier[s].large*V.large + storyTier[s].medium*V.med + storyTier[s].small*V.small) / n;
    console.log(`  ${STORY_LABELS[s].padEnd(16)} ${n.toString().padStart(5)}  ` +
      `make=${(100*storymake[s]/n).toFixed(1).padStart(5)}%  E[Pnth]=${eP.toFixed(2)}`);
  }

  // 6. Point flow
  console.log("\nTABLE-LEVEL POINT FLOW");
  console.log(sep);
  console.log(`  Mean Panther pts / deal:        ${(totalPnth/N).toFixed(3)}`);
  console.log(`  Mean Hunter pts  / deal (each): ${(totalHntr/N).toFixed(3)}`);
  console.log(`  Gap (Pnth - Hntr):              ${(totalPnth/N - totalHntr/N).toFixed(3)}`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
