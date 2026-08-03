import { randomUUID } from "node:crypto";
import {
  buildLedgerPostingStatements,
  type LedgerPostingPersistenceInput,
} from "./ledger.ts";
import { createAuditInsertStatement } from "./audit.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import { prepareLedgerPosting } from "../../domain/ledger/posting.ts";
import type { NormalizedImportRow } from "../../domain/imports/index.ts";

const DEFAULT_CHUNK_SIZE = 5;
const MAX_CHUNK_SIZE = 5;
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

export const IMPORT_COMMIT_LIMITS = {
  maxChunkSize: MAX_CHUNK_SIZE,
  maxStatementsPerChunk: 50,
  maxParametersPerStatement: 100,
} as const;

export type ImportCommitInput = {
  expectedVersion: number;
  expectedPreviewVersion: string;
  idempotencyKey: string;
  confirmation: boolean;
  requestId: string;
};

export type ImportCommitOptions = {
  chunkSize?: number;
  now?: () => string;
  failAtChunk?: number;
};

export type ImportCommitSuccess = {
  ok: true;
  batchId: string;
  status: "committing" | "committed";
  resumed: boolean;
  idempotent: boolean;
  highWaterRow: number;
  committedRows: number;
  skippedRows: number;
  rebuildJobId: string | null;
};

export type ImportCommitFailure = {
  ok: false;
  reason:
    | "not_found"
    | "confirmation_required"
    | "invalid_idempotency_key"
    | "stale_preview"
    | "not_ready"
    | "conflict"
    | "mapping_incomplete"
    | "atomic_failure"
    | "injected_failure";
  resumable?: boolean;
};

export type ImportCommitResult = ImportCommitSuccess | ImportCommitFailure;

type BatchState = {
  id: string;
  targetPortfolioId: string | null;
  status: string;
  version: number;
  commitIdempotencyKey: string | null;
  commitHighWaterRow: number;
};

type StagedRow = {
  id: string;
  batchId: string;
  physicalRowNumber: number;
  rowClass: string;
  normalizedFieldsJson: string | null;
  normalizedFingerprint: string | null;
  validationStatus: string;
  targetPortfolioId: string | null;
  targetPortfolioSecurityId: string | null;
  commitStatus: string;
};

function nowIso(now: () => string): string {
  return now();
}

function parseNormalized(value: string | null): NormalizedImportRow | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as NormalizedImportRow)
      : null;
  } catch {
    return null;
  }
}

function multiplyDecimal(left: string, right: string): string | null {
  if (!DECIMAL.test(left) || !DECIMAL.test(right)) return null;
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  let coefficient =
    BigInt(`${leftWhole}${leftFraction}`) *
    BigInt(`${rightWhole}${rightFraction}`);
  let scale = leftFraction.length + rightFraction.length;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function invertDecimal(value: string): string | null {
  if (!DECIMAL.test(value) || value === "0") return null;
  const [whole, fraction = ""] = value.split(".");
  const denominator = BigInt(`${whole}${fraction}`);
  const scale = 18;
  const numerator = 10n ** BigInt(scale + fraction.length);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  const digits = rounded.toString().padStart(scale + 1, "0");
  let result = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  result = result.replace(/0+$/, "").replace(/\.$/, "");
  return result || "0";
}

function mapRows(rows: Record<string, unknown>[]): StagedRow[] {
  return rows.map((row) => ({
    id: String(row.id),
    batchId: String(row.batch_id),
    physicalRowNumber: Number(row.physical_row_number),
    rowClass: String(row.row_class),
    normalizedFieldsJson:
      row.normalized_fields_json === null
        ? null
        : String(row.normalized_fields_json),
    normalizedFingerprint:
      row.normalized_fingerprint === null
        ? null
        : String(row.normalized_fingerprint),
    validationStatus: String(row.validation_status),
    targetPortfolioId:
      row.target_portfolio_id === null ? null : String(row.target_portfolio_id),
    targetPortfolioSecurityId:
      row.target_portfolio_security_id === null
        ? null
        : String(row.target_portfolio_security_id),
    commitStatus: String(row.commit_status),
  }));
}

function batchFromRow(row: Record<string, unknown>): BatchState {
  return {
    id: String(row.id),
    targetPortfolioId:
      row.target_portfolio_id === null ? null : String(row.target_portfolio_id),
    status: String(row.status),
    version: Number(row.version),
    commitIdempotencyKey:
      row.commit_idempotency_key === null
        ? null
        : String(row.commit_idempotency_key),
    commitHighWaterRow: Number(row.commit_high_water_row),
  };
}

function isValidCommitKey(value: string): boolean {
  return value.length > 0 && value.length <= 120 && !/[\u0000\r\n]/.test(value);
}

function isPreviewVersion(value: string, batch: BatchState): boolean {
  return new RegExp(`^${batch.version}\\.\\d+$`).test(value);
}

export function createOwnedImportCommitRepository(
  client: SqlClient,
  options: ImportCommitOptions = {},
) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const now = options.now ?? (() => new Date().toISOString());
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > MAX_CHUNK_SIZE
  ) {
    throw new Error("invalid_import_commit_chunk_size");
  }

  async function loadBatch(
    userId: string,
    batchId: string,
  ): Promise<BatchState | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT id, target_portfolio_id, status, version, commit_idempotency_key,
              commit_high_water_row
       FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1`,
      [batchId, userId],
    );
    return row ? batchFromRow(row) : null;
  }

  async function summary(
    userId: string,
    batchId: string,
    batch: BatchState,
    resumed: boolean,
    idempotent: boolean,
  ): Promise<ImportCommitSuccess> {
    const counts = await client.get<Record<string, unknown>>(
      `SELECT
         SUM(CASE WHEN commit_status = 'committed' THEN 1 ELSE 0 END) AS committed_rows,
         SUM(CASE WHEN commit_status = 'skipped' THEN 1 ELSE 0 END) AS skipped_rows
       FROM import_rows WHERE user_id = ? AND batch_id = ?`,
      [userId, batchId],
    );
    const job = await client.get<{ id: string }>(
      `SELECT id FROM calculation_runs
       WHERE user_id = ? AND portfolio_id = ? AND idempotency_key = ? LIMIT 1`,
      [
        userId,
        batch.targetPortfolioId,
        `import-rebuild:${batchId}:${batch.commitIdempotencyKey ?? ""}`,
      ],
    );
    return {
      ok: true,
      batchId,
      status: batch.status === "committed" ? "committed" : "committing",
      resumed,
      idempotent,
      highWaterRow: batch.commitHighWaterRow,
      committedRows: Number(counts?.committed_rows ?? 0),
      skippedRows: Number(counts?.skipped_rows ?? 0),
      rebuildJobId: job?.id ?? null,
    };
  }

  async function resolveInput(
    userId: string,
    batch: BatchState,
    row: StagedRow,
    commitKey: string,
    requestId: string,
  ): Promise<
    | {
        ok: true;
        input: LedgerPostingPersistenceInput;
        sourceReference: string;
      }
    | { ok: false; reason: "mapping_incomplete" }
  > {
    const normalized = parseNormalized(row.normalizedFieldsJson);
    if (!normalized || !normalized.tradeAtUtc || !normalized.localTradeDate) {
      return { ok: false, reason: "mapping_incomplete" };
    }
    const portfolioId = row.targetPortfolioId ?? batch.targetPortfolioId;
    if (!portfolioId || !normalized.currency) {
      return { ok: false, reason: "mapping_incomplete" };
    }
    const portfolio = await client.get<{ base_currency_code: string }>(
      `SELECT base_currency_code FROM portfolios
       WHERE id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
      [portfolioId, userId],
    );
    if (!portfolio) return { ok: false, reason: "mapping_incomplete" };
    const isCash = normalized.cashEvent !== null;
    if (!isCash && !row.targetPortfolioSecurityId) {
      return { ok: false, reason: "mapping_incomplete" };
    }
    let fxRate: string | null = null;
    let fxRateSource: string | null = null;
    if (
      normalized.purchaseExchangeRate !== null &&
      normalized.currency !== portfolio.base_currency_code
    ) {
      const decision = await client.get<{ target_value: string | null }>(
        `SELECT target_value FROM import_mapping_decisions
         WHERE user_id = ? AND batch_id = ? AND kind = 'fx'
           AND source_key = ? ORDER BY scope = 'row' DESC, version DESC LIMIT 1`,
        [
          userId,
          batch.id,
          `${normalized.currency}->${portfolio.base_currency_code}`,
        ],
      );
      if (
        decision?.target_value !== "native_to_home" &&
        decision?.target_value !== "home_to_native"
      ) {
        return { ok: false, reason: "mapping_incomplete" };
      }
      fxRate =
        decision.target_value === "native_to_home"
          ? normalized.purchaseExchangeRate
          : invertDecimal(normalized.purchaseExchangeRate);
      if (!fxRate) return { ok: false, reason: "mapping_incomplete" };
      fxRateSource = "csv_import";
    } else if (normalized.currency !== portfolio.base_currency_code) {
      fxRateSource = null;
    }
    const type = normalized.cashEvent ?? normalized.type;
    if (!type) return { ok: false, reason: "mapping_incomplete" };
    const gross =
      normalized.cashEvent !== null
        ? multiplyDecimal(
            normalized.sharesOwned ?? "",
            normalized.costPerShare ?? "",
          )
        : null;
    if (normalized.cashEvent !== null && !gross) {
      return { ok: false, reason: "mapping_incomplete" };
    }
    const sourceReference = `import-fingerprint:${row.normalizedFingerprint ?? row.id}`;
    return {
      ok: true,
      sourceReference,
      input: {
        portfolioId,
        type,
        portfolioSecurityId: isCash ? null : row.targetPortfolioSecurityId,
        quantityDecimal: isCash ? null : normalized.sharesOwned,
        unitPriceDecimal: isCash ? null : normalized.costPerShare,
        grossAmountDecimal: gross,
        feeAmountDecimal: normalized.commission ?? "0",
        taxAmountDecimal: "0",
        fxRateToBaseDecimal: fxRate,
        fxRateSource,
        fxObservedAt: normalized.tradeAtUtc,
        sourceType: "csv_import",
        idempotencyKey: `import:${batch.id}:${commitKey}:${row.id}`,
        tradeAt: normalized.tradeAtUtc,
        localTradeDate: normalized.localTradeDate,
        currencyCode: normalized.currency,
        sourceReference,
        importRowId: row.id,
        requestId,
        calculationVersion: 1,
      },
    };
  }

  async function finalize(
    userId: string,
    batch: BatchState,
    commitKey: string,
    nowAt: string,
    requestId: string,
  ): Promise<ImportCommitResult> {
    const transactionRows = await client.all<Record<string, unknown>>(
      `SELECT physical_row_number, normalized_fields_json
       FROM import_rows WHERE user_id = ? AND batch_id = ? AND row_class = 'transaction'
       ORDER BY physical_row_number ASC`,
      [userId, batch.id],
    );
    const dates = transactionRows
      .map(
        (row) =>
          parseNormalized(
            row.normalized_fields_json === null
              ? null
              : String(row.normalized_fields_json),
          )?.localTradeDate,
      )
      .filter((date): date is string => typeof date === "string")
      .sort();
    const rangeFrom = dates[0] ?? nowAt.slice(0, 10);
    const rangeTo = dates.at(-1) ?? rangeFrom;
    const rebuildJobId = `import-rebuild:${batch.id}:${commitKey}`;
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO calculation_runs (
          id, user_id, portfolio_id, range_from, range_to, calculation_version,
          reason, invalidation_source, status, attempt, ledger_high_water_start,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'import_commit', ?, 'queued', 0, ?, ?, ?, ?)
        ON CONFLICT (user_id, portfolio_id, calculation_version, idempotency_key) DO NOTHING`,
        params: [
          rebuildJobId,
          userId,
          batch.targetPortfolioId,
          rangeFrom,
          rangeTo,
          batch.id,
          `import:${batch.id}:${batch.commitHighWaterRow}`,
          rebuildJobId,
          nowAt,
          nowAt,
        ],
      },
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "import.commit",
          targetType: "import_batch",
          targetId: batch.id,
          requestId,
          result: "success",
          metadata: { committedRowCount: transactionRows.length },
          occurredAt: nowAt,
        },
        () => nowAt,
      ),
      {
        sql: `UPDATE import_batches
          SET status = 'committed', committed_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND status = 'committing'
            AND commit_idempotency_key = ?
            AND NOT EXISTS (
              SELECT 1 FROM import_rows
              WHERE batch_id = ? AND user_id = ? AND row_class = 'transaction'
                AND commit_status = 'staged'
            )`,
        params: [nowAt, nowAt, batch.id, userId, commitKey, batch.id, userId],
      },
    ];
    try {
      if (client.batch) await client.batch(statements);
      else {
        await client.run("BEGIN IMMEDIATE TRANSACTION");
        try {
          for (const statement of statements)
            await client.run(statement.sql, statement.params);
          await client.run("COMMIT");
        } catch (error) {
          await client.run("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }
    } catch {
      return { ok: false, reason: "atomic_failure", resumable: true };
    }
    const completed = await loadBatch(userId, batch.id);
    if (!completed || completed.status !== "committed") {
      return { ok: false, reason: "atomic_failure", resumable: true };
    }
    return summary(userId, batch.id, completed, true, false);
  }

  return {
    async commit(
      userId: string,
      batchId: string,
      input: ImportCommitInput,
    ): Promise<ImportCommitResult> {
      if (!input.confirmation)
        return { ok: false, reason: "confirmation_required" };
      if (!isValidCommitKey(input.idempotencyKey))
        return { ok: false, reason: "invalid_idempotency_key" };
      const initialBatch = await loadBatch(userId, batchId);
      if (!initialBatch) return { ok: false, reason: "not_found" };
      let batch: BatchState = initialBatch;
      if (batch.status === "committed") {
        return batch.commitIdempotencyKey === input.idempotencyKey
          ? summary(userId, batch.id, batch, true, true)
          : { ok: false, reason: "conflict" };
      }
      if (batch.status !== "ready" && batch.status !== "committing") {
        return { ok: false, reason: "not_ready" };
      }
      if (batch.status === "ready") {
        if (
          batch.version !== input.expectedVersion ||
          !isPreviewVersion(input.expectedPreviewVersion, batch)
        ) {
          return { ok: false, reason: "stale_preview" };
        }
        const changed = await client.run(
          `UPDATE import_batches SET status = 'committing', commit_idempotency_key = ?,
             updated_at = ?, version = version + 1
           WHERE id = ? AND user_id = ? AND status = 'ready' AND version = ?
             AND commit_idempotency_key IS NULL`,
          [
            input.idempotencyKey,
            nowIso(now),
            batch.id,
            userId,
            input.expectedVersion,
          ],
        );
        if (changed.changes !== 1) return { ok: false, reason: "conflict" };
        batch = (await loadBatch(userId, batchId)) as BatchState;
      } else if (batch.commitIdempotencyKey !== input.idempotencyKey) {
        return { ok: false, reason: "conflict" };
      }

      const allRows = mapRows(
        await client.all<Record<string, unknown>>(
          `SELECT id, batch_id, physical_row_number, row_class, normalized_fields_json,
                  normalized_fingerprint, validation_status, target_portfolio_id,
                  target_portfolio_security_id, commit_status
           FROM import_rows WHERE user_id = ? AND batch_id = ?
           ORDER BY physical_row_number ASC, id ASC`,
          [userId, batch.id],
        ),
      );
      const pending = allRows.filter(
        (row) =>
          row.physicalRowNumber > batch.commitHighWaterRow &&
          row.commitStatus === "staged",
      );
      let chunkIndex = Number(
        (
          await client.get<{ count: number }>(
            `SELECT count(*) AS count FROM import_commit_chunks WHERE user_id = ? AND batch_id = ?`,
            [userId, batch.id],
          )
        )?.count ?? 0,
      );
      const seenSourceReferences = new Set<string>();
      for (let offset = 0; offset < pending.length; offset += chunkSize) {
        const chunk = pending.slice(offset, offset + chunkSize);
        if (options.failAtChunk === chunkIndex)
          return { ok: false, reason: "injected_failure", resumable: true };
        const statements: SqlStatement[] = [];
        for (const row of chunk) {
          if (row.rowClass !== "transaction") {
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'skipped', updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [nowIso(now), row.id, userId, batch.id],
            });
            continue;
          }
          const resolved = await resolveInput(
            userId,
            batch,
            row,
            input.idempotencyKey,
            input.requestId,
          );
          if (!resolved.ok) return resolved;
          if (seenSourceReferences.has(resolved.sourceReference)) {
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'skipped', updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [nowIso(now), row.id, userId, batch.id],
            });
            continue;
          }
          seenSourceReferences.add(resolved.sourceReference);
          const existing = await client.get<{
            id: string;
            idempotency_key: string | null;
          }>(
            `SELECT id, idempotency_key FROM transactions
             WHERE user_id = ? AND portfolio_id = ? AND source_type = 'csv_import'
               AND source_reference = ? LIMIT 1`,
            [userId, resolved.input.portfolioId, resolved.sourceReference],
          );
          if (existing) {
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'skipped', commit_transaction_id = ?, updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [existing.id, nowIso(now), row.id, userId, batch.id],
            });
            continue;
          }
          const preparation = prepareLedgerPosting(
            resolved.input,
            randomUUID(),
          );
          if (!preparation.ok)
            return { ok: false, reason: "mapping_incomplete" };
          const built = await buildLedgerPostingStatements(
            client,
            userId,
            resolved.input,
            preparation.posting,
            "import.commit.transaction",
            () => nowIso(now),
          );
          statements.push(...built.statements);
          statements.push({
            sql: `UPDATE import_rows SET commit_status = 'committed', commit_transaction_id = ?, updated_at = ?, version = version + 1
              WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
            params: [
              built.transactionId,
              nowIso(now),
              row.id,
              userId,
              batch.id,
            ],
          });
        }
        const firstPhysicalRow =
          chunk[0]?.physicalRowNumber ?? batch.commitHighWaterRow;
        const lastPhysicalRow =
          chunk.at(-1)?.physicalRowNumber ?? firstPhysicalRow;
        statements.push({
          sql: `INSERT INTO import_commit_chunks (
            id, user_id, batch_id, commit_idempotency_key, chunk_index,
            first_physical_row, last_physical_row, committed_row_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            randomUUID(),
            userId,
            batch.id,
            input.idempotencyKey,
            chunkIndex,
            firstPhysicalRow,
            lastPhysicalRow,
            chunk.length,
            nowIso(now),
          ],
        });
        statements.push(
          createAuditInsertStatement(
            {
              actorUserId: userId,
              targetOwnerUserId: userId,
              action: "import.commit.chunk",
              targetType: "import_batch",
              targetId: batch.id,
              requestId: input.requestId,
              result: "success",
              metadata: { chunkIndex, firstPhysicalRow, lastPhysicalRow },
              occurredAt: nowIso(now),
            },
            () => nowIso(now),
          ),
        );
        statements.push({
          sql: `UPDATE import_batches SET commit_high_water_row = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND user_id = ? AND status = 'committing'
              AND commit_idempotency_key = ? AND commit_high_water_row = ?`,
          params: [
            lastPhysicalRow,
            nowIso(now),
            batch.id,
            userId,
            input.idempotencyKey,
            batch.commitHighWaterRow,
          ],
        });
        try {
          if (client.batch) await client.batch(statements);
          else {
            await client.run("BEGIN IMMEDIATE TRANSACTION");
            try {
              for (const statement of statements)
                await client.run(statement.sql, statement.params);
              await client.run("COMMIT");
            } catch (error) {
              await client.run("ROLLBACK").catch(() => undefined);
              throw error;
            }
          }
        } catch {
          return { ok: false, reason: "atomic_failure", resumable: true };
        }
        batch = (await loadBatch(userId, batch.id)) as BatchState;
        chunkIndex += 1;
      }
      return finalize(
        userId,
        batch,
        input.idempotencyKey,
        nowIso(now),
        input.requestId,
      );
    },
  };
}
