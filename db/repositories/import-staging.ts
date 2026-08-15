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
import type { SqlClient, SqlStatement } from "./sql-client.ts";

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

export const IMPORT_HISTORY_LIMITS = {
  defaultBatchLimit: 20,
  maxBatchLimit: 50,
  detailPageSize: 50,
  maxDetailPageSize: 100,
  maxDetailOffset: 100_000,
} as const;

export type ImportHistoryPage<T> = {
  items: T[];
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type ImportCommitProgressRecord = {
  highWaterRow: number;
  idempotencyKey: string | null;
  committedRows: number;
  skippedRows: number;
  remainingRows: number;
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
  | { ok: false; reason: "invalid_transition" }
  | { ok: false; reason: "atomic_failure" };

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

function validateHistoryPage(offset: number, limit: number): void {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > IMPORT_HISTORY_LIMITS.maxDetailOffset ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > IMPORT_HISTORY_LIMITS.maxDetailPageSize
  ) {
    throw new Error("invalid_import_history_page");
  }
}

function historyPage<T>(
  rows: T[],
  offset: number,
  limit: number,
): ImportHistoryPage<T> {
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit),
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
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

// The real upload/parse row cap is `DEFAULT_IMPORT_LIMITS.maxRows` (100,000
// rows, `domain/imports/strict-versioned-parser.ts`; also documented in
// `docs/CSV_IMPORT_SPEC.md` §7). `persistParsedResult` below issues one
// child statement per row plus one per row-level issue in a single D1
// `batch()` call (see docs/DATA_MODEL.md §11 for the atomicity technique),
// so its statement count is bounded by that row cap, not by a
// staging-specific chunk size. The normative fixture (`docs/Example_Portfolio.csv`,
// 244 rows) stays far inside D1's verified ~1000-statement batch ceiling;
// pathological uploads near the 100,000-row cap could exceed it, in which
// case the batch call fails closed (`atomic_failure`, nothing persisted)
// rather than partially applying — see docs/CSV_IMPORT_SPEC.md §7 for the
// documented risk.

/** Builds one guarded `import_issues` insert statement: the row is only
 * materialized if the batch's PRE-state (version = expectedVersion, status =
 * 'uploaded') still holds at execution time within the same `batch()` call
 * as the closing `import_batches` UPDATE (see `runAtomicPersist`). */
function issueInsertStatement(
  userId: string,
  batchId: string,
  importRowId: string | null,
  physicalRowNumber: number | null,
  issue: ParsedImportIssue,
  createdAt: string,
  expectedVersion: number,
): SqlStatement {
  const id = randomUUID();
  return {
    sql: `
      INSERT INTO import_issues (
        id, user_id, batch_id, row_id, physical_row_number, field, severity,
        code, message, suggested_resolution_type, resolved_value,
        resolved_by_user_id, resolved_at, created_at, updated_at, version
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1
      WHERE EXISTS (
        SELECT 1 FROM import_batches
        WHERE id = ? AND user_id = ? AND version = ? AND status = 'uploaded'
      )
    `,
    params: [
      id,
      userId,
      batchId,
      importRowId,
      physicalRowNumber,
      issue.field ?? null,
      issue.severity,
      issue.code,
      issue.message,
      createdAt,
      createdAt,
      batchId,
      userId,
      expectedVersion,
    ],
  };
}

/** Builds one guarded `import_rows` insert statement (see `issueInsertStatement`). */
function rowInsertStatement(
  userId: string,
  batchId: string,
  rowId: string,
  row: ParsedImportRow,
  validationStatus: ImportRowStatus,
  errorCount: number,
  warningCount: number,
  infoCount: number,
  createdAt: string,
  expectedVersion: number,
): SqlStatement {
  return {
    sql: `
      INSERT INTO import_rows (
        id, user_id, batch_id, physical_row_number, row_class,
        original_fields_json, normalized_fields_json, normalized_fingerprint,
        validation_status, target_portfolio_id, target_portfolio_security_id,
        commit_status, commit_transaction_id, error_count, warning_count,
        info_count, created_at, updated_at, version
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'staged', NULL, ?, ?, ?, ?, ?, 1
      WHERE EXISTS (
        SELECT 1 FROM import_batches
        WHERE id = ? AND user_id = ? AND version = ? AND status = 'uploaded'
      )
    `,
    params: [
      rowId,
      userId,
      batchId,
      row.rowNumber,
      rowClassFromParserKind(row.kind),
      toJson(row.rawFields),
      toJson(row.normalized),
      row.fingerprint,
      validationStatus,
      errorCount,
      warningCount,
      infoCount,
      createdAt,
      createdAt,
      batchId,
      userId,
      expectedVersion,
    ],
  };
}

/** Builds guarded insert statements for a batch-level (row-independent) issue list. */
function buildBatchIssueStatements(
  userId: string,
  batchId: string,
  issues: readonly ParsedImportIssue[],
  createdAt: string,
  expectedVersion: number,
): { statements: SqlStatement[]; issuesInserted: number } {
  const statements = issues.map((issue) =>
    issueInsertStatement(
      userId,
      batchId,
      null,
      null,
      issue,
      createdAt,
      expectedVersion,
    ),
  );
  return { statements, issuesInserted: statements.length };
}

/** Builds guarded insert statements for every parsed row and its issues,
 * PLUS every genuinely batch-level issue on `parseResult.issues` (BRK-005
 * review round 2 fix).
 *
 * `ImportParseSuccess.issues` (top-level) is not a uniformly independent
 * list across parser sources: `parseStrictVersionedCsvImport`
 * (`strict-versioned-parser.ts`) pushes each row's own issue objects into
 * BOTH `row.issues` AND the top-level `issues` array (`issues.push(
 * ...classification.issues)`) -- a pure, same-object-reference MIRROR of
 * every row-level issue, never a distinct batch-level fact for the CSV
 * path. `domain/sharesight-sync/transform.ts`, by contrast, pushes a
 * genuinely row-less issue (`SHARESIGHT_PAYOUT_UNCONFIRMED`, a null-id
 * payout that was never staged as a row at all) directly and ONLY into its
 * top-level `issues` array -- there is no row for it to also live on.
 *
 * Before this fix, only row-attached issues were ever persisted (this
 * function's per-row loop below), so a genuinely row-less batch issue was
 * silently dropped from `import_issues` even though `summarizeParseSuccess`
 * (which reads `parseResult.issues` directly) had already counted it into
 * the batch's own `warning_count` -- `import_issues` empty, `warning_count`
 * says 1, and the omission's own detail (which symbol/date was skipped)
 * never reached preview at all. Naively persisting the WHOLE top-level
 * `issues` array unconditionally would instead double-insert every CSV
 * issue (the same object already inserted once via the per-row loop, a
 * second time here). The fix distinguishes the two cases by OBJECT
 * IDENTITY, not by parser source: any `parseResult.issues` entry that is
 * not also present (by reference) in some row's own `issues` array is a
 * genuine batch-level fact and gets inserted here exactly once; every
 * CSV-mirrored entry IS present in a row's `issues` array (the same object
 * reference) and is therefore filtered out here, leaving the CSV path's
 * insert count byte-identical to before this fix. */
function buildParsedRowStatements(
  userId: string,
  batchId: string,
  parseResult: ImportParseSuccess,
  createdAt: string,
  expectedVersion: number,
): {
  statements: SqlStatement[];
  rowsInserted: number;
  issuesInserted: number;
  hasError: boolean;
} {
  const statements: SqlStatement[] = [];
  let rowsInserted = 0;
  let issuesInserted = 0;
  let hasError = false;
  const rowIssueRefs = new Set<ParsedImportIssue>();

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
    statements.push(
      rowInsertStatement(
        userId,
        batchId,
        rowId,
        row,
        validationStatus,
        errorCount,
        warningCount,
        infoCount,
        createdAt,
        expectedVersion,
      ),
    );
    rowsInserted += 1;

    for (const issue of row.issues) {
      rowIssueRefs.add(issue);
      statements.push(
        issueInsertStatement(
          userId,
          batchId,
          rowId,
          row.rowNumber,
          issue,
          createdAt,
          expectedVersion,
        ),
      );
      issuesInserted += 1;
    }
  }

  if (parseResult.issues.some((issue) => issue.severity === "error")) {
    hasError = true;
  }

  const batchOnlyIssues = parseResult.issues.filter(
    (issue) => !rowIssueRefs.has(issue),
  );
  const batchIssueStatements = buildBatchIssueStatements(
    userId,
    batchId,
    batchOnlyIssues,
    createdAt,
    expectedVersion,
  );
  statements.push(...batchIssueStatements.statements);
  issuesInserted += batchIssueStatements.issuesInserted;

  return { statements, rowsInserted, issuesInserted, hasError };
}

type AtomicPersistOutcome =
  { ok: true; batchRow: Record<string, unknown> | undefined } | { ok: false };

/**
 * Executes every child `import_rows`/`import_issues` insert FIRST, each
 * guarded by `WHERE EXISTS (SELECT 1 FROM import_batches WHERE id = ? AND
 * user_id = ? AND version = <expectedVersion> AND status = 'uploaded')` —
 * the batch's PRE-state, never any post-bump version — followed by the
 * version-checked `import_batches` UPDATE (`closing`, which also checks
 * `version = <expectedVersion> AND status = 'uploaded'`) as the LAST
 * statement of one atomic D1 `batch()` call.
 *
 * Because `batch()` executes as one indivisible unit with no interleaving
 * from other writers, the PRE-state predicate uniquely identifies "no other
 * writer has touched this batch since the caller's read": if it holds when
 * the guarded inserts run, nothing else can have changed the row before
 * `closing` runs moments later in the same call, so `closing` necessarily
 * also matches and bumps the version. If a concurrent writer already bumped
 * the version (or changed status) before this call started, the PRE-state
 * predicate is stale for every statement in the batch — the inserts AND
 * `closing` (whose own `status = 'uploaded'` predicate matches the same
 * pre-state) all no-op together, leaving the batch exactly as the concurrent
 * writer left it. (Guarding the inserts on the version `closing` would bump
 * *to*, instead of the version it requires *going in*, is unsound: a
 * concurrent writer's own single bump can independently produce that same
 * post-bump value, so the inserts would fire even when this call's own
 * `closing` no-ops against the now-stale pre-bump version it still checks.)
 * A thrown error (e.g. the batch exceeding a D1 platform limit) means D1
 * rolled back the whole call; nothing persisted either way.
 */
async function runAtomicPersist(
  client: SqlClient,
  childStatements: readonly SqlStatement[],
  closing: SqlStatement,
): Promise<AtomicPersistOutcome> {
  try {
    const results = await client.batch([...childStatements, closing]);
    return { ok: true, batchRow: results[results.length - 1]?.results[0] };
  } catch {
    return { ok: false };
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

  async function persistParsedResult(
    userId: string,
    batchId: string,
    input: RecordParsedImportResultInput,
  ): Promise<RecordParsedImportResult> {
    const current = await client.get<{
      id: string;
      status: ImportBatchStatus;
      version: number;
    }>(
      "SELECT id, status, version FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1",
      [batchId, userId],
    );

    if (!current) {
      return { ok: false, reason: "not_found" };
    }

    if (current.version !== input.expectedVersion) {
      return { ok: false, reason: "version_conflict" };
    }

    if (current.status !== "uploaded") {
      return { ok: false, reason: "invalid_transition" };
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
      const { statements, issuesInserted } = buildBatchIssueStatements(
        userId,
        batchId,
        parseFailure.issues,
        updatedAt,
        input.expectedVersion,
      );
      const closing: SqlStatement = {
        sql: `
          UPDATE import_batches
          SET status = 'invalid',
              failure_category = ?,
              failure_detail = ?,
              updated_at = ?,
              parsed_at = ?,
              version = version + 1
          WHERE id = ? AND user_id = ? AND version = ? AND status = 'uploaded'
          RETURNING
            id, user_id, target_portfolio_id, parser_format, parser_version,
            filename, byte_size, file_sha256, status, total_rows, blank_rows,
            definition_rows, transaction_rows, unsupported_rows, duplicate_rows,
            error_count, warning_count, info_count, commit_idempotency_key,
            reversal_idempotency_key, supersedes_batch_id, failure_category,
            failure_detail, created_at, updated_at, parsed_at, committed_at,
            reversed_at, version
        `,
        params: [
          parseFailure.code,
          failureDetail,
          updatedAt,
          updatedAt,
          batchId,
          userId,
          input.expectedVersion,
        ],
      };

      const outcome = await runAtomicPersist(client, statements, closing);
      if (!outcome.ok) {
        return { ok: false, reason: "atomic_failure" };
      }
      const row = outcome.batchRow;
      if (!row) {
        return await resolveMutationFailure(client, userId, batchId);
      }

      return {
        ok: true,
        batch: createBatchRecord(row),
        rowsInserted: 0,
        issuesInserted,
      };
    }

    const parseSuccess = input.parseResult as ImportParseSuccess;
    const summary = summarizeParseSuccess(parseSuccess);
    const { statements, rowsInserted, issuesInserted, hasError } =
      buildParsedRowStatements(
        userId,
        batchId,
        parseSuccess,
        updatedAt,
        input.expectedVersion,
      );

    const batchStatus: ImportBatchStatus = hasError ? "invalid" : "parsed";
    const failureCategory = hasError ? "validation_error" : null;
    const failureDetail = hasError
      ? toJson({
          errorCount: summary.errorCount,
          warningCount: summary.warningCount,
          infoCount: summary.infoCount,
          totalRows: parseSuccess.summary.totalRows,
        })
      : null;

    const closing: SqlStatement = {
      sql: `
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
        WHERE id = ? AND user_id = ? AND version = ? AND status = 'uploaded'
        RETURNING
          id, user_id, target_portfolio_id, parser_format, parser_version,
          filename, byte_size, file_sha256, status, total_rows, blank_rows,
          definition_rows, transaction_rows, unsupported_rows, duplicate_rows,
          error_count, warning_count, info_count, commit_idempotency_key,
          reversal_idempotency_key, supersedes_batch_id, failure_category,
          failure_detail, created_at, updated_at, parsed_at, committed_at,
          reversed_at, version
      `,
      params: [
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
    };

    const outcome = await runAtomicPersist(client, statements, closing);
    if (!outcome.ok) {
      return { ok: false, reason: "atomic_failure" };
    }
    const row = outcome.batchRow;
    if (!row) {
      return await resolveMutationFailure(client, userId, batchId);
    }

    return {
      ok: true,
      batch: createBatchRecord(row),
      rowsInserted,
      issuesInserted,
    };
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
      // A single `UPDATE ... RETURNING` statement is already atomic (D1 and
      // SQLite both auto-commit one statement), so this needs no `batch()`
      // wrapper. The pre-check reads below are read-only early exits: the
      // `WHERE ... version = ?` guard on the write re-verifies the same
      // precondition at write time, so a stale read cannot cause an invalid
      // transition (any state change bumps `version`).
      const current = await client.get<{
        id: string;
        status: ImportBatchStatus;
        version: number;
      }>(
        "SELECT id, status, version FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1",
        [batchId, userId],
      );

      if (!current) {
        return { ok: false, reason: "not_found" };
      }

      if (current.version !== input.expectedVersion) {
        return { ok: false, reason: "version_conflict" };
      }

      if (!isValidTransition(current.status, input.nextStatus)) {
        return { ok: false, reason: "invalid_transition" };
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
        return await resolveMutationFailure(client, userId, batchId);
      }

      return {
        ok: true,
        batch: createBatchRecord(updatedRows[0] ?? {}),
      };
    },

    async get(
      userId: string,
      batchId: string,
    ): Promise<ImportBatchRecord | null> {
      return await loadBatch(userId, batchId);
    },

    async listBatches(
      userId: string,
      limit = IMPORT_HISTORY_LIMITS.defaultBatchLimit,
    ): Promise<ImportBatchRecord[]> {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > IMPORT_HISTORY_LIMITS.maxBatchLimit
      ) {
        throw new Error("invalid_import_history_limit");
      }
      const rows = await client.all<Record<string, unknown>>(
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
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        [userId, limit],
      );
      return rows.map((row) => createBatchRecord(row));
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

    async listRowsPage(
      userId: string,
      batchId: string,
      offset = 0,
      limit = IMPORT_HISTORY_LIMITS.detailPageSize,
    ): Promise<ImportHistoryPage<ImportRowRecord>> {
      validateHistoryPage(offset, limit);
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
          LIMIT ? OFFSET ?
        `,
        [userId, batchId, limit + 1, offset],
      );
      return historyPage(
        rows.map((row) => createRowRecord(row)),
        offset,
        limit,
      );
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

    async listIssuesPage(
      userId: string,
      batchId: string,
      offset = 0,
      limit = IMPORT_HISTORY_LIMITS.detailPageSize,
    ): Promise<ImportHistoryPage<ImportIssueRecord>> {
      validateHistoryPage(offset, limit);
      const rows = await client.all<Record<string, unknown>>(
        `
          SELECT
            id, user_id, batch_id, row_id, physical_row_number, field, severity,
            code, message, suggested_resolution_type, resolved_value,
            resolved_by_user_id, resolved_at, created_at, updated_at, version
          FROM import_issues
          WHERE user_id = ? AND batch_id = ?
          ORDER BY physical_row_number ASC, row_id ASC, id ASC
          LIMIT ? OFFSET ?
        `,
        [userId, batchId, limit + 1, offset],
      );
      return historyPage(
        rows.map((row) => createIssueRecord(row)),
        offset,
        limit,
      );
    },

    async getCommitProgress(
      userId: string,
      batchId: string,
    ): Promise<ImportCommitProgressRecord | null> {
      const row = await client.get<Record<string, unknown>>(
        `
          SELECT b.commit_high_water_row, b.commit_idempotency_key,
            COALESCE(SUM(CASE WHEN r.commit_status = 'committed' THEN 1 ELSE 0 END), 0) AS committed_rows,
            COALESCE(SUM(CASE WHEN r.commit_status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped_rows,
            COALESCE(SUM(CASE WHEN r.commit_status = 'staged' THEN 1 ELSE 0 END), 0) AS remaining_rows
          FROM import_batches b
          LEFT JOIN import_rows r
            ON r.user_id = b.user_id AND r.batch_id = b.id
          WHERE b.id = ? AND b.user_id = ?
          GROUP BY b.id, b.commit_high_water_row, b.commit_idempotency_key
        `,
        [batchId, userId],
      );
      return row
        ? {
            highWaterRow: Number(row.commit_high_water_row),
            idempotencyKey:
              row.commit_idempotency_key === null
                ? null
                : String(row.commit_idempotency_key),
            committedRows: Number(row.committed_rows),
            skippedRows: Number(row.skipped_rows),
            remainingRows: Number(row.remaining_rows),
          }
        : null;
    },
  };
}
