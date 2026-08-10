import { createPortfolioAction } from "../../portfolio-actions";
import { rejectCrossSiteMutation } from "../../mutation-request";

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await createPortfolioAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
