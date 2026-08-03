import { loadImportHistoryAction } from "../../../import-history-actions.ts";

export async function GET(): Promise<Response> {
  const result = await loadImportHistoryAction();
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
