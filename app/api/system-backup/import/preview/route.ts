import { previewSystemBackupImportAction } from "../../../../system-backup-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await previewSystemBackupImportAction(request);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
