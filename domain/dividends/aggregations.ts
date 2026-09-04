// DIV-001: lifetime and per-financial-year dividend aggregations over an
// already-derived row list (`deriveDividendHistoryForSecurity`'s output).
// Callers must pass rows sharing one currency (per-security, native
// currency) -- this module never sums across currencies (see
// `docs/CALCULATIONS.md` section 11's dividend-history subsection for why
// portfolio-level totals stay per-security/native-currency in this task).
// Both functions verify this themselves rather than trusting the caller:
// a mixed-currency row set returns an explicit `mixed_currency` state for
// the affected totals instead of silently blending amounts under one
// currency label.
import {
  addDecimal,
  formatDecimalExact,
  fromInteger,
  parseDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";
import { fyWindowForDate } from "./fy-window.ts";
import type { DerivedDividendRow } from "./history.ts";
import type { FyWindow } from "../calculations/financial-year.ts";

const ZERO = fromInteger(0n);

function sumDecimals(values: readonly string[]): string {
  return formatDecimalExact(
    values.reduce<DecimalFraction>(
      (total, value) => addDecimal(total, parseDecimal(value)),
      ZERO,
    ),
  );
}

export type LifetimeDividendTotals = {
  currencyCode: string;
  status: "ok" | "mixed_currency";
  rowCount: number;
  excludedCount: number;
  /** Rows whose per-share amount is genuinely unknown (`amountUnknown`) -- excluded from every sum below, counted here instead of fabricating a "0". */
  unknownAmountCount: number;
  receivedCashDecimal: string | null;
  receivedFrankingKnownDecimal: string | null;
  receivedFrankingUnknownCount: number;
  /** Cash + known franking only -- unknown-franking rows contribute cash but not franking. `null` only in the `mixed_currency` state. */
  receivedGrossDecimal: string | null;
  pendingCashDecimal: string | null;
  pendingFrankingKnownDecimal: string | null;
  pendingFrankingUnknownCount: number;
  pendingGrossDecimal: string | null;
  pendingCount: number;
};

function mixedCurrencyLifetimeTotals(
  currencyCode: string,
  rows: readonly DerivedDividendRow[],
): LifetimeDividendTotals {
  return {
    currencyCode,
    status: "mixed_currency",
    rowCount: rows.length,
    excludedCount: rows.filter((row) => row.excluded).length,
    unknownAmountCount: rows.filter((row) => row.amountUnknown).length,
    receivedCashDecimal: null,
    receivedFrankingKnownDecimal: null,
    receivedFrankingUnknownCount: 0,
    receivedGrossDecimal: null,
    pendingCashDecimal: null,
    pendingFrankingKnownDecimal: null,
    pendingFrankingUnknownCount: 0,
    pendingGrossDecimal: null,
    pendingCount: 0,
  };
}

/** Lifetime totals for one security's (or one currency's) row list. Excluded rows are omitted from every sum but still counted in `excludedCount`; unknown-amount rows the same way via `unknownAmountCount`. */
export function computeLifetimeDividendTotals(
  rows: readonly DerivedDividendRow[],
  currencyCode: string,
): LifetimeDividendTotals {
  if (rows.some((row) => row.currencyCode !== currencyCode)) {
    return mixedCurrencyLifetimeTotals(currencyCode, rows);
  }
  const included = rows.filter((row) => !row.excluded);
  const excludedCount = rows.length - included.length;
  const unknownAmountCount = included.filter((row) => row.amountUnknown).length;
  const known = included.filter((row) => !row.amountUnknown);
  const received = known.filter((row) => row.status === "ex_date_passed");
  const pending = known.filter((row) => row.status === "declared_pending");
  const receivedFrankingKnown = received.filter(
    (row) => row.frankingTotalDecimal !== null,
  );
  const pendingFrankingKnown = pending.filter(
    (row) => row.frankingTotalDecimal !== null,
  );
  const receivedCash = sumDecimals(received.map((row) => row.cashDecimal!));
  const receivedFrankingKnownSum = sumDecimals(
    receivedFrankingKnown.map((row) => row.frankingTotalDecimal!),
  );
  const pendingCash = sumDecimals(pending.map((row) => row.cashDecimal!));
  const pendingFrankingKnownSum = sumDecimals(
    pendingFrankingKnown.map((row) => row.frankingTotalDecimal!),
  );
  return {
    currencyCode,
    status: "ok",
    rowCount: rows.length,
    excludedCount,
    unknownAmountCount,
    receivedCashDecimal: receivedCash,
    receivedFrankingKnownDecimal: receivedFrankingKnownSum,
    receivedFrankingUnknownCount:
      received.length - receivedFrankingKnown.length,
    receivedGrossDecimal: sumDecimals([receivedCash, receivedFrankingKnownSum]),
    pendingCashDecimal: pendingCash,
    pendingFrankingKnownDecimal: pendingFrankingKnownSum,
    pendingFrankingUnknownCount: pending.length - pendingFrankingKnown.length,
    pendingGrossDecimal: sumDecimals([pendingCash, pendingFrankingKnownSum]),
    pendingCount: pending.length,
  };
}

export type FyDividendOverrideFact = {
  endingYear: number;
  grossedAmountDecimal: string;
  frankingAmountDecimal: string | null;
};

export type FyDividendTotalSource =
  "fy_override" | "actual" | "partially_estimated" | "provider_estimate";

export type FyDividendTotal = {
  endingYear: number;
  label: string;
  window: FyWindow;
  source: FyDividendTotalSource;
  cashDecimal: string | null;
  frankingKnownDecimal: string | null;
  frankingUnknownCount: number;
  unknownAmountCount: number;
  rowCount: number;
  /** BRK-022 slice 3: the subset of this year's total that is a Sharesight
   * announcement (`DerivedDividendRow.announcedUnpaid`), not yet paid --
   * `null` when the year contributes no such rows (mirrors `cashDecimal`'s
   * own null-when-nothing convention) or under `source: "fy_override"`
   * (an owner correction replaces the whole year's figure; there is no
   * per-row composition left to break out). ALWAYS a subset already
   * included INSIDE `cashDecimal`/`frankingKnownDecimal` above -- the
   * owner's ruling is that the FY total reads paid + announced together,
   * with the announced portion separately disclosed, never summed twice. */
  unpaidCashDecimal: string | null;
  unpaidFrankingKnownDecimal: string | null;
  unpaidCount: number;
};

export type ComputeFyDividendTotalsResult =
  | { ok: true; totals: FyDividendTotal[] }
  | {
      ok: false;
      reason: "invalid_start_month" | "invalid_date" | "mixed_currency";
    };

/**
 * Per-FY totals, past-FY precedence: an owner `dividend_fy_overrides`
 * correction, when present, REPLACES the whole year's total outright
 * (`source: "fy_override"`) -- normalized to the same cash/franking split
 * every other tier uses (B6 fix: the override's `grossed_amount_decimal`
 * is cash+franking combined, so `cashDecimal` here is `grossed - franking`,
 * not the raw grossed figure, so a consumer computing `cash + franking`
 * gets the correct gross in every tier uniformly).
 *
 * Otherwise EVERY non-excluded row is aggregated into its year (B2 fix,
 * replacing an earlier bug where a single payment-dated row in a year
 * caused every OTHER row in that same year to be silently dropped from the
 * total): each row's best-available date is used for attribution --
 * `paymentDate` when known, else `exDate` (this provider never supplies a
 * payment date on the raw event, see `domain/market-data/
 * yahoo-compatible.ts`). The year's `source` label reflects the ROW
 * COMPOSITION of what got summed: `"actual"` when every contributing row
 * has a real payment date, `"provider_estimate"` when none do (pure
 * ex-date fallback), `"partially_estimated"` when it is a mix -- so the
 * label always describes what actually went into the number rather than an
 * all-or-nothing per-year tier switch. A year with no override and no
 * dated/estimable rows at all is simply not returned (no fabricated zero).
 */
export function computeFyDividendTotals(
  rows: readonly DerivedDividendRow[],
  fyOverrides: readonly FyDividendOverrideFact[],
  startMonth: number,
): ComputeFyDividendTotalsResult {
  const included = rows.filter((row) => !row.excluded);
  if (included.length > 0) {
    const currencies = new Set(included.map((row) => row.currencyCode));
    if (currencies.size > 1) return { ok: false, reason: "mixed_currency" };
  }

  type DatedRow = { row: DerivedDividendRow; date: string; estimated: boolean };
  const datedRows: DatedRow[] = [];
  for (const row of included) {
    const date = row.paymentDate ?? row.exDate;
    if (date === null) continue; // no usable date at all -- cannot attribute to any FY
    datedRows.push({ row, date, estimated: row.paymentDate === null });
  }

  const byYear = new Map<number, DatedRow[]>();
  for (const entry of datedRows) {
    const resolved = fyWindowForDate(entry.date, startMonth);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const list = byYear.get(resolved.endingYear) ?? [];
    list.push(entry);
    byYear.set(resolved.endingYear, list);
  }

  const overrideByYear = new Map(
    fyOverrides.map((override) => [override.endingYear, override]),
  );
  const candidateYears = new Set<number>([
    ...overrideByYear.keys(),
    ...byYear.keys(),
  ]);

  const totals: FyDividendTotal[] = [];
  for (const endingYear of candidateYears) {
    const anchorDate = `${String(endingYear - (startMonth === 1 ? 0 : 1)).padStart(4, "0")}-${String(startMonth).padStart(2, "0")}-01`;
    const windowResult = fyWindowForDate(anchorDate, startMonth);
    if (!windowResult.ok) {
      return { ok: false, reason: windowResult.reason };
    }
    const override = overrideByYear.get(endingYear);
    if (override) {
      const cashDecimal =
        override.frankingAmountDecimal !== null
          ? formatDecimalExact(
              subtractDecimal(
                parseDecimal(override.grossedAmountDecimal),
                parseDecimal(override.frankingAmountDecimal),
              ),
            )
          : override.grossedAmountDecimal;
      totals.push({
        endingYear,
        label: windowResult.label,
        window: windowResult.window,
        source: "fy_override",
        cashDecimal,
        frankingKnownDecimal: override.frankingAmountDecimal,
        frankingUnknownCount: override.frankingAmountDecimal === null ? 1 : 0,
        unknownAmountCount: 0,
        rowCount: 0,
        // BRK-022 slice 3: an owner FY override replaces the whole year's
        // figure -- there is no per-row announced/paid split left to report.
        unpaidCashDecimal: null,
        unpaidFrankingKnownDecimal: null,
        unpaidCount: 0,
      });
      continue;
    }
    const yearRows = byYear.get(endingYear) ?? [];
    const knownAmount = yearRows.filter(
      (entry) => entry.row.cashDecimal !== null,
    );
    const unknownAmountCount = yearRows.length - knownAmount.length;
    const frankingKnown = knownAmount.filter(
      (entry) => entry.row.frankingTotalDecimal !== null,
    );
    // BRK-022 slice 3: the announced-but-unpaid subset of this year's
    // KNOWN-amount rows -- always a subset of `knownAmount`/`frankingKnown`
    // above, never summed a second time (see `unpaidCashDecimal`'s doc
    // comment).
    const unpaidKnownAmount = knownAmount.filter(
      (entry) => entry.row.announcedUnpaid,
    );
    const unpaidFrankingKnown = unpaidKnownAmount.filter(
      (entry) => entry.row.frankingTotalDecimal !== null,
    );
    const estimatedCount = yearRows.filter((entry) => entry.estimated).length;
    const source: FyDividendTotalSource =
      estimatedCount === 0
        ? "actual"
        : estimatedCount === yearRows.length
          ? "provider_estimate"
          : "partially_estimated";
    totals.push({
      endingYear,
      label: windowResult.label,
      window: windowResult.window,
      source,
      cashDecimal:
        knownAmount.length > 0
          ? sumDecimals(knownAmount.map((entry) => entry.row.cashDecimal!))
          : null,
      frankingKnownDecimal:
        frankingKnown.length > 0
          ? sumDecimals(
              frankingKnown.map((entry) => entry.row.frankingTotalDecimal!),
            )
          : null,
      frankingUnknownCount: knownAmount.length - frankingKnown.length,
      unknownAmountCount,
      rowCount: yearRows.length,
      unpaidCashDecimal:
        unpaidKnownAmount.length > 0
          ? sumDecimals(
              unpaidKnownAmount.map((entry) => entry.row.cashDecimal!),
            )
          : null,
      unpaidFrankingKnownDecimal:
        unpaidFrankingKnown.length > 0
          ? sumDecimals(
              unpaidFrankingKnown.map(
                (entry) => entry.row.frankingTotalDecimal!,
              ),
            )
          : null,
      unpaidCount: unpaidKnownAmount.length,
    });
  }

  totals.sort((left, right) => right.endingYear - left.endingYear);
  return { ok: true, totals };
}
