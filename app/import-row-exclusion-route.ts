import type { ImportRowExclusionActionSuccess } from "./import-row-exclusion-service.ts";
import { rejectCrossSiteMutation } from "./mutation-request.ts";

type ImportRowExclusionRouteFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
};

export type SetImportRowExclusionAction = (
  batchId: string,
  value: unknown,
) => Promise<ImportRowExclusionActionSuccess | ImportRowExclusionRouteFailure>;

// Mirrors `createSecurityVerifyPost` (security-verification-route.ts): the
// CSRF guard and JSON/response plumbing are factored out of the
// authenticated action so a test can inject a handler bound to a
// sqlite-backed context (see `setImportRowExclusionWithContext`) without
// mocking Cloudflare Access/D1.
export function createImportRowExclusionPost(
  action: SetImportRowExclusionAction,
) {
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
