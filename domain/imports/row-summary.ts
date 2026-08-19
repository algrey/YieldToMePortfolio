// UI-012: business-basics derivation for one staged row's
// `NormalizedImportRow` (`row.normalizedFields` -- shared by both the CSV
// parser and `domain/sharesight-sync/transform.ts`, see that module's
// field-by-field build for the exact keys read below). Originally lived
// inline in `app/components/import-history-detail.tsx`; UI-014 moved it
// here, unchanged, so `app/import-preview.ts` (server, building the review
// payload) and `app/components/import-review.tsx` (client, rendering
// row-linked issue context) can both derive the SAME symbol/type/date/
// quantity/amount/currency summary a row's issue-context disclosure needs,
// rather than re-deriving it -- see TASKS.md's UI-014 entry, part 3.
//
// Treated as an unknown-ish record here rather than trusting the static
// `NormalizedImportRow` type, since this value round-trips through JSON
// storage (`db/repositories/import-staging.ts`'s `parseJson`) before
// reaching any caller. Never fabricates a value: a missing/blank field
// surfaces as "Not recorded", never 0 or "" (never-zero rule, AGENTS.md).
function asFieldRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

// First candidate that is a non-blank string or a finite number; anything
// else (null, undefined, "", NaN, objects) is treated as absent.
function firstRecordedValue(...candidates: unknown[]): string | number | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function summaryCell(value: string | number | null): string {
  return value === null ? "Not recorded" : String(value);
}

export type RowSummary = {
  symbol: string;
  type: string;
  date: string;
  quantity: string;
  amount: string;
  currency: string;
};

/**
 * Business-basics summary for one staged row's `normalizedFields`.
 * `symbol`/`displaySymbol`, `currency` are shared verbatim by both source
 * shapes. `type` prefers `cashEvent` over `type` (`cash_deposit`/
 * `cash_withdrawal` vs `buy`/`sell`) -- mirroring
 * `db/repositories/import-commit.ts`'s own `normalized.cashEvent ??
 * normalized.type` precedence, since a legacy cash row's parser-level
 * `type` stays "buy"/"sell" while the REAL effect is only encoded in
 * `cashEvent` (`domain/imports/strict-versioned-parser.ts`'s
 * `normalized.cashEvent = normalized.type === "buy" ? "cash_deposit" :
 * "cash_withdrawal"`); showing the raw `type` alone would mislabel a cash
 * deposit as a buy. `date` prefers `localTradeDate` (the business date both
 * shapes derive via `deriveDates`/CSV date parsing -- see AGENTS.md's
 * "prefer business-relevant dates" rule) over the raw `transactionDate`
 * CSV column. `quantity` is `sharesOwned`, always null on a Sharesight
 * payout-derived dividend row (BRK-005 totals-only shape) -- shown as "Not
 * recorded", never fabricated from an amount. `amount` coalesces
 * `costPerShare` (a trade's per-share price, OR a CSV dividend row's
 * per-share amount) with `totalCashDecimal` (a Sharesight payout's TOTAL
 * cash amount) -- the two are mutually exclusive by construction on every
 * row this codebase produces (see `transform.ts`'s header comment), so this
 * is never a lossy choice between two populated values.
 */
export function summarizeRow(normalizedFields: unknown): RowSummary {
  const fields = asFieldRecord(normalizedFields);
  return {
    symbol: summaryCell(
      firstRecordedValue(fields.symbol, fields.displaySymbol),
    ),
    type: summaryCell(firstRecordedValue(fields.cashEvent, fields.type)),
    date: summaryCell(
      firstRecordedValue(fields.localTradeDate, fields.transactionDate),
    ),
    quantity: summaryCell(firstRecordedValue(fields.sharesOwned)),
    amount: summaryCell(
      firstRecordedValue(fields.costPerShare, fields.totalCashDecimal),
    ),
    currency: summaryCell(firstRecordedValue(fields.currency)),
  };
}
