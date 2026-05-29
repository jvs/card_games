/**
 * mc_panther.ts — Monte Carlo answerer for Panther.
 *
 * Design:
 *  1. Determinization: build a Belief from viewFor, subtract known cards from
 *     the full deck to get the unknown pool, then sample plausible opponent
 *     hands + woods from that pool.
 *  2. Simulation: construct a fresh State from the sampled world and call
 *     playTricks on it, starting from the current trick position with
 *     partial plays pre-filled (no prank re-processing for plays already made).
 *  3. Bid decisions: assume the MC agent wins the auction with the chosen bid
 *     (simpler than replaying the auction; a known approximation).
 *  4. Play decisions: fix the MC agent's card, continue trick + remaining tricks
 *     with the given playout policy.
 *
 * Hidden-info note: the unknown pool is constructed as
 *   fullDeck − myHand − crow − completedTrickCards − currentTrickCards
 * An unseen Devil swap between two opponents just reshuffles cards within the
 * unknown pool, so no special case is needed — the pool membership is correct
 * regardless of unseen swaps. Swaps involving the MC agent's own hand or the
 * crow (both visible) are already reflected in the viewFor event log.
 *
 * Two playout policies are supported so sweep callers can compare results and
 * see where they diverge (turning policy-dependence into visible data):
 *   'random' — all simulated decisions are uniform-random over legal options
 *   'greedy' — the simulated Panther plays the highest card that can win the
 *              trick (or leads their strongest card); Hunters stay random
 */
import { Answerer, Effect, Choice, Player, Rng, Event } from "./core.js";
import { State, Card } from "./cards.js";
import {
  PantherConfig, Bid, PlayTricksParams, calcHandSize, deck as pantherDeck,
  newState, playTricks, clockwise,
} from "./panther.js";
import { run } from "./core.js";

// Needed for testing and sweep scripts.
export const __mcInternals = { unknownPool, sampleWorld, cardId };

// ---------------------------------------------------------------------------
// Belief — what the MC agent can reconstruct from its viewFor event log.
// ---------------------------------------------------------------------------
export interface Belief {
  phase:               'auction' | 'tricks';
  dealer:              Player;
  myHand:              Card[];
  crow:                Card[];
  completedTrickCards: Card[];   // all cards that have left the table to discard
  currentTrickCards:   Card[];   // played this trick but not yet in discard
  knownWoods:          Card[] | null;
  opponentHandSizes:   Record<Player, number>;
  // trick phase
  trickNumber:         number;
  lead:                number;   // seat index of current trick's lead
  partialPlays:        [number, Card][];
  partialLed:          string | null;
  forcedFromPartials:  number | null;
  won:                 Record<Player, number>;
  crowWon:             number;
  // post-auction
  panther:             Player | null;
  bid:                 Bid | null;
  // auction state (during auction, for evaluating pass)
  auctionPassed:       Set<Player>;
  auctionHighBid:      Bid | null;
  auctionHighBidder:   Player | null;
}

function cardId(c: Card): string { return c.get("suit") + "|" + c.get("rank"); }

/** Reconstruct game belief from the filtered event log (viewFor output). */
export function reconstructBelief(
  log: Event[],
  player: Player,
  allPlayers: Player[],
  cfg: PantherConfig,
): Belief {
  const hs = calcHandSize(cfg);

  // Dealer — from HandStart (added at the top of playHand)
  const handStart = [...log].reverse().find(e => e.type === "HandStart");
  const dealer: Player = handStart?.payload.dealer ?? allPlayers[0];

  // --- Auction result ---
  const auctionPassed = new Set<Player>();
  let auctionHighBid: Bid | null = null;
  let auctionHighBidder: Player | null = null;
  for (const e of log) {
    if (e.type === "Pass") auctionPassed.add(e.payload.player as Player);
    if (e.type === "Bid") {
      auctionHighBid = {
        tricks: e.payload.tricks as number,
        trump:  e.payload.trump as string | null,
        perilsOnly: e.payload.perilsOnly as boolean,
      };
      auctionHighBidder = e.payload.player as Player;
    }
  }
  const panther = auctionHighBidder;
  const bid = auctionHighBid;
  const phase: 'auction' | 'tricks' = panther !== null ? 'tricks' : 'auction';

  // Reconstruct seats (needed for mapping zone names → seat indices)
  let seats: [Player, string][] = [];
  if (panther !== null) {
    const order = clockwise(allPlayers, dealer);
    for (const p of order) {
      seats.push([p, `hand:${p}`]);
      if (p === panther) seats.push([panther, "crow"]);
    }
  }

  // --- Card knowledge ---
  const myHand: Card[] = [];
  const crow: Card[] = [];

  // Initial deal events
  for (const e of log) {
    if (e.type === "DealReveal") {
      if (e.payload.dst === `hand:${player}`) myHand.push(e.payload.card as Card);
      if (e.payload.dst === "crow")            crow.push(e.payload.card as Card);
    }
  }

  // Move events update hand/crow (Devil swaps etc.)
  for (const e of log) {
    if (e.type !== "Move") continue;
    const card = e.payload.card as Card;
    const cid = cardId(card);
    if (e.payload.src === `hand:${player}`) {
      const i = myHand.findIndex(c => cardId(c) === cid);
      if (i >= 0) myHand.splice(i, 1);
    }
    if (e.payload.dst === `hand:${player}`) myHand.push(card);
    if (e.payload.src === "crow") {
      const i = crow.findIndex(c => cardId(c) === cid);
      if (i >= 0) crow.splice(i, 1);
    }
    if (e.payload.dst === "crow") crow.push(card);
  }

  // Played events remove cards from my hand / crow
  for (const e of log) {
    if (e.type !== "Played") continue;
    const card = e.payload.card as Card;
    const cid = cardId(card);
    if (e.payload.seat === `hand:${player}`) {
      const i = myHand.findIndex(c => cardId(c) === cid);
      if (i >= 0) myHand.splice(i, 1);
    }
    if (e.payload.seat === "crow") {
      const i = crow.findIndex(c => cardId(c) === cid);
      if (i >= 0) crow.splice(i, 1);
    }
  }

  // --- Trick state ---
  const trickWonEvents = log.filter(e => e.type === "TrickWon");
  const trickNumber = trickWonEvents.length;
  const won: Record<Player, number> = Object.fromEntries(allPlayers.map(p => [p, 0]));
  let crowWon = 0;

  // Compute lead at end of each completed trick
  let lead = seats.length > 0 ? seats.findIndex(([, z]) => z === `hand:${panther}`) : 0;
  for (let idx = 0; idx < trickWonEvents.length; idx++) {
    const e = trickWonEvents[idx];
    if (e.payload.seat === "crow") crowWon++;
    else won[e.payload.winner as Player] = (won[e.payload.winner as Player] || 0) + 1;

    if (seats.length) {
      // Default lead = winning seat of this trick
      const winnerSeatIdx = seats.findIndex(([, z]) => z === e.payload.seat);
      lead = winnerSeatIdx >= 0 ? winnerSeatIdx : lead;

      // CatLead is emitted INSIDE the trick (before TrickWon), so search between
      // the previous TrickWon and this one.  The wrong pattern (seq > e.seq) would
      // find the Cat from the NEXT trick and corrupt lead.
      const prevSeq = idx > 0 ? trickWonEvents[idx - 1].seq : -1;
      const catEvent = log.find(
        e2 => e2.type === "CatLead" && e2.seq > prevSeq && e2.seq < e.seq
      );
      if (catEvent) lead = catEvent.payload.seat as number;
    }
  }

  // Partial plays in current (incomplete) trick
  const lastTrickSeq = trickWonEvents.length > 0
    ? trickWonEvents[trickWonEvents.length - 1].seq
    : -1;
  const recentPlayed = log.filter(e => e.type === "Played" && e.seq > lastTrickSeq);

  const partialPlays: [number, Card][] = [];
  let partialLed: string | null = null;
  for (const e of recentPlayed) {
    if (!seats.length) break;
    const si = seats.findIndex(([, z]) => z === e.payload.seat);
    if (si >= 0) {
      partialPlays.push([si, e.payload.card as Card]);
      if (partialLed === null) partialLed = (e.payload.card as Card).get("suit");
    }
  }

  // Cat played in partial plays forces next-trick lead
  let forcedFromPartials: number | null = null;
  for (const e of log) {
    if (e.type === "CatLead" && e.seq > lastTrickSeq) {
      forcedFromPartials = e.payload.seat as number;
    }
  }

  // Completed trick cards (to discard) + current trick cards (limbo)
  const completedTrickCards: Card[] = [];
  const currentTrickCards: Card[] = [];
  for (const e of log.filter(e => e.type === "Played")) {
    if (e.seq > lastTrickSeq) currentTrickCards.push(e.payload.card as Card);
    else completedTrickCards.push(e.payload.card as Card);
  }

  // Opponent hand sizes (based on zone plays, not total plays from a player who
  // might control two seats)
  const zonePlayed: Record<string, number> = {};
  for (const e of log.filter(e => e.type === "Played")) {
    const z = e.payload.seat as string;
    zonePlayed[z] = (zonePlayed[z] || 0) + 1;
  }
  const opponentHandSizes: Record<Player, number> = {};
  for (const p of allPlayers) {
    if (p === player) continue;
    opponentHandSizes[p] = hs - (zonePlayed[`hand:${p}`] || 0);
  }
  // Account for visible moves to/from opponent hands
  for (const e of log) {
    if (e.type !== "Move") continue;
    for (const p of allPlayers) {
      if (p === player) continue;
      if (e.payload.src === `hand:${p}` && opponentHandSizes[p] > 0) opponentHandSizes[p]--;
      if (e.payload.dst === `hand:${p}`) opponentHandSizes[p]++;
    }
  }

  // Hound peek: take the LAST HoundPeek by this player
  let knownWoods: Card[] | null = null;
  for (const e of log) {
    if (e.type === "HoundPeek" && e.payload.player === player) {
      knownWoods = e.payload.woods as Card[];
    }
  }

  return {
    phase, dealer, myHand, crow, completedTrickCards, currentTrickCards,
    knownWoods, opponentHandSizes, trickNumber, lead, partialPlays, partialLed,
    forcedFromPartials, won, crowWon, panther, bid,
    auctionPassed, auctionHighBid, auctionHighBidder,
  };
}

// ---------------------------------------------------------------------------
// World sampling — distributes the unknown card pool to opponent hands + woods.
// ---------------------------------------------------------------------------
function unknownPool(belief: Belief, cfg: PantherConfig, player: Player): Card[] {
  const known = new Set<string>();
  for (const c of belief.myHand)              known.add(cardId(c));
  for (const c of belief.crow)                known.add(cardId(c));
  for (const c of belief.completedTrickCards) known.add(cardId(c));
  for (const c of belief.currentTrickCards)   known.add(cardId(c));
  if (belief.knownWoods) for (const c of belief.knownWoods) known.add(cardId(c));
  return pantherDeck(cfg).filter(c => !known.has(cardId(c)));
}

interface SampledWorld {
  opponentHands: Record<Player, Card[]>;
  woods: Card[];
}

export function sampleWorld(
  belief: Belief, player: Player, allPlayers: Player[], cfg: PantherConfig, rng: Rng,
): SampledWorld {
  const pool = unknownPool(belief, cfg, player);
  rng.shuffle(pool);

  const opponentHands: Record<Player, Card[]> = {};
  let offset = 0;
  for (const p of allPlayers) {
    if (p === player) continue;
    const size = Math.max(0, belief.opponentHandSizes[p] ?? 0);
    opponentHands[p] = pool.slice(offset, offset + size);
    offset += size;
  }

  const woodsKnown = belief.knownWoods ?? [];
  const woodsUnknown = pool.slice(offset, offset + (cfg.woodsSize - woodsKnown.length));
  const woods = [...woodsKnown, ...woodsUnknown];

  return { opponentHands, woods };
}

// ---------------------------------------------------------------------------
// Build a simulation State from belief + sampled world. The State's zones are
// populated directly; no deal events are emitted (the log isn't used by the
// simulation).
// ---------------------------------------------------------------------------
export function buildSimState(
  belief: Belief,
  world: SampledWorld,
  player: Player,
  allPlayers: Player[],
  cfg: PantherConfig,
  rng: Rng,
): State {
  const st = newState(allPlayers, rng);
  // Known zones
  st.z(`hand:${player}`).cards = [...belief.myHand];
  st.z("crow").cards           = [...belief.crow];
  st.z("discard").cards        = [...belief.completedTrickCards];
  // Sampled zones
  for (const p of allPlayers) {
    if (p !== player) st.z(`hand:${p}`).cards = [...world.opponentHands[p]];
  }
  st.z("woods").cards = [...world.woods];
  return st;
}

// ---------------------------------------------------------------------------
// Playout policies
// ---------------------------------------------------------------------------
export type PlayoutPolicy = "random" | "greedy";

class GreedyPantherAnswerer implements Answerer {
  constructor(private panther: Player, private rng: Rng) {}
  answer(req: Choice): any {
    if (req.key !== "play" || req.player !== this.panther) return this.rng.choice(req.options);
    const cards = req.options as Card[];
    const led = (req.meta?.led as string | null) ?? null;
    const trump = (req.meta?.trump as string | null) ?? null;

    if (led === null) {
      // Leading: prefer highest trump, then highest Perils, then highest overall
      const byTier = (c: Card) => {
        const s = c.get("suit");
        if (s === "Perils") return 2;
        if (trump && s === trump) return 1;
        return 0;
      };
      return cards.slice().sort((a, b) => {
        const dt = byTier(b) - byTier(a);
        return dt !== 0 ? dt : b.get("rank") - a.get("rank");
      })[0];
    }
    // Following: highest of led suit first; else lowest to shed
    const ledSuit = cards.filter(c => c.get("suit") === led);
    if (ledSuit.length) return ledSuit.sort((a, b) => b.get("rank") - a.get("rank"))[0];
    return cards.slice().sort((a, b) => a.get("rank") - b.get("rank"))[0];
  }
}

// ---------------------------------------------------------------------------
// Competitive auction model.
//
// After the agent commits to agentDecision (a bid or "pass"), each remaining
// active opponent randomly passes (p=0.6) or bids at the current floor (p=0.4).
// The first bidder in auction order is forced to bid when no prior bid exists.
// This is crude — opponent bid probability isn't calibrated to hand strength —
// but it prices in losing the auction, which makes bid-success-rate meaningful.
// ---------------------------------------------------------------------------
const AUCTION_SUITS = ["Spades", "Diamonds", "Hearts", "Clubs"];

function remainingAuction(
  belief: Belief,
  agentDecision: Bid | "pass",
  player: Player,
  allPlayers: Player[],
  cfg: PantherConfig,
  rng: Rng,
): { panther: Player; bid: Bid } {
  const hs = calcHandSize(cfg);
  // Auction order: left of dealer through dealer (dealer bids last).
  const order = [...clockwise(allPlayers, belief.dealer).slice(1), belief.dealer];

  const passed = new Set<Player>(belief.auctionPassed);
  let high: Bid | null = belief.auctionHighBid ? { ...belief.auctionHighBid } : null;
  let highBidder: Player | null = belief.auctionHighBidder;

  // Apply agent's decision.
  if (agentDecision === "pass") {
    passed.add(player);
  } else {
    high = agentDecision;
    highBidder = player;
  }

  // Continue until one active player remains.  Cycle through order; passed
  // players and the agent (already decided) are skipped.
  let cycles = 0;
  const maxCycles = allPlayers.length * (hs + 2);
  while (order.length - passed.size > 1 && cycles < maxCycles) {
    cycles++;
    for (const p of order) {
      if (passed.has(p) || p === player) continue;
      if (order.length - passed.size <= 1) break;

      const floor = high ? high.tricks + 1 : 1;
      if (floor > hs) { passed.add(p); continue; }

      // order[0] must bid when no prior bid exists (same rule as real auction).
      const mustBid = high === null && p === order[0];
      // Bid probability declines with floor: opponents need increasingly strong
      // hands to justify bidding at higher levels.  Formula: (hs - floor + 1) /
      // (hs * 2), giving ~0.5 at floor=1 down to ~0.05 at floor=hs.
      const pBid = mustBid ? 1 : (hs - floor + 1) / (hs * 2);
      if (rng.next() >= pBid) {
        passed.add(p);
      } else {
        const perilsOnly = rng.next() < 0.2;
        high = perilsOnly
          ? { tricks: floor, trump: null, perilsOnly: true }
          : { tricks: floor, trump: rng.choice(AUCTION_SUITS), perilsOnly: false };
        highBidder = p;
      }
    }
  }

  if (high && highBidder) return { panther: highBidder as Player, bid: high };
  // Fallback: find any active non-agent player; if none, agent wins.
  const active = order.filter(p => !passed.has(p) && p !== player);
  const winner = (active[0] ?? player) as Player;
  return { panther: winner, bid: high ?? { tricks: 1, trump: AUCTION_SUITS[0], perilsOnly: false } };
}

// ---------------------------------------------------------------------------
// Simulate one playout from the current belief, with a specific first answer
// for the MC player's pending decision.
// ---------------------------------------------------------------------------
async function simulatePlayout(
  opt: any,
  belief: Belief,
  player: Player,
  allPlayers: Player[],
  cfg: PantherConfig,
  rng: Rng,
  policy: PlayoutPolicy,
  isBidDecision: boolean,
  fromZone?: string,   // for play decisions: the zone the agent plays from (from Choice meta)
): Promise<number> {
  const world = sampleWorld(belief, player, allPlayers, cfg, rng);
  const simSt = buildSimState(belief, world, player, allPlayers, cfg, new Rng(rng.int(2 ** 30)));

  // Determine panther and bid for this simulation
  let simPanther: Player;
  let simBid: Bid;

  if (isBidDecision) {
    // Run the competitive auction: agent commits to opt, opponents bid/pass randomly.
    const auction = remainingAuction(belief, opt as Bid | "pass", player, allPlayers, cfg, rng);
    simPanther = auction.panther;
    simBid = auction.bid;
    simSt.vars.trump = simBid.perilsOnly ? null : simBid.trump;
  } else {
    if (!belief.panther || !belief.bid) return 0;
    simPanther = belief.panther;
    simBid = belief.bid;
    simSt.vars.trump = simBid.perilsOnly ? null : simBid.trump;
  }

  // Build seats
  const order = clockwise(allPlayers, belief.dealer);
  const seats: [Player, string][] = [];
  for (const p of order) {
    seats.push([p, `hand:${p}`]);
    if (p === simPanther) seats.push([simPanther, "crow"]);
  }
  simSt.vars.seats = seats;
  simSt.vars.panther = simPanther;

  const hs = calcHandSize(cfg);

  // For bid decisions: start from trick 0 with no partial plays
  // For play decisions: start from current trick position with partial plays,
  //   then inject opt as the NEXT play (the MC agent's pending move)
  let params: PlayTricksParams;
  if (isBidDecision) {
    params = {
      seats, lead: seats.findIndex(([, z]) => z === `hand:${simPanther}`),
      handSize: hs, panther: simPanther, bid: simBid,
      trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
      won: Object.fromEntries(allPlayers.map(p => [p, 0])), crowWon: 0,
    };
  } else {
    // Use fromZone (from the live Choice meta) as the authoritative zone for the
    // agent's play. This avoids dependence on belief.lead reconstruction accuracy.
    const optCard = opt as Card;
    const optCid = cardId(optCard);
    const authorZone = fromZone ?? `hand:${player}`;
    const authorSi = seats.findIndex(([, z]) => z === authorZone);

    // Remove opt from its zone in the sim state
    const zc = simSt.z(authorZone).cards;
    const ri = zc.findIndex(c => cardId(c) === optCid);
    if (ri >= 0) zc.splice(ri, 1);
    // else: opt was already excluded from zones by the belief accounting

    const extPartialPlays: [number, Card][] = [...belief.partialPlays, [authorSi, optCard]];
    const extLed = belief.partialLed ?? optCard.get("suit");

    params = {
      seats, lead: belief.lead,
      handSize: hs, panther: simPanther, bid: simBid,
      trickNum: belief.trickNumber,
      partialPlays: extPartialPlays,
      partialLed: extLed,
      forcedFromPartials: belief.forcedFromPartials,
      won: { ...belief.won },
      crowWon: belief.crowWon,
    };
  }

  // Build answerer map for the simulation
  const randomAns = new Rng(rng.int(2 ** 30));
  const answerers = new Map<Player | null, Answerer>();

  if (policy === "greedy" && simPanther !== null) {
    answerers.set(simPanther, new GreedyPantherAnswerer(simPanther, new Rng(rng.int(2 ** 30))));
  }
  // All other players (and RNG) → random
  answerers.set(null, { answer: (req: Choice) => rng.choice(req.options) });

  const result = await run(playTricks(simSt, params, cfg), answerers);
  return result[player] ?? 0;
}

// ---------------------------------------------------------------------------
// MCAnswerer — the Monte Carlo answerer. Fits the Answerer interface exactly;
// no engine changes needed.
// ---------------------------------------------------------------------------
export class MCAnswerer implements Answerer {
  constructor(
    private player:     Player,
    private st:         State,           // live game state (read via viewFor only)
    private allPlayers: Player[],
    private cfg:        PantherConfig,
    private rng:        Rng,             // dedicated simulation RNG
    private iterations: number = 100,
    private policy:     PlayoutPolicy = "random",
  ) {}

  async answer(req: Effect): Promise<any> {
    const c = req as Choice;
    if (c.options.length === 1) return c.options[0];

    // Prank sub-decisions are rare and low-impact: random is fine.
    const key = c.key ?? "";
    if (!["bid", "play"].includes(key)) return this.rng.choice(c.options);

    const log = this.st.viewFor(this.player);
    const belief = reconstructBelief(log, this.player, this.allPlayers, this.cfg);

    const isBid = key === "bid";

    const scores = new Map<any, number>();
    for (const opt of c.options) scores.set(opt, 0);

    for (let i = 0; i < this.iterations; i++) {
      for (const opt of c.options) {
        const fromZone = isBid ? undefined : (c.meta?.seat as string | undefined);
        const score = await simulatePlayout(
          opt, belief, this.player, this.allPlayers, this.cfg, this.rng, this.policy, isBid, fromZone
        );
        scores.set(opt, (scores.get(opt) ?? 0) + score);
      }
    }

    let best = c.options[0];
    let bestScore = -Infinity;
    for (const opt of c.options) {
      const s = scores.get(opt) ?? 0;
      if (s > bestScore) { bestScore = s; best = opt; }
    }
    return best;
  }
}
