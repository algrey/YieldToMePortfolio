import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  listAttestedSecurityIds,
  listAutoCreatedSecurityIds,
  listNameEditableSecurityIds,
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
import {
  advanceCalculationRunsForCommit,
  POST_COMMIT_CALCULATION_BUDGET,
} from "./calculation-executor-service.ts";

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
        `SELECT ps.id, ps.portfolio_id, ps.source_symbol, ps.source_exchange_alias,
        ps.source_currency_code, ps.security_id, s.canonical_name
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       WHERE ps.user_id = ?
       ORDER BY ps.source_symbol ASC, ps.id ASC`,
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
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates,
    attestedSecurityIds,
    securityNames,
    autoCreatedSecurityIds,
    nameEditableSecurityIds,
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
  // UI-013 review round B3 (BLOCKING correction): a single `commit()` call
  // only ever processes `MAX_CHUNK_SIZE` (2) staged rows -- deliberately,
  // see `db/repositories/import-commit.ts` and ARCHITECTURE.md's dated
  // amendment (originally "processes one chunk per invocation" for the
  // manual commit route; this accept path is now documented as its own
  // bounded, measured exception). Left as one call, any batch with more
  // than a couple of committable rows would return here still `committing`,
  // leaving the owner to manually re-click Accept/Commit to pump the rest
  // -- the exact defect this task fixes. This loop repeats the SAME
  // idempotent commit step (deterministic `accept:<batchId>` key, resuming
  // from `commit_high_water_row` each time -- nothing here departs from the
  // existing resumable-commit machinery) until the batch is `committed`, a
  // real error occurs, or the safety cap below is reached.
  //
  // The cap is a MEASURED budget, not a guess: the reviewer's own repro
  // (accepting a realistic 225-row Sharesight batch against the original
  // 25-iteration cap) measured ~1000-1083 D1 statements emitted -- over
  // D1's per-invocation statement budget and directly against the
  // one-chunk-per-invocation discipline this loop is meant to respect, and
  // a failure there strands the batch `committing` with (at the time) no
  // way to reopen its review. That works out to ~40-43 statements per
  // 2-row chunk (each committed row's ledger posting is itself several
  // statements -- lots, postings, the row update -- plus the chunk-tracking
  // and audit inserts every chunk pays regardless of row count). 8
  // iterations x ~43 statements is ~350 -- comfortable headroom under that
  // budget, while still finishing realistically-sized batches (a 225-row
  // batch needs ~113 two-row chunks; ~15 client-side accept calls at
  // 8-iterations-per-call, each cheap, is a fine failure mode -- see
  // `import-review.tsx`'s `submitAccept`, which re-POSTs the identical
  // idempotent accept request until the batch reports `committed`, resuming
  // exactly where this loop left off). A batch stuck `committing` between
  // client retries is also no longer a dead end: `isResumableReviewStatus`
  // (`import-history-detail.tsx`) now allows reopening a `committing`
  // batch's review from import history specifically to resume it, closing
  // the stranding hole the original cap's failure mode exposed.
  const ACCEPT_COMMIT_LOOP_MAX_ITERATIONS = 8;
  let commitResult = await commitRepository.commit(context.userId, batchId, {
    expectedVersion: beforeCommit.version,
    expectedPreviewVersion,
    idempotencyKey: acceptCommitIdempotencyKey(batchId),
    confirmation: true,
    requestId: context.requestId,
  });
  for (
    let iteration = 1;
    commitResult.ok &&
    commitResult.status === "committing" &&
    iteration < ACCEPT_COMMIT_LOOP_MAX_ITERATIONS;
    iteration += 1
  ) {
    commitResult = await commitRepository.commit(context.userId, batchId, {
      expectedVersion: beforeCommit.version,
      expectedPreviewVersion: "",
      idempotencyKey: acceptCommitIdempotencyKey(batchId),
      confirmation: true,
      requestId: context.requestId,
    });
  }
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
  // CALC-003 trigger 1: identical rationale to the manual commit route
  // (`app/import-commit-actions.ts`) -- a batch that finished committing
  // here just queued `calculation_runs` rows nothing else would advance.
  // Best-effort and bounded; never turns a successful accept into an
  // error.
  if (
    commitResult.status === "committed" &&
    commitResult.rebuildJobIds.length > 0
  ) {
    await advanceCalculationRunsForCommit(
      { client: context.client },
      {
        userId: context.userId,
        calculationRunIds: commitResult.rebuildJobIds,
        budget: POST_COMMIT_CALCULATION_BUDGET,
      },
    ).catch(() => undefined);
  }
  return { ok: true, commit: commitResult };
}
