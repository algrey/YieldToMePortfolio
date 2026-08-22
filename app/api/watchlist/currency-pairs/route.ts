import { addWatchlistCurrencyPairAction } from "../../../watchlist-actions.ts";
import { rejectCrossSiteMutation } from "../../../mutation-request.ts";

// WLT-001: adds a currency pair to the owner's watchlist -- USER-scoped.
export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await addWatchlistCurrencyPairAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
