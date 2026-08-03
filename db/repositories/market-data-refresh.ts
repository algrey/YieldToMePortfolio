import { randomUUID } from "node:crypto";
import type {
  FxObservation,
  ObservationScope,
  PriceObservation,
} from "../../domain/market-data/contracts.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

export type RefreshTargetKind = "price" | "fx";
export type MarketDataRefreshJobStatus =
  "queued" | "running" | "completed" | "failed";

export type MarketDataRefreshJobRecord = {
  id: string;
  providerId: string;
  targetKind: RefreshTargetKind;
  targetKey: string;
  mappingId: string | null;
  securityId: string | null;
  baseCurrencyCode: string | null;
  quoteCurrencyCode: string | null;
  scope: ObservationScope;
  scopeKey: string;
  rangeFrom: string;
  rangeTo: string;
  highWaterDate: string | null;
  chunkDays: number;
  status: MarketDataRefreshJobStatus;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  providerRequestCount: number;
  observationCount: number;
  correctionCount: number;
  lastErrorKind: string | null;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RequestMarketDataRefreshInput = {
  id: string;
  providerId: string;
  targetKind: RefreshTargetKind;
  targetKey: string;
  mappingId?: string | null;
  securityId?: string | null;
  baseCurrencyCode?: string | null;
  quoteCurrencyCode?: string | null;
  scope: ObservationScope;
  rangeFrom: string;
  rangeTo: string;
  chunkDays?: number;
  idempotencyKey: string;
  now: string;
};

export type ClaimMarketDataRefreshResult =
  | { ok: true; job: MarketDataRefreshJobRecord }
  | { ok: false; reason: "not-claimable" };

export type ProgressMarketDataRefreshResult =
  | { ok: true; job: MarketDataRefreshJobRecord }
  | { ok: false; reason: "not-owned" | "invalid-progress" };

export type RetryMarketDataRefreshResult =
  | { ok: true; job: MarketDataRefreshJobRecord }
  | { ok: false; reason: "not-owned" | "failed" };

const JOB_COLUMNS = `
  id, provider_id, target_kind, target_key, mapping_id, security_id,
  base_currency_code, quote_currency_code, access_scope, scope_user_id,
  scope_key, range_from, range_to, high_water_date, chunk_days, status,
  attempt, lease_owner, lease_expires_at, next_attempt_at,
  provider_request_count, observation_count, correction_count, last_error_kind,
  idempotency_key, started_at, completed_at, created_at, updated_at
`;

function mapJob(row: Record<string, unknown>): MarketDataRefreshJobRecord {
  const accessScope = String(row.access_scope);
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    targetKind: String(row.target_kind) as RefreshTargetKind,
    targetKey: String(row.target_key),
    mappingId: row.mapping_id === null ? null : String(row.mapping_id),
    securityId: row.security_id === null ? null : String(row.security_id),
    baseCurrencyCode:
      row.base_currency_code === null ? null : String(row.base_currency_code),
    quoteCurrencyCode:
      row.quote_currency_code === null ? null : String(row.quote_currency_code),
    scope:
      accessScope === "deployment"
        ? { kind: "deployment", userId: null }
        : { kind: "user", userId: String(row.scope_user_id) },
    scopeKey: String(row.scope_key),
    rangeFrom: String(row.range_from),
    rangeTo: String(row.range_to),
    highWaterDate:
      row.high_water_date === null ? null : String(row.high_water_date),
    chunkDays: Number(row.chunk_days),
    status: String(row.status) as MarketDataRefreshJobStatus,
    attempt: Number(row.attempt),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null ? null : String(row.lease_expires_at),
    nextAttemptAt: String(row.next_attempt_at),
    providerRequestCount: Number(row.provider_request_count),
    observationCount: Number(row.observation_count),
    correctionCount: Number(row.correction_count),
    lastErrorKind:
      row.last_error_kind === null ? null : String(row.last_error_kind),
    idempotencyKey: String(row.idempotency_key),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function scopeValues(scope: ObservationScope): [string, string | null, string] {
  return scope.kind === "deployment"
    ? ["deployment", null, "deployment"]
    : ["user", scope.userId, scope.userId];
}

function observationScopeValues(
  scope: ObservationScope,
): [string, string | null, string] {
  return scopeValues(scope);
}

function writeStatements(
  observations: readonly (PriceObservation | FxObservation)[],
): SqlStatement[] {
  return observations.map((observation) => {
    const [accessScope, scopeUserId, scopeKey] = observationScopeValues(
      observation.scope,
    );
    if (observation.kind === "price") {
      return {
        sql: `INSERT INTO price_observations (
          id, provider_id, access_scope, scope_user_id, scope_key,
          mapping_id, security_id, interval, observation_at, market_date,
          market_timezone, currency_code, close_decimal, previous_close_decimal,
          adjustment_state, quality, delayed_minutes, ingested_at,
          provider_revision_id, payload_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (
          provider_id, scope_key, mapping_id, interval, observation_at,
          adjustment_state
        ) DO UPDATE SET
          market_date = excluded.market_date,
          market_timezone = excluded.market_timezone,
          currency_code = excluded.currency_code,
          close_decimal = excluded.close_decimal,
          previous_close_decimal = excluded.previous_close_decimal,
          quality = excluded.quality,
          delayed_minutes = excluded.delayed_minutes,
          ingested_at = excluded.ingested_at,
          provider_revision_id = excluded.provider_revision_id,
          payload_sha256 = excluded.payload_sha256`,
        params: [
          randomUUID(),
          observation.providerId,
          accessScope,
          scopeUserId,
          scopeKey,
          observation.mappingId,
          observation.securityId,
          observation.interval,
          observation.observationAt,
          observation.marketDate,
          observation.marketTimezone,
          observation.currencyCode,
          observation.closeDecimal,
          observation.previousCloseDecimal,
          observation.adjustmentState,
          observation.quality,
          observation.delayedMinutes,
          observation.ingestedAt,
          observation.providerRevisionId,
          observation.payloadSha256,
        ],
      };
    }

    return {
      sql: `INSERT INTO fx_rate_observations (
        id, provider_id, access_scope, scope_user_id, scope_key,
        base_currency_code, quote_currency_code, rate_decimal, interval,
        observed_at, market_date, quality, ingested_at, payload_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        provider_id, scope_key, base_currency_code, quote_currency_code,
        interval, observed_at
      ) DO UPDATE SET
        market_date = excluded.market_date,
        rate_decimal = excluded.rate_decimal,
        quality = excluded.quality,
        ingested_at = excluded.ingested_at,
        payload_sha256 = excluded.payload_sha256`,
      params: [
        randomUUID(),
        observation.providerId,
        accessScope,
        scopeUserId,
        scopeKey,
        observation.baseCurrencyCode,
        observation.quoteCurrencyCode,
        observation.rateDecimal,
        observation.interval,
        observation.observedAt,
        observation.marketDate,
        observation.quality,
        observation.ingestedAt,
        observation.payloadSha256,
      ],
    };
  });
}

async function runWriteBatch(
  client: SqlClient,
  statements: readonly SqlStatement[],
): Promise<void> {
  if (statements.length === 0) return;
  if (client.batch) {
    await client.batch(statements);
    return;
  }
  for (const statement of statements) {
    await client.run(statement.sql, statement.params);
  }
}

export function createMarketDataRefreshRepository(client: SqlClient) {
  async function get(id: string): Promise<MarketDataRefreshJobRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${JOB_COLUMNS} FROM market_data_refresh_jobs WHERE id = ?`,
      [id],
    );
    return row ? mapJob(row) : null;
  }

  async function getByIdempotency(
    input: RequestMarketDataRefreshInput,
  ): Promise<MarketDataRefreshJobRecord | null> {
    const [, , scopeKey] = scopeValues(input.scope);
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${JOB_COLUMNS} FROM market_data_refresh_jobs
       WHERE provider_id = ? AND scope_key = ? AND target_kind = ?
         AND target_key = ? AND idempotency_key = ? LIMIT 1`,
      [
        input.providerId,
        scopeKey,
        input.targetKind,
        input.targetKey,
        input.idempotencyKey,
      ],
    );
    return row ? mapJob(row) : null;
  }

  return {
    get,

    async request(
      input: RequestMarketDataRefreshInput,
    ): Promise<MarketDataRefreshJobRecord> {
      const [accessScope, scopeUserId, scopeKey] = scopeValues(input.scope);
      const existingActive = await client.get<Record<string, unknown>>(
        `SELECT ${JOB_COLUMNS} FROM market_data_refresh_jobs
         WHERE provider_id = ? AND scope_key = ? AND target_kind = ?
           AND target_key = ? AND status IN ('queued', 'running')
           AND range_from <= ? AND range_to >= ?
         ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at
         LIMIT 1`,
        [
          input.providerId,
          scopeKey,
          input.targetKind,
          input.targetKey,
          input.rangeTo,
          input.rangeFrom,
        ],
      );
      if (existingActive) {
        const existing = mapJob(existingActive);
        if (existing.status === "queued") {
          await client.run(
            `UPDATE market_data_refresh_jobs
             SET range_from = MIN(range_from, ?), range_to = MAX(range_to, ?),
                 updated_at = ?
             WHERE id = ? AND status = 'queued'`,
            [input.rangeFrom, input.rangeTo, input.now, existing.id],
          );
          return (await get(existing.id)) ?? existing;
        }
        // A running job may have already advanced its high-water mark, so
        // only extend the upper bound. Its lower bound must remain stable to
        // avoid implying that already-processed dates were backfilled.
        if (input.rangeTo > existing.rangeTo) {
          await client.run(
            `UPDATE market_data_refresh_jobs
             SET range_to = MAX(range_to, ?), updated_at = ?
             WHERE id = ? AND status = 'running' AND range_to < ?`,
            [input.rangeTo, input.now, existing.id, input.rangeTo],
          );
          return (await get(existing.id)) ?? existing;
        }
        return existing;
      }

      await client.run(
        `INSERT INTO market_data_refresh_jobs (
          id, provider_id, target_kind, target_key, mapping_id, security_id,
          base_currency_code, quote_currency_code, access_scope, scope_user_id,
          scope_key, range_from, range_to, chunk_days, status, attempt,
          next_attempt_at, provider_request_count, observation_count,
          correction_count, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0,
          ?, 0, 0, 0, ?, ?, ?)
        ON CONFLICT (
          provider_id, scope_key, target_kind, target_key, idempotency_key
        ) DO NOTHING`,
        [
          input.id,
          input.providerId,
          input.targetKind,
          input.targetKey,
          input.mappingId ?? null,
          input.securityId ?? null,
          input.baseCurrencyCode ?? null,
          input.quoteCurrencyCode ?? null,
          accessScope,
          scopeUserId,
          scopeKey,
          input.rangeFrom,
          input.rangeTo,
          input.chunkDays ?? 5,
          input.now,
          input.idempotencyKey,
          input.now,
          input.now,
        ],
      );
      const result = await getByIdempotency(input);
      if (!result) throw new Error("market_data_refresh_job_not_visible");
      return result;
    },

    async listClaimable(
      now: string,
      limit: number,
    ): Promise<MarketDataRefreshJobRecord[]> {
      const rows = await client.all<Record<string, unknown>>(
        `SELECT ${JOB_COLUMNS} FROM market_data_refresh_jobs
         WHERE (status = 'queued' AND next_attempt_at <= ?)
            OR (status = 'running' AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= ?)
         ORDER BY created_at, id LIMIT ?`,
        [now, now, limit],
      );
      return rows.map(mapJob);
    },

    async claim(
      id: string,
      leaseOwner: string,
      leaseExpiresAt: string,
      now: string,
    ): Promise<ClaimMarketDataRefreshResult> {
      const result = await client.run(
        `UPDATE market_data_refresh_jobs
         SET status = 'running', attempt = attempt + 1, lease_owner = ?,
             lease_expires_at = ?, started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE id = ? AND (
           (status = 'queued' AND next_attempt_at <= ?)
           OR (status = 'running' AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?)
         )`,
        [leaseOwner, leaseExpiresAt, now, now, id, now, now],
      );
      if (result.changes !== 1) return { ok: false, reason: "not-claimable" };
      const job = await get(id);
      return job ? { ok: true, job } : { ok: false, reason: "not-claimable" };
    },

    async recordProgress(
      id: string,
      leaseOwner: string,
      highWaterDate: string,
      providerRequestCount: number,
      observationCount: number,
      correctionCount: number,
      now: string,
    ): Promise<ProgressMarketDataRefreshResult> {
      const existing = await get(id);
      if (
        !existing ||
        existing.status !== "running" ||
        existing.leaseOwner !== leaseOwner ||
        existing.leaseExpiresAt === null ||
        existing.leaseExpiresAt <= now
      ) {
        return { ok: false, reason: "not-owned" };
      }
      if (
        highWaterDate < existing.rangeFrom ||
        highWaterDate > existing.rangeTo ||
        (existing.highWaterDate !== null &&
          highWaterDate <= existing.highWaterDate)
      ) {
        return { ok: false, reason: "invalid-progress" };
      }
      const completed = highWaterDate >= existing.rangeTo;
      const result = await client.run(
        `UPDATE market_data_refresh_jobs
         SET high_water_date = ?, status = ?, lease_owner = NULL,
             lease_expires_at = NULL, next_attempt_at = ?,
             provider_request_count = ?, observation_count = ?,
             correction_count = ?, completed_at = ?, last_error_kind = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`,
        [
          highWaterDate,
          completed ? "completed" : "queued",
          now,
          providerRequestCount,
          observationCount,
          correctionCount,
          completed ? now : null,
          now,
          id,
          leaseOwner,
          now,
        ],
      );
      if (result.changes !== 1) return { ok: false, reason: "not-owned" };
      const job = await get(id);
      return job ? { ok: true, job } : { ok: false, reason: "not-owned" };
    },

    async retry(
      id: string,
      leaseOwner: string,
      nextAttemptAt: string,
      errorKind: string,
      now: string,
    ): Promise<RetryMarketDataRefreshResult> {
      const result = await client.run(
        `UPDATE market_data_refresh_jobs
         SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
             next_attempt_at = ?, last_error_kind = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`,
        [nextAttemptAt, errorKind, now, id, leaseOwner, now],
      );
      if (result.changes !== 1) return { ok: false, reason: "not-owned" };
      const job = await get(id);
      return job ? { ok: true, job } : { ok: false, reason: "not-owned" };
    },

    async fail(
      id: string,
      leaseOwner: string,
      errorKind: string,
      now: string,
    ): Promise<RetryMarketDataRefreshResult> {
      const result = await client.run(
        `UPDATE market_data_refresh_jobs
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             last_error_kind = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`,
        [errorKind, now, id, leaseOwner, now],
      );
      if (result.changes !== 1) return { ok: false, reason: "not-owned" };
      const job = await get(id);
      return job ? { ok: true, job } : { ok: false, reason: "failed" };
    },

    async upsertPriceObservations(
      observations: readonly PriceObservation[],
    ): Promise<number> {
      const statements = writeStatements(observations);
      await runWriteBatch(client, statements);
      return observations.length;
    },

    async upsertFxObservations(
      observations: readonly FxObservation[],
    ): Promise<number> {
      const statements = writeStatements(observations);
      await runWriteBatch(client, statements);
      return observations.length;
    },
  };
}
