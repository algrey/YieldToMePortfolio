import type { SecurityVerifyActionSuccess } from "./security-verification-service.ts";
import { rejectCrossSiteMutation } from "./mutation-request.ts";

type SecurityVerifyRouteFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 502 | 503;
  message: string;
};

export type VerifySecurityCandidateAction = (
  batchId: string,
  value: unknown,
) => Promise<SecurityVerifyActionSuccess | SecurityVerifyRouteFailure>;

// Mirrors `createImportReadyPost` (import-ready-route.ts): the CSRF guard
// and JSON/response plumbing are factored out of the authenticated action so
// a test can inject a handler bound to a sqlite-backed context (see
// `verifySecurityCandidateWithContext`) without mocking Cloudflare
// Access/D1/the market-data provider's live HTTP calls.
export function createSecurityVerifyPost(
  action: VerifySecurityCandidateAction,
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
