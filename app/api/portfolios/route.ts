import { createPortfolioAction } from "../../portfolio-actions";

export async function POST(request: Request): Promise<Response> {
  const result = await createPortfolioAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
