/**
 * panther.ts — Panther, a 3-player trick-taker, implemented on the substrate.
 * The reference game: a worked example of the effect/generator pattern, the
 * zone/visibility model, secrets, and the Question seam.
 */
import {
  State, Card, Vis, Rng, Player, Question, HAND_PUBLIC,
  choice, run, RandomAnswerer, AnswererOrMap, Game,
} from "./cards.js";

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

function deck(): Card[] {
  const cs: Card[] = [];
  for (const s of SUITS)
    for (const [lbl, v] of TRAD)
      cs.push(Card.of({ suit: s, rank: v, label: lbl === "Prank" ? PRANK[s] : lbl,
                        prank: lbl === "Prank" ? PRANK[s] : null }));
  for (const [lbl, v] of PERILS)
    cs.push(Card.of({ suit: "Perils", rank: v, label: lbl, prank: null }));
  return cs;
}

// --- trick comparison (pure; PRNG-independent — the real regression anchor) ---
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

interface Bid { tricks: number; trump: string | null; perilsOnly: boolean; }

function newState(players: Player[], rng: Rng): State {
  const st = new State(players, rng);
  st.zone("deck", Vis.HIDDEN);
  st.zone("crow", Vis.PUBLIC);
  st.zone("woods", Vis.HIDDEN);
  st.zone("discard", Vis.PUBLIC);
  st.perPlayerZone("hand", Vis.OWNER);
  return st;
}
const clockwise = (ps: Player[], start: Player) => {
  const i = ps.indexOf(start);
  return [...ps.slice(i), ...ps.slice(0, i)];
};

function* playHand(st: State, dealer: Player): Game<Record<Player, number>> {
  const order = clockwise(st.players, dealer);
  st.z("deck").cards = deck();
  st.shuffle("deck");
  for (const p of st.players) st.deal("deck", `hand:${p}`, 10);
  st.deal("deck", "crow", 10);
  st.deal("deck", "woods", 5);

  const [panther, bid] = yield* auction(st, dealer);
  st.vars.panther = panther;
  st.vars.trump = bid.perilsOnly ? null : bid.trump;

  const seats: [Player, string][] = [];
  for (const p of order) {
    seats.push([p, `hand:${p}`]);
    if (p === panther) seats.push([panther, "crow"]);
  }
  st.vars.seats = seats;

  const won: Record<Player, number> = Object.fromEntries(st.players.map((p) => [p, 0]));
  let crowWon = 0;
  let lead = seats.findIndex(([, z]) => z === `hand:${panther}`);

  for (let t = 0; t < 10; t++) {
    const plays: [number, Card][] = [];
    let led: string | null = null;
    let forced: number | null = null;
    const rotation = [...seats.slice(lead), ...seats.slice(0, lead)];
    for (let off = 0; off < rotation.length; off++) {
      const [controller, zname] = rotation[off];
      const si = (lead + off) % seats.length;
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
    const wseat = seats[wsi];
    for (const [, c] of plays) st.z("discard").add(c);
    st.emit("TrickWon", { seat: wseat[1], winner: wseat[0], trick: t });
    if (wseat[1] === "crow") crowWon++; else won[wseat[0]]++;
    lead = forced !== null ? forced : wsi;
  }
  return score(st, panther, bid, won[panther] + crowWon);
}

function* auction(st: State, dealer: Player): Game<[Player, Bid]> {
  const order = [...clockwise(st.players, dealer).slice(1), dealer];
  let high: Bid | null = null, highBidder: Player | null = null;
  const passed = new Set<Player>();
  let i = 0;
  while (order.length - passed.size > 1) {
    const p = order[i % order.length]; i++;
    if (passed.has(p)) continue;
    const floor = high ? high.tricks + 1 : 1;
    const first = high === null && p === order[0];
    const opts = bidOptions(floor, first);
    const c: Bid | "pass" = yield choice(p, opts, "bid", { high });
    if (c === "pass") { st.emit("Pass", { player: p }); passed.add(p); }
    else { st.emit("Bid", { player: p, ...c }); high = c; highBidder = p; }
  }
  return [highBidder ?? order[0], high!];
}
function bidOptions(floor: number, first: boolean): (Bid | "pass")[] {
  const opts: (Bid | "pass")[] = first ? [] : ["pass"];
  for (let t = floor; t <= 10; t++) {
    for (const s of SUITS) opts.push({ tricks: t, trump: s, perilsOnly: false });
    opts.push({ tricks: t, trump: null, perilsOnly: true });
  }
  return opts;
}

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
  return yield choice(controller, seats.map((_, i) => i), "cat_leader");
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

function score(st: State, panther: Player, bid: Bid, total: number): Record<Player, number> {
  const g: Record<Player, number> = Object.fromEntries(st.players.map((p) => [p, 0]));
  const mult = bid.perilsOnly ? 2 : 1;
  if (total >= bid.tricks) g[panther] = bid.tricks * 10 * mult;
  else for (const p of st.players) if (p !== panther) g[p] = bid.tricks * 5 * mult;
  return g;
}

export async function playGame(players: Player[], rng: Rng, answerer: AnswererOrMap, target = 250) {
  const scores: Record<Player, number> = Object.fromEntries(players.map((p) => [p, 0]));
  let dealer = players[0], hands = 0;
  while (Math.max(...Object.values(scores)) < target && hands < 200) {
    const st = newState(players, rng);
    const gained = await run(playHand(st, dealer), answerer);
    for (const p of players) scores[p] += gained[p];
    dealer = players[(players.indexOf(dealer) + 1) % players.length];
    hands++;
  }
  return { scores, hands };
}

// --- run + scenario assertions when invoked directly ---
async function main() {
  const C = (suit: string, rank: number) => Card.of({ suit, rank, label: "x", prank: null });
  // deterministic, PRNG-independent: the trick-comparison contract
  console.assert(trickWinner([[0, C("Spades", 14)], [1, C("Hearts", 5)], [2, C("Perils", 21)]], "Hearts") === 2, "perils beat trump");
  console.assert(trickWinner([[0, C("Spades", 14)], [1, C("Hearts", 5)]], "Hearts") === 1, "trump beats led");
  console.assert(trickWinner([[0, C("Spades", 7)], [1, C("Spades", 13)], [2, C("Clubs", 14)]], "Hearts") === 1, "highest led wins");
  console.assert(trickWinner([[0, C("Spades", 7)], [1, C("Hearts", 14)]], null) === 0, "perils-only: hearts off-suit");
  console.log("scenario assertions: passed");

  const wins: Record<Player, number> = { A: 0, B: 0, C: 0 };
  for (let s = 0; s < 200; s++) {
    const rng = new Rng(s);
    const { scores } = await playGame(["A", "B", "C"], rng, new RandomAnswerer(rng));
    const w = (Object.keys(scores) as Player[]).reduce((a, b) => scores[a] >= scores[b] ? a : b);
    wins[w]++;
  }
  console.log("TS Panther, 200 games, wins:", wins);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
