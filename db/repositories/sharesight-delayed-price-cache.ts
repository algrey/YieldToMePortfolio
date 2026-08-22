import { randomUUID } from "node:crypto";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { SharesightPriceAccretionCandidate } from "../../domain/sharesight/price-accretion.ts";

// BRK-012C: the delayed-price CACHE + 10-minute read-gate store
// (`sharesight_delayed_prices`, db/schema.ts). One row per (user, security)
// -- the owner's latest observed Sharesight `current_price` plus WHEN it was
// fetched (`fetchedAt`). See db/schema.ts's header comment on
// `sharesightDelayedPrices` for why this is a SEPARATE table from
// `price_observations` rather than a read against it: this cache answers
// "is this owner's price data fresh enough" with ONE cheap indexed query,
// independent of `price_observations`' potentially-multi-row-per-day
// accretion history.

export type SharesightDelayedPriceCacheRow = Readonly<{
  securityId: string;
  priceDecimal: string;
  currencyCode: string;
  /** Sharesight's own quote timestamp (UTC `...Z`), when supplied. */
  quoteAt: string | null;
  /**
   * MKT-015 (migration 0052, review round 2026-08-22, BLOCKING fix):
   * verbatim `SharesightPriceAccretionCandidate.marketDate`/`.marketTimezone`
   * at cache-write time -- derived from Sharesight's ORIGINAL
   * offset-preserving timestamp, never re-derived later from `quoteAt`
   * above (which is already UTC-converted; re-slicing it for a date is
   * exactly the bug `deriveMarketDateFromTimestamp`'s own doc comment
   * forbids). `null` on a row written before migration 0052 -- a legacy
   * row, never guessed at read time; see db/schema.ts's identical
   * disclosure on `sharesightDelayedPrices.marketDate`.
   */
  marketDate: string | null;
  marketTimezone: string | null;
  /** Ingestion time -- the ONLY column the 10-minute gate compares against. */
  fetchedAt: string;
}>;

/**
 * Statement-budget discipline mirrored from
 * `db/repositories/sharesight-price-refresh.ts`'s
 * `SHARESIGHT_PRICE_REFRESH_LIMITS.maxSecuritiesPerChunk`: each candidate
 * costs exactly 1 statement in the upsert batch here (no guarded FK-anchor
 * insert needed -- unlike `price_observations`, this table's FKs point only
 * at `users`/`securities`/`currencies`, which always already exist by the
 * time a candidate reaches this function), so this chunk size has 2x the
 * headroom `sharesight-price-refresh.ts` measured sufficient for the
 * 2-statements-per-candidate case.
 */
const CACHE_UPSERT_CHUNK_SIZE = 25;

/**
 * Review round B2 fix (2026-08-20, BLOCKING): `loadSharesightDelayedPriceCache`'s
 * `IN (...)` clause previously bound ONE parameter per requested security id
 * in a SINGLE statement -- unbounded up to `app/owned-holdings.ts`'s
 * `MAX_HELD` (500), risking a real bind-parameter ceiling well before that
 * (silently swallowed by whatever try/catch wrapped the caller, never
 * surfaced). This chunk size keeps every single `IN (...)` statement to at
 * most 51 bind params (1 `userId` + up to 50 security ids), comfortably
 * under any realistic per-statement limit, regardless of how many
 * securities the owner holds.
 */
const CACHE_READ_CHUNK_SIZE = 50;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Loads this owner's cached delayed-price rows for exactly the requested
 * securities (never another owner's rows -- `user_id = ?` is a hard
 * predicate). Chunked (`CACHE_READ_CHUNK_SIZE`, review round B2 fix) into
 * multiple bounded `IN (...)` queries rather than one unbounded statement --
 * see that constant's doc comment. NOT on the read gate's hot path since
 * the review round B1 fix (staleness is now a per-owner watermark, not a
 * per-security cache scan -- see `app/sharesight-price-gate-service.ts`);
 * this remains a real, exported, chunk-safe accessor for the cache table
 * (tests, and any future per-security display surface).
 */
export async function loadSharesightDelayedPriceCache(
  client: SqlClient,
  userId: string,
  securityIds: readonly string[],
): Promise<Map<string, SharesightDelayedPriceCacheRow>> {
  const unique = [...new Set(securityIds)];
  if (unique.length === 0) return new Map();
  const map = new Map<string, SharesightDelayedPriceCacheRow>();
  for (const batchIds of chunk(unique, CACHE_READ_CHUNK_SIZE)) {
    const placeholders = batchIds.map(() => "?").join(",");
    const rows = await client.all<Record<string, unknown>>(
      `SELECT security_id, price_decimal, currency_code, quote_at,
              market_date, market_timezone, fetched_at
         FROM sharesight_delayed_prices
        WHERE user_id = ? AND security_id IN (${placeholders})`,
      [userId, ...batchIds],
    );
    for (const row of rows) {
      map.set(String(row.security_id), {
        securityId: String(row.security_id),
        priceDecimal: String(row.price_decimal),
        currencyCode: String(row.currency_code),
        quoteAt: row.quote_at === null ? null : String(row.quote_at),
        marketDate: row.market_date === null ? null : String(row.market_date),
        marketTimezone:
          row.market_timezone === null ? null : String(row.market_timezone),
        fetchedAt: String(row.fetched_at),
      });
    }
  }
  return map;
}

/**
 * Upserts one cache row per (user, security) -- ON CONFLICT overwrites the
 * prior row entirely (this is a LATEST-quote cache, never an accretion
 * history; see this table's schema comment). Reuses
 * `SharesightPriceAccretionCandidate` (BRK-012B's pure plan-builder output)
 * as its input shape so the gate's refresh call can feed the SAME candidate
 * list into both this cache write and `upsertSharesightPriceObservations`
 * (the `price_observations` accretion write) without re-deriving anything.
 */
export async function upsertSharesightDelayedPriceCache(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    candidates: readonly SharesightPriceAccretionCandidate[];
    now: string;
  }>,
): Promise<{ written: number }> {
  if (input.candidates.length === 0) return { written: 0 };
  let written = 0;
  for (const batchCandidates of chunk(
    input.candidates,
    CACHE_UPSERT_CHUNK_SIZE,
  )) {
    const statements: SqlStatement[] = batchCandidates.map((candidate) => ({
      sql: `INSERT INTO sharesight_delayed_prices (
              id, user_id, security_id, price_decimal, currency_code,
              quote_at, market_date, market_timezone, fetched_at,
              provider_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sharesight', ?, ?)
            ON CONFLICT (user_id, security_id) DO UPDATE SET
              price_decimal = excluded.price_decimal,
              currency_code = excluded.currency_code,
              quote_at = excluded.quote_at,
              market_date = excluded.market_date,
              market_timezone = excluded.market_timezone,
              fetched_at = excluded.fetched_at,
              updated_at = excluded.updated_at
            RETURNING id`,
      params: [
        randomUUID(),
        input.userId,
        candidate.securityId,
        candidate.closeDecimal,
        candidate.currencyCode,
        candidate.observationAt,
        // MKT-015: `candidate.marketDate`/`.marketTimezone` are ALREADY
        // correctly derived from Sharesight's original offset string by
        // `buildSharesightPriceAccretionPlan` -- this write persists them
        // verbatim so a LATER refresh can recover this exact day from the
        // cache without ever re-deriving a date from `quoteAt`'s
        // UTC-converted instant (see this table's schema comment).
        candidate.marketDate,
        candidate.marketTimezone,
        input.now,
        input.now,
        input.now,
      ],
    }));
    const results = await client.batch(statements);
    for (const result of results) written += result.results.length;
  }
  return { written };
}

/**
 * True when the owner has at least one ENABLED Sharesight link -- the same
 * "no link -> no fetch" rule `sharesight-price-refresh.ts`'s
 * `listEnabledSharesightUserIds` enforces for the cron sweep, checked here
 * as a single owner-scoped EXISTS query so the read gate can skip every
 * other query entirely for the (overwhelmingly common) case of a user with
 * no Sharesight link at all.
 */
export async function hasEnabledSharesightLink(
  client: SqlClient,
  userId: string,
): Promise<boolean> {
  const row = await client.get<{ marker: number }>(
    `SELECT 1 AS marker FROM sharesight_sync_state
      WHERE user_id = ? AND enabled = 1 LIMIT 1`,
    [userId],
  );
  return row !== undefined;
}

/**
 * Single-flight claim for the read gate's refresh, CAS'd via the SAME
 * conditional-UPDATE pattern `calculation_runs.claim()`
 * (`db/repositories/calculation-runs.ts`) uses: `changes = 1` means this
 * invocation won the race. The lease lives on the owner's FIRST enabled
 * `sharesight_sync_state` row (deterministic `ORDER BY id ASC LIMIT 1`) --
 * see db/schema.ts's comment on `priceRefreshLeaseOwner` for why this reuses
 * that existing per-owner row rather than a new lease table. Returns
 * `false` (never throws) when no enabled link exists OR another in-flight
 * request already holds an unexpired lease -- both are "do not fetch this
 * time" outcomes, not errors.
 */
export async function claimSharesightPriceGateLease(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    leaseOwner: string;
    now: string;
    leaseDurationMs: number;
  }>,
): Promise<boolean> {
  const anchor = await client.get<{ id: string }>(
    `SELECT id FROM sharesight_sync_state
      WHERE user_id = ? AND enabled = 1 ORDER BY id ASC LIMIT 1`,
    [input.userId],
  );
  if (!anchor) return false;
  const leaseExpiresAt = new Date(
    Date.parse(input.now) + input.leaseDurationMs,
  ).toISOString();
  const result = await client.run(
    `UPDATE sharesight_sync_state
        SET price_refresh_lease_owner = ?, price_refresh_lease_expires_at = ?,
            updated_at = ?
      WHERE id = ? AND user_id = ? AND enabled = 1
        AND (price_refresh_lease_owner IS NULL
             OR price_refresh_lease_expires_at IS NULL
             OR price_refresh_lease_expires_at <= ?)`,
    [
      input.leaseOwner,
      leaseExpiresAt,
      input.now,
      String(anchor.id),
      input.userId,
      input.now,
    ],
  );
  return result.changes === 1;
}

/**
 * Releases every enabled row's lease matching `leaseOwner` for this owner
 * (matches by owner value, not a captured row id -- safe/idempotent even if
 * the anchor row differed between claim and release, e.g. a link was
 * disabled mid-flight). Best-effort bookkeeping: an unreleased lease simply
 * expires naturally after `leaseDurationMs`, so a failure here is never a
 * correctness problem, only a bounded delay before the next request can
 * claim.
 */
export async function releaseSharesightPriceGateLease(
  client: SqlClient,
  input: Readonly<{ userId: string; leaseOwner: string; now: string }>,
): Promise<void> {
  await client.run(
    `UPDATE sharesight_sync_state
        SET price_refresh_lease_owner = NULL, price_refresh_lease_expires_at = NULL,
            updated_at = ?
      WHERE user_id = ? AND enabled = 1 AND price_refresh_lease_owner = ?`,
    [input.now, input.userId, input.leaseOwner],
  );
}
