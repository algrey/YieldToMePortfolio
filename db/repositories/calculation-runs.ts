import type { SqlClient } from "./sql-client.ts";

export type CalculationRunStatus =
  "queued" | "running" | "completed" | "failed" | "abandoned";

export type CalculationRunRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  rangeFrom: string;
  rangeTo: string;
  calculationVersion: number;
  reason: string;
  invalidationSource: string | null;
  status: CalculationRunStatus;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  ledgerHighWaterStart: string;
  ledgerHighWaterEnd: string | null;
  processedSnapshotCount: number;
  processedHoldingCount: number;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCategory: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RequestCalculationRunInput = {
  id: string;
  portfolioId: string;
  rangeFrom: string;
  rangeTo: string;
  calculationVersion: number;
  reason: string;
  invalidationSource?: string | null;
  ledgerHighWaterStart: string;
  idempotencyKey: string;
  now: string;
};

export type ClaimCalculationRunResult =
  | { ok: true; run: CalculationRunRecord }
  | { ok: false; reason: "not-claimable" };

export type CompleteCalculationRunResult =
  | { ok: true; run: CalculationRunRecord }
  | { ok: false; reason: "stale-ledger" | "not-owned" | "not-running" };

function mapRun(row: Record<string, unknown>): CalculationRunRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    rangeFrom: String(row.range_from),
    rangeTo: String(row.range_to),
    calculationVersion: Number(row.calculation_version),
    reason: String(row.reason),
    invalidationSource:
      row.invalidation_source === null ? null : String(row.invalidation_source),
    status: String(row.status) as CalculationRunStatus,
    attempt: Number(row.attempt),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null ? null : String(row.lease_expires_at),
    ledgerHighWaterStart: String(row.ledger_high_water_start),
    ledgerHighWaterEnd:
      row.ledger_high_water_end === null
        ? null
        : String(row.ledger_high_water_end),
    processedSnapshotCount: Number(row.processed_snapshot_count),
    processedHoldingCount: Number(row.processed_holding_count),
    idempotencyKey: String(row.idempotency_key),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    failureCategory:
      row.failure_category === null ? null : String(row.failure_category),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const selectRun = `
  SELECT * FROM calculation_runs
  WHERE user_id = ? AND portfolio_id = ? AND id = ?
`;

export function createCalculationRunRepository(sql: SqlClient) {
  async function get(
    userId: string,
    portfolioId: string,
    runId: string,
  ): Promise<CalculationRunRecord | null> {
    const row = await sql.get<Record<string, unknown>>(selectRun, [
      userId,
      portfolioId,
      runId,
    ]);
    return row ? mapRun(row) : null;
  }

  return {
    async request(
      userId: string,
      input: RequestCalculationRunInput,
    ): Promise<CalculationRunRecord> {
      await sql.run(
        `
          INSERT INTO calculation_runs (
            id, user_id, portfolio_id, range_from, range_to,
            calculation_version, reason, invalidation_source, status, attempt,
            ledger_high_water_start, idempotency_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
          ON CONFLICT (user_id, portfolio_id, calculation_version, idempotency_key)
          DO NOTHING
        `,
        [
          input.id,
          userId,
          input.portfolioId,
          input.rangeFrom,
          input.rangeTo,
          input.calculationVersion,
          input.reason,
          input.invalidationSource ?? null,
          input.ledgerHighWaterStart,
          input.idempotencyKey,
          input.now,
          input.now,
        ],
      );

      const run = await get(userId, input.portfolioId, input.id);
      if (run) {
        return run;
      }

      const existing = await sql.get<Record<string, unknown>>(
        `
          SELECT * FROM calculation_runs
          WHERE user_id = ? AND portfolio_id = ?
            AND calculation_version = ? AND idempotency_key = ?
        `,
        [
          userId,
          input.portfolioId,
          input.calculationVersion,
          input.idempotencyKey,
        ],
      );
      if (!existing) {
        throw new Error("calculation_run_insert_not_visible");
      }
      return mapRun(existing);
    },

    async claim(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      leaseExpiresAt: string,
      now: string,
    ): Promise<ClaimCalculationRunResult> {
      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET status = 'running', attempt = attempt + 1,
              lease_owner = ?, lease_expires_at = ?,
              started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE user_id = ? AND portfolio_id = ? AND id = ?
            AND (
              status = 'queued'
              OR (status = 'running' AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= ?)
            )
        `,
        [leaseOwner, leaseExpiresAt, now, now, userId, portfolioId, runId, now],
      );
      if (result.changes !== 1) {
        return { ok: false, reason: "not-claimable" };
      }

      const run = await get(userId, portfolioId, runId);
      return run ? { ok: true, run } : { ok: false, reason: "not-claimable" };
    },

    async complete(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      currentLedgerHighWater: string,
      now: string,
      processedSnapshotCount: number,
      processedHoldingCount: number,
    ): Promise<CompleteCalculationRunResult> {
      const existing = await get(userId, portfolioId, runId);
      if (!existing || existing.leaseOwner !== leaseOwner) {
        return { ok: false, reason: "not-owned" };
      }
      if (existing.status !== "running") {
        return { ok: false, reason: "not-running" };
      }
      if (existing.leaseExpiresAt === null || existing.leaseExpiresAt <= now) {
        return { ok: false, reason: "not-owned" };
      }
      if (existing.ledgerHighWaterStart !== currentLedgerHighWater) {
        return { ok: false, reason: "stale-ledger" };
      }

      const result = await sql.run(
        `
          UPDATE calculation_runs
          SET status = 'completed', ledger_high_water_end = ?,
              processed_snapshot_count = ?, processed_holding_count = ?,
              completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ?
          WHERE user_id = ? AND portfolio_id = ? AND id = ?
            AND status = 'running' AND lease_owner = ?
            AND lease_expires_at > ?
            AND ledger_high_water_start = ?
        `,
        [
          currentLedgerHighWater,
          processedSnapshotCount,
          processedHoldingCount,
          now,
          now,
          userId,
          portfolioId,
          runId,
          leaseOwner,
          now,
          currentLedgerHighWater,
        ],
      );
      if (result.changes !== 1) {
        return { ok: false, reason: "stale-ledger" };
      }

      const run = await get(userId, portfolioId, runId);
      return run ? { ok: true, run } : { ok: false, reason: "not-running" };
    },
  };
}
