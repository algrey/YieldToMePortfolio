// EXP-002: request-body parsing for the full-system backup import actions,
// split out DB/auth-free -- mirrors `app/portfolio-bundle-request-body.ts`'s
// identical split/rationale (testability under the plain Node test runner,
// which cannot resolve `next/headers`).
import { MAX_SYSTEM_BACKUP_REQUEST_BYTES } from "../domain/exports/system-backup.ts";

export type SystemBackupRequestFailure = Readonly<{
  ok: false;
  status: 400 | 413;
  message: string;
}>;

const MAX_FILENAME_LENGTH = 255;

/** Mirrors `portfolio-bundle-request-body.ts`'s `readBundleRequestBody`
 * byte-accounting discipline exactly (measures the ACTUAL received body,
 * never trusts `content-length` alone). */
export async function readSystemBackupRequestBody(
  request: Request,
): Promise<
  { ok: true; body: Record<string, unknown> } | SystemBackupRequestFailure
> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SYSTEM_BACKUP_REQUEST_BYTES
  ) {
    return { ok: false, status: 413, message: "The backup file is too large." };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      status: 400,
      message: "The backup file could not be read.",
    };
  }
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_SYSTEM_BACKUP_REQUEST_BYTES) {
    return { ok: false, status: 413, message: "The backup file is too large." };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: 400,
      message: "The backup file could not be read.",
    };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      message: "The backup file could not be read.",
    };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

export function systemBackupFilenameFromBody(
  body: Record<string, unknown>,
): string {
  const filename =
    typeof body.filename === "string" ? body.filename.trim() : "";
  return filename.length > 0
    ? filename.slice(0, MAX_FILENAME_LENGTH)
    : "system-backup.json";
}

export function systemBackupFromBody(body: Record<string, unknown>): unknown {
  return body.backup;
}
