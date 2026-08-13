import { sharesAtDateAction } from "../../../../dividend-assumptions-actions.ts";

// UI-006B: read-only auto-population for the manual dividend entry form's
// "shares held at that date" field (DIV-001's `deriveSharesHeldAtDate`).
// A read, not a mutation -- no CSRF gate, matching this codebase's
// established convention for GET routes (see docs/QA-001A_SECURITY_MATRIX.md
// section 1's "N/A (read)" rows).
export async function GET(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const { portfolioId } = await context.params;
  const url = new URL(request.url);
  const result = await sharesAtDateAction(portfolioId, {
    portfolioSecurityId: url.searchParams.get("portfolioSecurityId"),
    date: url.searchParams.get("date"),
  });
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
