import {
  acceptImportWithContext,
  type ImportAcceptActionFailure,
  type ImportAcceptActionSuccess,
} from "./import-accept-service.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";

// The business logic lives in `import-accept-service.ts`'s
// `acceptImportWithContext`, kept free of `next/headers`/D1-binding
// resolution for the same testability reason as `markImportReadyAction`/
// `verifySecurityCandidateAction` (`app/import-actions.ts`). This action only
// resolves the authenticated context (which already carries `requestId`,
// needed for the resolution/commit audit events) and delegates.
export async function acceptImportAction(
  batchId: string,
): Promise<ImportAcceptActionSuccess | ImportAcceptActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  return acceptImportWithContext(context, batchId);
}
