/**
 * exp_race.ts — minimal multi-hand RACE simulation, to test whether a flat
 * scoring scheme produces a live auction or a conservative collapse.
 *
 * This is the bidding rabbit hole, entered deliberately and narrowly. Unlike the
 * single-hand EV lenses, this plays whole games to a goal with a real ascending
 * auction, so it can see contention and (later) spoiler dynamics that single-hand
 * EV cannot.
 *
 * Scoring is FLAT (not bid-scaled), fully parameterized:
 *   - Panther meets/exceeds bid → +SUCCESS points
 *   - Panther fails             → +FAIL to EACH Hunter
 *   - first to GOAL wins
 *
 * Each hand:
 *   1. Deal. Every player privately estimates, from its OWN hand + the face-up
 *      Crow (the realistic info a bidder has), its make-prob curve as Panther —
 *      sampling the unseen cards, choosing its best trump, random rollouts.
 *   2. Comfortable bid = highest b with p(make) >= THRESHOLD (>= MINBID).
 *   3. Ascending auction (first bidder can't pass): winner = highest comfortable;
 *      final bid ratchets to runner-up + 1. Winner becomes Panther, plays its
 *      chosen trump.
 *   4. Play the hand (skill = SKILL), score, accumulate, rotate dealer.
 *
 * THRESHOLD is the conservative↔reckless dial. Metrics report which regime we're
 * in: mean winning bid, % auctions contested, Panther success rate, hands/game.
 *
 * Run:  GAMES=150 GOAL=10 SUCCESS=2 FAIL=1 THRESHOLD=0.6 MINBID=1 SAMPLES=16 \
 *       SKILL=R tsx exp_race.ts
 */
import { Rng, Player, run, Answerer, Choice } from "../../core.js";
import {
  PantherConfig, DEFAULT_CONFIG, calcHandSize, deck, newState, playTricks,
  clockwise, Bid, firstLeadSeat,
} from "../panther.js";
import { makePlayer, PlayerKind } from "../players.js";
import { trumpCandidates, TrumpChoice } from "../trump.js";
import { State, Card } from "../../cards.js";

const PLAYERS: Player[] = ["A", "B", "C"];

function cardId(c: Card): string { return `${c.get("suit")}|${c.get("rank")}`; }
function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

// ---------------------------------------------------------------------------
// Build a play-ready state from explicit zone contents, then run the hand out
// with the given skill. Returns Panther-side trick count.
// ---------------------------------------------------------------------------
async function playOut(
  cfg: PantherConfig, handBy: Record<Player, Card[]>, crow: Card[], woods: Card[],
  dealer: Player, panther: Player, choice: TrumpChoice, bidTricks: number,
  skill: PlayerKind, seed: number,
): Promise<number> {
  const hs = calcHandSize(cfg);
  const st = newState(PLAYERS, new Rng(seed));
  for (const p of PLAYERS) st.z(`hand:${p}`).cards = [...handBy[p]];
  st.z("crow").cards = [...crow];
  st.z("woods").cards = [...woods];

  const order = clockwise(PLAYERS, dealer);
  const seats: [Player, string][] = [];
  for (const p of order) {
    seats.push([p, `hand:${p}`]);
    if (p === panther) seats.push([panther, "crow"]);
  }
  st.vars.trump = choice.perilsOnly ? null : choice.trump;
  st.vars.seats = seats;
  st.vars.panther = panther;
  st.emit("HandStart", { dealer });
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
// Realistic bid estimation: player sees its own hand + the face-up Crow, samples
// the rest, and for each candidate trump runs random rollouts as Panther. Picks
// the best-EV trump; returns that trump + the make-prob curve p[b].
// ---------------------------------------------------------------------------
async function estimateCurve(
  cfg: PantherConfig, myHand: Card[], crow: Card[], dealer: Player, me: Player,
  samples: number, rng: Rng,
): Promise<{ choice: TrumpChoice; p: number[] }> {
  const hs = calcHandSize(cfg);
  const known = new Set<string>([...myHand, ...crow].map(cardId));
  const pool = deck(cfg).filter(c => !known.has(cardId(c)));
  const others = PLAYERS.filter(p => p !== me);
  const cands = trumpCandidates(false); // perils-only off for v1

  let best: { choice: TrumpChoice; p: number[]; ev: number } | null = null;
  for (const choice of cands) {
    const realized: number[] = [];
    for (let s = 0; s < samples; s++) {
      const shuffled = [...pool];
      rng.shuffle(shuffled);
      const handBy: Record<Player, Card[]> = { [me]: [...myHand] } as any;
      let off = 0;
      for (const o of others) { handBy[o] = shuffled.slice(off, off + hs); off += hs; }
      const woods = shuffled.slice(off, off + cfg.woodsSize);
      realized.push(await playOut(cfg, handBy, crow, woods, dealer, me, choice, 1, "R", rng.int(2 ** 30)));
    }
    const ev = mean(realized);
    const p: number[] = [];
    for (let b = 0; b <= hs; b++) p[b] = realized.filter(r => r >= b).length / samples;
    if (!best || ev > best.ev) best = { choice, p, ev };
  }
  return { choice: best!.choice, p: best!.p };
}

// ---------------------------------------------------------------------------
// Ascending auction. comfortable[p] = highest b with p(make) >= threshold (and
// >= minBid). First bidder in order can't pass (forced to open at minBid).
// Returns winner, final bid, and whether it was contested (>1 distinct bidder).
// ---------------------------------------------------------------------------
function auction(
  order: Player[], comfortable: Record<Player, number>, minBid: number,
): { winner: Player; bid: number; contested: boolean } {
  const passed = new Set<Player>();
  let high = 0;
  let highBidder: Player | null = null;
  const bidders = new Set<Player>();

  let idx = 0, guard = 0;
  while (passed.size < order.length - 1 && guard++ < 1000) {
    const p = order[idx % order.length]; idx++;
    if (passed.has(p) || p === highBidder) continue;
    const floor = Math.max(high + 1, minBid);
    const forcedOpen = high === 0 && highBidder === null && p === order[0];
    if (floor <= comfortable[p] || forcedOpen) {
      high = forcedOpen ? Math.max(minBid, high + 1) : floor;
      highBidder = p;
      bidders.add(p);
    } else {
      passed.add(p);
    }
  }
  return { winner: highBidder ?? order[0], bid: Math.max(high, minBid), contested: bidders.size > 1 };
}

async function main() {
  const GAMES = parseInt(process.env.GAMES ?? "150");
  const GOAL = parseInt(process.env.GOAL ?? "10");
  const SUCCESS = parseInt(process.env.SUCCESS ?? "2");
  const FAIL = parseInt(process.env.FAIL ?? "1");
  const THRESHOLD = parseFloat(process.env.THRESHOLD ?? "0.6");
  const MINBID = parseInt(process.env.MINBID ?? "1");
  const SAMPLES = parseInt(process.env.SAMPLES ?? "16");
  const SKILL = (process.env.SKILL ?? "R") as PlayerKind;
  const cfg = DEFAULT_CONFIG;
  const hs = calcHandSize(cfg);

  console.log(`race sim — GAMES=${GAMES}, GOAL=${GOAL}, scoring +${SUCCESS}/success +${FAIL}/hunter-fail`);
  console.log(`threshold=${THRESHOLD}, minBid=${MINBID}, samples=${SAMPLES}, skill=${SKILL}, handSize=${hs}\n`);

  let totalHands = 0;
  const winningBids: number[] = [];
  let contestedCount = 0, pantherSuccess = 0, handCount = 0;
  const bidHist = new Array(hs + 1).fill(0);
  let forcedOverbidFails = 0;

  for (let g = 0; g < GAMES; g++) {
    const scores: Record<Player, number> = { A: 0, B: 0, C: 0 };
    let dealer = PLAYERS[g % PLAYERS.length];
    let hands = 0;

    while (Math.max(...Object.values(scores)) < GOAL && hands < 60) {
      const seed = g * 100003 + hands * 31 + 1;
      const rng = new Rng(seed);
      // Deal a true hand.
      const dealSt: State = newState(PLAYERS, rng);
      dealSt.z("deck").cards = deck(cfg);
      dealSt.shuffle("deck");
      const handBy: Record<Player, Card[]> = { A: [], B: [], C: [] };
      for (const p of PLAYERS) handBy[p] = dealSt.z("deck").cards.splice(0, hs);
      const crow = dealSt.z("deck").cards.splice(0, hs);
      const woods = dealSt.z("deck").cards.splice(0, cfg.woodsSize);

      // Each player estimates its comfortable bid + chosen trump.
      const order = [...clockwise(PLAYERS, dealer).slice(1), dealer]; // left-of-dealer first
      const comfortable: Record<Player, number> = { A: 0, B: 0, C: 0 };
      const chosen: Record<Player, TrumpChoice> = {} as any;
      for (const p of PLAYERS) {
        const est = await estimateCurve(cfg, handBy[p], crow, dealer, p, SAMPLES, new Rng(seed * 7 + p.charCodeAt(0)));
        chosen[p] = est.choice;
        let c = 0;
        for (let b = MINBID; b <= hs; b++) if (est.p[b] >= THRESHOLD) c = b;
        comfortable[p] = c;
      }

      const { winner, bid, contested } = auction(order, comfortable, MINBID);
      const forcedOverbid = comfortable[winner] < bid; // won but bid past comfort (forced open)

      const tricks = await playOut(cfg, handBy, crow, woods, dealer, winner, chosen[winner], bid, SKILL, seed * 13 + 5);
      const made = tricks >= bid;
      if (made) scores[winner] += SUCCESS;
      else for (const p of PLAYERS) if (p !== winner) scores[p] += FAIL;

      winningBids.push(bid);
      bidHist[bid]++;
      if (contested) contestedCount++;
      if (made) pantherSuccess++;
      if (forcedOverbid && !made) forcedOverbidFails++;
      handCount++;
      hands++;
      dealer = PLAYERS[(PLAYERS.indexOf(dealer) + 1) % PLAYERS.length];
    }
    totalHands += hands;
  }

  console.log(`mean hands/game        : ${(totalHands / GAMES).toFixed(1)}`);
  console.log(`mean winning bid       : ${mean(winningBids).toFixed(2)}`);
  console.log(`auctions contested     : ${(100 * contestedCount / handCount).toFixed(1)}%`);
  console.log(`Panther success rate   : ${(100 * pantherSuccess / handCount).toFixed(1)}%`);
  console.log(`forced-open & failed   : ${(100 * forcedOverbidFails / handCount).toFixed(1)}% of hands\n`);
  console.log("winning-bid distribution:");
  for (let b = 0; b <= hs; b++) {
    if (bidHist[b] === 0) continue;
    const frac = bidHist[b] / handCount;
    console.log(`  ${String(b).padStart(2)} ${(100 * frac).toFixed(1).padStart(5)}%  ${"#".repeat(Math.round(frac * 60))}`);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
