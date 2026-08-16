import type {
  ImportPreviewExistingDividendEntry,
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
  // IMP-008: rows the owner has excluded from this batch's commit.
  // `preview` above silently omits these rows entirely (see
  // `buildImportReview`), so this is the ONLY place the review surfaces
  // them -- the "N rows excluded by owner" disclosure and the un-skip
  // affordance both read from here.
  excludedRows: ReadonlyArray<{
    id: string;
    physicalRowNumber: number;
    symbol: string | null;
  }>;
};

export function buildImportReviewPreview(input: {
  batch: ImportBatchRecord;
  rows: ImportRowRecord[];
  issues: ImportIssueRecord[];
  mappings: ImportReviewMapping[];
  portfolios: ImportPreviewPortfolio[];
  securityCandidates: ImportPreviewSecurityCandidate[];
  existingDividendEntries?: ImportPreviewExistingDividendEntry[];
}): ImportReviewPreview {
  const built = buildImportReview({
    batch: input.batch,
    rows: input.rows,
    issues: input.issues,
    mappings: input.mappings,
    portfolios: input.portfolios,
    securityCandidates: input.securityCandidates,
    existingDividendEntries: input.existingDividendEntries,
  });
  const excludedRows = input.rows
    .filter((row) => row.excludedByOwnerAt !== null)
    .map((row) => ({
      id: row.id,
      physicalRowNumber: row.physicalRowNumber,
      symbol: row.normalizedFields?.symbol ?? null,
    }))
    .sort((left, right) => left.physicalRowNumber - right.physicalRowNumber);
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
    excludedRows,
  };
}
