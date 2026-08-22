import { removeWatchlistEntryAction } from "../../../watchlist-actions.ts";
import { rejectCrossSiteMutation } from "../../../mutation-request.ts";

// WLT-001: removes one watch entry -- the row affordance, version-guarded.
export async function DELETE(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await removeWatchlistEntryAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
