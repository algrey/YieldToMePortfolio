import { randomUUID } from "node:crypto";
import {
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
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
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
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendSecurityAssumptionsInput = {
  dividendYieldPercentDecimal: string | null;
  frankingPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  expectedVersion: number | null;
  requestId: string;
};

const DIVIDEND_SECURITY_ASSUMPTIONS_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id,
  dividend_yield_percent_decimal, franking_percent_decimal,
  dividend_growth_percent_decimal, created_at, updated_at, version
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
    if (input.expectedVersion === null) {
      const id = randomUUID();
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO dividend_security_assumptions (
            id, user_id, portfolio_id, portfolio_security_id,
            dividend_yield_percent_decimal, franking_percent_decimal,
            dividend_growth_percent_decimal, created_at, updated_at, version
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
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
          updated_at = ?, version = version + 1
        WHERE portfolio_security_id = ? AND user_id = ? AND portfolio_id = ?
          AND version = ?
        RETURNING ${DIVIDEND_SECURITY_ASSUMPTIONS_COLUMNS}`,
        params: [
          input.dividendYieldPercentDecimal,
          input.frankingPercentDecimal,
          input.dividendGrowthPercentDecimal,
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
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SaveDividendManualRecordInput = {
  id?: string;
  portfolioSecurityId: string;
  paymentDate: string;
  sharesDecimal: string;
  dividendPerShareDecimal: string;
  frankingCreditPerShareDecimal?: string | null;
  // UI-009: when supplied (non-empty), `create()` dedupes on
  // (portfolioSecurityId, idempotencyKey) -- a retry with the same key
  // after a client-visible timeout returns the ALREADY-CREATED record as a
  // success, never a second row. Absent/undefined preserves the pre-UI-009
  // behaviour (no dedupe).
  idempotencyKey?: string | null;
  requestId: string;
};

export type UpdateDividendManualRecordInput = {
  paymentDate?: string;
  sharesDecimal?: string;
  dividendPerShareDecimal?: string;
  frankingCreditPerShareDecimal?: string | null;
  expectedVersion: number;
  requestId: string;
};

const DIVIDEND_MANUAL_RECORD_COLUMNS = `
  id, user_id, portfolio_id, portfolio_security_id, payment_date,
  shares_decimal, dividend_per_share_decimal,
  franking_credit_per_share_decimal, import_batch_id, source_reference,
  idempotency_key, total_cash_decimal, total_franking_decimal,
  currency_code, fx_rate_to_portfolio_decimal, fx_rate_source,
  created_at, updated_at, version
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
 * shares, dividend per share, franking); `id`/`version`/timestamps are
 * never part of this comparison. A `true` result means the caller must
 * disclose that the STORED values (not the just-submitted ones) are what
 * actually persisted, never silently claim the new payload was saved.
 */
function manualRecordMaterialFieldsDiffer(
  existing: DividendManualRecordRecord,
  input: SaveDividendManualRecordInput,
): boolean {
  if (existing.paymentDate !== input.paymentDate) return true;
  // BRK-005 defensive guard: the standalone manual-entry idempotency-key
  // retry path this function serves never creates a totals-mode row (only
  // the Sharesight import commit path does, and that path never supplies an
  // idempotency key), so `existing.sharesDecimal`/`dividendPerShareDecimal`
  // are never actually null here -- but the DB-level type is nullable now
  // (see `DividendManualRecordRecord`'s header note), so a genuinely
  // totals-mode row reaching this comparison (which should be impossible)
  // reads as "differs" rather than crashing on a non-nullable decimal
  // comparison.
  if (
    existing.sharesDecimal === null ||
    existing.dividendPerShareDecimal === null
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
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${DIVIDEND_MANUAL_RECORD_COLUMNS} FROM dividend_manual_records
       WHERE user_id = ? AND portfolio_id = ? ${predicate}
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
    if (
      !isPositiveDecimalString(input.sharesDecimal) ||
      !isPositiveDecimalString(input.dividendPerShareDecimal) ||
      !isNullable(
        input.frankingCreditPerShareDecimal ?? null,
        isNonNegativeDecimalString,
      ) ||
      !isValidDateString(input.paymentDate)
    )
      return { ok: false, reason: "invalid_input" };
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
          franking_credit_per_share_decimal, idempotency_key, created_at,
          updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        params: [
          id,
          userId,
          portfolioId,
          input.portfolioSecurityId,
          input.paymentDate,
          input.sharesDecimal,
          input.dividendPerShareDecimal,
          input.frankingCreditPerShareDecimal ?? null,
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

  async function update(
    userId: string,
    portfolioId: string,
    id: string,
    input: UpdateDividendManualRecordInput,
  ): Promise<
    | { ok: true; record: DividendManualRecordRecord }
    | DividendOwnerMutationFailure
  > {
    const frankingProvided = hasOwn(input, "frankingCreditPerShareDecimal");
    if (
      !isNullable(input.paymentDate, (value) =>
        isValidDateString(String(value)),
      ) ||
      !isNullable(input.sharesDecimal, isPositiveDecimalString) ||
      !isNullable(input.dividendPerShareDecimal, isPositiveDecimalString) ||
      (frankingProvided &&
        !isNullable(
          input.frankingCreditPerShareDecimal ?? null,
          isNonNegativeDecimalString,
        ))
    )
      return { ok: false, reason: "invalid_input" };
    const updatedAt = now();
    // See dividend_receipts.update() above for why franking is tri-state
    // (omitted = unchanged, explicit null = clear) while the other fields
    // use a plain COALESCE partial update (DB-005 review finding B2).
    const franking = triStateAssignment(
      "franking_credit_per_share_decimal",
      frankingProvided,
      input.frankingCreditPerShareDecimal,
    );
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "dividend.manual_record.update",
          targetType: "dividend_manual_record",
          targetId: id,
          requestId: input.requestId,
          result: "success",
          occurredAt: updatedAt,
        },
        "EXISTS (SELECT 1 FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ? AND import_batch_id IS NULL)",
        [id, userId, portfolioId, input.expectedVersion],
        now,
      ),
      {
        // B1 (UI-006B review fix): an IMPORTED row (`import_batch_id IS NOT
        // NULL`, created by IMP-006's CSV commit) is never mutable through
        // this owner-facing update path -- its facts change only by
        // reversing the import batch that created it (preserving IMP-006's
        // reversal accounting) and it must never carry an owner-typed edit
        // while still being labelled the imported tier. This predicate is
        // defense-in-depth: the action layer
        // (`app/dividend-assumptions-actions.ts`) already rejects an
        // imported-row edit explicitly before reaching here.
        sql: `UPDATE dividend_manual_records SET
          payment_date = COALESCE(?, payment_date),
          shares_decimal = COALESCE(?, shares_decimal),
          dividend_per_share_decimal = COALESCE(?, dividend_per_share_decimal),
          ${franking.fragment},
          updated_at = ?, version = version + 1
        WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?
          AND import_batch_id IS NULL
        RETURNING ${DIVIDEND_MANUAL_RECORD_COLUMNS}`,
        params: [
          input.paymentDate ?? null,
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
        "SELECT id FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ? AND import_batch_id IS NULL",
        [id, userId, portfolioId],
      );
    return { ok: true, record: mapDividendManualRecord(row) };
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
        "EXISTS (SELECT 1 FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ? AND import_batch_id IS NULL)",
        [id, userId, portfolioId, expectedVersion],
        now,
      ),
      {
        // B1: same imported-row immutability guard as update() above.
        sql: `DELETE FROM dividend_manual_records
              WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?
                AND import_batch_id IS NULL
              RETURNING id`,
        params: [id, userId, portfolioId, expectedVersion],
      },
    ];
    const rows = await client.batch(statements);
    const row = rows[rows.length - 1]?.results[0];
    if (!row)
      return await resolveOwnerMutationFailure(
        client,
        "SELECT id FROM dividend_manual_records WHERE id = ? AND user_id = ? AND portfolio_id = ? AND import_batch_id IS NULL",
        [id, userId, portfolioId],
      );
    return { ok: true };
  }

  return { get, list, create, update, remove };
}
