import type {
  ImportAcceptActionFailure,
  ImportAcceptActionSuccess,
} from "./import-accept-service.ts";
import { rejectCrossSiteMutation } from "./mutation-request.ts";

export type AcceptImportAction = (
  batchId: string,
) => Promise<ImportAcceptActionSuccess | ImportAcceptActionFailure>;

// Mirrors `createImportReadyPost` (import-ready-route.ts): the CSRF guard
// runs FIRST, before any authenticated action/database work, and the
// JSON/response plumbing is factored out of the authenticated action so a
// test can inject a handler bound to a sqlite-backed context
// (`acceptImportWithContext`) without mocking Cloudflare Access/D1. Unlike
// the other import routes, accept takes no request body at all -- one owner
// action, no client-supplied version/preview fields (see
// `import-accept-service.ts`'s header comment for why every step re-derives
// its own expected state fresh from the database instead).
export function createImportAcceptPost(action: AcceptImportAction) {
  return async function post(
    request: Request,
    context: { params: Promise<{ batchId: string }> },
  ): Promise<Response> {
    const rejected = rejectCrossSiteMutation(request);
    if (rejected) return rejected;
    const { batchId } = await context.params;
    const result = await action(batchId);
    return Response.json(result, {
      // Mirrors `app/api/import/commit/[batchId]/route.ts`'s identical
      // 200-vs-202 distinction: a resumable "committing" state (e.g. a large
      // batch split across commit chunks) is still `ok: true`, just not yet
      // fully committed.
      status: result.ok
        ? result.commit.status === "committed"
          ? 200
          : 202
        : result.status,
      headers: { "cache-control": "private, no-store" },
    });
  };
}
