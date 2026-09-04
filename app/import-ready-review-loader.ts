import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  listAttestedSecurityIds,
  listAutoCreatedSecurityIds,
  listNameEditableSecurityIds,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview.ts";
import {
  safeComputeDividendCashTotal,
  type ImportPreviewExistingDividendEntry,
  type ImportPreviewSecurityCandidate,
} from "../domain/imports/reconciliation.ts";
import {
  capExistingDividendRows,
  MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
} from "./import-dividend-duplicate-check.ts";
import { existingManualDividendRowsQuery } from "./import-review-queries.ts";

export type ImportReadyReviewLoadFailure = {
  ok: false;
  status: 404;
  message: string;
};

// CORRECTION ROUND (B1b, BLOCKING): a standalone copy of `loadReview`
// (app/import-actions.ts) so this module only depends on
// `db/repositories/index.ts` and `import-preview.ts` -- never
// `./portfolio-actions.ts` (which pulls in `next/headers` and the D1 binding
// resolver). Extracted from what used to be THREE independently-drifting
// hand-rolled copies of this same function (`app/import-ready-service.ts`,
// `app/import-accept-service.ts`) into this ONE shared module, which both
// now import -- exactly the "share the loader, never a second hand-rolled
// copy" this task's own doc comments elsewhere insist on for
// `app/import-review-queries.ts`'s query builders. The two callers MUST
// compute byte-identical `previewVersion`s for the SAME batch: `app/import-
// accept-service.ts`'s atomic Accept flow calls this loader once to obtain
// `expectedPreviewVersion`, then immediately calls
// `markImportReadyWithContext` (`import-ready-service.ts`), which calls this
// SAME loader again internally and compares hashes -- any divergence between
// two independently-drifting copies falsely 409s every Accept as "stale,
// reload" (reviewer-discovered while fixing B1b: an early version of this
// fix updated ONLY `import-ready-service.ts`, leaving `import-accept-
// service.ts`'s own blind copy out of step the moment ANY dividend near-match
// evidence changed `preview.ready` -- see this file's own git history).
//
// Deliberately stays evidence-BLIND to `committedTradeValues`/
// `committedDividendValues`/`existingDividendSourceReferences`/
// `existingTradeSourceReferences` -- that omission is INTENTIONAL (see
// `domain/imports/review.ts`'s own comment on why `ROW_DIFFERS_FROM_
// COMMITTED_RECORD` is excluded from `previewVersion` hashing): the EXACT-
// `source_reference`-match correction case relies on this path staying blind
// to those four inputs so a batch's OTHER, genuinely-clean rows can still
// reach `ready`/commit while `db/repositories/import-commit.ts`'s own
// independent, live fail-closed check silently skips just the corrected row
// -- this is the SAME "commits every other row, reports N needs a decision"
// behaviour `tests/brk-019.test.ts` establishes and relies on.
//
// What this loader DOES supply -- unlike its pre-correction-round ancestors
// -- is `existingDividendEntries` (with each entry's own `sourceReference`,
// so the DIV-004 near-match escalation can tell whether the near neighbour is
// itself Sharesight-sourced; see `ImportPreviewExistingDividendEntry.sourceReference`'s
// doc comment). Without it, neither `markImportReadyWithContext` nor
// `acceptImportWithContext` ever saw a paid-date-correction's near-match
// escalation at all, so `preview.ready` stayed `true` all the way to commit,
// which (before this task's commit-side fix) took the ordinary create path
// and double-wrote the distribution. Sourced from the SAME query builder
// (`app/import-review-queries.ts`'s `existingManualDividendRowsQuery`,
// PRF-015) the page uses. `dividend_receipts` (DIV-004's OTHER evidence
// source) is deliberately still omitted: a receipt never carries
// `source_reference`/a comparable cash total, so it can never feed this
// escalation, and this loader stays otherwise as cheap as its blind
// ancestors.
export async function loadImportReviewForReadyTransition(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | ImportReadyReviewLoadFailure> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  const manualDividendQuery = existingManualDividendRowsQuery(
    userId,
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1,
  );
  const [
    rows,
    issues,
    mappings,
    portfolios,
    candidateRows,
    existingManualRows,
  ] = await Promise.all([
    staging.listRows(userId, batchId),
    staging.listIssues(userId, batchId),
    createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
    createOwnedPortfolioRepository(client).list(userId),
    client.all<Record<string, unknown>>(
      `SELECT ps.id, ps.portfolio_id, ps.source_symbol, ps.source_exchange_alias,
        ps.source_currency_code, ps.security_id, s.canonical_name
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       WHERE ps.user_id = ?
       ORDER BY ps.source_symbol ASC, ps.id ASC`,
      [userId],
    ),
    client.all<Record<string, unknown>>(
      manualDividendQuery.sql,
      manualDividendQuery.params,
    ),
  ]);
  const securityCandidates: ImportPreviewSecurityCandidate[] =
    candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    }));
  const linkedSecurityIds = securityCandidates
    .map((candidate) => candidate.securityId)
    .filter((id): id is string => id !== null);
  // BRK-009C: `securities.canonical_name` for every linked candidate, read
  // from the SAME query above (widened by one LEFT JOIN column) -- feeds
  // the "Review securities" summary's Name column without a separate
  // round trip.
  const securityNames = new Map<string, string>();
  for (const row of candidateRows) {
    if (row.security_id !== null && row.canonical_name !== null) {
      securityNames.set(String(row.security_id), String(row.canonical_name));
    }
  }
  const cappedManualDividendRows = capExistingDividendRows(
    existingManualRows,
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
  );
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] =
    cappedManualDividendRows.unavailable
      ? []
      : cappedManualDividendRows.entries.map((row) => ({
          portfolioSecurityId: String(row.portfolio_security_id),
          paymentDate: String(row.payment_date),
          cashTotalDecimal: safeComputeDividendCashTotal({
            totalCashDecimal:
              row.total_cash_decimal === null
                ? null
                : String(row.total_cash_decimal),
            sharesDecimal:
              row.shares_decimal === null ? null : String(row.shares_decimal),
            dividendPerShareDecimal:
              row.dividend_per_share_decimal === null
                ? null
                : String(row.dividend_per_share_decimal),
          }),
          frankingTotalDecimal: safeComputeDividendCashTotal({
            totalCashDecimal:
              row.total_franking_decimal === null
                ? null
                : String(row.total_franking_decimal),
            sharesDecimal:
              row.shares_decimal === null ? null : String(row.shares_decimal),
            dividendPerShareDecimal:
              row.franking_credit_per_share_decimal === null
                ? null
                : String(row.franking_credit_per_share_decimal),
          }),
          currencyCode:
            row.currency_code === null ? null : String(row.currency_code),
          sourceReference:
            row.source_reference === null ? null : String(row.source_reference),
        }));
  const [attestedSecurityIds, autoCreatedSecurityIds, nameEditableSecurityIds] =
    await Promise.all([
      listAttestedSecurityIds(client, linkedSecurityIds),
      listAutoCreatedSecurityIds(client, linkedSecurityIds),
      listNameEditableSecurityIds(client, userId, linkedSecurityIds),
    ]);
  return buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates,
    existingDividendEntries,
    existingDividendEntriesUnavailable: cappedManualDividendRows.unavailable,
    attestedSecurityIds,
    securityNames,
    autoCreatedSecurityIds,
    nameEditableSecurityIds,
  });
}
