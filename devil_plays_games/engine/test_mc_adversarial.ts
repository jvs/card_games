/**
 * test_mc_adversarial.ts — tests built to BITE, targeting the two spots most
 * likely wrong: (1) belief.lead / partialPlays reconstruction THROUGH a Cat
 * play (the original test asserted neither and never guaranteed a Cat fired),
 * and (2) determinization never sampling a card that's provably elsewhere
 * (the original pool test was circular — same bookkeeping on both sides).
 *
 * REQUIRES one small export in mc_panther.ts (see note at bottom): the sampling
 * internals. Add this line near the other exports in mc_panther.ts:
 *
 *     export const __mcInternals = { unknownPool, sampleWorld, cardId };
 *
 * (unknownPool/sampleWorld/cardId are module-private in the current file.)
 *
 * Run: tsx test_mc_adversarial.ts
 */
import { Rng, Player, Choice, Answerer, Effect, run } from "./core.js";
import { Card } from "./cards.js";
import { DEFAULT_CONFIG, PantherConfig, newState, playHand } from "./panther.js";
import { reconstructBelief, Belief, __mcInternals } from "./mc_panther.js";

const { unknownPool, sampleWorld, cardId } = __mcInternals;

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) =>
  c ? (pass++, console.log("ok  " + m)) : (fail++, console.error("FAIL " + m));

// ---------------------------------------------------------------------------
// Capturer — at play-call #`at` for `player`, snapshot reconstructBelief output
// AND the live ground-truth zones, so we can compare the fields the original
// equivalence test skipped (partialPlays; and hand/discard exactly).
// ---------------------------------------------------------------------------
class Capturer implements Answerer {
  samples: {
    belief: Belief; liveHand: string[]; liveDiscard: string[];
    livePartial: number; sawCat: boolean;
  }[] = [];
  private callN = 0;
  constructor(
    private player: Player,
    private st: ReturnType<typeof newState>,
    private all: Player[],
    private cfg: PantherConfig,
    private at: number,
    private rng: Rng,
  ) {}
  answer(req: Effect): any {
    const c = req as Choice;
    if (c.key === "play" && c.player === this.player) {
      this.callN++;
      if (this.callN === this.at) {
        const belief = reconstructBelief(this.st.viewFor(this.player), this.player, this.all, this.cfg);
        const tw = this.st.log.filter(e => e.type === "TrickWon");
        const lastSeq = tw.length ? tw[tw.length - 1].seq : -1;
        const livePartial = this.st.log.filter(e => e.type === "Played" && e.seq > lastSeq).length;
        this.samples.push({
          belief,
          liveHand:    this.st.z(`hand:${this.player}`).cards.map(cardId).sort(),
          liveDiscard: this.st.z("discard").cards.map(cardId).sort(),
          livePartial,
          sawCat:      this.st.log.some(e => e.type === "CatLead"),
        });
      }
    }
    return this.rng.choice(c.options);
  }
}

// --- Test A: reconstruction equivalence across many seeds, asserting on hand,
//     discard, AND partialPlays — and REQUIRING that a Cat fired in some hands,
//     so the hard path is provably exercised (fails loudly if it never is). ---
async function testReconstructionBites() {
  const cfg = DEFAULT_CONFIG;
  const players: Player[] = ["A", "B", "C"];
  let total = 0, cat = 0, handOK = 0, discardOK = 0, partialOK = 0;

  for (let seed = 0; seed < 120; seed++) {
    const rng = new Rng(seed);
    const st = newState(players, rng);
    const cap = new Capturer("A", st, players, cfg, 5, new Rng(seed + 5000));
    await run(playHand(st, players[0], cfg), new Map<Player | null, Answerer>([
      ["A", cap], [null, { answer: (req: Choice) => rng.choice(req.options) }],
    ]));
    for (const s of cap.samples) {
      total++;
      if (s.sawCat) cat++;
      if (JSON.stringify(s.belief.myHand.map(cardId).sort()) === JSON.stringify(s.liveHand)) handOK++;
      if (JSON.stringify(s.belief.completedTrickCards.map(cardId).sort()) === JSON.stringify(s.liveDiscard)) discardOK++;
      if (s.belief.partialPlays.length === s.livePartial) partialOK++;
    }
  }

  ok(total > 50, `enough captures (${total})`);
  ok(cat > 0, `Cat fired before/within capture in some hands (${cat}/${total}) — hard path exercised`);
  ok(handOK === total, `belief.myHand matches live in ALL captures (${handOK}/${total})`);
  ok(discardOK === total, `belief.completedTrickCards matches live discard in ALL (${discardOK}/${total})`);
  ok(partialOK === total, `belief.partialPlays count matches live in ALL (${partialOK}/${total})`);
}

// --- Test B: the no-cheat determinization guarantee. Many worlds; assert no
//     sampled card is in A's real hand/discard/crow, none duplicated, and the
//     sampled count always equals the unknown-pool size. ---
async function testNoCheatSampling() {
  const cfg = DEFAULT_CONFIG;
  const players: Player[] = ["A", "B", "C"];
  let samples = 0, violations = 0, dupes = 0, countMismatch = 0;

  for (let seed = 0; seed < 60; seed++) {
    const rng = new Rng(seed);
    const st = newState(players, rng);
    let done = false;
    await run(playHand(st, players[0], cfg), new Map<Player | null, Answerer>([
      ["A", { answer: (req: Effect) => {
        const c = req as Choice;
        if (c.key === "play" && c.player === "A" && !done) {
          done = true;
          const belief = reconstructBelief(st.viewFor("A"), "A", players, cfg);
          const realHand    = new Set(st.z("hand:A").cards.map(cardId));
          const realDiscard = new Set(st.z("discard").cards.map(cardId));
          const realCrow    = new Set(st.z("crow").cards.map(cardId));
          const poolSize = unknownPool(belief, cfg, "A").length;
          for (let k = 0; k < 20; k++) {
            const w = sampleWorld(belief, "A", players, cfg, new Rng(seed * 100 + k));
            samples++;
            const seen = new Set<string>();
            const all: string[] = [];
            for (const p of players) if (p !== "A") for (const card of w.opponentHands[p]) all.push(cardId(card));
            for (const card of w.woods) all.push(cardId(card));
            for (const id of all) {
              if (realHand.has(id) || realDiscard.has(id) || realCrow.has(id)) violations++;
              if (seen.has(id)) dupes++;
              seen.add(id);
            }
            if (all.length !== poolSize) countMismatch++;
          }
        }
        return rng.choice(c.options);
      }}],
      [null, { answer: (req: Choice) => rng.choice(req.options) }],
    ]));
  }

  ok(samples > 100, `enough samples (${samples})`);
  ok(violations === 0, `NO sampled card is in A's real hand/discard/crow (violations=${violations})`);
  ok(dupes === 0, `NO card duplicated across opponents/woods (dupes=${dupes})`);
  ok(countMismatch === 0, `sampled count always equals unknown pool size (mismatch=${countMismatch})`);
}

async function main() {
  await testReconstructionBites();
  await testNoCheatSampling();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
