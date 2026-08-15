import { runSharesightSyncAction } from "../../../../sharesight-sync-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

// BRK-005: owner-initiated Sharesight read-sync into a STAGED import batch
// (CSRF-first, owner-scoped POST -- Orchestrator ruling 1). Fetches
// trades/payouts for the linked Sharesight portfolio via BRK-003's sealed
// GET-only client, transforms them, and stages them through the EXISTING
// CSV-import pipeline -- the returned batch then flows through the
// unmodified preview/mappings/ready/commit/reverse routes exactly like a
// CSV upload.
export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await runSharesightSyncAction(portfolioId);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
