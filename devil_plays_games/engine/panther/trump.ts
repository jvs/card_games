/**
 * trump.ts — trump-setting policies and per-suit hand evaluation.
 *
 * Shared by the matchup runner (to set each hand's trump) and the trump-choice
 * experiment (to measure how much choosing trump is worth). Trump-choice
 * rollouts are always RANDOM here — we isolate the structural value of the
 * choice and keep it cheap; seat skill is a separate axis owned by the caller.
 */
import { Rng, Player, run, Answerer, Choice } from "../core.js";
import { State } from "../cards.js";
import {
  PantherConfig, calcHandSize, deck, newState, playTricks, Story,
  firstLeadSeat, buildSeats,
} from "./panther.js";

export interface TrumpChoice { trump: string | null; perilsOnly: boolean; }

const SUITS = ["Spades", "Diamonds", "Hearts", "Clubs"];

export function trumpLabel(c: TrumpChoice): string {
  return c.perilsOnly ? "PerilsOnly" : c.trump!;
}

/** The trumps the Panther could declare. Perils-Only is included only when
 *  explicitly allowed — it changes the structure (no lesser trump), so we keep
 *  it opt-in rather than forcing it on every hand. */
export function trumpCandidates(allowPerilsOnly: boolean): TrumpChoice[] {
  const suits = SUITS.map(s => ({ trump: s, perilsOnly: false }));
  return allowPerilsOnly ? [...suits, { trump: null, perilsOnly: true }] : suits;
}

/** Deal a fresh, reproducible hand (cards only — no trump, no declaration).
 *  Re-dealing with the same dealSeed reproduces identical cards, so callers can
 *  evaluate several trumps on "the same hand". */
export function dealHand(
  cfg: PantherConfig, players: Player[], dealer: Player, panther: Player, dealSeed: number,
): { st: State; seats: [Player, string][] } {
  const hs = calcHandSize(cfg);
  const st = newState(players, new Rng(dealSeed));
  st.z("deck").cards = deck(cfg);
  st.shuffle("deck");
  for (const p of players) st.deal("deck", `hand:${p}`, hs);
  st.deal("deck", "crow", hs);
  st.deal("deck", "woods", cfg.woodsSize);

  const seats = buildSeats(players, panther);
  st.vars.seats = seats;
  st.vars.panther = panther;
  return { st, seats };
}

function countPanther(st: State, panther: Player): number {
  return st.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${panther}` || e.payload.seat === "crow")
  ).length;
}

/** One all-random playout of a specific deal under a specific trump; returns
 *  Panther-side tricks. Cards are fixed by dealSeed; only play varies by playSeed. */
export async function playRandomHand(
  cfg: PantherConfig, players: Player[], dealer: Player, panther: Player,
  dealSeed: number, choice: TrumpChoice, playSeed: number,
): Promise<number> {
  const hs = calcHandSize(cfg);
  const { st, seats } = dealHand(cfg, players, dealer, panther, dealSeed);
  st.vars.trump = choice.perilsOnly ? null : choice.trump;
  // Use Fight as the dummy plan — trump.ts analyses trick counts, not points.
  const story: Story = { plan: "Fight", ground: choice.perilsOnly ? null : choice.trump };
  const rng = new Rng(playSeed);
  const ans: Answerer = { answer: (r: Choice) => rng.choice(r.options) };

  await run(playTricks(st, {
    seats,
    lead:               firstLeadSeat(seats, panther, players, cfg),
    handSize:           hs,
    panther,
    story,
    trickNum:           0,
    partialPlays:       [],
    partialLed:         null,
    forcedFromPartials: null,
    won:                Object.fromEntries(players.map(p => [p, 0])),
    crowWon:            0,
  }, cfg), ans);

  return countPanther(st, panther);
}

/** Expected Panther tricks for one trump on one deal, over `n` random playouts. */
export async function evalTrump(
  cfg: PantherConfig, players: Player[], dealer: Player, panther: Player,
  dealSeed: number, choice: TrumpChoice, n: number, playSeedBase: number,
): Promise<number> {
  let s = 0;
  for (let i = 0; i < n; i++)
    s += await playRandomHand(cfg, players, dealer, panther, dealSeed, choice, playSeedBase + i);
  return s / n;
}

export type TrumpPolicy = string; // "fixed:Spades" | "random" | "oracle"

/** Pick a trump for a deal per policy. "oracle" picks the suit with the highest
 *  expected Panther tricks (argmax over `iters` random rollouts, full-deal info). */
export async function chooseTrump(
  policy: TrumpPolicy, cfg: PantherConfig, players: Player[], dealer: Player,
  panther: Player, dealSeed: number, allowPerilsOnly: boolean, iters: number, seed: number,
): Promise<TrumpChoice> {
  if (policy.startsWith("fixed:"))
    return { trump: policy.slice("fixed:".length), perilsOnly: false };

  const cands = trumpCandidates(allowPerilsOnly);
  if (policy === "random") return new Rng(seed).choice(cands);

  if (policy === "oracle") {
    let best = cands[0], bestEV = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      const ev = await evalTrump(cfg, players, dealer, panther, dealSeed, cands[i], iters, seed + i * 100003);
      if (ev > bestEV) { bestEV = ev; best = cands[i]; }
    }
    return best;
  }
  throw new Error(`unknown trump policy: ${policy}`);
}
