import { randomUUID } from "node:crypto";
import type { SharesightStreamWindow } from "../../domain/sharesight-sync/window.ts";
import { isWithinReadPathDecimalBounds } from "./dividends.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

// BRK-022 slice 1: repository for `sharesight_pending_payouts` -- an
// OBSERVATION table, not a ledger fact. See db/schema.ts's header comment
// on `sharesightPendingPayouts` for the full design rationale (the payout
// identity key shared with `dividend_manual_records`, the "paid overrides
// pending" rule slice 3 relies on, and the nullable-security meaning).
// This slice only reserves the shape: `upsertObserved` (called by slice 2's
// sync wiring on every sync attempt), `markWithdrawnNotObserved` (called
// once per sync, after every payout in the fetch window has been
// upserted), and `listActive` (the slice-3 read path's data source).

export type SharesightPendingPayoutRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  portfolioSecurityId: string | null;
  sourceReference: string;
  sharesightHoldingId: string;
  sharesightInstrumentId: string | null;
  sharesightPayoutId: string | null;
  symbol: string;
  marketCode: string;
  currencyCode: string;
  paymentDate: string;
  exDate: string | null;
  totalCashDecimal: string;
  grossAmountDecimal: string;
  totalFrankingDecimal: string | null;
  residentWithholdingTaxDecimal: string | null;
  nonResidentWithholdingTaxDecimal: string | null;
  fxRateToPortfolioDecimal: string | null;
  fxRateSource: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
  withdrawnAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PendingPayoutObservationInput = {
  portfolioSecurityId: string | null;
  sourceReference: string;
  sharesightHoldingId: string;
  sharesightInstrumentId: string | null;
  sharesightPayoutId: string | null;
  symbol: string;
  marketCode: string;
  currencyCode: string;
  paymentDate: string;
  exDate: string | null;
  totalCashDecimal: string;
  grossAmountDecimal: string;
  totalFrankingDecimal: string | null;
  residentWithholdingTaxDecimal: string | null;
  nonResidentWithholdingTaxDecimal: string | null;
  fxRateToPortfolioDecimal: string | null;
  fxRateSource: string | null;
};

export type SharesightPendingPayoutMutationFailure =
  | { ok: false; reason: "invalid_input"; field: string }
  | { ok: false; reason: "atomic_failure" };

const PENDING_PAYOUT_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id, source_reference,
  sharesight_holding_id, sharesight_instrument_id, sharesight_payout_id,
  symbol, market_code, currency_code, payment_date, ex_date,
  total_cash_decimal, gross_amount_decimal, total_franking_decimal,
  resident_withholding_tax_decimal, non_resident_withholding_tax_decimal,
  fx_rate_to_portfolio_decimal, fx_rate_source,
  first_observed_at, last_observed_at, withdrawn_at, created_at, updated_at
`;

function mapPendingPayout(
  row: Record<string, unknown>,
): SharesightPendingPayoutRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    portfolioSecurityId:
      row.portfolio_security_id === null
        ? null
        : String(row.portfolio_security_id),
    sourceReference: String(row.source_reference),
    sharesightHoldingId: String(row.sharesight_holding_id),
    sharesightInstrumentId:
      row.sharesight_instrument_id === null
        ? null
        : String(row.sharesight_instrument_id),
    sharesightPayoutId:
      row.sharesight_payout_id === null
        ? null
        : String(row.sharesight_payout_id),
    symbol: String(row.symbol),
    marketCode: String(row.market_code),
    currencyCode: String(row.currency_code),
    paymentDate: String(row.payment_date),
    exDate: row.ex_date === null ? null : String(row.ex_date),
    totalCashDecimal: String(row.total_cash_decimal),
    grossAmountDecimal: String(row.gross_amount_decimal),
    totalFrankingDecimal:
      row.total_franking_decimal === null
        ? null
        : String(row.total_franking_decimal),
    residentWithholdingTaxDecimal:
      row.resident_withholding_tax_decimal === null
        ? null
        : String(row.resident_withholding_tax_decimal),
    nonResidentWithholdingTaxDecimal:
      row.non_resident_withholding_tax_decimal === null
        ? null
        : String(row.non_resident_withholding_tax_decimal),
    fxRateToPortfolioDecimal:
      row.fx_rate_to_portfolio_decimal === null
        ? null
        : String(row.fx_rate_to_portfolio_decimal),
    fxRateSource:
      row.fx_rate_source === null ? null : String(row.fx_rate_source),
    firstObservedAt: String(row.first_observed_at),
    lastObservedAt: String(row.last_observed_at),
    withdrawnAt: row.withdrawn_at === null ? null : String(row.withdrawn_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Validation helpers -- mirrors dividends.ts's BUG-014/BUG-022 writer
// conventions exactly (duplicated locally, not imported, matching that
// file's own established practice of re-deriving small validators per
// repository rather than sharing a validation module -- see e.g. BRK-010's
// `CURRENCY_CODE_PATTERN` comment there for the same rationale).
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function isCurrencyCodeString(value: unknown): value is string {
  return typeof value === "string" && CURRENCY_CODE_PATTERN.test(value);
}

const FX_RATE_SOURCES = new Set(["sharesight"]);

function isFxRateSourceString(value: unknown): value is string {
  return typeof value === "string" && FX_RATE_SOURCES.has(value);
}

// Same 24-place scale boundary `dividend_manual_records`' FX rate write
// path bounds to (`MAX_FX_RATE_DECIMAL_SCALE` there) -- read-time
// conversion rounds to the same `FX_CONVERSION_SCALE`.
const MAX_FX_RATE_DECIMAL_SCALE = 24;

function hasDecimalScaleWithinLimit(value: string, maxScale: number): boolean {
  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) return true;
  return value.length - dotIndex - 1 <= maxScale;
}

const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" && DECIMAL_PATTERN.test(value) && value !== "-0"
  );
}

function isNonNegativeDecimalString(value: unknown): value is string {
  return isDecimalString(value) && !value.startsWith("-");
}

function isPositiveDecimalString(value: unknown): value is string {
  return isNonNegativeDecimalString(value) && /[1-9]/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullable<T>(value: T | null, check: (value: T) => boolean): boolean {
  return value === null || check(value);
}

/** Validates one observation row; returns the offending field name, or
 * `null` when the row is fully valid. Every amount field is additionally
 * bounded by `isWithinReadPathDecimalBounds` (BUG-014/BUG-022) so an
 * over-precision Sharesight figure can never reach storage and later crash
 * a read-time `parseDecimal` call the way an unbounded import once did. */
function validateObservationInput(
  input: PendingPayoutObservationInput,
): string | null {
  if (!isNonEmptyString(input.sourceReference)) return "sourceReference";
  if (!isNonEmptyString(input.sharesightHoldingId))
    return "sharesightHoldingId";
  if (!isNonEmptyString(input.symbol)) return "symbol";
  if (!isNonEmptyString(input.marketCode)) return "marketCode";
  if (!isCurrencyCodeString(input.currencyCode)) return "currencyCode";
  if (!isValidDateString(input.paymentDate)) return "paymentDate";
  if (!isNullable(input.exDate, isValidDateString)) return "exDate";
  if (!isNullable(input.portfolioSecurityId, isNonEmptyString))
    return "portfolioSecurityId";
  if (!isNullable(input.sharesightInstrumentId, isNonEmptyString))
    return "sharesightInstrumentId";
  if (!isNullable(input.sharesightPayoutId, isNonEmptyString))
    return "sharesightPayoutId";

  if (
    !isPositiveDecimalString(input.totalCashDecimal) ||
    !isWithinReadPathDecimalBounds(input.totalCashDecimal)
  )
    return "totalCashDecimal";
  if (
    !isPositiveDecimalString(input.grossAmountDecimal) ||
    !isWithinReadPathDecimalBounds(input.grossAmountDecimal)
  )
    return "grossAmountDecimal";
  if (
    !isNullable(
      input.totalFrankingDecimal,
      (value) =>
        isNonNegativeDecimalString(value) &&
        isWithinReadPathDecimalBounds(value),
    )
  )
    return "totalFrankingDecimal";
  if (
    !isNullable(
      input.residentWithholdingTaxDecimal,
      (value) =>
        isNonNegativeDecimalString(value) &&
        isWithinReadPathDecimalBounds(value),
    )
  )
    return "residentWithholdingTaxDecimal";
  if (
    !isNullable(
      input.nonResidentWithholdingTaxDecimal,
      (value) =>
        isNonNegativeDecimalString(value) &&
        isWithinReadPathDecimalBounds(value),
    )
  )
    return "nonResidentWithholdingTaxDecimal";

  // Same provenance pairing as `dividend_manual_records_fx_provenance_check`
  // (db/schema.ts) -- both present or both absent.
  if (
    (input.fxRateToPortfolioDecimal !== null) !==
    (input.fxRateSource !== null)
  )
    return "fxRateSource";
  if (input.fxRateToPortfolioDecimal !== null) {
    if (
      !isPositiveDecimalString(input.fxRateToPortfolioDecimal) ||
      !hasDecimalScaleWithinLimit(
        input.fxRateToPortfolioDecimal,
        MAX_FX_RATE_DECIMAL_SCALE,
      ) ||
      !isWithinReadPathDecimalBounds(input.fxRateToPortfolioDecimal)
    )
      return "fxRateToPortfolioDecimal";
    if (!isFxRateSourceString(input.fxRateSource)) return "fxRateSource";
  }

  return null;
}

// D1's per-statement bound-parameter ceiling is comfortably above this, but
// a single portfolio's whole Sharesight payout history is small (owner's
// own account: ~119 payouts total) -- chunking the pre-check SELECT and the
// withdrawal UPDATEs at a conservative size (mirrors OPS-005's ≤50-ref
// probe in db/repositories/import-commit.ts) keeps every statement well
// clear of the limit regardless of how large a future account's history
// grows, without needing to reason about the exact ceiling here.
const REFERENCE_CHUNK_SIZE = 50;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size)
    chunks.push(items.slice(offset, offset + size));
  return chunks;
}

export function createSharesightPendingPayoutsRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  /**
   * Upserts a batch of payout observations for ONE portfolio, keyed by
   * `(portfolio_id, source_reference)` (the table's own unique index). A
   * new `source_reference` is inserted with `first_observed_at =
   * last_observed_at = now`; an already-known one has every value column
   * refreshed, `last_observed_at`/`updated_at` advanced, and `withdrawn_at`
   * cleared (a re-observed row is no longer withdrawn), while `id`,
   * `first_observed_at`, and `created_at` are left untouched -- the SQL
   * UPSERT's `DO UPDATE SET` list deliberately omits all three, so SQLite
   * preserves the pre-existing row's values on conflict by construction
   * rather than by a second read-back.
   *
   * Every row is validated BEFORE any statement is built (fail-closed: one
   * invalid row means nothing in the batch is written, not a partial
   * commit) -- see `validateObservationInput`. `inserted`/`updated` counts
   * come from a pre-check `SELECT` of which `source_reference`s already
   * exist for this portfolio, taken before the batch executes; this is a
   * reporting count only (mirrors BRK-014's own "best-effort, not a
   * concurrency boundary" counts), not something the upsert's own
   * correctness depends on.
   */
  async function upsertObserved(
    userId: string,
    portfolioId: string,
    inputs: readonly PendingPayoutObservationInput[],
  ): Promise<
    | { ok: true; inserted: number; updated: number }
    | SharesightPendingPayoutMutationFailure
  > {
    if (!isNonEmptyString(userId) || !isNonEmptyString(portfolioId))
      return { ok: false, reason: "invalid_input", field: "portfolioId" };
    if (inputs.length === 0) return { ok: true, inserted: 0, updated: 0 };

    for (const [index, input] of inputs.entries()) {
      const field = validateObservationInput(input);
      if (field) {
        return {
          ok: false,
          reason: "invalid_input",
          field: `payouts[${index}].${field}`,
        };
      }
    }

    const sourceReferences = inputs.map((input) => input.sourceReference);
    const existing = new Set<string>();
    for (const referenceChunk of chunk(
      sourceReferences,
      REFERENCE_CHUNK_SIZE,
    )) {
      const placeholders = referenceChunk.map(() => "?").join(", ");
      const rows = await client.all<{ source_reference: string }>(
        `SELECT source_reference FROM sharesight_pending_payouts
         WHERE user_id = ? AND portfolio_id = ?
           AND source_reference IN (${placeholders})`,
        [userId, portfolioId, ...referenceChunk],
      );
      for (const row of rows) existing.add(row.source_reference);
    }

    const observedAt = now();
    const statements: SqlStatement[] = inputs.map((input) => ({
      sql: `INSERT INTO sharesight_pending_payouts (
          ${PENDING_PAYOUT_COLUMNS}
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
        )
        ON CONFLICT (portfolio_id, source_reference) DO UPDATE SET
          portfolio_security_id = excluded.portfolio_security_id,
          sharesight_holding_id = excluded.sharesight_holding_id,
          sharesight_instrument_id = excluded.sharesight_instrument_id,
          sharesight_payout_id = excluded.sharesight_payout_id,
          symbol = excluded.symbol,
          market_code = excluded.market_code,
          currency_code = excluded.currency_code,
          payment_date = excluded.payment_date,
          ex_date = excluded.ex_date,
          total_cash_decimal = excluded.total_cash_decimal,
          gross_amount_decimal = excluded.gross_amount_decimal,
          total_franking_decimal = excluded.total_franking_decimal,
          resident_withholding_tax_decimal = excluded.resident_withholding_tax_decimal,
          non_resident_withholding_tax_decimal = excluded.non_resident_withholding_tax_decimal,
          fx_rate_to_portfolio_decimal = excluded.fx_rate_to_portfolio_decimal,
          fx_rate_source = excluded.fx_rate_source,
          last_observed_at = excluded.last_observed_at,
          withdrawn_at = NULL,
          updated_at = excluded.updated_at`,
      params: [
        randomUUID(),
        userId,
        portfolioId,
        input.portfolioSecurityId,
        input.sourceReference,
        input.sharesightHoldingId,
        input.sharesightInstrumentId,
        input.sharesightPayoutId,
        input.symbol,
        input.marketCode,
        input.currencyCode,
        input.paymentDate,
        input.exDate,
        input.totalCashDecimal,
        input.grossAmountDecimal,
        input.totalFrankingDecimal,
        input.residentWithholdingTaxDecimal,
        input.nonResidentWithholdingTaxDecimal,
        input.fxRateToPortfolioDecimal,
        input.fxRateSource,
        observedAt,
        observedAt,
        observedAt,
        observedAt,
      ],
    }));

    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }

    const inserted = sourceReferences.filter(
      (ref) => !existing.has(ref),
    ).length;
    return { ok: true, inserted, updated: inputs.length - inserted };
  }

  /**
   * Withdraws every ACTIVE row for `(userId, portfolioId)` whose
   * `source_reference` was NOT in this sync's observed set AND that the
   * sync's own fetch window actually covered: on a `"full"` window, every
   * active row qualifies; on a `"narrowed"` window, only a row with a
   * non-null `ex_date` on or after `window.sinceDate` qualifies -- a
   * null-`ex_date` row is only ever withdrawn by a full window, since a
   * narrowed sync cannot honestly claim to have re-examined it (mirrors
   * `SharesightStreamWindow`'s own honesty rule for the routine sync).
   *
   * Candidates are computed in application code from one scoped `SELECT`
   * (never a giant `NOT IN (...)` bound-parameter list), then the matching
   * ids are chunked into bounded `UPDATE ... WHERE id IN (...)` statements
   * -- see `REFERENCE_CHUNK_SIZE`.
   */
  async function markWithdrawnNotObserved(
    userId: string,
    portfolioId: string,
    observedSourceReferences: readonly string[],
    window: SharesightStreamWindow,
  ): Promise<
    { ok: true; withdrawn: number } | SharesightPendingPayoutMutationFailure
  > {
    if (!isNonEmptyString(userId) || !isNonEmptyString(portfolioId))
      return { ok: false, reason: "invalid_input", field: "portfolioId" };
    if (window.kind === "narrowed" && !isValidDateString(window.sinceDate))
      return { ok: false, reason: "invalid_input", field: "window.sinceDate" };

    const activeRows = await client.all<{
      id: string;
      source_reference: string;
      ex_date: string | null;
    }>(
      `SELECT id, source_reference, ex_date FROM sharesight_pending_payouts
       WHERE user_id = ? AND portfolio_id = ? AND withdrawn_at IS NULL`,
      [userId, portfolioId],
    );

    const observedSet = new Set(observedSourceReferences);
    const isCovered = (exDate: string | null): boolean =>
      window.kind === "full"
        ? true
        : exDate !== null && exDate >= window.sinceDate;

    const candidateIds = activeRows
      .filter(
        (row) =>
          !observedSet.has(row.source_reference) && isCovered(row.ex_date),
      )
      .map((row) => row.id);

    if (candidateIds.length === 0) return { ok: true, withdrawn: 0 };

    const withdrawnAt = now();
    const statements: SqlStatement[] = chunk(
      candidateIds,
      REFERENCE_CHUNK_SIZE,
    ).map((idChunk) => ({
      sql: `UPDATE sharesight_pending_payouts
        SET withdrawn_at = ?, updated_at = ?
        WHERE user_id = ? AND portfolio_id = ?
          AND id IN (${idChunk.map(() => "?").join(", ")})`,
      params: [withdrawnAt, withdrawnAt, userId, portfolioId, ...idChunk],
    }));

    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }

    return { ok: true, withdrawn: candidateIds.length };
  }

  /** Owner+portfolio-scoped active (non-withdrawn) pending payouts, for the
   * slice-3 read path. */
  async function listActive(
    userId: string,
    portfolioId: string,
  ): Promise<SharesightPendingPayoutRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${PENDING_PAYOUT_COLUMNS}
       FROM sharesight_pending_payouts
       WHERE user_id = ? AND portfolio_id = ? AND withdrawn_at IS NULL
       ORDER BY payment_date, symbol`,
      [userId, portfolioId],
    );
    return rows.map(mapPendingPayout);
  }

  return { upsertObserved, markWithdrawnNotObserved, listActive };
}
