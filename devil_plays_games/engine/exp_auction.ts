/**
 * exp_auction.ts — pluggable BIDDING strategies under SPADES-style scoring.
 *
 * Scoring (Hunters score NOTHING; defense is purely relative in the race):
 *   Panther makes bid : +bidPts·bid + overPts·(tricks − bid)
 *   Panther fails     : −failPts·bid
 * This prices BOTH failure modes: overbidding is set (−failPts·bid), and
 * underbidding leaves contracted points on the table (an overtrick is worth
 * overPts, far less than bidPts), so accurate bidding wins.
 *
 * Bid strategies (each produces a "ceiling" = highest contract it will accept;
 * the auction is ascending, you bid the floor if ≤ ceiling else pass):
 *   MC      — Tier-1 bot: estimate make-prob from own hand + Crow, set ceiling =
 *             highest b whose empirical EV under the scoring is ≥ 0. Threshold is
 *             DERIVED from the scoring numbers, not hand-tuned.
 *   RND     — random ceiling (skill-value probe: how much does bidding skill matter?)
 *   K0..K7  — fixed ceiling = k (probes for a degenerate dominant constant bid).
 *
 * NOTE: card PLAY is random by default (SKILL=R). Justified: the trick
 * distribution is M≈O at equal skill, so make-probs barely move with play skill,
 * and random is ~10× cheaper. Set SKILL=M to verify.
 *
 * Run:  GAMES=200 GOAL=100 BID_PTS=10 OVER_PTS=2 FAIL_PTS=10 MINBID=1 \
 *       SAMPLES=12 SKILL=R tsx exp_auction.ts          # sweep MC/RND/K0..K7 vs 2 MC
 *       tsx exp_auction.ts MC K5 RND                    # one explicit 3-way matchup
 */
import { Rng, Player, run, Answerer, Choice } from "./core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, deck, newState, playTricks,
  clockwise, Bid, firstLeadSeat,
} from "./panther.js";
import { makePlayer, PlayerKind } from "./players.js";
import { trumpCandidates, TrumpChoice } from "./trump.js";
import { State, Card } from "./cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];

type Strat = { kind: "MC" } | { kind: "RND" } | { kind: "K"; n: number };

function parseStrat(s: string): Strat | null {
  const u = s.toUpperCase();
  if (u === "MC") return { kind: "MC" };
  if (u === "RND") return { kind: "RND" };
  const m = /^K(\d+)$/i.exec(s);
  return m ? { kind: "K", n: parseInt(m[1]) } : null;
}
function stratLabel(s: Strat): string {
  return s.kind === "K" ? `K${s.n}` : s.kind;
}

function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }
function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

interface GameOpts {
  cfg: PantherConfig; goal: number;
  bidPts: number; overPts: number; failPts: number;
  minBid: number; samples: number; skill: PlayerKind;
}

/** Points the Panther scores for `tricks` against a contract of `bid`. */
function pantherScore(tricks: number, bid: number, o: GameOpts): number {
  return tricks >= bid ? o.bidPts * bid + o.overPts * (tricks - bid) : -o.failPts * bid;
}

// ---------------------------------------------------------------------------
// Play a fully-specified hand out at the given skill; return Panther tricks.
// ---------------------------------------------------------------------------
async function playOut(
  cfg: PantherConfig, handBy: Record<Player, Card[]>, crow: Card[], woods: Card[],
  dealer: Player, panther: Player, choice: TrumpChoice, bidTricks: number,
  skill: PlayerKind, seed: number,
): Promise<number> {
  const hs = calcHandSize(cfg);
  const st = newState(PLAYERS, new Rng(seed));
  st.emit("HandStart", { dealer });

  // Populate zones AND emit the DealReveal events that viewFor-based MC players
  // reconstruct their hand + the Crow from. Visibility matches cards.ts deal():
  // a hand is seen only by its owner, the Crow is public, the Woods hidden.
  const reveal = (dst: string, cards: Card[], seen: ReadonlySet<Player> | null) => {
    st.z(dst).cards = [...cards];
    for (const c of cards) st.emit("DealReveal", { src: "deck", dst, card: c }, seen);
  };
  for (const p of PLAYERS) reveal(`hand:${p}`, handBy[p], new Set([p]));
  reveal("crow", crow, null);
  reveal("woods", woods, new Set<Player>());

  const order = clockwise(PLAYERS, dealer);
  const seats: [Player, string][] = [];
  for (const p of order) {
    seats.push([p, `hand:${p}`]);
    if (p === panther) seats.push([panther, "crow"]);
  }
  st.vars.trump = choice.perilsOnly ? null : choice.trump;
  st.vars.seats = seats;
  st.vars.panther = panther;
  const bid: Bid = { tricks: bidTricks, trump: choice.trump, perilsOnly: choice.perilsOnly };
  st.emit("Bid", { player: panther, ...bid });

  const answerers = new Map<Player | null, Answerer>();
  PLAYERS.forEach((p, i) =>
    answerers.set(p, makePlayer(skill, p, st, PLAYERS, cfg, new Rng(seed * 31 + i + 1), 12)));
  const fb = new Rng(seed * 911 + 7);
  answerers.set(null, { answer: (r: Choice) => fb.choice(r.options) });

  await run(playTricks(st, {
    seats, lead: firstLeadSeat(seats, panther, PLAYERS, cfg),
    handSize: hs, panther, bid,
    trickNum: 0, partialPlays: [], partialLed: null, forcedFromPartials: null,
    won: Object.fromEntries(PLAYERS.map(p => [p, 0])), crowWon: 0,
  }, cfg), answerers);

  return st.log.filter(e =>
    e.type === "TrickWon" &&
    (e.payload.seat === `hand:${panther}` || e.payload.seat === "crow")
  ).length;
}

// ---------------------------------------------------------------------------
// Estimate a player's realized-trick samples + best trump from own hand + Crow.
// ---------------------------------------------------------------------------
async function estimate(
  cfg: PantherConfig, myHand: Card[], crow: Card[], dealer: Player, me: Player,
  samples: number, rng: Rng,
): Promise<{ choice: TrumpChoice; realized: number[] }> {
  const hs = calcHandSize(cfg);
  const known = new Set<string>([...myHand, ...crow].map(cardId));
  const pool = deck(cfg).filter(c => !known.has(cardId(c)));
  const others = PLAYERS.filter(p => p !== me);
  const cands = trumpCandidates(false);

  let best: { choice: TrumpChoice; realized: number[]; ev: number } | null = null;
  for (const choice of cands) {
    const realized: number[] = [];
    for (let s = 0; s < samples; s++) {
      const sh = [...pool]; rng.shuffle(sh);
      const handBy: Record<Player, Card[]> = { [me]: [...myHand] } as any;
      let off = 0;
      for (const ot of others) { handBy[ot] = sh.slice(off, off + hs); off += hs; }
      const woods = sh.slice(off, off + cfg.woodsSize);
      realized.push(await playOut(cfg, handBy, crow, woods, dealer, me, choice, 1, "R", rng.int(2 ** 30)));
    }
    const ev = mean(realized);
    if (!best || ev > best.ev) best = { choice, realized, ev };
  }
  return { choice: best!.choice, realized: best!.realized };
}

/** MC ceiling: highest bid whose empirical EV (under the scoring) is ≥ 0. */
function mcCeiling(realized: number[], o: GameOpts): number {
  const hs = calcHandSize(o.cfg);
  let c = 0;
  for (let b = o.minBid; b <= hs; b++) {
    const ev = mean(realized.map(t => pantherScore(t, b, o)));
    if (ev >= 0) c = b;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Ascending auction over ceilings. First bidder can't pass (forced opener).
// ---------------------------------------------------------------------------
function auction(order: Player[], ceiling: Record<Player, number>, minBid: number) {
  const passed = new Set<Player>();
  let high = 0, highBidder: Player | null = null;
  let idx = 0, guard = 0;
  while (passed.size < order.length - 1 && guard++ < 1000) {
    const p = order[idx % order.length]; idx++;
    if (passed.has(p) || p === highBidder) continue;
    const floor = Math.max(high + 1, minBid);
    const forcedOpen = high === 0 && highBidder === null && p === order[0];
    if (floor <= ceiling[p]) { high = floor; highBidder = p; }
    else if (forcedOpen) { high = floor; highBidder = p; }
    else passed.add(p);
  }
  return { winner: highBidder ?? order[0], bid: Math.max(high, minBid) };
}

// ---------------------------------------------------------------------------
// One full game to GOAL; return winner (or null on tie) + probe stats.
// ---------------------------------------------------------------------------
interface GameResult {
  winner: Player | null;
  probeAsPanther: number; probeSuccess: number; bids: number[];      // probe-seat stats
  panBy: Record<Player, number>; succBy: Record<Player, number>;      // all-seat stats
  bidBy: Record<Player, number[]>;
}
async function playGame(
  strat: Record<Player, Strat>, probe: Player, gameSeed: number, o: GameOpts,
): Promise<GameResult> {
  const { cfg, goal, minBid, samples, skill } = o;
  const hs = calcHandSize(cfg);
  const scores: Record<Player, number> = { A: 0, B: 0, C: 0 };
  let dealer = PLAYERS[gameSeed % PLAYERS.length];
  let hands = 0, probeAsPanther = 0, probeSuccess = 0;
  const bids: number[] = [];
  const panBy: Record<Player, number> = { A: 0, B: 0, C: 0 };
  const succBy: Record<Player, number> = { A: 0, B: 0, C: 0 };
  const bidBy: Record<Player, number[]> = { A: [], B: [], C: [] };

  while (Math.max(...Object.values(scores)) < goal && hands < 60) {
    const seed = gameSeed * 100003 + hands * 31 + 1;
    const rng = new Rng(seed);
    const dst = newState(PLAYERS, rng);
    dst.z("deck").cards = deck(cfg); dst.shuffle("deck");
    const handBy: Record<Player, Card[]> = { A: [], B: [], C: [] };
    for (const p of PLAYERS) handBy[p] = dst.z("deck").cards.splice(0, hs);
    const crow = dst.z("deck").cards.splice(0, hs);
    const woods = dst.z("deck").cards.splice(0, cfg.woodsSize);

    const order = [...clockwise(PLAYERS, dealer).slice(1), dealer]; // left-of-dealer opens
    const ceiling: Record<Player, number> = { A: 0, B: 0, C: 0 };
    const cached: Record<Player, TrumpChoice | null> = { A: null, B: null, C: null };
    for (const p of PLAYERS) {
      const s = strat[p];
      if (s.kind === "K") ceiling[p] = Math.min(hs, Math.max(0, s.n));
      else if (s.kind === "RND") ceiling[p] = new Rng(seed * 7 + p.charCodeAt(0)).int(8); // 0..7
      else {
        const est = await estimate(cfg, handBy[p], crow, dealer, p, samples, new Rng(seed * 7 + p.charCodeAt(0)));
        ceiling[p] = mcCeiling(est.realized, o);
        cached[p] = est.choice;
      }
    }

    const { winner, bid } = auction(order, ceiling, minBid);
    let trump = cached[winner];
    if (!trump) {
      const est = await estimate(cfg, handBy[winner], crow, dealer, winner, samples, new Rng(seed * 13 + 99));
      trump = est.choice;
    }

    const tricks = await playOut(cfg, handBy, crow, woods, dealer, winner, trump, bid, skill, seed * 13 + 5);
    const made = tricks >= bid;
    scores[winner] += pantherScore(tricks, bid, o);

    panBy[winner]++; bidBy[winner].push(bid); if (made) succBy[winner]++;
    if (winner === probe) { probeAsPanther++; bids.push(bid); if (made) probeSuccess++; }
    hands++;
    dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length];
  }

  const top = Math.max(...Object.values(scores));
  const leaders = PLAYERS.filter(p => scores[p] === top);
  return {
    winner: leaders.length === 1 ? leaders[0] : null,
    probeAsPanther, probeSuccess, bids, panBy, succBy, bidBy,
  };
}

async function sweepRow(label: string, makeStrats: (probe: Player) => Record<Player, Strat>, games: number, o: GameOpts) {
  let wins = 0, pan = 0, succ = 0; const bids: number[] = [];
  for (let g = 0; g < games; g++) {
    const probe = PLAYERS[g % 3];
    const r = await playGame(makeStrats(probe), probe, g + 1, o);
    if (r.winner === probe) wins++;
    pan += r.probeAsPanther; succ += r.probeSuccess; bids.push(...r.bids);
  }
  console.log(`  ${label.padEnd(4)} ${(100 * wins / games).toFixed(1).padStart(5)}%   ${(pan / games).toFixed(2).padStart(6)}/game   ` +
    `${pan ? (100 * succ / pan).toFixed(0) : "–"}%    ${bids.length ? mean(bids).toFixed(2) : "–"}`);
}

async function main() {
  const o: GameOpts = {
    cfg: DEFAULT_CONFIG,
    goal: parseInt(process.env.GOAL ?? "100"),
    bidPts: parseInt(process.env.BID_PTS ?? "10"),
    overPts: parseInt(process.env.OVER_PTS ?? "2"),
    failPts: parseInt(process.env.FAIL_PTS ?? "10"),
    minBid: parseInt(process.env.MINBID ?? "1"),
    samples: parseInt(process.env.SAMPLES ?? "12"),
    skill: (process.env.SKILL ?? "R") as PlayerKind,
  };
  const GAMES = parseInt(process.env.GAMES ?? "200");
  const hs = calcHandSize(o.cfg);

  console.log(`auction sim — GAMES=${GAMES}, GOAL=${o.goal}, scoring +${o.bidPts}/bid +${o.overPts}/over −${o.failPts}/bid-fail (hunters 0)`);
  console.log(`minBid=${o.minBid}, samples=${o.samples}, play-skill=${o.skill}, handSize=${hs}\n`);

  const args = process.argv.slice(2).map(parseStrat);
  if (args.length === 3 && args.every(Boolean)) {
    const strats: Record<Player, Strat> = { A: args[0]!, B: args[1]!, C: args[2]! };
    console.log(`explicit: A=${stratLabel(strats.A)} B=${stratLabel(strats.B)} C=${stratLabel(strats.C)}`);
    console.log(`  seat   win%   becomes-panther   succ%   meanBid`);
    // Single pass: play each game ONCE; playGame now tallies all three seats.
    const wins: Record<Player, number> = { A: 0, B: 0, C: 0 };
    const pan: Record<Player, number> = { A: 0, B: 0, C: 0 };
    const succ: Record<Player, number> = { A: 0, B: 0, C: 0 };
    const bids: Record<Player, number[]> = { A: [], B: [], C: [] };
    let ties = 0;
    for (let g = 0; g < GAMES; g++) {
      const r = await playGame(strats, "A", g + 1, o);
      if (r.winner === null) ties++; else wins[r.winner]++;
      for (const seat of PLAYERS) {
        pan[seat] += r.panBy[seat];
        succ[seat] += r.succBy[seat];
        bids[seat].push(...r.bidBy[seat]);
      }
    }
    for (const seat of PLAYERS) {
      console.log(`  ${seat}:${stratLabel(strats[seat]).padEnd(3)} ${(100 * wins[seat] / GAMES).toFixed(1).padStart(5)}%   ` +
        `${(pan[seat] / GAMES).toFixed(2).padStart(6)}/game   ${pan[seat] ? (100 * succ[seat] / pan[seat]).toFixed(0) : "–"}%    ` +
        `${bids[seat].length ? mean(bids[seat]).toFixed(2) : "–"}`);
    }
    console.log(`  ties ${(100 * ties / GAMES).toFixed(1)}%`);
    return;
  }

  console.log(`probe vs two MC (probe rotated through all seats; fair share = 33.3%)\n`);
  console.log(`  who    win%   becomes-panther   succ%   meanBid`);
  await sweepRow("MC", () => ({ A: { kind: "MC" }, B: { kind: "MC" }, C: { kind: "MC" } }), GAMES, o);
  await sweepRow("RND", (probe) => {
    const s: Record<Player, Strat> = { A: { kind: "MC" }, B: { kind: "MC" }, C: { kind: "MC" } };
    s[probe] = { kind: "RND" }; return s;
  }, GAMES, o);
  for (let k = 0; k <= 7; k++) {
    await sweepRow(`K${k}`, (probe) => {
      const s: Record<Player, Strat> = { A: { kind: "MC" }, B: { kind: "MC" }, C: { kind: "MC" } };
      s[probe] = { kind: "K", n: k }; return s;
    }, GAMES, o);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
