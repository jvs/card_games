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
 *  3. Curse decisions: simulate opponents declaring/passing randomly, apply
 *     resolution rules, then evaluate the resulting hand.
 *  4. Play decisions: fix the MC agent's card, continue trick + remaining tricks
 *     with random rollouts.
 *
 * All inner simulations use random play. This is unbiased and converges well
 * for a 10-trick game; the per-card expected-point estimates become accurate
 * enough with 50–200 iterations that a greedy inner heuristic adds no
 * meaningful benefit.
 *
 * Hidden-info note: the unknown pool is constructed as
 *   fullDeck − myHand − crow − completedTrickCards − currentTrickCards
 * An unseen Devil swap between two opponents just reshuffles cards within the
 * unknown pool, so no special case is needed — the pool membership is correct
 * regardless of unseen swaps. Swaps involving the MC agent's own hand or the
 * crow (both visible) are already reflected in the viewFor event log.
 */
import { Answerer, Effect, Choice, Player, Rng, Event } from "../core.js";
import { State, Card } from "../cards.js";
import {
  PantherConfig, Story, PlanKind, NON_PANIC_PLANS, PlayTricksParams,
  calcHandSize, deck as pantherDeck,
  newState, playTricks, clockwise, firstLeadSeat, buildSeats,
} from "./panther.js";
import { run } from "../core.js";

// Needed for testing and sweep scripts.
export const __mcInternals = { unknownPool, sampleWorld, cardId };

// ---------------------------------------------------------------------------
// Belief — what the MC agent can reconstruct from its viewFor event log.
// ---------------------------------------------------------------------------
export interface Belief {
  phase:               'curse' | 'tricks';
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
  // post-curse
  panther:             Player | null;
  story:               Story | null;
  // curse state (for evaluating curse declarations mid-curse)
  cursePassed:         Set<Player>;
  curseStories:        [Player, Story][];
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

  // --- Curse result ---
  const cursePassed = new Set<Player>();
  const curseStories: [Player, Story][] = [];
  let panther: Player | null = null;
  let story: Story | null = null;

  for (const e of log) {
    if (e.type === "Pass") cursePassed.add(e.payload.player as Player);
    if (e.type === "Story") {
      curseStories.push([e.payload.player as Player, {
        plan:   e.payload.plan   as PlanKind,
        ground: e.payload.ground as string | null,
      }]);
    }
    if (e.type === "CurseResult") {
      panther = e.payload.panther as Player;
      story   = { plan: e.payload.plan as PlanKind, ground: e.payload.ground as string | null };
    }
  }
  const phase: 'curse' | 'tricks' = panther !== null ? 'tricks' : 'curse';

  // Reconstruct seats (needed for mapping zone names → seat indices)
  let seats: [Player, string][] = [];
  if (panther !== null) seats = buildSeats(allPlayers, panther);

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
  let lead = seats.length > 0 && panther !== null
    ? firstLeadSeat(seats, panther, allPlayers, cfg) : 0;
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
    forcedFromPartials, won, crowWon, panther, story,
    cursePassed, curseStories,
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
// Curse simulation model.
//
// After the agent commits to agentDecision (a story or "pass"), each remaining
// undecided opponent independently tells a random story (p=0.5) or passes.
// Curse resolution is then applied per the v2 rules.
// ---------------------------------------------------------------------------
const CURSE_SUITS = ["Spades", "Diamonds", "Hearts", "Clubs"];

function remainingCurse(
  belief: Belief,
  agentDecision: Story | "pass",
  player: Player,
  allPlayers: Player[],
  rng: Rng,
): { panther: Player; story: Story } {
  // Curse order: left of dealer first.
  const leftOfDealer = clockwise(allPlayers, belief.dealer)[1];
  const order = clockwise(allPlayers, leftOfDealer);

  // Carry forward what's already been declared.
  const storyTellers: [Player, Story][] = [...belief.curseStories];
  const passers = new Set<Player>(belief.cursePassed);
  const decided = new Set<Player>([
    ...passers,
    ...storyTellers.map(([p]) => p),
  ]);

  // Apply agent's decision.
  if (!decided.has(player)) {
    if (agentDecision === "pass") passers.add(player);
    else storyTellers.push([player, agentDecision]);
    decided.add(player);
  }

  // Simulate remaining undecided opponents.
  for (const p of order) {
    if (decided.has(p)) continue;
    if (rng.next() < 0.5) {
      const plan = rng.choice(NON_PANIC_PLANS);
      const ground = rng.next() < 0.2 ? null : rng.choice(CURSE_SUITS);
      storyTellers.push([p, { plan, ground }]);
    } else {
      passers.add(p);
    }
    decided.add(p);
  }

  // Apply resolution rules.
  switch (storyTellers.length) {
    case 0: {
      const ground = rng.next() < 0.2 ? null : rng.choice(CURSE_SUITS);
      return { panther: leftOfDealer, story: { plan: "Panic", ground } };
    }
    case 1:
      return { panther: storyTellers[0][0], story: storyTellers[0][1] };
    default: {
      // 2 or 3 stories: chooser picks randomly in simulation.
      const chosen = rng.choice(storyTellers.map(([p]) => p));
      const chosenStory = storyTellers.find(([p]) => p === chosen)![1];
      return { panther: chosen, story: chosenStory };
    }
  }
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
  isBidDecision: boolean,
  fromZone?: string,
): Promise<number> {
  const world = sampleWorld(belief, player, allPlayers, cfg, rng);
  const simSt = buildSimState(belief, world, player, allPlayers, cfg, new Rng(rng.int(2 ** 30)));

  // Determine panther and story for this simulation
  let simPanther: Player;
  let simStory: Story;

  if (isBidDecision) {
    // Simulate the curse: agent commits to opt, opponents decide randomly.
    const curse = remainingCurse(belief, opt as Story | "pass", player, allPlayers, rng);
    simPanther = curse.panther;
    simStory = curse.story;
    simSt.vars.trump = simStory.ground;
  } else {
    if (!belief.panther || !belief.story) return 0;
    simPanther = belief.panther;
    simStory = belief.story;
    simSt.vars.trump = simStory.ground;
  }

  // Build seats
  const seats = buildSeats(allPlayers, simPanther);
  simSt.vars.seats = seats;
  simSt.vars.panther = simPanther;

  const hs = calcHandSize(cfg);

  // For bid decisions: start from trick 0 with no partial plays
  // For play decisions: start from current trick position with partial plays,
  //   then inject opt as the NEXT play (the MC agent's pending move)
  let params: PlayTricksParams;
  if (isBidDecision) {
    params = {
      seats, lead: firstLeadSeat(seats, simPanther, allPlayers, cfg),
      handSize: hs, panther: simPanther, story: simStory,
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
      handSize: hs, panther: simPanther, story: simStory,
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

  // All decisions in inner simulations are random.
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
  ) {}

  async answer(req: Effect): Promise<any> {
    const c = req as Choice;
    if (c.options.length === 1) return c.options[0];

    // Prank sub-decisions are rare and low-impact: random is fine.
    const key = c.key ?? "";
    if (!["curse", "play"].includes(key)) return this.rng.choice(c.options);

    const log = this.st.viewFor(this.player);
    const belief = reconstructBelief(log, this.player, this.allPlayers, this.cfg);

    const isBidDecision = key === "curse";

    const scores = new Map<any, number>();
    for (const opt of c.options) scores.set(opt, 0);

    for (let i = 0; i < this.iterations; i++) {
      for (const opt of c.options) {
        const fromZone = isBidDecision ? undefined : (c.meta?.seat as string | undefined);
        const score = await simulatePlayout(
          opt, belief, this.player, this.allPlayers, this.cfg, this.rng, isBidDecision, fromZone
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
