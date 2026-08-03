import {
  reverseImportWithContext,
  type ImportReversalActionResult,
} from "./import-reversal-service.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";

export type { ImportReversalActionResult } from "./import-reversal-service.ts";

export async function reverseImportAction(
  batchId: string,
  value: unknown,
): Promise<ImportReversalActionResult> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  try {
    return await reverseImportWithContext(context, batchId, value);
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Import reversal is temporarily unavailable.",
    };
  }
}
