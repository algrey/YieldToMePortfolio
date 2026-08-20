import { deletePriceUploadAction } from "../../../../price-upload-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { batchId } = await params;
  const result = await deletePriceUploadAction(batchId);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
