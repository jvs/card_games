/**
 * exp_substrate.ts — trick-outcome distributions for each contract, under
 * realistic binary-make/fail MC.  No points, no auction, no story selection:
 * just the raw trick-count buckets that scoring will be layered onto.
 *
 * Setup (per contract):
 *   - Contract assigned on every deal; no auction.
 *   - Panther selects trump (all 5 options) via omniscient random rollouts
 *     maximising P(make) — binary signal, not points.
 *   - Both sides play realistic flat MC (sample opponent hands from unknown
 *     pool) with the binary P(make) signal:
 *       Panther: maximise P(make)
 *       Hunters: minimise P(make)
 *   - Same N deal seeds used for all three contracts.
 *   - Pranks active.
 *
 * Outcome buckets:
 *   Both Attack    — p+c = 7, 8, ≥9, fail (≤6)
 *   Both Defend    — p+c = 3, 2, ≤1, fail (≥4)
 *   Panther Defends— p = 0, fail (≥1)
 *
 * Output: one row per (contract × bucket) with P and binomial SE.
 *
 * Env vars:
 *   N=5000           deals
 *   SEL_ITER=30      rollouts per trump option (selection)
 *   PLAY_ITER=30     rollouts per card option (play)
 *
 * Run:  tsx exp_substrate.ts
 *       N=200 tsx exp_substrate.ts   # smoke test
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, playTricks, Bid,
  firstLeadSeat, buildSeats, deck, newState,
  StoryKind, ALL_STORIES, STORY_LABELS,
  storyMakes, rolloutSync, deck as pantherDeck,
} from "../panther.js";
import { reconstructBelief, Belief } from "../mc_panther.js";
import { State, Card } from "../../cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player   = "A";
const DEALER:  Player   = "C";

function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }

const TRUMP_OPTIONS: { trump: string | null; label: string }[] = [
  { trump: "Spades",   label: "Spades"     },
  { trump: "Diamonds", label: "Diamonds"   },
  { trump: "Hearts",   label: "Hearts"     },
  { trump: "Clubs",    label: "Clubs"      },
  { trump: null,       label: "PerilsOnly" },
];

// ---------------------------------------------------------------------------
// Outcome bucket definitions per contract.
// ---------------------------------------------------------------------------
interface Bucket { label: string; test: (p: number, c: number) => boolean; }

const BUCKETS: Record<StoryKind, Bucket[]> = {
  BothAttack: [
    { label: "p+c = 7  (small)", test: (p, c) => p + c === 7 },
    { label: "p+c = 8  (med)",   test: (p, c) => p + c === 8 },
    { label: "p+c ≥ 9  (large)", test: (p, c) => p + c >= 9  },
    { label: "fail  (p+c ≤ 6)",  test: (p, c) => p + c <= 6  },
  ],
  BothDefend: [
    { label: "p+c = 3  (small)", test: (p, c) => p + c === 3 },
    { label: "p+c = 2  (med)",   test: (p, c) => p + c === 2 },
    { label: "p+c ≤ 1  (large)", test: (p, c) => p + c <= 1  },
    { label: "fail  (p+c ≥ 4)",  test: (p, c) => p + c >= 4  },
  ],
  PantherDefends: [
    { label: "p = 0    (make)",  test: (p, _) => p === 0 },
    { label: "fail  (p ≥ 1)",   test: (p, _) => p >= 1  },
  ],
};

// ---------------------------------------------------------------------------
// Deal cards (deterministic from seed).
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
// Panther trump selection: pick the trump that maximises P(make) for the
// given story, using omniscient random rollouts.
// ---------------------------------------------------------------------------
function selectTrump(
  story: StoryKind, st: State, cfg: PantherConfig, rng: Rng, n: number,
): string | null {
  const hs    = calcHandSize(cfg);
  const seats = buildSeats(PLAYERS, PANTHER);
  const lead  = firstLeadSeat(seats, PANTHER, PLAYERS, cfg);
  let best: string | null = null;
  let bestEV = -Infinity;
  for (const { trump } of TRUMP_OPTIONS) {
    let makes = 0;
    for (let i = 0; i < n; i++) {
      const hands: Record<string, Card[]> = {};
      for (const [, z] of seats) hands[z] = [...st.z(z).cards];
      const { pantherTricks, crowTricks } = rolloutSync(
        hands, seats, lead, 0, hs, [], null, null, trump, PANTHER, rng);
      if (storyMakes(pantherTricks, crowTricks, story)) makes++;
    }
    const ev = makes / n;
    if (ev > bestEV) { bestEV = ev; best = trump; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Binary MC answerer — P(make) as the value signal.
//   Panther (player === PANTHER) maximises P(make).
//   Hunters minimise P(make).
//   Realistic vision: each player samples opponent hands independently.
// ---------------------------------------------------------------------------
class BinaryMCAnswerer implements Answerer {
  private readonly deck: Card[];
  constructor(
    private player:  Player,
    private st:      State,
    private cfg:     PantherConfig,
    private rng:     Rng,
    private story:   StoryKind,
    private iters:   number,
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
    const wantMax = this.player === panther;
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
    const pool     = this.unknownPool(belief);
    const opSlots  = PLAYERS
      .filter(p => p !== this.player)
      .map(p => ({ zname: `hand:${p}` as string,
                   size: Math.max(0, belief.opponentHandSizes[p] ?? 0) }));
    let total = 0;
    for (let i = 0; i < this.iters; i++) {
      const p = [...pool]; this.rng.shuffle(p);
      const hands: Record<string, Card[]> = {};
      let off = 0;
      for (const { zname, size } of opSlots) {
        hands[zname] = p.slice(off, off + size); off += size;
      }
      hands[`hand:${this.player}`] = [...belief.myHand];
      hands["crow"]                = [...belief.crow];
      const h   = hands[fromZone];
      const idx = h.findIndex(c => cardId(c) === cid);
      if (idx >= 0) h.splice(idx, 1);
      const { pantherTricks, crowTricks } = rolloutSync(
        hands, seats, belief.lead, belief.trickNumber, hs,
        extPlays, extLed, belief.forcedFromPartials, trump, panther, this.rng);
      const totalP = (belief.won[panther] ?? 0) + pantherTricks;
      const totalC = belief.crowWon + crowTricks;
      // Binary signal: 1 if contract makes, 0 if fails.
      total += storyMakes(totalP, totalC, this.story) ? 1 : 0;
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
// Play one deal under one contract; return (pTricks, cTricks).
// ---------------------------------------------------------------------------
async function playOneDeal(
  story: StoryKind, st: State, trump: string | null,
  cfg: PantherConfig, seed: number, playIter: number,
): Promise<{ pTricks: number; cTricks: number }> {
  const hs    = calcHandSize(cfg);
  const seats = buildSeats(PLAYERS, PANTHER);
  st.vars.seats   = seats;
  st.vars.panther = PANTHER;
  st.vars.trump   = trump;
  st.emit("HandStart", { dealer: DEALER });
  const bid: Bid = { tricks: 1, trump, perilsOnly: trump === null };
  st.emit("Bid", { player: PANTHER, ...bid });

  const answerers = new Map<Player | null, Answerer>();
  PLAYERS.forEach((p, i) =>
    answerers.set(p, new BinaryMCAnswerer(
      p, st, cfg, new Rng(seed * 1009 + i * 997 + 1), story, playIter)));
  answerers.set(null, {
    answer: (r: Choice) => new Rng(seed * 911 + 7).choice(r.options),
  });

  await run(playTricks(st, {
    seats, lead: firstLeadSeat(seats, PANTHER, PLAYERS, cfg),
    handSize: hs, panther: PANTHER, bid,
    trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
    won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
  }, cfg), answerers);

  let pTricks = 0, cTricks = 0;
  for (const e of st.log) {
    if (e.type !== "TrickWon") continue;
    if (e.payload.seat === `hand:${PANTHER}`) pTricks++;
    else if (e.payload.seat === "crow")       cTricks++;
  }
  return { pTricks, cTricks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N        = parseInt(process.env.N         ?? "5000");
  const SEL_ITER = parseInt(process.env.SEL_ITER  ?? "30");
  const PLAY_ITER= parseInt(process.env.PLAY_ITER ?? "30");
  const cfg: PantherConfig = DEFAULT_CONFIG;

  console.log(`exp_substrate — N=${N} deals, SEL_ITER=${SEL_ITER}, PLAY_ITER=${PLAY_ITER}`);
  console.log(`Binary P(make) MC: Panther maximises, Hunters minimise.`);
  console.log(`Panther selects trump per-contract via omniscient binary rollouts.`);
  console.log(`Same N deal seeds used for all three contracts.\n`);

  // counts[story][bucketIndex] = number of deals landing in that bucket
  const counts: Record<StoryKind, number[]> = {} as any;
  for (const story of ALL_STORIES)
    counts[story] = new Array(BUCKETS[story].length).fill(0);

  const progressEvery = Math.max(250, Math.floor(N / 20));

  for (let d = 0; d < N; d++) {
    if (d > 0 && d % progressEvery === 0)
      process.stdout.write(`  deal ${d}/${N}…\n`);

    const seed = d + 1;

    for (const story of ALL_STORIES) {
      // Re-deal same cards for each contract (deterministic seed).
      const st    = dealCards(cfg, seed);
      const trump = selectTrump(story, st, cfg, new Rng(seed * 9973 + 1), SEL_ITER);
      const { pTricks, cTricks } = await playOneDeal(
        story, st, trump, cfg, seed, PLAY_ITER);

      const buckets = BUCKETS[story];
      for (let b = 0; b < buckets.length; b++) {
        if (buckets[b].test(pTricks, cTricks)) { counts[story][b]++; break; }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Print results: one row per (contract, bucket) with P and binomial SE.
  // ---------------------------------------------------------------------------
  const CL = 20;   // contract label width
  const BL = 22;   // bucket label width
  const NW =  9;   // numeric column width

  const header = "Contract".padEnd(CL) + "Bucket".padEnd(BL) +
    "P".padStart(NW) + "SE".padStart(NW) + "count".padStart(NW);
  const rule   = "─".repeat(header.length);

  console.log(header);
  console.log(rule);

  for (const story of ALL_STORIES) {
    const label   = STORY_LABELS[story];
    const buckets = BUCKETS[story];
    for (let b = 0; b < buckets.length; b++) {
      const cnt = counts[story][b];
      const p   = cnt / N;
      const se  = Math.sqrt(p * (1 - p) / N);
      const contractCol = b === 0 ? label.padEnd(CL) : " ".repeat(CL);
      console.log(
        contractCol +
        buckets[b].label.padEnd(BL) +
        p.toFixed(4).padStart(NW) +
        se.toFixed(4).padStart(NW) +
        cnt.toString().padStart(NW),
      );
    }
    // Sanity-check row: counts should sum to N.
    const total = counts[story].reduce((a, b) => a + b, 0);
    if (total !== N)
      console.error(`  WARNING: ${label} counts sum to ${total}, expected ${N}`);
    if (story !== ALL_STORIES[ALL_STORIES.length - 1]) console.log("");
  }

  console.log(rule);
  console.log(`\n(Each SE is binomial: sqrt(p*(1-p)/${N}).)`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
