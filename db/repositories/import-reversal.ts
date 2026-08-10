import { createAuditInsertStatement } from "./audit.ts";
import { createOwnedLedgerRepository } from "./ledger.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

const DEFAULT_CHUNK_SIZE = 2;
const MAX_CHUNK_SIZE = 2;

export const IMPORT_REVERSAL_LIMITS = {
  maxChunkSize: MAX_CHUNK_SIZE,
  maxQueriesPerInvocation: 50,
  maxStatementsPerAtomicUnit: 10,
  maxStatementsPerInvocation: 50,
  maxParametersPerStatement: 100,
} as const;

export type ImportReversalInput = {
  expectedVersion: number;
  idempotencyKey: string;
  confirmation: boolean;
  requestId: string;
};

export type ImportReversalOptions = {
  chunkSize?: number;
  now?: () => string;
  failAtTransaction?: number;
};

export type ImportReversalImpact = {
  sourceTransactionId: string;
  dependentTransactionId: string;
  portfolioId: string;
  portfolioSecurityId: string;
  dependentTradeAt: string;
  dependentQuantityDecimal: string | null;
};

export type ImportReversalSuccess = {
  ok: true;
  batchId: string;
  status: "reversing" | "reversed";
  resumed: boolean;
  idempotent: boolean;
  reversedTransactions: number;
  remainingTransactions: number;
  rebuildJobIds: string[];
};

export type ImportReversalFailure = {
  ok: false;
  reason:
    | "not_found"
    | "confirmation_required"
    | "invalid_idempotency_key"
    | "stale_batch"
    | "not_committed"
    | "conflict"
    | "dependent_facts"
    | "atomic_failure"
    | "injected_failure";
  resumable?: boolean;
  impacts?: ImportReversalImpact[];
};

export type ImportReversalResult =
  ImportReversalSuccess | ImportReversalFailure;

type BatchState = {
  id: string;
  status: string;
  version: number;
  reversalIdempotencyKey: string | null;
};

type ReversalTarget = {
  transactionId: string;
  portfolioId: string;
};

function batchFromRow(row: Record<string, unknown>): BatchState {
  return {
    id: String(row.id),
    status: String(row.status),
    version: Number(row.version),
    reversalIdempotencyKey:
      row.reversal_idempotency_key === null
        ? null
        : String(row.reversal_idempotency_key),
  };
}

function isValidKey(value: string): boolean {
  return value.length > 0 && value.length <= 120 && !/[\u0000\r\n]/.test(value);
}

/** Executes `statements` as one D1-compatible atomic unit via `batch()`. */
async function atomic(
  client: SqlClient,
  statements: readonly SqlStatement[],
): Promise<void> {
  await client.batch(statements);
}

export function createOwnedImportReversalRepository(
  client: SqlClient,
  options: ImportReversalOptions = {},
) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const now = options.now ?? (() => new Date().toISOString());
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > MAX_CHUNK_SIZE
  ) {
    throw new Error("invalid_import_reversal_chunk_size");
  }

  async function loadBatch(
    userId: string,
    batchId: string,
  ): Promise<BatchState | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT id, status, version, reversal_idempotency_key
       FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1`,
      [batchId, userId],
    );
    return row ? batchFromRow(row) : null;
  }

  async function impactsFor(
    userId: string,
    batchId: string,
  ): Promise<ImportReversalImpact[]> {
    const rows = await client.all<Record<string, unknown>>(
      `
        SELECT DISTINCT
          source.id AS source_transaction_id,
          dependent.id AS dependent_transaction_id,
          dependent.portfolio_id,
          dependent.portfolio_security_id,
          dependent.trade_at AS dependent_trade_at,
          dependent.quantity_decimal AS dependent_quantity_decimal
        FROM import_rows source_row
        JOIN transactions source
          ON source.id = source_row.commit_transaction_id
         AND source.user_id = source_row.user_id
         AND source.import_row_id = source_row.id
        JOIN transactions dependent
          ON dependent.user_id = source.user_id
         AND dependent.portfolio_id = source.portfolio_id
         AND dependent.portfolio_security_id = source.portfolio_security_id
         AND dependent.type = 'sell'
         AND dependent.status = 'posted'
         AND (
           dependent.trade_at > source.trade_at
           OR (dependent.trade_at = source.trade_at AND dependent.id > source.id)
         )
        WHERE source_row.user_id = ?
          AND source_row.batch_id = ?
          AND source_row.commit_status IN ('committed', 'reversed')
          AND NOT EXISTS (
            SELECT 1
            FROM import_rows dependent_row
            WHERE dependent_row.user_id = ?
              AND dependent_row.batch_id = ?
              AND dependent_row.id = dependent.import_row_id
          )
        ORDER BY dependent.trade_at ASC, dependent.id ASC, source.id ASC
      `,
      [userId, batchId, userId, batchId],
    );
    return rows.map((row) => ({
      sourceTransactionId: String(row.source_transaction_id),
      dependentTransactionId: String(row.dependent_transaction_id),
      portfolioId: String(row.portfolio_id),
      portfolioSecurityId: String(row.portfolio_security_id),
      dependentTradeAt: String(row.dependent_trade_at),
      dependentQuantityDecimal:
        row.dependent_quantity_decimal === null
          ? null
          : String(row.dependent_quantity_decimal),
    }));
  }

  async function pendingTargets(
    userId: string,
    batchId: string,
  ): Promise<ReversalTarget[]> {
    const rows = await client.all<Record<string, unknown>>(
      `
        SELECT source.id AS transaction_id, source.portfolio_id
        FROM import_rows source_row
        JOIN transactions source
          ON source.id = source_row.commit_transaction_id
         AND source.user_id = source_row.user_id
         AND source.import_row_id = source_row.id
        LEFT JOIN transactions reversal
          ON reversal.user_id = source.user_id
         AND reversal.portfolio_id = source.portfolio_id
         AND reversal.reverses_transaction_id = source.id
        WHERE source_row.user_id = ?
          AND source_row.batch_id = ?
          AND source_row.commit_status IN ('committed', 'reversed')
          AND source.status = 'posted'
          AND reversal.id IS NULL
        ORDER BY source_row.physical_row_number ASC, source.id ASC
        LIMIT ?
      `,
      [userId, batchId, chunkSize],
    );
    return rows.map((row) => ({
      transactionId: String(row.transaction_id),
      portfolioId: String(row.portfolio_id),
    }));
  }

  async function remainingCount(
    userId: string,
    batchId: string,
  ): Promise<number> {
    const row = await client.get<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM import_rows source_row
        JOIN transactions source
          ON source.id = source_row.commit_transaction_id
         AND source.user_id = source_row.user_id
         AND source.import_row_id = source_row.id
        LEFT JOIN transactions reversal
          ON reversal.user_id = source.user_id
         AND reversal.portfolio_id = source.portfolio_id
         AND reversal.reverses_transaction_id = source.id
        WHERE source_row.user_id = ?
          AND source_row.batch_id = ?
          AND source_row.commit_status IN ('committed', 'reversed')
          AND source.status = 'posted'
          AND reversal.id IS NULL
      `,
      [userId, batchId],
    );
    return Number(row?.count ?? 0);
  }

  async function finalize(
    userId: string,
    batchId: string,
    idempotencyKey: string,
    requestId: string,
    reversed: boolean,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    const at = now();
    const statusFields = reversed
      ? "status = 'reversed', reversed_at = ?"
      : "status = 'reversing'";
    const statusParams = reversed ? [at] : [];
    const statements: SqlStatement[] = [
      {
        sql: `
          UPDATE import_rows
          SET commit_status = 'reversed', updated_at = ?, version = version + 1
          WHERE user_id = ? AND batch_id = ? AND commit_status = 'committed'
            AND EXISTS (
              SELECT 1 FROM transactions source
              JOIN transactions reversal
                ON reversal.user_id = source.user_id
               AND reversal.portfolio_id = source.portfolio_id
               AND reversal.reverses_transaction_id = source.id
              WHERE source.id = import_rows.commit_transaction_id
                AND source.user_id = import_rows.user_id
                AND source.import_row_id = import_rows.id
                AND source.status = 'reversed'
            )
        `,
        params: [at, userId, batchId],
      },
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: reversed ? "import.reverse" : "import.reverse.chunk",
          targetType: "import_batch",
          targetId: batchId,
          requestId,
          result: "success",
          metadata,
          occurredAt: at,
        },
        () => at,
      ),
      {
        sql: `
          UPDATE import_batches
          SET ${statusFields}, updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND status = 'reversing'
            AND reversal_idempotency_key = ?
        `,
        params: [...statusParams, at, batchId, userId, idempotencyKey],
      },
    ];
    try {
      await atomic(client, statements);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async reverse(
      userId: string,
      batchId: string,
      input: ImportReversalInput,
    ): Promise<ImportReversalResult> {
      if (!input.confirmation)
        return { ok: false, reason: "confirmation_required" };
      if (!isValidKey(input.idempotencyKey))
        return { ok: false, reason: "invalid_idempotency_key" };

      const initial = await loadBatch(userId, batchId);
      if (!initial) return { ok: false, reason: "not_found" };
      if (initial.status === "reversed") {
        return initial.reversalIdempotencyKey === input.idempotencyKey
          ? {
              ok: true,
              batchId,
              status: "reversed",
              resumed: true,
              idempotent: true,
              reversedTransactions: 0,
              remainingTransactions: 0,
              rebuildJobIds: [],
            }
          : { ok: false, reason: "conflict" };
      }
      if (initial.status !== "committed" && initial.status !== "reversing") {
        return { ok: false, reason: "not_committed" };
      }
      if (
        initial.status === "reversing" &&
        initial.reversalIdempotencyKey !== input.idempotencyKey
      ) {
        return { ok: false, reason: "conflict" };
      }
      if (
        initial.status === "committed" &&
        initial.version !== input.expectedVersion
      ) {
        return { ok: false, reason: "stale_batch" };
      }

      const impacts = await impactsFor(userId, batchId);
      if (impacts.length > 0) {
        return { ok: false, reason: "dependent_facts", impacts };
      }

      const resumed = initial.status === "reversing";
      if (initial.status === "committed") {
        const at = now();
        const started = await client.run(
          `UPDATE import_batches
           SET status = 'reversing', reversal_idempotency_key = ?,
               updated_at = ?, version = version + 1
           WHERE id = ? AND user_id = ? AND status = 'committed'
             AND version = ? AND reversal_idempotency_key IS NULL`,
          [input.idempotencyKey, at, batchId, userId, input.expectedVersion],
        );
        if (started.changes !== 1) return { ok: false, reason: "stale_batch" };
      }

      const targets = await pendingTargets(userId, batchId);
      const ledger = createOwnedLedgerRepository(client, now);
      const rebuildJobIds: string[] = [];
      let reversedTransactions = 0;
      for (let index = 0; index < targets.length; index += 1) {
        if (options.failAtTransaction === index) {
          return {
            ok: false,
            reason: "injected_failure",
            resumable: true,
          };
        }
        const target = targets[index];
        if (!target) continue;
        const result = await ledger.reverse(
          userId,
          target.portfolioId,
          target.transactionId,
          `import-reversal:${batchId}:${target.transactionId}`,
          input.requestId,
        );
        if (!result.ok) {
          return {
            ok: false,
            reason:
              result.reason === "atomic_failure"
                ? "atomic_failure"
                : result.reason === "not_found"
                  ? "not_found"
                  : "conflict",
            resumable: result.reason === "atomic_failure",
          };
        }
        if (result.calculationRunId)
          rebuildJobIds.push(result.calculationRunId);
        reversedTransactions += result.idempotent ? 0 : 1;
      }

      const remaining = await remainingCount(userId, batchId);
      const finalized = await finalize(
        userId,
        batchId,
        input.idempotencyKey,
        input.requestId,
        remaining === 0,
        {
          reversedTransactionCount: reversedTransactions,
          remainingTransactionCount: remaining,
          rebuildJobIds,
        },
      );
      if (!finalized) {
        return { ok: false, reason: "atomic_failure", resumable: true };
      }

      return {
        ok: true,
        batchId,
        status: remaining === 0 ? "reversed" : "reversing",
        resumed,
        idempotent: resumed && reversedTransactions === 0,
        reversedTransactions,
        remainingTransactions: remaining,
        rebuildJobIds,
      };
    },
  };
}
