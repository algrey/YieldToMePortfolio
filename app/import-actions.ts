import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  listAttestedSecurityIds,
  listAutoCreatedSecurityIds,
  listNameEditableSecurityIds,
  type ImportMappingConfidence,
  type ImportMappingKind,
  type ImportMappingScope,
} from "../db/repositories/index.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview";
import { markImportReadyWithContext } from "./import-ready-service.ts";
import {
  verifySecurityCandidateWithContext,
  type SecurityVerifyActionFailure,
  type SecurityVerifyActionSuccess,
} from "./security-verification-service.ts";
import { attestSecurityCandidateWithContext } from "./security-attestation-service.ts";
import { updateImportSecurityMetadataWithContext } from "./import-security-metadata-service.ts";
import {
  setImportRowExclusionWithContext,
  type ImportRowExclusionActionFailure,
  type ImportRowExclusionActionSuccess,
} from "./import-row-exclusion-service.ts";
import { classifyImportRows, DEFAULT_IMPORT_LIMITS } from "../domain/imports";
import {
  safeComputeDividendCashTotal,
  type ImportPreviewDividendReconciliationCandidate,
  type ImportPreviewExistingDividendEntry,
  type ImportPreviewExistingTradeEntry,
  type ImportPreviewPortfolio,
  type ImportPreviewSecurityCandidate,
} from "../domain/imports/reconciliation";
import {
  fileMetadataFromImportBody,
  MAX_IMPORT_UPLOAD_REQUEST_BYTES,
  rawRowsFromImportBody,
  readJsonBody,
  supersedesBatchIdFromImportBody,
  targetPortfolioIdFromImportBody,
} from "./import-request-body.ts";
import {
  capExistingTradeRows,
  MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
} from "./import-trade-duplicate-check.ts";
import {
  capExistingDividendRows,
  MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
} from "./import-dividend-duplicate-check.ts";
import { capSuppressionReferenceRows } from "./import-suppression-cap.ts";
import { emitStructuredLog } from "../domain/observability/index.ts";
import {
  existingDividendSourceReferenceRowsQuery,
  existingManualDividendRowsQuery,
  existingReceiptDividendRowsQuery,
  existingTradeRowsQuery,
  existingTradeSourceReferenceRowsQuery,
  portfolioSecurityCandidatesQuery,
} from "./import-review-queries.ts";

type ImportActionFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

export type ImportActionSuccess = { ok: true; review: ImportReviewPreview };

async function loadReview(
  client: Parameters<typeof createOwnedImportStagingRepository>[0],
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | ImportActionFailure> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  // PRF-015: query text for every one of these lives in
  // `./import-review-queries.ts`, imported by `tests/imp-004a.test.ts`'s
  // `pagePreview`/`currentPreviewVersion` mirrors too, so the two sides
  // cannot diverge -- see that module's doc comment for the full history.
  const candidatesQuery = portfolioSecurityCandidatesQuery(userId);
  const manualDividendQuery = existingManualDividendRowsQuery(
    userId,
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1,
  );
  const receiptDividendQuery = existingReceiptDividendRowsQuery(
    userId,
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1,
  );
  const dividendSourceReferenceQuery =
    existingDividendSourceReferenceRowsQuery(userId);
  const tradeSourceReferenceQuery = existingTradeSourceReferenceRowsQuery(
    userId,
    MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK + 1,
  );
  const tradeRowsQuery = existingTradeRowsQuery(
    userId,
    MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK + 1,
  );
  const [
    rows,
    issues,
    mappings,
    portfolios,
    candidateRows,
    existingManualRows,
    existingReceiptRows,
    reconciliationCandidateRows,
    existingSourceReferenceRows,
    existingTradeSourceReferenceRows,
    existingTradeRows,
  ] = await Promise.all([
    staging.listRows(userId, batchId),
    staging.listIssues(userId, batchId),
    createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
    createOwnedPortfolioRepository(client).list(userId),
    // PRF-015: query text lives in `./import-review-queries.ts` so
    // `tests/imp-004a.test.ts`'s mirror can import the SAME function -- see
    // that module's doc comment for the BRK-009C canonical_name history.
    client.all<Record<string, unknown>>(
      candidatesQuery.sql,
      candidatesQuery.params,
    ),
    // BUG-013: WIDENED from "owner-typed only" (`import_batch_id IS NULL`)
    // -- that filter was the confirmed root cause of a SILENT cross-route
    // dividend double-commit: both `existingDividendEntries` (this warning)
    // and DIV-016C's reconciliation candidates excluded EVERY import-
    // sourced dividend record, so a CSV-imported distribution was invisible
    // to the near-duplicate check when the SAME distribution later arrived
    // via Sharesight sync (or the reverse order) -- no skip, no warning, no
    // reconciliation candidate. Now includes every non-superseded
    // `dividend_manual_records` row regardless of route/batch, carrying the
    // amount/franking/currency columns `DIVIDEND_MATCHES_EXISTING_ENTRY`
    // (`domain/imports/reconciliation.ts`) needs. DIV-016C's OWN
    // reconciliation-candidates query below is DELIBERATELY left scoped to
    // `import_batch_id IS NULL` -- that is a distinct, correct business rule
    // (only a manually entered fact can be SUPERSEDED, per the DIV-016
    // owner ruling), not the same bug, and widening it would let an already-
    // imported row wrongly "supersede" another import.
    // DIV-016 part A: excludes a superseded (historical) row -- only the
    // CURRENT head of each lineage is "the" dividend on record; comparing
    // against a superseded ancestor's payment date would raise a spurious
    // near-duplicate warning against a fact the owner already corrected.
    // BUG-013: unlike a reversed TRADE (`ledger.reverse()` inserts a
    // compensating mirror row, still `status = 'posted'`, that BUG-011 had
    // to explicitly exclude), a reversed IMPORT BATCH's dividend rows are
    // hard-DELETEd by `db/repositories/import-reversal.ts`'s `finalize()`
    // (`dividend_manual_records` has no "reversed" status/mirror-row
    // concept -- DIV-001 treats it as an owner-mutable/deletable fact, not
    // an immutable ledger entry). A reversed dividend import therefore
    // leaves NO row here to warn against -- `superseded_by_record_id IS
    // NULL` above is the only exclusion this table needs.
    // PRF-015: query text moved to `./import-review-queries.ts`'s
    // `existingManualDividendRowsQuery` -- see that function's doc comment
    // for the BUG-013 widening/cap history.
    client.all<Record<string, unknown>>(
      manualDividendQuery.sql,
      manualDividendQuery.params,
    ),
    // PRF-015: query text moved to `./import-review-queries.ts`'s
    // `existingReceiptDividendRowsQuery` -- see that function's doc comment
    // for the BUG-013 scope/cap history.
    client.all<Record<string, unknown>>(
      receiptDividendQuery.sql,
      receiptDividendQuery.params,
    ),
    // DIV-016 part C: existing owner-typed, non-superseded manual dividend
    // records eligible to be matched and superseded by an incoming
    // Sharesight payout row -- see `ImportPreviewDividendReconciliationCandidate`'s
    // doc comment. Narrower than `existingManualRows` above (no receipts;
    // carries amounts): this is the advisory PREVIEW-only disclosure --
    // `db/repositories/import-commit.ts`'s `revalidate()` runs the
    // authoritative, live-DB-state equivalent independently at commit time.
    // BUG-014 correction round (follow-up): joins `portfolio_securities`
    // for a display label only (`display_symbol`, falling back to
    // `source_symbol` -- the same "always populated, sometimes owner-
    // resolved" pair `import-review.tsx` displays elsewhere) -- see
    // `ImportPreviewDividendReconciliationCandidate.securitySymbol`'s doc
    // comment. Never used for matching/identity; a missing membership row
    // (should not happen -- `portfolio_security_id` is a foreign key) just
    // leaves the label absent via the LEFT JOIN, never blocking the query.
    client.all<Record<string, unknown>>(
      `SELECT dmr.id AS id, dmr.portfolio_security_id AS portfolio_security_id,
              dmr.payment_date AS payment_date, dmr.shares_decimal AS shares_decimal,
              dmr.dividend_per_share_decimal AS dividend_per_share_decimal,
              dmr.total_cash_decimal AS total_cash_decimal,
              COALESCE(ps.display_symbol, ps.source_symbol) AS security_symbol
       FROM dividend_manual_records dmr
       LEFT JOIN portfolio_securities ps ON ps.id = dmr.portfolio_security_id
       WHERE dmr.user_id = ? AND dmr.import_batch_id IS NULL
         AND dmr.superseded_by_record_id IS NULL`,
      [userId],
    ),
    // DIV-016 part C, review round 1 B1 (BLOCKING): every dividend row
    // ALREADY imported (any prior batch) by this owner, keyed by the exact
    // `(portfolio_id, source_reference)` identity
    // `db/repositories/import-commit.ts`'s cross-batch idempotency check
    // uses -- a row whose own computed identity is already here can never
    // actually insert this commit, so it must never be offered a
    // `DIVIDEND_RECONCILIATION_PROPOSED` promise (see
    // `ImportReconciliationInput.existingDividendSourceReferences`'s doc
    // comment). PRF-015: query text moved to `./import-review-queries.ts`'s
    // `existingDividendSourceReferenceRowsQuery` -- see that function's doc
    // comment for the PRF-009 correction-round B1 history (this is a
    // COMPARISON set, deliberately unbounded, unlike the trade suppression
    // set below).
    client.all<Record<string, unknown>>(
      dividendSourceReferenceQuery.sql,
      dividendSourceReferenceQuery.params,
    ),
    // BUG-013 review round (ruling 1): the trade analog of the dividend
    // query above -- a pure SUPPRESSION set, unlike the comparison set
    // above, so it keeps a fail-open `LIMIT MAX + 1` cap. PRF-015: query
    // text moved to `./import-review-queries.ts`'s
    // `existingTradeSourceReferenceRowsQuery` -- see that function's doc
    // comment for the BUG-013/BUG-018 history.
    client.all<Record<string, unknown>>(
      tradeSourceReferenceQuery.sql,
      tradeSourceReferenceQuery.params,
    ),
    // BUG-011: every existing POSTED buy/sell transaction across the WHOLE
    // OWNER (any portfolio, any source route, any prior batch/import), for
    // the preview-time cross-route duplicate-trade warning -- see
    // `ImportPreviewExistingTradeEntry`'s doc comment for scope. PRF-015:
    // query text moved to `./import-review-queries.ts`'s
    // `existingTradeRowsQuery` -- see that function's doc comment for the
    // BUG-011 F1/F2 and PRF-009 fold-in (a) history.
    client.all<Record<string, unknown>>(
      tradeRowsQuery.sql,
      tradeRowsQuery.params,
    ),
  ]);
  const previewPortfolios: ImportPreviewPortfolio[] = portfolios.map(
    (item) => ({
      id: item.id,
      name: item.name,
      homeCurrencyCode: item.homeCurrencyCode,
      historyCompleteFrom: item.historyCompleteFrom,
    }),
  );
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
  // BUG-013: the cap/degrade DECISION is the same pure, directly-tested
  // function BUG-011 introduced, aliased for dividends -- see
  // `./import-dividend-duplicate-check.ts`'s doc comment.
  const cappedManualDividendRows = capExistingDividendRows(
    existingManualRows,
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
  );
  const cappedReceiptDividendRows = capExistingDividendRows(
    existingReceiptRows,
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
  );
  const existingDividendEntriesUnavailable =
    cappedManualDividendRows.unavailable ||
    cappedReceiptDividendRows.unavailable;
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] =
    existingDividendEntriesUnavailable
      ? []
      : [
          ...cappedManualDividendRows.entries.map((row) => ({
            portfolioSecurityId: String(row.portfolio_security_id),
            paymentDate: String(row.payment_date),
            // Review round (ruling 2): this row's own decimal columns are
            // now, for the first time, DB-sourced values reaching a
            // `parseDecimal` call in THIS file -- the pre-widening query
            // selected no decimal columns at all, so a corrupt/non-canonical
            // `shares_decimal`/`dividend_per_share_decimal` (or one exceeding
            // `parseDecimal`'s scale bound, which `dividends.ts`'s own write-
            // time `isDecimalString` does not check) is new exposure here.
            // `safeComputeDividendCashTotal` (exported from
            // `../domain/imports/reconciliation.ts`) never throws -- see its
            // doc comment.
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
            // BRK-019 slice 1: see `ImportPreviewExistingDividendEntry.sourceReference`'s
            // doc comment -- feeds the paid-date-correction escalation.
            sourceReference:
              row.source_reference === null
                ? null
                : String(row.source_reference),
          })),
          ...cappedReceiptDividendRows.entries.map((row) => ({
            portfolioSecurityId: String(row.portfolio_security_id),
            paymentDate: String(row.payment_date),
          })),
        ];
  const reconciliationCandidates: ImportPreviewDividendReconciliationCandidate[] =
    reconciliationCandidateRows.map((row) => ({
      id: String(row.id),
      portfolioSecurityId: String(row.portfolio_security_id),
      paymentDate: String(row.payment_date),
      totalCashDecimal:
        row.total_cash_decimal === null ? null : String(row.total_cash_decimal),
      sharesDecimal:
        row.shares_decimal === null ? null : String(row.shares_decimal),
      dividendPerShareDecimal:
        row.dividend_per_share_decimal === null
          ? null
          : String(row.dividend_per_share_decimal),
      securitySymbol:
        row.security_symbol === null ? null : String(row.security_symbol),
    }));
  // BUG-011 review round F2/F-a: the cap/degrade DECISION is a pure
  // function (`capExistingTradeRows`), unit-tested directly since this file
  // itself cannot be imported by the test runner -- see that module's doc
  // comment.
  const cappedTradeRows = capExistingTradeRows(
    existingTradeRows,
    MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
  );
  const existingTradeEntriesUnavailable = cappedTradeRows.unavailable;
  const existingTradeEntries: ImportPreviewExistingTradeEntry[] =
    cappedTradeRows.entries.map((row) => ({
      portfolioSecurityId: String(row.portfolio_security_id),
      type: String(row.type) as "buy" | "sell",
      tradeDate: String(row.local_trade_date),
      quantityDecimal: String(row.quantity_decimal),
      priceDecimal: String(row.unit_price_decimal),
    }));
  // PRF-009 correction round B1 (BLOCKING): NOT capped -- see the doc
  // comment on `existingSourceReferenceRows`'s own query above for why this
  // set is a COMPARISON set (DIV-016C), not a pure suppression set, and
  // therefore cannot fail open to empty on overflow.
  const existingDividendSourceReferences = new Set(
    existingSourceReferenceRows.map(
      (row) => `${String(row.portfolio_id)}::${String(row.source_reference)}`,
    ),
  );
  // BUG-013 review round (ruling 1): the trade analog, same key shape --
  // but unlike the dividend set above, this one IS a pure suppression set
  // (see its query's own doc comment) and keeps the fail-open cap.
  const cappedTradeSourceReferenceRows = capSuppressionReferenceRows(
    existingTradeSourceReferenceRows,
    MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
  );
  if (cappedTradeSourceReferenceRows.overflowed) {
    emitStructuredLog({
      level: "warn",
      event: "import.preview",
      action: "import.preview.trade_suppression_overflow",
      result: "failure",
      requestId: "import-preview-suppression-overflow",
      metadata: {
        batchId,
        rows: existingTradeSourceReferenceRows.length,
        max: MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
      },
    });
  }
  const existingTradeSourceReferences = new Set(
    cappedTradeSourceReferenceRows.rows.map(
      (row) => `${String(row.portfolio_id)}::${String(row.source_reference)}`,
    ),
  );
  // BRK-019 slice 1: value-bearing columns for the SAME rows the two
  // suppression/comparison sets above are keyed from (reusing those already
  // -loaded, already-capped/degraded result sets -- no extra query). Built
  // from `cappedTradeSourceReferenceRows.rows` (not the raw
  // `existingTradeSourceReferenceRows`) so an overflowed trade suppression
  // set degrades this map identically -- when the suppression set is empty,
  // `tradeAlreadyBoundForSkip` is false for every row and this map is never
  // consulted anyway, so degrading the two together is safe and simpler
  // than a second, independent overflow policy.
  const committedTradeValues = new Map(
    cappedTradeSourceReferenceRows.rows.map((row) => [
      `${String(row.portfolio_id)}::${String(row.source_reference)}`,
      {
        quantityDecimal:
          row.quantity_decimal === null ? null : String(row.quantity_decimal),
        priceDecimal:
          row.unit_price_decimal === null
            ? null
            : String(row.unit_price_decimal),
        feeAmountDecimal:
          row.fee_amount_decimal === null
            ? null
            : String(row.fee_amount_decimal),
        localTradeDate:
          row.local_trade_date === null ? null : String(row.local_trade_date),
        type: row.type === null ? null : String(row.type),
        currencyCode:
          row.currency_code === null ? null : String(row.currency_code),
      },
    ]),
  );
  // BRK-019 slice 1: the dividend analog, from the SAME (deliberately
  // uncapped -- see that query's own doc comment) comparison set
  // `existingDividendSourceReferences` above is keyed from.
  //
  // BRK-019 slice 1 CORRECTION ROUND (B2, BLOCKING): the committed side must
  // be derived via `safeComputeDividendCashTotal` over the row's three
  // amount-bearing columns, exactly like the incoming side always was --
  // reading `total_cash_decimal`/`total_franking_decimal` verbatim reports
  // `null` for a PER-SHARE-mode committed record (those two columns are
  // never populated in per-share mode; see `db/repositories/dividends.ts`),
  // which compared as "differs from a real amount" against an identical
  // per-share re-upload's own computed total -- a false
  // `ROW_DIFFERS_FROM_COMMITTED_RECORD`. `existingDividendSourceReferenceRowsQuery`
  // now also selects the three per-share columns for exactly this.
  const committedDividendValues = new Map(
    existingSourceReferenceRows.map((row) => [
      `${String(row.portfolio_id)}::${String(row.source_reference)}`,
      {
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
        totalFrankingDecimal: safeComputeDividendCashTotal({
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
        paymentDate:
          row.payment_date === null ? null : String(row.payment_date),
        fxRateToPortfolioDecimal:
          row.fx_rate_to_portfolio_decimal === null
            ? null
            : String(row.fx_rate_to_portfolio_decimal),
        currencyCode:
          row.currency_code === null ? null : String(row.currency_code),
      },
    ]),
  );
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
    portfolios: previewPortfolios,
    securityCandidates,
    existingDividendEntries,
    existingDividendEntriesUnavailable,
    existingTradeEntries,
    existingTradeEntriesUnavailable,
    reconciliationCandidates,
    existingDividendSourceReferences,
    existingTradeSourceReferences,
    committedTradeValues,
    committedDividendValues,
    attestedSecurityIds,
    securityNames,
    autoCreatedSecurityIds,
    nameEditableSecurityIds,
  });
}

// IMP-010B: the 17-column ledger CSV now parses in the BROWSER, the same
// way IMP-010A moved the price-CSV path's parsing there -- see
// `app/import-request-body.ts`'s header comment and
// `app/components/import-review.tsx`'s upload handlers, which import
// `splitStrictVersionedCsvRows` directly from
// `domain/imports/strict-versioned-parser.ts` (the single shared
// implementation) and upload the resulting `rows: string[][]` as JSON
// instead of the raw file. This action's remaining server-side work --
// `classifyImportRows` below -- is the sole, server-only classification
// authority: the browser never classifies (it only splits), so this is the
// ONE place the row grammar executes, once per upload, over the untrusted
// uploaded rows; it no longer reads a raw CSV body at all, so (per the
// investigation recorded in CSV_IMPORT_SPEC.md's IMP-010B section) nothing
// about this path is genuinely incompatible with the Cloudflare Workers
// free plan any more, matching the price-CSV path's own precedent -- there
// is no `assessCsvImportUploadStart`/`YIELDTOME_WORKERS_PLAN` gate here.
export async function createImportPreviewAction(
  request: Request,
): Promise<ImportActionSuccess | ImportActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readJsonBody(request, MAX_IMPORT_UPLOAD_REQUEST_BYTES);
  if (!read.ok) return read;
  try {
    const targetPortfolioId = targetPortfolioIdFromImportBody(read.body);
    const supersedesBatchId = supersedesBatchIdFromImportBody(read.body);
    const fileMetadata = fileMetadataFromImportBody(read.body);
    const rawRows = rawRowsFromImportBody(
      read.body,
      DEFAULT_IMPORT_LIMITS.maxRows,
    );
    // IMP-010B review round (fold 3): two genuinely different failure
    // reasons were previously conflated into one "Choose a CSV file and
    // portfolio" message -- a missing/blank `targetPortfolioId` is a real
    // "you forgot to pick a portfolio" UX state (the client's own `upload`/
    // `stageCorrectedSuccessor` handlers already guard this before ever
    // sending a request), while a malformed `fileMetadata`/`rawRows` is a
    // payload-SHAPE problem (a hostile or broken direct request, since the
    // real upload flow always sends a well-formed payload once a file is
    // picked) that has nothing to do with "choosing a file."
    if (!targetPortfolioId) {
      return {
        ok: false,
        status: 400,
        message: "Choose a target portfolio.",
      };
    }
    if (!fileMetadata || rawRows === null) {
      return {
        ok: false,
        status: 400,
        message: "The uploaded CSV payload was invalid or malformed.",
      };
    }
    const portfolio = await createOwnedPortfolioRepository(context.client).get(
      context.userId,
      targetPortfolioId,
    );
    if (!portfolio)
      return { ok: false, status: 404, message: "Portfolio not found." };
    const parseResult = await classifyImportRows(
      rawRows,
      DEFAULT_IMPORT_LIMITS,
      fileMetadata.fileSha256,
    );
    const parserVersion = parseResult.parserVersion;
    const started = await createOwnedImportStagingRepository(
      context.client,
    ).startUpload(context.userId, {
      targetPortfolioId,
      supersedesBatchId: supersedesBatchId || null,
      parserFormat: "strict-versioned-csv",
      parserVersion,
      filename: fileMetadata.filename,
      byteSize: fileMetadata.byteSize,
      fileSha256: fileMetadata.fileSha256,
    });
    if (!started.ok) {
      return {
        ok: false,
        status: started.reason === "not_found" ? 404 : 409,
        message:
          started.reason === "not_found"
            ? "The import batch to correct was not found."
            : "A corrected import must supersede a reversed batch in the same portfolio.",
      };
    }
    if (!started.reused && started.batch.status === "uploaded") {
      const recorded = await createOwnedImportStagingRepository(
        context.client,
      ).recordParseResult(context.userId, started.batch.id, {
        expectedVersion: started.batch.version,
        parseResult,
      });
      if (!recorded.ok) {
        return recorded.reason === "atomic_failure"
          ? {
              ok: false,
              status: 503,
              message:
                "The import is still in progress and can be resumed safely.",
            }
          : {
              ok: false,
              status: 409,
              message:
                "The uploaded preview changed while it was being prepared.",
            };
      }
    }
    const review = await loadReview(
      context.client,
      context.userId,
      started.batch.id,
    );
    return "ok" in review ? review : { ok: true, review };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Import preview is temporarily unavailable.",
    };
  }
}

export async function saveImportMappingAction(
  batchId: string,
  value: unknown,
): Promise<ImportActionSuccess | ImportActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const input = value as Record<string, unknown>;
  const kind = input?.kind;
  const scope = input?.scope;
  const confidence = input?.confidence;
  const sourceKey =
    typeof input?.sourceKey === "string" ? input.sourceKey.trim() : "";
  const normalizedSourceValue =
    typeof input?.normalizedSourceValue === "string"
      ? input.normalizedSourceValue.trim()
      : "";
  if (
    !["portfolio", "security", "currency", "transaction_type", "fx"].includes(
      String(kind),
    ) ||
    !["row", "batch", "user_future"].includes(String(scope)) ||
    !["user", "exact_identifier", "system_candidate"].includes(
      String(confidence),
    ) ||
    !sourceKey ||
    !normalizedSourceValue
  ) {
    return {
      ok: false,
      status: 400,
      message: "Complete the labelled mapping fields.",
    };
  }
  const staging = createOwnedImportStagingRepository(context.client);
  const batch = await staging.get(context.userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  const expectedVersion = input?.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    expectedVersion !== batch.version
  ) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before mapping.",
    };
  }
  const currentReview = await loadReview(
    context.client,
    context.userId,
    batchId,
  );
  if ("ok" in currentReview) return currentReview;
  if (
    typeof input?.expectedPreviewVersion !== "string" ||
    input.expectedPreviewVersion !== currentReview.previewVersion
  ) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before mapping.",
    };
  }
  try {
    await createOwnedImportMappingDecisionRepository(context.client).save(
      context.userId,
      {
        batchId,
        kind: kind as ImportMappingKind,
        scope: scope as ImportMappingScope,
        confidence: confidence as ImportMappingConfidence,
        source: "user",
        sourceKey,
        normalizedSourceValue,
        targetId: typeof input?.targetId === "string" ? input.targetId : null,
        targetValue:
          typeof input?.targetValue === "string" ? input.targetValue : null,
      },
    );
    const review = await loadReview(context.client, context.userId, batchId);
    return "ok" in review ? review : { ok: true, review };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "The mapping service is temporarily unavailable.",
    };
  }
}

// The business logic (readiness precondition + `transitionStatus` call)
// lives in `import-ready-service.ts`'s `markImportReadyWithContext`, which
// deliberately avoids importing `./portfolio-actions.ts` (and the
// `next/headers`/D1-binding resolution it pulls in) so it stays directly
// testable against a plain `SqlClient`, matching `reverseImportWithContext`
// in `import-reversal-service.ts`. This action only resolves the
// authenticated context and delegates.
export async function markImportReadyAction(
  batchId: string,
  value: unknown,
): Promise<ImportActionSuccess | ImportActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  return markImportReadyWithContext(context, batchId, value);
}

// The business logic lives in `security-verification-service.ts`'s
// `verifySecurityCandidateWithContext`, kept free of `next/headers`/D1-binding
// resolution for the same testability reason as `markImportReadyWithContext`
// above. This action only resolves the authenticated context and delegates.
export async function verifySecurityCandidateAction(
  batchId: string,
  value: unknown,
): Promise<SecurityVerifyActionSuccess | SecurityVerifyActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  return verifySecurityCandidateWithContext(context, batchId, value);
}

// The business logic lives in `security-attestation-service.ts`'s
// `attestSecurityCandidateWithContext`, kept free of `next/headers`/D1-binding
// resolution for the same testability reason as `verifySecurityCandidateAction`
// above. This action only resolves the authenticated context (which already
// carries `requestId`, needed for the attestation audit event) and
// delegates. Declared against THIS file's own broader `ImportActionFailure`
// (not `SecurityAttestActionFailure`, which deliberately excludes 401/503 --
// see that type's header comment) -- mirrors `markImportReadyAction` above,
// the established pattern for exactly this auth-context-pass-through case.
export async function attestSecurityCandidateAction(
  batchId: string,
  value: unknown,
): Promise<ImportActionSuccess | ImportActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  return attestSecurityCandidateWithContext(context, batchId, value);
}

// The business logic lives in `import-security-metadata-service.ts`'s
// `updateImportSecurityMetadataWithContext`, kept free of `next/headers`/
// D1-binding resolution for the same testability reason as
// `attestSecurityCandidateAction` above. This action only resolves the
// authenticated context (which already carries `requestId`, needed for the
// edit's audit event) and delegates. Declared against THIS file's own
// broader `ImportActionFailure` (not `ImportSecurityMetadataActionFailure`,
// which deliberately excludes 401/503) for the identical reason
// `attestSecurityCandidateAction`'s header comment gives.
export async function updateImportSecurityMetadataAction(
  batchId: string,
  value: unknown,
): Promise<ImportActionSuccess | ImportActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  return updateImportSecurityMetadataWithContext(context, batchId, value);
}

// The business logic lives in `import-row-exclusion-service.ts`'s
// `setImportRowExclusionWithContext`, kept free of `next/headers`/D1-binding
// resolution for the same testability reason as `markImportReadyWithContext`
// and `verifySecurityCandidateAction` above. This action only resolves the
// authenticated context and delegates.
export async function setImportRowExclusionAction(
  batchId: string,
  value: unknown,
): Promise<ImportRowExclusionActionSuccess | ImportRowExclusionActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  return setImportRowExclusionWithContext(context, batchId, value);
}

// Reloads the current server-issued review for a batch without mutating
// anything -- the "Refresh preview" affordance the UI offers after a stale
// (409) mapping/ready/verify response, so the owner can resynchronize the
// preview version without re-uploading the file.
export async function loadImportPreviewAction(
  batchId: string,
): Promise<ImportActionSuccess | ImportActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const review = await loadReview(context.client, context.userId, batchId);
  return "ok" in review ? review : { ok: true, review };
}
