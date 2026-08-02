import type {
  ImportPreviewMappingDecision,
  ImportPreviewPortfolio,
  ImportPreviewSecurityCandidate,
  ImportReconciliationPreview,
  ImportReconciliationRow,
} from "../domain/imports/reconciliation.ts";
import { createImportReconciliationPreview } from "../domain/imports/reconciliation.ts";
import type {
  ImportBatchRecord,
  ImportIssueRecord,
  ImportRowRecord,
} from "../db/repositories/import-staging.ts";

export type ImportReviewPreview = {
  batch: Pick<
    ImportBatchRecord,
    "id" | "filename" | "status" | "version" | "targetPortfolioId"
  >;
  previewVersion: string;
  preview: ImportReconciliationPreview;
  issues: ImportIssueRecord[];
  mappings: ImportPreviewMappingDecision[];
};

function rowForReview(
  row: ImportRowRecord,
  targetPortfolioId: string | null,
): ImportReconciliationRow {
  return {
    id: row.id,
    physicalRowNumber: row.physicalRowNumber,
    rowClass: row.rowClass,
    normalized: row.normalizedFields ?? {
      id: row.id,
      symbol: null,
      name: null,
      displaySymbol: null,
      exchange: null,
      portfolio: null,
      currency: null,
      sharesOwned: null,
      costPerShare: null,
      commission: null,
      transactionDate: null,
      transactionTime: null,
      purchaseExchangeRate: null,
      type: null,
      accounting: null,
      accountingExecutionIds: null,
      notes: null,
      tradeAtUtc: null,
      localTradeDate: null,
      cashEvent: null,
    },
    fingerprint: row.normalizedFingerprint ?? row.id,
    targetPortfolioId,
  };
}

export function buildImportReviewPreview(input: {
  batch: ImportBatchRecord;
  rows: ImportRowRecord[];
  issues: ImportIssueRecord[];
  mappings: ImportPreviewMappingDecision[];
  portfolios: ImportPreviewPortfolio[];
  securityCandidates: ImportPreviewSecurityCandidate[];
}): ImportReviewPreview {
  const rows = input.rows.map((row) =>
    rowForReview(row, input.batch.targetPortfolioId),
  );
  const preview = createImportReconciliationPreview({
    rows,
    portfolios: input.portfolios,
    securityCandidates: input.securityCandidates,
    decisions: input.mappings,
  });
  const decisionVersion = input.mappings.reduce(
    (highest, decision) =>
      Math.max(highest, (decision as { version?: number }).version ?? 0),
    0,
  );
  return {
    batch: {
      id: input.batch.id,
      filename: input.batch.filename,
      status: input.batch.status,
      version: input.batch.version,
      targetPortfolioId: input.batch.targetPortfolioId,
    },
    previewVersion: `${input.batch.version}.${decisionVersion}`,
    preview,
    issues: input.issues,
    mappings: input.mappings,
  };
}
