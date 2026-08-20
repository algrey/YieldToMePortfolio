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
 */
export async function writePriceUploadObservations(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    uploadBatchId: string;
    candidates: readonly PriceUploadWriteCandidate[];
    now: string;
  }>,
): Promise<{ written: number; insertedCount: number }> {
  if (input.candidates.length === 0) return { written: 0, insertedCount: 0 };

  let written = 0;
  let insertedCount = 0;
  for (const batchCandidates of chunk(
    input.candidates,
    PRICE_UPLOAD_WRITE_LIMITS.maxCandidatesPerChunk,
  )) {
    const statements: SqlStatement[] = [];
    // Tracks, per price_observations statement, the INDEX into `statements`
    // and the `id` this call generated for it -- so the post-batch loop can
    // tell INSERT (returned id === generated id) from an ON CONFLICT
    // overlay (returned id is the pre-existing row's, different) without a
    // second query.
    const priceStatementEntries: Array<{ index: number; generatedId: string }> =
      [];
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
      priceStatementEntries.push({ index: statements.length, generatedId });
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
    for (const entry of priceStatementEntries) {
      const returnedId = results[entry.index]?.results[0]?.id;
      if (returnedId === undefined) continue;
      written += 1;
      if (returnedId === entry.generatedId) insertedCount += 1;
    }
  }
  return { written, insertedCount };
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
