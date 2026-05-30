/**
 * verify_agents.ts — Sanity-check the four agents.
 *
 * Runs N deals under all four modes (same cards for each deal, different
 * agents) and verifies the expected ordering:
 *
 *   omniscient ≥ fair ≥ random ≥ suicidal   (Panther tricks, averaged)
 *
 * Also prints per-deal averages so the spread is visible.
 *
 * Run:  tsx verify_agents.ts
 */
import { Rng, Player, run } from "./core.js";
import { Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, deck,
  newState, playTricks, clockwise, Bid, PlayTricksParams, firstLeadSeat,
} from "./panther.js";
import { makeAgent, AgentMode } from "./agents.js";

const PANTHER: Player = "A";
const DEALER:  Player = "C";
const PLAYERS: Player[] = ["A", "B", "C"];
const MODES:   AgentMode[] = ["random", "fair", "omniscient", "suicidal"];

// ---------------------------------------------------------------------------
// Run one deal under one agent mode; return Panther trick count
// ---------------------------------------------------------------------------
async function runDeal(
  cfg:       PantherConfig,
  dealSeed:  number,
  agentPlayer: Player,
  agentMode: AgentMode,
  otherMode: AgentMode | "random",
  mcIters:   number,
): Promise<number> {
  const hs  = calcHandSize(cfg);
  const rng = new Rng(dealSeed);

  // Deal
  const st = newState(PLAYERS, rng);
  st.z("deck").cards = deck(cfg);
  st.shuffle("deck");
  for (const p of PLAYERS) st.deal("deck", `hand:${p}`, hs);
  st.deal("deck", "crow", hs);
  st.deal("deck", "woods", cfg.woodsSize);

  // One of the 4 trump suits (use Spades for simplicity)
  const trump = "Spades";
  const order = clockwise(PLAYERS, DEALER);
  const seats: [Player, string][] = [];
  for (const p of order) {
    seats.push([p, `hand:${p}`]);
    if (p === PANTHER) seats.push([PANTHER, "crow"]);
  }
  st.vars.trump   = trump;
  st.vars.seats   = seats;
  st.vars.panther = PANTHER;

  // The designated agent player
  const agentRng = new Rng(rng.int(2 ** 30));
  const agent    = makeAgent(agentMode, agentPlayer, st, PLAYERS, cfg, agentRng, mcIters);

  // All other players
  const hunterRng = new Rng(rng.int(2 ** 30));
  const randomAns: Answerer = { answer: (req: Choice) => hunterRng.choice(req.options) };

  const answerers = new Map<Player | null, Answerer>([
    [agentPlayer, agent],
    [null,        randomAns],
  ]);

  const bid: Bid = { tricks: 1, trump, perilsOnly: false };
  await run(playTricks(st, {
    seats,
    lead:               firstLeadSeat(seats, PANTHER, PLAYERS, cfg),
    handSize:           hs,
    panther:            PANTHER,
    bid,
    trickNum:           0,
    partialPlays:       [],
    partialLed:         null,
    forcedFromPartials: null,
    won:                Object.fromEntries(PLAYERS.map(p => [p, 0])) as Record<Player, number>,
    crowWon:            0,
  }, cfg), answerers);

  return st.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${PANTHER}` || e.payload.seat === "crow")
  ).length;
}

function checkOrdering(checks: [string, boolean][]): void {
  for (const [label, ok] of checks)
    console.log(`  ${ok ? "\u2713" : "\u2717 FAILED"}  ${label}`);
  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? "  All checks passed." : "  Some checks FAILED.");
}

async function main() {
  const N_DEALS  = parseInt(process.env.DEALS ?? "100");
  const MC_ITERS = parseInt(process.env.ITER  ?? "30");
  const cfg      = DEFAULT_CONFIG;

  console.log(`Agent verification — ${N_DEALS} deals, MC iters = ${MC_ITERS}`);
  console.log(`Config: handSize=${calcHandSize(cfg)}, trump=Spades fixed`);

  // ── Section 1: Panther agents ────────────────────────────────────────
  console.log(`\nSECTION 1 — Panther agent, Hunters random`);
  console.log(`Expected: omniscient ≥ fair ≥ random ≥ suicidal\n`);

  const pantherTotals: Record<AgentMode, number> = {
    random: 0, fair: 0, omniscient: 0, suicidal: 0,
  };
  for (let d = 0; d < N_DEALS; d++) {
    for (const mode of MODES)
      pantherTotals[mode] += await runDeal(cfg, d + 1, PANTHER, mode, "random", MC_ITERS);
  }

  console.log("Averages (Panther tricks/deal):");
  for (const mode of MODES)
    console.log(`  ${mode.padEnd(12)}: ${(pantherTotals[mode] / N_DEALS).toFixed(3)}`);

  const pa = Object.fromEntries(MODES.map(m => [m, pantherTotals[m] / N_DEALS]));
  checkOrdering([
    ["omniscient ≥ fair",     pa.omniscient >= pa.fair     - 0.05],
    ["fair       ≥ random",   pa.fair       >= pa.random   - 0.05],
    ["random     ≥ suicidal", pa.random     >= pa.suicidal - 0.05],
  ]);

  // ── Section 2: Hunter agents ────────────────────────────────────────
  // Hunter agent on player B; Panther and player C are random.
  // A skilled Hunter should *reduce* Panther tricks, so higher Hunter skill
  // means *fewer* Panther tricks.
  console.log(`\nSECTION 2 — Hunter agent on B, Panther random`);
  console.log(`Expected: suicidal ≥ random ≥ fair ≥ omniscient  (Panther tricks)\n`);

  const hunterTotals: Record<AgentMode, number> = {
    random: 0, fair: 0, omniscient: 0, suicidal: 0,
  };
  for (let d = 0; d < N_DEALS; d++) {
    for (const mode of MODES)
      hunterTotals[mode] += await runDeal(cfg, d + 1, "B", mode, "random", MC_ITERS);
  }

  console.log("Averages (Panther tricks/deal, lower = better Hunter play):");
  for (const mode of MODES)
    console.log(`  ${mode.padEnd(12)}: ${(hunterTotals[mode] / N_DEALS).toFixed(3)}`);

  const ha = Object.fromEntries(MODES.map(m => [m, hunterTotals[m] / N_DEALS]));
  checkOrdering([
    ["suicidal ≥ random   (suicidal Hunter helps Panther)", ha.suicidal >= ha.random   - 0.05],
    ["random   ≥ fair     (fair Hunter defends)",           ha.random   >= ha.fair     - 0.05],
    ["fair     ≥ omniscient",                               ha.fair     >= ha.omniscient - 0.05],
  ]);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
