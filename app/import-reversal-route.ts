import type { ImportReversalActionResult } from "./import-reversal-service.ts";
import { rejectCrossSiteMutation } from "./mutation-request.ts";

export type ReverseImportAction = (
  batchId: string,
  value: unknown,
) => Promise<ImportReversalActionResult>;

export function createImportReversalPost(action: ReverseImportAction) {
  return async function post(
    request: Request,
    context: { params: Promise<{ batchId: string }> },
  ): Promise<Response> {
    const rejected = rejectCrossSiteMutation(request);
    if (rejected) return rejected;
    const { batchId } = await context.params;
    const result = await action(
      batchId,
      await request.json().catch(() => null),
    );
    return Response.json(result, {
      status: result.ok
        ? result.reversal.status === "reversed"
          ? 200
          : 202
        : result.status,
      headers: { "cache-control": "private, no-store" },
    });
  };
}
