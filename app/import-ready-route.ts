import type { ImportReadyActionSuccess } from "./import-ready-service.ts";
import { rejectCrossSiteMutation } from "./mutation-request.ts";

type ImportReadyRouteFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

export type MarkImportReadyAction = (
  batchId: string,
  value: unknown,
) => Promise<ImportReadyActionSuccess | ImportReadyRouteFailure>;

// Mirrors `createImportReversalPost` (import-reversal-route.ts): the CSRF
// guard and JSON/response plumbing are factored out of the authenticated
// action so a test can inject a handler bound to a sqlite-backed context
// (see `markImportReadyWithContext`) without mocking Cloudflare Access/D1.
export function createImportReadyPost(action: MarkImportReadyAction) {
  return async function post(
    request: Request,
    context: { params: Promise<{ batchId: string }> },
  ): Promise<Response> {
    const rejected = rejectCrossSiteMutation(request);
    if (rejected) return rejected;
    const { batchId } = await context.params;
    const result = await action(
      batchId,
      await request.json().catch(() => null),
    );
    return Response.json(result, {
      status: result.ok ? 200 : result.status,
      headers: { "cache-control": "private, no-store" },
    });
  };
}
