import { reverseImportAction } from "../../../../../import-reversal-actions.ts";
import { rejectCrossSiteMutation } from "../../../../../mutation-request.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { batchId } = await context.params;
  const result = await reverseImportAction(
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
}
