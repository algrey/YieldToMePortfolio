// EXP-002: request-handling actions for the full-system backup, mirroring
// `app/portfolio-bundle-actions.ts`'s split (this module owns
// `getAuthenticatedSqlContext`/`next/headers`-dependent wiring; the DB-free
// validation/orchestration lives in `app/system-backup-service.ts` and
// `domain/exports/system-backup.ts` so they stay testable under the plain
// Node test runner).
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";
import {
  readSystemBackupRequestBody,
  systemBackupFilenameFromBody,
  systemBackupFromBody,
} from "./system-backup-request-body.ts";
import {
  commitSystemBackupImport,
  exportSystemBackup,
  exportSystemBackupCore,
  previewSystemBackupImport,
  type SystemBackupCommitResult,
  type SystemBackupPreview,
} from "./system-backup-service.ts";
import type { SystemBackupV1 } from "../domain/exports/system-backup.ts";

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

export async function exportSystemBackupAction(): Promise<
  { ok: true; backup: SystemBackupV1 } | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  return exportSystemBackup({
    client: context.client,
    userId: context.userId,
    requestId: context.requestId,
  });
}

export async function exportSystemBackupCoreAction(): Promise<
  { ok: true; backup: SystemBackupV1 } | ActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  return exportSystemBackupCore({
    client: context.client,
    userId: context.userId,
    requestId: context.requestId,
  });
}

export async function previewSystemBackupImportAction(
  request: Request,
): Promise<{ ok: true; preview: SystemBackupPreview } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readSystemBackupRequestBody(request);
  if (!read.ok) return read;
  return previewSystemBackupImport(
    {
      client: context.client,
      userId: context.userId,
      requestId: context.requestId,
    },
    systemBackupFromBody(read.body),
  );
}

export async function commitSystemBackupImportAction(
  request: Request,
): Promise<{ ok: true; result: SystemBackupCommitResult } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readSystemBackupRequestBody(request);
  if (!read.ok) return read;
  return commitSystemBackupImport(
    {
      client: context.client,
      userId: context.userId,
      requestId: context.requestId,
    },
    systemBackupFromBody(read.body),
    systemBackupFilenameFromBody(read.body),
  );
}
