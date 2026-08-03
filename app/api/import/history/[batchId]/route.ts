import { loadImportBatchHistoryAction } from "../../../../import-history-actions.ts";

export async function GET(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { batchId } = await context.params;
  const result = await loadImportBatchHistoryAction(batchId);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
