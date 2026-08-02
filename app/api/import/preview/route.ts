import { createImportPreviewAction } from "../../../import-actions";

export async function POST(request: Request): Promise<Response> {
  const result = await createImportPreviewAction(request);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
