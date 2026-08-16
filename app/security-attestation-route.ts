import type { SecurityAttestActionSuccess } from "./security-attestation-service.ts";
import { rejectCrossSiteMutation } from "./mutation-request.ts";

// Matches `ImportActionFailure` (`app/import-actions.ts`) exactly -- the
// wired action (`attestSecurityCandidateAction`) is declared against that
// broader file-local type (mirroring `ImportReadyRouteFailure`/
// `MarkImportReadyAction` in `import-ready-route.ts`, the established
// pattern for a route whose action legitimately covers
// `getAuthenticatedSqlContext()`'s own 401/503 pass-through, which
// `attestSecurityCandidateWithContext`'s own narrower `SecurityAttestActionFailure`
// deliberately excludes).
type SecurityAttestRouteFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

export type AttestSecurityCandidateAction = (
  batchId: string,
  value: unknown,
) => Promise<SecurityAttestActionSuccess | SecurityAttestRouteFailure>;

// Mirrors `createSecurityVerifyPost` (security-verification-route.ts): the
// CSRF guard and JSON/response plumbing are factored out of the
// authenticated action so a test can inject a handler bound to a
// sqlite-backed context (see `attestSecurityCandidateWithContext`) without
// mocking Cloudflare Access/D1. CSRF-first, per QA-001A's settled
// same-origin/CSRF discipline: `rejectCrossSiteMutation(request)` runs
// before any body read or authenticated work, exactly like every other
// mutation route in this app.
export function createSecurityAttestPost(
  action: AttestSecurityCandidateAction,
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
