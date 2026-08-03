import { rejectCrossSiteMutation } from "./mutation-request.ts";

type RouteResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; status: number; message: string; [key: string]: unknown };

type PortfolioAction = (
  portfolioId: string,
  value: unknown,
) => Promise<RouteResult>;

type TransactionAction = (
  portfolioId: string,
  transactionId: string,
  value: unknown,
) => Promise<RouteResult>;

function response(result: RouteResult): Response {
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}

export function createManualLedgerPortfolioPost(action: PortfolioAction) {
  return async function post(
    request: Request,
    context: { params: Promise<{ portfolioId: string }> },
  ): Promise<Response> {
    const rejected = rejectCrossSiteMutation(request);
    if (rejected) return rejected;
    const { portfolioId } = await context.params;
    return response(
      await action(portfolioId, await request.json().catch(() => null)),
    );
  };
}

export function createManualLedgerTransactionPost(action: TransactionAction) {
  return async function post(
    request: Request,
    context: {
      params: Promise<{ portfolioId: string; transactionId: string }>;
    },
  ): Promise<Response> {
    const rejected = rejectCrossSiteMutation(request);
    if (rejected) return rejected;
    const { portfolioId, transactionId } = await context.params;
    return response(
      await action(
        portfolioId,
        transactionId,
        await request.json().catch(() => null),
      ),
    );
  };
}
