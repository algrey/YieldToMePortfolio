import { reorderWatchlistAction } from "../../../watchlist-actions.ts";
import { rejectCrossSiteMutation } from "../../../mutation-request.ts";

// WLT-001: reorders the whole watchlist in one request (see
// `db/repositories/watchlist.ts`'s `reorder` doc comment for the
// set-equality concurrency guard this relies on instead of a per-row
// version).
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await reorderWatchlistAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
