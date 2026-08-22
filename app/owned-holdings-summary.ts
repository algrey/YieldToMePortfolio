// UI-031 (owner directive, verbatim): "Holdings should have a summary
// row ... four lines ... static at the bottom of the page ... shaded to be
// obviously different from the regular rows." Line 1: 'Unrealised' | total
// current market value | total daily gain amount | total gain amount.
// Line 2: blank | total cost basis | total daily percent | total percent.
// Line 3: 'All Time' + all-time gain including historical sold shares and
// unrealised gains, format "+$333,000 (+33.19%)". Line 4: 'Realised' +
// total capital gain for sold shares, same format.
//
// This module composes the two SERVER-COMPUTED, already-honest inputs
// (never re-deriving either):
//  - `unrealisedSummary` (`app/owned-holdings.ts`'s `loadOwnedHoldings`
//    return value) -- portfolio-wide market value / cost basis / daily
//    movement, built from the SAME holdings rows the list renders.
//  - `realisedTotals` (`app/owned-capital-gains.ts`'s
//    `loadOwnedRealisedGainTotals`'s `bySecurity` map) -- UI-030's
//    per-security lifetime realised-gain rollup, summed portfolio-wide by
//    `computePortfolioRealisedGainTotal` (`domain/gains/security-totals.ts`).
//
// Orchestrator ruling: portfolio-level percents are ALWAYS `Σ movement ÷ Σ
// previous value` / `Σ gain ÷ Σ basis`, never an average of row percents;
// every percent's denominator excludes exactly the same rows its numerator
// excludes; any row missing a price/basis/movement/CGT fact makes the
// AFFECTED total (and only that total) honestly qualified, never silently
// summed as zero. `realisedTotals === undefined` means the CGT enrichment
// itself failed to load for this request (`app/authenticated-workspace.ts`
// treats that as best-effort, mirroring UI-030) -- lines 3/4 then read
// "unavailable" rather than guessing.
import {
  addDecimal,
  divideDecimal,
  formatDecimalExact,
  formatDecimalTrimmed,
  isZero,
  multiplyDecimal,
  parseDecimalResult,
} from "../domain/calculations/index.ts";
import {
  computePortfolioRealisedGainTotal,
  type PortfolioRealisedGainTotal,
  type SecurityRealisedGainTotal,
} from "../domain/gains/index.ts";
import type {
  OwnedHoldingsUnrealisedSummary,
  OwnedHoldingValue,
} from "./owned-holdings-contract.ts";

const HUNDRED = parseDecimalResult("100");

function available(currencyCode: string, value: string): OwnedHoldingValue {
  return { status: "available", currencyCode, value, reason: null };
}
function unavailable(currencyCode: string, reason: string): OwnedHoldingValue {
  return { status: "unavailable", currencyCode, value: null, reason };
}
function percent(value: string | null, reason: string): OwnedHoldingValue {
  return value === null ? unavailable("%", reason) : available("%", value);
}

function holdingsNoun(count: number): string {
  return count === 1 ? "holding" : "holdings";
}
function lotMatchNoun(count: number): string {
  return count === 1 ? "lot match" : "lot matches";
}

// UI-031 (review fold F1): the number of holdings EXCLUDED from a
// `composePortfolioTotals`/`composePortfolioDailyMovementTotal` aligned
// set. Both functions already track the EXACT excluded set via
// `coverage.excludedHoldingIds` (nonzero-but-unaligned holdings AND
// invalid ones, e.g. a malformed decimal) -- using that length directly,
// rather than `nonZeroHoldingCount - alignedHoldingCount`, is required:
// the subtraction silently omits invalid rows (which are neither "zero"
// nor "aligned" nor counted in `alignedHoldingCount`), understating the
// qualifier's count whenever an invalid holding exists alongside the
// excluded ones.
function excludedHoldingCount(coverage: {
  excludedHoldingIds: readonly string[];
}): number {
  return coverage.excludedHoldingIds.length;
}

export type HoldingsSummaryFooter = {
  currencyCode: string;
  marketValue: OwnedHoldingValue;
  dailyMovement: OwnedHoldingValue;
  unrealisedGain: OwnedHoldingValue;
  costBasis: OwnedHoldingValue;
  dailyPercent: OwnedHoldingValue;
  totalPercent: OwnedHoldingValue;
  allTimeGain: OwnedHoldingValue;
  allTimePercent: OwnedHoldingValue;
  realisedGain: OwnedHoldingValue;
  realisedPercent: OwnedHoldingValue;
  /** Reachable honest qualifier for market value / cost basis / unrealised gain / total percent -- `null` when nothing was excluded. */
  valueQualifier: string | null;
  /** Reachable honest qualifier for daily movement / daily percent -- a DIFFERENT excluded set than `valueQualifier` (see `composePortfolioDailyMovementTotal`'s header comment); `null` when nothing was excluded. */
  dailyQualifier: string | null;
  allTimeQualifier: string | null;
  realisedQualifier: string | null;
};

/**
 * Portfolio-wide realised rollup, reused verbatim by both the "All Time"
 * and "Realised" lines below -- computed ONCE here from UI-030's
 * per-security map, never re-derived per line.
 */
function realisedTotal(
  bySecurity: Record<string, SecurityRealisedGainTotal> | undefined,
): PortfolioRealisedGainTotal | null {
  return bySecurity === undefined
    ? null
    : computePortfolioRealisedGainTotal(Object.values(bySecurity));
}

export function buildHoldingsSummaryFooter(
  homeCurrencyCode: string,
  unrealisedSummary: OwnedHoldingsUnrealisedSummary,
  bySecurity: Record<string, SecurityRealisedGainTotal> | undefined,
): HoldingsSummaryFooter {
  const value = unrealisedSummary.value;
  const daily = unrealisedSummary.daily;

  const marketValue =
    value.status === "unavailable"
      ? unavailable(homeCurrencyCode, "missing_price")
      : available(homeCurrencyCode, value.amounts.investedValueDecimal);
  const costBasis =
    value.status === "unavailable"
      ? unavailable(homeCurrencyCode, "missing_basis")
      : available(homeCurrencyCode, value.amounts.coveredOpenBasisDecimal);
  const unrealisedGain =
    value.status === "unavailable"
      ? unavailable(homeCurrencyCode, "missing_basis")
      : available(homeCurrencyCode, value.amounts.unrealisedGainDecimal);
  const totalPercent =
    value.status === "unavailable"
      ? percent(null, "missing_basis")
      : isZero(parseDecimalResult(value.amounts.coveredOpenBasisDecimal))
        ? percent(null, "zero_basis")
        : percent(
            formatDecimalTrimmed(
              multiplyDecimal(
                divideDecimal(
                  parseDecimalResult(value.amounts.unrealisedGainDecimal),
                  parseDecimalResult(value.amounts.coveredOpenBasisDecimal),
                ),
                HUNDRED,
              ),
              2,
            ),
            "zero_basis",
          );
  const excludedValueCount =
    value.status === "unavailable" ? 0 : excludedHoldingCount(value.coverage);
  const valueQualifier =
    excludedValueCount > 0
      ? `excludes ${excludedValueCount} ${holdingsNoun(excludedValueCount)} without both a price and a cost basis`
      : null;

  const dailyMovement =
    daily.status === "unavailable"
      ? unavailable(homeCurrencyCode, "missing_previous_fx")
      : available(homeCurrencyCode, daily.amounts.dailyMovementDecimal);
  const dailyPercent =
    daily.status === "unavailable"
      ? percent(null, "missing_previous_fx")
      : percent(daily.amounts.dailyPercentDecimal, "zero_previous_value");
  const excludedDailyCount =
    daily.status === "unavailable" ? 0 : excludedHoldingCount(daily.coverage);
  const dailyQualifier =
    excludedDailyCount > 0
      ? `excludes ${excludedDailyCount} ${holdingsNoun(excludedDailyCount)} without a comparable daily movement`
      : null;

  const realised = realisedTotal(bySecurity);

  // UI-030's own three tiers, applied portfolio-wide: never sold anywhere
  // (disposalCount 0) is a genuine zero, not a missing figure; every lot
  // match's basis unknown (knownDisposalCount 0, but disposalCount > 0) is
  // honestly unavailable rather than a fabricated $0; a MIX of known and
  // unknown lot matches shows the known partial sum with a qualifier and
  // suppresses the percent (never a partial figure presented as complete).
  let realisedGain: OwnedHoldingValue;
  let realisedPercent: OwnedHoldingValue;
  let realisedQualifier: string | null;
  let realisedAllIncomplete = false;
  if (realised === null) {
    realisedGain = unavailable(homeCurrencyCode, "realised_gains_unavailable");
    realisedPercent = percent(null, "realised_gains_unavailable");
    realisedQualifier = null;
  } else if (realised.disposalCount > 0 && realised.knownDisposalCount === 0) {
    realisedAllIncomplete = true;
    realisedGain = unavailable(homeCurrencyCode, "incomplete_basis");
    realisedPercent = percent(null, "incomplete_basis");
    realisedQualifier = null;
  } else {
    realisedGain = available(homeCurrencyCode, realised.gainDecimal);
    realisedPercent = realised.partialCoverage
      ? percent(null, "incomplete_basis")
      : percent(realised.percentDecimal, "zero_basis");
    realisedQualifier = realised.partialCoverage
      ? `partial -- excludes ${realised.excludedIncompleteCount} of ${realised.disposalCount} ${lotMatchNoun(realised.disposalCount)}, cost basis incomplete`
      : null;
  }

  // All-time = realised + unrealised (Orchestrator ruling). Requires BOTH
  // sides to have at least a KNOWN figure -- if the unrealised side is
  // entirely unavailable (no holding has both a known price and basis) or
  // every realised lot match anywhere is incomplete, there is no honest
  // combined number to show at all. Computed as plain decimal strings
  // first (never through the `OwnedHoldingValue` wrapper) so there is no
  // need to unwrap/assert a union type back down to its "available" arm.
  let allTimeGain: OwnedHoldingValue;
  let allTimePercent: OwnedHoldingValue;
  let allTimeQualifier: string | null;
  if (realised === null) {
    allTimeGain = unavailable(homeCurrencyCode, "realised_gains_unavailable");
    allTimePercent = percent(null, "realised_gains_unavailable");
    allTimeQualifier = null;
  } else if (realisedAllIncomplete || value.status === "unavailable") {
    allTimeGain = unavailable(
      homeCurrencyCode,
      realisedAllIncomplete ? "incomplete_basis" : "missing_basis",
    );
    allTimePercent = percent(
      null,
      realisedAllIncomplete ? "incomplete_basis" : "missing_basis",
    );
    allTimeQualifier = null;
  } else {
    const gainDecimal = formatDecimalExact(
      addDecimal(
        parseDecimalResult(realised.gainDecimal),
        parseDecimalResult(value.amounts.unrealisedGainDecimal),
      ),
    );
    const basisDecimal = formatDecimalExact(
      addDecimal(
        parseDecimalResult(realised.basisAtDisposalDecimal),
        parseDecimalResult(value.amounts.coveredOpenBasisDecimal),
      ),
    );
    const partial = realised.partialCoverage || excludedValueCount > 0;
    allTimeGain = available(homeCurrencyCode, gainDecimal);
    allTimePercent = partial
      ? percent(null, "incomplete_basis")
      : isZero(parseDecimalResult(basisDecimal))
        ? percent(null, "zero_basis")
        : percent(
            formatDecimalTrimmed(
              multiplyDecimal(
                divideDecimal(
                  parseDecimalResult(gainDecimal),
                  parseDecimalResult(basisDecimal),
                ),
                HUNDRED,
              ),
              2,
            ),
            "zero_basis",
          );
    const parts: string[] = [];
    if (excludedValueCount > 0)
      parts.push(
        `${excludedValueCount} ${holdingsNoun(excludedValueCount)} without both a price and a cost basis`,
      );
    if (realised.partialCoverage)
      parts.push(
        `${realised.excludedIncompleteCount} of ${realised.disposalCount} ${lotMatchNoun(realised.disposalCount)} with incomplete cost basis`,
      );
    allTimeQualifier =
      parts.length > 0 ? `partial -- excludes ${parts.join(" and ")}` : null;
  }

  return {
    currencyCode: homeCurrencyCode,
    marketValue,
    dailyMovement,
    unrealisedGain,
    costBasis,
    dailyPercent,
    totalPercent,
    allTimeGain,
    allTimePercent,
    realisedGain,
    realisedPercent,
    valueQualifier,
    dailyQualifier,
    allTimeQualifier,
    realisedQualifier,
  };
}
