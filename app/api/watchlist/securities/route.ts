import { addWatchlistSecurityAction } from "../../../watchlist-actions.ts";
import { rejectCrossSiteMutation } from "../../../mutation-request.ts";

// WLT-001: adds a security to the owner's watchlist -- USER-scoped (no
// portfolioId route segment; see `app/watchlist-actions.ts`'s header note).
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await addWatchlistSecurityAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
