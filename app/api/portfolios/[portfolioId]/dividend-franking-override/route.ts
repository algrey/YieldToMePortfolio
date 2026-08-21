import { saveDividendFrankingOverrideAction } from "../../../../dividend-assumptions-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

// BRK-011: owner-entered franking-currency override for a foreign-currency
// Sharesight payout (tier 3 of the owner's BINDING resolution cascade --
// see docs/CALCULATIONS.md section 11). Mirrors
// dividend-fy-overrides/route.ts's shape exactly.
export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await saveDividendFrankingOverrideAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
