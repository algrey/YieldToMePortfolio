import { requestMarketDataRefreshAction } from "../../../market-data-actions.ts";
import { rejectCrossSiteMutation } from "../../../mutation-request.ts";

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await requestMarketDataRefreshAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 202 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
