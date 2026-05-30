/**
 * players.ts — the four experiment players: R, M, O, S.
 *
 *   R  random              — uniform over legal moves, no search.
 *   M  realistic MC        — flat Monte Carlo over a determinization built ONLY
 *                            from viewFor (the player's projected event log).
 *                            Hidden hands are sampled, respecting known voids.
 *   O  omniscient MC       — flat Monte Carlo using the TRUE hidden hands.
 *   S  suicidal omniscient — like O, but picks the WORST move for its own side.
 *                            A floor: "this is the worst you could possibly do."
 *
 * Objective (bidding ignored): Panther trick count. Trick count is constant-sum
 * (every trick goes to exactly one seat, handSize tricks total), so a Hunter
 * maximizing its team's tricks is identical to minimizing Panther tricks. Each
 * player optimizes for its OWN side; S inverts that.
 *
 * M, O and S share one path: all three reconstruct the public skeleton (trick
 * state, seats, panther, trump, own hand, opponent hand sizes) from viewFor via
 * reconstructBelief, and M additionally derives voids from the same projected
 * log. They differ ONLY in how the hidden hands are filled:
 *   M  → sampled from the unknown pool, respecting voids
 *   O,S→ copied from the true state
 * M therefore cannot see hidden cards by construction, not merely by convention.
 *
 * Non-play decisions (bids, prank sub-choices) fall back to random for every
 * player: these agents study trick play.
 */
import { Answerer, Choice, Player, Rng, run } from "./core.js";
import { State, Card } from "./cards.js";
import {
  PantherConfig, calcHandSize, clockwise, playTricks, PlayTricksParams, Bid,
  deck as pantherDeck, buildSeats,
} from "./panther.js";
import {
  Belief, reconstructBelief, buildSimState,
} from "./mc_panther.js";
import type { Event } from "./core.js";

export type PlayerKind = "R" | "M" | "O" | "S";

function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

// ---------------------------------------------------------------------------
// Voids — suits a hidden zone has demonstrably run out of, inferred from the
// public play log. A zone is void in the led suit of a trick whenever it played
// a card of a different suit (couldn't follow). This covers Peril leads too:
// when a Peril is led the "led suit" is "Perils", so failing to play one marks
// a Perils void. Keyed by zone name ("hand:X" / "crow"), exactly as Played
// events record the seat.
// ---------------------------------------------------------------------------
function voidsByZone(log: Event[]): Record<string, Set<string>> {
  const voids: Record<string, Set<string>> = {};
  let led: string | null = null;
  for (const e of log) {
    if (e.type === "Played") {
      const suit = (e.payload.card as Card).get("suit") as string;
      if (led === null) {
        led = suit;
      } else if (suit !== led) {
        const seat = e.payload.seat as string;
        (voids[seat] ??= new Set()).add(led);
      }
    } else if (e.type === "TrickWon") {
      led = null;
    }
  }
  return voids;
}

// ---------------------------------------------------------------------------
// Unknown card pool from a belief: the full deck minus everything the player
// can locate (own hand, crow, cards already played, peeked woods).
// ---------------------------------------------------------------------------
function unknownPool(belief: Belief, cfg: PantherConfig): Card[] {
  const known = new Set<string>();
  for (const c of belief.myHand)              known.add(cardId(c));
  for (const c of belief.crow)                known.add(cardId(c));
  for (const c of belief.completedTrickCards) known.add(cardId(c));
  for (const c of belief.currentTrickCards)   known.add(cardId(c));
  if (belief.knownWoods) for (const c of belief.knownWoods) known.add(cardId(c));
  return pantherDeck(cfg).filter(c => !known.has(cardId(c)));
}

interface SampledWorld { opponentHands: Record<Player, Card[]>; woods: Card[]; }

// ---------------------------------------------------------------------------
// Sample hidden hands + woods from the unknown pool, never dealing a zone a
// suit it has shown void in. Most-constrained zones are filled first to reduce
// dead ends; a handful of reshuffled attempts almost always succeeds, and if
// they don't (pathologically tight constraints) we fall back to an unconstrained
// deal rather than loop forever.
// ---------------------------------------------------------------------------
function sampleWorldRealistic(
  belief: Belief, player: Player, allPlayers: Player[], cfg: PantherConfig,
  voids: Record<string, Set<string>>, rng: Rng,
): SampledWorld {
  const pool = unknownPool(belief, cfg);
  const zones = allPlayers
    .filter(p => p !== player)
    .map(p => ({
      player: p,
      size: Math.max(0, belief.opponentHandSizes[p] ?? 0),
      void: voids[`hand:${p}`] ?? new Set<string>(),
    }))
    .sort((a, b) => b.void.size - a.void.size); // most constrained first

  const knownWoods = belief.knownWoods ?? [];
  const woodsNeed = Math.max(0, cfg.woodsSize - knownWoods.length);

  const attempt = (respectVoids: boolean): SampledWorld | null => {
    const p = [...pool];
    rng.shuffle(p);
    const used = new Array(p.length).fill(false);
    const opponentHands: Record<Player, Card[]> = {};
    for (const z of zones) {
      const picked: Card[] = [];
      for (let i = 0; i < p.length && picked.length < z.size; i++) {
        if (used[i]) continue;
        if (respectVoids && z.void.has(p[i].get("suit"))) continue;
        used[i] = true;
        picked.push(p[i]);
      }
      if (picked.length < z.size) return null; // couldn't satisfy this zone
      opponentHands[z.player] = picked;
    }
    const leftover = p.filter((_, i) => !used[i]);
    return { opponentHands, woods: [...knownWoods, ...leftover.slice(0, woodsNeed)] };
  };

  for (let k = 0; k < 20; k++) {
    const w = attempt(true);
    if (w) return w;
  }
  return attempt(false)!; // fallback: ignore voids
}

// ---------------------------------------------------------------------------
// The MC player. One implementation covers M, O and S via two flags:
//   vision: "realistic" | "omniscient"
//   suicidal: boolean   (only meaningful with omniscient vision here)
// ---------------------------------------------------------------------------
class MCPlayer implements Answerer {
  constructor(
    private player:     Player,
    private st:         State,            // live state — read via viewFor; truth only when omniscient
    private allPlayers: Player[],
    private cfg:        PantherConfig,
    private rng:        Rng,
    private vision:     "realistic" | "omniscient",
    private suicidal:   boolean,
    private iters:      number,
  ) {}

  async answer(req: Choice): Promise<any> {
    if (req.options.length <= 1) return req.options[0];
    if (req.key !== "play") return this.rng.choice(req.options); // ignore bidding & pranks

    const log = this.st.viewFor(this.player);
    const belief = reconstructBelief(log, this.player, this.allPlayers, this.cfg);
    if (belief.panther === null || belief.bid === null) return this.rng.choice(req.options);

    const voids = this.vision === "realistic" ? voidsByZone(log) : {};
    const fromZone = (req.meta?.seat as string) ?? `hand:${this.player}`;
    const options = req.options as Card[];

    const scores = await Promise.all(
      options.map(c => this.evalCard(c, fromZone, belief, voids))
    );

    const panther = belief.panther;
    const wantMax = (this.player === panther) !== this.suicidal; // XOR
    const pick = wantMax ? Math.max(...scores) : Math.min(...scores);
    return options[scores.indexOf(pick)];
  }

  /** Average Panther trick count over `iters` random playouts after `card`. */
  private async evalCard(
    card: Card, fromZone: string, belief: Belief, voids: Record<string, Set<string>>,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < this.iters; i++) total += await this.playout(card, fromZone, belief, voids);
    return total / this.iters;
  }

  private async playout(
    card: Card, fromZone: string, belief: Belief, voids: Record<string, Set<string>>,
  ): Promise<number> {
    const panther = belief.panther!;
    const bid = belief.bid!;
    const simRng = new Rng(this.rng.int(2 ** 30));

    // Fill hidden hands: sampled (realistic) or copied from truth (omniscient).
    const world: SampledWorld =
      this.vision === "omniscient" ? this.trueWorld() :
      sampleWorldRealistic(belief, this.player, this.allPlayers, this.cfg, voids, simRng);

    const simSt = buildSimState(belief, world, this.player, this.allPlayers, this.cfg, simRng);
    simSt.vars.trump = bid.perilsOnly ? null : bid.trump;

    const seats = buildSeats(this.allPlayers, panther);
    simSt.vars.seats = seats;
    simSt.vars.panther = panther;

    // Inject `card` as the player's pending play in the current trick.
    const authorSi = seats.findIndex(([, z]) => z === fromZone);
    const zc = simSt.z(fromZone).cards;
    const ri = zc.findIndex(c => cardId(c) === cardId(card));
    if (ri >= 0) zc.splice(ri, 1);

    const params: PlayTricksParams = {
      seats,
      lead:               belief.lead,
      handSize:           calcHandSize(this.cfg),
      panther,
      bid,
      trickNum:           belief.trickNumber,
      partialPlays:       [...belief.partialPlays, [authorSi, card]],
      partialLed:         belief.partialLed ?? (card.get("suit") as string),
      forcedFromPartials: belief.forcedFromPartials,
      won:                { ...belief.won },
      crowWon:            belief.crowWon,
    };

    const rollRng = new Rng(this.rng.int(2 ** 30));
    const randomAns: Answerer = { answer: (r: Choice) => rollRng.choice(r.options) };
    await run(playTricks(simSt, params, this.cfg), randomAns);

    const completed = (belief.won[panther] ?? 0) + belief.crowWon;
    const simulated = simSt.log.filter(e =>
      e.type === "TrickWon" &&
      (e.payload.seat === `hand:${panther}` || e.payload.seat === "crow")
    ).length;
    return completed + simulated;
  }

  /** The true hidden world, read straight from live state (omniscient only). */
  private trueWorld(): SampledWorld {
    const opponentHands: Record<Player, Card[]> = {};
    for (const p of this.allPlayers)
      if (p !== this.player) opponentHands[p] = [...this.st.z(`hand:${p}`).cards];
    return { opponentHands, woods: [...this.st.z("woods").cards] };
  }
}

// ---------------------------------------------------------------------------
// Random player.
// ---------------------------------------------------------------------------
class RandomPlayer implements Answerer {
  constructor(private rng: Rng) {}
  answer(req: Choice): any { return this.rng.choice(req.options); }
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------
export function makePlayer(
  kind: PlayerKind,
  player: Player,
  st: State,
  allPlayers: Player[],
  cfg: PantherConfig,
  rng: Rng,
  iters = 50,
): Answerer {
  switch (kind) {
    case "R": return new RandomPlayer(rng);
    case "M": return new MCPlayer(player, st, allPlayers, cfg, rng, "realistic",  false, iters);
    case "O": return new MCPlayer(player, st, allPlayers, cfg, rng, "omniscient", false, iters);
    case "S": return new MCPlayer(player, st, allPlayers, cfg, rng, "omniscient", true,  iters);
  }
}
