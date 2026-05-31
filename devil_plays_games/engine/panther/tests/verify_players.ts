/**
 * verify_players.ts — sanity-check R / M / O / S from players.ts.
 *
 * Bidding is skipped: we deal, fix the Panther + trump, and emit the public
 * declaration (HandStart + Bid) so the viewFor-based players can read who the
 * Panther is and what trump is — exactly the public knowledge a real table has
 * after the auction. Then we play out the hand and count Panther tricks.
 *
 * Expected, with one skilled seat and the rest random:
 *   Panther seat:  O ≥ M ≥ R ≥ S      (S omniscient-suicidal = the floor)
 *   Hunter  seat:  S ≥ R ≥ M ≥ O      (lower Panther tricks = better defence)
 *
 * Run:  DEALS=100 ITER=30 tsx verify_players.ts
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, deck, newState, playTricks,
  Bid, firstLeadSeat, buildSeats,
} from "../panther.js";
import { makePlayer, PlayerKind } from "../players.js";

const PLAYERS: Player[] = ["A", "B", "C"];
const PANTHER: Player = "A";
const DEALER: Player = "C";
const TRUMP = "Spades";
const KINDS: PlayerKind[] = ["R", "M", "O", "S"];

/** Deal + declare, then play one hand with `kind` in `seat`, rest random. */
async function runDeal(
  cfg: PantherConfig, dealSeed: number, seat: Player, kind: PlayerKind, iters: number,
): Promise<number> {
  const hs = calcHandSize(cfg);
  const rng = new Rng(dealSeed);

  const st = newState(PLAYERS, rng);
  st.emit("HandStart", { dealer: DEALER });
  st.z("deck").cards = deck(cfg);
  st.shuffle("deck");
  for (const p of PLAYERS) st.deal("deck", `hand:${p}`, hs);
  st.deal("deck", "crow", hs);
  st.deal("deck", "woods", cfg.woodsSize);

  const seats = buildSeats(PLAYERS, PANTHER);
  st.vars.trump = TRUMP;
  st.vars.seats = seats;
  st.vars.panther = PANTHER;

  // Public declaration so viewFor players know the Panther + trump.
  const bid: Bid = { tricks: 1, trump: TRUMP, perilsOnly: false };
  st.emit("Bid", { player: PANTHER, ...bid });

  const agent = makePlayer(kind, seat, st, PLAYERS, cfg, new Rng(rng.int(2 ** 30)), iters);
  const randRng = new Rng(rng.int(2 ** 30));
  const random: Answerer = { answer: (r: Choice) => randRng.choice(r.options) };
  const answerers = new Map<Player | null, Answerer>([[seat, agent], [null, random]]);

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
    won:                Object.fromEntries(PLAYERS.map(p => [p, 0])),
    crowWon:            0,
  }, cfg), answerers);

  return st.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${PANTHER}` || e.payload.seat === "crow")
  ).length;
}

function report(title: string, avg: Record<PlayerKind, number>, checks: [string, boolean][]) {
  console.log(`\n${title}`);
  for (const k of KINDS) console.log(`  ${k}: ${avg[k].toFixed(3)}`);
  for (const [label, ok] of checks) console.log(`  ${ok ? "✓" : "✗ FAILED"}  ${label}`);
}

async function main() {
  const N = parseInt(process.env.DEALS ?? "100");
  const ITER = parseInt(process.env.ITER ?? "30");
  const cfg = DEFAULT_CONFIG;
  console.log(`players verification — ${N} deals, iters=${ITER}, handSize=${calcHandSize(cfg)}, trump=${TRUMP}`);

  // Panther seat.
  const pan: Record<PlayerKind, number> = { R: 0, M: 0, O: 0, S: 0 };
  for (let d = 0; d < N; d++)
    for (const k of KINDS) pan[k] += await runDeal(cfg, d + 1, PANTHER, k, ITER);
  for (const k of KINDS) pan[k] /= N;
  report("Panther seat (Panther tricks/deal) — expect O ≥ M ≥ R ≥ S", pan, [
    ["O ≥ M", pan.O >= pan.M - 0.05],
    ["M ≥ R", pan.M >= pan.R - 0.05],
    ["R ≥ S", pan.R >= pan.S - 0.05],
  ]);

  // Hunter seat (skilled Hunter on B).
  const hun: Record<PlayerKind, number> = { R: 0, M: 0, O: 0, S: 0 };
  for (let d = 0; d < N; d++)
    for (const k of KINDS) hun[k] += await runDeal(cfg, d + 1, "B", k, ITER);
  for (const k of KINDS) hun[k] /= N;
  report("Hunter seat on B (Panther tricks/deal, lower = better defence) — expect S ≥ R ≥ M ≥ O", hun, [
    ["S ≥ R", hun.S >= hun.R - 0.05],
    ["R ≥ M", hun.R >= hun.M - 0.05],
    ["M ≥ O", hun.M >= hun.O - 0.05],
  ]);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
