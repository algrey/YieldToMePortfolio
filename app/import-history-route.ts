import { IMPORT_HISTORY_LIMITS } from "../db/repositories/index.ts";
import type { ImportHistoryDetail } from "./import-history-service.ts";

type ImportHistoryDetailResult =
  | { ok: true; detail: ImportHistoryDetail }
  | {
      ok: false;
      status: 400 | 401 | 404 | 503;
      message: string;
    };

export type LoadImportBatchHistory = (
  batchId: string,
  offset: number,
) => Promise<ImportHistoryDetailResult>;

export function createImportBatchHistoryGet(action: LoadImportBatchHistory) {
  return async function get(
    request: Request,
    context: { params: Promise<{ batchId: string }> },
  ): Promise<Response> {
    const rawOffset = new URL(request.url).searchParams.get("offset") ?? "0";
    const offset = Number(rawOffset);
    if (
      !/^\d+$/.test(rawOffset) ||
      !Number.isSafeInteger(offset) ||
      offset > IMPORT_HISTORY_LIMITS.maxDetailOffset
    ) {
      return Response.json(
        { ok: false, message: "A valid history page is required." },
        {
          status: 400,
          headers: { "cache-control": "private, no-store" },
        },
      );
    }
    const { batchId } = await context.params;
    const result = await action(batchId, offset);
    return Response.json(result, {
      status: result.ok ? 200 : result.status,
      headers: { "cache-control": "private, no-store" },
    });
  };
}
