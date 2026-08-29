// Review B1 fix (BLOCKING, 2026-08-28): pure, `next/headers`-free helper
// that decides `mode=core`'s JSON response envelope from the action's
// result -- split out of `route.ts` ONLY so this exact shape can be
// exercised by a real behavioural test under the plain Node test runner,
// which cannot resolve `next/headers` (transitively imported by
// `system-backup-actions.ts` -> `portfolio-actions.ts`; importing `route.ts`
// itself therefore also fails under that runner) -- see
// `app/price-upload-request-body.ts`'s header comment for the identical,
// pre-existing constraint this mirrors.
//
// The original bug: this branch returned `JSON.stringify(result.backup)` (a
// bare object with no `ok` field) instead of the action's own `{ ok: true,
// backup }` envelope. The browser panel's `fetchJson`
// (`system-backup-panel.tsx`) discriminates every response on a top-level
// `ok` field; `SystemBackupV1` has none, so every core-mode fetch silently
// resolved as `{ ok: false, message: undefined }` and produced no file --
// the owner had NO working export path. `route.ts` now passes `result`
// through unchanged (matching the pre-existing `mode=prices` branch's own
// shape); this module exists purely to make that pass-through testable.
import type { SystemBackupV1 } from "../../../../domain/exports/system-backup.ts";

type SystemBackupExportActionFailure = Readonly<{
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
}>;

export type SystemBackupCoreExportResult =
  | Readonly<{ ok: true; backup: SystemBackupV1 }>
  | SystemBackupExportActionFailure;

export function systemBackupCoreExportResponseShape(
  result: SystemBackupCoreExportResult,
): { body: SystemBackupCoreExportResult; status: number } {
  return { body: result, status: result.ok ? 200 : result.status };
}
