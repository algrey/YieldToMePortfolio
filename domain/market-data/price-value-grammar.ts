import { DECIMAL_LIMITS } from "../calculations/decimal.ts";

// IMP-010A: shared price-decimal/market-date grammar for the "Historical
// Data" section's two CSV formats (`price-csv.ts`, `price-backup-csv.ts`).
// Both files independently defined byte-identical `DECIMAL_PATTERN`/
// `isPositiveDecimal` and near-identical market-date validity checks before
// this extraction -- consolidated here so the definition of "a valid price"
// and "a valid market date" lives in exactly ONE place. This matters more
// than usual after IMP-010A: the SAME predicates now also validate rows in
// an untrusted browser-uploaded JSON payload (`validateUploadedPriceCsvRow`/
// `validateUploadedPriceBackupRow` in the two sibling files), so a future
// edit to "what counts as a valid price/date" can never accidentally apply
// to raw-text parsing but not uploaded-row re-validation (or vice versa) --
// exactly the kind of drift AGENTS.md's "single shared implementation"
// ruling exists to prevent.
//
// Review B2 fix (BLOCKING, 2026-08-25): `isPositiveDecimal` was
// length-UNBOUNDED before this fix -- the reviewer's repro fed a
// 500,001-digit `priceDecimal` string through the untrusted-row
// re-validators (`validateUploadedPriceCsvRow`/`validateUploadedPriceBackupRow`),
// which happily accepted it (the regex matches any digit run) and would
// have written it straight into `price_observations.close_decimal`. This
// module's OWN `DECIMAL_LIMITS.inputDigits` bound (`domain/calculations/
// decimal.ts`, the SAME cap the financial-decimal wrapper enforces on every
// OTHER money/price/quantity input in this app) now applies here too --
// reused, not re-defined, so "how many digits a decimal input may carry"
// has one answer across the codebase. The length check runs BEFORE the
// regex test so a hostile huge string never even reaches pattern matching.

/** A positive decimal string: optional leading zero form disallowed
 * (`0` itself is fine, `01` is not), any number of fractional digits,
 * strictly greater than zero (a `0`/`0.00` price is never valid -- missing
 * data is never zero, per AGENTS.md). */
export const PRICE_DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

/** A bare `YYYY-MM-DD` market date -- no time component. Both this format's
 * raw text (the backup CSV) and every NORMALIZED row (the single-security
 * CSV's parser strips its optional time-of-day suffix before this point,
 * and every browser-uploaded row is normalized the same way before it ever
 * reaches the server) always match this exact shape. */
export const MARKET_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isPositiveDecimal(value: string): boolean {
  if (value.length > DECIMAL_LIMITS.inputDigits) return false;
  return PRICE_DECIMAL_PATTERN.test(value) && /[1-9]/.test(value);
}

export function isValidMarketDate(value: string): boolean {
  if (!MARKET_DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}
