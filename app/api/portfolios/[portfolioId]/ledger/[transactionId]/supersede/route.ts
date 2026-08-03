import { supersedeManualLedgerAction } from "../../../../../../manual-ledger-actions.ts";
import { rejectCrossSiteMutation } from "../../../../../../mutation-request.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string; transactionId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId, transactionId } = await context.params;
  const result = await supersedeManualLedgerAction(
    portfolioId,
    transactionId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
