import type { ImportSecurityMetadataActionSuccess } from "./import-security-metadata-service.ts";
import { rejectCrossSiteMutation } from "./mutation-request.ts";

// Matches `ImportActionFailure` (`app/import-actions.ts`) exactly -- the
// wired action (`updateImportSecurityMetadataAction`) is declared against
// that broader file-local type, mirroring `AttestSecurityCandidateAction`
// (`security-attestation-route.ts`), the established pattern for a route
// whose action legitimately covers `getAuthenticatedSqlContext()`'s own
// 401/503 pass-through, which `ImportSecurityMetadataActionFailure`
// deliberately excludes.
type ImportSecurityMetadataRouteFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

export type UpdateImportSecurityMetadataAction = (
  batchId: string,
  value: unknown,
) => Promise<
  ImportSecurityMetadataActionSuccess | ImportSecurityMetadataRouteFailure
>;

// Mirrors `createSecurityAttestPost` (security-attestation-route.ts): CSRF
// guard first, before any body read or authenticated work, and the JSON/
// response plumbing is factored out of the authenticated action so a test
// can inject a handler bound to a sqlite-backed context
// (`updateImportSecurityMetadataWithContext`) without mocking Cloudflare
// Access/D1.
export function createImportSecurityMetadataPost(
  action: UpdateImportSecurityMetadataAction,
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
