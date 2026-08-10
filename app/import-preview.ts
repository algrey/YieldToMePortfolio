import type {
  ImportPreviewPortfolio,
  ImportPreviewSecurityCandidate,
  ImportReconciliationPreview,
} from "../domain/imports/reconciliation.ts";
import { buildImportReview } from "../domain/imports/review.ts";
import type { ImportReviewMapping } from "../domain/imports/review.ts";
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
  mappings: ImportReviewMapping[];
  // All of the owner's portfolio-security candidates (resolved and
  // unresolved), so the review UI can offer "map to an existing resolved
  // security" as a target distinct from `preview.unresolvedCandidates`
  // (which only lists candidates still awaiting resolution).
  securityCandidates: ImportPreviewSecurityCandidate[];
};

export function buildImportReviewPreview(input: {
  batch: ImportBatchRecord;
  rows: ImportRowRecord[];
  issues: ImportIssueRecord[];
  mappings: ImportReviewMapping[];
  portfolios: ImportPreviewPortfolio[];
  securityCandidates: ImportPreviewSecurityCandidate[];
}): ImportReviewPreview {
  const built = buildImportReview({
    batch: input.batch,
    rows: input.rows,
    issues: input.issues,
    mappings: input.mappings,
    portfolios: input.portfolios,
    securityCandidates: input.securityCandidates,
  });
  return {
    batch: {
      id: input.batch.id,
      filename: input.batch.filename,
      status: input.batch.status,
      version: input.batch.version,
      targetPortfolioId: input.batch.targetPortfolioId,
    },
    previewVersion: built.previewVersion,
    preview: built.preview,
    issues: input.issues,
    mappings: input.mappings,
    securityCandidates: input.securityCandidates,
  };
}
