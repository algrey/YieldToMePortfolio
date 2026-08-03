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
  processedLedgerCount: number;
  processedHoldingCount: number;
  projectionCursorSecurityId: string | null;
  projectionActiveSecurityId: string | null;
  projectionOutputOffset: number;
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
  completed: boolean;
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
    | "security_history_too_large"
    | "atomic_failure";
  eventId?: string;
};

export type ProjectionRebuildResult =
  ProjectionRebuildSuccess | ProjectionRebuildFailure;

export type ProjectionRepositoryOptions = {
  maxLedgerEventsPerSecurity?: number;
  maxOutputStatementsPerChunk?: number;
};

const DEFAULT_MAX_LEDGER_EVENTS_PER_SECURITY = 1024;
const DEFAULT_MAX_OUTPUT_STATEMENTS_PER_CHUNK = 20;

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
    processedLedgerCount: Number(row.processed_ledger_count),
    processedHoldingCount: Number(row.processed_holding_count),
    projectionCursorSecurityId:
      row.projection_cursor_security_id === null
        ? null
        : String(row.projection_cursor_security_id),
    projectionActiveSecurityId:
      row.projection_active_security_id === null
        ? null
        : String(row.projection_active_security_id),
    projectionOutputOffset: Number(row.projection_output_offset),
  };
}

function mapTransaction(
  row: Record<string, unknown>,
): ProjectionLedgerTransaction {
  return {
    id: String(row.id),
    portfolioSecurityId: String(row.portfolio_security_id),
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
    reversesTransactionId: null,
  };
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

const reconciliation = {
  holdingQuantityEqualsOpenLots: true,
  allocationQuantityEqualsSales: true,
} as const;

export function createOwnedProjectionRepository(
  client: SqlClient,
  options: ProjectionRepositoryOptions = {},
) {
  const maxLedgerEventsPerSecurity =
    options.maxLedgerEventsPerSecurity ??
    DEFAULT_MAX_LEDGER_EVENTS_PER_SECURITY;
  const maxOutputStatementsPerChunk =
    options.maxOutputStatementsPerChunk ??
    DEFAULT_MAX_OUTPUT_STATEMENTS_PER_CHUNK;
  if (
    !Number.isInteger(maxLedgerEventsPerSecurity) ||
    maxLedgerEventsPerSecurity < 1 ||
    !Number.isInteger(maxOutputStatementsPerChunk) ||
    maxOutputStatementsPerChunk < 1
  ) {
    throw new Error("invalid_projection_chunk_limits");
  }

  async function getRun(
    userId: string,
    input: ProjectionRebuildInput,
  ): Promise<CalculationRun | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT id, calculation_version, status, lease_owner, lease_expires_at,
              ledger_high_water_start, ledger_high_water_end,
              processed_ledger_count, processed_holding_count,
              projection_cursor_security_id, projection_active_security_id,
              projection_output_offset
       FROM calculation_runs
       WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
      [input.calculationRunId, userId, input.portfolioId],
    );
    return row ? mapRun(row) : null;
  }

  async function counts(userId: string, input: ProjectionRebuildInput) {
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

  function result(
    input: ProjectionRebuildInput,
    rowCounts: { lots: number; allocations: number; holdings: number },
    completed: boolean,
    idempotent: boolean,
  ): ProjectionRebuildSuccess {
    return {
      ok: true,
      calculationRunId: input.calculationRunId,
      idempotent,
      completed,
      lotCount: rowCounts.lots,
      allocationCount: rowCounts.allocations,
      holdingCount: rowCounts.holdings,
      reconciliation,
    };
  }

  async function nextSecurityId(
    userId: string,
    input: ProjectionRebuildInput,
    cursor: string | null,
  ): Promise<string | null> {
    const row = await client.get<{ portfolio_security_id: string }>(
      `SELECT t.portfolio_security_id
       FROM transactions t
       WHERE t.user_id = ? AND t.portfolio_id = ?
         AND t.portfolio_security_id IS NOT NULL
         AND t.status IN ('posted', 'reversed')
         AND t.reverses_transaction_id IS NULL
         AND (? IS NULL OR t.portfolio_security_id > ?)
         AND NOT EXISTS (
           SELECT 1 FROM transactions reversal
           WHERE reversal.user_id = t.user_id
             AND reversal.portfolio_id = t.portfolio_id
             AND reversal.reverses_transaction_id = t.id
             AND reversal.status IN ('posted', 'reversed')
         )
       GROUP BY t.portfolio_security_id
       ORDER BY t.portfolio_security_id
       LIMIT 1`,
      [userId, input.portfolioId, cursor, cursor],
    );
    return row ? String(row.portfolio_security_id) : null;
  }

  async function buildSecurity(
    userId: string,
    input: ProjectionRebuildInput,
    securityId: string,
  ): Promise<
    | (Extract<ProjectionBuildResult, { ok: true }> & {
        ledgerEventCount: number;
      })
    | Extract<ProjectionBuildResult, { ok: false }>
    | { ok: false; reason: "security_history_too_large"; eventId: string }
  > {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT t.id, t.portfolio_security_id, t.type, t.status, t.trade_at,
              t.quantity_decimal, t.unit_price_decimal, t.gross_amount_decimal,
              t.fee_amount_decimal, t.tax_amount_decimal,
              t.fx_rate_to_base_decimal
       FROM transactions t
       WHERE t.user_id = ? AND t.portfolio_id = ?
         AND t.portfolio_security_id = ?
         AND t.status IN ('posted', 'reversed')
         AND t.reverses_transaction_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM transactions reversal
           WHERE reversal.user_id = t.user_id
             AND reversal.portfolio_id = t.portfolio_id
             AND reversal.reverses_transaction_id = t.id
             AND reversal.status IN ('posted', 'reversed')
         )
       ORDER BY t.trade_at, t.id
       LIMIT ?`,
      [userId, input.portfolioId, securityId, maxLedgerEventsPerSecurity + 1],
    );
    if (rows.length > maxLedgerEventsPerSecurity) {
      return {
        ok: false,
        reason: "security_history_too_large",
        eventId: securityId,
      };
    }
    const build = buildLedgerProjections(rows.map(mapTransaction));
    return build.ok ? { ...build, ledgerEventCount: rows.length } : build;
  }

  function insertStatements(
    userId: string,
    input: ProjectionRebuildInput,
    run: CalculationRun,
    build: Extract<ProjectionBuildResult, { ok: true }>,
    securityId: string,
  ): SqlStatement[] {
    const guard = `EXISTS (
      SELECT 1 FROM calculation_runs
      WHERE id = ? AND user_id = ? AND portfolio_id = ?
        AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
        AND ledger_high_water_start = ?
        AND projection_cursor_security_id IS ?
        AND projection_active_security_id IS ?
        AND projection_output_offset = ?
    )`;
    const marker = [
      input.calculationRunId,
      userId,
      input.portfolioId,
      input.leaseOwner,
      input.now,
      input.currentLedgerHighWater,
      run.projectionCursorSecurityId,
      run.projectionActiveSecurityId,
      run.projectionOutputOffset,
    ];
    const statements: SqlStatement[] = [];
    for (const lot of build.lots) {
      statements.push({
        sql: `INSERT INTO tax_lots (
          id, user_id, portfolio_id, portfolio_security_id,
          opening_transaction_id, acquired_at, original_quantity_decimal,
          open_quantity_decimal, native_basis_decimal, base_basis_decimal,
          basis_status, status, calculation_run_id, calculation_version,
          rebuilt_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        params: [
          `${input.calculationRunId}:${lot.id}`,
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
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        params: [
          `${input.calculationRunId}:${allocation.id}`,
          userId,
          input.portfolioId,
          allocation.portfolioSecurityId,
          allocation.sellTransactionId,
          `${input.calculationRunId}:${allocation.taxLotId}`,
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
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ? WHERE ${guard}`,
        params: [
          `${input.calculationRunId}:${holding.id}`,
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
    void securityId;
    return statements;
  }

  async function publish(
    userId: string,
    input: ProjectionRebuildInput,
    run: CalculationRun,
  ): Promise<ProjectionRebuildResult> {
    const completion: SqlStatement = {
      sql: `UPDATE calculation_runs
            SET status = 'completed', ledger_high_water_end = ?,
                completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                updated_at = ?
            WHERE id = ? AND user_id = ? AND portfolio_id = ?
              AND status = 'running' AND lease_owner = ?
              AND lease_expires_at > ? AND ledger_high_water_start = ?
              AND projection_active_security_id IS NULL`,
      params: [
        input.currentLedgerHighWater,
        input.now,
        input.now,
        input.calculationRunId,
        userId,
        input.portfolioId,
        input.leaseOwner,
        input.now,
        input.currentLedgerHighWater,
      ],
    };
    const publication: SqlStatement = {
      sql: `INSERT INTO projection_publications (
              user_id, portfolio_id, calculation_run_id, calculation_version,
              ledger_high_water, published_at
            )
            SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM calculation_runs
              WHERE id = ? AND user_id = ? AND portfolio_id = ?
                AND status = 'completed' AND ledger_high_water_end = ?
                AND completed_at = ?
            )
            ON CONFLICT (portfolio_id) DO UPDATE SET
              user_id = excluded.user_id,
              calculation_run_id = excluded.calculation_run_id,
              calculation_version = excluded.calculation_version,
              ledger_high_water = excluded.ledger_high_water,
              published_at = excluded.published_at`,
      params: [
        userId,
        input.portfolioId,
        input.calculationRunId,
        run.calculationVersion,
        input.currentLedgerHighWater,
        input.now,
        input.calculationRunId,
        userId,
        input.portfolioId,
        input.currentLedgerHighWater,
        input.now,
      ],
    };
    try {
      await atomic(client, [completion, publication]);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const completed = await getRun(userId, input);
    if (!completed || completed.status !== "completed") {
      return { ok: false, reason: "stale_ledger" };
    }
    return result(input, await counts(userId, input), true, false);
  }

  async function rebuild(
    userId: string,
    input: ProjectionRebuildInput,
  ): Promise<ProjectionRebuildResult> {
    const run = await getRun(userId, input);
    if (!run) return { ok: false, reason: "not_found" };
    if (run.status === "completed") {
      if (run.ledgerHighWaterEnd !== input.currentLedgerHighWater) {
        return { ok: false, reason: "stale_ledger" };
      }
      return result(input, await counts(userId, input), true, true);
    }
    if (run.status !== "running") return { ok: false, reason: "not_running" };
    if (
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= input.now
    ) {
      return { ok: false, reason: "not_owned" };
    }
    if (run.ledgerHighWaterStart !== input.currentLedgerHighWater) {
      return { ok: false, reason: "stale_ledger" };
    }

    const securityId =
      run.projectionActiveSecurityId ??
      (await nextSecurityId(userId, input, run.projectionCursorSecurityId));
    if (securityId === null) return publish(userId, input, run);

    const build = await buildSecurity(userId, input, securityId);
    if (!build.ok) {
      return { ok: false, reason: build.reason, eventId: build.eventId };
    }
    const outputs = insertStatements(userId, input, run, build, securityId);
    const offset = run.projectionOutputOffset;
    const slice = outputs.slice(offset, offset + maxOutputStatementsPerChunk);
    const nextOffset = offset + slice.length;
    const securityCompleted = nextOffset >= outputs.length;
    const checkpoint: SqlStatement = {
      sql: `UPDATE calculation_runs
            SET projection_cursor_security_id = ?,
                projection_active_security_id = ?, projection_output_offset = ?,
                processed_ledger_count = processed_ledger_count + ?,
                processed_holding_count = processed_holding_count + ?,
                updated_at = ?
            WHERE id = ? AND user_id = ? AND portfolio_id = ?
              AND status = 'running' AND lease_owner = ?
              AND lease_expires_at > ? AND ledger_high_water_start = ?
              AND projection_cursor_security_id IS ?
              AND projection_active_security_id IS ?
              AND projection_output_offset = ?`,
      params: [
        securityCompleted ? securityId : run.projectionCursorSecurityId,
        securityCompleted ? null : securityId,
        securityCompleted ? 0 : nextOffset,
        securityCompleted ? build.ledgerEventCount : 0,
        securityCompleted ? build.holdings.length : 0,
        input.now,
        input.calculationRunId,
        userId,
        input.portfolioId,
        input.leaseOwner,
        input.now,
        input.currentLedgerHighWater,
        run.projectionCursorSecurityId,
        run.projectionActiveSecurityId,
        run.projectionOutputOffset,
      ],
    };
    try {
      await atomic(client, [...slice, checkpoint]);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    return result(input, await counts(userId, input), false, false);
  }

  return { rebuild };
}
