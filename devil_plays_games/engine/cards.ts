/**
 * engine/cards — the CARD layer on top of core.
 * Cards, zones with visibility, dealing, secrets, questions, and a State
 * subclass. A non-card game ignores this file.
 */
import {
  GameState, Rng, Player, Event, SeenBy,
} from "./core.js";

export * from "./core.js";   // single import surface for games

// ---------------------------------------------------------------------------
// Cards — immutable typed field bags. The layer never interprets fields.
// ---------------------------------------------------------------------------
export type Fields = Record<string, string | number | null>;

export class Card {
  readonly fields: Fields;
  constructor(fields: Fields) { this.fields = fields; }
  static of(fields: Fields): Card { return new Card(fields); }
  get(key: string): any {
    if (!(key in this.fields)) throw new Error(`no field ${key}`);
    return this.fields[key];
  }
  toString(): string { return Object.values(this.fields).join("·"); }
}

// ---------------------------------------------------------------------------
// Zones — piles of cards. Visibility fixed at declaration.
// ---------------------------------------------------------------------------
export enum Vis { HIDDEN = "hidden", OWNER = "owner", PUBLIC = "public" }

export class Zone {
  cards: Card[] = [];
  constructor(public name: string, public vis: Vis = Vis.HIDDEN,
              public owner: Player | null = null) {}
  add(c: Card) { this.cards.push(c); }
  remove(c: Card) {
    const i = this.cards.findIndex((x) => x === c || (x instanceof Card && cardEq(x, c)));
    if (i < 0) throw new Error(`card not in ${this.name}: ${c}`);
    this.cards.splice(i, 1);
  }
  get length() { return this.cards.length; }
  [Symbol.iterator]() { return this.cards[Symbol.iterator](); }
}

function cardEq(a: Card, b: Card): boolean {
  const ak = Object.keys(a.fields), bk = Object.keys(b.fields);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a.fields[k] === b.fields[k]);
}

// ---------------------------------------------------------------------------
// Secrets — hidden per-player facts whose audience changes over time.
// ---------------------------------------------------------------------------
export class Secret {
  observers: Set<Player>;
  public_ = false;
  constructor(public owner: Player, public value: any) {
    this.observers = new Set([owner]);
  }
  visibleTo(p: Player): boolean { return this.public_ || this.observers.has(p); }
}

// ---------------------------------------------------------------------------
// Questions — opaque predicate source produced by a separate DSL. Compiled
// here via `new Function` (the JS analog of Python exec). In production this
// is the ONE seam where a wasm module slots in: value-in / bool-out, no host
// interaction, exactly wasm's strength.
// ---------------------------------------------------------------------------
export const HAND_PUBLIC = "hand_public"; // (hand: Card[], pub: object) => boolean
export const PLAYER_VIEW = "player_view"; // (view: Event[]) => boolean

export class Question {
  private fn: Function | null = null;
  constructor(public text: string, public src: string,
              public kind: string = HAND_PUBLIC) {}
  render(): string { return this.text; }
  private compile(): Function {
    if (!this.fn) this.fn = new Function(`return (${this.src});`)() as Function;
    return this.fn!;
  }
  call(...args: any[]): boolean { return !!this.compile()(...args); }
}

// ---------------------------------------------------------------------------
// State — GameState + zones + secrets. The class card games instantiate.
// ---------------------------------------------------------------------------
export class State extends GameState {
  zones: Record<string, Zone> = {};
  secrets: Record<string, Secret> = {};

  zone(name: string, vis: Vis = Vis.HIDDEN, owner: Player | null = null): Zone {
    const z = new Zone(name, vis, owner);
    this.zones[name] = z;
    return z;
  }
  perPlayerZone(base: string, vis: Vis = Vis.OWNER): void {
    for (const p of this.players) this.zone(`${base}:${p}`, vis, p);
  }
  z(name: string): Zone { return this.zones[name]; }
  hand(player: Player): Zone { return this.zones[`hand:${player}`]; }

  // card movement: mutate AND emit in one method (no drift, no handler registry)
  deal(src: string, dst: string, n: number): void {
    const d = this.z(dst);
    const seen: SeenBy =
      d.vis === Vis.PUBLIC ? null
      : d.vis === Vis.OWNER ? new Set([d.owner!])
      : new Set<Player>();
    this.emit("DealCount", { src, dst, n });
    for (let i = 0; i < n; i++) {
      const card = this.z(src).cards.pop()!;
      d.add(card);
      this.emit("DealReveal", { src, dst, card }, seen);
    }
  }
  move(card: Card, src: string, dst: string, seenBy: SeenBy = null): void {
    this.z(src).remove(card);
    this.z(dst).add(card);
    this.emit("Move", { card, src, dst }, seenBy);
  }
  shuffle(name: string): void {
    this.rng.shuffle(this.z(name).cards);
    this.emit("Shuffle", { zone: name });
  }

  // secrets
  newSecret(sid: string, owner: Player, value: any): Secret {
    const s = new Secret(owner, value);
    this.secrets[sid] = s;
    this.emit("SecretSet", { id: sid, owner, value }, new Set([owner]));
    return s;
  }
  peekSecret(sid: string, viewer: Player): any {
    const s = this.secrets[sid];
    s.observers.add(viewer);
    this.emit("SecretPeek", { id: sid, viewer, value: s.value }, new Set([viewer]));
    return s.value;
  }
  flipSecret(sid: string): any {
    const s = this.secrets[sid];
    s.public_ = true;
    s.observers = new Set(this.players);
    this.emit("SecretFlip", { id: sid, owner: s.owner, value: s.value });
    return s.value;
  }

  // questions
  ask(asker: Player, target: Player, q: Question): boolean {
    let answer: boolean;
    if (q.kind === HAND_PUBLIC) answer = q.call(this.hand(target).cards, this.publicState());
    else if (q.kind === PLAYER_VIEW) answer = q.call(this.viewFor(target));
    else throw new Error(`unknown question kind: ${q.kind}`);
    this.emit("Asked", { asker, target, question: q.render(), answer });
    return answer;
  }
  publicState(): object {
    const zones: Record<string, Card[]> = {};
    for (const [n, z] of Object.entries(this.zones))
      if (z.vis === Vis.PUBLIC) zones[n] = [...z.cards];
    const secrets: Record<string, any> = {};
    for (const [sid, s] of Object.entries(this.secrets))
      if (s.public_) secrets[sid] = s.value;
    return { zones, secrets, vars: { ...this.vars } };
  }
}
