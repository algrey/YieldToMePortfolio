// EXP-002/EXP-004: request-handling actions for the full-system backup,
// mirroring `app/portfolio-bundle-actions.ts`'s split (this module owns
// `getAuthenticatedSqlContext`/`next/headers`-dependent wiring; the DB-free
// validation/orchestration lives in `app/system-backup-service.ts` and
// `domain/exports/system-backup.ts` so they stay testable under the plain
// Node test runner).
//
// EXP-004: the CORE restore's HTTP surface is now the resumable, chunked
// scaffold/transactions/dividends/finalize protocol
// (`commitSystemBackupCorePartAction`) -- the old single-request whole-core
// `commitSystemBackupImportAction` is REMOVED from this module (and from
// `/api/system-backup/import/commit`'s dispatch) because exposing it would
// let a restore hit the exact CPU-budget production incident EXP-004 fixes.
// `commitSystemBackupImport` (the underlying service function it used to
// call) still exists in `system-backup-service.ts`, composing the SAME
// granular functions this action now calls piecewise -- kept only as a
// non-HTTP convenience for tests, per that module's own EXP-004 comment.
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";
import {
  readSystemBackupRequestBody,
  systemBackupCorePartFromBody,
  systemBackupFromBody,
} from "./system-backup-request-body.ts";
import {
  commitSystemBackupCoreScaffold,
  commitSystemBackupTransactionsPart,
  commitSystemBackupDividendsPart,
  commitSystemBackupFinalizePortfolioFromWire,
  exportSystemBackup,
  exportSystemBackupCore,
  previewSystemBackupImport,
  type SystemBackupPreview,
  type SystemBackupScaffoldResult,
} from "./system-backup-service.ts";
import type { SystemBackupV1 } from "../domain/exports/system-backup.ts";
import { emitStructuredLog } from "../domain/observability/logger.ts";

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

export type SystemBackupCorePartActionResult =
  | { ok: true; phase: "scaffold"; result: SystemBackupScaffoldResult }
  | {
      ok: true;
      phase: "transactions" | "dividends";
      result: { committedCount: number };
    }
  | {
      ok: true;
      phase: "finalize";
      result: { skippedDividendEventOverrides: number };
    }
  | ActionFailure;

/** EXP-004: ONE action dispatching all four core-restore phases by the
 * request body's own `phase` field -- see `system-backup-request-body.ts`'s
 * `systemBackupCorePartFromBody` for the wire shape. Every phase re-validates
 * its own inputs server-side (IMP-010B); this action does no more than route
 * to the already-authenticated, already-validating service functions. */
export async function commitSystemBackupCorePartAction(
  request: Request,
): Promise<SystemBackupCorePartActionResult> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readSystemBackupRequestBody(request);
  if (!read.ok) return read;
  const parsed = systemBackupCorePartFromBody(read.body);
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message };
  const ctx = {
    client: context.client,
    userId: context.userId,
    requestId: context.requestId,
  };
  const value = parsed.value;
  // EXP-004 diagnostics: a request killed by the platform (CPU eviction)
  // emits NO completion log of its own, so a phase-entry line is the only
  // way `wrangler tail` can attribute such a death to a specific restore
  // phase. Metadata is counts only -- never row contents or money values.
  emitStructuredLog({
    event: "restore.core",
    action: `phase.${value.phase}.start`,
    result: "success",
    requestId: context.requestId,
    // (scaffold's `backup` is still `unknown` here -- validated inside the
    // service -- so its entry log carries no counts.)
    metadata:
      value.phase === "transactions"
        ? { rows: value.transactions.length }
        : value.phase === "dividends"
          ? { rows: value.records.length }
          : {},
  });
  const outcome =
    await (async (): Promise<SystemBackupCorePartActionResult> => {
      if (value.phase === "scaffold") {
        const result = await commitSystemBackupCoreScaffold(
          ctx,
          value.backup,
          value.filename,
        );
        return result.ok
          ? { ok: true, phase: "scaffold", result: result.result }
          : result;
      }
      if (value.phase === "transactions") {
        const result = await commitSystemBackupTransactionsPart(ctx, value);
        return result.ok
          ? { ok: true, phase: "transactions", result: result.result }
          : result;
      }
      if (value.phase === "dividends") {
        const result = await commitSystemBackupDividendsPart(ctx, value);
        return result.ok
          ? { ok: true, phase: "dividends", result: result.result }
          : result;
      }
      const result = await commitSystemBackupFinalizePortfolioFromWire(
        ctx,
        value,
      );
      return result.ok
        ? { ok: true, phase: "finalize", result: result.result }
        : result;
    })();
  emitStructuredLog({
    level: outcome.ok ? "info" : "warn",
    event: "restore.core",
    action: `phase.${value.phase}.finish`,
    result: outcome.ok ? "success" : "failure",
    requestId: context.requestId,
    metadata: outcome.ok ? {} : { status: outcome.status },
  });
  return outcome;
}
