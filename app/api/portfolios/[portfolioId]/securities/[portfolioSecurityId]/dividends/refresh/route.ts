import { refreshSecurityDividendHistoryAction } from "../../../../../../../dividend-history-refresh-actions.ts";
import { rejectCrossSiteMutation } from "../../../../../../../mutation-request.ts";

// UI-006C: "Refresh historical" -- owner-initiated, per-security provider
// dividend/split re-pull (behind an explicit confirmation dialog on the
// client). No request body is read; the security is identified entirely by
// the owner-scoped URL params, re-verified server-side by
// `refreshSecurityDividendHistoryAction` before any provider call.
export async function POST(
  request: Request,
  context: {
    params: Promise<{ portfolioId: string; portfolioSecurityId: string }>;
  },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId, portfolioSecurityId } = await context.params;
  const result = await refreshSecurityDividendHistoryAction(
    portfolioId,
    portfolioSecurityId,
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
