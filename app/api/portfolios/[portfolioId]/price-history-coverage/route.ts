import { priceHistoryCoverageAction } from "../../../../price-history-coverage.ts";

// MKT-018B (guided flow): read-only price-history coverage for the import
// page's "Download price history" panel -- a read, not a mutation, so no
// CSRF gate, matching this codebase's established convention for GET
// routes (docs/QA-001A_SECURITY_MATRIX.md section 1's "N/A (read)" rows,
// e.g. the sibling `price-history` route).
export async function GET(
  _request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const { portfolioId } = await context.params;
  const result = await priceHistoryCoverageAction(portfolioId);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
