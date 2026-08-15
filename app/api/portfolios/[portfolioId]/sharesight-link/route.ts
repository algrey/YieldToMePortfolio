import { linkSharesightPortfolioAction } from "../../../../sharesight-sync-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

// BRK-005: one-time owner action that links a Sharesight portfolio to this
// local portfolio (stores `sharesight_portfolio_id` in `sharesight_sync_state`,
// BRK-004's reserved cursor table). A mutation of our data -- CSRF-first.
export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await linkSharesightPortfolioAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
