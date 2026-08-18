import {
  createOwnedImportCommitRepository,
  type ImportCommitSuccess,
} from "../db/repositories/index.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";
import {
  advanceCalculationRunsForCommit,
  POST_COMMIT_CALCULATION_BUDGET,
} from "./calculation-executor-service.ts";

type ImportCommitActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
};

export type ImportCommitActionResult =
  { ok: true; commit: ImportCommitSuccess } | ImportCommitActionFailure;

function messageFor(reason: string): string {
  switch (reason) {
    case "not_found":
      return "Import batch not found.";
    case "confirmation_required":
      return "Confirm the reviewed import before committing it.";
    case "invalid_idempotency_key":
      return "A valid idempotency key is required.";
    case "stale_preview":
      return "This preview is stale. Reload it before committing.";
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

export async function commitImportAction(
  batchId: string,
  value: unknown,
): Promise<ImportCommitActionResult> {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const expectedVersion =
    typeof input.expectedVersion === "number" ? input.expectedVersion : NaN;
  const expectedPreviewVersion = input.expectedPreviewVersion;
  const idempotencyKey = input.idempotencyKey;
  const confirmation = input.confirmation;
  if (
    !Number.isInteger(expectedVersion) ||
    typeof expectedPreviewVersion !== "string" ||
    typeof idempotencyKey !== "string" ||
    typeof confirmation !== "boolean"
  ) {
    return {
      ok: false,
      status: 400,
      message:
        "The reviewed preview, confirmation, and idempotency key are required.",
    };
  }
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  try {
    const result = await createOwnedImportCommitRepository(
      context.client,
    ).commit(context.userId, batchId, {
      expectedVersion,
      expectedPreviewVersion,
      idempotencyKey,
      confirmation,
      requestId: context.requestId,
    });
    if (result.ok) {
      // CALC-003 trigger 1: a committed batch just queued
      // `calculation_runs` rows (`rebuildJobIds`) that otherwise sit
      // `queued` forever with no production caller to advance them (the
      // root cause of "Holdings/Overview empty, Income zero after a real
      // committed import"). Best-effort and bounded -- a failure here must
      // never turn an already-successful commit into an error response;
      // trigger 2 (read-time, `owned-holdings.ts`) and trigger 3 (cron)
      // pick up anything left queued or interrupted.
      if (result.status === "committed" && result.rebuildJobIds.length > 0) {
        await advanceCalculationRunsForCommit(
          { client: context.client },
          {
            userId: context.userId,
            calculationRunIds: result.rebuildJobIds,
            budget: POST_COMMIT_CALCULATION_BUDGET,
          },
        ).catch(() => undefined);
      }
      return { ok: true, commit: result };
    }
    return {
      ok: false,
      status:
        result.reason === "not_found"
          ? 404
          : result.reason === "invalid_idempotency_key"
            ? 400
            : result.reason === "atomic_failure" ||
                result.reason === "injected_failure"
              ? 503
              : 409,
      message: messageFor(result.reason),
    };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Import commit is temporarily unavailable.",
    };
  }
}
