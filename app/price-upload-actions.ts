import { getAuthenticatedSqlContext } from "./portfolio-actions";
import {
  confirmBackupPriceUpload,
  confirmSinglePriceUpload,
  DEFAULT_SOURCE_LABEL,
  deleteOwnedPriceUpload,
  exportOwnerPriceHistoryCsv,
  listOwnedPriceUploads,
  previewBackupPriceUpload,
  previewSinglePriceUpload,
  type BackupConfirmResult,
  type BackupUploadPreview,
  type PriceUploadContext,
  type SinglePriceUploadConfirmResult,
  type SinglePriceUploadPreview,
} from "./price-upload-service";
import type { PriceUploadBatchRecord } from "../db/repositories/price-uploads.ts";

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

// A single owner-uploaded price CSV is one security's full history -- much
// smaller than the ledger CSV's multi-portfolio-transaction scope, so a flat
// 8 MiB request-body ceiling (well above `price-csv.ts`'s own 2 MiB file
// cap, leaving room for multipart overhead) is enough without a runtime-plan
// lookup the way `assessCsvImportUploadStart` needs.
const MAX_UPLOAD_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_BACKUP_REQUEST_BYTES = 24 * 1024 * 1024;

function tooLarge(contentLength: number | null, ceiling: number): boolean {
  return contentLength !== null && contentLength > ceiling;
}

async function readFileField(
  request: Request,
  ceiling: number,
): Promise<
  | { ok: true; bytes: Uint8Array; filename: string; form: FormData }
  | ActionFailure
> {
  if (
    tooLarge(
      Number(request.headers.get("content-length") ?? "0") || null,
      ceiling,
    )
  ) {
    return { ok: false, status: 413, message: "The file is too large." };
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, status: 400, message: "The upload could not be read." };
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return { ok: false, status: 400, message: "Choose a file to upload." };
  }
  if (file.size > ceiling) {
    return { ok: false, status: 413, message: "The file is too large." };
  }
  return {
    ok: true,
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name,
    form,
  };
}

function settingsFromForm(form: FormData) {
  return {
    exchangeAlias: String(form.get("exchangeAlias") ?? "ASX").trim() || "ASX",
    currencyCode: String(form.get("currencyCode") ?? "AUD").trim() || "AUD",
  };
}

export async function previewSinglePriceUploadAction(
  request: Request,
): Promise<{ ok: true; preview: SinglePriceUploadPreview } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readFileField(request, MAX_UPLOAD_REQUEST_BYTES);
  if (!read.ok) return read;
  const sqlContext: PriceUploadContext = {
    client: context.client,
    userId: context.userId,
  };
  return previewSinglePriceUpload(
    sqlContext,
    read.bytes,
    settingsFromForm(read.form),
  );
}

export async function confirmSinglePriceUploadAction(
  request: Request,
): Promise<
  { ok: true; batch: PriceUploadBatchRecord; written: number } | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readFileField(request, MAX_UPLOAD_REQUEST_BYTES);
  if (!read.ok) return read;
  const sqlContext: PriceUploadContext = {
    client: context.client,
    userId: context.userId,
  };
  const sourceLabel = String(
    read.form.get("sourceLabel") ?? DEFAULT_SOURCE_LABEL,
  );
  const result:
    { ok: true; value: SinglePriceUploadConfirmResult } | ActionFailure =
    await confirmSinglePriceUpload(
      sqlContext,
      read.bytes,
      settingsFromForm(read.form),
      { filename: read.filename, sourceLabel },
    );
  if (!result.ok) return result;
  return { ok: true, batch: result.value.batch, written: result.value.written };
}

export async function previewBackupPriceUploadAction(
  request: Request,
): Promise<{ ok: true; preview: BackupUploadPreview } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readFileField(request, MAX_BACKUP_REQUEST_BYTES);
  if (!read.ok) return read;
  const sqlContext: PriceUploadContext = {
    client: context.client,
    userId: context.userId,
  };
  return previewBackupPriceUpload(sqlContext, read.bytes);
}

export async function confirmBackupPriceUploadAction(request: Request): Promise<
  | {
      ok: true;
      batch: PriceUploadBatchRecord;
      written: number;
      unresolvedRowCount: number;
    }
  | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readFileField(request, MAX_BACKUP_REQUEST_BYTES);
  if (!read.ok) return read;
  const sqlContext: PriceUploadContext = {
    client: context.client,
    userId: context.userId,
  };
  const result: { ok: true; value: BackupConfirmResult } | ActionFailure =
    await confirmBackupPriceUpload(sqlContext, read.bytes, {
      filename: read.filename,
    });
  if (!result.ok) return result;
  return {
    ok: true,
    batch: result.value.batch,
    written: result.value.written,
    unresolvedRowCount: result.value.unresolvedRowCount,
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
