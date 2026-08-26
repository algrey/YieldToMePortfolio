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
  ImportPreviewPortfolio,
  ImportPreviewSecurityCandidate,
} from "../domain/imports/reconciliation";
import {
  fileMetadataFromImportBody,
  MAX_IMPORT_UPLOAD_REQUEST_BYTES,
  rawRowsFromImportBody,
  readJsonBody,
  supersedesBatchIdFromImportBody,
  targetPortfolioIdFromImportBody,
} from "./import-request-body.ts";

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
    // DIV-004: existing OWNER-typed manual records only (import_batch_id
    // IS NULL) -- an imported-vs-imported near match is cross-batch
    // dedupe's job (source_reference idempotency), not this warning's.
    // DIV-016 part A: excludes a superseded (historical) row -- only the
    // CURRENT head of each lineage is "the" dividend on record; comparing
    // against a superseded ancestor's payment date would raise a spurious
    // near-duplicate warning against a fact the owner already corrected.
    client.all<Record<string, unknown>>(
      `SELECT portfolio_security_id, payment_date FROM dividend_manual_records
       WHERE user_id = ? AND import_batch_id IS NULL
         AND superseded_by_record_id IS NULL`,
      [userId],
    ),
    client.all<Record<string, unknown>>(
      `SELECT portfolio_security_id, payment_date FROM dividend_receipts
       WHERE user_id = ?`,
      [userId],
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
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] = [
    ...existingManualRows,
    ...existingReceiptRows,
  ].map((row) => ({
    portfolioSecurityId: String(row.portfolio_security_id),
    paymentDate: String(row.payment_date),
  }));
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
