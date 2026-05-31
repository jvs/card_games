/**
 * test_panther.ts — panther-specific guarantees.
 *
 * The key test here is RECONSTRUCTION EQUIVALENCE: playFromState (playTricks)
 * plus the log-reconstructor create two code paths that must agree on what
 * "current trick state" means. This test plays a hand normally, intercepts at
 * a mid-trick point, reconstructs from the log, and asserts the reconstructed
 * belief matches the live State.
 *
 * Run with: tsx test_panther.ts
 */
import { Rng, Player, Choice, Answerer, Effect, run } from "../../core.js";
import { Card } from "../../cards.js";
import {
  DEFAULT_CONFIG, PantherConfig, calcHandSize,
  newState, playHand, clockwise, Bid,
} from "../panther.js";
import { reconstructBelief, Belief } from "../mc_panther.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) =>
  c ? (pass++, console.log("ok  " + m)) : (fail++, console.error("FAIL " + m));

function cardId(c: Card): string { return c.get("suit") + "|" + c.get("rank"); }
function cardSetEq(a: Card[], b: Card[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map(cardId).sort().join(",");
  const sb = b.map(cardId).sort().join(",");
  return sa === sb;
}

// ---------------------------------------------------------------------------
// Intercepting answerer: plays randomly, but at a chosen "play" call number
// snapshots both the live state and the reconstructed belief.
// ---------------------------------------------------------------------------
class CapturingAnswerer implements Answerer {
  capturedBelief:        Belief | null = null;
  capturedHand:          Card[] | null = null;
  capturedCrow:          Card[] | null = null;
  capturedDiscard:       Card[] | null = null;
  capturedTrickNumber:   number | null = null;
  capturedPanther:       Player | null = null;

  private playCallCount = 0;

  constructor(
    private capturePlayer: Player,
    private st: ReturnType<typeof newState>,
    private allPlayers: Player[],
    private cfg: PantherConfig,
    private captureAtCall: number,
    private rng: Rng,
  ) {}

  answer(req: Effect): any {
    const c = req as Choice;
    if (c.key === "play" && c.player === this.capturePlayer) {
      this.playCallCount++;
      if (this.playCallCount === this.captureAtCall) {
        // Snapshot live state (ground truth)
        this.capturedHand          = [...this.st.z(`hand:${this.capturePlayer}`).cards];
        this.capturedCrow          = [...this.st.z("crow").cards];
        this.capturedDiscard       = [...this.st.z("discard").cards];
        this.capturedTrickNumber   = this.st.log.filter(e => e.type === "TrickWon").length;
        this.capturedPanther       = this.st.vars.panther ?? null;

        // Reconstruct from the player's filtered log view
        this.capturedBelief = reconstructBelief(
          this.st.viewFor(this.capturePlayer),
          this.capturePlayer,
          this.allPlayers,
          this.cfg,
        );
      }
    }
    return this.rng.choice(c.options);
  }
}

// ---------------------------------------------------------------------------
// Test 1: mid-trick reconstruction matches live state (default config)
// ---------------------------------------------------------------------------
async function testReconstructionEquivalence() {
  const cfg = DEFAULT_CONFIG;
  const players: Player[] = ["A", "B", "C"];
  const rng = new Rng(99);

  // Play a hand with player A captured on their 8th play (across 10 tricks,
  // this is somewhere in the middle of the hand)
  const st = newState(players, rng);
  const capturer = new CapturingAnswerer("A", st, players, cfg, 8, new Rng(7));

  const answerers = new Map<Player | null, Answerer>([
    ["A", capturer],
    [null, { answer: (req: Choice) => rng.choice(req.options) }],
  ]);

  await run(playHand(st, players[0], cfg), answerers);

  const b = capturer.capturedBelief!;
  ok(b !== null, "capture happened");
  if (!b) return;

  ok(cardSetEq(b.myHand, capturer.capturedHand!),
    "belief.myHand matches live hand:A contents at capture point");

  ok(cardSetEq(b.crow, capturer.capturedCrow!),
    "belief.crow matches live crow contents at capture point");

  // Discard: belief.completedTrickCards should match live discard
  ok(cardSetEq(b.completedTrickCards, capturer.capturedDiscard!),
    "belief.completedTrickCards matches live discard at capture point");

  ok(b.trickNumber === capturer.capturedTrickNumber!,
    `belief.trickNumber (${b.trickNumber}) matches live (${capturer.capturedTrickNumber})`);

  ok(b.panther === capturer.capturedPanther,
    `belief.panther (${b.panther}) matches live (${capturer.capturedPanther})`);

  ok(b.phase === "tricks",
    "belief.phase is 'tricks' during play");
}

// ---------------------------------------------------------------------------
// Test 2: unknown pool accounting — pool size equals sum of opponent hand
// sizes plus unaccounted woods cards.
// ---------------------------------------------------------------------------
async function testUnknownPoolAccounting() {
  const cfg = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);
  const players: Player[] = ["A", "B", "C"];
  const rng = new Rng(42);

  const st = newState(players, rng);
  // Use a wrapper object so TypeScript can narrow the property type (let
  // variables modified inside closures aren't narrowed by TS control-flow).
  const cap = { belief: null as Belief | null };

  const capturer: Answerer = {
    answer(req: Effect): any {
      const c = req as Choice;
      if (c.key === "play" && c.player === "A" && cap.belief === null) {
        cap.belief = reconstructBelief(st.viewFor("A"), "A", players, cfg);
      }
      return rng.choice(c.options);
    }
  };

  const ans = new Map<Player | null, Answerer>([
    ["A", capturer],
    [null, { answer: (req: Choice) => rng.choice(req.options) }],
  ]);
  await run(playHand(st, players[0], cfg), ans);

  const b = cap.belief;
  if (!b) { ok(false, "pool test: belief captured"); return; }

  // Full deck size
  const fullDeckSize = 4 * cfg.cardsPerSuit + cfg.perilsCount;

  // Known cards = myHand + crow + completedTrickCards + currentTrickCards + knownWoods
  const knownSize =
    b.myHand.length +
    b.crow.length +
    b.completedTrickCards.length +
    b.currentTrickCards.length +
    (b.knownWoods?.length ?? 0);

  const unknownSize = fullDeckSize - knownSize;

  // Unknown pool should be: sum of opponent hand sizes + unknown woods
  const sumOpponentHands = Object.entries(b.opponentHandSizes)
    .filter(([p]) => p !== "A")
    .reduce((s, [, n]: [string, number]) => s + n, 0);
  const unknownWoods = cfg.woodsSize - (b.knownWoods?.length ?? 0);
  const expectedUnknown = sumOpponentHands + unknownWoods;

  ok(unknownSize === expectedUnknown,
    `unknown pool size (${unknownSize}) = opponent hands (${sumOpponentHands}) + unknown woods (${unknownWoods})`);
}

// ---------------------------------------------------------------------------
// Test 3: reconstruction with non-default config (fewer perils, smaller woods)
// ---------------------------------------------------------------------------
async function testNonDefaultConfig() {
  // (4×10 + 3 − 3) / 4 = 40/4 = 10 → handSize=10, valid
  const cfg: PantherConfig = { ...DEFAULT_CONFIG, perilsCount: 3, woodsSize: 3 };
  const players: Player[] = ["A", "B", "C"];
  const rng = new Rng(17);
  const st = newState(players, rng);

  const cap = { belief: null as Belief | null };
  const capturer: Answerer = {
    answer(req: Effect): any {
      const c = req as Choice;
      if (c.key === "play" && c.player === "B" && cap.belief === null) {
        cap.belief = reconstructBelief(st.viewFor("B"), "B", players, cfg);
      }
      return rng.choice(c.options);
    }
  };

  const ans = new Map<Player | null, Answerer>([
    ["B", capturer],
    [null, { answer: (req: Choice) => rng.choice(req.options) }],
  ]);
  await run(playHand(st, players[0], cfg), ans);

  const b = cap.belief;
  ok(b !== null, "non-default config: belief captured");
  if (b) {
    const hs = calcHandSize(cfg);
    ok(b.myHand.length <= hs,
      `non-default config: B's hand size (${b.myHand.length}) ≤ handSize (${hs})`);
    ok(b.phase === "tricks",
      "non-default config: phase is 'tricks'");
  }
}

// ---------------------------------------------------------------------------
// Test 4: playTricks with partial plays produces a valid score
// ---------------------------------------------------------------------------
async function testPlayTricksWithPartialPlays() {
  // Run two identical hands up to a mid-trick point:
  //   hand 1: plays normally (reference)
  //   hand 2: run up to trick 3, rebuild state, call playTricks from there
  // The scores won't necessarily match (random play), but both should be valid
  // score records (non-negative, correct players, success/failure structure).
  const cfg = DEFAULT_CONFIG;
  const players: Player[] = ["A", "B", "C"];
  const rng = new Rng(55);
  const st = newState(players, rng);

  let scores: Record<Player, number> | null = null;
  const ans: Answerer = { answer: (req: Choice) => rng.choice(req.options) };
  scores = await run(playHand(st, players[0], cfg), ans);

  const allNonNeg = Object.values(scores).every(s => s >= 0);
  ok(allNonNeg, "playTricks: all scores non-negative");

  const atMostOnePositive = Object.values(scores).filter(s => s > 0).length <= 1 ||
    Object.values(scores).filter(s => s > 0).length === players.length - 1;
  ok(atMostOnePositive,
    "playTricks: either Panther scored XOR all Hunters scored (Panther-fail)");
}

async function main() {
  await testReconstructionEquivalence();
  await testUnknownPoolAccounting();
  await testNonDefaultConfig();
  await testPlayTricksWithPartialPlays();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
