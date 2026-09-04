import { createHash } from "node:crypto";
import type { NormalizedImportRow } from "./strict-versioned-parser.ts";
import {
  createImportReconciliationPreview,
  type ImportPreviewDividendReconciliationCandidate,
  type ImportPreviewExistingDividendEntry,
  type ImportPreviewExistingTradeEntry,
  type ImportPreviewMappingDecision,
  type ImportPreviewPortfolio,
  type ImportPreviewSecurityCandidate,
  type ImportReconciliationPreview,
  type ImportReconciliationRow,
} from "./reconciliation.ts";
import type {
  CommittedDividendValues,
  CommittedTradeValues,
} from "./committed-value-comparison.ts";

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
  // IMP-008: NULL when the owner has not excluded this row. A non-null
  // value removes the row from reconciliation entirely (see
  // `buildImportReview` below) -- it generates no issue, contributes to no
  // count, and can never block or satisfy readiness -- while still being
  // part of the canonical hashed evidence, so excluding/un-excluding a row
  // always changes `previewVersion`.
  excludedByOwnerAt: string | null;
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
  // DIV-004: existing owner-typed dividend facts, for the preview-time
  // near-duplicate warning. Optional/defaulted to empty so every existing
  // caller/test keeps working unchanged.
  existingDividendEntries?: readonly ImportPreviewExistingDividendEntry[];
  // BUG-013: mirrors `existingTradeEntriesUnavailable` below -- see this
  // module's `hashedPreview` comment for why it is excluded from
  // `previewVersion`.
  existingDividendEntriesUnavailable?: boolean;
  // BUG-011: existing posted buy/sell transactions, for the preview-time
  // cross-route duplicate-trade warning -- same optional/absent-tolerant
  // scoping as `existingDividendEntries` above (see this module's
  // `hashedPreview` comment for why it is excluded from `previewVersion`).
  existingTradeEntries?: readonly ImportPreviewExistingTradeEntry[];
  // BUG-011 review round F2: mirrors `existingTradeEntries` -- true when the
  // caller's own comparison-set cap was hit, so the check above was not run
  // this time (see `ImportReconciliationInput.existingTradeEntriesUnavailable`'s
  // doc comment). Same optional/absent-tolerant scoping and hash exclusion.
  existingTradeEntriesUnavailable?: boolean;
  // DIV-016 part C: existing manual dividend rows eligible for
  // reconciliation, for the preview-only `DIVIDEND_RECONCILIATION_PROPOSED`/
  // `_AMBIGUOUS` disclosure -- same optional/absent-tolerant scoping as
  // `existingDividendEntries` above (see this module's `hashedPreview`
  // comment for why both are excluded from `previewVersion`).
  reconciliationCandidates?: readonly ImportPreviewDividendReconciliationCandidate[];
  // DIV-016 part C, review round 1 B1 (BLOCKING): `${portfolioId}::
  // ${sourceReference}` keys already committed to `dividend_manual_records`
  // from a prior import -- see `ImportReconciliationInput`'s own doc
  // comment for what this excludes from the matching pool and why. BUG-013
  // review round: also now used to suppress a guaranteed-noise dividend
  // advisory warning -- see that type's own updated doc comment.
  existingDividendSourceReferences?: ReadonlySet<string>;
  // BUG-013 review round: the trade analog, used to suppress
  // `TRADE_NEAR_EXISTING_ENTRY` for a row already bound for an identical
  // commit-time exact-`source_reference` skip -- see
  // `ImportReconciliationInput.existingTradeSourceReferences`'s doc comment.
  existingTradeSourceReferences?: ReadonlySet<string>;
  // BRK-019 slice 1: see `ImportReconciliationInput.committedTradeValues`/
  // `.committedDividendValues`'s doc comments -- same page-only-supplied,
  // hash-excluded scoping as every other field above (see `hashedPreview`
  // below).
  committedTradeValues?: ReadonlyMap<string, CommittedTradeValues>;
  committedDividendValues?: ReadonlyMap<string, CommittedDividendValues>;
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
  // IMP-008: an owner-excluded row is dropped BEFORE reconciliation ever
  // sees it -- it generates no issue, is never an unresolved candidate, and
  // contributes to no count, so readiness depends only on non-excluded
  // rows. It remains part of `evidence.rows` for the hash below (see
  // `ImportReviewRow`'s doc comment), so exclude/un-exclude still changes
  // `previewVersion`.
  const rows: ImportReconciliationRow[] = evidence.rows
    .filter((row) => row.excludedByOwnerAt === null)
    .map((row) => ({
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
    existingDividendEntries: evidence.existingDividendEntries,
    existingDividendEntriesUnavailable:
      evidence.existingDividendEntriesUnavailable,
    existingTradeEntries: evidence.existingTradeEntries,
    existingTradeEntriesUnavailable: evidence.existingTradeEntriesUnavailable,
    reconciliationCandidates: evidence.reconciliationCandidates,
    existingDividendSourceReferences: evidence.existingDividendSourceReferences,
    existingTradeSourceReferences: evidence.existingTradeSourceReferences,
    committedTradeValues: evidence.committedTradeValues,
    committedDividendValues: evidence.committedDividendValues,
  });
  // DIV-004 (Orchestrator ruling, review round 1 BLOCKING B1 fix):
  // `DIVIDEND_NEAR_EXISTING_ENTRY` is advisory DISPLAY evidence only -- it
  // depends on `evidence.existingDividendEntries`, which only the page/
  // refresh preview path (`app/import-actions.ts`'s `loadReview`) supplies
  // today; the ready-service, security-verification-service, and
  // import-commit revalidation paths call `buildImportReview` without it
  // (the warning never gates readiness or commit, so they have no reason
  // to supply it). If the warning's presence/absence changed
  // `previewVersion`, those paths would compute a DIFFERENT hash than the
  // one the page rendered and sent back as `expectedPreviewVersion`,
  // permanently 409ing an affected batch's ready/commit with no recovery
  // path (reviewer repro, round 1). Excluded from the hash input by
  // construction -- via the `hashedPreview` filter below -- so
  // `previewVersion` is IDENTICAL whether or not this warning is present;
  // the full, un-filtered `preview` (including the warning) is still what
  // callers get back for rendering. A manual record added in another tab
  // therefore does not invalidate an already-open preview's version --
  // intended, since the warning is advisory, not a fact that changes what
  // would actually commit.
  //
  // BUG-011: `TRADE_NEAR_EXISTING_ENTRY` follows the IDENTICAL rule for the
  // IDENTICAL reason as `DIVIDEND_NEAR_EXISTING_ENTRY` above --
  // `evidence.existingTradeEntries` is likewise only supplied by the page/
  // refresh preview path, so this is advisory DISPLAY evidence only; the
  // ready-service, security-verification-service, and import-commit
  // revalidation paths call `buildImportReview` without it and must still
  // compute the identical `previewVersion`. `TRADE_DUPLICATE_CHECK_UNAVAILABLE`
  // (review round F2) is excluded for the same reason: it too depends on a
  // page-only-supplied signal (`evidence.existingTradeEntriesUnavailable`).
  //
  // BUG-013: `DIVIDEND_MATCHES_EXISTING_ENTRY`/`DIVIDEND_DUPLICATE_CHECK_
  // UNAVAILABLE` follow the IDENTICAL rule for the IDENTICAL reason as their
  // trade-side counterparts just above -- both depend on page-only-supplied
  // signals (`evidence.existingDividendEntries`/
  // `evidence.existingDividendEntriesUnavailable`).
  //
  // DIV-016 part C: `DIVIDEND_RECONCILIATION_PROPOSED`/`_AMBIGUOUS`/
  // `_ALREADY_IMPORTED_MANUAL_DUPLICATE` and `proposedReconciliations`
  // follow the IDENTICAL rule for the IDENTICAL reason --
  // `evidence.reconciliationCandidates`/`existingDividendSourceReferences`
  // are likewise only supplied by the page/refresh preview path, so this is
  // advisory DISPLAY evidence only. The ACTUAL, commit-consequential
  // reconciliation decision is computed independently and authoritatively
  // at commit time, straight from live database state, by
  // `db/repositories/import-commit.ts`'s `revalidate()` -- deliberately NOT
  // sourced from this preview struct -- so omitting these fields here never
  // changes what a commit actually does, only what the owner sees disclosed
  // before approving it.
  //
  // F1 (review round 1 follow-up, disclosed asymmetry): because
  // `revalidate()` is the sole authority at commit time and queries live
  // state fresh on every call, a manual row created AFTER this preview was
  // last shown CAN still be reconciled at commit -- correctly, atomically,
  // batch-attributably, audited, and reversibly -- without ever having
  // appeared here as `DIVIDEND_RECONCILIATION_PROPOSED`. The preview is a
  // best-effort, point-in-time disclosure of what commit is LIKELY to do,
  // not a contract of exactly what it will do; the reverse case (a manual
  // row deleted/edited after preview) is symmetric and equally expected.
  //
  // BUG-014: `DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE` follows
  // the IDENTICAL rule as `DIVIDEND_RECONCILIATION_PROPOSED` et al. just
  // above -- it too is derived from the page-only-supplied
  // `evidence.reconciliationCandidates`, so it is excluded here for the
  // same reason. `DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE` is
  // deliberately NOT in this list: it is derived purely from
  // `evidence.rows`, which every caller (ready-service,
  // security-verification-service, commit revalidation, and the page/
  // refresh preview path) supplies identically, so it is exactly as
  // hash-stable across callers as e.g. `OVERSELL`/`FX_RATE_INCOMPLETE`.
  const hashedPreview: ImportReconciliationPreview = {
    ...preview,
    proposedReconciliations: [],
    issues: preview.issues.filter(
      (issue) =>
        issue.code !== "DIVIDEND_NEAR_EXISTING_ENTRY" &&
        issue.code !== "TRADE_NEAR_EXISTING_ENTRY" &&
        issue.code !== "TRADE_DUPLICATE_CHECK_UNAVAILABLE" &&
        issue.code !== "DIVIDEND_MATCHES_EXISTING_ENTRY" &&
        issue.code !== "DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE" &&
        issue.code !== "DIVIDEND_RECONCILIATION_PROPOSED" &&
        issue.code !== "DIVIDEND_RECONCILIATION_AMBIGUOUS" &&
        issue.code !== "DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE" &&
        issue.code !== "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE" &&
        // BRK-019 slice 1: `ROW_DIFFERS_FROM_COMMITTED_RECORD` depends on
        // `evidence.committedTradeValues`/`.committedDividendValues`/
        // `.existingDividendEntries` -- like every other code excluded
        // above, these are supplied ONLY by the page/refresh preview path
        // (`app/import-actions.ts`'s `loadReview`), never by ready-service,
        // security-verification-service, or commit's own revalidation, so
        // this issue must not change `previewVersion` or those callers
        // would compute a different hash than the page rendered. The
        // OWNER-VISIBLE blocking behaviour is unaffected -- `preview.ready`
        // (the un-hashed struct) still reflects it wherever this evidence
        // IS supplied; `db/repositories/import-commit.ts`'s own
        // independent, live commit-time check (this task) is the
        // authoritative backstop that never depends on this hash.
        issue.code !== "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ),
  };
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
    preview: hashedPreview,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalEvidence))
    .digest("hex");
  return { previewVersion: `${evidence.batch.version}.${digest}`, preview };
}
