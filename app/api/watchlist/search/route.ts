import { searchWatchlistSecuritiesAction } from "../../../watchlist-actions.ts";

// WLT-001: reads only (a provider search, never a mutation) -- no CSRF gate,
// matching this codebase's established "reads are N/A for CSRF" convention
// (docs/QA-001A_SECURITY_MATRIX.md section 1).
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const result = await searchWatchlistSecuritiesAction({
    text: url.searchParams.get("text") ?? "",
  });
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
