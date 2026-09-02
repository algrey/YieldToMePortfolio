import { randomUUID } from "node:crypto";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { HistoricalPortfolioValuePoint } from "../../domain/snapshots/historical-portfolio-value.ts";

// HIST-002: owner-scoped read/write access to `portfolio_value_history`,
// the persisted cache of `domain/snapshots/historical-portfolio-value.ts`'s
// read-time derivation -- see db/schema.ts's `portfolioValueHistory` header
// comment for the full design record. Every query here is scoped by the
// CALLING user's id (never a client-supplied one), matching every other
// owner-scoped repository in this codebase -- EXCEPT the two cross-owner
// invalidation helpers at the bottom of this file, whose own doc comments
// explain why a single write can legitimately need to invalidate more than
// one owner's cache row (deployment-scope price observations), and why that
// is still safe (ownership is derived from `portfolio_securities`'s own
// authoritative `user_id` column, never a client-supplied id).

/** D1 statement-variable-count discipline (matches `MKT-018B`'s 50/chunk
 * precedent): each upserted row costs a small, fixed number of bound
 * parameters, so this bounds one `batch()` call comfortably under D1's
 * 100-statement/per-call practicality. */
export const VALUE_HISTORY_CHUNK_SIZE = 50;

/** Review B2 fold (defensive ceiling, not a realistic limit): how many
 * distinct portfolios one security's invalidation is allowed to touch -- a
 * real security is held by a small handful of portfolios at most. */
const MAX_INVALIDATION_PORTFOLIOS = 500;

export type StoredValueHistoryPoint = HistoricalPortfolioValuePoint;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function mapRow(row: Record<string, unknown>): StoredValueHistoryPoint | null {
  const date = row.value_date;
  const valueDecimal = row.value_decimal;
  const completeness = row.completeness;
  if (
    typeof date !== "string" ||
    typeof valueDecimal !== "string" ||
    (completeness !== "complete" && completeness !== "partial")
  ) {
    return null; // malformed row: excluded, never fabricated -- falls back to derivation for this date
  }
  return {
    date,
    valueDecimal,
    completeness,
    heldSecurityCount:
      typeof row.held_security_count === "number" ? row.held_security_count : 0,
    pricedSecurityCount:
      typeof row.priced_security_count === "number"
        ? row.priced_security_count
        : 0,
  };
}

/** Bounded, owner-scoped read of every stored row for one portfolio within
 * `[rangeFrom, rangeTo]` (inclusive) -- a "trivial bounded read", never
 * itself invoking the derivation. Returns a `Map` keyed by `value_date` so
 * callers can cheaply test "is this candidate date already stored".
 *
 * Review B2 fold: when the true row count exceeds `limit`, this must keep
 * the MOST RECENT rows, matching `MAX_CANDIDATE_DATES`'s own "keep the
 * newest, drop the oldest" convention (`app/historical-portfolio-value.ts`)
 * -- an ascending `ORDER BY ... LIMIT` would silently clip the NEWEST rows
 * instead, the exact dates a reader is most likely viewing. Reads
 * `DESC LIMIT` then re-sorts ascending before returning. */
export async function loadStoredValueHistory(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  rangeFrom: string,
  rangeTo: string,
  limit: number,
): Promise<Map<string, StoredValueHistoryPoint>> {
  const rows = await client.all<Record<string, unknown>>(
    `SELECT value_date, value_decimal, completeness, held_security_count, priced_security_count
     FROM portfolio_value_history
     WHERE user_id = ? AND portfolio_id = ? AND value_date BETWEEN ? AND ?
     ORDER BY value_date DESC LIMIT ?`,
    [userId, portfolioId, rangeFrom, rangeTo, limit],
  );
  const result = new Map<string, StoredValueHistoryPoint>();
  for (const row of rows) {
    const point = mapRow(row);
    if (point) result.set(point.date, point);
  }
  return result;
}

/**
 * Idempotent, owner-scoped upsert of derived value-history points --
 * EFF-001's "identical-value upserts are free" pattern applied to this
 * table: the `DO UPDATE SET ... WHERE` guard compares every value column
 * against `excluded.*` with SQLite's null-safe `IS NOT`, so re-storing an
 * UNCHANGED point (the common case on a routine re-derivation, e.g. a price
 * import that turned out to correct nothing) performs NO write at all.
 * `computed_at` is deliberately excluded from the guard (bookkeeping, not a
 * value -- including it would make the guard always true, per
 * `writePriceUploadObservations`'s identical precedent).
 *
 * Only points with a non-null `valueDecimal` are written -- a point this
 * derivation could not resolve AT ALL has no row here (the honesty
 * invariant: "no row for dates with no data", never a NULL placeholder).
 * Review fold: this means "fully backfilled never re-derives" is NOT a
 * universal guarantee -- an unresolvable date is never stored, so it is
 * always absent from the store and is re-attempted (cheaply, one date at a
 * time) on every subsequent read until it genuinely resolves.
 */
export async function upsertStoredValueHistory(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    portfolioId: string;
    points: readonly HistoricalPortfolioValuePoint[];
    now: string;
  }>,
): Promise<{ written: number; unchangedCount: number }> {
  const writable = input.points.filter(
    (
      point,
    ): point is HistoricalPortfolioValuePoint & { valueDecimal: string } =>
      point.valueDecimal !== null,
  );
  if (writable.length === 0) return { written: 0, unchangedCount: 0 };

  let written = 0;
  let unchangedCount = 0;
  for (const group of chunk(writable, VALUE_HISTORY_CHUNK_SIZE)) {
    const statements: SqlStatement[] = group.map((point) => ({
      sql: `INSERT INTO portfolio_value_history (
              id, user_id, portfolio_id, value_date, value_decimal,
              completeness, held_security_count, priced_security_count, computed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (portfolio_id, value_date) DO UPDATE SET
              value_decimal = excluded.value_decimal,
              completeness = excluded.completeness,
              held_security_count = excluded.held_security_count,
              priced_security_count = excluded.priced_security_count,
              computed_at = excluded.computed_at
            WHERE
              value_decimal IS NOT excluded.value_decimal
              OR completeness IS NOT excluded.completeness
              OR held_security_count IS NOT excluded.held_security_count
              OR priced_security_count IS NOT excluded.priced_security_count
            RETURNING id`,
      params: [
        randomUUID(),
        input.userId,
        input.portfolioId,
        point.date,
        point.valueDecimal,
        point.completeness,
        point.heldSecurityCount,
        point.pricedSecurityCount,
        input.now,
      ],
    }));
    const results = await client.batch(statements);
    for (const result of results) {
      if (result.results.length > 0) written += 1;
      else unchangedCount += 1;
    }
  }
  return { written, unchangedCount };
}

// ---------------------------------------------------------------------------
// PRF-010: cron-only convergence marker.
//
// The hourly cron backfill (`app/value-history-backfill-service.ts`) paid a
// full `loadCandidateDates` `DISTINCT market_date` seek over
// `price_observations` (~47k index entries at the owner's real 18-security
// scale) EVERY tick for EVERY portfolio, including one that had fully
// converged -- measured at ~1.1M D1 `rows_read`/day against the free plan's
// 5M/day allowance (see `tests/prf-010.test.ts`'s own before/after
// measurement). The functions below let the cron short-circuit that scan for
// a portfolio it has ALREADY proven has zero missing candidate dates,
// without introducing a flag some OTHER write path must remember to clear.
//
// SAFETY: the "fingerprint" below is not an independently-maintained flag --
// it is a `(row count, min value_date, max value_date)` snapshot of
// `portfolio_value_history` ITSELF, taken at the exact moment a full check
// proved nothing was missing. Every existing invalidation path (the ranged
// DELETE in `valueHistoryInvalidationFromDateStatement`, the owner-scoped
// `deleteStoredValueHistoryInRangeForOwnedSecurity`, and the cross-owner
// `buildValueHistoryInvalidationStatementsForSecurities`) mutates exactly
// this table, so any of them changes this table's row count and/or its
// min/max date -- there is no separate signal to keep in sync, and no
// fourth call site to remember (the exact class of bug this task's own
// history -- BRK-015's two watermarks, BUG-010's unresolvable dates,
// BUG-011's comparison set -- kept repeating). `tests/prf-010.test.ts`
// proves this end to end: converge a portfolio, invalidate it through the
// real `invalidateStoredValueHistoryForSecurity` path, and confirm the very
// next sweep tick detects the mismatch and resumes backfilling.
//
// This marker is ONLY ever written when a full check found ZERO missing
// candidate dates from the very first look (`ValueHistoryBackfillOutcome`'s
// `missingDates === 0`) -- never when a tick merely exhausted its derive
// budget over dates that turned out unresolvable. That keeps a portfolio
// with even one permanently-unresolvable candidate date (BUG-010 follow-up
// (e)'s territory) OUT of this shortcut forever: such a portfolio always
// has `missingDates > 0` (the unresolvable date can never be `stored`), so
// it keeps paying for -- and keeps LOGGING -- the full check and its
// `datesDerived > 0`/`rowsPersisted === 0` tell on every tick, completely
// unaffected by this shortcut.
//
// This marker lives on `portfolios` (matching `historyCompleteFrom`'s own
// precedent of a nullable per-portfolio bookkeeping column), never on
// `portfolio_value_history` -- the table this fingerprint DESCRIBES must
// stay the untouched read-time cache the rest of this module documents.
// ---------------------------------------------------------------------------

/** How long a confirmed-converged marker may be trusted before the cron
 * re-runs the full check regardless of the fingerprint -- a hard ceiling on
 * staleness that needs no invalidation coupling to be safe: even in the
 * narrow theoretical case where an interior invalidation's row-count/date-
 * range change happens to be masked by an unrelated, coincidentally
 * offsetting write in the same window (see `tests/prf-010.test.ts`'s own
 * discussion), this bounds how long the CRON specifically could go without
 * re-verifying. The independent read path (`loadHistoricalPortfolioValueSeries`,
 * untouched by this task) re-verifies via the same full check on every page
 * load regardless, so this is defense in depth, not the only backstop. */
export const CONVERGENCE_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ValueHistoryConvergenceFingerprint = {
  rowCount: number;
  minValueDate: string | null;
  maxValueDate: string | null;
};

function encodeConvergenceFingerprint(
  fingerprint: ValueHistoryConvergenceFingerprint,
): string {
  return `${fingerprint.rowCount}:${fingerprint.minValueDate ?? ""}:${fingerprint.maxValueDate ?? ""}`;
}

/** Cheap owner-scoped snapshot of `portfolio_value_history`'s CURRENT shape
 * for one portfolio -- one aggregate query, no per-row payload. Far cheaper
 * than `loadCandidateDates`'s `price_observations` scan (which this
 * shortcut exists to avoid), but not free: computing `COUNT`/`MIN`/`MAX`
 * still visits every stored row for this portfolio, so this is sized
 * against `loadStoredValueHistory`'s existing per-tick cost, not zero. */
export async function loadValueHistoryConvergenceFingerprint(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<ValueHistoryConvergenceFingerprint> {
  const row = await client.get<Record<string, unknown>>(
    `SELECT COUNT(*) AS row_count, MIN(value_date) AS lo, MAX(value_date) AS hi
     FROM portfolio_value_history WHERE user_id = ? AND portfolio_id = ?`,
    [userId, portfolioId],
  );
  return {
    rowCount: typeof row?.row_count === "number" ? row.row_count : 0,
    minValueDate: typeof row?.lo === "string" ? row.lo : null,
    maxValueDate: typeof row?.hi === "string" ? row.hi : null,
  };
}

/** Owner-scoped read of the last confirmed-converged marker, or `null` when
 * the portfolio does not exist for this owner OR has never been confirmed
 * converged (the fail-open default: "do the full check"). */
export async function loadPortfolioConvergenceMarker(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<{ verifiedAt: string; fingerprint: string } | null> {
  const row = await client.get<Record<string, unknown>>(
    `SELECT value_history_backfill_verified_at AS verified_at,
            value_history_backfill_verified_fingerprint AS fingerprint
     FROM portfolios WHERE id = ? AND user_id = ?`,
    [portfolioId, userId],
  );
  if (
    !row ||
    typeof row.verified_at !== "string" ||
    typeof row.fingerprint !== "string"
  ) {
    return null;
  }
  return { verifiedAt: row.verified_at, fingerprint: row.fingerprint };
}

/** Returns `true` when `loadPortfolioConvergenceMarker`'s own fingerprint
 * matches `loadValueHistoryConvergenceFingerprint`'s CURRENT one -- pulled
 * out as its own function so the comparison logic lives next to the
 * encoding it exercises, rather than being re-derived at the call site. */
export function convergenceFingerprintMatches(
  marker: { fingerprint: string },
  current: ValueHistoryConvergenceFingerprint,
): boolean {
  return marker.fingerprint === encodeConvergenceFingerprint(current);
}

/** Owner-scoped write of the confirmed-converged marker -- called ONLY after
 * a full check proves `missingDates === 0` (see this section's header for
 * why that gate matters). Never bumps `portfolios.version`: this is cron
 * bookkeeping invisible to every user-facing read/edit path, not a change a
 * concurrent owner edit could conflict with. */
export async function recordPortfolioConvergenceMarker(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  fingerprint: ValueHistoryConvergenceFingerprint,
  now: string,
): Promise<void> {
  await client.run(
    `UPDATE portfolios SET value_history_backfill_verified_at = ?,
       value_history_backfill_verified_fingerprint = ?
     WHERE id = ? AND user_id = ?`,
    [now, encodeConvergenceFingerprint(fingerprint), portfolioId, userId],
  );
}

// ---------------------------------------------------------------------------
// Invalidation.
//
// Review B2 (BLOCKING): ledger mutations (a back-dated buy, a reversal) and
// the non-CSV price writers (Yahoo-compatible rollup, MKT-011A intraday
// capture) never invalidated this store -- a portfolio's graph froze
// forever the moment a stored row existed for a date a later mutation
// changed. Three shapes below, matched to three different call-site
// constraints:
// ---------------------------------------------------------------------------

/**
 * Pure statement builder (no DB call) -- for embedding directly inside an
 * ALREADY-ATOMIC `client.batch()` a ledger mutation or import commit is
 * building (`db/repositories/ledger.ts`'s `persist`/`buildLedgerPostingStatements`,
 * `db/repositories/import-commit.ts`'s `finalize`). A single ranged DELETE
 * per portfolio: every stored row from `fromDate` onward is invalidated,
 * since a share-quantity-changing ledger fact effective from that date
 * changes every later date's held-quantity too (never just the one date).
 * Deleting a row that does not exist is a normal, cheap no-op (D1 counts
 * `changes` but this builder never inspects it -- the caller's own atomic
 * batch result is authoritative for the whole mutation's success).
 */
export function valueHistoryInvalidationFromDateStatement(
  userId: string,
  portfolioId: string,
  fromDate: string,
): SqlStatement {
  return {
    sql: `DELETE FROM portfolio_value_history
          WHERE user_id = ? AND portfolio_id = ? AND value_date >= ?`,
    params: [userId, portfolioId, fromDate],
  };
}

/**
 * Owner-scoped invalidation for a SINGLE owner's own price-history import
 * (`app/price-upload-service.ts`'s MKT-008/MKT-020 confirm paths, via
 * `app/historical-portfolio-value.ts`'s `invalidateStoredValueHistoryForSecurity`).
 * Review B2 follow-up (5): ONE ranged `BETWEEN` DELETE per portfolio
 * (`[fromDate, toDate]` spanning every touched date) rather than the
 * previous per-date-list chunking (~34 statements for a 1,700-row import) --
 * a few untouched dates inside that span may be conservatively invalidated
 * too (safe: they simply get cheaply re-derived, and the EFF-001 guard
 * makes an unchanged re-derivation a zero-write no-op). Scoped to portfolios
 * the CALLING owner actually holds this security in -- never another
 * owner's cache, matching this import's own `access_scope = 'user'` write.
 */
export async function deleteStoredValueHistoryInRangeForOwnedSecurity(
  client: SqlClient,
  userId: string,
  securityId: string,
  fromDate: string,
  toDate: string,
): Promise<{ portfoliosInvalidated: number; rowsDeleted: number }> {
  const portfolioRows = await client.all<Record<string, unknown>>(
    `SELECT DISTINCT portfolio_id FROM portfolio_securities
     WHERE user_id = ? AND security_id = ? LIMIT ?`,
    [userId, securityId, MAX_INVALIDATION_PORTFOLIOS + 1],
  );
  const portfolioIds = portfolioRows
    .map((row) => row.portfolio_id)
    .filter((id): id is string => typeof id === "string")
    .slice(0, MAX_INVALIDATION_PORTFOLIOS);
  let rowsDeleted = 0;
  for (const portfolioId of portfolioIds) {
    const result = await client.run(
      `DELETE FROM portfolio_value_history
       WHERE user_id = ? AND portfolio_id = ? AND value_date BETWEEN ? AND ?`,
      [userId, portfolioId, fromDate, toDate],
    );
    rowsDeleted += result.changes;
  }
  return { portfoliosInvalidated: portfolioIds.length, rowsDeleted };
}

export type ValueHistoryInvalidationTarget = Readonly<{
  securityId: string;
  fromDate: string;
  toDate: string;
}>;

/**
 * Cross-owner statement builder -- for the non-CSV, background price
 * writers (`db/repositories/market-data-refresh.ts`'s Yahoo-compatible
 * rollup, `db/repositories/intraday-price-capture.ts`'s MKT-011A capture).
 * These can write a `access_scope = 'deployment'` row (Yahoo-compatible) or
 * a `'user'` row for a DIFFERENT triggering user than the one whose capture
 * cycle happened to run first -- either way, ANY owner holding this
 * security can be affected, not just the caller. Ownership is still derived
 * ONLY from `portfolio_securities`'s own authoritative `user_id` column
 * (never a client-supplied id), so this never crosses the AGENTS.md
 * ownership boundary -- it only means "which rows to invalidate" is
 * resolved per-security rather than per-caller. Returns statements to
 * append to the SAME atomic batch the write itself is already building
 * (never a separate round trip).
 *
 * Takes MULTIPLE targets (one per distinct security in a write chunk) and
 * resolves them in ONE query (`security_id IN (...)`), bounded by
 * `maxPortfolios` TOTAL rows across every target -- these callers write in
 * small (<=5-observation) chunks with a tight per-batch statement budget
 * (D1's own practical ceiling), so the caller passes a small cap that keeps
 * `writes + 1 progress update + invalidation deletes` well under it. A
 * security legitimately held by more portfolios than the cap allows is a
 * defensively-bounded, documented limitation (not expected at this
 * codebase's real scale) -- excess portfolios simply are not invalidated
 * THIS commit; a later write for the same security tries again.
 */
export async function buildValueHistoryInvalidationStatementsForSecurities(
  client: SqlClient,
  targets: readonly ValueHistoryInvalidationTarget[],
  maxPortfolios: number,
): Promise<SqlStatement[]> {
  const bySecurityId = new Map(
    targets.map((target) => [target.securityId, target]),
  );
  const securityIds = [...bySecurityId.keys()];
  if (securityIds.length === 0) return [];
  const rows = await client.all<Record<string, unknown>>(
    `SELECT DISTINCT user_id, portfolio_id, security_id FROM portfolio_securities
     WHERE security_id IN (${securityIds.map(() => "?").join(",")}) LIMIT ?`,
    [...securityIds, maxPortfolios],
  );
  const statements: SqlStatement[] = [];
  for (const row of rows) {
    if (
      typeof row.user_id !== "string" ||
      typeof row.portfolio_id !== "string" ||
      typeof row.security_id !== "string"
    ) {
      continue;
    }
    const target = bySecurityId.get(row.security_id);
    if (!target) continue;
    statements.push({
      sql: `DELETE FROM portfolio_value_history
            WHERE user_id = ? AND portfolio_id = ? AND value_date BETWEEN ? AND ?`,
      params: [row.user_id, row.portfolio_id, target.fromDate, target.toDate],
    });
  }
  return statements;
}
