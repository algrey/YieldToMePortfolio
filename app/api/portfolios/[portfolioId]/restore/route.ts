import { restorePortfolioAction } from "../../../../portfolio-actions";
import { rejectCrossSiteMutation } from "../../../../mutation-request";

export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    expectedVersion?: unknown;
  } | null;
  const result = await restorePortfolioAction(
    portfolioId,
    body?.expectedVersion,
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
