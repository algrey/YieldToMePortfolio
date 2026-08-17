import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  listAttestedSecurityIds,
  type ImportCommitSuccess,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview.ts";
import type { ImportPreviewSecurityCandidate } from "../domain/imports/reconciliation.ts";
import { markImportReadyWithContext } from "./import-ready-service.ts";
import { resolveSharesightBatchSecuritiesWithContext } from "./security-resolution-service.ts";
import { SHARESIGHT_SYNC_PARSER_FORMAT } from "../domain/sharesight-sync/index.ts";

// BRK-009B: the single atomic "Accept Import" owner action -- (re-run
// security resolution idempotently for a sharesight_sync batch) -> mark
// ready (the existing, version-guarded `markImportReadyWithContext`) ->
// commit (the existing idempotent commit machinery,
// `createOwnedImportCommitRepository`). One request, one owner action; no
// client-supplied version/previewVersion -- every step re-derives its own
// expected state fresh from the database immediately before acting, so the
// caller never needs to round-trip a preview version first (that is the
// entire point of collapsing "resolve securities" + "mark ready" + "commit"
// into one server-orchestrated action). Reuses the EXISTING commit machinery
// unmodified (per the Orchestrator ruling: "no new commit path") -- this
// module only sequences the existing, independently-tested steps and
// generates the commit idempotency key server-side (deterministically, so a
// retried/duplicated accept call for the same batch converges on the SAME
// commit attempt rather than racing two different idempotency keys against
// `import_batches.commit_idempotency_key`'s single-writer guard).
export type ImportAcceptActionContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

// 401 is included solely so `import-accept-actions.ts` can widen this type
// to also cover `getAuthenticatedSqlContext()`'s own auth-resolution
// failure (mirrors `markImportReadyAction`'s identical accommodation in
// `app/import-actions.ts`) -- `acceptImportWithContext` itself never
// produces a 401.
export type ImportAcceptActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
};

export type ImportAcceptActionSuccess = {
  ok: true;
  commit: ImportCommitSuccess;
};

export type ImportAcceptActionOptions = {
  now?: () => string;
};

// Deterministic per-batch commit idempotency key -- NOT a random value per
// call. `db/repositories/import-commit.ts`'s `commit()` resumes an
// in-progress ("committing") batch only when the caller's idempotency key
// matches the one already stored on the batch, and treats a mismatch as a
// hard `conflict`. A random key per accept call would break the very
// "idempotent re-accept" behaviour this action promises: a retried/duplicate
// request (network retry, a second click before the UI disables the button)
// must resolve to the SAME commit attempt, not collide with it. Scoped to
// this batch id alone; `isValidCommitKey` (import-commit.ts) only requires
// non-empty, <=120 chars, no control/newline bytes -- this value satisfies
// that for any UUID-shaped `batchId`.
function acceptCommitIdempotencyKey(batchId: string): string {
  return `accept:${batchId}`;
}

// A standalone copy of `loadReview` (app/import-actions.ts) for the same
// reason `import-ready-service.ts`/`security-verification-service.ts`/
// `security-attestation-service.ts` each keep their own: this module must
// stay importable and directly testable against a plain sqlite-backed
// `SqlClient`, never pulling in `./portfolio-actions.ts` (and the
// `next/headers`/D1-binding resolution it carries).
async function loadImportReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | ImportAcceptActionFailure> {
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

function commitFailureMessage(reason: string): string {
  switch (reason) {
    case "not_found":
      return "Import batch not found.";
    case "confirmation_required":
      return "Confirm the reviewed import before committing it.";
    case "invalid_idempotency_key":
      return "A valid idempotency key is required.";
    case "stale_preview":
      return "This import changed while it was being accepted. Reload and try again.";
    case "revalidation_failed":
      return "This import no longer matches a commit-ready server preview. Review its issues and mappings again.";
    case "not_ready":
      return "This import is not ready to commit.";
    case "mapping_incomplete":
      return "Resolve every required mapping before committing this import.";
    case "conflict":
      return "This import commit conflicts with an existing request.";
    case "injected_failure":
    case "atomic_failure":
      return "The import is still in progress and can be resumed safely.";
    default:
      return "The import commit could not be completed.";
  }
}

export async function acceptImportWithContext(
  context: ImportAcceptActionContext,
  batchId: string,
  options: ImportAcceptActionOptions = {},
): Promise<ImportAcceptActionSuccess | ImportAcceptActionFailure> {
  const staging = createOwnedImportStagingRepository(context.client);
  const initialBatch = await staging.get(context.userId, batchId);
  if (!initialBatch)
    return { ok: false, status: 404, message: "Import batch not found." };

  // F4 (BRK-009B review): this atomic action is scoped to `sharesight_sync`
  // batches ONLY -- a CSV batch keeps the pre-existing two-step review flow
  // (verify/attest each candidate, then `POST .../ready`, then
  // `POST /api/import/commit/:batchId`), never this single-request
  // shortcut. Checked before any write (resolution/ready/commit) is even
  // attempted.
  if (initialBatch.parserFormat !== SHARESIGHT_SYNC_PARSER_FORMAT) {
    return {
      ok: false,
      status: 400,
      message:
        "Accept is available for Sharesight sync imports; use the review flow for CSV imports.",
    };
  }

  // Step 1: re-run security resolution idempotently.
  const resolved = await resolveSharesightBatchSecuritiesWithContext(
    context,
    batchId,
    { now: options.now },
  );
  if (!resolved.ok) return resolved;

  // Step 2: mark ready, only if the batch is not there yet -- re-derives its
  // own expectedVersion/expectedPreviewVersion fresh from the database
  // immediately before calling the existing, version-guarded service (never
  // trusts a value from outside this function). Already-ready/committing/
  // committed batches skip straight to step 3 (idempotent re-accept).
  const beforeReady = await staging.get(context.userId, batchId);
  if (!beforeReady)
    return { ok: false, status: 404, message: "Import batch not found." };
  if (
    beforeReady.status === "parsed" ||
    beforeReady.status === "needs_mapping"
  ) {
    const review = await loadImportReview(
      context.client,
      context.userId,
      batchId,
    );
    if ("ok" in review) return review;
    const readied = await markImportReadyWithContext(context, batchId, {
      expectedVersion: beforeReady.version,
      expectedPreviewVersion: review.previewVersion,
    });
    if (!readied.ok) return readied;
  } else if (
    beforeReady.status !== "ready" &&
    beforeReady.status !== "committing" &&
    beforeReady.status !== "committed"
  ) {
    return {
      ok: false,
      status: 409,
      message: "This import cannot be accepted from its current status.",
    };
  }

  // Step 3: commit through the EXISTING idempotent commit machinery, no new
  // commit path (Orchestrator ruling). `expectedVersion`/`expectedPreviewVersion`
  // are re-derived fresh immediately before the call; for an already-
  // `committing`/`committed` batch these two values are not even consulted
  // by `commit()`'s own resume/idempotent-replay branches (see that
  // repository's own state machine), so it is always safe to supply them.
  const beforeCommit = await staging.get(context.userId, batchId);
  if (!beforeCommit)
    return { ok: false, status: 404, message: "Import batch not found." };
  const commitRepository = createOwnedImportCommitRepository(context.client);
  let expectedPreviewVersion = "";
  if (beforeCommit.status === "ready") {
    const validated = await commitRepository.validate(context.userId, batchId);
    if (!validated.ok) {
      return {
        ok: false,
        status: validated.reason === "not_found" ? 404 : 409,
        message: commitFailureMessage("revalidation_failed"),
      };
    }
    expectedPreviewVersion = validated.previewVersion;
  }
  const commitResult = await commitRepository.commit(context.userId, batchId, {
    expectedVersion: beforeCommit.version,
    expectedPreviewVersion,
    idempotencyKey: acceptCommitIdempotencyKey(batchId),
    confirmation: true,
    requestId: context.requestId,
  });
  if (!commitResult.ok) {
    return {
      ok: false,
      status:
        commitResult.reason === "not_found"
          ? 404
          : commitResult.reason === "invalid_idempotency_key"
            ? 400
            : commitResult.reason === "atomic_failure" ||
                commitResult.reason === "injected_failure"
              ? 503
              : 409,
      message: commitFailureMessage(commitResult.reason),
    };
  }
  return { ok: true, commit: commitResult };
}
