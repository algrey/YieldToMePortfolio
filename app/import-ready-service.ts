import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  listAttestedSecurityIds,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview.ts";
import { SUPPORTED_IMPORT_PARSER_VERSIONS } from "../domain/imports/index.ts";
import type { ImportPreviewSecurityCandidate } from "../domain/imports/reconciliation.ts";
import {
  SHARESIGHT_SYNC_PARSER_FORMAT,
  SHARESIGHT_SYNC_PARSER_VERSION,
} from "../domain/sharesight-sync/index.ts";

// BRK-005: the CSV parser's own `(parserFormat, parserVersion)` allowlist,
// widened by exactly one additional pair for Sharesight-sourced batches.
// This is the ONE necessary extension to the readiness gate -- everything
// else in this function (issue/mapping revalidation, preview-version
// staleness check) is untouched and applies identically to a Sharesight
// batch, per the Orchestrator ruling that preview/ready/commit/reverse are
// reused, not reimplemented.
function isSupportedImportBatchFormat(
  parserFormat: string,
  parserVersion: string,
): boolean {
  if (parserFormat === "strict-versioned-csv") {
    return SUPPORTED_IMPORT_PARSER_VERSIONS.includes(parserVersion);
  }
  if (parserFormat === SHARESIGHT_SYNC_PARSER_FORMAT) {
    return parserVersion === SHARESIGHT_SYNC_PARSER_VERSION;
  }
  return false;
}

export type ImportReadyActionFailure = {
  ok: false;
  status: 400 | 404 | 409 | 503;
  message: string;
};

export type ImportReadyActionSuccess = {
  ok: true;
  review: ImportReviewPreview;
};

export type ImportReadyActionContext = {
  client: SqlClient;
  userId: string;
};

// A standalone copy of `loadReview` (app/import-actions.ts) so this module
// only depends on `db/repositories/index.ts` and `import-preview.ts` --
// never `./portfolio-actions.ts` (which pulls in `next/headers` and the D1
// binding resolver). That keeps `markImportReadyWithContext` importable and
// exercisable against a plain sqlite-backed `SqlClient` in tests, exactly
// like `reverseImportWithContext` in `import-reversal-service.ts`.
async function loadImportReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | ImportReadyActionFailure> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows(userId, batchId),
      staging.listIssues(userId, batchId),
      createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
      createOwnedPortfolioRepository(client).list(userId),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
        source_currency_code, security_id
       FROM portfolio_securities
       WHERE user_id = ?
       ORDER BY source_symbol ASC, id ASC`,
        [userId],
      ),
    ],
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
  const attestedSecurityIds = await listAttestedSecurityIds(
    client,
    securityCandidates
      .map((candidate) => candidate.securityId)
      .filter((id): id is string => id !== null),
  );
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
    attestedSecurityIds,
  });
}

// `transitionStatus` (db/repositories/import-staging.ts) only validates the
// batch version and the structural state-graph edge (e.g. `parsed` ->
// `ready` is a legal edge). It intentionally has no visibility into mapping
// decisions, reconciliation, or persisted validation issues, so it cannot by
// itself enforce "no blocking issues and no unresolved required mappings"
// before `ready`. This function supplies that missing business precondition:
// it reloads the batch and rebuilds the full owner-scoped review straight
// from the database (never from client-supplied state, matching
// `saveImportMappingAction`'s stale-preview guard in import-actions.ts) and
// only calls the repository's `transitionStatus` once that fresh
// recomputation shows zero unresolved error-severity reconciliation issues
// (`preview.ready`) and zero unresolved persisted validation issues. This is
// the preview-level precondition, not a substitute for commit's own gate:
// `import-commit.ts`'s independent commit-time revalidation additionally
// re-checks row-level persisted state (`validationStatus === "invalid"`,
// `errorCount > 0`, missing `resolvedTarget` for unresolved transaction
// rows) that this function does not inspect. The two checks coincide today
// only because no issue-resolution path can leave a row invalid/unresolved
// without also surfacing an unresolved persisted issue here; commit's
// revalidation remains the final authority and still catches any
// concurrent change or divergence between the two checks.
export async function markImportReadyWithContext(
  context: ImportReadyActionContext,
  batchId: string,
  value: unknown,
): Promise<ImportReadyActionSuccess | ImportReadyActionFailure> {
  const input = value as Record<string, unknown>;
  const expectedVersion = input?.expectedVersion;
  const expectedPreviewVersion = input?.expectedPreviewVersion;
  if (
    typeof expectedVersion !== "number" ||
    typeof expectedPreviewVersion !== "string"
  ) {
    return {
      ok: false,
      status: 400,
      message: "The reviewed preview version is required.",
    };
  }
  const staging = createOwnedImportStagingRepository(context.client);
  const batch = await staging.get(context.userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  if (batch.version !== expectedVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before marking it ready.",
    };
  }
  if (batch.status !== "parsed" && batch.status !== "needs_mapping") {
    return {
      ok: false,
      status: 409,
      message: "This import cannot be marked ready from its current status.",
    };
  }
  const review = await loadImportReview(
    context.client,
    context.userId,
    batchId,
  );
  if ("ok" in review) return review;
  if (review.previewVersion !== expectedPreviewVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before marking it ready.",
    };
  }
  // IMP-008: a persisted error-severity issue linked to a row the owner has
  // excluded (e.g. SHARESIGHT_PAYOUT_KEY_COLLISION) never blocks readiness
  // -- only a batch-level issue (`rowId === null`) or one linked to a
  // still-INCLUDED row does.
  const excludedRowIds = new Set(review.excludedRows.map((row) => row.id));
  const hasUnresolvedPersistedIssue = review.issues.some(
    (issue) =>
      issue.severity === "error" &&
      issue.resolvedAt === null &&
      (issue.rowId === null || !excludedRowIds.has(issue.rowId)),
  );
  const unsupportedParser = !isSupportedImportBatchFormat(
    batch.parserFormat,
    batch.parserVersion,
  );
  if (
    !review.preview.ready ||
    hasUnresolvedPersistedIssue ||
    unsupportedParser
  ) {
    return {
      ok: false,
      status: 409,
      message:
        "Resolve every blocking issue and required mapping before marking this import ready.",
    };
  }
  try {
    const transitioned = await staging.transitionStatus(
      context.userId,
      batchId,
      { expectedVersion, nextStatus: "ready" },
    );
    if (!transitioned.ok) {
      return {
        ok: false,
        status: transitioned.reason === "not_found" ? 404 : 409,
        message:
          transitioned.reason === "version_conflict"
            ? "This preview is stale. Reload it before marking it ready."
            : "This import could not be marked ready.",
      };
    }
    const refreshed = await loadImportReview(
      context.client,
      context.userId,
      batchId,
    );
    return "ok" in refreshed ? refreshed : { ok: true, review: refreshed };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "The import readiness service is temporarily unavailable.",
    };
  }
}
