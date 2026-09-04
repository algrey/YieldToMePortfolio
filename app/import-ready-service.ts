import {
  createOwnedImportStagingRepository,
  type SqlClient,
} from "../db/repositories/index.ts";
import type { ImportReviewPreview } from "./import-preview.ts";
import { SUPPORTED_IMPORT_PARSER_VERSIONS } from "../domain/imports/index.ts";
import {
  SHARESIGHT_SYNC_PARSER_FORMAT,
  SHARESIGHT_SYNC_PARSER_VERSION,
} from "../domain/sharesight-sync/index.ts";
// CORRECTION ROUND (B1b): the shared loader `app/import-accept-service.ts`
// ALSO uses -- see that module's own comment and this loader's own header
// comment for why both callers must import the SAME function, never
// independently-drifting copies.
import { loadImportReviewForReadyTransition } from "./import-ready-review-loader.ts";
import { rowDiffersFromCommittedRecordIssueStatement } from "../db/repositories/import-issue-statements.ts";

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

// CORRECTION ROUND (B1b): `loadImportReview` now delegates entirely to the
// SHARED loader `app/import-ready-review-loader.ts` -- `app/import-accept-
// service.ts` calls the SAME function, so the two can never independently
// drift on what evidence they supply (see that loader's own header comment
// for why divergence there was a real, reviewer-discovered bug: it falsely
// 409'd every Accept as "stale, reload" instead of the honest "resolve
// blocking issues" the moment ANY dividend near-match evidence changed
// `preview.ready`).
async function loadImportReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | ImportReadyActionFailure> {
  return loadImportReviewForReadyTransition(client, userId, batchId);
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
  // CORRECTION ROUND (B1b, BLOCKING): persist the DIV-004 near-match
  // escalation (`ROW_DIFFERS_FROM_COMMITTED_RECORD`) into `import_issues`
  // right here, at the moment readiness is checked -- this is the one point
  // every path that can reach `ready`/Accept (the CSV "Mark Ready" button
  // and the Sharesight `acceptImportWithContext` atomic flow,
  // `app/import-accept-service.ts`) is guaranteed to pass through before
  // ever reaching commit. Without this, the escalation lived only in the
  // COMPUTED, un-persisted `preview.issues` -- `app/components/import-review.tsx`'s
  // `acceptDisabled` deliberately gates on PERSISTED `review.issues` only
  // (BRK-009C ruling, unchanged by this task), so the "Accept Import" button
  // stayed enabled AND, once clicked, gave no indication of what had
  // blocked it.
  //
  // ROUND 3 (B3, 2026-09-04) -- correcting this comment's own overstated
  // claim: persistence happens HERE, inside `markImportReadyWithContext`,
  // so it is the FIRST Accept/Mark-ready attempt that is rejected and
  // persists the finding; the button is disabled only from the NEXT render
  // onward. This is NOT pre-emptive blocking, and slice 1 deliberately does
  // not implement any (a pre-emptive block would need the page-only
  // committed-value evidence loaded on every render). What this DOES buy is
  // that the owner never gets a second, unexplained rejection: after the
  // first attempt the block is visible and named on the row.
  //
  // Persisted with the SAME idempotent `WHERE NOT EXISTS` guard
  // `db/repositories/import-commit.ts`'s own fail-closed skip uses (shared
  // via `rowDiffersFromCommittedRecordIssueStatement`) -- a retried/repeated
  // ready-check never inserts a second copy. No separate "clear on
  // exclusion" step is needed: `isRowStillBlocking` (`import-review.tsx`)
  // and this function's own `hasUnresolvedPersistedIssue` below already
  // treat ANY issue linked to an EXCLUDED row as non-blocking regardless of
  // `resolvedAt`, and the computed `preview.issues` this loop reads drops an
  // excluded row's issues entirely before this point is ever reached (see
  // `domain/imports/review.ts`) -- so once the owner excludes the row, this
  // issue is simply never re-inserted and this loop never sees it again.
  for (const issue of review.preview.issues) {
    if (
      issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD" &&
      issue.rowId !== undefined &&
      issue.physicalRowNumber !== undefined
    ) {
      const statement = rowDiffersFromCommittedRecordIssueStatement(
        context.userId,
        batchId,
        issue.rowId,
        issue.physicalRowNumber,
        issue.message,
        new Date().toISOString(),
      );
      await context.client.run(statement.sql, statement.params);
    }
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
