import { createAuditInsertStatement } from "../db/repositories/audit.ts";
import {
  buildReadyToNeedsMappingStatement,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  listAttestedSecurityIds,
  listAutoCreatedSecurityIds,
  listNameEditableSecurityIds,
  type ImportBatchRecord,
  type ImportRowRecord,
  type SqlClient,
} from "../db/repositories/index.ts";
import type { SqlStatement } from "../db/repositories/sql-client.ts";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview.ts";
import { buildImportReview } from "../domain/imports/review.ts";
import type { ImportPreviewSecurityCandidate } from "../domain/imports/reconciliation.ts";

export type ImportRowExclusionActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
};

export type ImportRowExclusionActionSuccess = {
  ok: true;
  review: ImportReviewPreview;
  changedRowCount: number;
};

export type ImportRowExclusionActionContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

// Review finding FU-2: an injectable clock, matching
// `SecurityVerifyActionOptions`'s identical `now` seam
// (`app/security-verification-service.ts`) -- every timestamp this service
// writes (the row-exclusion repository call AND the `ready` ->
// `needs_mapping` downgrade statement built here) must derive from the
// SAME clock, real or test-injected, rather than the downgrade statement
// alone calling `new Date()` directly.
export type ImportRowExclusionActionOptions = {
  now?: () => string;
};

// A standalone copy of `loadReview` (app/import-actions.ts) for the same
// reason `import-ready-service.ts` and `security-verification-service.ts`
// each keep their own: this module must stay importable and directly
// testable against a plain sqlite-backed `SqlClient`, never pulling in
// `./portfolio-actions.ts` (and the `next/headers`/D1-binding resolution it
// carries).
async function loadImportReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | ImportRowExclusionActionFailure> {
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

// Mirrors `normalized()` in `domain/imports/reconciliation.ts` (kept local
// rather than exported/shared -- a two-line primitive, matching that
// module's own precedent for tiny local helpers over a shared export).
function normalizedKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

// Mirrors `securityKey()` in `domain/imports/reconciliation.ts` exactly
// (also not exported there), so a candidate identity supplied by the client
// composes into the SAME key reconciliation itself uses as
// `ImportReconciliationIssue.sourceKey` on `SECURITY_MAPPING_REQUIRED`.
function securityCandidateKey(
  portfolioId: string,
  sourceSymbol: string,
  sourceExchangeAlias: string | null,
  sourceCurrencyCode: string,
): string {
  return [
    portfolioId,
    normalizedKeyPart(sourceSymbol),
    normalizedKeyPart(sourceExchangeAlias ?? ""),
    normalizedKeyPart(sourceCurrencyCode),
  ].join("|");
}

// EXCLUDE direction: every row CURRENTLY blocked by this unresolved
// candidate has its own `SECURITY_MAPPING_REQUIRED` issue in the freshly
// rebuilt preview (`review.preview.issues`), carrying both `rowId` and the
// same `sourceKey` -- this is the one-action-skips-every-row-for-this-
// security granularity the Orchestrator ruling calls for (the "19
// candidates" case).
function rowsBlockedBySecurityCandidate(
  review: ImportReviewPreview,
  key: string,
): string[] {
  return review.preview.issues
    .filter(
      (issue) =>
        issue.code === "SECURITY_MAPPING_REQUIRED" && issue.sourceKey === key,
    )
    .flatMap((issue) => (issue.rowId ? [issue.rowId] : []));
}

// INCLUDE (un-skip) direction: an already-excluded row generates NO
// reconciliation issue (it is filtered out of `buildImportReview` entirely
// -- see that module's header comment), so there is nothing in `preview` to
// match against. Falls back to the row's own persisted `normalizedFields`
// and resolves its portfolio the same way reconciliation's un-mapped
// fallback does (`row.targetPortfolioId ?? batch.targetPortfolioId`) --
// this does not account for a `scope: "batch"`/`"user_future"` portfolio
// MAPPING DECISION overriding that fallback, so a row whose portfolio only
// resolves through such a decision may need its un-skip driven via the
// row-id target (the "Excluded rows" list) instead of the security-
// candidate target. Never a correctness risk either way: a row that fails
// to match here simply stays excluded until explicitly un-skipped by id.
function excludedRowsMatchingSecurityCandidate(
  rows: readonly ImportRowRecord[],
  batchTargetPortfolioId: string | null,
  key: string,
): string[] {
  return rows
    .filter(
      (row) => row.excludedByOwnerAt !== null && row.normalizedFields !== null,
    )
    .filter((row) => {
      const portfolioId = row.targetPortfolioId ?? batchTargetPortfolioId;
      if (!portfolioId) return false;
      const normalizedFields = row.normalizedFields;
      if (!normalizedFields || normalizedFields.symbol === null) return false;
      return (
        securityCandidateKey(
          portfolioId,
          normalizedFields.symbol,
          normalizedFields.exchange,
          normalizedFields.currency ?? "",
        ) === key
      );
    })
    .map((row) => row.id);
}

function resolveTargetRowIds(
  action: "exclude" | "include",
  target: Record<string, unknown>,
  review: ImportReviewPreview,
  rows: readonly ImportRowRecord[],
  batchTargetPortfolioId: string | null,
): { ok: true; rowIds: string[] } | { ok: false; message: string } {
  const kind = target.kind;
  if (kind === "securityCandidate") {
    const portfolioId =
      typeof target.portfolioId === "string" ? target.portfolioId : "";
    const sourceSymbol =
      typeof target.sourceSymbol === "string" ? target.sourceSymbol : "";
    const sourceExchangeAlias =
      typeof target.sourceExchangeAlias === "string" &&
      target.sourceExchangeAlias.trim().length > 0
        ? target.sourceExchangeAlias
        : null;
    const sourceCurrencyCode =
      typeof target.sourceCurrencyCode === "string"
        ? target.sourceCurrencyCode
        : "";
    if (!portfolioId || !sourceSymbol || !sourceCurrencyCode) {
      return {
        ok: false,
        message: "Complete the labelled security candidate fields.",
      };
    }
    const key = securityCandidateKey(
      portfolioId,
      sourceSymbol,
      sourceExchangeAlias,
      sourceCurrencyCode,
    );
    return {
      ok: true,
      rowIds:
        action === "exclude"
          ? rowsBlockedBySecurityCandidate(review, key)
          : excludedRowsMatchingSecurityCandidate(
              rows,
              batchTargetPortfolioId,
              key,
            ),
    };
  }
  if (kind === "issue") {
    const issueId = typeof target.issueId === "string" ? target.issueId : "";
    const issue = review.issues.find((candidate) => candidate.id === issueId);
    if (!issue || issue.severity !== "error" || issue.rowId === null) {
      return {
        ok: false,
        message: "This issue does not identify a single blocked row.",
      };
    }
    return { ok: true, rowIds: [issue.rowId] };
  }
  if (kind === "rowIds") {
    const requested = Array.isArray(target.rowIds) ? target.rowIds : [];
    const rowIds = requested.filter(
      (rowId): rowId is string => typeof rowId === "string" && rowId.length > 0,
    );
    if (rowIds.length === 0) {
      return { ok: false, message: "At least one row id is required." };
    }
    return { ok: true, rowIds };
  }
  return { ok: false, message: "An exclusion target is required." };
}

// IMP-008 review finding B1: when the batch is currently `ready`, an
// exclusion change (most notably an un-skip re-surfacing a blocking issue
// the owner had excluded away) can leave it no longer actually ready. This
// simulates the post-change row set PURELY IN MEMORY -- no extra write --
// against the SAME evidence `markImportReadyWithContext` itself checks
// (`buildImportReview`'s reconciliation result, plus any unresolved
// PERSISTED error issue on a still-included row), so the exclusion service
// can decide, before writing anything, whether to bundle a `ready` ->
// `needs_mapping` downgrade into the SAME atomic `client.batch()` call as
// the row update (see `buildReadyToNeedsMappingStatement`). Mirrors
// `app/import-ready-service.ts`'s own readiness computation; kept
// independent rather than shared, matching this codebase's established
// precedent of small duplicated per-call-site readiness snapshots (e.g.
// `db/repositories/import-commit.ts`'s `revalidate`) over a shared helper.
//
// Review finding FU-1: also checks the same row-level PERSISTED-state
// predicate commit's own `revalidate()` uses (`db/repositories/import-commit.ts`,
// `hasBlockingPersistedState`'s `rows.some(...)` branch) -- a non-excluded
// row whose OWN `validationStatus`/`errorCount` is still invalid (e.g. the
// SHARESIGHT_PAYOUT_KEY_COLLISION row itself, distinct from the persisted
// ISSUE check above) blocks commit even when reconciliation alone would
// call the preview ready. Without this, an include-at-ready could leave
// the batch mislabelled `ready` when commit would immediately fail-closed
// with `revalidation_failed` -- safe, but incoherent: the status should
// already say `needs_mapping` in that case.
function stillReadyAfterChange(
  batch: ImportBatchRecord,
  rows: readonly ImportRowRecord[],
  review: ImportReviewPreview,
  portfolios: ReadonlyArray<{
    id: string;
    name: string;
    homeCurrencyCode: string;
    historyCompleteFrom: string | null;
  }>,
  changedRowIds: readonly string[],
  action: "exclude" | "include",
): boolean {
  const changedSet = new Set(changedRowIds);
  const simulatedRows = rows.map((row) =>
    changedSet.has(row.id)
      ? {
          ...row,
          excludedByOwnerAt:
            action === "exclude" ? "1970-01-01T00:00:00.000Z" : null,
        }
      : row,
  );
  const built = buildImportReview({
    batch,
    rows: simulatedRows,
    issues: review.issues,
    mappings: review.mappings,
    portfolios,
    securityCandidates: review.securityCandidates,
  });
  const excludedRowIds = new Set(
    simulatedRows
      .filter((row) => row.excludedByOwnerAt !== null)
      .map((row) => row.id),
  );
  const hasUnresolvedPersistedIssue = review.issues.some(
    (issue) =>
      issue.severity === "error" &&
      issue.resolvedAt === null &&
      (issue.rowId === null || !excludedRowIds.has(issue.rowId)),
  );
  const hasBlockingPersistedRowState = simulatedRows.some(
    (row) =>
      row.excludedByOwnerAt === null &&
      (row.validationStatus === "invalid" || row.errorCount > 0),
  );
  return (
    built.preview.ready &&
    !hasUnresolvedPersistedIssue &&
    !hasBlockingPersistedRowState
  );
}

// Implements IMP-008: an owner-initiated, batch-scoped, reversible decision
// to exclude specific staged rows from this batch's eventual commit (never
// relaxing verification -- excluded rows simply never post any financial
// effect, see `import-commit.ts`'s row-iteration skip). `expectedVersion`/
// `expectedPreviewVersion` are re-verified against the freshly reloaded
// batch/preview exactly like `verifySecurityCandidateWithContext`, since
// exclusion changes the canonical evidence `previewVersion` hashes (see
// `domain/imports/review.ts`), not just an advisory display warning.
export async function setImportRowExclusionWithContext(
  context: ImportRowExclusionActionContext,
  batchId: string,
  value: unknown,
  options: ImportRowExclusionActionOptions = {},
): Promise<ImportRowExclusionActionSuccess | ImportRowExclusionActionFailure> {
  const now = options.now ?? (() => new Date().toISOString());
  const input = value as Record<string, unknown>;
  const action = input?.action;
  if (action !== "exclude" && action !== "include") {
    return {
      ok: false,
      status: 400,
      message: "A valid exclusion action (exclude or include) is required.",
    };
  }
  const target = input?.target;
  const expectedVersion = input?.expectedVersion;
  const expectedPreviewVersion = input?.expectedPreviewVersion;
  if (
    typeof expectedVersion !== "number" ||
    typeof expectedPreviewVersion !== "string" ||
    typeof target !== "object" ||
    target === null
  ) {
    return {
      ok: false,
      status: 400,
      message:
        "The reviewed preview version and an exclusion target are required.",
    };
  }

  const staging = createOwnedImportStagingRepository(context.client, now);
  const batch = await staging.get(context.userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  if (batch.version !== expectedVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before changing exclusions.",
    };
  }
  if (
    batch.status !== "parsed" &&
    batch.status !== "needs_mapping" &&
    batch.status !== "invalid" &&
    batch.status !== "ready"
  ) {
    return {
      ok: false,
      status: 409,
      message: "Rows cannot be excluded from this import's current status.",
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
      message: "This preview is stale. Reload it before changing exclusions.",
    };
  }

  const rows = await staging.listRows(context.userId, batchId);
  const resolved = resolveTargetRowIds(
    action,
    target as Record<string, unknown>,
    review,
    rows,
    batch.targetPortfolioId,
  );
  if (!resolved.ok) {
    return { ok: false, status: 400, message: resolved.message };
  }
  if (resolved.rowIds.length === 0) {
    return { ok: true, review, changedRowCount: 0 };
  }

  try {
    const result = await staging.setRowExclusion(context.userId, batchId, {
      rowIds: resolved.rowIds,
      excluded: action === "exclude",
      // IMP-008 review finding B3: built from the ACTUALLY CHANGED row ids
      // `setRowExclusion` passes in here (its own eligibility SELECT
      // result), never `resolved.rowIds` (what was REQUESTED) -- a request
      // mixing one real staged row with a foreign/ineligible id must not
      // record an audit event naming the id that never actually changed.
      buildExtraStatements: async (changedRowIds): Promise<SqlStatement[]> => {
        const statements: SqlStatement[] = [
          createAuditInsertStatement({
            actorUserId: context.userId,
            targetOwnerUserId: context.userId,
            action:
              action === "exclude"
                ? "import.row.exclude"
                : "import.row.include",
            targetType: "import_batch",
            targetId: batchId,
            requestId: context.requestId,
            result: "success",
            metadata: { rowIds: changedRowIds },
          }),
        ];
        // IMP-008 review finding B1: a `ready` batch stays open to
        // exclusion changes; if this one leaves it no longer actually
        // ready (most notably an un-skip re-surfacing a blocking issue),
        // downgrade it to `needs_mapping` in the SAME atomic call as the
        // row update/audit insert above -- see `stillReadyAfterChange` and
        // `buildReadyToNeedsMappingStatement` for why this must be bundled
        // rather than a second round-trip.
        if (batch.status === "ready") {
          const portfolios = await createOwnedPortfolioRepository(
            context.client,
          ).list(context.userId);
          const stillReady = stillReadyAfterChange(
            batch,
            rows,
            review,
            portfolios.map((portfolio) => ({
              id: portfolio.id,
              name: portfolio.name,
              homeCurrencyCode: portfolio.homeCurrencyCode,
              historyCompleteFrom: portfolio.historyCompleteFrom,
            })),
            changedRowIds,
            action,
          );
          if (!stillReady) {
            statements.push(
              buildReadyToNeedsMappingStatement(context.userId, batchId, now()),
            );
          }
        }
        return statements;
      },
    });
    if (!result.ok) {
      return {
        ok: false,
        status: result.reason === "not_found" ? 404 : 409,
        message: "This import's rows could not be updated.",
      };
    }

    // IMP-008 supersedes BRK-005D: a batch that reached `invalid` because
    // of a persisted parse/sync-time error issue (e.g.
    // SHARESIGHT_PAYOUT_KEY_COLLISION) has no OTHER way forward -- see the
    // `isValidTransition` comment in `db/repositories/import-staging.ts`.
    // Once excluding rows removes every remaining blocking persisted row/
    // issue, advance the batch to `needs_mapping` so the existing
    // `markImportReadyWithContext` parsed/needs_mapping gate picks it up
    // normally; this never touches an already parsed/needs_mapping batch.
    if (result.changedRowIds.length > 0 && batch.status === "invalid") {
      const refreshedRows = await staging.listRows(context.userId, batchId);
      const stillExcludedIds = new Set(
        refreshedRows
          .filter((row) => row.excludedByOwnerAt !== null)
          .map((row) => row.id),
      );
      const refreshedIssues = await staging.listIssues(context.userId, batchId);
      const stillBlocked =
        refreshedRows.some(
          (row) =>
            !stillExcludedIds.has(row.id) &&
            (row.validationStatus === "invalid" || row.errorCount > 0),
        ) ||
        refreshedIssues.some(
          (issue) =>
            issue.severity === "error" &&
            issue.resolvedAt === null &&
            (issue.rowId === null || !stillExcludedIds.has(issue.rowId)),
        );
      if (!stillBlocked) {
        const current = await staging.get(context.userId, batchId);
        if (current && current.status === "invalid") {
          await staging.transitionStatus(context.userId, batchId, {
            expectedVersion: current.version,
            nextStatus: "needs_mapping",
          });
        }
      }
    }

    const refreshed = await loadImportReview(
      context.client,
      context.userId,
      batchId,
    );
    return "ok" in refreshed
      ? refreshed
      : {
          ok: true,
          review: refreshed,
          changedRowCount: result.changedRowIds.length,
        };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "The row exclusion service is temporarily unavailable.",
    };
  }
}
