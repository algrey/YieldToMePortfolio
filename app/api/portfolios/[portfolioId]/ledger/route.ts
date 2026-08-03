import { createManualLedgerAction } from "../../../../manual-ledger-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await createManualLedgerAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
