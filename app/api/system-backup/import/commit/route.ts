import { commitSystemBackupCorePartAction } from "../../../../system-backup-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

// EXP-004: ONE endpoint dispatching all four resumable core-restore phases
// (scaffold/transactions/dividends/finalize) by the request body's own
// `phase` field -- see `system-backup-actions.ts`'s
// `commitSystemBackupCorePartAction`. Replaces the old single-request
// whole-core commit, which could exceed the Cloudflare Workers Free plan's
// per-request CPU budget partway through a portfolio's replay.
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await commitSystemBackupCorePartAction(request);
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
