/**
 * engine/core — the card-AGNOSTIC substrate.
 *
 * Three jobs: an authoritative EVENT LOG, PROJECTION to a player's view
 * (viewFor), and a DECISION LOOP (run) that drives a game generator, routing
 * each yielded effect to whoever answers it.
 *
 * A game is a generator that yields a decision request and is resumed with the
 * answer:
 *   function* game(): Generator<Effect, Result, Answer>
 * The three type params type the effect channel — it yields Effects, returns a
 * Result, and is resumed with Answers.
 */

export type Player = string;

// ---------------------------------------------------------------------------
// Seedable RNG (mulberry32). JS has no seedable Math.random; reproducibility
// has been load-bearing since the start, so the core supplies one.
// ---------------------------------------------------------------------------
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s |= 0; this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  choice<T>(arr: readonly T[]): T { return arr[this.int(arr.length)]; }
  shuffle<T>(arr: T[]): void {        // Fisher–Yates, in place
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}

// ---------------------------------------------------------------------------
// Events. seenBy === null means "everyone"; otherwise a set of players. null is
// used (not a sentinel string) so it can't collide with a player id and so the
// log serializes cleanly to a wire format later.
// ---------------------------------------------------------------------------
export type SeenBy = ReadonlySet<Player> | null;

export interface Event {
  type: string;
  payload: Record<string, any>;
  seenBy: SeenBy;
  seq: number;
}

export function visibleTo(ev: Event, player: Player): boolean {
  return ev.seenBy === null || ev.seenBy.has(player);
}

// ---------------------------------------------------------------------------
// GameState: players, rng, scratch vars, and the log. emit() APPENDS only —
// it never mutates derived state (the cards layer mutates-then-emits in one
// method, so log and state can't drift without the core knowing what state is).
// ---------------------------------------------------------------------------
export class GameState {
  readonly players: Player[];
  readonly rng: Rng;
  vars: Record<string, any> = {};
  log: Event[] = [];

  constructor(players: Player[], rng: Rng) {
    this.players = players;
    this.rng = rng;
  }

  emit(type: string, payload: Record<string, any>, seenBy: SeenBy = null): Event {
    const ev: Event = { type, payload, seenBy, seq: this.log.length };
    this.log.push(ev);
    return ev;
  }

  /** Pure projection: the events tagged visible to `player`. No redaction —
   *  each event already carries exactly the audience for its contents. */
  viewFor(player: Player): Event[] {
    return this.log.filter((ev) => visibleTo(ev, player));
  }
}

// ---------------------------------------------------------------------------
// Effects — a discriminated union: what a game yields when it needs an answer.
// ---------------------------------------------------------------------------
export interface Choice<T = any> {
  kind: "choice";
  player: Player;
  options: T[];
  key?: string;
  meta?: Record<string, any>;
}
export interface Commit<T = any> {
  kind: "commit";
  players: Player[];
  optionsFor: (p: Player) => T[];
  key?: string;
  meta?: Record<string, any>;
}
export type Effect = Choice | Commit;

// Reserved "player" id for decisions made by the RNG. A roll is just a uniform
// Choice addressed to this seat. WEIGHTED randomness is a game-layer concern:
// expand the outcome into a uniform pool (7 of A, 3 of B for 70/30) and map the
// pick back — the game holds that mapping, the engine stays uniform-only.
export const RNG: Player = "$rng";

export const choice = <T>(player: Player, options: T[], key = "", meta: Record<string, any> = {}): Choice<T> =>
  ({ kind: "choice", player, options, key, meta });
export const roll = <T>(options: T[], key = ""): Choice<T> =>
  ({ kind: "choice", player: RNG, options, key });
export const commit = <T>(players: Player[], optionsFor: (p: Player) => T[], key = "", meta: Record<string, any> = {}): Commit<T> =>
  ({ kind: "commit", players, optionsFor, key, meta });

// A game is a generator: yields Effects, is resumed with answers, returns a result.
export type Game<R> = Generator<Effect, R, any>;

// ---------------------------------------------------------------------------
// Answerers — pluggable "who decides" policies. `answer` may return a value OR
// a Promise: sync seats (random, scripted, local UI) return values and need no
// change; network and AI seats return Promises the driver awaits. This is the
// whole async surface — game logic stays synchronous.
// ---------------------------------------------------------------------------
export interface Answerer {
  answer(req: Effect): any | Promise<any>;
}

export class RandomAnswerer implements Answerer {
  constructor(private rng: Rng) {}
  answer(req: Choice): any {
    return this.rng.choice(req.options);
  }
}

export type AnswererOrMap = Answerer | Map<Player | null, Answerer>;

// ---------------------------------------------------------------------------
// The driver. Async so a Choice can be answered over a network or by a model;
// sync answerers resolve instantly (await of a non-Promise is a no-op tick).
// The game generator itself stays synchronous — only OBTAINING each answer is
// awaited, never the game's own stepping.
// ---------------------------------------------------------------------------
export async function run<R>(game: Game<R>, answerer: AnswererOrMap): Promise<R> {
  const answererFor = (player: Player | null): Answerer => {
    if (answerer instanceof Map) {
      // RNG decisions fall back to the null key (or any answerer) if unmapped.
      return answerer.get(player) ?? answerer.get(null) ?? [...answerer.values()][0];
    }
    return answerer;
  };

  const pick = async (req: Effect): Promise<any> => {
    if (req.kind === "commit") {
      // Simultaneous: gather all commits CONCURRENTLY against the same
      // pre-commit state. Nothing is revealed until the game emits after this
      // returns, so no answerer can peek at another's — and because results are
      // keyed by player (not collected in arrival order), concurrency cannot
      // affect the outcome. Sequential awaiting would serialize real network
      // seats and leak timing; Promise.all does not.
      const entries = await Promise.all(req.players.map(async (p) => {
        const sub = choice(p, req.optionsFor(p), req.key, req.meta);
        return [p, await answererFor(p).answer(sub)] as const;
      }));
      return Object.fromEntries(entries);
    }
    return await answererFor(req.player).answer(req);
  };

  let step = game.next();
  while (!step.done) step = game.next(await pick(step.value));
  return step.value;
}
