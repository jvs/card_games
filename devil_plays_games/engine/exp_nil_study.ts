/**
 * exp_nil_study.ts — how hard is Panther Defends (nil) to break as Hunter
 * skill increases?
 *
 * Setup (fixed across all conditions):
 *   - Story = Panther Defends on every deal; no auction.
 *   - Panther selects best trump from {Sp, Di, He, Cl, PerilsOnly} via
 *     omniscient random rollouts (SEL_ITER rollouts each), then plays with
 *     realistic flat MC (PANTHER_ITER rollouts/option).
 *   - Same N deal seeds used for every Hunter condition for a controlled
 *     comparison: Panther plays identically; only Hunter strategy varies.
 *   - Pranks active.
 *
 * Hunter conditions:
 *   1. Random          — uniform random legal play.
 *   2. Realistic-30    — realistic flat MC, 30 rollouts/option.
 *                        Each Hunter samples the unknown pool independently.
 *   3. Realistic-200   — same, 200 rollouts/option (depth vs noise).
 *   4. Omniscient-30   — both Hunters read Panther's TRUE hand (no sampling);
 *                        30 rollouts/option. Automatic coordination via shared
 *                        perfect information — the joint-plan upper bound.
 *
 * Metric: P(Panther takes 0 tricks from hand:Panther), with binomial SE.
 *
 * Env vars:
 *   N=5000           deals per condition
 *   SEL_ITER=30      rollouts per trump option for Panther's trump selection
 *   PANTHER_ITER=30  rollouts/option for Panther's play
 *
 * Run:  tsx exp_nil_study.ts
 *       N=300 tsx exp_nil_study.ts   # quick smoke test
 */
import { Rng, Player, run, Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid,
  firstLeadSeat, buildSeats, deck, newState,
  StoryOutcome, storyPoints, rolloutSync, deck as pantherDeck,
} from "./panther.js";
import { reconstructBelief, Belief } from "./mc_panther.js";
import { State, Card } from "./cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player   = "A";
const DEALER:  Player   = "C";
const STORY                = "PantherDefends" as const;

function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

const TRUMP_OPTIONS: { trump: string | null; label: string }[] = [
  { trump: "Spades",   label: "Spades"     },
  { trump: "Diamonds", label: "Diamonds"   },
  { trump: "Hearts",   label: "Hearts"     },
  { trump: "Clubs",    label: "Clubs"      },
  { trump: null,       label: "PerilsOnly" },
];

// ---------------------------------------------------------------------------
// Deal cards
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
// Panther trump selection: omniscient random rollouts over all 5 options.
// ---------------------------------------------------------------------------
function selectTrump(st: State, cfg: PantherConfig, rng: Rng, n: number): string | null {
  const hs    = calcHandSize(cfg);
  const seats = buildSeats(PLAYERS, PANTHER);
  const lead  = firstLeadSeat(seats, PANTHER, PLAYERS, cfg);
  let best: string | null = null;
  let bestEV = -Infinity;
  for (const { trump } of TRUMP_OPTIONS) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const hands: Record<string, Card[]> = {};
      for (const [, z] of seats) hands[z] = [...st.z(z).cards];
      const { pantherTricks } = rolloutSync(
        hands, seats, lead, 0, hs, [], null, null, trump, PANTHER, rng);
      total += storyPoints(pantherTricks, 0, STORY).panther;
    }
    const ev = total / n;
    if (ev > bestEV) { bestEV = ev; best = trump; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// MC answerer — used for BOTH Panther and Hunters.
//   vision="realistic" → sample opponent hands from unknown pool
//   vision="omniscient" → read true hands from live State
// ---------------------------------------------------------------------------
class NilAnswerer implements Answerer {
  private readonly deck: Card[];
  constructor(
    private player:   Player,
    private st:       State,
    private cfg:      PantherConfig,
    private rng:      Rng,
    private iters:    number,
    private vision:   "realistic" | "omniscient",
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
    const wantMax = this.player === panther;   // Panther maximizes, Hunters minimize
    const best    = wantMax ? Math.max(...scores) : Math.min(...scores);
    return options[scores.indexOf(best)];
  }

  private evalCard(card: Card, fromZone: string, belief: Belief,
      trump: string | null, seats: [Player, string][], panther: Player): number {
    const hs       = calcHandSize(this.cfg);
    const authorSi = seats.findIndex(([, z]) => z === fromZone);
    const extPlays: [number, Card][] = [...belief.partialPlays, [authorSi, card]];
    const extLed   = belief.partialLed ?? (card.get("suit") as string);
    const cid      = cardId(card);

    // Build opponent-slot list for realistic vision
    const opSlots = PLAYERS
      .filter(p => p !== this.player)
      .map(p => ({ zname: `hand:${p}` as string,
                   size: Math.max(0, belief.opponentHandSizes[p] ?? 0) }));
    const pool = this.vision === "realistic" ? this.unknownPool(belief) : null;

    let total = 0;
    for (let i = 0; i < this.iters; i++) {
      const hands: Record<string, Card[]> = {};

      if (this.vision === "omniscient") {
        // Read true hands directly — both Hunters see the same Panther hand.
        for (const [, z] of seats) hands[z] = [...this.st.z(z).cards];
      } else {
        // Realistic: sample opponent hands from unknown pool.
        const p = [...pool!]; this.rng.shuffle(p);
        let off = 0;
        for (const { zname, size } of opSlots) {
          hands[zname] = p.slice(off, off + size); off += size;
        }
        hands[`hand:${this.player}`] = [...belief.myHand];
        hands["crow"]                = [...belief.crow];
      }

      const h   = hands[fromZone];
      const idx = h.findIndex(c => cardId(c) === cid);
      if (idx >= 0) h.splice(idx, 1);

      const { pantherTricks, crowTricks } = rolloutSync(
        hands, seats, belief.lead, belief.trickNumber, hs,
        extPlays, extLed, belief.forcedFromPartials, trump, panther, this.rng);

      const totalP = (belief.won[panther] ?? 0) + pantherTricks;
      const totalC = belief.crowWon + crowTricks;
      total += storyPoints(totalP, totalC, STORY).panther;
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
// Run one condition over N deals.
// ---------------------------------------------------------------------------
type HunterKind = "random" | "realistic" | "omniscient";

async function runCondition(
  name: string,
  hunterKind: HunterKind,
  hunterIters: number,
  N: number,
  selIters: number,
  pantherIters: number,
  cfg: PantherConfig,
  progressEvery: number,
): Promise<{ name: string; makes: number; n: number }> {
  const hs = calcHandSize(cfg);
  let makes = 0;

  for (let d = 0; d < N; d++) {
    if (d > 0 && d % progressEvery === 0)
      process.stdout.write(`  [${name}] ${d}/${N}…\n`);

    const seed = d + 1;

    // Deal (same cards for every condition via deterministic seed).
    const st   = dealCards(cfg, seed);
    const trump = selectTrump(st, cfg, new Rng(seed * 9973 + 1), selIters);

    st.vars.trump   = trump;
    st.vars.panther = PANTHER;
    const seats = buildSeats(PLAYERS, PANTHER);
    st.vars.seats   = seats;
    st.emit("HandStart", { dealer: DEALER });

    const bid: Bid = { tricks: 1, trump, perilsOnly: trump === null };
    st.emit("Bid", { player: PANTHER, ...bid });

    // Build answerers.
    const answerers = new Map<Player | null, Answerer>();

    // Panther: always realistic MC.
    answerers.set(PANTHER, new NilAnswerer(
      PANTHER, st, cfg, new Rng(seed * 1009 + 1), pantherIters, "realistic"));

    // Hunters.
    const hunters = PLAYERS.filter(p => p !== PANTHER);
    hunters.forEach((p, i) => {
      if (hunterKind === "random") {
        const rng = new Rng(seed * 1009 + (i + 2) * 997);
        answerers.set(p, { answer: (r: Choice) => rng.choice(r.options) });
      } else {
        const vision = hunterKind === "omniscient" ? "omniscient" : "realistic";
        answerers.set(p, new NilAnswerer(
          p, st, cfg, new Rng(seed * 1009 + (i + 2) * 997), hunterIters, vision));
      }
    });

    answerers.set(null, {
      answer: (r: Choice) => new Rng(seed * 911 + 7).choice(r.options),
    });

    await run(playTricks(st, {
      seats, lead: firstLeadSeat(seats, PANTHER, PLAYERS, cfg),
      handSize: hs, panther: PANTHER, bid,
      trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
      won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
    }, cfg), answerers);

    // Count Panther-hand tricks.
    let pTricks = 0;
    for (const e of st.log)
      if (e.type === "TrickWon" && e.payload.seat === `hand:${PANTHER}`) pTricks++;
    if (pTricks === 0) makes++;
  }

  return { name, makes, n: N };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N            = parseInt(process.env.N            ?? "5000");
  const SEL_ITER     = parseInt(process.env.SEL_ITER     ?? "30");
  const PANTHER_ITER = parseInt(process.env.PANTHER_ITER ?? "30");
  const cfg: PantherConfig = DEFAULT_CONFIG;

  console.log(`exp_nil_study — N=${N} deals/condition, SEL_ITER=${SEL_ITER}, PANTHER_ITER=${PANTHER_ITER}`);
  console.log(`Story: Panther Defends (nil). Panther realistic MC throughout.`);
  console.log(`Same ${N} deal seeds used for all conditions (controlled comparison).\n`);

  const conditions: { name: string; kind: HunterKind; iters: number }[] = [
    { name: "Random Hunters",      kind: "random",     iters: 0   },
    { name: "Realistic MC  30",    kind: "realistic",  iters: 30  },
    { name: "Realistic MC 200",    kind: "realistic",  iters: 200 },
    { name: "Omniscient MC  30",   kind: "omniscient", iters: 30  },
  ];

  const progress = Math.max(500, Math.floor(N / 10));
  const results: { name: string; makes: number; n: number }[] = [];

  for (const { name, kind, iters } of conditions) {
    console.log(`Running: ${name}…`);
    const r = await runCondition(name, kind, iters, N, SEL_ITER, PANTHER_ITER,
                                 cfg, progress);
    results.push(r);
    const p = r.makes / r.n;
    const se = Math.sqrt(p * (1 - p) / r.n);
    console.log(`  → P(nil) = ${p.toFixed(4)}  SE = ${se.toFixed(4)}\n`);
  }

  // ---------------------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------------------
  const SL = 22;
  const NC =  9;
  console.log("═".repeat(SL + NC * 4));
  console.log(
    "Condition".padEnd(SL) +
    "P(nil)".padStart(NC) + "SE".padStart(NC) +
    "makes".padStart(NC) + "n".padStart(NC),
  );
  console.log("─".repeat(SL + NC * 4));
  for (const { name, makes, n } of results) {
    const p  = makes / n;
    const se = Math.sqrt(p * (1 - p) / n);
    console.log(
      name.padEnd(SL) +
      p.toFixed(4).padStart(NC) +
      se.toFixed(4).padStart(NC) +
      makes.toString().padStart(NC) +
      n.toString().padStart(NC),
    );
  }
  console.log("─".repeat(SL + NC * 4));

  // Slope: P(nil random) − P(nil omniscient)
  if (results.length >= 4) {
    const pRand  = results[0].makes / results[0].n;
    const pOmni  = results[3].makes / results[3].n;
    const drop   = pRand - pOmni;
    const seComb = Math.sqrt(
      (pRand*(1-pRand)/results[0].n) + (pOmni*(1-pOmni)/results[3].n));
    console.log(
      `\nSlope (random → omniscient): Δ = ${drop >= 0 ? "-" : "+"}${Math.abs(drop).toFixed(4)}` +
      `  (${(drop/seComb).toFixed(1)} SE combined)`
    );
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
