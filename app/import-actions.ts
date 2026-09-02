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
import type {
  ImportPreviewDividendReconciliationCandidate,
  ImportPreviewExistingDividendEntry,
  ImportPreviewExistingTradeEntry,
  ImportPreviewPortfolio,
  ImportPreviewSecurityCandidate,
} from "../domain/imports/reconciliation";
// BUG-013: the SAME comparable-total helper DIV-016C's reconciliation
// matching rule uses, reused here so the cross-route dividend near-duplicate
// check compares like-for-like amounts (see that module's header comment).
import { computeDividendCashTotal } from "../domain/imports/dividend-reconciliation.ts";
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
    existingTradeRows,
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
    // BUG-013: `LIMIT MAX + 1` caps the comparison set, mirroring BUG-011's
    // F2 lesson -- `capExistingDividendRows` (`./import-dividend-duplicate-
    // check.ts`) degrades to `existingDividendEntriesUnavailable` rather
    // than silently comparing against a truncated (and therefore
    // unreliable) set. This query was previously UNBOUNDED.
    client.all<Record<string, unknown>>(
      `SELECT portfolio_security_id, payment_date, shares_decimal,
              dividend_per_share_decimal, franking_credit_per_share_decimal,
              total_cash_decimal, total_franking_decimal, currency_code
       FROM dividend_manual_records
       WHERE user_id = ? AND superseded_by_record_id IS NULL
       LIMIT ?`,
      [userId, MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1],
    ),
    // BUG-013: `dividend_receipts` is a provider-observed fact outside the
    // CSV/Sharesight IMPORT routes this task's cross-route gap is about (it
    // has no `import_batch_id`/route concept at all), so it stays out of
    // scope for `DIVIDEND_MATCHES_EXISTING_ENTRY`'s amount check -- only
    // DIV-004's payment-date-proximity check uses it, unchanged. Now capped
    // like the query above (was previously unbounded) since both feed the
    // same combined, capped `existingDividendEntries` array.
    client.all<Record<string, unknown>>(
      `SELECT portfolio_security_id, payment_date FROM dividend_receipts
       WHERE user_id = ?
       LIMIT ?`,
      [userId, MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1],
    ),
    // DIV-016 part C: existing owner-typed, non-superseded manual dividend
    // records eligible to be matched and superseded by an incoming
    // Sharesight payout row -- see `ImportPreviewDividendReconciliationCandidate`'s
    // doc comment. Narrower than `existingManualRows` above (no receipts;
    // carries amounts): this is the advisory PREVIEW-only disclosure --
    // `db/repositories/import-commit.ts`'s `revalidate()` runs the
    // authoritative, live-DB-state equivalent independently at commit time.
    client.all<Record<string, unknown>>(
      `SELECT id, portfolio_security_id, payment_date, shares_decimal,
              dividend_per_share_decimal, total_cash_decimal
       FROM dividend_manual_records
       WHERE user_id = ? AND import_batch_id IS NULL
         AND superseded_by_record_id IS NULL`,
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
    // comment).
    client.all<Record<string, unknown>>(
      `SELECT portfolio_id, source_reference FROM dividend_manual_records
       WHERE user_id = ? AND source_reference IS NOT NULL`,
      [userId],
    ),
    // BUG-011: every existing POSTED buy/sell transaction across the WHOLE
    // OWNER (any portfolio, any source route, any prior batch/import), for
    // the preview-time cross-route duplicate-trade warning -- see
    // `ImportPreviewExistingTradeEntry`'s doc comment for scope.
    //
    // Review round F2 RULING CORRECTION (this query was briefly scoped to
    // `batch.targetPortfolioId` in an earlier round; that was WRONG and is
    // reverted here). `portfolioFor` (`domain/imports/reconciliation.ts`)
    // resolves a row's portfolio THREE ways -- a `kind:"portfolio"` mapping
    // decision's `targetId` (any OWNED portfolio, not just the batch's own
    // target -- the mapping picker offers every one and
    // `saveImportMappingAction` accepts any owned `targetId`), the row's own
    // `targetPortfolioId`, or a unique portfolio NAME match -- so a row can
    // resolve into a DIFFERENT portfolio than `batch.targetPortfolioId`, and
    // a batch with no target at all (`null`) still resolves fully by name.
    // Scoping the comparison set to `batch.targetPortfolioId` therefore
    // produced silent FALSE NEGATIVES for exactly those rows -- indistin-
    // guishable from a genuine non-match, i.e. exactly the failure mode this
    // task's own cap/degrade design (below) is built to avoid. Reverted to
    // user-wide with no loss of precision: `portfolio_securities.id` is
    // unique per portfolio and every match below compares against the row's
    // own already-resolved, portfolio-correct `membershipId`
    // (`createImportReconciliationPreview`'s `candidate.portfolioId ===
    // portfolio.id` filter upstream), so a portfolio-A trade can never match
    // a portfolio-B row's `membershipId` regardless of how wide this read
    // is -- per-portfolio correctness is enforced by membership identity,
    // not by this query's `WHERE` clause.
    //
    // Review round F1: `status = 'posted'` alone is NOT enough to exclude a
    // reversed trade's ledger footprint -- `ledger.reverse()` re-runs
    // `prepareLedgerPosting` on the ORIGINAL input, so the COMPENSATING
    // MIRROR row it inserts is itself `status = 'posted'`, with the same
    // type/quantity/price/date/`portfolio_security_id` as the reversed
    // trade, and only `reverses_transaction_id` set to distinguish it. The
    // reversed trade's own ORIGINAL row is excluded by `status = 'posted'`
    // (it flips to `'reversed'`), but without also excluding
    // `reverses_transaction_id IS NOT NULL`, the mirror row would still
    // match and warn on exactly the reverse-then-re-import remediation this
    // task's own diagnostic step prescribes.
    //
    // Review round F2: `LIMIT MAX + 1` caps the comparison set; a
    // `length > MAX` check (`capExistingTradeRows`, `./import-trade-
    // duplicate-check.ts`) degrades to `existingTradeEntriesUnavailable`
    // rather than silently comparing against a truncated (and therefore
    // unreliable) set.
    client.all<Record<string, unknown>>(
      `SELECT portfolio_security_id, type, local_trade_date,
              quantity_decimal, unit_price_decimal
       FROM transactions
       WHERE user_id = ? AND status = 'posted'
         AND type IN ('buy', 'sell') AND reverses_transaction_id IS NULL
         AND portfolio_security_id IS NOT NULL
         AND quantity_decimal IS NOT NULL AND unit_price_decimal IS NOT NULL
       LIMIT ?`,
      [userId, MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK + 1],
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
            cashTotalDecimal: computeDividendCashTotal({
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
            frankingTotalDecimal: computeDividendCashTotal({
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
  const existingDividendSourceReferences = new Set(
    existingSourceReferenceRows.map(
      (row) => `${String(row.portfolio_id)}::${String(row.source_reference)}`,
    ),
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
