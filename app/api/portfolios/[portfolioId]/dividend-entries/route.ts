import {
  deleteDividendManualRecordAction,
  saveDividendEntryAction,
} from "../../../../dividend-assumptions-actions.ts";
import { rejectCrossSiteMutation } from "../../../../mutation-request.ts";

// UI-006B: the per-share manual dividend record / event-linked override
// form. POST saves (routing to `dividend_manual_records` or
// `dividend_event_overrides` -- see `app/dividend-assumptions-actions.ts`'s
// header note); DELETE removes an owner-typed manual record (the "Exclude
// this dividend" action for a non-event-linked row -- an event-linked
// row's exclude is a flag on the same POST save, never a delete).
export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await saveDividendEntryAction(
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
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const { portfolioId } = await context.params;
  const result = await deleteDividendManualRecordAction(
    portfolioId,
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
