/**
 * exp_p_sweep.ts — sweep base Hunter fail-reward P ∈ {1, 2, 3, 4}.
 *
 * Everything else held fixed:
 *   Locked vector BA/BD 3/4/5, PD nil=4.
 *   Doubling mechanic: contested 1-pass → each bidder may double;
 *     one doubles → wins at 2P; both double → passer picks (lower EV);
 *     neither → passer picks (1P).
 *   Endogenous pass: pass value = per-deal Hunter EV, iterated to fixed point.
 *   Realistic MC (correct signal: always Panther pts, minimised by Hunters).
 *   Dealer rotates; same deal seeds used for all P values.
 *
 * Env vars:  N=1000  ITER=20  SEL_ITER=20
 * Run:  tsx exp_p_sweep.ts
 *       N=120 ITER=5 SEL_ITER=5 tsx exp_p_sweep.ts   # smoke test
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

// Fixed reward tiers (Panther side).
const BASE = { small: 3, med: 4, large: 5, nil: 4 } as const;

// ---------------------------------------------------------------------------
// Scoring — P-parameterised.  failReward is the base Hunter reward; doubling
// makes it 2×failReward.  Panther rewards never depend on failReward.
// ---------------------------------------------------------------------------
function tierPts(
  tier: StoryOutcome, story: StoryKind, failReward: number,
): { panther: number; hunters: number } {
  if (story === "PantherDefends")
    return tier === "medium" ? { panther: BASE.nil, hunters: 0 }
                              : { panther: 0, hunters: failReward };
  if (tier === "fail") return { panther: 0, hunters: failReward };
  return {
    panther: tier === "large" ? BASE.large : tier === "medium" ? BASE.med : BASE.small,
    hunters: 0,
  };
}

// MC signal: Panther's pts only; Hunters minimise → they defend correctly.
// Never depends on failReward — same signal at every P.
function signalPanther(pT: number, cT: number, story: StoryKind): number {
  // (reuse tierPts with dummy failReward=0 since we only need panther side)
  return tierPts(storyOutcome(pT, cT, story), story, 0).panther;
}

// ---------------------------------------------------------------------------
// Trumps / bid types
// ---------------------------------------------------------------------------
const TRUMP_OPTIONS: { trump: string | null; label: string }[] = [
  { trump: "Spades",   label: "Sp" }, { trump: "Diamonds", label: "Di" },
  { trump: "Hearts",   label: "He" }, { trump: "Clubs",    label: "Cl" },
  { trump: null,       label: "PO" },
];
interface BidChoice { story: StoryKind; trump: string | null; }
type     PlayerBid  = BidChoice | "pass";

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
// evalBidForPlayer — omniscient random rollouts; failReward-aware.
// ---------------------------------------------------------------------------
function evalBidForPlayer(
  player: Player, panther: Player, bid: BidChoice,
  st: State, cfg: PantherConfig, rng: Rng, n: number, failReward: number,
): number {
  const hs    = calcHandSize(cfg);
  const seats = buildSeats(PLAYERS, panther);
  const lead  = firstLeadSeat(seats, panther, PLAYERS, cfg);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const hands: Record<string, Card[]> = {};
    for (const [, z] of seats) hands[z] = [...st.z(z).cards];
    const { pantherTricks, crowTricks } = rolloutSync(
      hands, seats, lead, 0, hs, [], null, null, bid.trump, panther, rng);
    const pts = tierPts(storyOutcome(pantherTricks, crowTricks, bid.story), bid.story, failReward);
    total += player === panther ? pts.panther : pts.hunters;
  }
  return total / n;
}

function selectBidForPlayer(
  player: Player, st: State, cfg: PantherConfig,
  rng: Rng, n: number, passEV: number | null, failReward: number,
): { bid: BidChoice; ev: number } | null {
  let best: BidChoice | null = null, bestEV = passEV ?? -Infinity;
  for (const story of ALL_STORIES)
    for (const { trump } of TRUMP_OPTIONS) {
      const ev = evalBidForPlayer(player, player, { story, trump }, st, cfg, rng, n, failReward);
      if (ev > bestEV) { bestEV = ev; best = { story, trump }; }
    }
  return best !== null ? { bid: best, ev: bestEV } : null;
}

function computeHunterEV(
  player: Player, bids: Record<Player, PlayerBid>,
  st: State, cfg: PantherConfig, dealer: Player,
  rng: Rng, n: number, failReward: number,
): number {
  const tentative: Record<Player, PlayerBid> = { ...bids, [player]: "pass" };
  const bidders = PLAYERS.filter(p => tentative[p] !== "pass");
  const lod     = clockwise(PLAYERS, dealer)[1];
  if (bidders.length === 0) {
    const forced = selectBidForPlayer(lod, st, cfg, new Rng(rng.int(2**30)), n, null, failReward)!;
    return evalBidForPlayer(player, lod, forced.bid, st, cfg, rng, n, failReward);
  }
  if (bidders.length === 1)
    return evalBidForPlayer(player, bidders[0], tentative[bidders[0]] as BidChoice,
                            st, cfg, rng, n, failReward);
  const [b1, b2] = bidders;
  const ev1 = evalBidForPlayer(player, b1, tentative[b1] as BidChoice, st, cfg, rng, n, failReward);
  const ev2 = evalBidForPlayer(player, b2, tentative[b2] as BidChoice, st, cfg, rng, n, failReward);
  return Math.max(ev1, ev2);
}

// ---------------------------------------------------------------------------
// Doubling duel (pure arithmetic on pre-estimated EVs).
// hunterEV12/21 already contain failReward scaling from evalBidForPlayer.
// ---------------------------------------------------------------------------
function computeDoubles(
  pev1: number, pev2: number, hev12: number, hev21: number,
): { d1: boolean; d2: boolean } {
  const pickedB1 = pev1 <= pev2;
  const ev1 = (d1: boolean, d2: boolean) => {
    if ( d1 && !d2) return pev1;
    if (!d1 &&  d2) return 2 * hev12;
    return pickedB1 ? pev1 : (d1 && d2 ? 2 : 1) * hev12;
  };
  const ev2 = (d1: boolean, d2: boolean) => {
    if ( d1 && !d2) return 2 * hev21;
    if (!d1 &&  d2) return pev2;
    return !pickedB1 ? pev2 : (d1 && d2 ? 2 : 1) * hev21;
  };
  let d1 = false, d2 = false;
  for (let r = 0; r < 6; r++) {
    const nd1 = ev1(true, d2) > ev1(false, d2);
    const nd2 = ev2(d1, true) > ev2(d1, false);
    if (nd1 === d1 && nd2 === d2) break;
    d1 = nd1; d2 = nd2;
  }
  return { d1, d2 };
}

// ---------------------------------------------------------------------------
// Equilibrium bidding
// ---------------------------------------------------------------------------
function computeEquilibrium(
  st: State, cfg: PantherConfig, dealer: Player,
  seed: number, n: number, failReward: number,
) {
  const bestBids:   Record<Player, BidChoice> = {} as any;
  const pantherEVs: Record<Player, number>    = {} as any;
  for (let i = 0; i < PLAYERS.length; i++) {
    const p   = PLAYERS[i];
    const res = selectBidForPlayer(p, st, cfg,
      new Rng(seed * 1009 + i * 997 + 1), n, null, failReward)!;
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
      const p   = PLAYERS[i];
      const hEV = computeHunterEV(p, bids, st, cfg, dealer,
        new Rng(seed * 7919 + round * 31 + i * 13), n, failReward);
      next[p] = pantherEVs[p] > hEV ? bestBids[p] : "pass";
    }
    if (!PLAYERS.some(p => (next[p] === "pass") !== (bids[p] === "pass"))) { bids = next; break; }
    bids = next;
  }
  return { bids, bestBids, pantherEVs };
}

// ---------------------------------------------------------------------------
// Auction resolution
// ---------------------------------------------------------------------------
function resolveAuction(
  bids: Record<Player, PlayerBid>, dealer: Player,
  st: State, cfg: PantherConfig, rng: Rng,
  pantherEVs: Record<Player, number>, n: number, failReward: number,
): {
  panther: Player; contract: BidChoice; doubled: boolean; failMult: number;
  auctionType: string;
  contested?: {
    doubleCase: "neither"|"one"|"both"; strongerWon: boolean;
    winnerEV: number; loserEV: number;
  };
} {
  const lod     = clockwise(PLAYERS, dealer)[1];
  const passers = PLAYERS.filter(p => bids[p] === "pass");
  const bidders = PLAYERS.filter(p => bids[p] !== "pass");

  if (passers.length === 3) {
    const forced = selectBidForPlayer(lod, st, cfg, new Rng(rng.int(2**30)), n, null, failReward)!;
    return { panther: lod, contract: forced.bid, doubled: true, failMult: 1, auctionType: "3pass" };
  }
  if (passers.length === 2)
    return { panther: bidders[0], contract: bids[bidders[0]] as BidChoice,
             doubled: false, failMult: 1, auctionType: "2pass" };

  if (passers.length === 1) {
    const [b1, b2] = bidders;
    const bid1 = bids[b1] as BidChoice, bid2 = bids[b2] as BidChoice;
    const pev1 = pantherEVs[b1], pev2 = pantherEVs[b2];
    const hev12 = evalBidForPlayer(b1, b2, bid2, st, cfg, new Rng(rng.int(2**30)), n, failReward);
    const hev21 = evalBidForPlayer(b2, b1, bid1, st, cfg, new Rng(rng.int(2**30)), n, failReward);
    const { d1, d2 } = computeDoubles(pev1, pev2, hev12, hev21);

    let panther: Player, contract: BidChoice, failMult: number;
    let doubleCase: "neither"|"one"|"both";
    if (d1 && !d2) { panther = b1; contract = bid1; failMult = 2; doubleCase = "one"; }
    else if (!d1 && d2) { panther = b2; contract = bid2; failMult = 2; doubleCase = "one"; }
    else {
      const pickB1 = pev1 <= pev2;
      panther = pickB1 ? b1 : b2; contract = pickB1 ? bid1 : bid2;
      failMult = (d1 && d2) ? 2 : 1; doubleCase = (d1 && d2) ? "both" : "neither";
    }
    const stronger = pev1 >= pev2 ? b1 : b2;
    return {
      panther, contract, doubled: false, failMult, auctionType: "1pass",
      contested: {
        doubleCase, strongerWon: panther === stronger,
        winnerEV: panther === b1 ? pev1 : pev2,
        loserEV:  panther === b1 ? pev2 : pev1,
      },
    };
  }

  let best = -Infinity, winner = lod, contract = bids[lod] as BidChoice;
  for (const p of PLAYERS) {
    const ev = evalBidForPlayer(lod, p, bids[p] as BidChoice, st, cfg, rng, n, failReward);
    if (ev > best) { best = ev; winner = p; contract = bids[p] as BidChoice; }
  }
  return { panther: winner, contract, doubled: false, failMult: 1, auctionType: "0pass" };
}

// ---------------------------------------------------------------------------
// MC answerer — signal is always Panther pts (independent of failReward)
// ---------------------------------------------------------------------------
class MCAnswerer implements Answerer {
  private readonly deck: Card[];
  constructor(
    private player: Player, private st: State, private cfg: PantherConfig,
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
      for (const { zname, size } of opSlots) { hands[zname] = p.slice(off, off+size); off += size; }
      hands[`hand:${this.player}`] = [...belief.myHand];
      hands["crow"]                = [...belief.crow];
      const h = hands[fromZone]; const idx = h.findIndex(c => cardId(c) === cid); if (idx >= 0) h.splice(idx, 1);
      const { pantherTricks, crowTricks } = rolloutSync(
        hands, seats, belief.lead, belief.trickNumber, hs,
        extPlays, extLed, belief.forcedFromPartials, trump, panther, this.rng);
      total += signalPanther(
        (belief.won[panther]??0)+pantherTricks, belief.crowWon+crowTricks, this.story);
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
// Stats bucket for one P value
// ---------------------------------------------------------------------------
interface PStat {
  p: number; n: number;
  auctDist:   Record<string, number>;
  totalPasses: number;
  allPassDeals: number;
  totalPnth: number; totalHntr: number;
  scores: Record<Player, number>;
  asPanther: Record<Player, number>;
  storyCnt:  Record<StoryKind, number>;
  storymake: Record<StoryKind, number>;
  // contested
  contN: number; contBoth: number; contOne: number; contNeither: number;
  contStronger: number;
  contWinnerEVSum: number; contLoserEVSum: number;
}

function emptyStats(p: number, n: number): PStat {
  const s: PStat = {
    p, n,
    auctDist: { "0pass":0, "1pass":0, "2pass":0, "3pass":0 },
    totalPasses: 0, allPassDeals: 0,
    totalPnth: 0, totalHntr: 0,
    scores: { A:0, B:0, C:0 }, asPanther: { A:0, B:0, C:0 },
    storyCnt:  {} as any, storymake: {} as any,
    contN: 0, contBoth: 0, contOne: 0, contNeither: 0,
    contStronger: 0, contWinnerEVSum: 0, contLoserEVSum: 0,
  };
  for (const st of ALL_STORIES) { s.storyCnt[st] = 0; s.storymake[st] = 0; }
  return s;
}

// ---------------------------------------------------------------------------
// Run N deals for one P value
// ---------------------------------------------------------------------------
async function runP(
  failReward: number, N: number, ITER: number, SEL_ITER: number,
  cfg: PantherConfig,
): Promise<PStat> {
  const hs   = calcHandSize(cfg);
  const stat = emptyStats(failReward, N);
  let dealer = "C" as Player;
  const prog = Math.max(200, Math.floor(N / 5));

  for (let d = 0; d < N; d++) {
    if (d > 0 && d % prog === 0)
      process.stdout.write(`    P=${failReward}  ${d}/${N}\n`);

    const seed = d + 1;
    const st   = dealCards(cfg, seed);
    const { bids, pantherEVs } = computeEquilibrium(st, cfg, dealer, seed, SEL_ITER, failReward);

    // Count passes
    const passCount = PLAYERS.filter(p => bids[p] === "pass").length;
    stat.totalPasses += passCount;
    if (passCount === 3) stat.allPassDeals++;

    const ar = resolveAuction(bids, dealer, st, cfg,
      new Rng(seed*5003+3), pantherEVs, SEL_ITER, failReward);
    stat.auctDist[ar.auctionType]++;

    const { panther, contract, doubled, failMult } = ar;
    const seats = buildSeats(PLAYERS, panther);
    st.vars.seats = seats; st.vars.panther = panther; st.vars.trump = contract.trump;
    st.emit("HandStart", { dealer });
    const bid: Bid = { tricks:1, trump: contract.trump, perilsOnly: contract.trump === null };
    st.emit("Bid", { player: panther, ...bid });
    stat.asPanther[panther]++;

    const answerers = new Map<Player|null, Answerer>();
    PLAYERS.forEach((p, i) =>
      answerers.set(p, new MCAnswerer(p, st, cfg, new Rng(seed*1009+i*997+13), contract.story, ITER)));
    answerers.set(null, { answer: (r: Choice) => new Rng(seed*911+7).choice(r.options) });

    await run(playTricks(st, {
      seats, lead: firstLeadSeat(seats, panther, PLAYERS, cfg),
      handSize: hs, panther, bid,
      trickNum:0, partialPlays:[], partialLed:null, forcedFromPartials:null,
      won: Object.fromEntries(PLAYERS.map(p=>[p,0])), crowWon:0,
    }, cfg), answerers);

    let pT = 0, cT = 0;
    for (const e of st.log) {
      if (e.type !== "TrickWon") continue;
      if (e.payload.seat === `hand:${panther}`) pT++;
      else if (e.payload.seat === "crow") cT++;
    }

    const tier = storyOutcome(pT, cT, contract.story);
    const raw  = tierPts(tier, contract.story, failReward);
    const pts: Record<Player, number> = Object.fromEntries(PLAYERS.map(p => [p, 0]));
    if (raw.panther > 0) {
      pts[panther] = doubled ? raw.panther * 2 : raw.panther;
    } else {
      for (const p of PLAYERS) if (p !== panther) pts[p] = raw.hunters * failMult;
    }
    for (const p of PLAYERS) stat.scores[p] += pts[p];
    stat.storyCnt[contract.story]++;
    if (tier !== "fail") stat.storymake[contract.story]++;
    stat.totalPnth += pts[panther];
    stat.totalHntr += PLAYERS.filter(p => p !== panther).reduce((s, p) => s + pts[p], 0) / 2;

    if (ar.contested) {
      const c = ar.contested;
      stat.contN++;
      if (c.doubleCase === "both")    stat.contBoth++;
      else if (c.doubleCase === "one")   stat.contOne++;
      else                               stat.contNeither++;
      if (c.strongerWon) stat.contStronger++;
      stat.contWinnerEVSum += c.winnerEV;
      stat.contLoserEVSum  += c.loserEV;
    }

    dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length] as Player;
  }
  return stat;
}

// ---------------------------------------------------------------------------
// Main — sweep and print comparison table
// ---------------------------------------------------------------------------
async function main() {
  const N        = parseInt(process.env.N        ?? "1000");
  const ITER     = parseInt(process.env.ITER     ?? "20");
  const SEL_ITER = parseInt(process.env.SEL_ITER ?? "20");
  const P_VALUES = [1, 2, 3, 4];
  const cfg: PantherConfig = DEFAULT_CONFIG;

  console.log(`exp_p_sweep — N=${N}/P, ITER=${ITER}, SEL_ITER=${SEL_ITER}`);
  console.log(`Sweep P∈{${P_VALUES.join(",")}}  |  locked vector BA/BD 3/4/5; PD nil=4`);
  console.log(`Doubling mechanic on; endogenous pass; realistic MC\n`);

  const results: PStat[] = [];
  for (const p of P_VALUES) {
    console.log(`Running P=${p}…`);
    results.push(await runP(p, N, ITER, SEL_ITER, cfg));
    console.log(`  P=${p} done.\n`);
  }

  // -------------------------------------------------------------------------
  // Comparison table
  // -------------------------------------------------------------------------
  const pv = (s: PStat, fn: (s: PStat) => number, dec = 1, pct = true): string => {
    const v = fn(s);
    return pct ? `${(100*v).toFixed(dec)}%` : v.toFixed(dec);
  };
  const col = 9; // column width
  const hdr = (label: string) =>
    label.padEnd(36) + P_VALUES.map(p => `P=${p}`.padStart(col)).join("");

  console.log("=".repeat(36 + col * P_VALUES.length));
  console.log("SWEEP RESULTS (same N deal seeds for each P)");
  console.log("=".repeat(36 + col * P_VALUES.length));

  const row = (label: string, fn: (s: PStat) => string) =>
    label.padEnd(36) + results.map(s => fn(s).padStart(col)).join("");

  // Header
  console.log(row("", s => `P=${s.p}`));
  console.log("-".repeat(36 + col * P_VALUES.length));

  // Auction distribution
  console.log("AUCTION DISTRIBUTION");
  for (const type of ["0pass","1pass","2pass","3pass"] as const) {
    const lbl = `  ${type.padEnd(8)} (${type==="1pass"?"contested":type==="0pass"?"uncontested":type==="2pass"?"auto-win":"force-feed"})`;
    console.log(row(lbl, s => `${(100*s.auctDist[type]/s.n).toFixed(1)}%`));
  }
  console.log();

  // Pass behaviour
  console.log("PASS BEHAVIOUR");
  console.log(row("  Pass rate (per player-deal)", s => `${(100*s.totalPasses/(3*s.n)).toFixed(1)}%`));
  console.log(row("  All-pass equil deals (n)", s => String(s.allPassDeals)));
  console.log();

  // Point flow
  console.log("POINT FLOW (per deal)");
  console.log(row("  E[Panther pts]", s => (s.totalPnth/s.n).toFixed(2)));
  console.log(row("  E[Hunter pts each]", s => (s.totalHntr/s.n).toFixed(2)));
  const crossoverStr = (s: PStat) => {
    const pnth = s.totalPnth / s.n, hntr = s.totalHntr / s.n;
    return pnth > hntr ? "P>H" : "H>P ◄";
  };
  console.log(row("  Direction (P vs H)", s => crossoverStr(s)));
  console.log(row("  Gap (Pnth - Hntr)", s => (s.totalPnth/s.n - s.totalHntr/s.n).toFixed(2)));
  console.log();

  // Per-player
  console.log("PER-PLAYER MEAN PTS/DEAL");
  for (const p of PLAYERS)
    console.log(row(`  ${p}`, s => (s.scores[p as Player]/s.n).toFixed(3)));
  const seStr = (s: PStat) => {
    const ms = PLAYERS.map(p => s.scores[p as Player]/s.n);
    const spread = Math.max(...ms) - Math.min(...ms);
    const se = 1.5 / Math.sqrt(s.n);
    return `${spread.toFixed(2)}(${(spread/se).toFixed(1)}σ)`;
  };
  console.log(row("  spread(σ)", s => seStr(s)));
  console.log();

  // Contract make-rates
  console.log("CONTRACT MAKE-RATES");
  for (const story of ALL_STORIES)
    console.log(row(`  ${STORY_LABELS[story]}`, s =>
      s.storyCnt[story] ? `${(100*s.storymake[story]/s.storyCnt[story]).toFixed(1)}%` : "—"));
  console.log();

  // Contested duel
  console.log("CONTESTED DUEL (1-pass deals)");
  console.log(row("  n contested", s => String(s.contN)));
  console.log(row("  Stronger hand wins", s =>
    s.contN ? `${(100*s.contStronger/s.contN).toFixed(1)}%` : "—"));
  console.log(row("  Mean winner EV", s =>
    s.contN ? (s.contWinnerEVSum/s.contN).toFixed(2) : "—"));
  console.log(row("  Mean loser EV", s =>
    s.contN ? (s.contLoserEVSum/s.contN).toFixed(2) : "—"));
  console.log(row("  Both-double rate", s =>
    s.contN ? `${(100*s.contBoth/s.contN).toFixed(1)}%` : "—"));
  console.log(row("  One-double rate", s =>
    s.contN ? `${(100*s.contOne/s.contN).toFixed(1)}%` : "—"));
  console.log(row("  Neither-double rate", s =>
    s.contN ? `${(100*s.contNeither/s.contN).toFixed(1)}%` : "—"));

  console.log("=".repeat(36 + col * P_VALUES.length));
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
