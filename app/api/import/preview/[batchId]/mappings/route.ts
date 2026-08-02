import { saveImportMappingAction } from "../../../../../import-actions";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { batchId } = await context.params;
  const result = await saveImportMappingAction(
    batchId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
