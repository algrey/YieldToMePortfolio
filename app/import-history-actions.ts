import {
  createAuditRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  type AuditEventRecord,
  type ImportBatchRecord,
  type ImportIssueRecord,
  type ImportMappingDecision,
  type ImportRowRecord,
} from "../db/repositories/index.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";

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

export type ImportHistoryDetail = {
  batch: ImportHistoryBatch;
  rows: ImportHistoryRow[];
  issues: ImportIssueRecord[];
  mappings: ImportMappingDecision[];
  audit: AuditEventRecord[];
};

type ImportHistoryFailure = {
  ok: false;
  status: 401 | 404 | 503;
  message: string;
};

export type ImportHistoryListResult =
  { ok: true; history: ImportHistoryBatch[] } | ImportHistoryFailure;

export type ImportHistoryDetailResult =
  { ok: true; detail: ImportHistoryDetail } | ImportHistoryFailure;

function historyContextFailure(context: {
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
}): ImportHistoryFailure {
  return {
    ok: false,
    status: context.status === 401 ? 401 : context.status === 404 ? 404 : 503,
    message: context.message,
  };
}

function batchHistory(batch: ImportBatchRecord): ImportHistoryBatch {
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

export async function loadImportHistoryAction(): Promise<ImportHistoryListResult> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return historyContextFailure(context);
  try {
    const batches = await createOwnedImportStagingRepository(
      context.client,
    ).listBatches(context.userId);
    return { ok: true, history: batches.map(batchHistory) };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Import history is temporarily unavailable.",
    };
  }
}

export async function loadImportBatchHistoryAction(
  batchId: string,
): Promise<ImportHistoryDetailResult> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return historyContextFailure(context);
  try {
    const staging = createOwnedImportStagingRepository(context.client);
    const batch = await staging.get(context.userId, batchId);
    if (!batch) {
      return { ok: false, status: 404, message: "Import batch not found." };
    }
    const [rows, issues, mappings, audit] = await Promise.all([
      staging.listRows(context.userId, batchId),
      staging.listIssues(context.userId, batchId),
      createOwnedImportMappingDecisionRepository(context.client).list(
        context.userId,
        batchId,
      ),
      createAuditRepository(context.client).listForOwnerTarget(
        context.userId,
        "import_batch",
        batchId,
      ),
    ]);
    return {
      ok: true,
      detail: {
        batch: batchHistory(batch),
        rows: rows.map(rowHistory),
        issues,
        mappings,
        audit,
      },
    };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Import batch history is temporarily unavailable.",
    };
  }
}
