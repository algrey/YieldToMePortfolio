import { createOwnedImportStagingRepository } from "../db/repositories/index.ts";
import {
  batchHistory,
  loadImportBatchHistoryWithContext,
  type ImportHistoryBatch,
  type ImportHistoryDetail,
} from "./import-history-service.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";

export type {
  ImportHistoryBatch,
  ImportHistoryDetail,
} from "./import-history-service.ts";

type ImportHistoryFailure = {
  ok: false;
  status: 400 | 401 | 404 | 503;
  message: string;
};

export type ImportHistoryListResult =
  { ok: true; history: ImportHistoryBatch[] } | ImportHistoryFailure;

export type ImportHistoryDetailResult =
  { ok: true; detail: ImportHistoryDetail } | ImportHistoryFailure;

function historyContextFailure(context: {
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
}): ImportHistoryFailure {
  return {
    ok: false,
    status: context.status === 401 ? 401 : context.status === 404 ? 404 : 503,
    message: context.message,
  };
}

export async function loadImportHistoryAction(): Promise<ImportHistoryListResult> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return historyContextFailure(context);
  try {
    const batches = await createOwnedImportStagingRepository(
      context.client,
    ).listBatches(context.userId);
    return { ok: true, history: batches.map(batchHistory) };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Import history is temporarily unavailable.",
    };
  }
}

export async function loadImportBatchHistoryAction(
  batchId: string,
  offset = 0,
): Promise<ImportHistoryDetailResult> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return historyContextFailure(context);
  try {
    const detail = await loadImportBatchHistoryWithContext(
      context,
      batchId,
      offset,
    );
    if (!detail) {
      return { ok: false, status: 404, message: "Import batch not found." };
    }
    return { ok: true, detail };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Import batch history is temporarily unavailable.",
    };
  }
}
