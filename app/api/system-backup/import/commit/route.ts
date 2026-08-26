import { commitSystemBackupImportAction } from "../../../../system-backup-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await commitSystemBackupImportAction(request);
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
