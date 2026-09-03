import { createAuditInsertStatement } from "./audit.ts";
import { createOwnedLedgerRepository } from "./ledger.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import { emitStructuredLog } from "../../domain/observability/logger.ts";

const DEFAULT_CHUNK_SIZE = 2;
const MAX_CHUNK_SIZE = 2;

export const IMPORT_REVERSAL_LIMITS = {
  maxChunkSize: MAX_CHUNK_SIZE,
  // HIST-002 review B2 fix (2026-08-25): each reversed transaction now
  // routes through `ledger.ts`'s `persist()`, which pushes one additional
  // `valueHistoryInvalidationFromDateStatement` DELETE into that
  // transaction's own atomic batch (see `persist`'s own doc comment) --
  // a small 2-transaction fixture measured 51 total queries/statements
  // against the previous 50 ceiling (1 over). Raised with headroom.
  maxQueriesPerInvocation: 56,
  maxStatementsPerAtomicUnit: 10,
  maxStatementsPerInvocation: 56,
  maxParametersPerStatement: 100,
  // BUG-016 review B1 fix (2026-09-03): mirrors `import-commit.ts`'s
  // `IMPORT_COMMIT_LIMITS.maxAffectedPortfolios` -- the same ceiling on how
  // many distinct portfolios one finalizing reversal will queue an
  // `import_reverse` rebuild run for. Unlike commit, a reversal must never
  // fail closed on overflow (see `finalize`'s doc comment): the first N
  // portfolios (ordered by id) are queued and the rest are logged as a
  // structured warning, never thrown.
  maxAffectedPortfolios: 25,
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

  // IMP-006: how many `dividend_manual_records` rows this batch's reversal
  // is about to delete in THIS invocation (read before `finalize` builds
  // and executes the atomic DELETE), so the audit metadata never reports
  // "0 reversed" for a dividend-only reversal that is actually deleting
  // income facts.
  async function pendingDividendRecordCount(
    userId: string,
    batchId: string,
  ): Promise<number> {
    const row = await client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM dividend_manual_records
       WHERE user_id = ? AND import_batch_id = ?`,
      [userId, batchId],
    );
    return Number(row?.count ?? 0);
  }

  // DIV-016 part C: how many EXISTING manual records this batch's reversal
  // is about to RESTORE (un-supersede) in THIS invocation -- read before
  // `finalize` builds and executes the atomic UPDATE/DELETE pair, so the
  // audit metadata honestly discloses the restoration alongside the
  // deletion. Owner ruling: reversing a Sharesight batch must restore the
  // manual row's evidence, never silently lose it -- a manual row this
  // batch reconciled-away (superseded) becomes the head of its lineage
  // again the moment its superseding (imported) row is reversed.
  async function pendingRestoredManualRecordCount(
    userId: string,
    batchId: string,
  ): Promise<number> {
    const row = await client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM dividend_manual_records
       WHERE user_id = ?
         AND superseded_by_record_id IN (
           SELECT id FROM dividend_manual_records
           WHERE user_id = ? AND import_batch_id = ?
         )`,
      [userId, userId, batchId],
    );
    return Number(row?.count ?? 0);
  }

  async function finalize(
    userId: string,
    batchId: string,
    idempotencyKey: string,
    requestId: string,
    reversed: boolean,
    // BUG-016: how many of THIS batch's own `dividend_manual_records` rows
    // are still present as of the read taken just before this call (`reverse()`'s
    // `pendingDividendRecordCount`) -- lets a trade-only invocation (the
    // overwhelmingly common case) skip the extra grouped SELECT below
    // entirely, keeping `IMPORT_REVERSAL_LIMITS.maxQueriesPerInvocation`
    // unchanged for that path. A resumed/repeated FINAL invocation also
    // naturally reads 0 here (the rows are already gone from the first
    // successful run), so it skips the SELECT and queues no duplicate run --
    // the ON CONFLICT DO NOTHING on the INSERT below is a second, belt-and-
    // braces guard, not the only one.
    dividendRecordCount: number,
    metadata: Record<string, unknown>,
  ): Promise<{ ok: true; dividendRebuildJobIds: string[] } | { ok: false }> {
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
    ];
    let dividendRebuildJobIds: string[] = [];
    // BUG-016 review B1 fix (2026-09-03): the per-portfolio `calculation_runs`
    // INSERT statements are computed inside the `if (reversed)` block below
    // (while `dividend_manual_records` still holds this batch's rows, before
    // the DELETE further down removes them) but are NOT pushed into the
    // atomic `statements` array -- they are issued in their own chunked
    // `client.batch()` calls after `atomic()` below succeeds. See that
    // block's own doc comment for the full rationale.
    let dividendRebuildInserts: { id: string; statement: SqlStatement }[] = [];
    // BUG-016: the dividend side of a reversal (the flip below, the DIV-016C
    // restore, and the hard DELETE) must never run on a non-final CHUNK --
    // only the finalizing invocation (`reversed === true`) may touch income
    // facts. Before this fix all three ran on EVERY invocation, so a batch
    // with more trades than `chunkSize` lost every dividend record after the
    // very first chunk; if a later chunk then failed permanently
    // (`dependent_facts`/`conflict`) the batch was stuck `reversing` with its
    // income facts already gone. Each statement stays self-guarded/idempotent
    // exactly as before, so a resumed/repeated FINAL invocation is still a
    // safe no-op.
    if (reversed) {
      statements.push(
        // IMP-006: dividend rows never post through the ledger (see
        // `db/repositories/dividends.ts`), so they have no compensating
        // "reversal" transaction for the predicate above to match. DIV-001
        // treats `dividend_manual_records` as an owner-mutable/deletable fact
        // rather than an immutable ledger entry (its own repository already
        // exposes a hard `remove()`), so reversal here deletes exactly the
        // rows this batch created (via `import_batch_id`) instead of writing
        // a "reversed" marker row -- there is no such status on this table.
        // Both statements below are self-guarded and safe to include on
        // every finalizing invocation (including resumed/repeated ones): the
        // `UPDATE` only matches rows still `committed`, and the `DELETE`
        // only matches rows that still exist, so a repeat run of either is a
        // no-op.
        {
          sql: `
            UPDATE import_rows
            SET commit_status = 'reversed', updated_at = ?, version = version + 1
            WHERE user_id = ? AND batch_id = ? AND commit_status = 'committed'
              AND row_class = 'transaction'
              AND json_extract(normalized_fields_json, '$.type') = 'dividend'
          `,
          params: [at, userId, batchId],
        },
        // DIV-016 part C: restore (un-supersede) any manual row this batch
        // reconciled away BEFORE the DELETE below removes its superseding
        // (imported) successor -- ordering matters, the subquery must still
        // find the about-to-be-deleted rows. Owner ruling: "sharesight
        // should take precedence from there forward" implies the reverse
        // too -- reversing that same sync must hand precedence back to the
        // manual row, never silently lose it. Self-guarded like the
        // statements around it: only rows still pointing at THIS batch's
        // imported rows match, so a repeat/resumed reversal invocation is a
        // safe no-op.
        {
          sql: `
            UPDATE dividend_manual_records
            SET superseded_by_record_id = NULL, updated_at = ?, version = version + 1
            WHERE user_id = ?
              AND superseded_by_record_id IN (
                SELECT id FROM dividend_manual_records
                WHERE user_id = ? AND import_batch_id = ?
              )
          `,
          params: [at, userId, userId, batchId],
        },
      );

      // BUG-016: close the asymmetry PRF-007 left on the commit side --
      // PRF-007's `import-commit.ts` `finalize` queues a `projection`
      // `calculation_runs` row for every portfolio a dividend-only COMMIT
      // touched, on the same terms as a trade-bearing commit. Note PRF-007's
      // own review B3 retraction: nothing derived actually reads
      // `dividend_manual_records` content today (`/income` reads dividends
      // LIVE; neither `db/repositories/projections.ts` nor
      // `domain/snapshots/historical-portfolio-value.ts` /
      // `domain/dividends/shares-held.ts` consume the table at all), so this
      // queued run cannot change any figure `/income` or `/holdings`
      // renders. PRF-007 queued it anyway, on its own merits, for parity
      // between the two commit kinds -- this mirrors that same parity
      // decision onto the reversal path rather than inventing a rebuild
      // this data actually needs. Guarded by `dividendRecordCount` (read
      // just before `finalize` was called): a trade-only reversal skips the
      // extra SELECT and queues nothing.
      //
      // Review B1 fix (2026-09-03): this per-portfolio SELECT+INSERT used to
      // build one `calculation_runs` INSERT per row returned and push every
      // one of them into THIS function's single atomic `client.batch()` --
      // an atomic unit whose size was therefore controlled by how many
      // distinct portfolios a batch's dividend rows happened to span, with
      // no LIMIT on the SELECT at all. A 10-statement `maxStatementsPerAtomicUnit`
      // budget (measured: 9 statements trade-only, 12 with 6 dividend-bearing
      // portfolios) made a wide dividend-bearing batch's reversal exceed the
      // atomic-unit budget -- and unlike commit's `revalidation_failed`
      // fail-closed response to the same shape of problem, a REVERSAL must
      // never fail closed here: the ledger side has already been reversed
      // (this is the FINALIZING invocation), so refusing to finish would
      // strand the batch. The fix below still reads this SELECT here, before
      // the DELETE two statements below removes its own source rows -- but
      // defers actually ISSUING the per-portfolio INSERTs until after the
      // fixed-size atomic unit below has committed, chunked into their own
      // separate `client.batch()` calls capped at `maxStatementsPerAtomicUnit`
      // each (see the `dividendRebuildInserts` loop after `atomic()`
      // succeeds). That keeps the ONE atomic unit that must complete
      // together with the reversal itself (row flip, dividend flip,
      // DIV-016C restore, delete, audit, batch-status -- 6 statements,
      // fixed regardless of dividend-portfolio count) genuinely fixed-size,
      // while the parity rebuild queueing -- non-essential per PRF-007's own
      // B3 retraction above -- becomes best-effort and bounded instead of a
      // reversal-blocking liability. `LIMIT maxAffectedPortfolios + 1`
      // mirrors `import-commit.ts`'s identical overflow probe; on overflow
      // the first N portfolios (by id) are still queued and the rest are
      // logged, never thrown.
      if (dividendRecordCount > 0) {
        const dividendPortfolios = await client.all<Record<string, unknown>>(
          `
            SELECT dmr.portfolio_id AS portfolio_id,
                   MIN(dmr.payment_date) AS range_from,
                   MAX(dmr.payment_date) AS range_to,
                   COALESCE(
                     (SELECT latest.id FROM transactions latest
                      WHERE latest.user_id = ? AND latest.portfolio_id = dmr.portfolio_id
                        AND latest.status IN ('posted', 'reversed')
                      ORDER BY latest.trade_at DESC, latest.id DESC LIMIT 1),
                     ''
                   ) AS ledger_high_water
            FROM dividend_manual_records dmr
            WHERE dmr.user_id = ? AND dmr.import_batch_id = ?
            GROUP BY dmr.portfolio_id
            ORDER BY dmr.portfolio_id ASC
            LIMIT ?
          `,
          [
            userId,
            userId,
            batchId,
            IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios + 1,
          ],
        );
        let affectedPortfolioRows = dividendPortfolios;
        if (
          affectedPortfolioRows.length >
          IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios
        ) {
          emitStructuredLog({
            level: "warn",
            event: "import.reverse",
            action: "import.reverse.dividend_rebuild_overflow",
            result: "failure",
            requestId,
            metadata: {
              batchId,
              affectedPortfolios: affectedPortfolioRows.length,
              queuedPortfolios: IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios,
            },
          });
          affectedPortfolioRows = affectedPortfolioRows.slice(
            0,
            IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios,
          );
        }
        dividendRebuildInserts = affectedPortfolioRows.map((row) => {
          const portfolioId = String(row.portfolio_id);
          const rebuildJobId = `import-reversal-rebuild:${batchId}:${portfolioId}`;
          return {
            id: rebuildJobId,
            statement: {
              sql: `INSERT INTO calculation_runs (
                id, user_id, portfolio_id, range_from, range_to, calculation_version,
                reason, invalidation_source, status, attempt, ledger_high_water_start,
                idempotency_key, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 1, 'import_reverse', ?, 'queued', 0, ?, ?, ?, ?)
              ON CONFLICT (user_id, portfolio_id, calculation_version, idempotency_key) DO NOTHING`,
              params: [
                rebuildJobId,
                userId,
                portfolioId,
                String(row.range_from),
                String(row.range_to),
                batchId,
                String(row.ledger_high_water),
                rebuildJobId,
                at,
                at,
              ],
            },
          };
        });
        dividendRebuildJobIds = dividendRebuildInserts.map((entry) => entry.id);
      }

      statements.push({
        sql: `
          DELETE FROM dividend_manual_records
          WHERE user_id = ? AND import_batch_id = ?
        `,
        params: [userId, batchId],
      });
    }
    statements.push(
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: reversed ? "import.reverse" : "import.reverse.chunk",
          targetType: "import_batch",
          targetId: batchId,
          requestId,
          result: "success",
          metadata:
            dividendRebuildJobIds.length > 0
              ? {
                  ...metadata,
                  rebuildJobIds: [
                    ...((metadata.rebuildJobIds as string[] | undefined) ?? []),
                    ...dividendRebuildJobIds,
                  ],
                }
              : metadata,
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
    );
    try {
      await atomic(client, statements);
    } catch {
      return { ok: false };
    }

    // BUG-016 review B1 fix (2026-09-03): the reversal itself is already
    // durable at this point (the atomic unit above committed, including the
    // batch's terminal `reversed` status) -- everything from here down is
    // best-effort parity queueing (see the doc comment where
    // `dividendRebuildInserts` is built) and must NEVER turn an
    // already-successful reversal into a failure response, nor strand the
    // batch. Each chunk is its own `client.batch()` call capped at
    // `maxStatementsPerAtomicUnit` statements; a failed chunk stops further
    // queueing (nothing later depends on ordering) and is logged, but the
    // ids that landed before the failure are still returned so callers can
    // still advance what did get queued.
    const landedDividendRebuildJobIds: string[] = [];
    for (
      let index = 0;
      index < dividendRebuildInserts.length;
      index += IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit
    ) {
      const chunk = dividendRebuildInserts.slice(
        index,
        index + IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit,
      );
      try {
        await client.batch(chunk.map((entry) => entry.statement));
        landedDividendRebuildJobIds.push(...chunk.map((entry) => entry.id));
      } catch {
        emitStructuredLog({
          level: "error",
          event: "import.reverse",
          action: "import.reverse.dividend_rebuild_queue_failed",
          result: "failure",
          requestId,
          metadata: {
            batchId,
            queuedCount: landedDividendRebuildJobIds.length,
            intendedCount: dividendRebuildInserts.length,
          },
        });
        break;
      }
    }

    return { ok: true, dividendRebuildJobIds: landedDividendRebuildJobIds };
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
      const finalizing = remaining === 0;
      const dividendRecordCount = await pendingDividendRecordCount(
        userId,
        batchId,
      );
      const restoredManualRecordCount = await pendingRestoredManualRecordCount(
        userId,
        batchId,
      );
      // BUG-016: these counts are read from `dividend_manual_records` as it
      // stands BEFORE this call's own writes -- on a non-final CHUNK the
      // dividend statements below do not run at all (see `finalize`), so the
      // rows are still merely PENDING, not reversed/restored yet. Naming the
      // audit field honestly by invocation kind stops a chunk's metadata
      // from reading "reversed" for income facts `finalize` did not touch.
      const finalized = await finalize(
        userId,
        batchId,
        input.idempotencyKey,
        input.requestId,
        finalizing,
        dividendRecordCount,
        {
          reversedTransactionCount: reversedTransactions,
          remainingTransactionCount: remaining,
          ...(finalizing
            ? {
                reversedDividendRecordCount: dividendRecordCount,
                restoredManualRecordCount,
              }
            : {
                pendingDividendRecordCount: dividendRecordCount,
                pendingRestoredManualRecordCount: restoredManualRecordCount,
              }),
          rebuildJobIds,
        },
      );
      if (!finalized.ok) {
        return { ok: false, reason: "atomic_failure", resumable: true };
      }

      return {
        ok: true,
        batchId,
        status: finalizing ? "reversed" : "reversing",
        resumed,
        idempotent: resumed && reversedTransactions === 0,
        reversedTransactions,
        remainingTransactions: remaining,
        rebuildJobIds: [...rebuildJobIds, ...finalized.dividendRebuildJobIds],
      };
    },
  };
}
