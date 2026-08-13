import { saveDividendFyOverrideAction } from "../../../../dividend-assumptions-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

// UI-006B: past-FY income override (gross + franking; cash is derived at
// read time by DIV-001) -- overrides receipts and provider history for that
// FY's display.
export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await saveDividendFyOverrideAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
