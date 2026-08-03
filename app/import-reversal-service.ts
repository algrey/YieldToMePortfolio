import {
  createOwnedImportReversalRepository,
  type ImportReversalImpact,
  type ImportReversalSuccess,
  type SqlClient,
} from "../db/repositories/index.ts";

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
  if (result.ok) return { ok: true, reversal: result };
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
