import { createImportPreviewAction } from "../../../import-actions";
import { rejectCrossSiteMutation } from "../../../mutation-request";

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await createImportPreviewAction(request);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
