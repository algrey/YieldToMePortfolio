import { randomUUID } from "node:crypto";
import type {
  ImportIssue as ParsedImportIssue,
  ImportParseFailure,
  ImportParseResult,
  ImportParseSuccess,
  ImportRowKind as ParsedImportRowKind,
  NormalizedImportRow,
  ParsedImportRow,
} from "../../domain/imports/index.ts";
import type { SqlClient } from "./sql-client.ts";

export type ImportBatchStatus =
  | "uploaded"
  | "parsed"
  | "needs_mapping"
  | "invalid"
  | "ready"
  | "committing"
  | "committed"
  | "reversing"
  | "reversed"
  | "failed";

export type ImportRowStatus = "staged" | "valid" | "needs_mapping" | "invalid";

export type ImportCommitStatus =
  "staged" | "committed" | "skipped" | "reversed" | "failed";

export type ImportBatchRecord = {
  id: string;
  userId: string;
  targetPortfolioId: string | null;
  parserFormat: string;
  parserVersion: string;
  filename: string;
  byteSize: number;
  fileSha256: string;
  status: ImportBatchStatus;
  totalRows: number;
  blankRows: number;
  definitionRows: number;
  transactionRows: number;
  unsupportedRows: number;
  duplicateRows: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  commitIdempotencyKey: string | null;
  reversalIdempotencyKey: string | null;
  supersedesBatchId: string | null;
  failureCategory: string | null;
  failureDetail: string | null;
  createdAt: string;
  updatedAt: string;
  parsedAt: string | null;
  committedAt: string | null;
  reversedAt: string | null;
  version: number;
};

export type ImportRowRecord = {
  id: string;
  userId: string;
  batchId: string;
  physicalRowNumber: number;
  rowClass:
    "portfolio_security_definition" | "transaction" | "blank" | "unsupported";
  originalFields: string[];
  normalizedFields: NormalizedImportRow | null;
  normalizedFingerprint: string | null;
  validationStatus: ImportRowStatus;
  targetPortfolioId: string | null;
  targetPortfolioSecurityId: string | null;
  commitStatus: ImportCommitStatus;
  commitTransactionId: string | null;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type ImportIssueRecord = {
  id: string;
  userId: string;
  batchId: string;
  rowId: string | null;
  physicalRowNumber: number | null;
  field: string | null;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  suggestedResolutionType: string | null;
  resolvedValue: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type ImportMutationFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict" }
  | { ok: false; reason: "invalid_transition" };

export type StartImportUploadInput = {
  id?: string;
  targetPortfolioId?: string | null;
  supersedesBatchId?: string | null;
  parserFormat: string;
  parserVersion: string;
  filename: string;
  byteSize: number;
  fileSha256: string;
};

export type StartImportUploadResult =
  | {
      ok: true;
      reused: false;
      batch: ImportBatchRecord;
    }
  | {
      ok: true;
      reused: true;
      batch: ImportBatchRecord;
    }
  | {
      ok: false;
      reason: "not_found" | "invalid_supersession";
    };

export type RecordParsedImportResultInput = {
  expectedVersion: number;
  parseResult: ImportParseResult;
};

export type RecordParsedImportResult =
  | {
      ok: true;
      batch: ImportBatchRecord;
      rowsInserted: number;
      issuesInserted: number;
    }
  | ImportMutationFailure;

export type TransitionImportBatchInput = {
  expectedVersion: number;
  nextStatus: ImportBatchStatus;
  failureCategory?: string | null;
  failureDetail?: string | null;
};

export type TransitionImportBatchResult =
  | {
      ok: true;
      batch: ImportBatchRecord;
    }
  | ImportMutationFailure;

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) {
    return null;
  }

  return JSON.parse(value) as T;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function createBatchRecord(row: Record<string, unknown>): ImportBatchRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    targetPortfolioId:
      row.target_portfolio_id === null ? null : String(row.target_portfolio_id),
    parserFormat: String(row.parser_format),
    parserVersion: String(row.parser_version),
    filename: String(row.filename),
    byteSize: Number(row.byte_size),
    fileSha256: String(row.file_sha256),
    status: String(row.status) as ImportBatchStatus,
    totalRows: Number(row.total_rows),
    blankRows: Number(row.blank_rows),
    definitionRows: Number(row.definition_rows),
    transactionRows: Number(row.transaction_rows),
    unsupportedRows: Number(row.unsupported_rows),
    duplicateRows: Number(row.duplicate_rows),
    errorCount: Number(row.error_count),
    warningCount: Number(row.warning_count),
    infoCount: Number(row.info_count),
    commitIdempotencyKey:
      row.commit_idempotency_key === null
        ? null
        : String(row.commit_idempotency_key),
    reversalIdempotencyKey:
      row.reversal_idempotency_key === null
        ? null
        : String(row.reversal_idempotency_key),
    supersedesBatchId:
      row.supersedes_batch_id === null ? null : String(row.supersedes_batch_id),
    failureCategory:
      row.failure_category === null ? null : String(row.failure_category),
    failureDetail:
      row.failure_detail === null ? null : String(row.failure_detail),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    parsedAt: row.parsed_at === null ? null : String(row.parsed_at),
    committedAt: row.committed_at === null ? null : String(row.committed_at),
    reversedAt: row.reversed_at === null ? null : String(row.reversed_at),
    version: Number(row.version),
  };
}

function createRowRecord(row: Record<string, unknown>): ImportRowRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    batchId: String(row.batch_id),
    physicalRowNumber: Number(row.physical_row_number),
    rowClass: String(row.row_class) as ImportRowRecord["rowClass"],
    originalFields: parseJson<string[]>(String(row.original_fields_json)) ?? [],
    normalizedFields: parseJson<NormalizedImportRow>(
      row.normalized_fields_json as string | null,
    ),
    normalizedFingerprint:
      row.normalized_fingerprint === null
        ? null
        : String(row.normalized_fingerprint),
    validationStatus: String(row.validation_status) as ImportRowStatus,
    targetPortfolioId:
      row.target_portfolio_id === null ? null : String(row.target_portfolio_id),
    targetPortfolioSecurityId:
      row.target_portfolio_security_id === null
        ? null
        : String(row.target_portfolio_security_id),
    commitStatus: String(row.commit_status) as ImportCommitStatus,
    commitTransactionId:
      row.commit_transaction_id === null
        ? null
        : String(row.commit_transaction_id),
    errorCount: Number(row.error_count),
    warningCount: Number(row.warning_count),
    infoCount: Number(row.info_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

function createIssueRecord(row: Record<string, unknown>): ImportIssueRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    batchId: String(row.batch_id),
    rowId: row.row_id === null ? null : String(row.row_id),
    physicalRowNumber:
      row.physical_row_number === null ? null : Number(row.physical_row_number),
    field: row.field === null ? null : String(row.field),
    severity: String(row.severity) as ImportIssueRecord["severity"],
    code: String(row.code),
    message: String(row.message),
    suggestedResolutionType:
      row.suggested_resolution_type === null
        ? null
        : String(row.suggested_resolution_type),
    resolvedValue:
      row.resolved_value === null ? null : String(row.resolved_value),
    resolvedByUserId:
      row.resolved_by_user_id === null ? null : String(row.resolved_by_user_id),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

function rowValidationStatus(
  issues: readonly ParsedImportIssue[],
): ImportRowStatus {
  if (issues.some((issue) => issue.severity === "error")) {
    return "invalid";
  }

  if (issues.length > 0) {
    return "needs_mapping";
  }

  return "valid";
}

function rowClassFromParserKind(
  kind: ParsedImportRowKind,
): ImportRowRecord["rowClass"] {
  switch (kind) {
    case "definition":
      return "portfolio_security_definition";
    case "transaction":
      return "transaction";
    case "blank":
      return "blank";
    case "unsupported":
      return "unsupported";
  }
}

function summarizeParseSuccess(parseResult: ImportParseSuccess) {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const row of parseResult.rows) {
    for (const issue of row.issues) {
      if (issue.severity === "error") {
        errorCount += 1;
      } else if (issue.severity === "warning") {
        warningCount += 1;
      } else {
        infoCount += 1;
      }
    }
  }

  for (const issue of parseResult.issues) {
    if (issue.severity === "error") {
      errorCount += 1;
    } else if (issue.severity === "warning") {
      warningCount += 1;
    } else {
      infoCount += 1;
    }
  }

  return {
    errorCount,
    warningCount,
    infoCount,
  };
}

function isValidTransition(
  currentStatus: ImportBatchStatus,
  nextStatus: ImportBatchStatus,
): boolean {
  const allowedTransitions: Record<ImportBatchStatus, ImportBatchStatus[]> = {
    uploaded: ["parsed", "invalid", "failed"],
    parsed: ["needs_mapping", "ready", "invalid", "failed"],
    needs_mapping: ["ready", "invalid", "failed"],
    invalid: [],
    ready: ["committing", "failed"],
    committing: ["committed", "failed"],
    committed: ["reversing", "failed"],
    reversing: ["reversed", "failed"],
    reversed: [],
    failed: [],
  };

  return allowedTransitions[currentStatus].includes(nextStatus);
}

async function withTransaction<T>(
  client: SqlClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const result = await operation();
    await client.run("COMMIT");
    return result;
  } catch (error) {
    await client.run("ROLLBACK").catch(() => undefined);
    if (error instanceof ImportMutationAbort) {
      return error.result as T;
    }
    throw error;
  }
}

class ImportMutationAbort extends Error {
  public readonly result: ImportMutationFailure;

  constructor(result: ImportMutationFailure) {
    super("import mutation aborted");
    this.result = result;
  }
}

async function resolveMutationFailure(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportMutationFailure> {
  const row = await client.get<{ id: string; version: number }>(
    "SELECT id, version FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1",
    [batchId, userId],
  );

  return row
    ? { ok: false, reason: "version_conflict" }
    : { ok: false, reason: "not_found" };
}

export function createOwnedImportStagingRepository(
  client: SqlClient,
  now?: () => string,
) {
  async function loadBatch(
    userId: string,
    batchId: string,
  ): Promise<ImportBatchRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `
        SELECT
          id, user_id, target_portfolio_id, parser_format, parser_version, filename,
          byte_size, file_sha256, status, total_rows, blank_rows, definition_rows,
          transaction_rows, unsupported_rows, duplicate_rows, error_count,
          warning_count, info_count, commit_idempotency_key,
          reversal_idempotency_key, supersedes_batch_id, failure_category,
          failure_detail, created_at, updated_at, parsed_at, committed_at,
          reversed_at, version
        FROM import_batches
        WHERE id = ? AND user_id = ?
        LIMIT 1
      `,
      [batchId, userId],
    );

    return row ? createBatchRecord(row) : null;
  }

  async function insertIssueRows(
    userId: string,
    batchId: string,
    importRowId: string,
    row: ParsedImportRow,
    issueRows: ParsedImportIssue[],
    createdAt: string,
  ): Promise<number> {
    let inserted = 0;
    for (const issue of issueRows) {
      await client.run(
        `
          INSERT INTO import_issues (
            id, user_id, batch_id, row_id, physical_row_number, field, severity,
            code, message, suggested_resolution_type, resolved_value,
            resolved_by_user_id, resolved_at, created_at, updated_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1)
        `,
        [
          randomUUID(),
          userId,
          batchId,
          importRowId,
          row.rowNumber,
          issue.field ?? null,
          issue.severity,
          issue.code,
          issue.message,
          null,
          null,
          createdAt,
          createdAt,
        ],
      );
      inserted += 1;
    }

    return inserted;
  }

  async function insertBatchIssues(
    userId: string,
    batchId: string,
    issues: readonly ParsedImportIssue[],
    createdAt: string,
  ): Promise<number> {
    let inserted = 0;
    for (const issue of issues) {
      await client.run(
        `
          INSERT INTO import_issues (
            id, user_id, batch_id, row_id, physical_row_number, field, severity,
            code, message, suggested_resolution_type, resolved_value,
            resolved_by_user_id, resolved_at, created_at, updated_at, version
          )
          VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 1)
        `,
        [
          randomUUID(),
          userId,
          batchId,
          issue.field ?? null,
          issue.severity,
          issue.code,
          issue.message,
          null,
          createdAt,
          createdAt,
        ],
      );
      inserted += 1;
    }

    return inserted;
  }

  async function insertParsedRows(
    userId: string,
    batchId: string,
    parseResult: ImportParseSuccess,
    createdAt: string,
  ): Promise<{
    rowsInserted: number;
    issuesInserted: number;
    hasError: boolean;
  }> {
    let rowsInserted = 0;
    let issuesInserted = 0;
    let hasError = false;

    for (const row of parseResult.rows) {
      const validationStatus = rowValidationStatus(row.issues);
      const errorCount = row.issues.filter(
        (issue) => issue.severity === "error",
      ).length;
      const warningCount = row.issues.filter(
        (issue) => issue.severity === "warning",
      ).length;
      const infoCount = row.issues.filter(
        (issue) => issue.severity === "info",
      ).length;

      if (errorCount > 0) {
        hasError = true;
      }

      const rowId = randomUUID();
      await client.run(
        `
          INSERT INTO import_rows (
            id, user_id, batch_id, physical_row_number, row_class,
            original_fields_json, normalized_fields_json, normalized_fingerprint,
            validation_status, target_portfolio_id, target_portfolio_security_id,
            commit_status, commit_transaction_id, error_count, warning_count,
            info_count, created_at, updated_at, version
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1)
        `,
        [
          rowId,
          userId,
          batchId,
          row.rowNumber,
          rowClassFromParserKind(row.kind),
          toJson(row.rawFields),
          toJson(row.normalized),
          row.fingerprint,
          validationStatus,
          null,
          null,
          "staged",
          errorCount,
          warningCount,
          infoCount,
          createdAt,
          createdAt,
        ],
      );
      rowsInserted += 1;
      issuesInserted += await insertIssueRows(
        userId,
        batchId,
        rowId,
        row,
        row.issues,
        createdAt,
      );
    }

    if (parseResult.issues.some((issue) => issue.severity === "error")) {
      hasError = true;
    }

    return { rowsInserted, issuesInserted, hasError };
  }

  async function persistParsedResult(
    userId: string,
    batchId: string,
    input: RecordParsedImportResultInput,
  ): Promise<RecordParsedImportResult> {
    return await withTransaction(client, async () => {
      const current = await client.get<{
        id: string;
        status: ImportBatchStatus;
        version: number;
      }>(
        "SELECT id, status, version FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1",
        [batchId, userId],
      );

      if (!current) {
        throw new ImportMutationAbort({ ok: false, reason: "not_found" });
      }

      if (current.version !== input.expectedVersion) {
        throw new ImportMutationAbort({
          ok: false,
          reason: "version_conflict",
        });
      }

      if (current.status !== "uploaded") {
        throw new ImportMutationAbort({
          ok: false,
          reason: "invalid_transition",
        });
      }

      const updatedAt = nowIso(now);

      if (!input.parseResult.ok) {
        const parseFailure = input.parseResult as ImportParseFailure;
        const failureDetail = toJson({
          code: parseFailure.code,
          message: parseFailure.message,
          headerSignature: parseFailure.header?.signature ?? null,
          issueCount: parseFailure.issues.length,
        });
        const issuesInserted = await insertBatchIssues(
          userId,
          batchId,
          parseFailure.issues,
          updatedAt,
        );

        const updatedRows = await client.all<Record<string, unknown>>(
          `
            UPDATE import_batches
            SET status = 'invalid',
                failure_category = ?,
                failure_detail = ?,
                updated_at = ?,
                parsed_at = ?,
                version = version + 1
            WHERE id = ? AND user_id = ? AND version = ?
            RETURNING
              id, user_id, target_portfolio_id, parser_format, parser_version,
              filename, byte_size, file_sha256, status, total_rows, blank_rows,
              definition_rows, transaction_rows, unsupported_rows, duplicate_rows,
              error_count, warning_count, info_count, commit_idempotency_key,
              reversal_idempotency_key, supersedes_batch_id, failure_category,
              failure_detail, created_at, updated_at, parsed_at, committed_at,
              reversed_at, version
          `,
          [
            parseFailure.code,
            failureDetail,
            updatedAt,
            updatedAt,
            batchId,
            userId,
            input.expectedVersion,
          ],
        );

        if (updatedRows.length === 0) {
          throw new ImportMutationAbort(
            await resolveMutationFailure(client, userId, batchId),
          );
        }

        return {
          ok: true,
          batch: createBatchRecord(updatedRows[0] ?? {}),
          rowsInserted: 0,
          issuesInserted,
        };
      }

      const parseSuccess = input.parseResult as ImportParseSuccess;
      const summary = summarizeParseSuccess(parseSuccess);
      const rowStats = await insertParsedRows(
        userId,
        batchId,
        parseSuccess,
        updatedAt,
      );

      const batchStatus: ImportBatchStatus = rowStats.hasError
        ? "invalid"
        : "parsed";
      const failureCategory = rowStats.hasError ? "validation_error" : null;
      const failureDetail = rowStats.hasError
        ? toJson({
            errorCount: summary.errorCount,
            warningCount: summary.warningCount,
            infoCount: summary.infoCount,
            totalRows: parseSuccess.summary.totalRows,
          })
        : null;

      const updatedRows = await client.all<Record<string, unknown>>(
        `
          UPDATE import_batches
          SET status = ?,
              total_rows = ?,
              blank_rows = ?,
              definition_rows = ?,
              transaction_rows = ?,
              unsupported_rows = ?,
              duplicate_rows = ?,
              error_count = ?,
              warning_count = ?,
              info_count = ?,
              failure_category = ?,
              failure_detail = ?,
              updated_at = ?,
              parsed_at = ?,
              version = version + 1
          WHERE id = ? AND user_id = ? AND version = ?
          RETURNING
            id, user_id, target_portfolio_id, parser_format, parser_version,
            filename, byte_size, file_sha256, status, total_rows, blank_rows,
            definition_rows, transaction_rows, unsupported_rows, duplicate_rows,
            error_count, warning_count, info_count, commit_idempotency_key,
            reversal_idempotency_key, supersedes_batch_id, failure_category,
            failure_detail, created_at, updated_at, parsed_at, committed_at,
            reversed_at, version
        `,
        [
          batchStatus,
          parseSuccess.summary.totalRows,
          parseSuccess.summary.blankRows,
          parseSuccess.summary.definitionRows,
          parseSuccess.summary.transactionRows,
          parseSuccess.summary.unsupportedRows,
          parseSuccess.summary.duplicateRows,
          summary.errorCount,
          summary.warningCount,
          summary.infoCount,
          failureCategory,
          failureDetail,
          updatedAt,
          updatedAt,
          batchId,
          userId,
          input.expectedVersion,
        ],
      );

      if (updatedRows.length === 0) {
        throw new ImportMutationAbort(
          await resolveMutationFailure(client, userId, batchId),
        );
      }

      return {
        ok: true,
        batch: createBatchRecord(updatedRows[0] ?? {}),
        rowsInserted: rowStats.rowsInserted,
        issuesInserted: rowStats.issuesInserted,
      };
    });
  }

  return {
    async startUpload(
      userId: string,
      input: StartImportUploadInput,
    ): Promise<StartImportUploadResult> {
      const createdAt = nowIso(now);
      const batchId = input.id ?? randomUUID();
      let targetPortfolioId = input.targetPortfolioId ?? null;
      if (input.supersedesBatchId) {
        const superseded = await client.get<{
          id: string;
          target_portfolio_id: string | null;
          status: ImportBatchStatus;
        }>(
          `SELECT id, target_portfolio_id, status
           FROM import_batches
           WHERE id = ? AND user_id = ? LIMIT 1`,
          [input.supersedesBatchId, userId],
        );
        if (!superseded) return { ok: false, reason: "not_found" };
        if (
          superseded.status !== "reversed" ||
          (targetPortfolioId !== null &&
            targetPortfolioId !== superseded.target_portfolio_id)
        ) {
          return { ok: false, reason: "invalid_supersession" };
        }
        targetPortfolioId = superseded.target_portfolio_id;
      }
      const insertedRows = await client.all<Record<string, unknown>>(
        `
          INSERT INTO import_batches (
            id, user_id, target_portfolio_id, parser_format, parser_version,
            filename, byte_size, file_sha256, status, total_rows, blank_rows,
            definition_rows, transaction_rows, unsupported_rows, duplicate_rows,
            error_count, warning_count, info_count, commit_idempotency_key,
            reversal_idempotency_key, supersedes_batch_id, failure_category,
            failure_detail, created_at, updated_at, parsed_at, committed_at,
            reversed_at, version
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', 0, 0, 0, 0, 0, 0, 0, 0, 0,
            NULL, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, 1
          )
          ON CONFLICT(user_id, file_sha256, parser_format, parser_version)
          DO NOTHING
          RETURNING
            id, user_id, target_portfolio_id, parser_format, parser_version,
            filename, byte_size, file_sha256, status, total_rows, blank_rows,
            definition_rows, transaction_rows, unsupported_rows, duplicate_rows,
            error_count, warning_count, info_count, commit_idempotency_key,
            reversal_idempotency_key, supersedes_batch_id, failure_category,
            failure_detail, created_at, updated_at, parsed_at, committed_at,
            reversed_at, version
        `,
        [
          batchId,
          userId,
          targetPortfolioId,
          input.parserFormat,
          input.parserVersion,
          input.filename,
          input.byteSize,
          input.fileSha256,
          input.supersedesBatchId ?? null,
          createdAt,
          createdAt,
        ],
      );

      if (insertedRows.length > 0) {
        return {
          ok: true,
          reused: false,
          batch: createBatchRecord(insertedRows[0] ?? {}),
        };
      }

      const existing = await loadBatch(userId, batchId);
      if (existing) {
        return {
          ok: true,
          reused: true,
          batch: existing,
        };
      }

      const duplicate = await client.get<Record<string, unknown>>(
        `
          SELECT
            id, user_id, target_portfolio_id, parser_format, parser_version,
            filename, byte_size, file_sha256, status, total_rows, blank_rows,
            definition_rows, transaction_rows, unsupported_rows, duplicate_rows,
            error_count, warning_count, info_count, commit_idempotency_key,
            reversal_idempotency_key, supersedes_batch_id, failure_category,
            failure_detail, created_at, updated_at, parsed_at, committed_at,
            reversed_at, version
          FROM import_batches
          WHERE user_id = ? AND file_sha256 = ? AND parser_format = ? AND parser_version = ?
          LIMIT 1
        `,
        [userId, input.fileSha256, input.parserFormat, input.parserVersion],
      );

      if (!duplicate) {
        throw new Error("expected duplicate batch lookup to return a row");
      }

      return {
        ok: true,
        reused: true,
        batch: createBatchRecord(duplicate),
      };
    },

    async recordParseResult(
      userId: string,
      batchId: string,
      input: RecordParsedImportResultInput,
    ): Promise<RecordParsedImportResult> {
      return await persistParsedResult(userId, batchId, input);
    },

    async transitionStatus(
      userId: string,
      batchId: string,
      input: TransitionImportBatchInput,
    ): Promise<TransitionImportBatchResult> {
      return await withTransaction(client, async () => {
        const current = await client.get<{
          id: string;
          status: ImportBatchStatus;
          version: number;
        }>(
          "SELECT id, status, version FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1",
          [batchId, userId],
        );

        if (!current) {
          throw new ImportMutationAbort({ ok: false, reason: "not_found" });
        }

        if (current.version !== input.expectedVersion) {
          throw new ImportMutationAbort({
            ok: false,
            reason: "version_conflict",
          });
        }

        if (!isValidTransition(current.status, input.nextStatus)) {
          throw new ImportMutationAbort({
            ok: false,
            reason: "invalid_transition",
          });
        }

        const updatedAt = nowIso(now);
        const updatedRows = await client.all<Record<string, unknown>>(
          `
            UPDATE import_batches
            SET status = ?,
                failure_category = ?,
                failure_detail = ?,
                updated_at = ?,
                version = version + 1
            WHERE id = ? AND user_id = ? AND version = ?
            RETURNING
              id, user_id, target_portfolio_id, parser_format, parser_version,
              filename, byte_size, file_sha256, status, total_rows, blank_rows,
              definition_rows, transaction_rows, unsupported_rows, duplicate_rows,
              error_count, warning_count, info_count, commit_idempotency_key,
              reversal_idempotency_key, supersedes_batch_id, failure_category,
              failure_detail, created_at, updated_at, parsed_at, committed_at,
              reversed_at, version
          `,
          [
            input.nextStatus,
            input.failureCategory ?? null,
            input.failureDetail ?? null,
            updatedAt,
            batchId,
            userId,
            input.expectedVersion,
          ],
        );

        if (updatedRows.length === 0) {
          throw new ImportMutationAbort(
            await resolveMutationFailure(client, userId, batchId),
          );
        }

        return {
          ok: true,
          batch: createBatchRecord(updatedRows[0] ?? {}),
        };
      });
    },

    async get(
      userId: string,
      batchId: string,
    ): Promise<ImportBatchRecord | null> {
      return await loadBatch(userId, batchId);
    },

    async listRows(
      userId: string,
      batchId: string,
    ): Promise<ImportRowRecord[]> {
      const rows = await client.all<Record<string, unknown>>(
        `
          SELECT
            id, user_id, batch_id, physical_row_number, row_class,
            original_fields_json, normalized_fields_json, normalized_fingerprint,
            validation_status, target_portfolio_id, target_portfolio_security_id,
            commit_status, commit_transaction_id, error_count, warning_count,
            info_count, created_at, updated_at, version
          FROM import_rows
          WHERE user_id = ? AND batch_id = ?
          ORDER BY physical_row_number ASC, id ASC
        `,
        [userId, batchId],
      );

      return rows.map((row) => createRowRecord(row));
    },

    async listIssues(
      userId: string,
      batchId: string,
    ): Promise<ImportIssueRecord[]> {
      const rows = await client.all<Record<string, unknown>>(
        `
          SELECT
            id, user_id, batch_id, row_id, physical_row_number, field, severity,
            code, message, suggested_resolution_type, resolved_value,
            resolved_by_user_id, resolved_at, created_at, updated_at, version
          FROM import_issues
          WHERE user_id = ? AND batch_id = ?
          ORDER BY physical_row_number ASC, row_id ASC, id ASC
        `,
        [userId, batchId],
      );

      return rows.map((row) => createIssueRecord(row));
    },
  };
}
