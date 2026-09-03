import {
  createOwnedImportReversalRepository,
  type ImportReversalImpact,
  type ImportReversalSuccess,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  advanceCalculationRunsForCommit,
  POST_COMMIT_CALCULATION_BUDGET,
} from "./calculation-executor-service.ts";

export type ImportReversalActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
  impacts?: ImportReversalImpact[];
};

export type ImportReversalActionResult =
  { ok: true; reversal: ImportReversalSuccess } | ImportReversalActionFailure;

export type ImportReversalActionContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

function messageFor(reason: string): string {
  switch (reason) {
    case "not_found":
      return "Import batch not found.";
    case "confirmation_required":
      return "Confirm the import reversal before continuing.";
    case "invalid_idempotency_key":
      return "A valid idempotency key is required.";
    case "stale_batch":
      return "This import changed. Reload it before reversing it.";
    case "not_committed":
      return "Only a committed import can be reversed.";
    case "dependent_facts":
      return "This import has later dependent facts. Resolve the listed impact before reversing it.";
    case "injected_failure":
    case "atomic_failure":
      return "The import reversal is still in progress and can be resumed safely.";
    default:
      return "The import reversal could not be completed.";
  }
}

export async function reverseImportWithContext(
  context: ImportReversalActionContext,
  batchId: string,
  value: unknown,
): Promise<ImportReversalActionResult> {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const expectedVersion =
    typeof input.expectedVersion === "number" ? input.expectedVersion : NaN;
  const idempotencyKey = input.idempotencyKey;
  const confirmation = input.confirmation;
  if (
    !Number.isInteger(expectedVersion) ||
    typeof idempotencyKey !== "string" ||
    typeof confirmation !== "boolean"
  ) {
    return {
      ok: false,
      status: 400,
      message:
        "The batch version, confirmation, and idempotency key are required.",
    };
  }

  const result = await createOwnedImportReversalRepository(
    context.client,
  ).reverse(context.userId, batchId, {
    expectedVersion,
    idempotencyKey,
    confirmation,
    requestId: context.requestId,
  });
  if (result.ok) {
    // BUG-016 fold-in: identical rationale to the commit routes
    // (`app/import-commit-actions.ts`, `app/import-accept-service.ts`) --
    // a reversal that just finished queues `calculation_runs` rows (the
    // per-transaction `ledger_mutation` rows `ledger.reverse()` queues for
    // every reversed trade, plus, on the finalizing invocation, the
    // dividend-parity `import_reverse` rows) that nothing else would advance
    // in-request, leaving them `queued` until the cron sweep. Best-effort
    // and bounded -- a failure here must never turn an already-successful
    // reversal into an error response; the read-time and cron triggers
    // still cover anything left queued or interrupted.
    //
    // Review B2 fix (2026-09-03): gated on the TERMINAL status, exactly as
    // the commit route it mirrors gates on `result.status === "committed"`.
    // A reversal chunks at `IMPORT_REVERSAL_LIMITS.maxChunkSize` (2), so a
    // large batch spans many `reversing` invocations, each returning its own
    // freshly queued `rebuildJobIds`; advancing on every one of them ran a
    // full FIFO rebuild plus publish per chunk against a ledger still being
    // reversed -- measured 75/72/65 D1 statements across a 3-chunk reversal
    // versus 46/45/65 with this gate, for an identical end state, since the
    // intermediate rebuilds are superseded by the next chunk's run anyway.
    // Runs queued by a non-final chunk are not lost: the finalizing call
    // resolves its own ids to their DISTINCT portfolios and then advances
    // each portfolio's whole projection pipeline (see
    // `advanceCalculationRunsForCommit`), so earlier chunks' queued rows for
    // those portfolios are completed or superseded there. The read-time and
    // cron triggers remain the backstop if the finalizing call never comes.
    if (result.status === "reversed" && result.rebuildJobIds.length > 0) {
      await advanceCalculationRunsForCommit(
        { client: context.client },
        {
          userId: context.userId,
          calculationRunIds: result.rebuildJobIds,
          budget: POST_COMMIT_CALCULATION_BUDGET,
        },
      ).catch(() => undefined);
    }
    return { ok: true, reversal: result };
  }
  return {
    ok: false,
    status:
      result.reason === "not_found"
        ? 404
        : result.reason === "confirmation_required" ||
            result.reason === "invalid_idempotency_key"
          ? 400
          : result.reason === "atomic_failure" ||
              result.reason === "injected_failure"
            ? 503
            : 409,
    message: messageFor(result.reason),
    impacts: result.impacts,
  };
}
