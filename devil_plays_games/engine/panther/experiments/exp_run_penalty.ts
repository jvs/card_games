/**
 * exp_run_penalty.ts — quick sanity check for the reduced Run failure penalty.
 *
 * Change under test: Run fail now awards +1 to each Hunter (was +2).
 * All three seats use MCAnswerer (curse declarations + trick play via MC).
 * Runs a small fixed number of hands and prints per-hand details plus summary.
 *
 * Usage:  tsx panther/experiments/exp_run_penalty.ts
 * Env:    HANDS=12  ITERS=50  SEED=1
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, newState, playHand,
  storyOutcome, storyPoints, Story, PlanKind,
} from "../panther.js";
import { MCAnswerer } from "../mc_panther.js";

const PLAYERS: Player[] = ["A", "B", "C"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pad(s: string | number, w: number, right = false): string {
  const t = String(s);
  return right ? t.padStart(w) : t.padEnd(w);
}

function groundLabel(g: string | null): string {
  return g ?? "Perils";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N     = parseInt(process.env.HANDS ?? "12");
  const iters = parseInt(process.env.ITERS ?? "50");
  const seed  = parseInt(process.env.SEED  ?? "1");

  const cfg: PantherConfig = { ...DEFAULT_CONFIG };
  const hs = calcHandSize(cfg);

  const scores: Record<Player, number> = { A: 0, B: 0, C: 0 };
  const stats: Record<PlanKind, { n: number; made: number }> = {
    Fight: { n: 0, made: 0 }, Run:    { n: 0, made: 0 },
    Vanish: { n: 0, made: 0 }, Panic: { n: 0, made: 0 },
  };
  const pantherCount: Record<Player, number> = { A: 0, B: 0, C: 0 };
  const storyDist: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

  // Separate tallies for declared-plans vs chosen-plan vs ground choice.
  const declaredPlan:  Record<PlanKind, number> = { Fight: 0, Run: 0, Vanish: 0, Panic: 0 };
  const declaredGround: Record<string, number>  = { Spades: 0, Diamonds: 0, Hearts: 0, Clubs: 0, Perils: 0 };
  const chosenGround:   Record<string, number>  = { Spades: 0, Diamonds: 0, Hearts: 0, Clubs: 0, Perils: 0 };

  const masterRng = new Rng(seed);
  let dealer = PLAYERS[0];

  // Header
  console.log(`Fight: 7→1p, 8→2p, 9/10→4p, fail→+2 ea Hunter`);  console.log(`Run:   3→1p, 2→2p, 1/0→4p, fail→+1 ea Hunter`);  console.log(`Vanish: 0 Panther tricks→2p, fail→+1 ea Hunter`);
  console.log(`${N} hands · MC iters=${iters} · handSize=${hs} · seed=${seed}\n`);

  const hdr = [
    pad("Hd", 3),  pad("Dlr", 4), pad("Panther", 8), pad("Plan", 7),
    pad("Ground", 9), pad("P", 2), pad("C", 2), pad("Tot", 4),
    pad("Outcome", 9), pad("Cx", 4), pad("Δ this hand", 14), "Running totals",
  ].join(" ");
  console.log(hdr);
  console.log("─".repeat(hdr.length + 6));

  for (let h = 0; h < N; h++) {
    const st = newState(PLAYERS, new Rng(masterRng.int(2 ** 30)));

    // One MCAnswerer per player; one seeded fallback Rng for prank sub-choices
    // and curse meta-decisions (panic_ground, choose_panther).
    const answerers = new Map<Player | null, Answerer>();
    for (const p of PLAYERS)
      answerers.set(p, new MCAnswerer(p, st, PLAYERS, cfg, new Rng(masterRng.int(2 ** 30)), iters));
    const fbRng = new Rng(masterRng.int(2 ** 30));
    answerers.set(null, { answer: (r: Choice) => fbRng.choice(r.options) });

    const gained = await run(playHand(st, dealer, cfg), answerers);

    // Extract hand facts from the log.
    const curseEv = st.log.find(e => e.type === "CurseResult")!;
    const panther = curseEv.payload.panther as Player;
    const story: Story = {
      plan:   curseEv.payload.plan   as PlanKind,
      ground: curseEv.payload.ground as string | null,
    };

    const storyCount = st.log.filter(e => e.type === "Story").length;

    // Tally every declaration (not just the chosen one).
    for (const e of st.log.filter(e => e.type === "Story")) {
      declaredPlan[e.payload.plan as PlanKind]++;
      const g = e.payload.ground as string | null;
      declaredGround[g ?? "Perils"]++;
    }
    // Tally the chosen ground.
    chosenGround[story.ground ?? "Perils"]++;

    const trickWon = st.log.filter(e => e.type === "TrickWon");
    const pTricks  = trickWon.filter(e => e.payload.seat === `hand:${panther}`).length;
    const cTricks  = trickWon.filter(e => e.payload.seat === "crow").length;
    const combined = pTricks + cTricks;

    const outcome = storyOutcome(pTricks, cTricks, story);
    const pts     = storyPoints(pTricks, cTricks, story);

    // Accumulators
    for (const p of PLAYERS) scores[p] += gained[p];
    stats[story.plan].n++;
    if (outcome !== "fail") stats[story.plan].made++;
    pantherCount[panther]++;
    storyDist[storyCount]++;;

    // Δ column: show who earned what this hand.
    const delta = pts.panther > 0
      ? `+${pts.panther} → ${panther}`
      : `+${pts.hunters} ea Hunter`;

    const running = PLAYERS.map(p => `${p}:${scores[p]}`).join("  ");
    const curseTag = `${storyCount}/3`;

    console.log([
      pad(h + 1, 3, true),
      pad(dealer, 4),
      pad(panther, 8),
      pad(story.plan, 7),
      pad(groundLabel(story.ground), 9),
      pad(pTricks, 2, true),
      pad(cTricks, 2, true),
      pad(combined, 4, true),
      pad(outcome, 9),
      pad(curseTag, 4),
      pad(delta, 14),
      running,
    ].join(" "));

    dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length];
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n" + "═".repeat(72));
  console.log("\nFinal scores");
  console.log("  " + PLAYERS.map(p => `${p}: ${scores[p]}`).join("    "));

  console.log(`\nPanther seat (${N} hands)`);
  console.log("  " + PLAYERS.map(p => `${p}: ${pantherCount[p]}×`).join("    "));

  console.log("\nCurse story count  (Cx = how many players told a story)");
  console.log(`  ${ "Stories".padEnd(10) } ${ "Hands".padStart(6) }  ${ "Pct".padStart(5) }`);
  for (const k of [3, 2, 1, 0]) {
    const n = storyDist[k] ?? 0;
    if (n === 0) continue;
    const label = k === 3 ? "3 (all bid)" : k === 0 ? "0 (all pass)" : `${k}`;
    const pct = `${((n / N) * 100).toFixed(0)}%`;
    console.log(`  ${label.padEnd(10)} ${String(n).padStart(6)}  ${pct.padStart(5)}`);
  }

  const totalDeclared = Object.values(declaredPlan).reduce((a, b) => a + b, 0);
  console.log("\nDeclared plans  (every story told, including losing declarations)");
  console.log(`  ${"Plan".padEnd(8)} ${"Told".padStart(6)}  ${"Pct".padStart(5)}`);
  for (const plan of ["Fight", "Run", "Vanish", "Panic"] as PlanKind[]) {
    const n = declaredPlan[plan];
    if (n === 0) continue;
    const pct = `${((n / totalDeclared) * 100).toFixed(0)}%`;
    console.log(`  ${plan.padEnd(8)} ${String(n).padStart(6)}  ${pct.padStart(5)}`);
  }

  console.log("\nChosen plan  (the plan that became the Panther's contract)");
  console.log(`  ${"Plan".padEnd(8)} ${"Chosen".padStart(6)}  ${"Made".padStart(5)}  ${"Rate".padStart(5)}`);
  for (const plan of ["Fight", "Run", "Vanish", "Panic"] as PlanKind[]) {
    const { n, made } = stats[plan];
    if (n === 0) continue;
    const rate = `${((made / n) * 100).toFixed(0)}%`;
    console.log(`  ${plan.padEnd(8)} ${String(n).padStart(6)}  ${String(made).padStart(5)}  ${rate.padStart(5)}`);
  }

  const GROUNDS = ["Spades", "Diamonds", "Hearts", "Clubs", "Perils"];
  console.log("\nGround (trump suit or Perils Only)");
  console.log(`  ${"Ground".padEnd(9)} ${"Declared".padStart(12)}  ${"Chosen".padStart(10)}`);
  for (const g of GROUNDS) {
    const d = declaredGround[g] ?? 0;
    const c = chosenGround[g]   ?? 0;
    if (d === 0 && c === 0) continue;
    const dStr = totalDeclared > 0 ? `${d} (${((d / totalDeclared) * 100).toFixed(0)}%)` : `${d}`;
    const cStr = N > 0           ? `${c} (${((c / N)             * 100).toFixed(0)}%)` : `${c}`;
    console.log(`  ${g.padEnd(9)} ${dStr.padStart(12)}  ${cStr.padStart(10)}`);
  }

  console.log("\nAvg pts / hand");
  console.log("  " + PLAYERS.map(p => `${p}: ${(scores[p] / N).toFixed(2)}`).join("    "));
}

main().catch(console.error);
