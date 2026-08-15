import { listSharesightPortfoliosAction } from "../../../../sharesight-sync-actions.ts";

// BRK-005: lists the owner's Sharesight portfolios (via BRK-003's sealed
// GET-only client) so the owner can pick which one to link to this local
// portfolio. A read against Sharesight, not a mutation of our data -- no
// CSRF gate, matching this codebase's established convention for GET routes.
export async function GET(
  _request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const { portfolioId } = await context.params;
  const result = await listSharesightPortfoliosAction(portfolioId);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
