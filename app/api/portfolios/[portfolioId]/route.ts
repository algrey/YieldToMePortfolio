import {
  archivePortfolioAction,
  renamePortfolioAction,
} from "../../../portfolio-actions";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const { portfolioId } = await context.params;
  const result = await renamePortfolioAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const { portfolioId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    expectedVersion?: unknown;
  } | null;
  const result = await archivePortfolioAction(
    portfolioId,
    body?.expectedVersion,
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
