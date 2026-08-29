import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";
import {
  confirmBackupPriceUpload,
  confirmSinglePriceUpload,
  DEFAULT_SOURCE_LABEL,
  deleteOwnedPriceUpload,
  exportOwnerPriceHistoryCsv,
  exportOwnerPriceHistoryPage,
  listOwnedPriceUploads,
  previewBackupPriceUpload,
  previewSinglePriceUpload,
  type BackupConfirmResult,
  type BackupUploadPreview,
  type PriceUploadContext,
  type SinglePriceUploadConfirmResult,
  type SinglePriceUploadPreview,
} from "./price-upload-service";
import {
  filenameFromBody,
  MAX_BACKUP_REQUEST_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  readJsonBody,
  settingsFromBody,
} from "./price-upload-request-body.ts";
import type { PriceUploadBatchRecord } from "../db/repositories/price-uploads.ts";

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

export async function previewSinglePriceUploadAction(
  request: Request,
): Promise<{ ok: true; preview: SinglePriceUploadPreview } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readJsonBody(request, MAX_UPLOAD_REQUEST_BYTES);
  if (!read.ok) return read;
  const sqlContext: PriceUploadContext = {
    client: context.client,
    userId: context.userId,
  };
  return previewSinglePriceUpload(
    sqlContext,
    {
      ticker: read.body.ticker,
      rows: read.body.rows,
      malformedCount: read.body.malformedCount,
    },
    settingsFromBody(read.body),
  );
}

export async function confirmSinglePriceUploadAction(request: Request): Promise<
  | {
      ok: true;
      batch: PriceUploadBatchRecord;
      written: number;
      unchangedCount: number;
    }
  | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readJsonBody(request, MAX_UPLOAD_REQUEST_BYTES);
  if (!read.ok) return read;
  const sqlContext: PriceUploadContext = {
    client: context.client,
    userId: context.userId,
  };
  const sourceLabel =
    typeof read.body.sourceLabel === "string"
      ? read.body.sourceLabel
      : DEFAULT_SOURCE_LABEL;
  const result:
    { ok: true; value: SinglePriceUploadConfirmResult } | ActionFailure =
    await confirmSinglePriceUpload(
      sqlContext,
      {
        ticker: read.body.ticker,
        rows: read.body.rows,
        malformedCount: read.body.malformedCount,
      },
      settingsFromBody(read.body),
      { filename: filenameFromBody(read.body), sourceLabel },
    );
  if (!result.ok) return result;
  return {
    ok: true,
    batch: result.value.batch,
    written: result.value.written,
    unchangedCount: result.value.unchangedCount,
  };
}

export async function previewBackupPriceUploadAction(
  request: Request,
): Promise<{ ok: true; preview: BackupUploadPreview } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readJsonBody(request, MAX_BACKUP_REQUEST_BYTES);
  if (!read.ok) return read;
  const sqlContext: PriceUploadContext = {
    client: context.client,
    userId: context.userId,
  };
  return previewBackupPriceUpload(sqlContext, {
    rows: read.body.rows,
    malformedByReason: read.body.malformedByReason,
  });
}

export async function confirmBackupPriceUploadAction(request: Request): Promise<
  | {
      ok: true;
      batch: PriceUploadBatchRecord;
      written: number;
      unresolvedRowCount: number;
      unchangedCount: number;
    }
  | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readJsonBody(request, MAX_BACKUP_REQUEST_BYTES);
  if (!read.ok) return read;
  const sqlContext: PriceUploadContext = {
    client: context.client,
    userId: context.userId,
  };
  // Review B2 fix (BLOCKING, 2026-08-28): only the EXP-003 chunked restore
  // caller (`system-backup-panel.tsx`) sends `chunked: true` -- see
  // `confirmBackupPriceUpload`'s `tolerateAllUnresolved` doc comment for why
  // this must NOT apply to the standalone MKT-008 whole-file restore.
  const result: { ok: true; value: BackupConfirmResult } | ActionFailure =
    await confirmBackupPriceUpload(
      sqlContext,
      { rows: read.body.rows, malformedByReason: read.body.malformedByReason },
      {
        filename: filenameFromBody(read.body),
        tolerateAllUnresolved: read.body.chunked === true,
      },
    );
  if (!result.ok) return result;
  return {
    ok: true,
    batch: result.value.batch,
    written: result.value.written,
    unresolvedRowCount: result.value.unresolvedRowCount,
    unchangedCount: result.value.unchangedCount,
  };
}

export async function listPriceUploadsAction(): Promise<
  { ok: true; batches: PriceUploadBatchRecord[] } | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const batches = await listOwnedPriceUploads({
    client: context.client,
    userId: context.userId,
  });
  return { ok: true, batches };
}

export async function deletePriceUploadAction(
  batchId: string,
): Promise<{ ok: true; deletedObservations: number } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  if (!batchId || batchId.length > 100) {
    return { ok: false, status: 400, message: "Upload identifier is invalid." };
  }
  const result = await deleteOwnedPriceUpload(
    { client: context.client, userId: context.userId },
    batchId,
  );
  if (!result.ok) return result;
  return { ok: true, deletedObservations: result.deletedObservations };
}

export async function exportPriceHistoryAction(): Promise<
  { ok: true; csv: string } | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const csv = await exportOwnerPriceHistoryCsv({
    client: context.client,
    userId: context.userId,
  });
  return { ok: true, csv };
}

export async function exportPriceHistoryPageAction(offset: number): Promise<
  | {
      ok: true;
      rows: Awaited<ReturnType<typeof exportOwnerPriceHistoryPage>>["rows"];
      nextOffset: number | null;
    }
  | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const page = await exportOwnerPriceHistoryPage(
    { client: context.client, userId: context.userId },
    offset,
  );
  return { ok: true, ...page };
}
