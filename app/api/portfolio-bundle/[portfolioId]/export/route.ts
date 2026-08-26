import { exportPortfolioBundleAction } from "../../../../portfolio-bundle-actions.ts";

// EXP-001: a plain authenticated GET download (no mutation, no CSRF gate),
// mirroring `app/api/market-data/price-uploads/export/route.ts`'s MKT-008
// precedent -- one JSON attachment per portfolio.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const { portfolioId } = await params;
  const result = await exportPortfolioBundleAction(portfolioId);
  if (!result.ok) {
    return Response.json(result, {
      status: result.status,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const dateStamp = result.bundle.exportedAt.slice(0, 10);
  const filename = `yieldtome-portfolio-${dateStamp}.json`;
  return new Response(JSON.stringify(result.bundle), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
