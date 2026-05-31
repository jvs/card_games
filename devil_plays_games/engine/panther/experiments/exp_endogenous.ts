/**
 * exp_endogenous.ts — endogenous pass value: a player's pass threshold is
 * their own Hunter EV on that deal (what they'd earn if someone else is Panther).
 *
 * Fixed-point iteration per deal:
 *   Round 0: each player computes their best Panther EV; all provisionally bid.
 *   Each round: given the current bid/pass picture, compute each player's
 *     Hunter EV if they were to pass (resolves auction for the remaining bidders),
 *     compare to Panther EV, update bid/pass decision simultaneously (Jacobi).
 *   Stop when stable or a cycle is detected (max 8 distinct states for 3 players).
 *
 * Scoring vector (locked): BA/BD 3/4/5; PD nil 4; Hunter fail 1; force-feed doubles.
 * Realistic MC play, correct Hunter signal (always Panther's pts, minimised).
 * Dealer rotates, large N.
 *
 * Reports:
 *   1. Equilibrium pass rate per player + overall; auction-type distribution.
 *   2. Convergence stats (rounds, oscillation rate).
 *   3. For passing deals: mean declined Panther EV vs Hunter EV threshold.
 *   4. All-pass-equilibrium rate (force-feed earned honestly).
 *   5. Post-play per-player points, contract mix, point flow.
 *
 * Env vars:  N=3000  ITER=20  SEL_ITER=20
 * Run:  tsx exp_endogenous.ts
 *       N=100 ITER=5 SEL_ITER=5 tsx exp_endogenous.ts   # smoke test
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

// MC signal: always Panther's pts. Hunters minimise → they defend correctly.
function signalPanther(pT: number, cT: number, story: StoryKind): number {
  return tierPts(storyOutcome(pT, cT, story), story).panther;
}

// ---------------------------------------------------------------------------
// Trump options
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
// evalBidForPlayer — E[player's pts] if (panther, bid) wins the auction.
// player===panther → Panther EV; player!==panther → Hunter EV.
// ---------------------------------------------------------------------------
function evalBidForPlayer(
  player: Player, panther: Player, bid: BidChoice,
  st: State, cfg: PantherConfig, rng: Rng, n: number,
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
    const pts = tierPts(storyOutcome(pantherTricks, crowTricks, bid.story), bid.story);
    total += player === panther ? pts.panther : pts.hunters;
  }
  return total / n;
}

// ---------------------------------------------------------------------------
// selectBidForPlayer — best (story×trump) for player as Panther.
// passEV=null → no pass option (forced bid).
// ---------------------------------------------------------------------------
function selectBidForPlayer(
  player: Player, st: State, cfg: PantherConfig,
  rng: Rng, n: number, passEV: number | null,
): { bid: BidChoice; ev: number } | null {
  let best: BidChoice | null = null, bestEV = passEV ?? -Infinity;
  for (const story of ALL_STORIES)
    for (const { trump } of TRUMP_OPTIONS) {
      const ev = evalBidForPlayer(player, player, { story, trump }, st, cfg, rng, n);
      if (ev > bestEV) { bestEV = ev; best = { story, trump }; }
    }
  return best !== null ? { bid: best, ev: bestEV } : null;
}

// ---------------------------------------------------------------------------
// computeHunterEV — player's EV if they pass, given current bid/pass picture.
//
// Always sets player to "pass" tentatively, then resolves the auction for the
// remaining bidders.  Three sub-cases (bidders.length = 0/1/2):
//   2 others bid → player is sole passer → player SELECTS the winner (max EV)
//   1 other bids → player + one other pass → sole bidder wins automatically
//   0 others bid → all-pass → left-of-dealer force-fed
// ---------------------------------------------------------------------------
function computeHunterEV(
  player: Player,
  bids: Record<Player, PlayerBid>,     // current state; player's entry is ignored
  st: State, cfg: PantherConfig, dealer: Player,
  rng: Rng, n: number,
): number {
  const tentative: Record<Player, PlayerBid> = { ...bids, [player]: "pass" };
  const bidders = PLAYERS.filter(p => tentative[p] !== "pass");
  const lod     = clockwise(PLAYERS, dealer)[1];

  if (bidders.length === 0) {
    // All pass → force-feed left-of-dealer.
    const forced = selectBidForPlayer(lod, st, cfg, new Rng(rng.int(2 ** 30)), n, null)!;
    return evalBidForPlayer(player, lod, forced.bid, st, cfg, rng, n);
  }

  if (bidders.length === 1) {
    // Two players pass; sole bidder wins automatically.
    const panther = bidders[0];
    return evalBidForPlayer(player, panther, tentative[panther] as BidChoice,
                            st, cfg, rng, n);
  }

  // bidders.length === 2: player is the sole passer; player SELECTS the winner.
  // Player picks whichever bid maximises their Hunter EV.
  const [b1, b2] = bidders;
  const ev1 = evalBidForPlayer(player, b1, tentative[b1] as BidChoice, st, cfg, rng, n);
  const ev2 = evalBidForPlayer(player, b2, tentative[b2] as BidChoice, st, cfg, rng, n);
  return Math.max(ev1, ev2);
}

// ---------------------------------------------------------------------------
// Fixed-point iteration: find the equilibrium bid/pass vector for one deal.
//
// Returns:
//   bids          — converged bid/pass vector
//   bestBids      — each player's best contract (Panther EV maximiser)
//   pantherEVs    — each player's best Panther EV
//   hunterEVs     — each player's Hunter EV at the converged state
//   rounds        — number of Jacobi rounds executed
//   converged     — true if a fixed point was reached
//   allPassEquil  — true if the converged state is all-pass (everyone passes)
// ---------------------------------------------------------------------------
interface EquilResult {
  bids:         Record<Player, PlayerBid>;
  bestBids:     Record<Player, BidChoice>;
  pantherEVs:   Record<Player, number>;
  hunterEVs:    Record<Player, number>;
  rounds:       number;
  converged:    boolean;
  allPassEquil: boolean;
}

function computeEquilibrium(
  st: State, cfg: PantherConfig, dealer: Player, seed: number, selIters: number,
): EquilResult {
  // Step 0: best Panther EV for each player (no pass option).
  const bestBids:   Record<Player, BidChoice> = {} as any;
  const pantherEVs: Record<Player, number>    = {} as any;
  for (let i = 0; i < PLAYERS.length; i++) {
    const p   = PLAYERS[i];
    const res = selectBidForPlayer(p, st, cfg,
                  new Rng(seed * 1009 + i * 997 + 1), selIters, null)!;
    bestBids[p]   = res.bid;
    pantherEVs[p] = res.ev;
  }

  // Initial state: all bid.
  let bids: Record<Player, PlayerBid> = Object.fromEntries(
    PLAYERS.map(p => [p, bestBids[p]]));

  // Jacobi iteration.  Only 2^3 = 8 possible states, so any cycle has period ≤ 8.
  const seen: string[] = [];
  let rounds    = 0;
  let converged = false;

  for (let round = 0; round <= 8; round++) {
    const key = PLAYERS.map(p => bids[p] === "pass" ? "P" : "B").join("");
    if (seen.includes(key)) break;           // cycle detected
    seen.push(key);

    // Compute all new decisions simultaneously (Jacobi).
    const next: Record<Player, PlayerBid> = {} as any;
    for (let i = 0; i < PLAYERS.length; i++) {
      const p      = PLAYERS[i];
      const rng    = new Rng(seed * 7919 + round * 31 + i * 13);
      const hEV    = computeHunterEV(p, bids, st, cfg, dealer, rng, selIters);
      next[p]      = pantherEVs[p] > hEV ? bestBids[p] : "pass";
    }

    rounds = round + 1;
    const changed = PLAYERS.some(p => (next[p] === "pass") !== (bids[p] === "pass"));
    bids = next;
    if (!changed) { converged = true; break; }
  }

  // Final Hunter EVs at converged state.
  const hunterEVs: Record<Player, number> = {} as any;
  for (let i = 0; i < PLAYERS.length; i++) {
    const p   = PLAYERS[i];
    const rng = new Rng(seed * 7919 + rounds * 31 + i * 13);
    hunterEVs[p] = computeHunterEV(p, bids, st, cfg, dealer, rng, selIters);
  }

  return {
    bids, bestBids, pantherEVs, hunterEVs, rounds, converged,
    allPassEquil: PLAYERS.every(p => bids[p] === "pass"),
  };
}

// ---------------------------------------------------------------------------
// resolveAuction — same rules as exp_balance
// ---------------------------------------------------------------------------
function resolveAuction(
  bids: Record<Player, PlayerBid>,
  dealer: Player, st: State, cfg: PantherConfig, rng: Rng, n: number,
): { panther: Player; contract: BidChoice; doubled: boolean; auctionType: string } {
  const lod     = clockwise(PLAYERS, dealer)[1];
  const passers = PLAYERS.filter(p => bids[p] === "pass");
  const bidders = PLAYERS.filter(p => bids[p] !== "pass");

  if (passers.length === 3) {
    const forced = selectBidForPlayer(lod, st, cfg, new Rng(rng.int(2 ** 30)), n, null)!;
    return { panther: lod, contract: forced.bid, doubled: true, auctionType: "3pass" };
  }
  if (passers.length === 2)
    return { panther: bidders[0], contract: bids[bidders[0]] as BidChoice,
             doubled: false, auctionType: "2pass" };
  if (passers.length === 1) {
    const passer = passers[0];
    const [b1, b2] = bidders;
    const ev1 = evalBidForPlayer(passer, b1, bids[b1] as BidChoice, st, cfg, rng, n);
    const ev2 = evalBidForPlayer(passer, b2, bids[b2] as BidChoice, st, cfg, rng, n);
    const [w, c] = ev1 >= ev2 ? [b1, bids[b1] as BidChoice] : [b2, bids[b2] as BidChoice];
    return { panther: w, contract: c, doubled: false, auctionType: "1pass" };
  }
  // 0 passes: lod selects (own bid → Panther EV; others → Hunter EV)
  let best = -Infinity, winner = lod, contract = bids[lod] as BidChoice;
  for (const p of PLAYERS) {
    const ev = evalBidForPlayer(lod, p, bids[p] as BidChoice, st, cfg, rng, n);
    if (ev > best) { best = ev; winner = p; contract = bids[p] as BidChoice; }
  }
  return { panther: winner, contract, doubled: false, auctionType: "0pass" };
}

// ---------------------------------------------------------------------------
// MC answerer — correct signal (always Panther's pts)
// ---------------------------------------------------------------------------
class MCAnswerer implements Answerer {
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
      total += signalPanther(tP, tC, this.story);  // always Panther's pts
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
  const cfg: PantherConfig = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);

  console.log(`exp_endogenous — N=${N}, ITER=${ITER}, SEL_ITER=${SEL_ITER}`);
  console.log(`Vector: BA/BD 3/4/5; PD nil=4; Hunter fail=1; force-feed doubles.`);
  console.log(`Pass value = per-deal Hunter EV (endogenous); iterated to fixed point.\n`);

  // ---- Accumulators ----
  const scores:     Record<Player, number> = { A: 0, B: 0, C: 0 };
  const asPanther:  Record<Player, number> = { A: 0, B: 0, C: 0 };
  const passCount:  Record<Player, number> = { A: 0, B: 0, C: 0 };

  const auctionDist: Record<string, number> = { "0pass": 0, "1pass": 0, "2pass": 0, "3pass": 0 };

  let totalRounds = 0, totalConverged = 0, totalOscillated = 0, maxRounds = 0;
  let allPassEquilCount = 0;

  // Passing stats: for each pass decision, record [pantherEV, hunterEV]
  const passRecords: { pantherEV: number; hunterEV: number }[] = [];

  const storyCnt:   Record<StoryKind, number> = {} as any;
  const storyMake:  Record<StoryKind, number> = {} as any;
  const storyTiers: Record<StoryKind, Record<StoryOutcome, number>> = {} as any;
  for (const s of ALL_STORIES) {
    storyCnt[s] = 0; storyMake[s] = 0;
    storyTiers[s] = { large: 0, medium: 0, small: 0, fail: 0 };
  }

  let totalPantherPts = 0, totalHunterPts = 0;
  let ffPantherPts = 0, ffHunterPts = 0, ffCount = 0;

  const prog = Math.max(250, Math.floor(N / 12));
  let dealer = "C" as Player;

  for (let d = 0; d < N; d++) {
    if (d > 0 && d % prog === 0)
      process.stdout.write(`  ${d}/${N}  A=${scores.A} B=${scores.B} C=${scores.C}\n`);

    const seed = d + 1;
    const st   = dealCards(cfg, seed);

    // Fixed-point auction.
    const equil = computeEquilibrium(st, cfg, dealer, seed, SEL_ITER);

    totalRounds += equil.rounds;
    if (equil.converged) totalConverged++;
    else totalOscillated++;
    if (equil.rounds > maxRounds) maxRounds = equil.rounds;
    if (equil.allPassEquil) allPassEquilCount++;

    // Record passing decisions.
    for (const p of PLAYERS) {
      if (equil.bids[p] === "pass") {
        passCount[p]++;
        passRecords.push({ pantherEV: equil.pantherEVs[p], hunterEV: equil.hunterEVs[p] });
      }
    }

    // Resolve auction.
    const ar = resolveAuction(equil.bids, dealer, st, cfg,
                              new Rng(seed * 5003 + 3), SEL_ITER);
    auctionDist[ar.auctionType]++;

    const { panther, contract, doubled } = ar;
    const seats = buildSeats(PLAYERS, panther);
    st.vars.seats = seats; st.vars.panther = panther; st.vars.trump = contract.trump;
    const bid: Bid = { tricks: 1, trump: contract.trump, perilsOnly: contract.trump === null };
    st.emit("HandStart", { dealer });
    st.emit("Bid", { player: panther, ...bid });
    asPanther[panther]++;

    // Play.
    const answerers = new Map<Player | null, Answerer>();
    PLAYERS.forEach((p, i) =>
      answerers.set(p, new MCAnswerer(
        p, st, cfg, new Rng(seed * 1009 + i * 997 + 13), contract.story, ITER)));
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
      else if (e.payload.seat === "crow")       cT++;
    }
    const tier = storyOutcome(pT, cT, contract.story);
    const raw  = tierPts(tier, contract.story);
    const pts: Record<Player, number> = Object.fromEntries(PLAYERS.map(p => [p, 0]));
    if (raw.panther > 0) {
      pts[panther] = doubled ? raw.panther * 2 : raw.panther;
    } else {
      for (const p of PLAYERS) if (p !== panther) pts[p] = raw.hunters;
    }
    for (const p of PLAYERS) scores[p] += pts[p];
    storyCnt[contract.story]++;
    storyTiers[contract.story][tier]++;
    if (tier !== "fail") storyMake[contract.story]++;
    totalPantherPts += pts[panther];
    totalHunterPts  += PLAYERS.filter(p => p !== panther).reduce((s, p) => s + pts[p], 0) / 2;
    if (doubled) {
      ffCount++; ffPantherPts += pts[panther];
      ffHunterPts += PLAYERS.filter(p => p !== panther).reduce((s, p) => s + pts[p], 0) / 2;
    }

    dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length] as Player;
  }

  // =========================================================================
  // Output
  // =========================================================================
  const sep = "-".repeat(68);

  // 1. Pass rates and auction distribution
  const totalPasses = Object.values(passCount).reduce((a, b) => a + b, 0);
  const overallPassRate = totalPasses / (3 * N);
  console.log("=".repeat(68));
  console.log("PASS RATES (endogenous threshold = Hunter EV per deal)");
  console.log(sep);
  for (const p of PLAYERS)
    console.log(`  ${p}: ${(100*passCount[p]/N).toFixed(1)}%  (${passCount[p]}/${N} deals)`);
  console.log(`  Overall (per player-deal): ${(100*overallPassRate).toFixed(1)}%`);

  console.log("\nAUCTION TYPE DISTRIBUTION");
  console.log(sep);
  const baseline = { "0pass": "89%", "1pass": "11%", "2pass": "0.6%", "3pass": "0%" };
  for (const [t, n] of Object.entries(auctionDist))
    console.log(`  ${t.padEnd(7)} ${n.toString().padStart(5)}  (${(100*n/N).toFixed(1)}%)` +
                `  cf. fixed-PASS_EV baseline: ${baseline[t as keyof typeof baseline]}`);

  // 2. Convergence
  console.log("\nCONVERGENCE");
  console.log(sep);
  console.log(`  Converged:         ${totalConverged}/${N}  (${(100*totalConverged/N).toFixed(1)}%)`);
  console.log(`  Oscillated/cycled: ${totalOscillated}/${N}  (${(100*totalOscillated/N).toFixed(1)}%)`);
  console.log(`  Mean rounds:       ${(totalRounds/N).toFixed(2)}`);
  console.log(`  Max rounds:        ${maxRounds}`);
  console.log(`  All-pass equilibrium (every player prefers Hunter role): ` +
              `${allPassEquilCount}  (${(100*allPassEquilCount/N).toFixed(1)}%)`);

  // 3. Passing deal characterisation
  if (passRecords.length > 0) {
    const meanPEV  = passRecords.reduce((s, r) => s + r.pantherEV, 0) / passRecords.length;
    const meanHEV  = passRecords.reduce((s, r) => s + r.hunterEV, 0)  / passRecords.length;
    const meanGap  = passRecords.reduce((s, r) => s + (r.hunterEV - r.pantherEV), 0) / passRecords.length;
    // How many passes were "comfortable" (gap > 0.2)?
    const comfortable = passRecords.filter(r => r.hunterEV - r.pantherEV > 0.2).length;
    console.log("\nPASSING DEAL CHARACTERISATION");
    console.log(sep);
    console.log(`  Total pass decisions: ${passRecords.length}`);
    console.log(`  Mean declined Panther EV:  ${meanPEV.toFixed(3)}`);
    console.log(`  Mean Hunter EV threshold:  ${meanHEV.toFixed(3)}`);
    console.log(`  Mean gap (Hunter - Panther EV): ${meanGap.toFixed(3)}`);
    console.log(`  "Comfortable" passes (gap > 0.2): ${comfortable} (${(100*comfortable/passRecords.length).toFixed(1)}%)`);
    console.log(`  Marginal passes (gap ≤ 0.1): ` +
      `${passRecords.filter(r => Math.abs(r.hunterEV - r.pantherEV) <= 0.1).length}`);

    // Distribution of declined Panther EVs
    const bins = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
    console.log(`  Declined Panther EV histogram:`);
    let prev = 0;
    for (const hi of [...bins, Infinity]) {
      const cnt = passRecords.filter(r => r.pantherEV >= prev && r.pantherEV < hi).length;
      const bar = "#".repeat(Math.round(cnt / passRecords.length * 40));
      const label = hi === Infinity ? `>=${prev.toFixed(1)}` : `${prev.toFixed(1)}-${hi.toFixed(1)}`;
      console.log(`    ${label.padEnd(8)} ${String(cnt).padStart(5)}  ${bar}`);
      prev = hi;
    }
  }

  // 4. Post-play balance
  const means = PLAYERS.map(p => scores[p] / N);
  const spread = Math.max(...means) - Math.min(...means);
  const se = 1.5 / Math.sqrt(N);
  console.log("\nPER-PLAYER MEAN POINTS/DEAL");
  console.log(sep);
  PLAYERS.forEach((p, i) =>
    console.log(`  ${p}: ${means[i].toFixed(3)}  (as Panther: ${asPanther[p]} times)`));
  console.log(`  Max spread: ${spread.toFixed(3)}  (~${(spread/se).toFixed(1)} SE  — ` +
    `${spread/se > 3 ? "SIGNIFICANT" : "within noise"})`);

  // 5. Contract mix
  console.log("\nCONTRACT SELECTION + MAKE-RATES");
  console.log(sep);
  console.log("  Contract         n       %   Make%   MeanPnth");
  for (const s of ALL_STORIES) {
    const n = storyCnt[s]; if (!n) continue;
    const ep = (storyTiers[s].large*V.large + storyTiers[s].medium*V.med +
                storyTiers[s].small*V.small + (s==="PantherDefends"?0:0)) / n;
    const nilPts = s==="PantherDefends" ? storyTiers[s].medium*V.nil/n : 0;
    const eP = s === "PantherDefends" ? nilPts
             : (storyTiers[s].large*V.large + storyTiers[s].medium*V.med + storyTiers[s].small*V.small) / n;
    console.log(`  ${STORY_LABELS[s].padEnd(16)} ${n.toString().padStart(5)}  ` +
      `${(100*n/N).toFixed(1).padStart(5)}%  ` +
      `${(100*storyMake[s]/n).toFixed(1).padStart(5)}%   ${eP.toFixed(2).padStart(5)}`);
  }

  // 6. Point flow
  const hunterPtsPerDeal = PLAYERS.reduce((s, p) =>
    s + (scores[p] - asPanther[p] * totalPantherPts / N * (asPanther[p] / N)), 0);
  console.log("\nTABLE-LEVEL POINT FLOW");
  console.log(sep);
  console.log(`  Mean Panther pts / deal:        ${(totalPantherPts/N).toFixed(3)}`);
  console.log(`  Mean Hunter pts  / deal (each): ${(totalHunterPts/N).toFixed(3)}`);
  console.log(`  Gap (Pnth - Hntr):              ${(totalPantherPts/N - totalHunterPts/N).toFixed(3)}`);
  if (ffCount > 0)
    console.log(`  Force-feed: n=${ffCount}  mean Pnth=${(ffPantherPts/ffCount).toFixed(2)}  mean Hntr=${(ffHunterPts/ffCount).toFixed(2)}`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
