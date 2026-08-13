import { createHash } from "node:crypto";
import type { NormalizedImportRow } from "./strict-versioned-parser.ts";
import {
  createImportReconciliationPreview,
  type ImportPreviewMappingDecision,
  type ImportPreviewPortfolio,
  type ImportPreviewSecurityCandidate,
  type ImportReconciliationPreview,
  type ImportReconciliationRow,
} from "./reconciliation.ts";

export type ImportReviewBatch = Readonly<{
  id: string;
  filename: string;
  status: string;
  version: number;
  parserFormat: string;
  parserVersion: string;
  targetPortfolioId: string | null;
  errorCount: number;
}>;

export type ImportReviewRow = Readonly<{
  id: string;
  physicalRowNumber: number;
  rowClass: ImportReconciliationRow["rowClass"];
  normalizedFields: NormalizedImportRow | null;
  normalizedFingerprint: string | null;
  validationStatus: string;
  targetPortfolioId: string | null;
  targetPortfolioSecurityId: string | null;
  commitStatus: string;
  errorCount: number;
  version: number;
}>;

export type ImportReviewIssue = Readonly<{
  id: string;
  rowId: string | null;
  severity: "error" | "warning" | "info";
  code: string;
  resolvedAt: string | null;
  version: number;
}>;

export type ImportReviewMapping = ImportPreviewMappingDecision &
  Readonly<{
    normalizedSourceValue?: string;
    version: number;
  }>;

export type ImportReviewEvidence = Readonly<{
  batch: ImportReviewBatch;
  rows: readonly ImportReviewRow[];
  issues: readonly ImportReviewIssue[];
  mappings: readonly ImportReviewMapping[];
  portfolios: readonly ImportPreviewPortfolio[];
  securityCandidates: readonly ImportPreviewSecurityCandidate[];
}>;

export type BuiltImportReview = Readonly<{
  previewVersion: string;
  preview: ImportReconciliationPreview;
}>;

const EMPTY_NORMALIZED_ROW: NormalizedImportRow = {
  id: null,
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
  frankingPerShare: null,
};

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

export function buildImportReview(
  evidence: ImportReviewEvidence,
): BuiltImportReview {
  const rows: ImportReconciliationRow[] = evidence.rows.map((row) => ({
    id: row.id,
    physicalRowNumber: row.physicalRowNumber,
    rowClass: row.rowClass,
    normalized: row.normalizedFields ?? EMPTY_NORMALIZED_ROW,
    fingerprint: row.normalizedFingerprint ?? row.id,
    targetPortfolioId:
      row.targetPortfolioId ?? evidence.batch.targetPortfolioId,
    targetPortfolioSecurityId: row.targetPortfolioSecurityId,
  }));
  const preview = createImportReconciliationPreview({
    rows,
    portfolios: evidence.portfolios,
    securityCandidates: evidence.securityCandidates,
    decisions: evidence.mappings,
  });
  const canonicalEvidence = {
    batch: evidence.batch,
    rows: [...evidence.rows].sort(byId),
    issues: [...evidence.issues].sort(byId),
    mappings: [...evidence.mappings].sort((left, right) =>
      `${left.kind}\u0000${left.sourceKey}\u0000${left.scope}`.localeCompare(
        `${right.kind}\u0000${right.sourceKey}\u0000${right.scope}`,
      ),
    ),
    portfolios: [...evidence.portfolios].sort(byId),
    securityCandidates: [...evidence.securityCandidates].sort(byId),
    preview,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalEvidence))
    .digest("hex");
  return { previewVersion: `${evidence.batch.version}.${digest}`, preview };
}
