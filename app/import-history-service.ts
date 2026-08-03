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
  rows: ImportHistoryRow[];
  issues: ImportIssueRecord[];
  mappings: ImportMappingDecision[];
  audit: AuditEventRecord[];
  progress: ImportCommitProgressRecord;
  pagination: ImportHistoryPagination;
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
  const [rows, issues, mappings, audit, progress] = await Promise.all([
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
  ]);
  if (!progress) return null;
  const hasMore =
    rows.hasMore || issues.hasMore || mappings.hasMore || audit.hasMore;
  return {
    batch: batchHistory(batch),
    rows: rows.items.map(rowHistory),
    issues: issues.items,
    mappings: mappings.items,
    audit: audit.items,
    progress,
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
