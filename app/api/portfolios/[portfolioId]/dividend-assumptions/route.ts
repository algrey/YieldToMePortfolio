import { saveDividendAssumptionsGridAction } from "../../../../dividend-assumptions-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

// UI-006B: version-guarded, CSRF-first save of the whole assumptions grid
// (per-security rows + the portfolio-level growth row).
export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await saveDividendAssumptionsGridAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
