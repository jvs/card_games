/**
 * panther.ts — Panther, a 3-player trick-taker, implemented on the substrate.
 * The reference game: a worked example of the effect/generator pattern, the
 * zone/visibility model, secrets, and the Question seam.
 *
 * v2 rules: The Curse replaces the Spades-style auction. Each player declares
 * a Plan+Ground or passes; resolution depends on how many players told a story.
 * Scoring is a fixed per-plan point table (no bid-tricks multiplier).
 */
import {
  State, Card, Vis, Rng, Player, Question, HAND_PUBLIC,
  choice, run, RandomAnswerer, AnswererOrMap, Game,
} from "../cards.js";

// ---------------------------------------------------------------------------
// Config — tuneable levers for balance sweeps. The default reproduces the
// v2 rules. Rules logic must not reference magic numbers; use config fields.
// ---------------------------------------------------------------------------
export interface PantherConfig {
  perilsCount:  number;      // how many Peril cards (1–5)
  cardsPerSuit: number;      // traditional cards per suit, incl. the Prank
  woodsSize:    number;      // hidden reserve pile
  targetScore:  number;      // game ends when this score is reached
  firstLeader:  FirstLeader; // which seat leads the first trick of a hand
}

// Who leads the opening trick. "panther" is the rules-accurate default; the
// others exist to probe whether leading first is the source of the Panther's
// edge. "panther" and "crow" are BOTH Panther-controlled seats; only
// "left-of-panther" hands the opening lead to a Hunter.
export type FirstLeader = "panther" | "crow" | "left-of-panther";

export const DEFAULT_CONFIG: PantherConfig = {
  perilsCount:  5,
  cardsPerSuit: 10,
  woodsSize:    5,
  targetScore:  25,
  firstLeader:  "panther",
};

/** Derive the hand (and crow) size from the deck composition. Throws if the
 *  arithmetic doesn't divide evenly — caller chose an incoherent config. */
export function calcHandSize(cfg: PantherConfig): number {
  const total = 4 * cfg.cardsPerSuit + cfg.perilsCount;
  const remaining = total - cfg.woodsSize;
  if (remaining % 4 !== 0 || remaining <= 0)
    throw new Error(
      `config incoherent: (4×${cfg.cardsPerSuit} + ${cfg.perilsCount} − ${cfg.woodsSize}) = ${remaining} must be divisible by 4`
    );
  return remaining / 4;
}

// ---------------------------------------------------------------------------
// Plan types — the four contract types available in the Curse.
// ---------------------------------------------------------------------------
export type PlanKind = "Fight" | "Run" | "Vanish" | "Panic";

export const ALL_PLANS: PlanKind[] = ["Fight", "Run", "Vanish", "Panic"];

/** Plans available in the Curse. Panic is reserved for the forced all-pass case. */
export const NON_PANIC_PLANS: PlanKind[] = ["Fight", "Run", "Vanish"];

export const PLAN_LABELS: Record<PlanKind, string> = {
  Fight:  "Fight",
  Run:    "Run",
  Vanish: "Vanish",
  Panic:  "Panic",
};

/** A story: the Panther's declared plan and the lesser trump suit (null = Perils-Only). */
export interface Story {
  plan:   PlanKind;
  ground: string | null;  // lesser trump suit, or null for Perils-Only
}

// ---------------------------------------------------------------------------
// Card tables
// ---------------------------------------------------------------------------
const SUITS = ["Spades", "Diamonds", "Hearts", "Clubs"];
const PRANK: Record<string, string> = {
  Spades: "Snitch", Diamonds: "Devil", Hearts: "Hound", Clubs: "Cat",
};
const TRAD: [string, number][] = [
  ["Prank", 4], ["5", 5], ["6", 6], ["7", 7], ["8", 8], ["9", 9],
  ["10", 10], ["J", 11], ["Q", 12], ["K", 13], ["A", 14],
];
const PERILS: [string, number][] = [
  ["Goblin", 21], ["Ogre", 22], ["Dragon", 23], ["Witch", 24], ["Death", 25],
];

export function deck(cfg: PantherConfig): Card[] {
  if (cfg.perilsCount > PERILS.length)
    throw new Error(`perilsCount ${cfg.perilsCount} exceeds available perils (${PERILS.length})`);
  if (cfg.cardsPerSuit > TRAD.length)
    throw new Error(`cardsPerSuit ${cfg.cardsPerSuit} exceeds defined ranks (${TRAD.length})`);
  const cs: Card[] = [];
  const tradCards = TRAD.slice(0, cfg.cardsPerSuit);
  for (const s of SUITS)
    for (const [lbl, v] of tradCards)
      cs.push(Card.of({ suit: s, rank: v, label: lbl === "Prank" ? PRANK[s] : lbl,
                        prank: lbl === "Prank" ? PRANK[s] : null }));
  for (const [lbl, v] of PERILS.slice(0, cfg.perilsCount))
    cs.push(Card.of({ suit: "Perils", rank: v, label: lbl, prank: null }));
  return cs;
}

// --- trick comparison (pure; PRNG-independent) ---
export function cardStrength(c: Card, led: string, trump: string | null): [number, number] {
  const s = c.get("suit");
  let tier: number;
  if (s === "Perils") tier = 3;
  else if (trump !== null && s === trump) tier = 2;
  else if (s === led) tier = 1;
  else tier = 0;
  return [tier, c.get("rank")];
}
export function trickWinner(plays: [number, Card][], trump: string | null): number {
  const led = plays[0][1].get("suit");
  let best = plays[0];
  for (const pc of plays) {
    const a = cardStrength(pc[1], led, trump), b = cardStrength(best[1], led, trump);
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) best = pc;
  }
  return best[0];
}

function mustFollow(hand: Card[], led: string | null): Card[] {
  if (led === null) return [...hand];
  const same = hand.filter((c) => c.get("suit") === led);
  return same.length ? same : [...hand];
}

export function newState(players: Player[], rng: Rng): State {
  const st = new State(players, rng);
  st.zone("deck", Vis.HIDDEN);
  st.zone("crow", Vis.PUBLIC);
  st.zone("woods", Vis.HIDDEN);
  st.zone("discard", Vis.PUBLIC);
  st.perPlayerZone("hand", Vis.OWNER);
  return st;
}

export const clockwise = (ps: Player[], start: Player) => {
  const i = ps.indexOf(start);
  return [...ps.slice(i), ...ps.slice(0, i)];
};

/** Table seating, clockwise, with the Crow seated ACROSS from the Panther so
 *  play alternates Panther-team / Hunter-team. For 3 players this yields
 *  [Panther-hand, Hunter1-hand, Crow, Hunter2-hand]. */
export function buildSeats(players: Player[], panther: Player): [Player, string][] {
  const [, ...hunters] = clockwise(players, panther);
  const seats: [Player, string][] = [[panther, `hand:${panther}`]];
  hunters.forEach((h, i) => {
    seats.push([h, `hand:${h}`]);
    if (i === Math.floor((hunters.length - 1) / 2)) seats.push([panther, "crow"]);
  });
  return seats;
}

export function firstLeadSeat(
  seats: [Player, string][], panther: Player, players: Player[], cfg: PantherConfig,
): number {
  switch (cfg.firstLeader) {
    case "crow":
      return seats.findIndex(([, z]) => z === "crow");
    case "left-of-panther": {
      const left = clockwise(players, panther)[1 % players.length];
      return seats.findIndex(([, z]) => z === `hand:${left}`);
    }
    case "panther":
    default:
      return seats.findIndex(([, z]) => z === `hand:${panther}`);
  }
}

// ---------------------------------------------------------------------------
// Trick-playing loop — extracted so the MC agent can call it on a freshly
// constructed state without re-running the deal/curse.
// ---------------------------------------------------------------------------
export interface PlayTricksParams {
  seats:              [Player, string][];
  lead:               number;          // seat index to lead trick trickNum
  handSize:           number;          // total tricks this hand
  panther:            Player;
  story:              Story;
  trickNum:           number;          // first trick to play (0 = full hand)
  partialPlays:       [number, Card][]; // [seatIdx, card] already played in trickNum
  partialLed:         string | null;   // suit led so far in trickNum
  forcedFromPartials: number | null;   // Cat-forced next-lead baked into partials
  won:                Record<Player, number>;
  crowWon:            number;
}

export function* playTricks(
  st: State,
  p: PlayTricksParams,
  cfg: PantherConfig,
): Game<Record<Player, number>> {
  let lead = p.lead;
  const won = { ...p.won };
  let crowWon = p.crowWon;

  for (let t = p.trickNum; t < p.handSize; t++) {
    const plays: [number, Card][] = t === p.trickNum ? [...p.partialPlays] : [];
    let led: string | null = t === p.trickNum ? p.partialLed : null;
    let forced: number | null = t === p.trickNum ? (p.forcedFromPartials ?? null) : null;
    const startOff = plays.length;
    const rotation = [...p.seats.slice(lead), ...p.seats.slice(0, lead)];

    for (let off = startOff; off < rotation.length; off++) {
      const [controller, zname] = rotation[off];
      const si = (lead + off) % p.seats.length;
      const card: Card = yield choice(controller, mustFollow(st.z(zname).cards, led),
        "play", { seat: zname, led, trick: t });
      st.emit("Played", { seat: zname, controller, card });
      st.z(zname).remove(card);
      led = led ?? card.get("suit");
      plays.push([si, card]);
      if (card.get("prank")) {
        const f = yield* prank(st, card, controller, zname);
        if (f !== null) forced = f;
      }
    }
    const wsi = trickWinner(plays, st.vars.trump);
    const wseat = p.seats[wsi];
    for (const [, c] of plays) st.z("discard").add(c);
    st.emit("TrickWon", { seat: wseat[1], winner: wseat[0], trick: t });
    if (wseat[1] === "crow") crowWon++; else won[wseat[0]]++;
    lead = forced !== null ? forced : wsi;
  }
  return score(st, p.panther, p.story, won[p.panther], crowWon);
}

export function* playHand(st: State, dealer: Player, cfg: PantherConfig): Game<Record<Player, number>> {
  const hs = calcHandSize(cfg);
  st.emit("HandStart", { dealer });
  st.z("deck").cards = deck(cfg);
  st.shuffle("deck");
  for (const p of st.players) st.deal("deck", `hand:${p}`, hs);
  st.deal("deck", "crow", hs);
  st.deal("deck", "woods", cfg.woodsSize);

  const [panther, story] = yield* curse(st, dealer);
  st.vars.panther = panther;
  st.vars.trump = story.ground;  // null if Perils-Only

  const seats = buildSeats(st.players, panther);
  st.vars.seats = seats;

  const won: Record<Player, number> = Object.fromEntries(st.players.map((p) => [p, 0]));
  const lead = firstLeadSeat(seats, panther, st.players, cfg);

  return yield* playTricks(st, {
    seats, lead, handSize: hs, panther, story,
    trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
    won, crowWon: 0,
  }, cfg);
}

// ---------------------------------------------------------------------------
// The Curse — v2 story-declaration system.
//
// Order: player to the dealer's left goes first, clockwise, dealer goes last.
// Each player either tells a story (Plan + Ground) or passes.
//
// Resolution by story count:
//   0 stories — left-of-dealer is forced to declare Panic; they pick any Ground.
//   1 story   — that player becomes the Panther and plays their story.
//   2 stories — the one player who passed chooses which storyteller is Panther.
//   3 stories — left-of-dealer chooses which player is Panther (may pick self).
// ---------------------------------------------------------------------------

/** All (plan, ground) options available to a player during the Curse.
 *  Panic is reserved for the forced all-pass case — not offered here. */
function curseStoryOptions(): Story[] {
  const opts: Story[] = [];
  for (const plan of NON_PANIC_PLANS) {
    for (const g of SUITS) opts.push({ plan, ground: g });
    opts.push({ plan, ground: null }); // Perils-Only
  }
  return opts;
}

function* curse(st: State, dealer: Player): Game<[Player, Story]> {
  const left = clockwise(st.players, dealer)[1]; // player to dealer's left
  const order = clockwise(st.players, left);     // curse order: left→...→dealer

  const storyTellers: [Player, Story][] = [];
  const passers: Player[] = [];
  const storyOpts = curseStoryOptions();

  for (const p of order) {
    const opts: (Story | "pass")[] = ["pass", ...storyOpts];
    const decision: Story | "pass" = yield choice(p, opts, "curse", {});
    if (decision === "pass") {
      st.emit("Pass", { player: p });
      passers.push(p);
    } else {
      st.emit("Story", { player: p, plan: decision.plan, ground: decision.ground });
      storyTellers.push([p, decision]);
    }
  }

  switch (storyTellers.length) {
    case 0: {
      // Forced Panic: left-of-dealer picks any Ground.
      const groundOpts: (string | null)[] = [...SUITS, null];
      const ground: string | null = yield choice(left, groundOpts, "panic_ground", {});
      const story: Story = { plan: "Panic", ground };
      st.emit("CurseResult", { panther: left, plan: "Panic", ground });
      return [left, story];
    }
    case 1: {
      const [panther, story] = storyTellers[0];
      st.emit("CurseResult", { panther, plan: story.plan, ground: story.ground });
      return [panther, story];
    }
    case 2: {
      // The one passer chooses which storyteller becomes the Panther.
      const passer = passers[0];
      const candidates = storyTellers.map(([p]) => p);
      const chosen: Player = yield choice(passer, candidates, "choose_panther", {});
      const story = storyTellers.find(([p]) => p === chosen)![1];
      st.emit("CurseResult", { panther: chosen, plan: story.plan, ground: story.ground });
      return [chosen, story];
    }
    default: {
      // All three told a story: left-of-dealer picks the Panther (may pick self).
      const candidates = storyTellers.map(([p]) => p);
      const chosen: Player = yield choice(left, candidates, "choose_panther", {});
      const story = storyTellers.find(([p]) => p === chosen)![1];
      st.emit("CurseResult", { panther: chosen, plan: story.plan, ground: story.ground });
      return [chosen, story];
    }
  }
}

// ---------------------------------------------------------------------------
// Prank cards
// ---------------------------------------------------------------------------
function* prank(st: State, card: Card, controller: Player, zname: string): Game<number | null> {
  const name = card.get("prank");
  if (name === "Cat") return yield* cat(st, controller);
  if (name === "Devil") yield* devil(st, controller, zname);
  if (name === "Hound") hound(st, controller);
  if (name === "Snitch") yield* snitch(st, controller);
  return null;
}
function* cat(st: State, controller: Player): Game<number> {
  const seats = st.vars.seats as [Player, string][];
  const result: number = yield choice(controller, seats.map((_, i) => i), "cat_leader");
  st.emit("CatLead", { seat: result });
  return result;
}
function* devil(st: State, controller: Player, zname: string): Game<void> {
  const mine = [...st.z(zname).cards];
  if (!mine.length) return;
  const seats = st.vars.seats as [Player, string][];
  const targets = seats.map(([, z]) => z).filter((z) => z !== zname && st.z(z).length);
  if (!targets.length) return;
  const tgt: string = yield choice(controller, targets, "devil_target");
  const give: Card = yield choice(controller, mine, "devil_give");
  const theirs = [...st.z(tgt).cards];
  const crow = zname === "crow" || tgt === "crow";
  const other = tgt === "crow" ? (st.vars.panther as Player) : st.z(tgt).owner!;
  const seen = crow ? null : new Set([controller, other]);
  if (theirs.length) {
    const take: Card = yield choice(other, theirs, "devil_take");
    st.move(take, tgt, zname, seen);
  }
  st.move(give, zname, tgt, seen);
}
function hound(st: State, controller: Player): void {
  st.emit("HoundPeek", { player: controller, woods: [...st.z("woods").cards] },
          new Set([controller]));
}
function* snitch(st: State, controller: Player): Game<void> {
  const others = st.players.filter((p) => p !== controller);
  const target: Player = yield choice(controller, others, "snitch_target");
  const q = new Question("Do you hold any Peril?",
    "(hand, pub) => hand.some(c => c.get('suit') === 'Perils')", HAND_PUBLIC);
  st.ask(controller, target, q);
}

// ---------------------------------------------------------------------------
// Scoring — based on the Panther's Plan and the trick result.
// ---------------------------------------------------------------------------
export type StoryOutcome = "large" | "medium" | "small" | "fail";

/** Classify the result into a scoring tier.
 *
 *  Fight  — combined Panther+Crow tricks:  9+→large, 8→medium, 7→small, <7→fail
 *  Run    — combined Panther+Crow tricks:  0-1→large, 2→medium, 3→small, >3→fail
 *  Vanish — Panther's own tricks only:     0→large, >0→fail
 *  Panic  — combined Panther+Crow tricks:  5→large, 4|6→medium, else→fail
 */
export function storyOutcome(
  pantherTricks: number, crowTricks: number, story: Story,
): StoryOutcome {
  const sum = pantherTricks + crowTricks;
  switch (story.plan) {
    case "Fight":
      if (sum >= 9) return "large";
      if (sum === 8) return "medium";
      if (sum === 7) return "small";
      return "fail";
    case "Run":
      if (sum <= 1) return "large";
      if (sum === 2) return "medium";
      if (sum === 3) return "small";
      return "fail";
    case "Vanish":
      return pantherTricks === 0 ? "large" : "fail";
    case "Panic":
      if (sum === 5) return "large";
      if (sum === 4 || sum === 6) return "medium";
      return "fail";
  }
}

/** Does the contract succeed (any non-fail outcome)? */
export function storyMakes(
  pantherTricks: number, crowTricks: number, story: Story,
): boolean {
  return storyOutcome(pantherTricks, crowTricks, story) !== "fail";
}

/** Point payouts: panther = points the Panther earns; hunters = points EACH Hunter earns.
 *
 *  Fight:  large→4p, medium→3p, small→2p, fail→1p each Hunter
 *  Run:    large→4p, medium→3p, small→2p, fail→2p each Hunter
 *  Vanish: large→4p,                      fail→1p each Hunter
 *  Panic:  large→4p, medium→3p,           fail→1p each Hunter
 */
export interface StoryPointResult { panther: number; hunters: number; }

export function storyPoints(
  pantherTricks: number, crowTricks: number, story: Story,
): StoryPointResult {
  const outcome = storyOutcome(pantherTricks, crowTricks, story);
  switch (story.plan) {
    case "Fight":
      if (outcome === "large")  return { panther: 4, hunters: 0 };
      if (outcome === "medium") return { panther: 3, hunters: 0 };
      if (outcome === "small")  return { panther: 2, hunters: 0 };
      return { panther: 0, hunters: 1 };
    case "Run":
      if (outcome === "large")  return { panther: 4, hunters: 0 };
      if (outcome === "medium") return { panther: 3, hunters: 0 };
      if (outcome === "small")  return { panther: 2, hunters: 0 };
      return { panther: 0, hunters: 2 };
    case "Vanish":
      return outcome !== "fail" ? { panther: 4, hunters: 0 } : { panther: 0, hunters: 1 };
    case "Panic":
      if (outcome === "large")  return { panther: 4, hunters: 0 };
      if (outcome === "medium") return { panther: 3, hunters: 0 };
      return { panther: 0, hunters: 1 };
  }
}

function score(
  st: State, panther: Player, story: Story, pantherSolo: number, crowWon: number,
): Record<Player, number> {
  const g: Record<Player, number> = Object.fromEntries(st.players.map((p) => [p, 0]));
  const { panther: pp, hunters: ph } = storyPoints(pantherSolo, crowWon, story);
  g[panther] = pp;
  for (const p of st.players) if (p !== panther) g[p] = ph;
  return g;
}

// ---------------------------------------------------------------------------
// Fast synchronous rollout for MC inner loops.
// Plays the remaining tricks randomly, without the async generator machinery.
// Does NOT emit events. Mutates `hands` in place — callers must pass copies.
// ---------------------------------------------------------------------------
export interface RolloutResult { pantherTricks: number; crowTricks: number; }

export function rolloutSync(
  hands:        Record<string, Card[]>,   // zone → remaining cards (MUTATED)
  seats:        [Player, string][],
  lead:         number,                   // seat index leading trick `trickNum`
  trickNum:     number,                   // first trick to play
  handSize:     number,                   // total tricks in hand
  partialPlays: [number, Card][],         // cards already played in trick `trickNum`
  partialLed:   string | null,
  forcedLead:   number | null,            // Cat-forced lead for next trick
  trump:        string | null,
  panther:      Player,
  rng:          Rng,
): RolloutResult {
  let pTricks = 0, cTricks = 0;
  const n = seats.length;
  for (let t = trickNum; t < handSize; t++) {
    const plays: [number, Card][] = t === trickNum ? [...partialPlays] : [];
    let led:    string | null = t === trickNum ? partialLed  : null;
    let forced: number | null = t === trickNum ? forcedLead  : null;
    const startOff = plays.length;
    for (let off = startOff; off < n; off++) {
      const si     = (lead + off) % n;
      const zname  = seats[si][1];
      const hand   = hands[zname];
      const legal  = mustFollow(hand, led);
      const card   = rng.choice(legal);
      rolloutRemove(hand, card);
      led = led ?? (card.get("suit") as string);
      plays.push([si, card]);
      const prank = card.get("prank") as string | null;
      if (prank !== null) {
        const f = rolloutPrank(prank, hands, seats, zname, rng);
        if (f !== null) forced = f;
      }
    }
    const wsi = trickWinner(plays, trump);
    if      (seats[wsi][1] === "crow")  cTricks++;
    else if (seats[wsi][0] === panther) pTricks++;
    lead = forced !== null ? forced : wsi;
  }
  return { pantherTricks: pTricks, crowTricks: cTricks };
}

function rolloutRemove(hand: Card[], card: Card): void {
  const i = hand.indexOf(card);
  if (i >= 0) { hand.splice(i, 1); return; }
  const s = card.get("suit") as string, r = card.get("rank") as number;
  const j = hand.findIndex(c => c.get("suit") === s && c.get("rank") === r);
  if (j >= 0) hand.splice(j, 1);
}

function rolloutPrank(
  name:  string,
  hands: Record<string, Card[]>,
  seats: [Player, string][],
  zname: string,
  rng:   Rng,
): number | null {
  if (name === "Cat") {
    return rng.int(seats.length);
  }
  if (name === "Devil") {
    const mine    = hands[zname];
    if (!mine.length) return null;
    const targets = seats.map(([, z]) => z).filter(z => z !== zname && (hands[z]?.length ?? 0) > 0);
    if (!targets.length) return null;
    const tgt  = rng.choice(targets);
    const them = hands[tgt];
    const give = rng.choice(mine);
    const take = rng.choice(them);
    rolloutRemove(mine, give);  them.push(give);
    rolloutRemove(them, take);  mine.push(take);
  }
  return null;
}

export async function playGame(
  players: Player[], rng: Rng, answerer: AnswererOrMap,
  cfg: PantherConfig = DEFAULT_CONFIG,
) {
  const scores: Record<Player, number> = Object.fromEntries(players.map((p) => [p, 0]));
  let dealer = players[0], hands = 0;
  while (Math.max(...Object.values(scores)) < cfg.targetScore && hands < 200) {
    const st = newState(players, rng);
    const gained = await run(playHand(st, dealer, cfg), answerer);
    for (const p of players) scores[p] += gained[p];
    dealer = players[(players.indexOf(dealer) + 1) % players.length];
    hands++;
  }
  return { scores, hands };
}

// --- run + scenario assertions when invoked directly ---
async function main() {
  const C = (suit: string, rank: number) => Card.of({ suit, rank, label: "x", prank: null });
  console.assert(trickWinner([[0, C("Spades", 14)], [1, C("Hearts", 5)], [2, C("Perils", 21)]], "Hearts") === 2, "perils beat trump");
  console.assert(trickWinner([[0, C("Spades", 14)], [1, C("Hearts", 5)]], "Hearts") === 1, "trump beats led");
  console.assert(trickWinner([[0, C("Spades", 7)], [1, C("Spades", 13)], [2, C("Clubs", 14)]], "Hearts") === 1, "highest led wins");
  console.assert(trickWinner([[0, C("Spades", 7)], [1, C("Hearts", 14)]], null) === 0, "perils-only: hearts off-suit");

  // Scoring assertions
  console.assert(storyPoints(7, 3, { plan: "Fight", ground: "Spades" }).panther === 4, "Fight large");
  console.assert(storyPoints(4, 4, { plan: "Fight", ground: "Spades" }).panther === 3, "Fight medium");
  console.assert(storyPoints(3, 4, { plan: "Fight", ground: "Spades" }).panther === 2, "Fight small");
  console.assert(storyPoints(2, 4, { plan: "Fight", ground: "Spades" }).hunters === 1, "Fight fail hunters");
  console.assert(storyPoints(0, 1, { plan: "Run", ground: null }).panther === 4, "Run large");
  console.assert(storyPoints(1, 1, { plan: "Run", ground: null }).panther === 3, "Run medium");
  console.assert(storyPoints(2, 1, { plan: "Run", ground: null }).panther === 2, "Run small");
  console.assert(storyPoints(2, 3, { plan: "Run", ground: null }).hunters === 2, "Run fail hunters=2");
  console.assert(storyPoints(0, 5, { plan: "Vanish", ground: "Clubs" }).panther === 4, "Vanish success");
  console.assert(storyPoints(1, 4, { plan: "Vanish", ground: "Clubs" }).hunters === 1, "Vanish fail");
  console.assert(storyPoints(2, 3, { plan: "Panic", ground: "Hearts" }).panther === 4, "Panic large (5)");
  console.assert(storyPoints(2, 4, { plan: "Panic", ground: "Hearts" }).panther === 3, "Panic medium (6)");
  console.assert(storyPoints(1, 2, { plan: "Panic", ground: "Hearts" }).hunters === 1, "Panic fail");

  console.log("scenario assertions: passed");

  const wins: Record<Player, number> = { A: 0, B: 0, C: 0 };
  for (let s = 0; s < 200; s++) {
    const rng = new Rng(s);
    const { scores } = await playGame(["A", "B", "C"], rng, new RandomAnswerer(rng));
    const w = (Object.keys(scores) as Player[]).reduce((a, b) => scores[a] >= scores[b] ? a : b);
    wins[w]++;
  }
  console.log("Panther v2, 200 games, wins:", wins);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
