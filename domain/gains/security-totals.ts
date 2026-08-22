// UI-030 (owner directive, verbatim): "In holdings, for any ticker row that
// has sold shares, there should be a forth line ... 'Realised: +$15000
// (+13.91%)'." Orchestrator ruling: the holdings row's fourth line is
// sourced from THIS same CGT-001A domain -- a LIFETIME, per-security
// rollup of already-derived disposal rows (`deriveCapitalGainDisposalRow`'s
// output, `disposal-rows.ts`), never a UI-layer FIFO recomputation and
// never a second calculation path.
//
// Unlike `fy-aggregation.ts` (which buckets by financial year for the tax
// disclosure screen), this module buckets by `portfolioSecurityId` and
// stays FY-agnostic -- a security's lifetime realised gain spans every FY
// it was ever sold in. "Basis at the time of the gain" (the owner's own
// phrase) is `basisDecimal` on each disposal row -- the allocated cost
// basis of the specific tax lot matched to that specific sell, exactly as
// CGT-001A already computed it.
//
// Reused, not rebuilt: `app/owned-capital-gains.ts` calls this ONCE per
// portfolio load (one batched SQL read, already bounded by
// `MAX_ALLOCATIONS`) and hands every disposal row to
// `computeSecurityRealisedGainTotals` in a single pass -- never a per-row
// query from the holdings screen. The resulting map is intentionally
// reusable for UI-031's later portfolio-wide summary row: that task sums
// this map's own `gainDecimal`/`basisAtDisposalDecimal` fields across every
// entry rather than re-deriving anything or re-reading the ledger.
//
// Informational estimate only -- NOT tax advice. See
// `docs/CALCULATIONS.md` section 14.
import {
  addDecimal,
  divideDecimal,
  formatDecimalExact,
  formatDecimalTrimmed,
  fromInteger,
  isZero,
  multiplyDecimal,
  parseDecimalResult,
  type DecimalFraction,
} from "../calculations/decimal.ts";
import type { CapitalGainDisposalRow } from "./disposal-rows.ts";

const ZERO = fromInteger(0n);
const HUNDRED = fromInteger(100n);

export type SecurityRealisedGainTotal = {
  portfolioSecurityId: string;
  /** Every disposal (lot-allocation match) attributed to this security, complete and incomplete alike -- ALLOCATIONS, not distinct sale transactions, mirroring `FyCapitalGainsTotal.disposalCount`'s meaning (see `disposal-rows.ts`/CGT-001A). */
  disposalCount: number;
  /** Disposals with a known (`basisStatus === 'complete'`) gain AND a known basis -- the only rows folded into `gainDecimal`/`basisAtDisposalDecimal` below. */
  knownDisposalCount: number;
  excludedIncompleteCount: number;
  /** True when at least one of this security's disposals has an unknown gain/basis -- `gainDecimal`/`basisAtDisposalDecimal` below are then a PARTIAL sum (the known disposals only), never a fabricated zero for the unknown ones. */
  partialCoverage: boolean;
  /** Sum of complete-basis realised gains, sign-preserving (a net loss renders negative). Exact decimal, no rounding. */
  gainDecimal: string;
  /** Sum of complete-basis allocated cost basis ("basis at the time of the gain") -- always >= 0. Exact decimal, no rounding. */
  basisAtDisposalDecimal: string;
  /** `gainDecimal` ÷ `basisAtDisposalDecimal` × 100, trimmed to 2dp (half-even, matching `app/owned-holdings.ts`'s own gain-percent convention) -- `null` when `basisAtDisposalDecimal` is zero (never a divide-by-zero, covers both the free-shares edge and the all-incomplete edge where the known-basis sum is itself empty). Callers must ALSO gate display on `partialCoverage`/`knownDisposalCount` per UI-030's honesty rule -- a non-null percent here is only trustworthy when coverage is complete. */
  percentDecimal: string | null;
};

function hasKnownGainAndBasis(
  row: CapitalGainDisposalRow,
): row is CapitalGainDisposalRow & {
  gainDecimal: string;
  basisDecimal: string;
} {
  return (
    row.basisStatus === "complete" &&
    row.gainDecimal !== null &&
    row.basisDecimal !== null
  );
}

function sumField(
  rows: readonly (CapitalGainDisposalRow & {
    gainDecimal: string;
    basisDecimal: string;
  })[],
  field: (row: (typeof rows)[number]) => string,
): DecimalFraction {
  return rows.reduce<DecimalFraction>(
    (total, row) => addDecimal(total, parseDecimalResult(field(row))),
    ZERO,
  );
}

/**
 * One batched pass over ALL of a portfolio's disposal rows (any FY, any
 * security), grouping into a per-`portfolioSecurityId` lifetime realised-
 * gain rollup. A security with zero disposal rows simply has no entry in
 * the returned map (no fabricated zero-gain entry for a never-sold
 * security) -- callers distinguish "never sold" (`map.get(id) ===
 * undefined`) from "sold, rollup available" this way.
 */
export function computeSecurityRealisedGainTotals(
  rows: readonly CapitalGainDisposalRow[],
): Map<string, SecurityRealisedGainTotal> {
  const bySecurity = new Map<string, CapitalGainDisposalRow[]>();
  for (const row of rows) {
    const list = bySecurity.get(row.portfolioSecurityId) ?? [];
    list.push(row);
    bySecurity.set(row.portfolioSecurityId, list);
  }

  const totals = new Map<string, SecurityRealisedGainTotal>();
  for (const [portfolioSecurityId, securityRows] of bySecurity) {
    const known = securityRows.filter(hasKnownGainAndBasis);
    const excludedIncompleteCount = securityRows.length - known.length;

    const gain = sumField(known, (row) => row.gainDecimal);
    const basis = sumField(known, (row) => row.basisDecimal);
    const percentDecimal = isZero(basis)
      ? null
      : formatDecimalTrimmed(
          multiplyDecimal(divideDecimal(gain, basis), HUNDRED),
          2,
        );

    totals.set(portfolioSecurityId, {
      portfolioSecurityId,
      disposalCount: securityRows.length,
      knownDisposalCount: known.length,
      excludedIncompleteCount,
      partialCoverage: excludedIncompleteCount > 0,
      gainDecimal: formatDecimalExact(gain),
      basisAtDisposalDecimal: formatDecimalExact(basis),
      percentDecimal,
    });
  }
  return totals;
}
