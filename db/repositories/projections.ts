import {
  buildLedgerProjections,
  type ProjectionBuildResult,
  type ProjectionLedgerTransaction,
} from "../../domain/ledger/index.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

type CalculationRun = {
  id: string;
  calculationVersion: number;
  status: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  ledgerHighWaterStart: string;
  ledgerHighWaterEnd: string | null;
};

export type ProjectionRebuildInput = {
  portfolioId: string;
  calculationRunId: string;
  leaseOwner: string;
  currentLedgerHighWater: string;
  now: string;
};

export type ProjectionRebuildSuccess = {
  ok: true;
  calculationRunId: string;
  idempotent: boolean;
  lotCount: number;
  allocationCount: number;
  holdingCount: number;
  reconciliation: {
    holdingQuantityEqualsOpenLots: true;
    allocationQuantityEqualsSales: true;
  };
};

export type ProjectionRebuildFailure = {
  ok: false;
  reason:
    | "not_found"
    | "not_owned"
    | "not_running"
    | "stale_ledger"
    | "invalid_decimal"
    | "invalid_scale"
    | "oversell"
    | "atomic_failure";
  eventId?: string;
};

export type ProjectionRebuildResult =
  ProjectionRebuildSuccess | ProjectionRebuildFailure;

const PROJECTION_MARKER = `
  EXISTS (
    SELECT 1 FROM calculation_runs
    WHERE id = ? AND user_id = ? AND portfolio_id = ?
      AND status = 'completed'
      AND calculation_version = ?
      AND ledger_high_water_end = ?
      AND completed_at = ?
  )
`;

function mapRun(row: Record<string, unknown>): CalculationRun {
  return {
    id: String(row.id),
    calculationVersion: Number(row.calculation_version),
    status: String(row.status),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null ? null : String(row.lease_expires_at),
    ledgerHighWaterStart: String(row.ledger_high_water_start),
    ledgerHighWaterEnd:
      row.ledger_high_water_end === null
        ? null
        : String(row.ledger_high_water_end),
  };
}

function mapTransaction(
  row: Record<string, unknown>,
): ProjectionLedgerTransaction {
  return {
    id: String(row.id),
    portfolioSecurityId:
      row.portfolio_security_id === null
        ? null
        : String(row.portfolio_security_id),
    type: String(row.type),
    status: String(row.status),
    tradeAt: String(row.trade_at),
    quantityDecimal:
      row.quantity_decimal === null ? null : String(row.quantity_decimal),
    unitPriceDecimal:
      row.unit_price_decimal === null ? null : String(row.unit_price_decimal),
    grossAmountDecimal:
      row.gross_amount_decimal === null
        ? null
        : String(row.gross_amount_decimal),
    feeAmountDecimal: String(row.fee_amount_decimal),
    taxAmountDecimal: String(row.tax_amount_decimal),
    fxRateToBaseDecimal:
      row.fx_rate_to_base_decimal === null
        ? null
        : String(row.fx_rate_to_base_decimal),
    reversesTransactionId:
      row.reverses_transaction_id === null
        ? null
        : String(row.reverses_transaction_id),
  };
}

function markerParams(
  userId: string,
  input: ProjectionRebuildInput,
  calculationVersion: number,
): unknown[] {
  return [
    input.calculationRunId,
    userId,
    input.portfolioId,
    calculationVersion,
    input.currentLedgerHighWater,
    input.now,
  ];
}

async function atomic(
  client: SqlClient,
  statements: readonly SqlStatement[],
): Promise<void> {
  if (client.batch) {
    await client.batch(statements);
    return;
  }
  await client.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const statement of statements) {
      await client.run(statement.sql, statement.params);
    }
    await client.run("COMMIT");
  } catch (error) {
    await client.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function countRows(
  client: SqlClient,
  table: string,
  userId: string,
  portfolioId: string,
  runId: string,
): Promise<number> {
  const row = await client.get<{ count: number }>(
    `SELECT count(*) AS count FROM ${table}
     WHERE user_id = ? AND portfolio_id = ? AND calculation_run_id = ?`,
    [userId, portfolioId, runId],
  );
  return Number(row?.count ?? 0);
}

function success(
  input: ProjectionRebuildInput,
  build: ProjectionBuildResult,
  idempotent: boolean,
  counts: { lots: number; allocations: number; holdings: number },
): ProjectionRebuildSuccess {
  if (!build.ok) {
    throw new Error("projection_success_requires_build_success");
  }
  return {
    ok: true,
    calculationRunId: input.calculationRunId,
    idempotent,
    lotCount: counts.lots,
    allocationCount: counts.allocations,
    holdingCount: counts.holdings,
    reconciliation: build.reconciliation,
  };
}

export function createOwnedProjectionRepository(client: SqlClient) {
  async function getRun(
    userId: string,
    input: ProjectionRebuildInput,
  ): Promise<CalculationRun | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT id, calculation_version, status, lease_owner, lease_expires_at,
              ledger_high_water_start, ledger_high_water_end
       FROM calculation_runs
       WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
      [input.calculationRunId, userId, input.portfolioId],
    );
    return row ? mapRun(row) : null;
  }

  async function getCompletedCounts(
    userId: string,
    input: ProjectionRebuildInput,
  ) {
    const [lots, allocations, holdings] = await Promise.all([
      countRows(
        client,
        "tax_lots",
        userId,
        input.portfolioId,
        input.calculationRunId,
      ),
      countRows(
        client,
        "lot_allocations",
        userId,
        input.portfolioId,
        input.calculationRunId,
      ),
      countRows(
        client,
        "holding_projections",
        userId,
        input.portfolioId,
        input.calculationRunId,
      ),
    ]);
    return { lots, allocations, holdings };
  }

  async function rebuild(
    userId: string,
    input: ProjectionRebuildInput,
  ): Promise<ProjectionRebuildResult> {
    const run = await getRun(userId, input);
    if (!run) return { ok: false, reason: "not_found" };
    if (run.status === "completed") {
      if (
        run.ledgerHighWaterEnd === input.currentLedgerHighWater &&
        run.leaseOwner === null
      ) {
        const counts = await getCompletedCounts(userId, input);
        const build: ProjectionBuildResult = {
          ok: true,
          lots: [],
          allocations: [],
          holdings: [],
          reconciliation: {
            holdingQuantityEqualsOpenLots: true,
            allocationQuantityEqualsSales: true,
          },
        };
        return success(input, build, true, counts);
      }
      return { ok: false, reason: "stale_ledger" };
    }
    if (run.status !== "running") return { ok: false, reason: "not_running" };
    if (run.leaseOwner !== input.leaseOwner) {
      return { ok: false, reason: "not_owned" };
    }
    if (run.leaseExpiresAt === null || run.leaseExpiresAt <= input.now) {
      return { ok: false, reason: "not_owned" };
    }
    if (run.ledgerHighWaterStart !== input.currentLedgerHighWater) {
      return { ok: false, reason: "stale_ledger" };
    }

    const rows = await client.all<Record<string, unknown>>(
      `SELECT id, portfolio_security_id, type, status, trade_at,
              quantity_decimal, unit_price_decimal, gross_amount_decimal,
              fee_amount_decimal, tax_amount_decimal, fx_rate_to_base_decimal,
              reverses_transaction_id
       FROM transactions
       WHERE user_id = ? AND portfolio_id = ?
         AND status IN ('posted', 'reversed')
       ORDER BY trade_at, id`,
      [userId, input.portfolioId],
    );
    const build = buildLedgerProjections(rows.map(mapTransaction));
    if (!build.ok) {
      return {
        ok: false,
        reason: build.reason,
        eventId: build.eventId,
      };
    }

    const marker = markerParams(userId, input, run.calculationVersion);
    const completionUpdate: SqlStatement = {
      sql: `
        UPDATE calculation_runs
        SET status = 'completed', ledger_high_water_end = ?,
            processed_snapshot_count = 0, processed_holding_count = ?,
            completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ? AND user_id = ? AND portfolio_id = ?
          AND status = 'running' AND lease_owner = ?
          AND lease_expires_at > ?
          AND calculation_version = ?
          AND ledger_high_water_start = ?
      `,
      params: [
        input.currentLedgerHighWater,
        build.holdings.length,
        input.now,
        input.now,
        input.calculationRunId,
        userId,
        input.portfolioId,
        input.leaseOwner,
        input.now,
        run.calculationVersion,
        input.currentLedgerHighWater,
      ],
    };
    const guard = `${PROJECTION_MARKER}`;
    const statements: SqlStatement[] = [
      completionUpdate,
      {
        sql: `DELETE FROM holding_projections
              WHERE user_id = ? AND portfolio_id = ? AND ${guard}`,
        params: [userId, input.portfolioId, ...marker],
      },
      {
        sql: `DELETE FROM lot_allocations
              WHERE user_id = ? AND portfolio_id = ? AND ${guard}`,
        params: [userId, input.portfolioId, ...marker],
      },
      {
        sql: `DELETE FROM tax_lots
              WHERE user_id = ? AND portfolio_id = ? AND ${guard}`,
        params: [userId, input.portfolioId, ...marker],
      },
    ];

    for (const lot of build.lots) {
      statements.push({
        sql: `INSERT INTO tax_lots (
          id, user_id, portfolio_id, portfolio_security_id,
          opening_transaction_id, acquired_at, original_quantity_decimal,
          open_quantity_decimal, native_basis_decimal, base_basis_decimal,
          basis_status, status, calculation_run_id, calculation_version,
          rebuilt_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${guard}`,
        params: [
          lot.id,
          userId,
          input.portfolioId,
          lot.portfolioSecurityId,
          lot.openingTransactionId,
          lot.acquiredAt,
          lot.originalQuantityDecimal,
          lot.openQuantityDecimal,
          lot.nativeBasisDecimal,
          lot.baseBasisDecimal,
          lot.basisStatus,
          lot.status,
          input.calculationRunId,
          run.calculationVersion,
          input.now,
          ...marker,
        ],
      });
    }
    for (const allocation of build.allocations) {
      statements.push({
        sql: `INSERT INTO lot_allocations (
          id, user_id, portfolio_id, portfolio_security_id,
          sell_transaction_id, tax_lot_id, allocation_sequence,
          matched_quantity_decimal, allocated_base_basis_decimal,
          base_net_proceeds_decimal, fee_base_decimal, tax_base_decimal,
          base_realised_gain_decimal, basis_status, calculation_run_id,
          calculation_version
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${guard}`,
        params: [
          allocation.id,
          userId,
          input.portfolioId,
          allocation.portfolioSecurityId,
          allocation.sellTransactionId,
          allocation.taxLotId,
          allocation.allocationSequence,
          allocation.matchedQuantityDecimal,
          allocation.allocatedBaseBasisDecimal,
          allocation.baseNetProceedsDecimal,
          allocation.feeBaseDecimal,
          allocation.taxBaseDecimal,
          allocation.baseRealisedGainDecimal,
          allocation.basisStatus,
          input.calculationRunId,
          run.calculationVersion,
          ...marker,
        ],
      });
    }
    for (const holding of build.holdings) {
      statements.push({
        sql: `INSERT INTO holding_projections (
          id, user_id, portfolio_id, portfolio_security_id, quantity_decimal,
          native_open_basis_decimal, base_open_basis_decimal,
          average_base_cost_decimal, completeness, status,
          last_ledger_high_water, calculation_run_id, calculation_version,
          rebuilt_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?
        WHERE ${guard}`,
        params: [
          holding.id,
          userId,
          input.portfolioId,
          holding.portfolioSecurityId,
          holding.quantityDecimal,
          holding.nativeOpenBasisDecimal,
          holding.baseOpenBasisDecimal,
          holding.averageBaseCostDecimal,
          holding.completeness,
          input.currentLedgerHighWater,
          input.calculationRunId,
          run.calculationVersion,
          input.now,
          ...marker,
        ],
      });
    }

    try {
      await atomic(client, statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }

    const completed = await getRun(userId, input);
    if (
      !completed ||
      completed.status !== "completed" ||
      completed.ledgerHighWaterEnd !== input.currentLedgerHighWater
    ) {
      return { ok: false, reason: "stale_ledger" };
    }
    const counts = await getCompletedCounts(userId, input);
    return success(input, build, false, counts);
  }

  return { rebuild };
}
