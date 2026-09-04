// BRK-019 slice 1: the shared, single-source-of-truth comparison this task's
// two consumers both need -- `domain/imports/reconciliation.ts` (preview-time
// `ROW_DIFFERS_FROM_COMMITTED_RECORD` detection, this task) and
// `app/sharesight-sync-service.ts` (BRK-014's `isRowAlreadyImported`,
// refactored by this task to call this module instead of its own private
// copy of the same three helpers). Extracted here -- rather than left
// duplicated, or exported from the `app/` layer for `domain/` to import,
// which would invert this codebase's layering -- so the two call sites can
// never independently drift on what counts as "the same value" the way
// BRK-014's own review rounds (1-4) repeatedly found the ORIGINAL, narrower
// comparison to have drifted from `canonicalRowDigestFields`'s value-bearing
// field list.
//
// Deliberately mirrors `db/repositories/sharesight-sync-state.ts`'s
// `loadCommittedSharesightRowValues` value shapes exactly (`CommittedTradeValues`/
// `CommittedDividendValues` below are structurally identical to that
// function's `SharesightCommittedRowValues.trades`/`.payouts` map value
// types) -- this module answers the same "does this row's own economic
// value still match what is currently committed under its identity"
// question that function's caller (`isRowAlreadyImported`) already asked,
// generalized so `app/import-review-queries.ts` (this task) can supply the
// SAME shape from a route-agnostic query (no `sharesight-` prefix filter),
// not just from Sharesight-prefixed rows.

import { compareDecimal, parseDecimal } from "../calculations/decimal.ts";

export type CommittedTradeValues = Readonly<{
  quantityDecimal: string | null;
  priceDecimal: string | null;
  feeAmountDecimal: string | null;
  localTradeDate: string | null;
  type: string | null;
  currencyCode: string | null;
}>;

export type CommittedDividendValues = Readonly<{
  cashTotalDecimal: string | null;
  totalFrankingDecimal: string | null;
  paymentDate: string | null;
  // BRK-014 round 3/round 4: populated only when `import-commit.ts` finds
  // the payout FOREIGN to its security's own currency -- a stored `null`
  // means "not independently recorded", never "changed" or "confirmed
  // equal". See `fxRateNotComparableOrMatches`/`currencyNotComparableOrMatches`
  // below.
  fxRateToPortfolioDecimal: string | null;
  currencyCode: string | null;
}>;

export type CommittedRecordFieldDifference = Readonly<{
  field: string;
  committed: string | null;
  incoming: string | null;
}>;

/**
 * BRK-014: exact-decimal equality, tolerant of a formatting difference
 * ("100" vs "100.00") the way every other decimal comparison in this
 * codebase is (AGENTS.md) -- never a literal string/`Number()` compare.
 * `null` matches `null` (both sides genuinely have no value); any other
 * mismatch, including one side `null` and the other not, or a parse
 * failure on a malformed stored value, returns `false`. Deliberately the
 * CONSERVATIVE direction: an uncertain comparison must never be mistaken
 * for "confirmed unchanged".
 */
export function decimalValuesMatch(
  incoming: string | null,
  existing: string | null,
): boolean {
  if (incoming === null && existing === null) return true;
  if (incoming === null || existing === null) return false;
  try {
    return compareDecimal(parseDecimal(incoming), parseDecimal(existing)) === 0;
  } catch {
    return false;
  }
}

/**
 * BRK-014 round 3: `dividend_manual_records.fx_rate_to_portfolio_decimal`
 * is only ever written when the payout is foreign to its security AND
 * Sharesight supplied a rate -- a stored `null` means "not independently
 * recorded", never "no rate supplied" and never "confirmed equal to the
 * incoming value". Treating a stored `null` as a mismatch would report
 * EVERY native-currency payout as changed. So this field is deliberately
 * NOT COMPARABLE when nothing is stored to compare against -- "not
 * comparable" here means "does not by itself indicate a change", the
 * opposite default from `decimalValuesMatch`.
 */
export function fxRateNotComparableOrMatches(
  incoming: string | null,
  storedFxRateToPortfolioDecimal: string | null,
): boolean {
  if (storedFxRateToPortfolioDecimal === null) return true;
  return decimalValuesMatch(incoming, storedFxRateToPortfolioDecimal);
}

/**
 * BRK-014 round 4: the currency counterpart of `fxRateNotComparableOrMatches`
 * above -- `dividend_manual_records.currency_code` is written under the same
 * foreign-to-security condition as the FX rate, so a stored `null` means
 * "native to its security, nothing independently recorded", never "changed".
 */
export function currencyNotComparableOrMatches(
  incoming: string | null,
  storedCurrencyCode: string | null,
): boolean {
  if (storedCurrencyCode === null) return true;
  return incoming === storedCurrencyCode;
}

/**
 * BRK-019 slice 1: field-by-field trade comparison, mirroring
 * `app/sharesight-sync-service.ts`'s (pre-this-task) `isRowAlreadyImported`
 * trade branch exactly -- the same six fields that branch already checked,
 * now exposed as an itemised difference list instead of a single boolean,
 * for the preview-time "what changed" disclosure. `feeAmountDecimal` is the
 * caller's responsibility to default (`commission ?? "0"`, matching
 * `import-commit.ts`'s own `feeAmountDecimal: normalized.commission ?? "0"`
 * mapping) -- never defaulted inside this pure comparison.
 */
export function tradeValueDifferences(
  incoming: Readonly<{
    type: string | null;
    localTradeDate: string | null;
    quantityDecimal: string | null;
    priceDecimal: string | null;
    feeAmountDecimal: string | null;
    currencyCode: string | null;
  }>,
  committed: CommittedTradeValues,
): CommittedRecordFieldDifference[] {
  const differences: CommittedRecordFieldDifference[] = [];
  if (
    !decimalValuesMatch(incoming.quantityDecimal, committed.quantityDecimal)
  ) {
    differences.push({
      field: "quantity",
      committed: committed.quantityDecimal,
      incoming: incoming.quantityDecimal,
    });
  }
  if (!decimalValuesMatch(incoming.priceDecimal, committed.priceDecimal)) {
    differences.push({
      field: "price",
      committed: committed.priceDecimal,
      incoming: incoming.priceDecimal,
    });
  }
  if (
    !decimalValuesMatch(incoming.feeAmountDecimal, committed.feeAmountDecimal)
  ) {
    differences.push({
      field: "fee",
      committed: committed.feeAmountDecimal,
      incoming: incoming.feeAmountDecimal,
    });
  }
  if (incoming.localTradeDate !== committed.localTradeDate) {
    differences.push({
      field: "trade date",
      committed: committed.localTradeDate,
      incoming: incoming.localTradeDate,
    });
  }
  if (incoming.type !== committed.type) {
    differences.push({
      field: "type",
      committed: committed.type,
      incoming: incoming.type,
    });
  }
  if (incoming.currencyCode !== committed.currencyCode) {
    differences.push({
      field: "currency",
      committed: committed.currencyCode,
      incoming: incoming.currencyCode,
    });
  }
  return differences;
}

/**
 * BRK-019 slice 1: field-by-field dividend comparison, mirroring
 * `isRowAlreadyImported`'s dividend branch (pre-this-task). `cashTotalDecimal`/
 * `totalFrankingDecimal` are the caller's own COMPUTED comparable totals
 * (`domain/imports/reconciliation.ts`'s `safeComputeDividendCashTotal`, the
 * same helper `DIVIDEND_MATCHES_EXISTING_ENTRY` already uses) -- passing the
 * computed total rather than a raw `totalCashDecimal` field is what lets
 * this comparison also work for a CSV PER-SHARE dividend row (which never
 * populates `totalCashDecimal` at all), not just a Sharesight totals-mode
 * payout.
 */
export function dividendValueDifferences(
  incoming: Readonly<{
    cashTotalDecimal: string | null;
    totalFrankingDecimal: string | null;
    paymentDate: string | null;
    fxRateToPortfolioDecimal: string | null;
    currencyCode: string | null;
  }>,
  committed: CommittedDividendValues,
): CommittedRecordFieldDifference[] {
  const differences: CommittedRecordFieldDifference[] = [];
  if (
    !decimalValuesMatch(incoming.cashTotalDecimal, committed.cashTotalDecimal)
  ) {
    differences.push({
      field: "cash total",
      committed: committed.cashTotalDecimal,
      incoming: incoming.cashTotalDecimal,
    });
  }
  if (
    !decimalValuesMatch(
      incoming.totalFrankingDecimal,
      committed.totalFrankingDecimal,
    )
  ) {
    differences.push({
      field: "franking credits",
      committed: committed.totalFrankingDecimal,
      incoming: incoming.totalFrankingDecimal,
    });
  }
  if (incoming.paymentDate !== committed.paymentDate) {
    differences.push({
      field: "paid on date",
      committed: committed.paymentDate,
      incoming: incoming.paymentDate,
    });
  }
  if (
    !fxRateNotComparableOrMatches(
      incoming.fxRateToPortfolioDecimal,
      committed.fxRateToPortfolioDecimal,
    )
  ) {
    differences.push({
      field: "FX rate",
      committed: committed.fxRateToPortfolioDecimal,
      incoming: incoming.fxRateToPortfolioDecimal,
    });
  }
  if (
    !currencyNotComparableOrMatches(
      incoming.currencyCode,
      committed.currencyCode,
    )
  ) {
    differences.push({
      field: "currency",
      committed: committed.currencyCode,
      incoming: incoming.currencyCode,
    });
  }
  return differences;
}
