import {
  createAuditRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  IMPORT_HISTORY_LIMITS,
  type AuditEventRecord,
  type ImportBatchRecord,
  type ImportCommitProgressRecord,
  type ImportIssueRecord,
  type ImportMappingDecision,
  type ImportRowRecord,
  type SqlClient,
} from "../db/repositories/index.ts";

export type ImportHistoryBatch = Pick<
  ImportBatchRecord,
  | "id"
  | "filename"
  | "status"
  | "version"
  | "targetPortfolioId"
  | "totalRows"
  | "transactionRows"
  | "errorCount"
  | "warningCount"
  | "createdAt"
  | "updatedAt"
  | "parsedAt"
  | "committedAt"
  | "reversedAt"
  | "supersedesBatchId"
>;

export type ImportHistoryRow = Pick<
  ImportRowRecord,
  | "id"
  | "physicalRowNumber"
  | "rowClass"
  | "originalFields"
  | "normalizedFields"
  | "validationStatus"
  | "commitStatus"
  | "commitTransactionId"
  | "excludedByOwnerAt"
  | "errorCount"
  | "warningCount"
  | "infoCount"
>;

export type ImportHistoryPagination = {
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  rowsHaveMore: boolean;
  issuesHaveMore: boolean;
  mappingsHaveMore: boolean;
  auditHaveMore: boolean;
};

export type ImportHistoryDetail = {
  batch: ImportHistoryBatch;
  successorBatchId: string | null;
  rows: ImportHistoryRow[];
  issues: ImportIssueRecord[];
  mappings: ImportMappingDecision[];
  audit: AuditEventRecord[];
  progress: ImportCommitProgressRecord;
  pagination: ImportHistoryPagination;
  // IMP-008: the WHOLE batch's excluded-row count -- unlike `rows` above,
  // never paginated, so "N rows excluded by owner" reads correctly no
  // matter which page of rows is currently loaded.
  excludedRowCount: number;
};

export type ImportHistoryContext = {
  client: SqlClient;
  userId: string;
};

export function batchHistory(batch: ImportBatchRecord): ImportHistoryBatch {
  return {
    id: batch.id,
    filename: batch.filename,
    status: batch.status,
    version: batch.version,
    targetPortfolioId: batch.targetPortfolioId,
    totalRows: batch.totalRows,
    transactionRows: batch.transactionRows,
    errorCount: batch.errorCount,
    warningCount: batch.warningCount,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    parsedAt: batch.parsedAt,
    committedAt: batch.committedAt,
    reversedAt: batch.reversedAt,
    supersedesBatchId: batch.supersedesBatchId,
  };
}

function rowHistory(row: ImportRowRecord): ImportHistoryRow {
  return {
    id: row.id,
    physicalRowNumber: row.physicalRowNumber,
    rowClass: row.rowClass,
    originalFields: row.originalFields,
    normalizedFields: row.normalizedFields,
    validationStatus: row.validationStatus,
    commitStatus: row.commitStatus,
    commitTransactionId: row.commitTransactionId,
    excludedByOwnerAt: row.excludedByOwnerAt,
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    infoCount: row.infoCount,
  };
}

export async function loadImportBatchHistoryWithContext(
  context: ImportHistoryContext,
  batchId: string,
  offset = 0,
  limit = IMPORT_HISTORY_LIMITS.detailPageSize,
): Promise<ImportHistoryDetail | null> {
  const staging = createOwnedImportStagingRepository(context.client);
  const batch = await staging.get(context.userId, batchId);
  if (!batch) return null;
  const successor = await context.client.get<{ id: string }>(
    `SELECT id FROM import_batches
      WHERE user_id = ? AND supersedes_batch_id = ?
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    [context.userId, batchId],
  );
  const [rows, issues, mappings, audit, progress, excludedRowCountRow] =
    await Promise.all([
      staging.listRowsPage(context.userId, batchId, offset, limit),
      staging.listIssuesPage(context.userId, batchId, offset, limit),
      createOwnedImportMappingDecisionRepository(context.client).listPage(
        context.userId,
        batchId,
        offset,
        limit,
      ),
      createAuditRepository(context.client).listForOwnerTargetPage(
        context.userId,
        "import_batch",
        batchId,
        offset,
        limit,
      ),
      staging.getCommitProgress(context.userId, batchId),
      // IMP-008: an unpaginated whole-batch count, not derived from `rows`
      // above (which is only the current page).
      context.client.get<{ excluded_row_count: number }>(
        `SELECT COUNT(*) AS excluded_row_count FROM import_rows
         WHERE user_id = ? AND batch_id = ? AND excluded_by_owner_at IS NOT NULL`,
        [context.userId, batchId],
      ),
    ]);
  if (!progress) return null;
  const hasMore =
    rows.hasMore || issues.hasMore || mappings.hasMore || audit.hasMore;
  return {
    batch: batchHistory(batch),
    successorBatchId: successor?.id ?? null,
    rows: rows.items.map(rowHistory),
    issues: issues.items,
    mappings: mappings.items,
    audit: audit.items,
    progress,
    excludedRowCount: Number(excludedRowCountRow?.excluded_row_count ?? 0),
    pagination: {
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      rowsHaveMore: rows.hasMore,
      issuesHaveMore: issues.hasMore,
      mappingsHaveMore: mappings.hasMore,
      auditHaveMore: audit.hasMore,
    },
  };
}
