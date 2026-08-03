import { requestMarketDataRefreshAction } from "../../../market-data-actions";

export async function POST(request: Request): Promise<Response> {
  const result = await requestMarketDataRefreshAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 202 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
