import {
  deleteIncomeScenarioAction,
  saveIncomeScenarioAction,
} from "../../../../income-scenario-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

// DIV-014: saves a NAMED multi-year income what-if scenario (POST) or
// removes one permanently, no confirmation (DELETE) -- both owner-scoped,
// portfolio-scoped. Mirrors `app/api/watchlist/entries/route.ts`'s
// body-carried `{ id, expectedVersion }` DELETE shape (never a nested
// `[scenarioId]` route segment).
export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await saveIncomeScenarioAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await deleteIncomeScenarioAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
