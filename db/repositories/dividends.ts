import { randomUUID } from "node:crypto";
import {
  DECIMAL_LIMITS,
  compareDecimal,
  parseDecimalResult,
} from "../../domain/calculations/decimal.ts";
import { createConditionalAuditInsertStatement } from "./audit.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

// ---------------------------------------------------------------------------
// Shared validation helpers (DB-005). Money/quantity/percentage fields are
// decimal strings validated here at the repository boundary -- schema.ts
// intentionally has no decimal-format CHECK constraints, matching every
// other financial table in this repository (see market-data.ts's
// `validDecimal`/`validDate`).
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

// BRK-010: mirrors `domain/calculations/multi-currency.ts`'s
// `CURRENCY_CODE` pattern -- duplicated locally rather than imported so
// this server-only repository layer's dependency surface stays as narrow
// as its existing helpers above (same rationale as
// `domain/securities/resolve-security.ts`'s deliberately re-derived
// `normalizeToken`).
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function isCurrencyCodeString(value: unknown): value is string {
  return typeof value === "string" && CURRENCY_CODE_PATTERN.test(value);
}

// BRK-010: the only source this codebase currently writes for a dividend
// manual record's `fx_rate_source` -- mirrors
// `dividend_manual_records_fx_rate_source_check`'s closed CHECK set. A
// future user-applied-conversion source (owner's stated lower-priority
// preference, TASKS.md BRK-010) would extend both this set and that CHECK
// together, not silently widen one without the other.
const FX_RATE_SOURCES = new Set(["sharesight"]);

function isFxRateSourceString(value: unknown): value is string {
  return typeof value === "string" && FX_RATE_SOURCES.has(value);
}

// BRK-010 review finding F3: caps a stored FX rate's decimal scale at the
// same 24-place boundary `domain/dividends/history.ts`'s read-time
// conversion rounds to (`FX_CONVERSION_SCALE`, itself matching
// `franking.ts`'s established `DEFAULT_TIER_SCALE`) -- rejected at THIS
// write-time boundary, with an honest message, rather than ever letting an
// over-precision rate reach storage and only fail later at read time (where
// a single bad row could otherwise abort loading a whole security's
// dividend history -- see history.ts's per-record isolation for the
// read-time half of this fix).
const MAX_FX_RATE_DECIMAL_SCALE = 24;

function hasDecimalScaleWithinLimit(value: string, maxScale: number): boolean {
  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) return true;
  return value.length - dotIndex - 1 <= maxScale;
}

// BUG-014 correction round 3 (B2, BLOCKING): the ONE bound for stored
// dividend money on the import-commit path, expressed as the READ path's own
// limits rather than a second hard-coded copy of them.
//
// `DECIMAL_PATTERN`/`isPositiveDecimalString` below bound a value's FORM but
// not its SIZE, and nothing upstream of this boundary bounds a TOTALS-mode
// amount at all: `domain/imports/dividend-reconciliation.ts`'s
// `computeDividendCashTotal` returns `totalCashDecimal` VERBATIM (it is never
// parsed), so a Sharesight payout amount with, say, 97 fractional digits used
// to reach this builder, satisfy `isPositiveDecimalString`, and be PERSISTED.
// Every one of these columns is then read back through `parseDecimal`
// (`domain/dividends/history.ts`'s `computeCashGross`/`computeCashGrossOrTotals`
// and `domain/dividends/history-row-derivation.ts`'s `deriveHistoryRowDps`),
// which enforces `DECIMAL_LIMITS.inputDigits`/`inputScale` and THROWS -- so an
// over-bound value did not fail the import, it committed cleanly and then
// crashed `/income` on every subsequent render, permanently (ledger facts are
// immutable; the crash simply moved from a recoverable import failure to an
// unrecoverable read failure). Rejecting here returns `invalid_input`, which
// `db/repositories/import-commit.ts` surfaces as the honest, expected
// `mapping_incomplete` -- nothing malformed is ever written.
//
// Deliberately references `DECIMAL_LIMITS` (not the local
// `MAX_FX_RATE_DECIMAL_SCALE`, whose 24 comes from a DIFFERENT decision --
// `FX_CONVERSION_SCALE`, the read-time conversion rounding) so this bound
// cannot drift away from the parse it exists to protect.
function isWithinReadPathDecimalBounds(value: string): boolean {
  return (
    hasDecimalScaleWithinLimit(value, DECIMAL_LIMITS.inputScale) &&
    value.replace("-", "").replace(".", "").length <= DECIMAL_LIMITS.inputDigits
  );
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

/** `undefined`/`null` pass -- only a *present* value must satisfy `check`. */
function isNullable(
  value: unknown,
  check: (candidate: unknown) => boolean,
): boolean {
  return value === null || value === undefined || check(value);
}

/**
 * True only when `key` is an OWN property of `input`, distinguishing "the
 * caller explicitly sent `null`" (present, value null -- clear this nullable
 * field) from "the caller omitted the key" (`undefined` via a missing
 * property -- leave the field unchanged). A plain `input.field === undefined`
 * check cannot tell these apart, since both read as `undefined` in JS; that
 * conflation is exactly what silently wiped known franking values on a
 * shares-only partial update (DB-005 review finding B2).
 */
function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

/**
 * Builds a tri-state SQL assignment for a nullable "partial update" column:
 * present (including explicit `null`) -> bind and assign the new value;
 * absent -> leave the column untouched (`column = column`, no parameter).
 * Returns the SQL fragment and, separately, the parameter to splice into the
 * statement's `params` array at the fragment's position (only when present).
 */
function triStateAssignment(
  column: string,
  present: boolean,
  value: unknown,
): { fragment: string; params: unknown[] } {
  return present
    ? { fragment: `${column} = ?`, params: [value ?? null] }
    : { fragment: `${column} = ${column}`, params: [] };
}

async function resolveOwnerMutationFailure(
  client: SqlClient,
  existsSql: string,
  params: readonly unknown[],
): Promise<{ ok: false; reason: "not_found" | "version_conflict" }> {
  const row = await client.get<Record<string, unknown>>(existsSql, params);
  return row
    ? { ok: false, reason: "version_conflict" }
    : { ok: false, reason: "not_found" };
}

/**
 * Verifies `portfolioSecurityId` belongs to `userId`/`portfolioId` AND, when
 * `dividendEventId` is given, that the event's security matches the
 * holding's security -- a single query closes both the ownership and the
 * cross-security-mismatch gap (a receipt/override can never attach an event
 * belonging to a different security than the holding it targets).
 */
async function ownedHoldingWithOptionalEvent(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  portfolioSecurityId: string,
  dividendEventId: string | null,
): Promise<boolean> {
  if (dividendEventId === null) {
    const row = await client.get<{ id: string }>(
      `SELECT id FROM portfolio_securities
       WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
      [portfolioSecurityId, userId, portfolioId],
    );
    return Boolean(row);
  }
  const row = await client.get<{ id: string }>(
    `SELECT ps.id FROM portfolio_securities AS ps
     INNER JOIN dividend_events AS de ON de.security_id = ps.security_id
     WHERE ps.id = ? AND ps.user_id = ? AND ps.portfolio_id = ? AND de.id = ?
     LIMIT 1`,
    [portfolioSecurityId, userId, portfolioId, dividendEventId],
  );
  return Boolean(row);
}

async function ownedPortfolio(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<boolean> {
  const row = await client.get<{ id: string }>(
    "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
    [portfolioId, userId],
  );
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Shared provider facts: dividend_events / split_events.
//
// These repositories are server/provider-write-only -- they take no userId
// and perform no ownership predicate, mirroring how
// `security-verification.ts`'s `publishAndLink` writes the shared
// `securities` master: the gate is architectural (no server action wires
// these to a user-triggered mutation in this task) rather than a runtime
// check, exactly like the securities master write path.
// ---------------------------------------------------------------------------

export type DividendEventKind = "cash" | "special" | "capital_return";
export type DividendEventStatus =
  "estimated" | "declared" | "paid" | "cancelled" | "superseded";

export type DividendEventRecord = {
  id: string;
  securityId: string;
  providerId: string;
  kind: DividendEventKind;
  status: DividendEventStatus;
  exDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  declarationDate: string | null;
  currencyCode: string;
  grossPerShareDecimal: string | null;
  frankingPercentDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  observedAt: string;
  ingestedAt: string;
  estimateMethod: string | null;
  estimateAsOf: string | null;
  supersedesEventId: string | null;
  createdAt: string;
};

export type RecordDividendEventInput = {
  id?: string;
  securityId: string;
  providerId: string;
  kind: DividendEventKind;
  status: DividendEventStatus;
  exDate?: string | null;
  recordDate?: string | null;
  paymentDate?: string | null;
  declarationDate?: string | null;
  currencyCode: string;
  grossPerShareDecimal?: string | null;
  frankingPercentDecimal?: string | null;
  frankingCreditPerShareDecimal?: string | null;
  observedAt: string;
  ingestedAt: string;
  estimateMethod?: string | null;
  estimateAsOf?: string | null;
  /** When set, the event at this id is atomically superseded by the new row. */
  supersedesEventId?: string | null;
};

export type DividendEventMutationFailure = {
  ok: false;
  reason: "invalid_input" | "conflict" | "atomic_failure";
};
export type DividendEventMutationResult =
  { ok: true; event: DividendEventRecord } | DividendEventMutationFailure;

const DIVIDEND_EVENT_COLUMNS = `
  id, security_id, provider_id, kind, status, ex_date, record_date,
  payment_date, declaration_date, currency_code, gross_per_share_decimal,
  franking_percent_decimal, franking_credit_per_share_decimal, observed_at,
  ingested_at, estimate_method, estimate_as_of, supersedes_event_id,
  created_at
`;

function mapDividendEvent(row: Record<string, unknown>): DividendEventRecord {
  return {
    id: String(row.id),
    securityId: String(row.security_id),
    providerId: String(row.provider_id),
    kind: String(row.kind) as DividendEventKind,
    status: String(row.status) as DividendEventStatus,
    exDate: row.ex_date === null ? null : String(row.ex_date),
    recordDate: row.record_date === null ? null : String(row.record_date),
    paymentDate: row.payment_date === null ? null : String(row.payment_date),
    declarationDate:
      row.declaration_date === null ? null : String(row.declaration_date),
    currencyCode: String(row.currency_code),
    grossPerShareDecimal:
      row.gross_per_share_decimal === null
        ? null
        : String(row.gross_per_share_decimal),
    frankingPercentDecimal:
      row.franking_percent_decimal === null
        ? null
        : String(row.franking_percent_decimal),
    frankingCreditPerShareDecimal:
      row.franking_credit_per_share_decimal === null
        ? null
        : String(row.franking_credit_per_share_decimal),
    observedAt: String(row.observed_at),
    ingestedAt: String(row.ingested_at),
    estimateMethod:
      row.estimate_method === null ? null : String(row.estimate_method),
    estimateAsOf:
      row.estimate_as_of === null ? null : String(row.estimate_as_of),
    supersedesEventId:
      row.supersedes_event_id === null ? null : String(row.supersedes_event_id),
    createdAt: String(row.created_at),
  };
}

function validDividendEventInput(input: RecordDividendEventInput): boolean {
  const kinds: DividendEventKind[] = ["cash", "special", "capital_return"];
  const statuses: DividendEventStatus[] = [
    "estimated",
    "declared",
    "paid",
    "cancelled",
    "superseded",
  ];
  if (!kinds.includes(input.kind) || !statuses.includes(input.status))
    return false;
  // 'superseded' is a legitimate row STATE (an existing event moves to it
  // via the correction path in `recordEvent` below), but a row can never be
  // born superseded -- inserting one directly would create a corrected
  // event referencing nothing it corrected. Reject it as a direct insert
  // input value.
  if (input.status === "superseded") return false;
  if (
    (input.status === "declared" || input.status === "paid") &&
    !isPositiveDecimalString(input.grossPerShareDecimal ?? null)
  )
    return false;
  if (
    !isNullable(input.grossPerShareDecimal ?? null, isNonNegativeDecimalString)
  )
    return false;
  if (
    !isNullable(
      input.frankingPercentDecimal ?? null,
      isNonNegativeDecimalString,
    )
  )
    return false;
  if (
    !isNullable(
      input.frankingCreditPerShareDecimal ?? null,
      isNonNegativeDecimalString,
    )
  )
    return false;
  for (const date of [
    input.exDate,
    input.recordDate,
    input.paymentDate,
    input.declarationDate,
  ])
    if (!isNullable(date ?? null, (value) => isValidDateString(String(value))))
      return false;
  return true;
}

export function createDividendEventRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(id: string): Promise<DividendEventRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_EVENT_COLUMNS} FROM dividend_events WHERE id = ? LIMIT 1`,
      [id],
    );
    return row ? mapDividendEvent(row) : null;
  }

  async function listForSecurity(
    securityId: string,
  ): Promise<DividendEventRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${DIVIDEND_EVENT_COLUMNS} FROM dividend_events
       WHERE security_id = ? ORDER BY ex_date IS NULL, ex_date DESC, id DESC`,
      [securityId],
    );
    return rows.map(mapDividendEvent);
  }

  /** Server/provider-write-only: see the module header note above. */
  async function recordEvent(
    input: RecordDividendEventInput,
  ): Promise<DividendEventMutationResult> {
    if (!validDividendEventInput(input))
      return { ok: false, reason: "invalid_input" };
    const existing = input.supersedesEventId
      ? await get(input.supersedesEventId)
      : null;
    if (input.supersedesEventId) {
      if (
        !existing ||
        existing.securityId !== input.securityId ||
        existing.status === "superseded"
      )
        return { ok: false, reason: "conflict" };
    }
    const id = input.id ?? randomUUID();
    const createdAt = now();
    const statements: SqlStatement[] = [];
    if (existing) {
      statements.push({
        sql: `UPDATE dividend_events SET status = 'superseded'
              WHERE id = ? AND security_id = ? AND status <> 'superseded'`,
        params: [existing.id, input.securityId],
      });
    }
    statements.push({
      sql: `INSERT INTO dividend_events (
        id, security_id, provider_id, kind, status, ex_date, record_date,
        payment_date, declaration_date, currency_code,
        gross_per_share_decimal, franking_percent_decimal,
        franking_credit_per_share_decimal, observed_at, ingested_at,
        estimate_method, estimate_as_of, supersedes_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        input.securityId,
        input.providerId,
        input.kind,
        input.status,
        input.exDate ?? null,
        input.recordDate ?? null,
        input.paymentDate ?? null,
        input.declarationDate ?? null,
        input.currencyCode,
        input.grossPerShareDecimal ?? null,
        input.frankingPercentDecimal ?? null,
        input.frankingCreditPerShareDecimal ?? null,
        input.observedAt,
        input.ingestedAt,
        input.estimateMethod ?? null,
        input.estimateAsOf ?? null,
        input.supersedesEventId ?? null,
        createdAt,
      ],
    });
    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const event = await get(id);
    return event
      ? { ok: true, event }
      : { ok: false, reason: "atomic_failure" };
  }

  /**
   * B4 (MKT-005 review fix): `status` is a lifecycle column, not an
   * immutable provider fact. A pure lifecycle progression (e.g.
   * `declared` -> `paid` once the ex-date passes) with every other fact
   * unchanged updates the existing row in place -- explicitly NOT a
   * correction and NOT a supersession, which stays reserved for actual fact
   * changes (amount, date, currency). See docs/DATA_MODEL.md's
   * `dividend_events` status-semantics note. Server/provider-write-only:
   * see the module header note above.
   */
  async function updateStatus(
    id: string,
    securityId: string,
    status: DividendEventStatus,
    observedAt: string,
  ): Promise<
    | { ok: true; event: DividendEventRecord }
    | { ok: false; reason: "not_found" }
  > {
    const result = await client.run(
      `UPDATE dividend_events SET status = ?, observed_at = ?
       WHERE id = ? AND security_id = ? AND status <> 'superseded'`,
      [status, observedAt, id, securityId],
    );
    if (result.changes !== 1) return { ok: false, reason: "not_found" };
    const event = await get(id);
    return event ? { ok: true, event } : { ok: false, reason: "not_found" };
  }

  return { get, listForSecurity, recordEvent, updateStatus };
}

export type SplitEventStatus =
  "declared" | "effective" | "cancelled" | "superseded";

export type SplitEventRecord = {
  id: string;
  securityId: string;
  providerId: string;
  exDate: string;
  effectiveDate: string;
  numeratorDecimal: string;
  denominatorDecimal: string;
  status: SplitEventStatus;
  observedAt: string;
  ingestedAt: string;
  supersedesEventId: string | null;
  createdAt: string;
};

export type RecordSplitEventInput = {
  id?: string;
  securityId: string;
  providerId: string;
  exDate: string;
  effectiveDate: string;
  numeratorDecimal: string;
  denominatorDecimal: string;
  status: SplitEventStatus;
  observedAt: string;
  ingestedAt: string;
  supersedesEventId?: string | null;
};

export type SplitEventMutationFailure = {
  ok: false;
  reason: "invalid_input" | "conflict" | "atomic_failure";
};
export type SplitEventMutationResult =
  { ok: true; event: SplitEventRecord } | SplitEventMutationFailure;

const SPLIT_EVENT_COLUMNS = `
  id, security_id, provider_id, ex_date, effective_date, numerator_decimal,
  denominator_decimal, status, observed_at, ingested_at, supersedes_event_id,
  created_at
`;

function mapSplitEvent(row: Record<string, unknown>): SplitEventRecord {
  return {
    id: String(row.id),
    securityId: String(row.security_id),
    providerId: String(row.provider_id),
    exDate: String(row.ex_date),
    effectiveDate: String(row.effective_date),
    numeratorDecimal: String(row.numerator_decimal),
    denominatorDecimal: String(row.denominator_decimal),
    status: String(row.status) as SplitEventStatus,
    observedAt: String(row.observed_at),
    ingestedAt: String(row.ingested_at),
    supersedesEventId:
      row.supersedes_event_id === null ? null : String(row.supersedes_event_id),
    createdAt: String(row.created_at),
  };
}

function validSplitEventInput(input: RecordSplitEventInput): boolean {
  const statuses: SplitEventStatus[] = [
    "declared",
    "effective",
    "cancelled",
    "superseded",
  ];
  return (
    statuses.includes(input.status) &&
    // A row can never be born superseded -- see the identical dividend_events
    // note in validDividendEventInput above.
    input.status !== "superseded" &&
    isValidDateString(input.exDate) &&
    isValidDateString(input.effectiveDate) &&
    isPositiveDecimalString(input.numeratorDecimal) &&
    isPositiveDecimalString(input.denominatorDecimal)
  );
}

export function createSplitEventRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(id: string): Promise<SplitEventRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${SPLIT_EVENT_COLUMNS} FROM split_events WHERE id = ? LIMIT 1`,
      [id],
    );
    return row ? mapSplitEvent(row) : null;
  }

  async function listForSecurity(
    securityId: string,
  ): Promise<SplitEventRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${SPLIT_EVENT_COLUMNS} FROM split_events
       WHERE security_id = ? ORDER BY ex_date DESC, id DESC`,
      [securityId],
    );
    return rows.map(mapSplitEvent);
  }

  /** Server/provider-write-only: see the module header note above. */
  async function recordEvent(
    input: RecordSplitEventInput,
  ): Promise<SplitEventMutationResult> {
    if (!validSplitEventInput(input))
      return { ok: false, reason: "invalid_input" };
    const existing = input.supersedesEventId
      ? await get(input.supersedesEventId)
      : null;
    if (input.supersedesEventId) {
      if (
        !existing ||
        existing.securityId !== input.securityId ||
        existing.status === "superseded"
      )
        return { ok: false, reason: "conflict" };
    }
    const id = input.id ?? randomUUID();
    const createdAt = now();
    const statements: SqlStatement[] = [];
    if (existing) {
      statements.push({
        sql: `UPDATE split_events SET status = 'superseded'
              WHERE id = ? AND security_id = ? AND status <> 'superseded'`,
        params: [existing.id, input.securityId],
      });
    }
    statements.push({
      sql: `INSERT INTO split_events (
        id, security_id, provider_id, ex_date, effective_date,
        numerator_decimal, denominator_decimal, status, observed_at,
        ingested_at, supersedes_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        input.securityId,
        input.providerId,
        input.exDate,
        input.effectiveDate,
        input.numeratorDecimal,
        input.denominatorDecimal,
        input.status,
        input.observedAt,
        input.ingestedAt,
        input.supersedesEventId ?? null,
        createdAt,
      ],
    });
    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const event = await get(id);
    return event
      ? { ok: true, event }
      : { ok: false, reason: "atomic_failure" };
  }

  /**
   * B4 (MKT-005 review fix): same lifecycle-vs-supersession distinction as
   * `createDividendEventRepository.updateStatus` above (e.g. `declared` ->
   * `effective` once the effective date passes with numerator/denominator
   * unchanged). Server/provider-write-only: see the module header note.
   */
  async function updateStatus(
    id: string,
    securityId: string,
    status: SplitEventStatus,
    observedAt: string,
  ): Promise<
    { ok: true; event: SplitEventRecord } | { ok: false; reason: "not_found" }
  > {
    const result = await client.run(
      `UPDATE split_events SET status = ?, observed_at = ?
       WHERE id = ? AND security_id = ? AND status <> 'superseded'`,
      [status, observedAt, id, securityId],
    );
    if (result.changes !== 1) return { ok: false, reason: "not_found" };
    const event = await get(id);
    return event ? { ok: true, event } : { ok: false, reason: "not_found" };
  }

  return { get, listForSecurity, recordEvent, updateStatus };
}

// ---------------------------------------------------------------------------
// MKT-005: bounded candidate selection for the periodic dividend/split
// refresh sweep (ingestion trigger (b), "new declarations picked up on the
// normal market-data refresh path"). This intentionally does NOT extend
// `market_data_refresh_jobs` -- that table's schema (see
// `market_data_refresh_jobs_target_kind_check`/`..._target_shape_check` in
// db/schema.ts) is purpose-built for incremental date-chunked price/FX
// polling with a persisted high-water mark, whereas dividend/split ingestion
// always re-pulls and reconciles a security's FULL history in one pass (see
// `ingestSecurityCorporateActionHistory` in
// domain/market-data/corporate-action-ingestion.ts). Rather than migrating
// that job-queue schema to a shape it was not designed for, this ranks
// verified provider mappings by `corporate_action_refresh_state.last_attempted_at`,
// oldest-first (a never-attempted security has no row and sorts first via the
// `COALESCE` fallback).
//
// Review fix (B1): the original version of this repository ranked by
// `MAX(ingested_at)` derived from `dividend_events`/`split_events` directly.
// That watermark only advances when an ingestion attempt actually WRITES a
// row, so a non-paying security or one whose fetched data never changes
// (an "unchanged" reconciliation result) never advances its watermark and
// sorted first on every single sweep forever, starving every other security.
// `corporate_action_refresh_state` is written by
// `ingestSecurityCorporateActionHistory` on every ATTEMPT (success, failure,
// or no-op change), independent of whether any event row was written, so
// ranking by it rotates through the full candidate set.
// ---------------------------------------------------------------------------

export type CorporateActionRefreshCandidate = {
  securityId: string;
  mappingId: string;
};

export type CorporateActionRefreshAttemptStatus = "ok" | "failed";

export function createCorporateActionRefreshRepository(client: SqlClient) {
  async function listCandidates(
    providerId: string,
    limit: number,
  ): Promise<CorporateActionRefreshCandidate[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, 50));
    const rows = await client.all<Record<string, unknown>>(
      `SELECT spm.security_id AS security_id, spm.id AS mapping_id
       FROM security_provider_mappings AS spm
       LEFT JOIN corporate_action_refresh_state AS refresh_state
         ON refresh_state.security_id = spm.security_id
       WHERE spm.provider_id = ? AND spm.status = 'verified' AND spm.valid_to IS NULL
       ORDER BY COALESCE(refresh_state.last_attempted_at, '0001-01-01T00:00:00.000Z') ASC,
                spm.security_id ASC
       LIMIT ?`,
      [providerId, boundedLimit],
    );
    return rows.map((row) => ({
      securityId: String(row.security_id),
      mappingId: String(row.mapping_id),
    }));
  }

  /**
   * Upserted by `ingestSecurityCorporateActionHistory` at the end of every
   * ingestion attempt, regardless of which of the three triggers invoked it
   * (security-verified, this sweep, or an owner-initiated re-pull) -- a
   * single shared write point keeps the "last attempted" watermark honest no
   * matter how ingestion was triggered.
   */
  async function recordAttempt(
    securityId: string,
    attemptedAt: string,
    status: CorporateActionRefreshAttemptStatus,
  ): Promise<void> {
    await client.run(
      `INSERT INTO corporate_action_refresh_state (security_id, last_attempted_at, last_status)
       VALUES (?, ?, ?)
       ON CONFLICT (security_id) DO UPDATE SET
         last_attempted_at = excluded.last_attempted_at,
         last_status = excluded.last_status`,
      [securityId, attemptedAt, status],
    );
  }

  return { listCandidates, recordAttempt };
}

// ---------------------------------------------------------------------------
// Owner-scoped: dividend_receipts (DB-005 original scope).
// ---------------------------------------------------------------------------

export type DividendReceiptSource = "manual" | "csv_import" | "broker_sync";

export type DividendReceiptRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  portfolioSecurityId: string;
  dividendEventId: string;
  transactionId: string | null;
  sharesDecimal: string;
  dividendPerShareDecimal: string;
  frankingPerShareDecimal: string | null;
  currencyCode: string;
  paymentDate: string;
  source: DividendReceiptSource;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendReceiptInput = {
  id?: string;
  portfolioSecurityId: string;
  dividendEventId: string;
  transactionId?: string | null;
  sharesDecimal: string;
  dividendPerShareDecimal: string;
  frankingPerShareDecimal?: string | null;
  currencyCode: string;
  paymentDate: string;
  source: DividendReceiptSource;
  requestId: string;
};

export type UpdateDividendReceiptInput = {
  sharesDecimal?: string;
  dividendPerShareDecimal?: string;
  frankingPerShareDecimal?: string | null;
  expectedVersion: number;
  requestId: string;
};

export type DividendOwnerMutationFailure = {
  ok: false;
  reason: "invalid_input" | "not_found" | "version_conflict" | "atomic_failure";
};

const DIVIDEND_RECEIPT_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id, dividend_event_id,
  transaction_id, shares_decimal, dividend_per_share_decimal,
  franking_per_share_decimal, currency_code, payment_date, source,
  created_at, updated_at, version
`;

function mapDividendReceipt(
  row: Record<string, unknown>,
): DividendReceiptRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    portfolioSecurityId: String(row.portfolio_security_id),
    dividendEventId: String(row.dividend_event_id),
    transactionId:
      row.transaction_id === null ? null : String(row.transaction_id),
    sharesDecimal: String(row.shares_decimal),
    dividendPerShareDecimal: String(row.dividend_per_share_decimal),
    frankingPerShareDecimal:
      row.franking_per_share_decimal === null
        ? null
        : String(row.franking_per_share_decimal),
    currencyCode: String(row.currency_code),
    paymentDate: String(row.payment_date),
    source: String(row.source) as DividendReceiptSource,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

export function createDividendReceiptRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<DividendReceiptRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_RECEIPT_COLUMNS} FROM dividend_receipts
       WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
      [id, userId, portfolioId],
    );
    return row ? mapDividendReceipt(row) : null;
  }

  async function list(
    userId: string,
    portfolioId: string,
  ): Promise<DividendReceiptRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${DIVIDEND_RECEIPT_COLUMNS} FROM dividend_receipts
       WHERE user_id = ? AND portfolio_id = ?
       ORDER BY payment_date DESC, id DESC`,
      [userId, portfolioId],
    );
    return rows.map(mapDividendReceipt);
  }

  async function create(
    userId: string,
    portfolioId: string,
    input: SaveDividendReceiptInput,
  ): Promise<
    { ok: true; receipt: DividendReceiptRecord } | DividendOwnerMutationFailure
  > {
    if (
      !isPositiveDecimalString(input.sharesDecimal) ||
      !isPositiveDecimalString(input.dividendPerShareDecimal) ||
      !isNullable(
        input.frankingPerShareDecimal ?? null,
        isNonNegativeDecimalString,
      ) ||
      !isValidDateString(input.paymentDate) ||
      !(["manual", "csv_import", "broker_sync"] as const).includes(input.source)
    )
      return { ok: false, reason: "invalid_input" };
    if (
      !(await ownedHoldingWithOptionalEvent(
        client,
        userId,
        portfolioId,
        input.portfolioSecurityId,
        input.dividendEventId,
      ))
    )
      return { ok: false, reason: "invalid_input" };
    const id = input.id ?? randomUUID();
    const createdAt = now();
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO dividend_receipts (
          id, user_id, portfolio_id, portfolio_security_id,
          dividend_event_id, transaction_id, shares_decimal,
          dividend_per_share_decimal, franking_per_share_decimal,
          currency_code, payment_date, status, source, created_at,
          updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'actual', ?, ?, ?, 1)`,
        params: [
          id,
          userId,
          portfolioId,
          input.portfolioSecurityId,
          input.dividendEventId,
          input.transactionId ?? null,
          input.sharesDecimal,
          input.dividendPerShareDecimal,
          input.frankingPerShareDecimal ?? null,
          input.currencyCode,
          input.paymentDate,
          input.source,
          createdAt,
          createdAt,
        ],
      },
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.receipt.create",
          targetType: "dividend_receipt",
          targetId: id,
          requestId: input.requestId,
          result: "success",
          occurredAt: createdAt,
        },
        "EXISTS (SELECT 1 FROM dividend_receipts WHERE id = ? AND user_id = ? AND portfolio_id = ?)",
        [id, userId, portfolioId],
        now,
      ),
    ];
    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const receipt = await get(userId, portfolioId, id);
    return receipt
      ? { ok: true, receipt }
      : { ok: false, reason: "atomic_failure" };
  }

  async function update(
    userId: string,
    portfolioId: string,
    id: string,
    input: UpdateDividendReceiptInput,
  ): Promise<
    { ok: true; receipt: DividendReceiptRecord } | DividendOwnerMutationFailure
  > {
    const frankingProvided = hasOwn(input, "frankingPerShareDecimal");
    if (
      !isNullable(input.sharesDecimal, isPositiveDecimalString) ||
      !isNullable(input.dividendPerShareDecimal, isPositiveDecimalString) ||
      (frankingProvided &&
        !isNullable(
          input.frankingPerShareDecimal ?? null,
          isNonNegativeDecimalString,
        ))
    )
      return { ok: false, reason: "invalid_input" };
    const updatedAt = now();
    // franking_per_share_decimal is tri-state: omitted from `input` leaves
    // it unchanged (a shares-only edit must not wipe known franking to
    // unknown -- DB-005 review finding B2); an explicit `null` clears it.
    // shares/dividend-per-share are never nullable, so COALESCE(?, column)
    // (bind NULL when omitted) is a safe, simpler partial-update mechanism
    // for those two -- there is no "clear to null" state to lose.
    const franking = triStateAssignment(
      "franking_per_share_decimal",
      frankingProvided,
      input.frankingPerShareDecimal,
    );
    // Pre-state-guard construction (DB-006/DB-007): audit INSERT first,
    // guarded on the UPDATE's own pre-state predicate; version-bumping
    // UPDATE ... RETURNING last, in the same batch.
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.receipt.update",
          targetType: "dividend_receipt",
          targetId: id,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM dividend_receipts WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?)",
        [id, userId, portfolioId, input.expectedVersion],
        now,
      ),
      {
        sql: `UPDATE dividend_receipts SET
          shares_decimal = COALESCE(?, shares_decimal),
          dividend_per_share_decimal = COALESCE(?, dividend_per_share_decimal),
          ${franking.fragment},
          updated_at = ?, version = version + 1
        WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?
        RETURNING ${DIVIDEND_RECEIPT_COLUMNS}`,
        params: [
          input.sharesDecimal ?? null,
          input.dividendPerShareDecimal ?? null,
          ...franking.params,
          updatedAt,
          id,
          userId,
          portfolioId,
          input.expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_receipts WHERE id = ? AND user_id = ? AND portfolio_id = ?",
        [id, userId, portfolioId],
      );
    return { ok: true, receipt: mapDividendReceipt(row) };
  }

  async function remove(
    userId: string,
    portfolioId: string,
    id: string,
    expectedVersion: number,
    requestId: string,
  ): Promise<{ ok: true } | DividendOwnerMutationFailure> {
    const occurredAt = now();
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.receipt.delete",
          targetType: "dividend_receipt",
          targetId: id,
          requestId,
          result: "success",
          occurredAt,
        },
        "EXISTS (SELECT 1 FROM dividend_receipts WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?)",
        [id, userId, portfolioId, expectedVersion],
        now,
      ),
      {
        sql: `DELETE FROM dividend_receipts
              WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?
              RETURNING id`,
        params: [id, userId, portfolioId, expectedVersion],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_receipts WHERE id = ? AND user_id = ? AND portfolio_id = ?",
        [id, userId, portfolioId],
      );
    return { ok: true };
  }

  return { get, list, create, update, remove };
}

// ---------------------------------------------------------------------------
// IMP-006: CSV-import commit support for dividend_manual_records.
//
// A CSV dividend row cannot become a `dividend_receipts` row: that table's
// `dividend_event_id` is NOT NULL and FKs to the shared, provider-populated
// `dividend_events` table (DB-005/MKT-005) -- the importer has no safe way
// to fabricate or guess a provider corporate-action fact, and requiring one
// to already exist would make CSV dividend import fail whenever the
// configured provider hasn't ingested that exact event, defeating the
// point of a gap-filling import. `dividend_manual_records` is DIV-001's own
// table for exactly this case ("a security/payment the provider never
// surfaced as an event") and its read-time derivation
// (`domain/dividends/history.ts`, global nearest-wins `PROXIMITY_WINDOW_DAYS`
// matching) already folds these rows into the one-row-per-event precedence
// (manual/override > imported > auto-derived) and double-count guard DIV-001
// documents -- so an imported dividend that happens to match a provider
// event still never double-counts, without the importer needing to resolve
// that match itself at write time.
//
// This builds INSERT statements only (unlike `createDividendManualRecordRepository`
// .create, which executes its own atomic `client.batch()` call) so
// `db/repositories/import-commit.ts` can fold them into the SAME atomic
// chunk as the rest of that row's commit effects and the `import_rows`
// status update, preserving mixed trade+dividend batch atomicity.
// ---------------------------------------------------------------------------

export type BuildDividendManualRecordImportInsertInput = {
  id?: string;
  userId: string;
  portfolioId: string;
  portfolioSecurityId: string;
  paymentDate: string;
  // Exactly one of the two modes below must be supplied (mirrors the
  // `dividend_manual_records_amount_mode_check` DB invariant, re-validated
  // here since D1 does not enforce that CHECK the same way SQLite's local
  // shim does -- see db/schema.ts's header note): PER-SHARE (IMP-006 CSV
  // rows and any future per-share importer) supplies
  // `sharesDecimal`/`dividendPerShareDecimal` (and optionally
  // `frankingCreditPerShareDecimal`), leaving both `total*` fields
  // undefined/null; TOTALS (BRK-005 Sharesight payouts, which report only a
  // total cash amount and total franking credits, never a share count)
  // supplies `totalCashDecimal` (and optionally `totalFrankingDecimal`),
  // leaving `sharesDecimal`/`dividendPerShareDecimal`/
  // `frankingCreditPerShareDecimal` undefined/null -- never fabricating a
  // share count or per-share amount from a total.
  sharesDecimal?: string | null;
  dividendPerShareDecimal?: string | null;
  frankingCreditPerShareDecimal?: string | null;
  totalCashDecimal?: string | null;
  totalFrankingDecimal?: string | null;
  // BRK-010 review finding B4: `fxRateToPortfolioDecimal`/`fxRateSource` are
  // paired (all-or-neither) and never supplied without `currencyCode`, but
  // `currencyCode` MAY be supplied alone (mirrors
  // `dividend_manual_records_fx_provenance_check`, re-validated here for
  // the same D1-enforcement-uncertainty reason the mode fields above are).
  // Supplied when the row's own currency differs from its OWN SECURITY's
  // currency -- see `db/repositories/import-commit.ts`'s dividend branch
  // for the full three-case model (native / rate-achievable / rate-
  // unachievable). Omit/leave undefined for a native (security-currency)
  // or legacy row.
  currencyCode?: string | null;
  fxRateToPortfolioDecimal?: string | null;
  fxRateSource?: string | null;
  importBatchId: string;
  sourceReference: string;
  // EXP-004: unlike `sourceReference` (preserved verbatim from the row's
  // ORIGINAL import evidence, when the row already carried one before this
  // replay -- see the caller's own comment), this is purely an internal
  // replay-dedupe key. Optional/omittable for every OTHER caller of this
  // builder (`db/repositories/import-commit.ts`), which never needs it and
  // leaves the column NULL as before.
  idempotencyKey?: string | null;
  requestId: string;
  now: string;
};

export type BuildDividendManualRecordImportInsertResult =
  | { ok: true; id: string; statements: SqlStatement[] }
  | { ok: false; reason: "invalid_input" };

export function buildDividendManualRecordImportInsertStatements(
  input: BuildDividendManualRecordImportInsertInput,
): BuildDividendManualRecordImportInsertResult {
  if (!isValidDateString(input.paymentDate)) {
    return { ok: false, reason: "invalid_input" };
  }
  const totalsMode =
    input.totalCashDecimal !== undefined && input.totalCashDecimal !== null;
  const perShareMode =
    (input.sharesDecimal !== undefined && input.sharesDecimal !== null) ||
    (input.dividendPerShareDecimal !== undefined &&
      input.dividendPerShareDecimal !== null);
  if (totalsMode === perShareMode) {
    // Neither mode supplied, or both were -- either is invalid, matching
    // the DB CHECK invariant's exact disjunction.
    return { ok: false, reason: "invalid_input" };
  }

  let sharesDecimal: string | null = null;
  let dividendPerShareDecimal: string | null = null;
  let frankingCreditPerShareDecimal: string | null = null;
  let totalCashDecimal: string | null = null;
  let totalFrankingDecimal: string | null = null;

  if (perShareMode) {
    if (
      !isPositiveDecimalString(input.sharesDecimal) ||
      !isPositiveDecimalString(input.dividendPerShareDecimal) ||
      !isNullable(
        input.frankingCreditPerShareDecimal ?? null,
        isNonNegativeDecimalString,
      )
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    sharesDecimal = input.sharesDecimal;
    dividendPerShareDecimal = input.dividendPerShareDecimal;
    frankingCreditPerShareDecimal = input.frankingCreditPerShareDecimal ?? null;
  } else {
    if (
      !isPositiveDecimalString(input.totalCashDecimal) ||
      !isNullable(
        input.totalFrankingDecimal ?? null,
        isNonNegativeDecimalString,
      )
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    totalCashDecimal = input.totalCashDecimal;
    totalFrankingDecimal = input.totalFrankingDecimal ?? null;
  }

  // BUG-014 correction round 3 (B2, BLOCKING): both modes' amount columns are
  // bounded at the read path's own `parseDecimal` limits before anything is
  // written -- see `isWithinReadPathDecimalBounds` above for why form-only
  // validation was not enough, and why the TOTALS-mode columns in particular
  // had no size bound anywhere upstream of this line.
  for (const amount of [
    sharesDecimal,
    dividendPerShareDecimal,
    frankingCreditPerShareDecimal,
    totalCashDecimal,
    totalFrankingDecimal,
  ]) {
    if (amount !== null && !isWithinReadPathDecimalBounds(amount)) {
      return { ok: false, reason: "invalid_input" };
    }
  }

  // BRK-010 review finding B4: `fxRateToPortfolioDecimal`/`fxRateSource` are
  // paired (all-or-neither) and never present without `currencyCode`, but
  // `currencyCode` MAY stand alone (a payout foreign to its own security
  // whose security ALSO differs from the portfolio's base currency has no
  // achievable Sharesight rate -- see `db/schema.ts`'s table header note's
  // case-C reasoning; the row's true currency is still recorded so it is
  // never silently mislabelled). Re-validated at this repository boundary
  // exactly like every other decimal/enum field above (D1 CHECK-enforcement
  // is not independently verified -- see this function's header comment).
  const currencyCode = input.currencyCode ?? null;
  const fxRateToPortfolioDecimal = input.fxRateToPortfolioDecimal ?? null;
  const fxRateSource = input.fxRateSource ?? null;
  if (
    (fxRateToPortfolioDecimal !== null) !== (fxRateSource !== null) ||
    (fxRateToPortfolioDecimal !== null && currencyCode === null)
  ) {
    return { ok: false, reason: "invalid_input" };
  }
  if (currencyCode !== null && !isCurrencyCodeString(currencyCode)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (fxRateToPortfolioDecimal !== null) {
    // F3: an over-precision rate is rejected here, with an honest message,
    // rather than ever reaching storage.
    if (
      !isPositiveDecimalString(fxRateToPortfolioDecimal) ||
      !hasDecimalScaleWithinLimit(
        fxRateToPortfolioDecimal,
        MAX_FX_RATE_DECIMAL_SCALE,
      ) ||
      !isFxRateSourceString(fxRateSource)
    ) {
      return { ok: false, reason: "invalid_input" };
    }
  }

  const id = input.id ?? randomUUID();
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO dividend_manual_records (
        id, user_id, portfolio_id, portfolio_security_id, payment_date,
        shares_decimal, dividend_per_share_decimal,
        franking_credit_per_share_decimal, import_batch_id, source_reference,
        total_cash_decimal, total_franking_decimal,
        currency_code, fx_rate_to_portfolio_decimal, fx_rate_source,
        idempotency_key, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      params: [
        id,
        input.userId,
        input.portfolioId,
        input.portfolioSecurityId,
        input.paymentDate,
        sharesDecimal,
        dividendPerShareDecimal,
        frankingCreditPerShareDecimal,
        input.importBatchId,
        input.sourceReference,
        totalCashDecimal,
        totalFrankingDecimal,
        currencyCode,
        fxRateToPortfolioDecimal,
        fxRateSource,
        input.idempotencyKey ?? null,
        input.now,
        input.now,
      ],
    },
    createConditionalAuditInsertStatement(
      {
        actorUserId: input.userId,
        targetOwnerUserId: input.userId,
        action: "dividend.manual_record.create",
        targetType: "dividend_manual_record",
        targetId: id,
        requestId: input.requestId,
        result: "success",
        occurredAt: input.now,
      },
      "EXISTS (SELECT 1 FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ?)",
      [id, input.userId, input.portfolioId],
      () => input.now,
    ),
  ];
  return { ok: true, id, statements };
}

// ---------------------------------------------------------------------------
// Owner-scoped: dividend assumptions (DB-005 extension a).
//
// Every mutation here is a full replace of the sparse fields ("send all
// three, explicit null clears back to the provider fallback") rather than a
// COALESCE-style partial patch, so a caller can always restore a field to
// "unknown / fall back to provider" without a separate clear operation.
// Upsert is keyed by the natural target key (one row per portfolio-security
// / one row per portfolio): `expectedVersion: null` means "create, must not
// already exist"; a number means "update this exact version".
// ---------------------------------------------------------------------------

export type DividendSecurityAssumptionsRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  portfolioSecurityId: string;
  dividendYieldPercentDecimal: string | null;
  frankingPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  /** DIV-016 part B (override-as-bridge): `true` when the owner has
   * explicitly forced this security's yield/franking override to keep
   * winning regardless of `hasFullYearHistoryEvidence`. `false` (never
   * `null` at this mapped layer -- the stored column is nullable but a
   * NULL means exactly "not forced") is the default. */
  forceAssumption: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendSecurityAssumptionsInput = {
  dividendYieldPercentDecimal: string | null;
  frankingPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  forceAssumption: boolean;
  expectedVersion: number | null;
  requestId: string;
};

const DIVIDEND_SECURITY_ASSUMPTIONS_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id,
  dividend_yield_percent_decimal, franking_percent_decimal,
  dividend_growth_percent_decimal, force_assumption, created_at, updated_at,
  version
`;

function mapDividendSecurityAssumptions(
  row: Record<string, unknown>,
): DividendSecurityAssumptionsRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    portfolioSecurityId: String(row.portfolio_security_id),
    dividendYieldPercentDecimal:
      row.dividend_yield_percent_decimal === null
        ? null
        : String(row.dividend_yield_percent_decimal),
    frankingPercentDecimal:
      row.franking_percent_decimal === null
        ? null
        : String(row.franking_percent_decimal),
    dividendGrowthPercentDecimal:
      row.dividend_growth_percent_decimal === null
        ? null
        : String(row.dividend_growth_percent_decimal),
    forceAssumption:
      row.force_assumption === 1 || row.force_assumption === true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

export type DividendPortfolioAssumptionsRecord = {
  portfolioId: string;
  userId: string;
  valueGrowthPercentDecimal: string | null;
  portfolioDividendGrowthPercentDecimal: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendPortfolioAssumptionsInput = {
  valueGrowthPercentDecimal: string | null;
  portfolioDividendGrowthPercentDecimal: string | null;
  expectedVersion: number | null;
  requestId: string;
};

const DIVIDEND_PORTFOLIO_ASSUMPTIONS_COLUMNS = `
  portfolio_id, user_id, value_growth_percent_decimal,
  portfolio_dividend_growth_percent_decimal, created_at, updated_at, version
`;

function mapDividendPortfolioAssumptions(
  row: Record<string, unknown>,
): DividendPortfolioAssumptionsRecord {
  return {
    portfolioId: String(row.portfolio_id),
    userId: String(row.user_id),
    valueGrowthPercentDecimal:
      row.value_growth_percent_decimal === null
        ? null
        : String(row.value_growth_percent_decimal),
    portfolioDividendGrowthPercentDecimal:
      row.portfolio_dividend_growth_percent_decimal === null
        ? null
        : String(row.portfolio_dividend_growth_percent_decimal),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

export function createDividendAssumptionsRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function getSecurityAssumptions(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
  ): Promise<DividendSecurityAssumptionsRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_SECURITY_ASSUMPTIONS_COLUMNS}
       FROM dividend_security_assumptions
       WHERE portfolio_security_id = ? AND user_id = ? AND portfolio_id = ?
       LIMIT 1`,
      [portfolioSecurityId, userId, portfolioId],
    );
    return row ? mapDividendSecurityAssumptions(row) : null;
  }

  async function listSecurityAssumptions(
    userId: string,
    portfolioId: string,
  ): Promise<DividendSecurityAssumptionsRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${DIVIDEND_SECURITY_ASSUMPTIONS_COLUMNS}
       FROM dividend_security_assumptions
       WHERE user_id = ? AND portfolio_id = ?`,
      [userId, portfolioId],
    );
    return rows.map(mapDividendSecurityAssumptions);
  }

  async function saveSecurityAssumptions(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
    input: SaveDividendSecurityAssumptionsInput,
  ): Promise<
    | { ok: true; assumptions: DividendSecurityAssumptionsRecord }
    | DividendOwnerMutationFailure
  > {
    if (
      !isNullable(
        input.dividendYieldPercentDecimal,
        isNonNegativeDecimalString,
      ) ||
      !isNullable(input.frankingPercentDecimal, isNonNegativeDecimalString) ||
      !isNullable(input.dividendGrowthPercentDecimal, isDecimalString)
    )
      return { ok: false, reason: "invalid_input" };
    if (
      !(await ownedHoldingWithOptionalEvent(
        client,
        userId,
        portfolioId,
        portfolioSecurityId,
        null,
      ))
    )
      return { ok: false, reason: "not_found" };
    const updatedAt = now();
    // DIV-016 part B follow-up (b): `force_assumption` bridges an override
    // past 12+ months of history evidence (see `resolveAssumptionBridgeStatus`)
    // -- it is meaningless once NEITHER override field is set (`hasAnyOverride`
    // in `app/owned-dividend-assumptions.ts` is exactly "yield OR franking
    // non-null"), and the editor's force checkbox only renders while the
    // status is dormant/forced, i.e. while an override still exists. Without
    // this clamp, clearing both fields left the stored flag `true` with no
    // owner-visible control to unset it, and a LATER value re-entered into
    // either field would silently resurrect "forced" -- clamped here,
    // server-side, so the invariant holds regardless of what any caller
    // (grid save, a future direct API call) actually submits.
    const forceAssumption =
      input.forceAssumption &&
      (input.dividendYieldPercentDecimal !== null ||
        input.frankingPercentDecimal !== null);
    if (input.expectedVersion === null) {
      const id = randomUUID();
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO dividend_security_assumptions (
            id, user_id, portfolio_id, portfolio_security_id,
            dividend_yield_percent_decimal, franking_percent_decimal,
            dividend_growth_percent_decimal, force_assumption, created_at,
            updated_at, version
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1 FROM dividend_security_assumptions
            WHERE portfolio_security_id = ?
          )`,
          params: [
            id,
            userId,
            portfolioId,
            portfolioSecurityId,
            input.dividendYieldPercentDecimal,
            input.frankingPercentDecimal,
            input.dividendGrowthPercentDecimal,
            forceAssumption ? 1 : 0,
            updatedAt,
            updatedAt,
            portfolioSecurityId,
          ],
        },
        createConditionalAuditInsertStatement(
          {
            actorUserId: userId,
            targetOwnerUserId: userId,
            action: "dividend.assumptions.security.create",
            targetType: "dividend_security_assumptions",
            targetId: portfolioSecurityId,
            requestId: input.requestId,
            result: "success",
            occurredAt: updatedAt,
          },
          "EXISTS (SELECT 1 FROM dividend_security_assumptions WHERE id = ?)",
          [id],
          now,
        ),
      ];
      try {
        await client.batch(statements);
      } catch {
        return { ok: false, reason: "atomic_failure" };
      }
      const assumptions = await getSecurityAssumptions(
        userId,
        portfolioId,
        portfolioSecurityId,
      );
      return assumptions && assumptions.id === id
        ? { ok: true, assumptions }
        : { ok: false, reason: "version_conflict" };
    }
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.assumptions.security.update",
          targetType: "dividend_security_assumptions",
          targetId: portfolioSecurityId,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM dividend_security_assumptions WHERE portfolio_security_id = ? AND user_id = ? AND portfolio_id = ? AND version = ?)",
        [portfolioSecurityId, userId, portfolioId, input.expectedVersion],
        now,
      ),
      {
        sql: `UPDATE dividend_security_assumptions SET
          dividend_yield_percent_decimal = ?,
          franking_percent_decimal = ?,
          dividend_growth_percent_decimal = ?,
          force_assumption = ?,
          updated_at = ?, version = version + 1
        WHERE portfolio_security_id = ? AND user_id = ? AND portfolio_id = ?
          AND version = ?
        RETURNING ${DIVIDEND_SECURITY_ASSUMPTIONS_COLUMNS}`,
        params: [
          input.dividendYieldPercentDecimal,
          input.frankingPercentDecimal,
          input.dividendGrowthPercentDecimal,
          forceAssumption ? 1 : 0,
          updatedAt,
          portfolioSecurityId,
          userId,
          portfolioId,
          input.expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_security_assumptions WHERE portfolio_security_id = ? AND user_id = ? AND portfolio_id = ?",
        [portfolioSecurityId, userId, portfolioId],
      );
    return { ok: true, assumptions: mapDividendSecurityAssumptions(row) };
  }

  async function getPortfolioAssumptions(
    userId: string,
    portfolioId: string,
  ): Promise<DividendPortfolioAssumptionsRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_PORTFOLIO_ASSUMPTIONS_COLUMNS}
       FROM dividend_portfolio_assumptions
       WHERE portfolio_id = ? AND user_id = ? LIMIT 1`,
      [portfolioId, userId],
    );
    return row ? mapDividendPortfolioAssumptions(row) : null;
  }

  async function savePortfolioAssumptions(
    userId: string,
    portfolioId: string,
    input: SaveDividendPortfolioAssumptionsInput,
  ): Promise<
    | { ok: true; assumptions: DividendPortfolioAssumptionsRecord }
    | DividendOwnerMutationFailure
  > {
    if (
      !isNullable(input.valueGrowthPercentDecimal, isDecimalString) ||
      !isNullable(input.portfolioDividendGrowthPercentDecimal, isDecimalString)
    )
      return { ok: false, reason: "invalid_input" };
    if (!(await ownedPortfolio(client, userId, portfolioId)))
      return { ok: false, reason: "not_found" };
    const updatedAt = now();
    if (input.expectedVersion === null) {
      // This table has no surrogate id (portfolio_id is the natural PK), so
      // -- unlike the security-assumptions/fy-override/event-override
      // create paths below, which mint a fresh randomUUID() and use it as
      // an unambiguous "did MY insert fire" discriminator -- a duplicate
      // create attempt against an already-existing row is a real, expected
      // case, not a near-impossible id collision, and cannot be told apart
      // from "genuinely just created" by re-reading the row afterward (an
      // injected/mocked clock can make two calls share the same
      // created_at). Two techniques close this instead, both from the
      // guard-conditional-single-batch pattern documented in
      // docs/DATA_MODEL.md section 11:
      // 1. The main INSERT's own `RETURNING` is the sole authoritative
      //    signal for whether THIS call's statement inserted a row -- empty
      //    results means the NOT EXISTS guard failed, full stop.
      // 2. The audit INSERT is placed FIRST, guarded on the IDENTICAL
      //    pre-state `NOT EXISTS` predicate as the main INSERT. Since
      //    neither statement has written to dividend_portfolio_assumptions
      //    yet when the audit's guard evaluates (it runs before the write),
      //    both guards see the exact same table state and therefore always
      //    agree -- both fire together on a genuine create, both no-op
      //    together on a duplicate -- independent of clock values.
      const statements: SqlStatement[] = [
        createConditionalAuditInsertStatement(
          {
            actorUserId: userId,
            targetOwnerUserId: userId,
            action: "dividend.assumptions.portfolio.create",
            targetType: "dividend_portfolio_assumptions",
            targetId: portfolioId,
            requestId: input.requestId,
            result: "success",
            occurredAt: updatedAt,
          },
          "NOT EXISTS (SELECT 1 FROM dividend_portfolio_assumptions WHERE portfolio_id = ?)",
          [portfolioId],
          now,
        ),
        {
          sql: `INSERT INTO dividend_portfolio_assumptions (
            portfolio_id, user_id, value_growth_percent_decimal,
            portfolio_dividend_growth_percent_decimal, created_at,
            updated_at, version
          )
          SELECT ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1 FROM dividend_portfolio_assumptions
            WHERE portfolio_id = ?
          )
          RETURNING portfolio_id`,
          params: [
            portfolioId,
            userId,
            input.valueGrowthPercentDecimal,
            input.portfolioDividendGrowthPercentDecimal,
            updatedAt,
            updatedAt,
            portfolioId,
          ],
        },
      ];
      let batchResult;
      try {
        batchResult = await client.batch(statements);
      } catch {
        return { ok: false, reason: "atomic_failure" };
      }
      if (!batchResult[1]?.results[0])
        return { ok: false, reason: "version_conflict" };
      const assumptions = await getPortfolioAssumptions(userId, portfolioId);
      return assumptions
        ? { ok: true, assumptions }
        : { ok: false, reason: "atomic_failure" };
    }
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.assumptions.portfolio.update",
          targetType: "dividend_portfolio_assumptions",
          targetId: portfolioId,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM dividend_portfolio_assumptions WHERE portfolio_id = ? AND user_id = ? AND version = ?)",
        [portfolioId, userId, input.expectedVersion],
        now,
      ),
      {
        sql: `UPDATE dividend_portfolio_assumptions SET
          value_growth_percent_decimal = ?,
          portfolio_dividend_growth_percent_decimal = ?,
          updated_at = ?, version = version + 1
        WHERE portfolio_id = ? AND user_id = ? AND version = ?
        RETURNING ${DIVIDEND_PORTFOLIO_ASSUMPTIONS_COLUMNS}`,
        params: [
          input.valueGrowthPercentDecimal,
          input.portfolioDividendGrowthPercentDecimal,
          updatedAt,
          portfolioId,
          userId,
          input.expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT portfolio_id FROM dividend_portfolio_assumptions WHERE portfolio_id = ? AND user_id = ?",
        [portfolioId, userId],
      );
    return { ok: true, assumptions: mapDividendPortfolioAssumptions(row) };
  }

  return {
    getSecurityAssumptions,
    listSecurityAssumptions,
    saveSecurityAssumptions,
    getPortfolioAssumptions,
    savePortfolioAssumptions,
  };
}

// ---------------------------------------------------------------------------
// Owner-scoped: dividend_fy_overrides (DB-005 extension b).
// ---------------------------------------------------------------------------

export type DividendFyOverrideRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  financialYearEndingYear: number;
  grossedAmountDecimal: string;
  frankingAmountDecimal: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendFyOverrideInput = {
  grossedAmountDecimal: string;
  frankingAmountDecimal: string | null;
  expectedVersion: number | null;
  requestId: string;
};

const DIVIDEND_FY_OVERRIDE_COLUMNS = `
  id, user_id, portfolio_id, financial_year_ending_year,
  grossed_amount_decimal, franking_amount_decimal, created_at, updated_at,
  version
`;

function mapDividendFyOverride(
  row: Record<string, unknown>,
): DividendFyOverrideRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    financialYearEndingYear: Number(row.financial_year_ending_year),
    grossedAmountDecimal: String(row.grossed_amount_decimal),
    frankingAmountDecimal:
      row.franking_amount_decimal === null
        ? null
        : String(row.franking_amount_decimal),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

export function createDividendFyOverrideRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(
    userId: string,
    portfolioId: string,
    financialYearEndingYear: number,
  ): Promise<DividendFyOverrideRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_FY_OVERRIDE_COLUMNS} FROM dividend_fy_overrides
       WHERE portfolio_id = ? AND user_id = ? AND financial_year_ending_year = ?
       LIMIT 1`,
      [portfolioId, userId, financialYearEndingYear],
    );
    return row ? mapDividendFyOverride(row) : null;
  }

  async function list(
    userId: string,
    portfolioId: string,
  ): Promise<DividendFyOverrideRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${DIVIDEND_FY_OVERRIDE_COLUMNS} FROM dividend_fy_overrides
       WHERE user_id = ? AND portfolio_id = ?
       ORDER BY financial_year_ending_year DESC`,
      [userId, portfolioId],
    );
    return rows.map(mapDividendFyOverride);
  }

  async function save(
    userId: string,
    portfolioId: string,
    financialYearEndingYear: number,
    input: SaveDividendFyOverrideInput,
  ): Promise<
    | { ok: true; override: DividendFyOverrideRecord }
    | DividendOwnerMutationFailure
  > {
    if (
      !isNonNegativeDecimalString(input.grossedAmountDecimal) ||
      !isNullable(input.frankingAmountDecimal, isNonNegativeDecimalString) ||
      !Number.isInteger(financialYearEndingYear) ||
      financialYearEndingYear < 1900 ||
      financialYearEndingYear > 2999
    )
      return { ok: false, reason: "invalid_input" };
    if (!(await ownedPortfolio(client, userId, portfolioId)))
      return { ok: false, reason: "not_found" };
    const updatedAt = now();
    if (input.expectedVersion === null) {
      const id = randomUUID();
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO dividend_fy_overrides (
            id, user_id, portfolio_id, financial_year_ending_year,
            grossed_amount_decimal, franking_amount_decimal, created_at,
            updated_at, version
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1 FROM dividend_fy_overrides
            WHERE portfolio_id = ? AND financial_year_ending_year = ?
          )`,
          params: [
            id,
            userId,
            portfolioId,
            financialYearEndingYear,
            input.grossedAmountDecimal,
            input.frankingAmountDecimal,
            updatedAt,
            updatedAt,
            portfolioId,
            financialYearEndingYear,
          ],
        },
        createConditionalAuditInsertStatement(
          {
            actorUserId: userId,
            targetOwnerUserId: userId,
            action: "dividend.fy_override.create",
            targetType: "dividend_fy_override",
            targetId: id,
            requestId: input.requestId,
            result: "success",
            occurredAt: updatedAt,
          },
          "EXISTS (SELECT 1 FROM dividend_fy_overrides WHERE id = ?)",
          [id],
          now,
        ),
      ];
      try {
        await client.batch(statements);
      } catch {
        return { ok: false, reason: "atomic_failure" };
      }
      const override = await get(userId, portfolioId, financialYearEndingYear);
      return override && override.id === id
        ? { ok: true, override }
        : { ok: false, reason: "version_conflict" };
    }
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.fy_override.update",
          targetType: "dividend_fy_override",
          targetId: `${portfolioId}:${financialYearEndingYear}`,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM dividend_fy_overrides WHERE portfolio_id = ? AND user_id = ? AND financial_year_ending_year = ? AND version = ?)",
        [portfolioId, userId, financialYearEndingYear, input.expectedVersion],
        now,
      ),
      {
        sql: `UPDATE dividend_fy_overrides SET
          grossed_amount_decimal = ?, franking_amount_decimal = ?,
          updated_at = ?, version = version + 1
        WHERE portfolio_id = ? AND user_id = ? AND financial_year_ending_year = ?
          AND version = ?
        RETURNING ${DIVIDEND_FY_OVERRIDE_COLUMNS}`,
        params: [
          input.grossedAmountDecimal,
          input.frankingAmountDecimal,
          updatedAt,
          portfolioId,
          userId,
          financialYearEndingYear,
          input.expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_fy_overrides WHERE portfolio_id = ? AND user_id = ? AND financial_year_ending_year = ?",
        [portfolioId, userId, financialYearEndingYear],
      );
    return { ok: true, override: mapDividendFyOverride(row) };
  }

  async function remove(
    userId: string,
    portfolioId: string,
    financialYearEndingYear: number,
    expectedVersion: number,
    requestId: string,
  ): Promise<{ ok: true } | DividendOwnerMutationFailure> {
    const occurredAt = now();
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.fy_override.delete",
          targetType: "dividend_fy_override",
          targetId: `${portfolioId}:${financialYearEndingYear}`,
          requestId,
          result: "success",
          occurredAt,
        },
        "EXISTS (SELECT 1 FROM dividend_fy_overrides WHERE portfolio_id = ? AND user_id = ? AND financial_year_ending_year = ? AND version = ?)",
        [portfolioId, userId, financialYearEndingYear, expectedVersion],
        now,
      ),
      {
        sql: `DELETE FROM dividend_fy_overrides
              WHERE portfolio_id = ? AND user_id = ? AND financial_year_ending_year = ?
                AND version = ?
              RETURNING id`,
        params: [portfolioId, userId, financialYearEndingYear, expectedVersion],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_fy_overrides WHERE portfolio_id = ? AND user_id = ? AND financial_year_ending_year = ?",
        [portfolioId, userId, financialYearEndingYear],
      );
    return { ok: true };
  }

  return { get, list, save, remove };
}

// ---------------------------------------------------------------------------
// Owner-scoped: dividend_event_overrides (DB-005 extension c).
// ---------------------------------------------------------------------------

export type DividendEventOverrideRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  portfolioSecurityId: string;
  dividendEventId: string;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  exclude: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendEventOverrideInput = {
  // Tri-state: omitted = unchanged (on update) / not set (on create);
  // explicit `null` = clear back to the read-time auto-derivation.
  sharesDecimal?: string | null;
  dividendPerShareDecimal?: string | null;
  frankingCreditPerShareDecimal?: string | null;
  // Plain optional, not tri-state (booleans have no meaningful "clear"
  // state distinct from `false`): omitted defaults to `false` on create and
  // leaves the column unchanged on update.
  exclude?: boolean;
  expectedVersion: number | null;
  requestId: string;
};

const DIVIDEND_EVENT_OVERRIDE_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id, dividend_event_id,
  shares_decimal, dividend_per_share_decimal,
  franking_credit_per_share_decimal, exclude, created_at, updated_at, version
`;

function mapDividendEventOverride(
  row: Record<string, unknown>,
): DividendEventOverrideRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    portfolioSecurityId: String(row.portfolio_security_id),
    dividendEventId: String(row.dividend_event_id),
    sharesDecimal:
      row.shares_decimal === null ? null : String(row.shares_decimal),
    dividendPerShareDecimal:
      row.dividend_per_share_decimal === null
        ? null
        : String(row.dividend_per_share_decimal),
    frankingCreditPerShareDecimal:
      row.franking_credit_per_share_decimal === null
        ? null
        : String(row.franking_credit_per_share_decimal),
    exclude: Boolean(row.exclude),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

export function createDividendEventOverrideRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
    dividendEventId: string,
  ): Promise<DividendEventOverrideRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_EVENT_OVERRIDE_COLUMNS} FROM dividend_event_overrides
       WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
         AND dividend_event_id = ?
       LIMIT 1`,
      [userId, portfolioId, portfolioSecurityId, dividendEventId],
    );
    return row ? mapDividendEventOverride(row) : null;
  }

  async function list(
    userId: string,
    portfolioId: string,
    portfolioSecurityId?: string,
  ): Promise<DividendEventOverrideRecord[]> {
    const predicate = portfolioSecurityId
      ? "AND portfolio_security_id = ?"
      : "";
    const params = portfolioSecurityId
      ? [userId, portfolioId, portfolioSecurityId]
      : [userId, portfolioId];
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${DIVIDEND_EVENT_OVERRIDE_COLUMNS} FROM dividend_event_overrides
       WHERE user_id = ? AND portfolio_id = ? ${predicate}`,
      params,
    );
    return rows.map(mapDividendEventOverride);
  }

  async function save(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
    dividendEventId: string,
    input: SaveDividendEventOverrideInput,
  ): Promise<
    | { ok: true; override: DividendEventOverrideRecord }
    | DividendOwnerMutationFailure
  > {
    const sharesProvided = hasOwn(input, "sharesDecimal");
    const dpsProvided = hasOwn(input, "dividendPerShareDecimal");
    const frankingProvided = hasOwn(input, "frankingCreditPerShareDecimal");
    const excludeProvided = hasOwn(input, "exclude");
    if (
      (sharesProvided &&
        !isNullable(input.sharesDecimal, isPositiveDecimalString)) ||
      (dpsProvided &&
        !isNullable(input.dividendPerShareDecimal, isPositiveDecimalString)) ||
      (frankingProvided &&
        !isNullable(
          input.frankingCreditPerShareDecimal,
          isNonNegativeDecimalString,
        ))
    )
      return { ok: false, reason: "invalid_input" };
    if (
      !(await ownedHoldingWithOptionalEvent(
        client,
        userId,
        portfolioId,
        portfolioSecurityId,
        dividendEventId,
      ))
    )
      return { ok: false, reason: "not_found" };
    const updatedAt = now();
    if (input.expectedVersion === null) {
      // Create: an omitted sparse field has no prior value to preserve, so
      // it is simply not set (NULL); an omitted `exclude` defaults to false.
      const id = randomUUID();
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO dividend_event_overrides (
            id, user_id, portfolio_id, portfolio_security_id,
            dividend_event_id, shares_decimal, dividend_per_share_decimal,
            franking_credit_per_share_decimal, exclude, created_at,
            updated_at, version
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1 FROM dividend_event_overrides
            WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
              AND dividend_event_id = ?
          )`,
          params: [
            id,
            userId,
            portfolioId,
            portfolioSecurityId,
            dividendEventId,
            sharesProvided ? (input.sharesDecimal ?? null) : null,
            dpsProvided ? (input.dividendPerShareDecimal ?? null) : null,
            frankingProvided
              ? (input.frankingCreditPerShareDecimal ?? null)
              : null,
            excludeProvided ? (input.exclude ? 1 : 0) : 0,
            updatedAt,
            updatedAt,
            userId,
            portfolioId,
            portfolioSecurityId,
            dividendEventId,
          ],
        },
        createConditionalAuditInsertStatement(
          {
            actorUserId: userId,
            targetOwnerUserId: userId,
            action: "dividend.event_override.create",
            targetType: "dividend_event_override",
            targetId: id,
            requestId: input.requestId,
            result: "success",
            occurredAt: updatedAt,
          },
          "EXISTS (SELECT 1 FROM dividend_event_overrides WHERE id = ?)",
          [id],
          now,
        ),
      ];
      try {
        await client.batch(statements);
      } catch {
        return { ok: false, reason: "atomic_failure" };
      }
      const override = await get(
        userId,
        portfolioId,
        portfolioSecurityId,
        dividendEventId,
      );
      return override && override.id === id
        ? { ok: true, override }
        : { ok: false, reason: "version_conflict" };
    }
    // Update: every sparse field (including `exclude`) is tri-state --
    // omitted leaves the column unchanged (a shares-only edit must not wipe
    // known franking, DPS, or the exclude flag -- DB-005 review finding B2
    // and its "mirror for event-override" follow-up); explicit `null`
    // clears a nullable field back to the read-time auto-derivation.
    const shares = triStateAssignment(
      "shares_decimal",
      sharesProvided,
      input.sharesDecimal,
    );
    const dps = triStateAssignment(
      "dividend_per_share_decimal",
      dpsProvided,
      input.dividendPerShareDecimal,
    );
    const franking = triStateAssignment(
      "franking_credit_per_share_decimal",
      frankingProvided,
      input.frankingCreditPerShareDecimal,
    );
    const exclude = triStateAssignment(
      "exclude",
      excludeProvided,
      excludeProvided ? (input.exclude ? 1 : 0) : null,
    );
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.event_override.update",
          targetType: "dividend_event_override",
          targetId: `${portfolioSecurityId}:${dividendEventId}`,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM dividend_event_overrides WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ? AND dividend_event_id = ? AND version = ?)",
        [
          userId,
          portfolioId,
          portfolioSecurityId,
          dividendEventId,
          input.expectedVersion,
        ],
        now,
      ),
      {
        sql: `UPDATE dividend_event_overrides SET
          ${shares.fragment}, ${dps.fragment},
          ${franking.fragment}, ${exclude.fragment},
          updated_at = ?, version = version + 1
        WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
          AND dividend_event_id = ? AND version = ?
        RETURNING ${DIVIDEND_EVENT_OVERRIDE_COLUMNS}`,
        params: [
          ...shares.params,
          ...dps.params,
          ...franking.params,
          ...exclude.params,
          updatedAt,
          userId,
          portfolioId,
          portfolioSecurityId,
          dividendEventId,
          input.expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_event_overrides WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ? AND dividend_event_id = ?",
        [userId, portfolioId, portfolioSecurityId, dividendEventId],
      );
    return { ok: true, override: mapDividendEventOverride(row) };
  }

  async function remove(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
    dividendEventId: string,
    expectedVersion: number,
    requestId: string,
  ): Promise<{ ok: true } | DividendOwnerMutationFailure> {
    const occurredAt = now();
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.event_override.delete",
          targetType: "dividend_event_override",
          targetId: `${portfolioSecurityId}:${dividendEventId}`,
          requestId,
          result: "success",
          occurredAt,
        },
        "EXISTS (SELECT 1 FROM dividend_event_overrides WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ? AND dividend_event_id = ? AND version = ?)",
        [
          userId,
          portfolioId,
          portfolioSecurityId,
          dividendEventId,
          expectedVersion,
        ],
        now,
      ),
      {
        sql: `DELETE FROM dividend_event_overrides
              WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
                AND dividend_event_id = ? AND version = ?
              RETURNING id`,
        params: [
          userId,
          portfolioId,
          portfolioSecurityId,
          dividendEventId,
          expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_event_overrides WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ? AND dividend_event_id = ?",
        [userId, portfolioId, portfolioSecurityId, dividendEventId],
      );
    return { ok: true };
  }

  return { get, list, save, remove };
}

// ---------------------------------------------------------------------------
// Owner-scoped: dividend_manual_records (DB-005 extension d).
// ---------------------------------------------------------------------------

export type DividendManualRecordRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  portfolioSecurityId: string;
  paymentDate: string;
  // BRK-005: nullable -- a Sharesight payout row (totals mode, see
  // `BuildDividendManualRecordImportInsertInput`'s header note) genuinely
  // has no per-share fact, so these are `null` on that row alone. Every
  // pre-BRK-005 row (owner-typed or CSV-imported) still has both set.
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  // IMP-006: set only for rows a CSV import batch created; null for rows
  // entered directly through the manual dividend-entry UI.
  importBatchId: string | null;
  sourceReference: string | null;
  // UI-009: client-generated key (crypto.randomUUID at dialog-open time,
  // stable across retries within one dialog session) used to dedupe a
  // retry-after-timeout on the standalone manual-create path. Null for
  // every row created without one (all pre-UI-009 rows, and any future
  // caller that doesn't supply one).
  idempotencyKey: string | null;
  // BRK-005: set only for a totals-mode Sharesight payout row; null for
  // every per-share row (owner-typed or CSV-imported).
  totalCashDecimal: string | null;
  totalFrankingDecimal: string | null;
  // BRK-010 review finding B4: `fxRateToPortfolioDecimal`/`fxRateSource`
  // are paired (all-or-neither) and never present without `currencyCode`,
  // but `currencyCode` MAY stand alone (see `db/schema.ts`'s header note
  // and `dividend_manual_records_fx_provenance_check`). NULL `currencyCode`
  // means "already in this row's own SECURITY's currency" -- every
  // pre-BRK-010 row and every native row going forward.
  currencyCode: string | null;
  fxRateToPortfolioDecimal: string | null;
  fxRateSource: string | null;
  // DIV-016 part A: non-null exactly when a LATER correction superseded
  // this row -- the id of that successor row. NULL means this row is the
  // current head of its own lineage (every pre-DIV-016 row, and the most
  // recent row of every lineage). See `db/schema.ts`'s header note.
  supersededByRecordId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendManualRecordInput = {
  id?: string;
  portfolioSecurityId: string;
  paymentDate: string;
  // DIV-016 part A: exactly one of the two modes below, mirroring
  // `BuildDividendManualRecordImportInsertInput`'s established disjunction
  // (`validateManualRecordAmounts` re-validates the same
  // `dividend_manual_records_amount_mode_check` invariant this function
  // enforces at the import-commit boundary) -- PER-SHARE supplies
  // `sharesDecimal`/`dividendPerShareDecimal` (optionally
  // `frankingCreditPerShareDecimal`); TOTALS supplies `totalCashDecimal`
  // (optionally `totalFrankingDecimal`), leaving the per-share fields
  // unset. Both are still declared required-non-nullable below for
  // backward compatibility with every pre-DIV-016 caller, which always
  // supplies both per-share fields; a totals-mode caller passes `undefined`
  // for them via a structurally-widened call site (TypeScript does not
  // enforce this disjunction at the type level, matching the import
  // builder's own equivalent input type -- enforcement is runtime, in
  // `validateManualRecordAmounts`).
  sharesDecimal?: string | null;
  dividendPerShareDecimal?: string | null;
  frankingCreditPerShareDecimal?: string | null;
  totalCashDecimal?: string | null;
  totalFrankingDecimal?: string | null;
  // UI-009: when supplied (non-empty), `create()` dedupes on
  // (portfolioSecurityId, idempotencyKey) -- a retry with the same key
  // after a client-visible timeout returns the ALREADY-CREATED record as a
  // success, never a second row. Absent/undefined preserves the pre-UI-009
  // behaviour (no dedupe).
  idempotencyKey?: string | null;
  requestId: string;
};

/**
 * DIV-016 part A: the owner-facing CORRECTION path for `dividend_manual_
 * records`, replacing the pre-DIV-016 `update()` (a genuine in-place
 * `UPDATE ... SET shares_decimal = ...`, which violated AGENTS.md's
 * ledger-immutability rule -- "corrections use reversal/supersession...
 * never silent history rewrites"). `supersede()` below creates a NEW row
 * carrying the corrected facts and marks the OLD row's
 * `supersededByRecordId` (never rewriting the old row's own financial
 * fields), mirroring `db/repositories/ledger.ts`'s `supersede()` for
 * `transactions`. Every field is OPTIONAL (tri-state via `hasOwn`,
 * mirroring the pre-DIV-016 `update()`'s partial-patch convention exactly)
 * -- an omitted field carries forward the ORIGINAL row's own value; an
 * explicit `null` on a nullable field clears it. Supplying either
 * `totalCashDecimal` or a per-share field switches the corrected row's
 * MODE even if the original was the other mode -- see
 * `resolveSupersedeAmounts`'s doc comment.
 */
export type SupersedeDividendManualRecordInput = {
  paymentDate?: string;
  sharesDecimal?: string | null;
  dividendPerShareDecimal?: string | null;
  frankingCreditPerShareDecimal?: string | null;
  totalCashDecimal?: string | null;
  totalFrankingDecimal?: string | null;
  expectedVersion: number;
  // UI-009 extension (DIV-016 part A): the SAME dialog-session key used for
  // the standalone CREATE path (`app/components/dividend-assumptions-
  // editor.tsx`'s `dialogIdempotencyKey`) is also sent on an edit submit.
  // Review fix (B1, BLOCKING): storing this RAW key verbatim on the
  // successor row collided with `dividend_manual_records_security_
  // idempotency_unique` (`portfolio_security_id`, `idempotency_key`) --
  // that pair is ALREADY claimed by the record's own original CREATE (the
  // dialog reuses one key for the whole session), so a create-then-edit or
  // edit-then-edit in one dialog session aborted the supersede batch with
  // an opaque 503, silently losing the correction. `supersede()` instead
  // derives and stores `` `supersede:${id}:${key}` `` (`id` = the record
  // BEING superseded) -- unique per correction STEP, never colliding with
  // the CREATE's own stored key or another step's. A retry-after-timeout
  // of THIS exact step re-derives the IDENTICAL key (same `id`, same raw
  // key) and dedupes; a SECOND, deliberate edit later in the same dialog
  // session targets the NEW row `supersede()` just created (a different
  // `id`), so its derived key differs even though the raw dialog key is
  // identical, and is never mistaken for a retry of the first.
  idempotencyKey?: string | null;
  requestId: string;
};

const DIVIDEND_MANUAL_RECORD_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id, payment_date,
  shares_decimal, dividend_per_share_decimal,
  franking_credit_per_share_decimal, import_batch_id, source_reference,
  idempotency_key, total_cash_decimal, total_franking_decimal,
  currency_code, fx_rate_to_portfolio_decimal, fx_rate_source,
  superseded_by_record_id, created_at, updated_at, version
`;

function mapDividendManualRecord(
  row: Record<string, unknown>,
): DividendManualRecordRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    portfolioSecurityId: String(row.portfolio_security_id),
    paymentDate: String(row.payment_date),
    sharesDecimal:
      row.shares_decimal === null ? null : String(row.shares_decimal),
    dividendPerShareDecimal:
      row.dividend_per_share_decimal === null
        ? null
        : String(row.dividend_per_share_decimal),
    frankingCreditPerShareDecimal:
      row.franking_credit_per_share_decimal === null
        ? null
        : String(row.franking_credit_per_share_decimal),
    importBatchId:
      row.import_batch_id === null ? null : String(row.import_batch_id),
    idempotencyKey:
      row.idempotency_key === null ? null : String(row.idempotency_key),
    sourceReference:
      row.source_reference === null ? null : String(row.source_reference),
    totalCashDecimal:
      row.total_cash_decimal === null ? null : String(row.total_cash_decimal),
    totalFrankingDecimal:
      row.total_franking_decimal === null
        ? null
        : String(row.total_franking_decimal),
    currencyCode: row.currency_code === null ? null : String(row.currency_code),
    fxRateToPortfolioDecimal:
      row.fx_rate_to_portfolio_decimal === null
        ? null
        : String(row.fx_rate_to_portfolio_decimal),
    fxRateSource:
      row.fx_rate_source === null ? null : String(row.fx_rate_source),
    supersededByRecordId:
      row.superseded_by_record_id === null
        ? null
        : String(row.superseded_by_record_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

/** Numeric decimal-string equality (mirrors
 * `app/dividend-history-prefill.ts`'s `decimalsEqual`, duplicated locally
 * rather than imported so this server-only repository layer never depends
 * on `app/`): two decimal STRINGS at different textual scale ("0.50" vs
 * "0.5") represent the same value and must not read as a material
 * difference. Falls back to raw string comparison on a malformed string
 * (never expected from already-validated input) rather than throwing. */
function manualRecordDecimalsEqual(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return (
      compareDecimal(parseDecimalResult(left), parseDecimalResult(right)) === 0
    );
  } catch {
    return false;
  }
}

/**
 * UI-009 finishing item 1: whether an idempotency-key retry's incoming
 * payload actually matches what is stored, or whether the owner changed
 * the form's material fields between the original (successfully committed)
 * save and a client-visible-timeout retry -- e.g. edited the amount after
 * the first submit appeared to hang, then resubmitted. Comparing ONLY the
 * fields that determine the dividend's financial meaning (payment date,
 * shares, dividend per share, franking -- or, DIV-016 part A, the totals-
 * mode equivalents); `id`/`version`/timestamps are never part of this
 * comparison. A `true` result means the caller must disclose that the
 * STORED values (not the just-submitted ones) are what actually persisted,
 * never silently claim the new payload was saved.
 */
function manualRecordMaterialFieldsDiffer(
  existing: DividendManualRecordRecord,
  input: SaveDividendManualRecordInput,
): boolean {
  if (existing.paymentDate !== input.paymentDate) return true;
  const existingIsTotals = existing.sharesDecimal === null;
  const inputIsTotals =
    input.totalCashDecimal !== undefined && input.totalCashDecimal !== null;
  // DIV-016 part A: a retry that switched mode from what is actually stored
  // is never the SAME save -- reads as "differs" so the caller discloses
  // the stored (unchanged) truth rather than silently accepting the new
  // shape as if it were the original save.
  if (existingIsTotals !== inputIsTotals) return true;
  if (existingIsTotals) {
    if (existing.totalCashDecimal === null || input.totalCashDecimal == null) {
      return true;
    }
    if (
      !manualRecordDecimalsEqual(
        existing.totalCashDecimal,
        input.totalCashDecimal,
      )
    )
      return true;
    const inputTotalFranking = input.totalFrankingDecimal ?? null;
    if (existing.totalFrankingDecimal === null || inputTotalFranking === null) {
      return existing.totalFrankingDecimal !== inputTotalFranking;
    }
    return !manualRecordDecimalsEqual(
      existing.totalFrankingDecimal,
      inputTotalFranking,
    );
  }
  if (
    existing.sharesDecimal === null ||
    existing.dividendPerShareDecimal === null ||
    input.sharesDecimal == null ||
    input.dividendPerShareDecimal == null
  ) {
    return true;
  }
  if (!manualRecordDecimalsEqual(existing.sharesDecimal, input.sharesDecimal))
    return true;
  if (
    !manualRecordDecimalsEqual(
      existing.dividendPerShareDecimal,
      input.dividendPerShareDecimal,
    )
  )
    return true;
  const inputFranking = input.frankingCreditPerShareDecimal ?? null;
  if (
    existing.frankingCreditPerShareDecimal === null ||
    inputFranking === null
  ) {
    return existing.frankingCreditPerShareDecimal !== inputFranking;
  }
  return !manualRecordDecimalsEqual(
    existing.frankingCreditPerShareDecimal,
    inputFranking,
  );
}

/**
 * DIV-016 part A: the shared amount-mode validator for a fully-specified
 * (non-partial) manual-record write -- `create()`'s CREATE path, where
 * every field is always freshly supplied (there is no "original" to carry
 * a field forward from). Mirrors `buildDividendManualRecordImportInsertStatements`'s
 * exact disjunction (`totalsMode === perShareMode` rejects both-or-neither)
 * so this table's ONE amount-mode invariant
 * (`dividend_manual_records_amount_mode_check`) has a single re-validation
 * shape shared by every write path, never a second drifted copy. Returns
 * `null` on any invalid shape/value.
 */
function validateManualRecordAmounts(input: {
  sharesDecimal?: string | null;
  dividendPerShareDecimal?: string | null;
  frankingCreditPerShareDecimal?: string | null;
  totalCashDecimal?: string | null;
  totalFrankingDecimal?: string | null;
}): {
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  totalCashDecimal: string | null;
  totalFrankingDecimal: string | null;
} | null {
  const totalsMode =
    input.totalCashDecimal !== undefined && input.totalCashDecimal !== null;
  const perShareMode =
    (input.sharesDecimal !== undefined && input.sharesDecimal !== null) ||
    (input.dividendPerShareDecimal !== undefined &&
      input.dividendPerShareDecimal !== null);
  if (totalsMode === perShareMode) return null;
  if (perShareMode) {
    if (
      !isPositiveDecimalString(input.sharesDecimal) ||
      !isPositiveDecimalString(input.dividendPerShareDecimal) ||
      !isNullable(
        input.frankingCreditPerShareDecimal ?? null,
        isNonNegativeDecimalString,
      )
    ) {
      return null;
    }
    return {
      sharesDecimal: input.sharesDecimal,
      dividendPerShareDecimal: input.dividendPerShareDecimal,
      frankingCreditPerShareDecimal:
        input.frankingCreditPerShareDecimal ?? null,
      totalCashDecimal: null,
      totalFrankingDecimal: null,
    };
  }
  if (
    !isPositiveDecimalString(input.totalCashDecimal) ||
    !isNullable(input.totalFrankingDecimal ?? null, isNonNegativeDecimalString)
  ) {
    return null;
  }
  return {
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: input.totalCashDecimal,
    totalFrankingDecimal: input.totalFrankingDecimal ?? null,
  };
}

/**
 * DIV-016 part A: `supersede()`'s amount-mode resolver -- unlike
 * `validateManualRecordAmounts` above (a fully-specified CREATE), a
 * correction is a PARTIAL patch (mirrors the pre-DIV-016 `update()`'s own
 * `hasOwn`-gated tri-state convention exactly, see
 * `SupersedeDividendManualRecordInput`'s doc comment): any field the
 * caller does not mention carries forward from `original`. The target MODE
 * is whichever the caller's present fields imply; if the caller mentions
 * neither a total nor a per-share field at all, the mode carries forward
 * from `original` too (a pure date/franking-only correction that never
 * touches the amount shape).
 */
function resolveSupersedeAmounts(
  original: DividendManualRecordRecord,
  input: SupersedeDividendManualRecordInput,
): {
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  totalCashDecimal: string | null;
  totalFrankingDecimal: string | null;
} | null {
  const suppliesTotals =
    hasOwn(input, "totalCashDecimal") && input.totalCashDecimal != null;
  const suppliesPerShare =
    (hasOwn(input, "sharesDecimal") && input.sharesDecimal != null) ||
    (hasOwn(input, "dividendPerShareDecimal") &&
      input.dividendPerShareDecimal != null);
  if (suppliesTotals && suppliesPerShare) return null;
  const originalIsTotals = original.sharesDecimal === null;
  const useTotals = suppliesTotals
    ? true
    : suppliesPerShare
      ? false
      : originalIsTotals;

  if (useTotals) {
    const totalCashDecimal = hasOwn(input, "totalCashDecimal")
      ? (input.totalCashDecimal ?? null)
      : original.totalCashDecimal;
    const totalFrankingDecimal = hasOwn(input, "totalFrankingDecimal")
      ? (input.totalFrankingDecimal ?? null)
      : original.totalFrankingDecimal;
    if (
      !isPositiveDecimalString(totalCashDecimal) ||
      !isNullable(totalFrankingDecimal, isNonNegativeDecimalString)
    ) {
      return null;
    }
    return {
      sharesDecimal: null,
      dividendPerShareDecimal: null,
      frankingCreditPerShareDecimal: null,
      totalCashDecimal,
      totalFrankingDecimal,
    };
  }
  const sharesDecimal = hasOwn(input, "sharesDecimal")
    ? (input.sharesDecimal ?? null)
    : original.sharesDecimal;
  const dividendPerShareDecimal = hasOwn(input, "dividendPerShareDecimal")
    ? (input.dividendPerShareDecimal ?? null)
    : original.dividendPerShareDecimal;
  const frankingCreditPerShareDecimal = hasOwn(
    input,
    "frankingCreditPerShareDecimal",
  )
    ? (input.frankingCreditPerShareDecimal ?? null)
    : original.frankingCreditPerShareDecimal;
  if (
    !isPositiveDecimalString(sharesDecimal) ||
    !isPositiveDecimalString(dividendPerShareDecimal) ||
    !isNullable(frankingCreditPerShareDecimal, isNonNegativeDecimalString)
  ) {
    return null;
  }
  return {
    sharesDecimal,
    dividendPerShareDecimal,
    frankingCreditPerShareDecimal,
    totalCashDecimal: null,
    totalFrankingDecimal: null,
  };
}

/**
 * DIV-016 part A follow-up (UI-009 disclosure parity): the supersede-path
 * equivalent of `manualRecordMaterialFieldsDiffer` above, comparing an
 * ALREADY-DEDUPED successor row against the RESOLVED (mode-aware, tri-state
 * partial-patch already applied) amounts a retry just submitted -- never
 * the raw request input, since `resolveSupersedeAmounts` may have carried
 * an omitted field forward from `original` rather than the caller
 * re-sending it. `paymentDate`/`amounts` here are always the SAME values
 * `supersede()` itself would have persisted for this exact request, so a
 * `true` result means the stored successor was created by a DIFFERENT
 * request (the owner edited the form between the original attempt and this
 * retry) and the caller must disclose the STORED truth instead of silently
 * claiming the just-submitted values were saved.
 */
function supersedeStoredDiffers(
  stored: DividendManualRecordRecord,
  paymentDate: string,
  amounts: {
    sharesDecimal: string | null;
    dividendPerShareDecimal: string | null;
    frankingCreditPerShareDecimal: string | null;
    totalCashDecimal: string | null;
    totalFrankingDecimal: string | null;
  },
): boolean {
  if (stored.paymentDate !== paymentDate) return true;
  const storedIsTotals = stored.sharesDecimal === null;
  const intendedIsTotals = amounts.totalCashDecimal !== null;
  if (storedIsTotals !== intendedIsTotals) return true;
  if (storedIsTotals) {
    if (stored.totalCashDecimal === null || amounts.totalCashDecimal === null) {
      return true;
    }
    if (
      !manualRecordDecimalsEqual(
        stored.totalCashDecimal,
        amounts.totalCashDecimal,
      )
    )
      return true;
    if (
      stored.totalFrankingDecimal === null ||
      amounts.totalFrankingDecimal === null
    ) {
      return stored.totalFrankingDecimal !== amounts.totalFrankingDecimal;
    }
    return !manualRecordDecimalsEqual(
      stored.totalFrankingDecimal,
      amounts.totalFrankingDecimal,
    );
  }
  if (
    stored.sharesDecimal === null ||
    stored.dividendPerShareDecimal === null ||
    amounts.sharesDecimal === null ||
    amounts.dividendPerShareDecimal === null
  ) {
    return true;
  }
  if (!manualRecordDecimalsEqual(stored.sharesDecimal, amounts.sharesDecimal))
    return true;
  if (
    !manualRecordDecimalsEqual(
      stored.dividendPerShareDecimal,
      amounts.dividendPerShareDecimal,
    )
  )
    return true;
  if (
    stored.frankingCreditPerShareDecimal === null ||
    amounts.frankingCreditPerShareDecimal === null
  ) {
    return (
      stored.frankingCreditPerShareDecimal !==
      amounts.frankingCreditPerShareDecimal
    );
  }
  return !manualRecordDecimalsEqual(
    stored.frankingCreditPerShareDecimal,
    amounts.frankingCreditPerShareDecimal,
  );
}

export function createDividendManualRecordRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<DividendManualRecordRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_MANUAL_RECORD_COLUMNS} FROM dividend_manual_records
       WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
      [id, userId, portfolioId],
    );
    return row ? mapDividendManualRecord(row) : null;
  }

  async function list(
    userId: string,
    portfolioId: string,
    portfolioSecurityId?: string,
  ): Promise<DividendManualRecordRecord[]> {
    const predicate = portfolioSecurityId
      ? "AND portfolio_security_id = ?"
      : "";
    const params = portfolioSecurityId
      ? [userId, portfolioId, portfolioSecurityId]
      : [userId, portfolioId];
    // DIV-016 part A: the SINGLE choke point every evidence/aggregation
    // consumer of this table reads through (`app/owned-dividend-history.ts`
    // -- forecast TTM, UI-046 rows -- and `app/owned-security-dividends.ts`
    // -- the per-security Dividends tab). Excluding a superseded row here,
    // once, means every consumer downstream automatically sees exactly the
    // current head of each lineage without re-implementing the exclusion
    // -- see `db/schema.ts`'s `dividendManualRecords` header note.
    // `get()`/`getByIdempotencyKey` below deliberately do NOT filter --
    // `supersede()` needs to fetch a row regardless of its lineage state to
    // decide the correct outcome (already-superseded vs a fresh
    // correction), and a superseded ancestor must still be directly
    // fetchable for audit reconstruction.
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${DIVIDEND_MANUAL_RECORD_COLUMNS} FROM dividend_manual_records
       WHERE user_id = ? AND portfolio_id = ? ${predicate}
         AND superseded_by_record_id IS NULL
       ORDER BY payment_date DESC, id DESC`,
      params,
    );
    return rows.map(mapDividendManualRecord);
  }

  // UI-009: looks up a manual record by its client-generated idempotency
  // key, scoped to the owner/portfolio/security (defense-in-depth beyond
  // the unique index, which is scoped to portfolioSecurityId alone -- see
  // the schema comment for why that's already ownership-safe).
  async function getByIdempotencyKey(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
    idempotencyKey: string,
  ): Promise<DividendManualRecordRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_MANUAL_RECORD_COLUMNS} FROM dividend_manual_records
       WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
         AND idempotency_key = ? LIMIT 1`,
      [userId, portfolioId, portfolioSecurityId, idempotencyKey],
    );
    return row ? mapDividendManualRecord(row) : null;
  }

  async function create(
    userId: string,
    portfolioId: string,
    input: SaveDividendManualRecordInput,
  ): Promise<
    | {
        ok: true;
        record: DividendManualRecordRecord;
        // UI-009 finishing item 1: `deduped` true means this response is
        // an EXISTING record matched by idempotency key, not a fresh
        // create; `storedDiffers` true additionally means the incoming
        // payload's material fields differ from what is actually stored
        // (`record` always reflects the STORED truth either way -- the
        // caller must never substitute the just-submitted values).
        deduped: boolean;
        storedDiffers: boolean;
      }
    | DividendOwnerMutationFailure
  > {
    if (!isValidDateString(input.paymentDate)) {
      return { ok: false, reason: "invalid_input" };
    }
    const amounts = validateManualRecordAmounts(input);
    if (!amounts) return { ok: false, reason: "invalid_input" };
    const idempotencyKey =
      input.idempotencyKey && input.idempotencyKey.length > 0
        ? input.idempotencyKey
        : null;
    // UI-009: dedupe a retry-after-timeout BEFORE touching ownership/ledger
    // state -- a matching key means this exact dialog session already
    // succeeded, so the retry must read as success (the same record), never
    // create a second row.
    if (idempotencyKey !== null) {
      const existing = await getByIdempotencyKey(
        userId,
        portfolioId,
        input.portfolioSecurityId,
        idempotencyKey,
      );
      if (existing) {
        return {
          ok: true,
          record: existing,
          deduped: true,
          storedDiffers: manualRecordMaterialFieldsDiffer(existing, input),
        };
      }
    }
    if (
      !(await ownedHoldingWithOptionalEvent(
        client,
        userId,
        portfolioId,
        input.portfolioSecurityId,
        null,
      ))
    )
      return { ok: false, reason: "not_found" };
    const id = input.id ?? randomUUID();
    const createdAt = now();
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO dividend_manual_records (
          id, user_id, portfolio_id, portfolio_security_id, payment_date,
          shares_decimal, dividend_per_share_decimal,
          franking_credit_per_share_decimal, total_cash_decimal,
          total_franking_decimal, idempotency_key, created_at,
          updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        params: [
          id,
          userId,
          portfolioId,
          input.portfolioSecurityId,
          input.paymentDate,
          amounts.sharesDecimal,
          amounts.dividendPerShareDecimal,
          amounts.frankingCreditPerShareDecimal,
          amounts.totalCashDecimal,
          amounts.totalFrankingDecimal,
          idempotencyKey,
          createdAt,
          createdAt,
        ],
      },
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.manual_record.create",
          targetType: "dividend_manual_record",
          targetId: id,
          requestId: input.requestId,
          result: "success",
          occurredAt: createdAt,
        },
        "EXISTS (SELECT 1 FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ?)",
        [id, userId, portfolioId],
        now,
      ),
    ];
    try {
      await client.batch(statements);
    } catch {
      // UI-009: a concurrent retry (same idempotency key racing the first
      // request) can hit the unique index here instead of the pre-check
      // above finding it in time -- re-check before failing closed,
      // mirroring db/repositories/ledger.ts's persist()/getByIdempotency
      // race handling.
      if (idempotencyKey !== null) {
        const existing = await getByIdempotencyKey(
          userId,
          portfolioId,
          input.portfolioSecurityId,
          idempotencyKey,
        );
        if (existing) {
          return {
            ok: true,
            record: existing,
            deduped: true,
            storedDiffers: manualRecordMaterialFieldsDiffer(existing, input),
          };
        }
      }
      return { ok: false, reason: "atomic_failure" };
    }
    const record = await get(userId, portfolioId, id);
    return record
      ? { ok: true, record, deduped: false, storedDiffers: false }
      : { ok: false, reason: "atomic_failure" };
  }

  /**
   * DIV-016 part A: replaces the pre-DIV-016 `update()` (an in-place
   * `UPDATE ... SET shares_decimal = ...`) with a correction that creates a
   * NEW row and marks the OLD one, never rewriting the old row's own
   * financial fields -- see `SupersedeDividendManualRecordInput`'s doc
   * comment and `db/schema.ts`'s `dividendManualRecords` header note.
   *
   * Atomicity: the guarded `UPDATE` (statement 1) and the new row's
   * conditional `INSERT ... SELECT ... WHERE EXISTS` (statement 2) run in
   * ONE `client.batch()` call. The INSERT's `EXISTS` clause checks the
   * ORIGINAL row's POST-update state (`superseded_by_record_id = newId AND
   * version = expectedVersion + 1`) -- state that can only exist if
   * statement 1's own CAS guard (`WHERE version = ? AND
   * superseded_by_record_id IS NULL`) actually matched and applied within
   * this same transaction. If the CAS guard fails (stale version, already
   * superseded, or an imported row), statement 1 changes nothing, the
   * original's state never reaches that post-update shape, and the INSERT
   * correctly inserts zero rows -- no compensating rollback statement is
   * needed; either both the mark and the new row commit, or neither does.
   */
  async function supersede(
    userId: string,
    portfolioId: string,
    id: string,
    input: SupersedeDividendManualRecordInput,
  ): Promise<
    | {
        ok: true;
        record: DividendManualRecordRecord;
        deduped: boolean;
        // UI-009 disclosure parity (review follow-up): mirrors `create()`'s
        // `storedDiffers` -- true only on a `deduped: true` result whose
        // stored successor's material fields differ from what THIS request
        // just submitted (the owner edited the form between the original
        // attempt and a client-visible-timeout retry). Always `false` on a
        // fresh (non-deduped) success.
        storedDiffers: boolean;
      }
    | DividendOwnerMutationFailure
  > {
    if (typeof input.expectedVersion !== "number") {
      return { ok: false, reason: "invalid_input" };
    }
    if (
      !isNullable(input.paymentDate, (value) =>
        isValidDateString(String(value)),
      )
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    const original = await get(userId, portfolioId, id);
    if (!original) return { ok: false, reason: "not_found" };
    // Same imported-row immutability guard `update()`/`remove()` already
    // enforced -- an imported row corrects only via import-batch reversal
    // (IMP-006), never through this owner-facing path. Defense-in-depth:
    // the action layer already rejects this before reaching here.
    if (original.importBatchId !== null) {
      return { ok: false, reason: "invalid_input" };
    }
    const paymentDate = input.paymentDate ?? original.paymentDate;
    const resolvedAmounts = resolveSupersedeAmounts(original, input);
    if (!resolvedAmounts) return { ok: false, reason: "invalid_input" };
    // Re-bound to a variable whose STATIC type is already non-nullable
    // (rather than referencing the narrowed-but-still-`| null`-typed
    // `resolvedAmounts` directly) so the nested `dedupedResult` closure
    // below -- which TypeScript's control-flow narrowing does not reach
    // into -- can use it without a redundant null check.
    const amounts: {
      sharesDecimal: string | null;
      dividendPerShareDecimal: string | null;
      frankingCreditPerShareDecimal: string | null;
      totalCashDecimal: string | null;
      totalFrankingDecimal: string | null;
    } = resolvedAmounts;

    const rawIdempotencyKey =
      input.idempotencyKey && input.idempotencyKey.length > 0
        ? input.idempotencyKey
        : null;
    // B1 (BLOCKING review fix): see `SupersedeDividendManualRecordInput`'s
    // doc comment -- the raw dialog-session key is scoped PER SESSION, not
    // per correction step, so storing it verbatim would collide with the
    // record's own original CREATE (or an earlier step) under
    // `dividend_manual_records_security_idempotency_unique`'s
    // `(portfolio_security_id, idempotency_key)` uniqueness. Deriving a key
    // scoped to (the id BEING superseded, the raw key) keeps every
    // correction step's stored key globally unique for this security.
    const idempotencyKey =
      rawIdempotencyKey !== null
        ? `supersede:${id}:${rawIdempotencyKey}`
        : null;

    // UI-009 extension: whether `originalRow`'s lineage already has a
    // successor matching THIS exact request's derived key -- either a
    // retry-after-timeout of this same correction (dedupe) or, if the key
    // doesn't match (or none was supplied), a genuine version conflict
    // (someone/something else corrected it first). Never dedupes by
    // re-comparing amounts -- a deliberate second edit could legitimately
    // resubmit identical values.
    async function dedupedResult(
      originalRow: DividendManualRecordRecord,
    ): Promise<{
      ok: true;
      record: DividendManualRecordRecord;
      deduped: true;
      storedDiffers: boolean;
    } | null> {
      if (
        originalRow.supersededByRecordId === null ||
        idempotencyKey === null
      ) {
        return null;
      }
      const successor = await get(
        userId,
        portfolioId,
        originalRow.supersededByRecordId,
      );
      if (!successor || successor.idempotencyKey !== idempotencyKey) {
        return null;
      }
      return {
        ok: true,
        record: successor,
        deduped: true,
        storedDiffers: supersedeStoredDiffers(successor, paymentDate, amounts),
      };
    }

    if (original.supersededByRecordId !== null) {
      const deduped = await dedupedResult(original);
      if (deduped) return deduped;
      return { ok: false, reason: "version_conflict" };
    }
    if (original.version !== input.expectedVersion) {
      return { ok: false, reason: "version_conflict" };
    }

    const newId = randomUUID();
    const occurredAt = now();
    const nextVersion = input.expectedVersion + 1;
    const statements: SqlStatement[] = [
      {
        sql: `UPDATE dividend_manual_records
          SET superseded_by_record_id = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?
            AND import_batch_id IS NULL AND superseded_by_record_id IS NULL`,
        params: [
          newId,
          occurredAt,
          id,
          userId,
          portfolioId,
          input.expectedVersion,
        ],
      },
      {
        sql: `INSERT INTO dividend_manual_records (
          id, user_id, portfolio_id, portfolio_security_id, payment_date,
          shares_decimal, dividend_per_share_decimal,
          franking_credit_per_share_decimal, total_cash_decimal,
          total_franking_decimal, idempotency_key, created_at, updated_at,
          version
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
        WHERE EXISTS (
          SELECT 1 FROM dividend_manual_records
          WHERE id = ? AND user_id = ? AND portfolio_id = ?
            AND superseded_by_record_id = ? AND version = ?
        )`,
        params: [
          newId,
          userId,
          portfolioId,
          original.portfolioSecurityId,
          paymentDate,
          amounts.sharesDecimal,
          amounts.dividendPerShareDecimal,
          amounts.frankingCreditPerShareDecimal,
          amounts.totalCashDecimal,
          amounts.totalFrankingDecimal,
          idempotencyKey,
          occurredAt,
          occurredAt,
          // The EXISTS guard above: only fires once statement 1's CAS has
          // actually applied within this same atomic batch.
          id,
          userId,
          portfolioId,
          newId,
          nextVersion,
        ],
      },
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.manual_record.supersede",
          targetType: "dividend_manual_record",
          targetId: newId,
          requestId: input.requestId,
          result: "success",
          occurredAt,
          metadata: { supersedesRecordId: id },
        },
        "EXISTS (SELECT 1 FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ?)",
        [newId, userId, portfolioId],
        now,
      ),
    ];
    try {
      await client.batch(statements);
    } catch {
      // Race: a concurrent request may have won the CAS between our
      // pre-check above and this batch. Re-check idempotency the same way
      // as the pre-check before failing closed.
      const refreshedOriginal = await get(userId, portfolioId, id);
      const deduped = refreshedOriginal
        ? await dedupedResult(refreshedOriginal)
        : null;
      if (deduped) return deduped;
      return { ok: false, reason: "atomic_failure" };
    }
    const record = await get(userId, portfolioId, newId);
    if (record)
      return { ok: true, record, deduped: false, storedDiffers: false };
    // The guard failed silently (a concurrent request won the CAS with no
    // exception -- the conditional INSERT above simply inserted nothing).
    // Re-check dedupe once more before falling back to a generic
    // not_found/version_conflict resolution.
    const refreshedOriginal = await get(userId, portfolioId, id);
    const deduped = refreshedOriginal
      ? await dedupedResult(refreshedOriginal)
      : null;
    if (deduped) return deduped;
    return await resolveOwnerMutationFailure(
      client,
      "SELECT id FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ? AND import_batch_id IS NULL",
      [id, userId, portfolioId],
    );
  }

  async function remove(
    userId: string,
    portfolioId: string,
    id: string,
    expectedVersion: number,
    requestId: string,
  ): Promise<{ ok: true } | DividendOwnerMutationFailure> {
    const occurredAt = now();
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.manual_record.delete",
          targetType: "dividend_manual_record",
          targetId: id,
          requestId,
          result: "success",
          occurredAt,
        },
        "EXISTS (SELECT 1 FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ? AND import_batch_id IS NULL AND superseded_by_record_id IS NULL)",
        [id, userId, portfolioId, expectedVersion],
        now,
      ),
      {
        // B1: same imported-row immutability guard as pre-DIV-016
        // `update()` had. DIV-016 part A addition
        // (`superseded_by_record_id IS NULL`): a superseded (historical)
        // ancestor row can never be deleted directly -- it is already
        // excluded from every evidence path by `list()`'s filter, and
        // deleting it would destroy the ONLY record of what it was
        // eventually corrected TO (the backward audit-walk
        // `WHERE superseded_by_record_id = <successor id>` would return
        // nothing). This guard does NOT prevent deleting a CURRENT HEAD
        // that itself has an ancestor pointing at it (a correction, then
        // "Exclude this dividend" on the corrected row) -- see
        // `db/schema.ts`'s `dividendManualRecords` header note for the
        // accurate, documented consequence of that case (the ancestor's
        // own `superseded_by_record_id` becomes a tombstone reference; it
        // stays correctly excluded from evidence either way, but a forward
        // lineage walk from it finds no row, since the row it names was
        // deliberately deleted).
        sql: `DELETE FROM dividend_manual_records
              WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?
                AND import_batch_id IS NULL AND superseded_by_record_id IS NULL
              RETURNING id`,
        params: [id, userId, portfolioId, expectedVersion],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ? AND import_batch_id IS NULL AND superseded_by_record_id IS NULL",
        [id, userId, portfolioId],
      );
    return { ok: true };
  }

  // EXP-004: exposes the same idempotency-key lookup `create()` already uses
  // internally so a resumable, chunked replay (`app/portfolio-bundle-service.ts`)
  // can re-derive "the row already created for bundle ref X" across separate
  // HTTP requests without holding an in-memory ref->id map, which cannot
  // survive a Worker request boundary.
  return { get, list, create, getByIdempotencyKey, supersede, remove };
}

// ---------------------------------------------------------------------------
// Owner-scoped: dividend_import_franking_overrides (BRK-011).
//
// A sparse, one-row-per-imported-record overlay for a FOREIGN-CURRENCY
// Sharesight payout's franking credit total -- see db/schema.ts's header
// comment on `dividendImportFrankingOverrides` for the full ledger-
// immutability/tier-cascade rationale. Unlike `dividend_event_overrides`,
// every field here is REQUIRED (there is nothing sparse to partially update
// -- an override either states a known franking total or does not exist),
// so `save()` is a plain create-or-update keyed by
// `(userId, portfolioId, dividendManualRecordId)`, mirroring
// `dividend_event_overrides.save()`'s expectedVersion convention
// (`null` = create, a number = update) without that function's tri-state
// machinery.
// ---------------------------------------------------------------------------

export type DividendImportFrankingOverrideRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  portfolioSecurityId: string;
  dividendManualRecordId: string;
  frankingTotalDecimal: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendImportFrankingOverrideInput = {
  frankingTotalDecimal: string;
  expectedVersion: number | null;
  requestId: string;
};

const DIVIDEND_IMPORT_FRANKING_OVERRIDE_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id, dividend_manual_record_id,
  franking_total_decimal, created_at, updated_at, version
`;

function mapDividendImportFrankingOverride(
  row: Record<string, unknown>,
): DividendImportFrankingOverrideRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    portfolioSecurityId: String(row.portfolio_security_id),
    dividendManualRecordId: String(row.dividend_manual_record_id),
    frankingTotalDecimal: String(row.franking_total_decimal),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

/**
 * Verifies `dividendManualRecordId` is an IMPORTED (`import_batch_id IS NOT
 * NULL`) row belonging to `userId`/`portfolioId`/`portfolioSecurityId` --
 * an owner override only ever makes sense against a Sharesight-sourced
 * totals-mode fact (see this table's schema.ts header note); an owner-typed
 * manual record's franking is already directly editable through
 * `dividendManualRecords.update()` and must never gain a second, competing
 * override path.
 */
async function ownedImportedManualRecord(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  portfolioSecurityId: string,
  dividendManualRecordId: string,
): Promise<boolean> {
  const row = await client.get<{ id: string }>(
    `SELECT id FROM dividend_manual_records
     WHERE id = ? AND user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
       AND import_batch_id IS NOT NULL
     LIMIT 1`,
    [dividendManualRecordId, userId, portfolioId, portfolioSecurityId],
  );
  return Boolean(row);
}

export function createDividendImportFrankingOverrideRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function get(
    userId: string,
    portfolioId: string,
    dividendManualRecordId: string,
  ): Promise<DividendImportFrankingOverrideRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${DIVIDEND_IMPORT_FRANKING_OVERRIDE_COLUMNS}
       FROM dividend_import_franking_overrides
       WHERE user_id = ? AND portfolio_id = ? AND dividend_manual_record_id = ?
       LIMIT 1`,
      [userId, portfolioId, dividendManualRecordId],
    );
    return row ? mapDividendImportFrankingOverride(row) : null;
  }

  async function list(
    userId: string,
    portfolioId: string,
    portfolioSecurityId?: string,
  ): Promise<DividendImportFrankingOverrideRecord[]> {
    const predicate = portfolioSecurityId
      ? "AND portfolio_security_id = ?"
      : "";
    const params = portfolioSecurityId
      ? [userId, portfolioId, portfolioSecurityId]
      : [userId, portfolioId];
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${DIVIDEND_IMPORT_FRANKING_OVERRIDE_COLUMNS}
       FROM dividend_import_franking_overrides
       WHERE user_id = ? AND portfolio_id = ? ${predicate}`,
      params,
    );
    return rows.map(mapDividendImportFrankingOverride);
  }

  async function save(
    userId: string,
    portfolioId: string,
    portfolioSecurityId: string,
    dividendManualRecordId: string,
    input: SaveDividendImportFrankingOverrideInput,
  ): Promise<
    | { ok: true; override: DividendImportFrankingOverrideRecord }
    | DividendOwnerMutationFailure
  > {
    if (!isNonNegativeDecimalString(input.frankingTotalDecimal)) {
      return { ok: false, reason: "invalid_input" };
    }
    if (
      !(await ownedImportedManualRecord(
        client,
        userId,
        portfolioId,
        portfolioSecurityId,
        dividendManualRecordId,
      ))
    )
      return { ok: false, reason: "not_found" };
    const updatedAt = now();
    if (input.expectedVersion === null) {
      const id = randomUUID();
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO dividend_import_franking_overrides (
            id, user_id, portfolio_id, portfolio_security_id,
            dividend_manual_record_id, franking_total_decimal, created_at,
            updated_at, version
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1 FROM dividend_import_franking_overrides
            WHERE user_id = ? AND portfolio_id = ? AND dividend_manual_record_id = ?
          )`,
          params: [
            id,
            userId,
            portfolioId,
            portfolioSecurityId,
            dividendManualRecordId,
            input.frankingTotalDecimal,
            updatedAt,
            updatedAt,
            userId,
            portfolioId,
            dividendManualRecordId,
          ],
        },
        createConditionalAuditInsertStatement(
          {
            actorUserId: userId,
            targetOwnerUserId: userId,
            action: "dividend.import_franking_override.create",
            targetType: "dividend_import_franking_override",
            targetId: id,
            requestId: input.requestId,
            result: "success",
            occurredAt: updatedAt,
          },
          "EXISTS (SELECT 1 FROM dividend_import_franking_overrides WHERE id = ?)",
          [id],
          now,
        ),
      ];
      try {
        await client.batch(statements);
      } catch {
        return { ok: false, reason: "atomic_failure" };
      }
      const override = await get(userId, portfolioId, dividendManualRecordId);
      return override && override.id === id
        ? { ok: true, override }
        : { ok: false, reason: "version_conflict" };
    }
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.import_franking_override.update",
          targetType: "dividend_import_franking_override",
          targetId: `${portfolioSecurityId}:${dividendManualRecordId}`,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM dividend_import_franking_overrides WHERE user_id = ? AND portfolio_id = ? AND dividend_manual_record_id = ? AND version = ?)",
        [userId, portfolioId, dividendManualRecordId, input.expectedVersion],
        now,
      ),
      {
        sql: `UPDATE dividend_import_franking_overrides SET
          franking_total_decimal = ?, updated_at = ?, version = version + 1
        WHERE user_id = ? AND portfolio_id = ? AND dividend_manual_record_id = ?
          AND version = ?
        RETURNING ${DIVIDEND_IMPORT_FRANKING_OVERRIDE_COLUMNS}`,
        params: [
          input.frankingTotalDecimal,
          updatedAt,
          userId,
          portfolioId,
          dividendManualRecordId,
          input.expectedVersion,
        ],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_import_franking_overrides WHERE user_id = ? AND portfolio_id = ? AND dividend_manual_record_id = ?",
        [userId, portfolioId, dividendManualRecordId],
      );
    return { ok: true, override: mapDividendImportFrankingOverride(row) };
  }

  return { get, list, save };
}
