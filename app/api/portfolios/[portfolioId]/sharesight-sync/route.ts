import { runSharesightSyncAction } from "../../../../sharesight-sync-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";
import { resolveSharesightSyncMode } from "../../../../sharesight-sync-panel-helpers.ts";

// BRK-005: owner-initiated Sharesight read-sync into a STAGED import batch
// (CSRF-first, owner-scoped POST -- Orchestrator ruling 1). Fetches
// trades/payouts for the linked Sharesight portfolio via BRK-003's sealed
// GET-only client, transforms them, and stages them through the EXISTING
// CSV-import pipeline -- the returned batch then flows through the
// unmodified preview/mappings/ready/commit/reverse routes exactly like a
// CSV upload.
//
// BRK-015: `?mode=full` selects the explicit "Full resync" action
// (unconditional inception-to-now fetch, unchanged from pre-BRK-015
// behaviour); any other value, or its absence, is the default `"routine"`
// watermark-narrowed sync. Parsing lives in the shared, directly-tested
// `resolveSharesightSyncMode` (`sharesight-sync-panel-helpers.ts`) -- the
// SAME function `tests/brk-005b.test.ts` pins against the exact wire
// string, rather than an inline literal duplicated (and driftable) between
// this route and the panel's fetch call.
export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const mode = resolveSharesightSyncMode(request.url);
  const result = await runSharesightSyncAction(portfolioId, mode);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
