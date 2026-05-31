/**
 * exp_pricing.ts — pure arithmetic sweep over scoring vectors.
 *
 * Input: fixed outcome distributions from exp_substrate (N=5000 run).
 * No simulation; everything here is closed-form from the substrate.
 *
 * Notation:
 *   s / m / l   = small / medium / large Panther reward on a make tier
 *   nil_pts     = Panther reward when Panther Defends makes (one tier, no ladder)
 *   P           = Hunter reward per Hunter on a fail
 *
 * Formulas:
 *   EV_Pnth(contract) = Σ(tier_prob × tier_reward) − fail_prob × P
 *   EV_Hntr(contract) = fail_prob × P
 *
 *   Envelope = max(EV_Pnth over all three contracts)
 *   Neutral gap = EV_Pnth(envelope contract) − EV_Hntr(envelope contract)
 *   Positive gap → Panther-favoured; negative → Hunter-favoured.
 *
 *   Neutrality P* = exact penalty where EV_Pnth(envelope) = EV_Hntr(envelope).
 *
 * Key structural fact (derivable, not an assumption):
 *   Both Attack always dominates Both Defend at the same (s,m,l,P).
 *   Reason: BA has lower fail rate (0.6196 vs 0.6832) AND weakly higher
 *   make-tier probabilities.  BD is only viable via deal-selection effects
 *   (some hands have much better defend distributions than attack) — outside
 *   the scope of this unconditional sweep.
 *
 * Panther Defends nil_pts:
 *   Swept independently because it's a single tier, not a tier in the ladder.
 *   Candidates: tied to m (conservative), tied to l (standard), l+bonus (generous).
 *
 * Run:  npx tsx exp_pricing.ts
 */

// ---------------------------------------------------------------------------
// Substrate distributions (from exp_substrate, N=5000 run)
// ---------------------------------------------------------------------------
const S = {
  BA: { small: 0.2168, med: 0.1224, large: 0.0412, fail: 0.6196 },
  BD: { small: 0.1862, med: 0.0978, large: 0.0328, fail: 0.6832 },
  PD: { make:  0.2886, fail: 0.7114 },
} as const;

// ---------------------------------------------------------------------------
// Core calculation for one (s, m, l, nil_pts, P) vector.
// ---------------------------------------------------------------------------
interface ContractEV { ev: number; hunterEV: number; }
interface Result {
  evBA: ContractEV; evBD: ContractEV; evPD: ContractEV;
  envelope: { name: string; ev: number; hunterEV: number; gap: number };
  neutralP: number;   // exact P* where envelope EV = Hunter EV (may be ≤ 0)
}

function compute(s: number, m: number, l: number, nil_pts: number, P: number): Result {
  const calcEV = (pS: number, pM: number, pL: number, pF: number): ContractEV => ({
    ev:       pS * s + pM * m + pL * l - pF * P,
    hunterEV: pF * P,
  });
  const evBA = calcEV(S.BA.small, S.BA.med, S.BA.large, S.BA.fail);
  const evBD = calcEV(S.BD.small, S.BD.med, S.BD.large, S.BD.fail);
  const evPD: ContractEV = {
    ev:       S.PD.make * nil_pts - S.PD.fail * P,
    hunterEV: S.PD.fail * P,
  };

  // Envelope = contract with highest Panther EV.
  let env: { name: string; ev: number; hunterEV: number };
  if (evBA.ev >= evBD.ev && evBA.ev >= evPD.ev)
    env = { name: "BA", ev: evBA.ev, hunterEV: evBA.hunterEV };
  else if (evBD.ev >= evPD.ev)
    env = { name: "BD", ev: evBD.ev, hunterEV: evBD.hunterEV };
  else
    env = { name: "PD", ev: evPD.ev, hunterEV: evPD.hunterEV };

  // Neutrality P*: solve EV(envelope contract) = HunterEV(envelope contract)
  //   Pnth make-sum - fail×P* = fail×P*  →  P* = make-sum / (2×fail)
  let makeSum: number, failProb: number;
  if (env.name === "BA") {
    makeSum  = S.BA.small * s + S.BA.med * m + S.BA.large * l;
    failProb = S.BA.fail;
  } else if (env.name === "BD") {
    makeSum  = S.BD.small * s + S.BD.med * m + S.BD.large * l;
    failProb = S.BD.fail;
  } else {
    makeSum  = S.PD.make * nil_pts;
    failProb = S.PD.fail;
  }
  const neutralP = makeSum / (2 * failProb);

  return {
    evBA, evBD, evPD,
    envelope: { ...env, gap: env.ev - env.hunterEV },
    neutralP,
  };
}

// ---------------------------------------------------------------------------
// Sweep grid
// ---------------------------------------------------------------------------
// Ladders: (s, m, l) — a handful of compressed and graduated options.
const LADDERS: [number, number, number, string][] = [
  [1, 2, 5, "1/2/5 (original, steep)"],
  [2, 3, 4, "2/3/4 (user example, compressed)"],
  [1, 3, 5, "1/3/5 (linear)"],
  [2, 4, 7, "2/4/7 (steep large)"],
  [3, 4, 5, "3/4/5 (tight, shifted up)"],
];

// nil_pts options for Panther Defends.
// "= m", "= l", "= l+1" — we'll show these as separate sub-rows.
// For legibility, express each as a function of (s, m, l).
const NIL_MODES: [string, (s: number, m: number, l: number) => number][] = [
  ["nil=m", (_s, m, _l) => m],
  ["nil=l", (_s, _m, l) => l],
];

// Penalties to sweep.
const PENALTIES = [1, 2, 3];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
function fmt(x: number, width = 7): string {
  return (x >= 0 ? "+" : "") + x.toFixed(3).padStart(width);
}

// Header for one block (ladder + nil mode).
function printBlock(
  ladderLabel: string, nilMode: string,
  s: number, m: number, l: number, nilPts: number,
) {
  console.log(`\nLadder ${ladderLabel}  ${nilMode}(=${nilPts})`);
  const colW = 9;
  const rowHdr =
    "  P".padEnd(5) +
    "BA EV".padStart(colW) + "BD EV".padStart(colW) + "PD EV".padStart(colW) +
    "  Envelope".padEnd(14) +
    "Env-EV".padStart(colW) + "Htr-EV".padStart(colW) + "  gap".padStart(colW) +
    "  P*".padStart(7);
  console.log(rowHdr);
  console.log("  " + "─".repeat(rowHdr.length - 2));

  for (const P of PENALTIES) {
    const r = compute(s, m, l, nilPts, P);
    const envLabel = r.envelope.name.padEnd(3);
    const gapStr   = fmt(r.envelope.gap, 7);
    const starStr  = r.neutralP <= 0 ? "  (never)" : r.neutralP.toFixed(2).padStart(6);
    console.log(
      "  " + String(P).padEnd(3) +
      fmt(r.evBA.ev).padStart(colW) +
      fmt(r.evBD.ev).padStart(colW) +
      fmt(r.evPD.ev).padStart(colW) +
      "  " + envLabel + " " +
      fmt(r.envelope.ev).padStart(colW - 2) +
      fmt(r.envelope.hunterEV).padStart(colW) +
      gapStr.padStart(colW) +
      starStr,
    );
  }
}

console.log("exp_pricing — scoring vector sweep (no simulation; arithmetic on substrate)");
console.log("\nSubstrate (binary MC, N=5000, Panther selects trump):");
console.log(`  Both Attack:     small(p+c=7)=${S.BA.small}  med(=8)=${S.BA.med}  large(≥9)=${S.BA.large}  fail(≤6)=${S.BA.fail}`);
console.log(`  Both Defend:     small(p+c=3)=${S.BD.small}  med(=2)=${S.BD.med}  large(≤1)=${S.BD.large}  fail(≥4)=${S.BD.fail}`);
console.log(`  Panther Defends: make(p=0)=${S.PD.make}  fail(≥1)=${S.PD.fail}`);
console.log(`\nFormulas:`);
console.log(`  EV_Panther = Σ(tier_prob × reward) − fail_prob × P`);
console.log(`  EV_Hunter  = fail_prob × P`);
console.log(`  Envelope   = max(EV_Panther over 3 contracts); Panther picks this.`);
console.log(`  P*         = exact penalty for EV_Panther(envelope) = EV_Hunter(envelope).`);
console.log(`  gap        = EV_Panther(envelope) − EV_Hunter(envelope):`);
console.log(`               positive = Panther-favoured, negative = Hunter-favoured.`);
console.log(`\n⚠  Both Attack dominates Both Defend at any (s,m,l,P): lower fail rate`);
console.log(`   (${S.BA.fail} vs ${S.BD.fail}) and weakly higher tier probs.  BD viable only via`);
console.log(`   deal-selection (some hands are much better for defend). Shown here for`);
console.log(`   completeness; will separate once selection is modelled.`);

for (const [s, m, l, ladderLabel] of LADDERS) {
  for (const [nilMode, nilFn] of NIL_MODES) {
    const nilPts = nilFn(s, m, l);
    printBlock(ladderLabel, nilMode, s, m, l, nilPts);
  }
}

// ---------------------------------------------------------------------------
// Summary: for each ladder × nil mode, the penalty P closest to P* and the
// gap at that integer P.
// ---------------------------------------------------------------------------
console.log("\n\n━━━ Closest-to-neutral integer P for each ladder × nil setting ━━━");
const sumHdr = "  Ladder".padEnd(32) + "nilMode".padEnd(10) +
  "P*".padStart(6) + "  closest_P".padEnd(12) +
  "EnvCtract".padEnd(10) + "  gap@P".padStart(10);
console.log(sumHdr);
console.log("  " + "─".repeat(sumHdr.length - 2));

for (const [s, m, l, ladderLabel] of LADDERS) {
  for (const [nilMode, nilFn] of NIL_MODES) {
    const nilPts = nilFn(s, m, l);
    // Find P* at the "midpoint" penalty (use P=1 to get the envelope name, then recompute P*)
    const mid = compute(s, m, l, nilPts, 1);
    // Recompute P* properly using the actual envelope identity (might change with P)
    // Use a small binary search to confirm the envelope identity around P*.
    let pStar = mid.neutralP;
    let env   = mid.envelope.name;
    // Re-evaluate at P*: which contract is truly envelope there?
    const atPStar = compute(s, m, l, nilPts, pStar);
    env   = atPStar.envelope.name;
    pStar = atPStar.neutralP;  // might differ if envelope flipped

    const closestP = Math.round(pStar);
    const atP = compute(s, m, l, nilPts, Math.max(1, closestP));
    const gap = atP.envelope.gap;

    console.log(
      "  " + ladderLabel.padEnd(30) +
      nilMode.padEnd(10) +
      pStar.toFixed(2).padStart(6) +
      "  " + String(Math.max(1, closestP)).padEnd(10) +
      atP.envelope.name.padEnd(10) +
      fmt(gap, 8),
    );
  }
}
