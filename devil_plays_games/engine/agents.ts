/**
 * agents.ts — Four general-purpose game agents for Panther analysis.
 *
 * Agent modes:
 *   random     — all decisions uniformly random (no evaluation)
 *   fair       — flat Monte Carlo with only information a real player has;
 *                opponent hands are sampled from the unknown card pool
 *                (determinization)
 *   omniscient — flat Monte Carlo with perfect knowledge of all cards;
 *                uses actual hidden hands directly, no sampling needed
 *   suicidal   — identical to fair but plays against its own interest;
 *                a Panther suicidal agent throws tricks away;
 *                a Hunter suicidal agent helps the Panther win
 *
 * Optimization goal is role-aware:
 *   Panther (fair/omniscient) → maximise Panther tricks
 *   Hunter  (fair/omniscient) → minimise Panther tricks
 *   Either  (suicidal)        → the opposite of the above
 *
 * All agents implement Answerer. Non-play decisions (bidding, prank
 * sub-choices) always fall back to random — these agents study trick play.
 *
 * "Flat Monte Carlo" means: for each legal move, simulate the rest of the
 * hand N times with random play for everyone, and take the average Panther
 * trick count as the move's score. This is distinct from MCTS (which builds
 * an explicit tree with UCB exploration). Flat MC + determinization is the
 * standard approach for trick-taking games because must-follow rules already
 * constrain choices heavily, keeping branching factors small.
 */
import { Player, Rng, run }     from "./core.js";
import { Answerer, Choice }      from "./core.js";
import { State, Card }           from "./cards.js";
import {
  PantherConfig, calcHandSize, deck,
  newState, playTricks, Bid, PlayTricksParams, firstLeadSeat,
} from "./panther.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export type AgentMode = "random" | "fair" | "omniscient" | "suicidal";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

/**
 * Cards whose location is unknown to `player` at this point in the game.
 * Known: own hand, Crow (public), discard (public), cards already played
 * in the current unresolved trick (removed from zones but not yet in discard).
 */
function unknownPool(simSt: State, player: Player, cfg: PantherConfig): Card[] {
  const known = new Set<string>();
  for (const c of simSt.z(`hand:${player}`).cards) known.add(cardId(c));
  for (const c of simSt.z("crow").cards)            known.add(cardId(c));
  for (const c of simSt.z("discard").cards)         known.add(cardId(c));

  // Cards played this trick are gone from zones but not yet in discard
  const log = simSt.log;
  let lastWon = -1;
  for (let i = log.length - 1; i >= 0; i--)
    if (log[i].type === "TrickWon") { lastWon = i; break; }
  for (const e of log.slice(lastWon + 1))
    if (e.type === "Played") known.add(cardId(e.payload.card as Card));

  return deck(cfg).filter(c => !known.has(cardId(c)));
}

/**
 * Build PlayTricksParams for a continuation that starts with `candidate`
 * as the agent's current move.  Reads completed-trick history and the
 * current partial-trick state from `simSt.log`.
 */
function buildContinuationParams(
  simSt:     State,
  candidate: Card,
  mySeat:    string,
  allPlayers: Player[],
  cfg:       PantherConfig,
): PlayTricksParams {
  const panther = simSt.vars.panther as Player;
  const seats   = simSt.vars.seats   as [Player, string][];
  const trump   = simSt.vars.trump   as string | null;
  const hs      = calcHandSize(cfg);
  const log     = simSt.log;

  // ── Completed tricks ───────────────────────────────────────────────────
  const wonEvents = log.filter(e => e.type === "TrickWon");
  const trickNum  = wonEvents.length;

  // Lead for the current trick: winner of the last completed trick,
  // overridden by any CatLead event inside that trick.
  let lead = firstLeadSeat(seats, panther, allPlayers, cfg);
  for (let i = 0; i < wonEvents.length; i++) {
    const e  = wonEvents[i];
    const wi = seats.findIndex(([, z]) => z === e.payload.seat);
    if (wi >= 0) lead = wi;
    const prevSeq = i > 0 ? wonEvents[i - 1].seq : -1;
    const cat = log.find(
      e2 => e2.type === "CatLead" && e2.seq > prevSeq && e2.seq < e.seq
    );
    if (cat) lead = cat.payload.seat as number;
  }

  // ── Current (incomplete) trick ─────────────────────────────────────────
  const lastWonSeq = wonEvents.length > 0
    ? wonEvents[wonEvents.length - 1].seq : -1;

  const priorPlays: [number, Card][] = log
    .filter(e => e.type === "Played" && e.seq > lastWonSeq)
    .map(e => [
      seats.findIndex(([, z]) => z === (e.payload.seat as string)),
      e.payload.card as Card,
    ] as [number, Card])
    .filter(([i]) => i >= 0);

  const mySeatIdx    = seats.findIndex(([, z]) => z === mySeat);
  const partialPlays = [...priorPlays, [mySeatIdx, candidate]] as [number, Card][];
  const partialLed   = priorPlays.length > 0
    ? priorPlays[0][1].get("suit") : candidate.get("suit");

  // CatLead in the current partial trick forces next-trick lead
  let forcedFromPartials: number | null = null;
  for (const e of log)
    if (e.type === "CatLead" && e.seq > lastWonSeq)
      forcedFromPartials = e.payload.seat as number;

  // ── Accumulated trick counts ────────────────────────────────────────────
  const won: Record<Player, number> =
    Object.fromEntries(allPlayers.map(p => [p, 0]));
  let crowWon = 0;
  for (const e of wonEvents) {
    if (e.payload.seat === "crow") crowWon++;
    else won[e.payload.winner as Player] = (won[e.payload.winner as Player] ?? 0) + 1;
  }

  const bid: Bid = { tricks: 1, trump, perilsOnly: trump === null };
  return {
    seats, lead, handSize: hs, panther, bid,
    trickNum, partialPlays, partialLed, forcedFromPartials, won, crowWon,
  };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------
export class Agent implements Answerer {
  constructor(
    public  readonly mode:    AgentMode,
    private readonly player:  Player,
    private readonly simSt:   State,
    private readonly players: Player[],
    private readonly cfg:     PantherConfig,
    private readonly rng:     Rng,
    private readonly iters:   number = 50,
  ) {}

  async answer(req: Choice): Promise<any> {
    // Only intercept play decisions with a genuine choice; everything else random.
    if (this.mode === "random" || req.key !== "play" || req.options.length <= 1)
      return this.rng.choice(req.options);

    const options = req.options as Card[];
    const scores  = await Promise.all(options.map(c => this.evalCard(c, req)));

    // Panther wants more tricks; Hunters want fewer Panther tricks.
    // Suicidal inverts the player's natural goal.
    const isPanther = this.player === (this.simSt.vars.panther as Player);
    const maximize  = isPanther !== (this.mode === "suicidal");  // XOR
    return maximize
      ? options[scores.indexOf(Math.max(...scores))]
      : options[scores.indexOf(Math.min(...scores))];
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  private async evalCard(card: Card, req: Choice): Promise<number> {
    let total = 0;
    for (let i = 0; i < this.iters; i++) total += await this.simulate(card, req);
    return total / this.iters;
  }

  private async simulate(card: Card, req: Choice): Promise<number> {
    const mySeat  = (req.meta?.seat as string) ?? `hand:${this.player}`;
    const panther = this.simSt.vars.panther as Player;
    const simRng  = new Rng(this.rng.int(2 ** 30));

    // Build a fresh continuation state with sampled or actual hands
    const simSt = this.buildSimState(simRng);
    simSt.vars.trump   = this.simSt.vars.trump;
    simSt.vars.seats   = this.simSt.vars.seats;
    simSt.vars.panther = this.simSt.vars.panther;

    // Remove the candidate card from its zone — it's about to be "played"
    const cid  = cardId(card);
    const zone = simSt.z(mySeat).cards;
    const ri   = zone.findIndex(c => cardId(c) === cid);
    if (ri >= 0) zone.splice(ri, 1);

    // Reconstruct partial-trick context and run out the hand
    const params   = buildContinuationParams(this.simSt, card, mySeat, this.players, this.cfg);
    const randomAns: Answerer = { answer: (r: Choice) => simRng.choice(r.options) };
    await run(playTricks(simSt, params, this.cfg), randomAns);

    // Total Panther tricks = already-completed + just-simulated
    const completedPanther = (params.won[panther] ?? 0) + params.crowWon;
    const simulatedTricks  = simSt.log.filter(e =>
      e.type === "TrickWon" &&
      (e.payload.seat === `hand:${panther}` || e.payload.seat === "crow")
    ).length;
    return completedPanther + simulatedTricks;
  }

  // ── State construction ────────────────────────────────────────────────────

  /**
   * Clone the live state for a simulation run.
   * fair / suicidal: opponent hands are re-sampled from the unknown pool.
   * omniscient:      opponent hands are copied from the actual state.
   */
  private buildSimState(rng: Rng): State {
    const simSt = newState(this.players, rng);
    simSt.z("crow").cards    = [...this.simSt.z("crow").cards];
    simSt.z("discard").cards = [...this.simSt.z("discard").cards];

    if (this.mode === "omniscient") {
      for (const p of this.players)
        simSt.z(`hand:${p}`).cards = [...this.simSt.z(`hand:${p}`).cards];
      simSt.z("woods").cards = [...this.simSt.z("woods").cards];
    } else {
      // Own hand is known exactly
      simSt.z(`hand:${this.player}`).cards =
        [...this.simSt.z(`hand:${this.player}`).cards];

      // Sample the rest from the unknown pool
      const pool = unknownPool(this.simSt, this.player, this.cfg);
      rng.shuffle(pool);
      let offset = 0;
      for (const p of this.players) {
        if (p === this.player) continue;
        // Hand size is public information (how many cards each player holds)
        const size = this.simSt.z(`hand:${p}`).cards.length;
        simSt.z(`hand:${p}`).cards = pool.slice(offset, offset + size);
        offset += size;
      }
      // Remaining pool cards are the (unknown) woods
      simSt.z("woods").cards = pool.slice(offset, offset + this.cfg.woodsSize);
    }
    return simSt;
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------
export function makeAgent(
  mode:    AgentMode,
  player:  Player,
  simSt:   State,
  players: Player[],
  cfg:     PantherConfig,
  rng:     Rng,
  iters  = 50,
): Agent {
  return new Agent(mode, player, simSt, players, cfg, rng, iters);
}
