import { randomUUID } from "node:crypto";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { PriceUploadSecurityEvidenceRow } from "../../domain/market-data/resolve-price-upload-security.ts";

// MKT-008: "Historical Data" section write path -- owner single-security CSV
// imports AND the lossless backup export/re-import round trip both write
// through this ONE repository (`writePriceUploadObservations`), keyed by a
// generic `providerId` per candidate so a backup re-import can preserve each
// row's ORIGINAL provider (never relabel a Sharesight-sourced row as
// freshly owner-uploaded, per this task's binding ruling).

export const OWNER_IMPORT_PROVIDER_ID = "owner-import";

/**
 * Mirrors `SHARESIGHT_PRICE_REFRESH_LIMITS`'s statement-budget discipline
 * (see `sharesight-price-refresh.ts`'s header comment for the full
 * rationale): each candidate costs at most 2 statements (1 guarded
 * `security_provider_mappings` ensure + 1 `price_observations` upsert), so
 * `maxCandidatesPerChunk: 25` bounds one `batch()` call to 50 statements,
 * comfortably under D1's 100-statement ceiling. Chunks run as separate
 * atomic `batch()` calls, not one giant transaction -- safe because every
 * write here is an idempotent natural-key upsert (a chunk failing after an
 * earlier chunk committed leaves no partial/duplicated observation, only a
 * resumable "run confirm again" state for the owner).
 */
export const PRICE_UPLOAD_WRITE_LIMITS = Object.freeze({
  maxCandidatesPerChunk: 25,
});

/**
 * Same-user identity evidence for resolving a price-history CSV's ticker
 * (plus the settings' exchange/currency) against securities the OWNER
 * already holds -- feeds `domain/market-data/resolve-price-upload-security.ts`.
 * Ticker matches either `portfolio_securities.source_symbol` directly, or an
 * active `scheme = 'ticker'` `security_identifiers` row for the same
 * security -- both are legitimate "the owner already calls this security by
 * this ticker" evidence. Exchange evidence is assembled from
 * `portfolio_securities.source_exchange_alias` and any active
 * `security_provider_mappings.provider_exchange`, exactly like
 * `security-resolution.ts`'s `loadSameUserEvidence`.
 */
export async function loadSameUserSecurityEvidenceForTicker(
  client: SqlClient,
  userId: string,
  ticker: string,
  currencyCode: string,
): Promise<PriceUploadSecurityEvidenceRow[]> {
  const normalizedTicker = ticker.trim().toUpperCase();
  const normalizedCurrency = currencyCode.trim().toUpperCase();
  const rows = await client.all<Record<string, unknown>>(
    `SELECT DISTINCT s.id AS security_id, s.canonical_name AS canonical_name,
            COALESCE(ps.source_exchange_alias, spm.provider_exchange) AS exchange_alias
       FROM portfolio_securities ps
       JOIN securities s ON s.id = ps.security_id
       LEFT JOIN security_provider_mappings spm
         ON spm.security_id = ps.security_id AND spm.valid_to IS NULL
      WHERE ps.user_id = ? AND ps.security_id IS NOT NULL
        AND UPPER(s.primary_currency_code) = ?
        AND (
          UPPER(ps.source_symbol) = ?
          OR EXISTS (
               SELECT 1 FROM security_identifiers si
                WHERE si.security_id = s.id AND si.scheme = 'ticker'
                  AND UPPER(si.value) = ? AND si.valid_to IS NULL
             )
        )`,
    [userId, normalizedCurrency, normalizedTicker, normalizedTicker],
  );
  return rows.map((row) => ({
    securityId: String(row.security_id),
    canonicalName: String(row.canonical_name),
    exchangeAlias:
      row.exchange_alias === null ? null : String(row.exchange_alias),
  }));
}

export type PriceUploadWriteCandidate = Readonly<{
  providerId: string;
  securityId: string;
  /** Evidence written into the guard-created `security_provider_mappings`
   * row when one does not already exist for (providerId, securityId) --
   * mirrors `sharesight-price-refresh.ts`'s identical guard-create, which
   * `price_observations.mapping_id`'s hard FK requires regardless of
   * provider. */
  providerExchange: string;
  providerSymbol: string;
  currencyCode: string;
  marketDate: string;
  priceDecimal: string;
  observationAt: string;
  marketTimezone: string;
  interval: "eod" | "delayed" | "intraday";
  quality: "observed" | "corrected" | "indicative" | "stale_candidate";
  adjustmentState: "raw" | "split_adjusted" | "total_return_adjusted";
  delayedMinutes: number | null;
}>;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * EFF-001 (measure 2, "delta-upload"): a defensive bound on how many
 * distinct dates a single security's OWN existing owner-import coverage
 * read may return -- mirrors `domain/market-data/price-csv.ts`'s
 * `DEFAULT_PRICE_CSV_LIMITS.maxRows` (20,000; a generous ~80 years of daily
 * history), the same headroom this read exists to compare against. Unlike
 * `app/price-history-coverage.ts`'s MULTI-security aggregate (which chunks
 * an `IN (...)` clause across up to 500 held securities,
 * `COVERAGE_READ_CHUNK_SIZE = 50` per chunk, to stay under D1's
 * bind-parameter ceiling), this read is scoped to exactly ONE security via
 * two plain equality binds -- there is no parameter-count risk to chunk
 * against, only a row-count one, which this `LIMIT` bounds directly.
 */
const MAX_EXISTING_MARKET_DATES = 20_000;

/**
 * The (date, price) observations a specific security ALREADY has owner-import
 * price history for (this exact write path's own `provider_id`, this
 * owner's own `user`-scope rows) -- feeds the "N identical row(s) already
 * present -- skipped" client-side delta-upload optimization
 * (`app/price-upload-service.ts`'s `previewSinglePriceUpload`, via
 * `domain/market-data/price-csv.ts`'s `filterRowsAlreadyPresent`).
 *
 * Review B1 fix (BLOCKING, 2026-08-25): the first version returned dates
 * ONLY -- a CSV carrying a CORRECTED price for an already-covered date was
 * then indistinguishable from a genuine duplicate and silently never
 * uploaded, while the preview kept promising "overwriting the price on any
 * date already imported". Returning `closeDecimal` alongside `marketDate`
 * lets the caller compare VALUE, not just presence -- a corrected price
 * still uploads and converges normally.
 *
 * Deliberately scoped to `provider_id = OWNER_IMPORT_PROVIDER_ID AND
 * interval = 'eod'` rather than every row for this security: a
 * Sharesight/Yahoo-sourced observation on the same date is a DIFFERENT fact
 * (different provider, different interval/quality, a different `ON
 * CONFLICT` target entirely -- see `writePriceUploadObservations`'s header
 * comment), not something a CSV re-upload should treat as "already
 * covered". Review fold: the `interval = 'eod'` filter was missing from the
 * first version -- the reviewer's repro hand-crafted an `owner-import`
 * row with `interval != 'eod'` (mirroring how this same provider id could,
 * in principle, carry a non-eod row) on the SAME market_date, which then
 * wrongly shadowed a genuine eod upload; `writePriceUploadObservations`'s
 * owner-import candidates are ALWAYS `interval: "eod"`, so this read must
 * match that exactly to reflect the SAME natural key the upsert converges
 * on, not a looser one.
 *
 * A write-avoidance HEURISTIC ONLY: the client uses this list to decide
 * which rows to bother SENDING, never a correctness gate --
 * `writePriceUploadObservations`'s upsert (plus its own measure-3
 * identical-value guard) handles whatever arrives regardless of whether the
 * client's coverage snapshot was stale or skipped entirely.
 */
export async function loadOwnerImportPriceObservationsForSecurity(
  client: SqlClient,
  userId: string,
  securityId: string,
): Promise<Array<{ marketDate: string; closeDecimal: string }>> {
  const rows = await client.all<{
    market_date: string;
    close_decimal: string;
  }>(
    `SELECT market_date, close_decimal FROM price_observations
      WHERE security_id = ?
        AND provider_id = ?
        AND interval = 'eod'
        AND access_scope = 'user'
        AND scope_user_id = ?
        AND adjustment_state = 'raw'
      ORDER BY market_date
      LIMIT ?`,
    [securityId, OWNER_IMPORT_PROVIDER_ID, userId, MAX_EXISTING_MARKET_DATES],
  );
  return rows.map((row) => ({
    marketDate: String(row.market_date),
    closeDecimal: String(row.close_decimal),
  }));
}

/**
 * Writes `candidates` as natural-key idempotent upserts into
 * `price_observations`. Each candidate's `providerId` decides which of
 * `price_observations`' TWO unique indexes the `ON CONFLICT` clause targets
 * (db/schema.ts): `provider_id = 'sharesight'` rows use the BRK-012B
 * partial `..._date_unique` index (scoped to `market_date`, the
 * accretion-converges-within-a-day model); every OTHER provider (this
 * task's `'owner-import'`, and any future one a backup re-import might
 * carry) uses the pre-existing general `..._unique` index (scoped to the
 * full `observation_at` instant) -- correct here because `observation_at`
 * is a DETERMINISTIC function of `market_date` for every non-Sharesight
 * source this codebase writes (the midnight-exchange-timezone convention;
 * see `domain/market-data/exchange-timezone.ts`), so re-importing the
 * identical date always produces the identical `observation_at` and
 * upserts onto the SAME row -- no Sharesight-style same-day multi-fetch
 * convergence needed, and therefore no new partial index for
 * `'owner-import'` either.
 *
 * Review B1 fix (BLOCKING, 2026-08-21): `upload_batch_id` is stamped on
 * INSERT only -- the `ON CONFLICT DO UPDATE SET` clause deliberately does
 * NOT touch it, so overlaying an existing row (created by a DIFFERENT
 * upload, or by Sharesight's accretion, or not attributed to any upload at
 * all) updates its price/quote fields but leaves attribution with whoever
 * created it. The reviewer's drill: the PRIOR version stamped
 * `upload_batch_id = excluded.upload_batch_id` unconditionally, so deleting
 * an OVERLAYING upload silently deleted rows it never created -- including
 * an un-refetchable Sharesight accretion row. `insertedCount` (distinct
 * from `written`, the total upserted-or-overlaid count) is derived by
 * comparing each candidate's freshly generated `id` against the id
 * `RETURNING id` actually reports: on a genuine INSERT the returned id
 * equals the one this call generated; on an `ON CONFLICT` overlay SQLite
 * returns the EXISTING row's (different) id, since `id` is never touched by
 * `DO UPDATE SET`. This needs no extra query -- it falls out of the same
 * `RETURNING id` the write already reads for `written`.
 *
 * EFF-001 (measure 3, "identical-value upserts free"): the `DO UPDATE SET`
 * clause now carries a `WHERE` guard comparing every column it would
 * otherwise touch (`ingested_at` excluded -- it is bookkeeping, not a
 * value, and would make the guard always true) against `excluded.*` with
 * SQLite's null-safe `IS NOT`. When a re-upload's candidate is
 * byte-identical to the stored row on every VALUE column, the `WHERE`
 * evaluates false and SQLite performs NO write at all for that row --
 * neither an INSERT nor an UPDATE, the pre-existing row is left completely
 * untouched (documented SQLite `ON CONFLICT ... DO UPDATE ... WHERE`
 * behaviour: a false guard abandons the upsert for that conflicting row).
 * `RETURNING id` then reports nothing for that statement, so `written`
 * correctly excludes it; `unchangedCount` counts it separately so callers
 * can disclose the saving honestly rather than have it silently vanish from
 * the "N price observation(s)" total. This guard is SCOPED to this single
 * write path -- it does not touch, and does not need to compose its own
 * WHERE clause with, MKT-011A's rollup strictly-newer guard
 * (`db/repositories/intraday-price-capture.ts`), MKT-015's backfill
 * `noDowngrade` guard (`db/repositories/sharesight-price-refresh.ts`), or
 * WLT-001's prime guard (`app/watchlist-actions.ts`) -- each of those
 * targets a DIFFERENT `ON CONFLICT` index/provider (the Yahoo-compatible
 * partial index, `provider_id != 'owner-import'`) via its OWN separate
 * write function, so there is no single SQL statement where two WHERE
 * clauses would need to combine; they compose simply by being independent.
 */
export async function writePriceUploadObservations(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    uploadBatchId: string;
    candidates: readonly PriceUploadWriteCandidate[];
    now: string;
  }>,
): Promise<{
  written: number;
  insertedCount: number;
  unchangedCount: number;
  /** Review fold (2026-08-25): distinguishes measure 3's genuine
   * identical-value skip (`unchangedCount`) from the structurally-different
   * failure mode of the guard-created mapping still being absent when the
   * price statement ran -- see the post-batch verification below. Expected
   * to be `0` in ordinary operation (the guard-create statement immediately
   * precedes each price statement in the SAME batch); a non-zero value is a
   * genuine data-integrity anomaly worth investigating, never silently
   * folded into `unchangedCount`'s write-avoidance meaning. */
  mappingMissingCount: number;
}> {
  if (input.candidates.length === 0) {
    return {
      written: 0,
      insertedCount: 0,
      unchangedCount: 0,
      mappingMissingCount: 0,
    };
  }

  let written = 0;
  let insertedCount = 0;
  let unchangedCount = 0;
  let mappingMissingCount = 0;
  for (const batchCandidates of chunk(
    input.candidates,
    PRICE_UPLOAD_WRITE_LIMITS.maxCandidatesPerChunk,
  )) {
    const statements: SqlStatement[] = [];
    // Tracks, per price_observations statement, the INDEX into `statements`,
    // the `id` this call generated for it (so the post-batch loop can tell
    // INSERT -- returned id === generated id -- from an ON CONFLICT overlay,
    // returned id is the pre-existing row's, different -- without a second
    // query), and the (providerId, securityId) pair a post-batch mapping
    // verification needs if this candidate resolves ambiguously (see below).
    const priceStatementEntries: Array<{
      index: number;
      generatedId: string;
      providerId: string;
      securityId: string;
    }> = [];
    for (const candidate of batchCandidates) {
      statements.push({
        sql: `INSERT INTO security_provider_mappings (
                id, security_id, provider_id, provider_exchange, provider_symbol,
                valid_from, valid_to, status, verified_by_user_id, verified_at
              )
              SELECT ?, ?, ?, ?, ?, ?, NULL, 'candidate', NULL, NULL
              WHERE NOT EXISTS (
                SELECT 1 FROM security_provider_mappings
                WHERE provider_id = ? AND security_id = ? AND valid_to IS NULL
              )`,
        params: [
          randomUUID(),
          candidate.securityId,
          candidate.providerId,
          candidate.providerExchange,
          candidate.providerSymbol,
          input.now.slice(0, 10),
          candidate.providerId,
          candidate.securityId,
        ],
      });
      const mappingIdSubquery = `(SELECT id FROM security_provider_mappings
              WHERE provider_id = ? AND security_id = ? AND valid_to IS NULL LIMIT 1)`;
      const isSharesight = candidate.providerId === "sharesight";
      const conflictClause = isSharesight
        ? `ON CONFLICT (
             provider_id, scope_key, mapping_id, interval, market_date, adjustment_state
           ) WHERE provider_id = 'sharesight'`
        : `ON CONFLICT (
             provider_id, scope_key, mapping_id, interval, observation_at, adjustment_state
           )`;
      const generatedId = randomUUID();
      priceStatementEntries.push({
        index: statements.length,
        generatedId,
        providerId: candidate.providerId,
        securityId: candidate.securityId,
      });
      statements.push({
        sql: `INSERT INTO price_observations (
                id, provider_id, access_scope, scope_user_id, scope_key,
                mapping_id, security_id, interval, observation_at, market_date,
                market_timezone, currency_code, close_decimal,
                previous_close_decimal, adjustment_state, quality,
                delayed_minutes, ingested_at, provider_revision_id,
                payload_sha256, upload_batch_id
              )
              SELECT ?, ?, 'user', ?, ?, ${mappingIdSubquery}, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?
              WHERE ${mappingIdSubquery} IS NOT NULL
              ${conflictClause}
              DO UPDATE SET
                market_date = excluded.market_date,
                market_timezone = excluded.market_timezone,
                currency_code = excluded.currency_code,
                close_decimal = excluded.close_decimal,
                quality = excluded.quality,
                delayed_minutes = excluded.delayed_minutes,
                ingested_at = excluded.ingested_at
              WHERE
                market_date IS NOT excluded.market_date
                OR market_timezone IS NOT excluded.market_timezone
                OR currency_code IS NOT excluded.currency_code
                OR close_decimal IS NOT excluded.close_decimal
                OR quality IS NOT excluded.quality
                OR delayed_minutes IS NOT excluded.delayed_minutes
              RETURNING id`,
        params: [
          generatedId,
          candidate.providerId,
          input.userId,
          input.userId,
          candidate.providerId,
          candidate.securityId,
          candidate.securityId,
          candidate.interval,
          candidate.observationAt,
          candidate.marketDate,
          candidate.marketTimezone,
          candidate.currencyCode,
          candidate.priceDecimal,
          candidate.adjustmentState,
          candidate.quality,
          candidate.delayedMinutes,
          input.now,
          // Only the INSERT branch (SELECT ... WHERE mapping exists) ever
          // writes upload_batch_id -- the ON CONFLICT DO UPDATE SET above
          // deliberately omits it (B1 fix).
          input.uploadBatchId,
          candidate.providerId,
          candidate.securityId,
        ],
      });
    }
    const results = await client.batch(statements);
    // EFF-001 (measure 3 + review fold): no `RETURNING id` row means EITHER
    // (a) the guarded `INSERT ... SELECT ... WHERE mappingIdSubquery IS NOT
    // NULL` matched nothing, or (b) the row DID conflict but the
    // `DO UPDATE ... WHERE` guard found every value column already
    // identical and correctly performed no write at all. These are
    // DIFFERENT facts -- (b) is the intended write-avoidance saving, (a) is
    // a genuine anomaly (the guard-create statement immediately precedes
    // each price statement in the SAME batch, so this "should" be
    // unreachable) -- so unresolved entries are verified against
    // `security_provider_mappings` in ONE follow-up read per chunk (only
    // when needed) rather than silently folded into one ambiguous count.
    const unresolvedEntries: typeof priceStatementEntries = [];
    for (const entry of priceStatementEntries) {
      const returnedId = results[entry.index]?.results[0]?.id;
      if (returnedId === undefined) {
        unresolvedEntries.push(entry);
        continue;
      }
      written += 1;
      if (returnedId === entry.generatedId) insertedCount += 1;
    }
    if (unresolvedEntries.length > 0) {
      const uniquePairs = [
        ...new Map(
          unresolvedEntries.map((entry) => [
            `${entry.providerId} ${entry.securityId}`,
            entry,
          ]),
        ).values(),
      ];
      const existingMappings = await client.all<{
        provider_id: string;
        security_id: string;
      }>(
        `SELECT DISTINCT provider_id, security_id FROM security_provider_mappings
          WHERE valid_to IS NULL AND (${uniquePairs
            .map(() => `(provider_id = ? AND security_id = ?)`)
            .join(" OR ")})`,
        uniquePairs.flatMap((entry) => [entry.providerId, entry.securityId]),
      );
      const mappingExists = new Set(
        existingMappings.map((row) => `${row.provider_id} ${row.security_id}`),
      );
      for (const entry of unresolvedEntries) {
        if (mappingExists.has(`${entry.providerId} ${entry.securityId}`)) {
          unchangedCount += 1;
        } else {
          mappingMissingCount += 1;
        }
      }
    }
  }
  return { written, insertedCount, unchangedCount, mappingMissingCount };
}

export type CreatePriceUploadBatchInput = Readonly<{
  id: string;
  userId: string;
  sourceLabel: string;
  format: "single" | "backup";
  filename: string;
  rowCount: number;
  malformedRowCount: number;
  now: string;
}>;

/**
 * Creates the batch row with `inserted_row_count = 0` -- the caller updates
 * that field afterward via `updatePriceUploadBatchInsertedCount` once
 * `writePriceUploadObservations` reports the real count. This call MUST
 * complete before any `price_observations` chunk that references this
 * batch's id runs (see `db/schema.ts`'s `uploadBatchId` column comment for
 * why this ORDERING, not shared-transaction atomicity, is what keeps that
 * soft reference orphan-free).
 */
export async function createPriceUploadBatch(
  client: SqlClient,
  input: CreatePriceUploadBatchInput,
): Promise<void> {
  await client.run(
    `INSERT INTO price_upload_batches (
       id, user_id, source_label, format, filename, row_count,
       inserted_row_count, malformed_row_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      input.id,
      input.userId,
      input.sourceLabel,
      input.format,
      input.filename,
      input.rowCount,
      input.malformedRowCount,
      input.now,
    ],
  );
}

/**
 * Records how many rows this upload actually CREATED (as opposed to
 * `row_count`, which also includes rows it merely overlaid -- see B1's
 * ruling on `db/schema.ts`) as a point-in-time BATCH-SUMMARY value. Called
 * once, immediately after `writePriceUploadObservations` returns.
 *
 * Review follow-up (2026-08-21): this stored column is a two-statement-window
 * snapshot (write, THEN this UPDATE) -- a crash between them leaves a batch
 * whose real attributed-row count no longer matches this column (e.g. `0`
 * here while `price_observations` rows already carry its `upload_batch_id`).
 * `listPriceUploadBatches` below therefore does NOT read this column for
 * the owner-facing `insertedRowCount` it returns -- it computes a LIVE
 * `COUNT(*)` instead (self-healing, cheap via
 * `price_observations_upload_batch_idx`), so the delete dialog/list always
 * states the number a delete would actually remove, never a stale
 * point-in-time value. This column is retained only as an internal
 * batch-summary artifact (kept in sync for anyone reading the raw table
 * directly), never trusted for a DELETE-facing figure.
 */
export async function updatePriceUploadBatchInsertedCount(
  client: SqlClient,
  userId: string,
  batchId: string,
  insertedRowCount: number,
): Promise<void> {
  await client.run(
    `UPDATE price_upload_batches SET inserted_row_count = ? WHERE id = ? AND user_id = ?`,
    [insertedRowCount, batchId, userId],
  );
}

export type PriceUploadBatchRecord = Readonly<{
  id: string;
  sourceLabel: string;
  format: "single" | "backup";
  filename: string;
  rowCount: number;
  insertedRowCount: number;
  malformedRowCount: number;
  createdAt: string;
}>;

function mapBatch(row: Record<string, unknown>): PriceUploadBatchRecord {
  return {
    id: String(row.id),
    sourceLabel: String(row.source_label),
    format: String(row.format) as "single" | "backup",
    filename: String(row.filename),
    rowCount: Number(row.row_count),
    insertedRowCount: Number(row.inserted_row_count),
    malformedRowCount: Number(row.malformed_row_count),
    createdAt: String(row.created_at),
  };
}

/**
 * `insertedRowCount` on every returned record is a LIVE `COUNT(*)` of
 * `price_observations` rows still attributed to that batch (`upload_batch_id
 * = b.id`), not the stored `inserted_row_count` column -- see that column's
 * own doc comment (`updatePriceUploadBatchInsertedCount`) for why: the
 * stored value is a two-statement-window snapshot that can go stale on a
 * crash between the write and its follow-up UPDATE. Computing it live here
 * is self-healing (always correct regardless of that window) and cheap
 * (`price_observations_upload_batch_idx` backs the correlated subquery) --
 * this is the ONLY place `insertedRowCount` is read for owner-facing
 * display (the past-uploads list and, by extension, the delete
 * confirmation dialog, which looks up its batch from this same list).
 */
export async function listPriceUploadBatches(
  client: SqlClient,
  userId: string,
): Promise<PriceUploadBatchRecord[]> {
  const rows = await client.all<Record<string, unknown>>(
    `SELECT b.id AS id, b.source_label AS source_label, b.format AS format,
            b.filename AS filename, b.row_count AS row_count,
            (SELECT COUNT(*) FROM price_observations po
              WHERE po.upload_batch_id = b.id AND po.scope_user_id = b.user_id) AS inserted_row_count,
            b.malformed_row_count AS malformed_row_count, b.created_at AS created_at
       FROM price_upload_batches b
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC, b.id DESC`,
    [userId],
  );
  return rows.map(mapBatch);
}

export type DeletePriceUploadBatchResult =
  | { ok: true; deletedObservations: number }
  | { ok: false; reason: "not_found" };

/**
 * Deletes the upload's own attribution row AND every `price_observations`
 * row this upload CREATED (`upload_batch_id = ?`) -- since `upload_batch_id`
 * is stamped on INSERT only and never reassigned by a later overlay (B1
 * fix, `writePriceUploadObservations`'s header comment), this is EXACTLY
 * the set of rows this upload is responsible for. A row this upload merely
 * OVERLAID (overwrote the price/quote fields of a row some OTHER upload, or
 * Sharesight's accretion, or no upload at all, originally created) is never
 * touched by this delete -- its `upload_batch_id` still names whoever
 * created it, and its value stays whatever this (now-deleted) upload most
 * recently wrote; that overwritten value is NOT reverted (no
 * versioned-override history for market-data facts -- out of scope,
 * documented in `docs/MARKET_DATA_STRATEGY.md` §18 and surfaced honestly in
 * the delete-confirmation copy). Re-uploading the identical file after a
 * delete reconstructs byte-identical observations for the rows THIS upload
 * had created, under a NEW batch id.
 */
export async function deletePriceUploadBatch(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<DeletePriceUploadBatchResult> {
  const owned = await client.get<{ id: string }>(
    `SELECT id FROM price_upload_batches WHERE id = ? AND user_id = ? LIMIT 1`,
    [batchId, userId],
  );
  if (!owned) return { ok: false, reason: "not_found" };
  const results = await client.batch([
    {
      sql: `DELETE FROM price_observations
            WHERE upload_batch_id = ? AND access_scope = 'user' AND scope_user_id = ?
            RETURNING id`,
      params: [batchId, userId],
    },
    {
      sql: `DELETE FROM price_upload_batches WHERE id = ? AND user_id = ?`,
      params: [batchId, userId],
    },
  ]);
  return { ok: true, deletedObservations: results[0]?.results.length ?? 0 };
}

export type PriceExportRow = Readonly<{
  providerId: string;
  sourceLabel: string;
  providerSymbol: string;
  providerExchange: string;
  currencyCode: string;
  marketDate: string;
  priceDecimal: string;
  observationAt: string;
  marketTimezone: string;
  interval: string;
  quality: string;
  adjustmentState: string;
  delayedMinutes: number | null;
}>;

/**
 * The full backup export: every one of the owner's USER-SCOPED
 * `price_observations` rows (never deployment-scoped rows -- those are not
 * the owner's to export, per this task's binding ruling), joined to
 * `security_provider_mappings` for the symbol/exchange evidence
 * `mapping_id` already anchors (the cleanest available provenance source --
 * every row's `mapping_id` resolves to exactly one provider_symbol/
 * provider_exchange pair), and left-joined to `price_upload_batches` for a
 * human `source_label` (falls back to the bare provider id for rows this
 * feature never batch-attributed, e.g. Sharesight's own accretion writes).
 */
export async function loadOwnerPriceExportRows(
  client: SqlClient,
  userId: string,
): Promise<PriceExportRow[]> {
  const rows = await client.all<Record<string, unknown>>(
    `SELECT po.provider_id AS provider_id,
            COALESCE(pub.source_label, po.provider_id) AS source_label,
            spm.provider_symbol AS provider_symbol,
            spm.provider_exchange AS provider_exchange,
            po.currency_code AS currency_code,
            po.market_date AS market_date,
            po.close_decimal AS close_decimal,
            po.observation_at AS observation_at,
            po.market_timezone AS market_timezone,
            po.interval AS interval,
            po.quality AS quality,
            po.adjustment_state AS adjustment_state,
            po.delayed_minutes AS delayed_minutes
       FROM price_observations po
       JOIN security_provider_mappings spm ON spm.id = po.mapping_id
       LEFT JOIN price_upload_batches pub ON pub.id = po.upload_batch_id AND pub.user_id = po.scope_user_id
      WHERE po.access_scope = 'user' AND po.scope_user_id = ?
      ORDER BY po.provider_id ASC, spm.provider_symbol ASC, po.market_date ASC`,
    [userId],
  );
  return rows.map((row) => ({
    providerId: String(row.provider_id),
    sourceLabel: String(row.source_label),
    providerSymbol: String(row.provider_symbol),
    providerExchange: String(row.provider_exchange),
    currencyCode: String(row.currency_code),
    marketDate: String(row.market_date),
    priceDecimal: String(row.close_decimal),
    observationAt: String(row.observation_at),
    marketTimezone: String(row.market_timezone),
    interval: String(row.interval),
    quality: String(row.quality),
    adjustmentState: String(row.adjustment_state),
    delayedMinutes:
      row.delayed_minutes === null ? null : Number(row.delayed_minutes),
  }));
}
