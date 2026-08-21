import { priceHistoryAction } from "../../../../../../owned-price-history.ts";

// UI-018: read-only price-history series for the holding-detail chart. A
// read, not a mutation -- no CSRF gate, matching this codebase's
// established convention for GET routes (docs/QA-001A_SECURITY_MATRIX.md
// section 1's "N/A (read)" rows, e.g. the sibling
// `dividend-shares-at-date` route).
export async function GET(
  request: Request,
  context: {
    params: Promise<{ portfolioId: string; portfolioSecurityId: string }>;
  },
): Promise<Response> {
  const { portfolioId, portfolioSecurityId } = await context.params;
  const url = new URL(request.url);
  const result = await priceHistoryAction(
    portfolioId,
    portfolioSecurityId,
    url.searchParams.get("range"),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
