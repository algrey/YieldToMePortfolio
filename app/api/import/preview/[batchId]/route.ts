import { loadImportPreviewAction } from "../../../../import-actions";

// Read-only reload of the current server-issued review for a batch -- no
// mutation, so (matching every other GET route in this app, e.g.
// `/api/import/history`) `rejectCrossSiteMutation` does not apply here. This
// backs the "Refresh preview" affordance the UI offers after a stale (409)
// mapping/ready/verify response.
export async function GET(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { batchId } = await context.params;
  const result = await loadImportPreviewAction(batchId);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
