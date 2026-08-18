import type {
  ImportPreviewExistingDividendEntry,
  ImportPreviewPortfolio,
  ImportPreviewSecurityCandidate,
  ImportReconciliationPreview,
} from "../domain/imports/reconciliation.ts";
import { buildImportReview } from "../domain/imports/review.ts";
import type { ImportReviewMapping } from "../domain/imports/review.ts";
import {
  deriveSharesightSecuritiesSummary,
  type SharesightSecuritySummaryEntry,
} from "../domain/imports/security-summary.ts";
import { SHARESIGHT_SYNC_PARSER_FORMAT } from "../domain/sharesight-sync/index.ts";
import type {
  ImportBatchRecord,
  ImportIssueRecord,
  ImportRowRecord,
} from "../db/repositories/import-staging.ts";

export type ImportReviewPreview = {
  batch: Pick<
    ImportBatchRecord,
    | "id"
    | "filename"
    | "status"
    | "version"
    | "targetPortfolioId"
    // BRK-009C: the review UI needs to know a batch's parser format to
    // decide whether to render the "Review securities" section at all --
    // CSV (`strict-versioned-csv`) batches never get one (unchanged UI).
    | "parserFormat"
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
  // IMP-009: `securities.id` values among this batch's resolved candidates
  // that are owner-attested and NOT YET provider-verified (no active
  // verified `security_provider_mappings` row) -- the queryable
  // absence-of-mapping provenance signal the review UI reads to render the
  // "Owner-attested identity; market data unavailable until
  // provider-verified" state label. See `db/repositories/security-attestation.ts`'s
  // `listAttestedSecurityIds`. Optional on input (defaults to empty) so
  // every pre-existing caller of this function -- test fixtures included --
  // keeps compiling unchanged; always present on output.
  attestedSecurityIds: readonly string[];
  // BRK-009C: the pre-acceptance "Review securities" table's data, one
  // entry per DISTINCT security this `sharesight_sync` batch's rows
  // reference. Always `[]` for a `strict-versioned-csv` batch (unchanged
  // UI, per the Orchestrator ruling) -- see `deriveSharesightSecuritiesSummary`
  // for the derivation and its own header comment for why "conflict" and
  // "unresolved" are both genuine, distinct states.
  securities: readonly SharesightSecuritySummaryEntry[];
  // UI-013 review round B1 (BLOCKING): the review's committed/reversed
  // status line must report actual LEDGER EFFECTS, never reconciliation
  // INTENT (`preview.counts.transactionCreates`/`dividendCreates` describe
  // what a commit WOULD create from the current preview, not what a past
  // commit actually did -- a re-sync that overlaps an already-committed
  // batch can show a materially different preview count than what was
  // actually committed). Derived straight from `input.rows`' own
  // `commitStatus`/`excludedByOwnerAt` -- the same authoritative source
  // `db/repositories/import-commit.ts`'s `summary()` and
  // `import-staging.ts`'s `getCommitProgress()` read, just computed here in
  // JS over rows this function already received (no extra query). Accurate
  // for any batch status: all zero pre-commit, live-accurate mid-`committing`,
  // and a stable historical fact once `committed`/`reversed` (reversal does
  // not rewrite `import_rows.commit_status` -- ledger facts are immutable).
  commitProgress: {
    committedRows: number;
    skippedRows: number;
    excludedByOwnerRows: number;
    remainingRows: number;
  };
};

export function buildImportReviewPreview(input: {
  batch: ImportBatchRecord;
  rows: ImportRowRecord[];
  issues: ImportIssueRecord[];
  mappings: ImportReviewMapping[];
  portfolios: ImportPreviewPortfolio[];
  securityCandidates: ImportPreviewSecurityCandidate[];
  existingDividendEntries?: ImportPreviewExistingDividendEntry[];
  attestedSecurityIds?: readonly string[];
  // BRK-009C: pre-fetched inputs to `deriveSharesightSecuritiesSummary` --
  // this function stays a synchronous, DB-free builder (like every other
  // field here), so every caller queries these itself first. Optional/
  // defaulted so pre-BRK-009C callers/test fixtures keep compiling
  // unchanged; harmless no-ops for a CSV batch either way (the summary is
  // only ever derived for a `sharesight_sync` batch below).
  securityNames?: ReadonlyMap<string, string>;
  autoCreatedSecurityIds?: readonly string[];
  nameEditableSecurityIds?: readonly string[];
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
  // UI-013 review round B1: see the field's own doc comment above -- ledger
  // fact, not reconciliation intent.
  const commitProgress = {
    committedRows: input.rows.filter((row) => row.commitStatus === "committed")
      .length,
    skippedRows: input.rows.filter((row) => row.commitStatus === "skipped")
      .length,
    excludedByOwnerRows: input.rows.filter(
      (row) => row.commitStatus === "skipped" && row.excludedByOwnerAt !== null,
    ).length,
    remainingRows: input.rows.filter((row) => row.commitStatus === "staged")
      .length,
  };
  const securities: SharesightSecuritySummaryEntry[] =
    input.batch.parserFormat === SHARESIGHT_SYNC_PARSER_FORMAT
      ? deriveSharesightSecuritiesSummary({
          rows: input.rows,
          targetPortfolioId: input.batch.targetPortfolioId,
          securityCandidates: input.securityCandidates,
          conflictedRowIds: new Set(
            input.issues
              .filter(
                (issue) =>
                  issue.code === "SECURITY_RESOLUTION_CONFLICT" &&
                  issue.resolvedAt === null,
              )
              .map((issue) => issue.rowId)
              .filter((rowId): rowId is string => rowId !== null),
          ),
          securityNames: input.securityNames ?? new Map(),
          autoCreatedSecurityIds: new Set(input.autoCreatedSecurityIds ?? []),
          nameEditableSecurityIds: new Set(input.nameEditableSecurityIds ?? []),
        })
      : [];
  return {
    batch: {
      id: input.batch.id,
      filename: input.batch.filename,
      status: input.batch.status,
      version: input.batch.version,
      targetPortfolioId: input.batch.targetPortfolioId,
      parserFormat: input.batch.parserFormat,
    },
    previewVersion: built.previewVersion,
    preview: built.preview,
    issues: input.issues,
    mappings: input.mappings,
    securityCandidates: input.securityCandidates,
    excludedRows,
    attestedSecurityIds: input.attestedSecurityIds ?? [],
    securities,
    commitProgress,
  };
}
