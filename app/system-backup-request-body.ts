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

// ---------------------------------------------------------------------------
// EXP-004: the resumable, chunked core-restore protocol
// (`app/system-backup-service.ts`'s `commitSystemBackupCoreScaffold`/
// `commitSystemBackupTransactionsPart`/`commitSystemBackupDividendsPart`/
// `commitSystemBackupFinalizePortfolio`). Every field below is shaped only
// loosely here (basic type guards) -- IMP-010B's real, DEEP structural
// validation (`validateSystemBackup`/`validateTransaction`/
// `validateDividendManualRecord`) happens in the service layer, which has DB
// access to cross-check referential facts this layer cannot. This module's
// job is only to safely narrow an arbitrary JSON body into a typed shape
// without throwing.
// ---------------------------------------------------------------------------

export type SystemBackupCorePartPhase =
  "scaffold" | "transactions" | "dividends" | "finalize";

export type ScaffoldSecurityWire = { ref: string; portfolioSecurityId: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Every phase after `scaffold` carries the same three identifiers the
 * scaffold response returned -- parsed once, reused by every phase parser
 * below. */
function corePartIdentity(
  body: Record<string, unknown>,
): { portfolioId: string; batchId: string; fingerprint: string } | null {
  if (
    !isNonEmptyString(body.portfolioId) ||
    !isNonEmptyString(body.batchId) ||
    !isNonEmptyString(body.fingerprint)
  ) {
    return null;
  }
  return {
    portfolioId: body.portfolioId,
    batchId: body.batchId,
    fingerprint: body.fingerprint,
  };
}

/** Parses the `securities` id-map every non-scaffold phase carries (echoed
 * back by the browser from an earlier scaffold response) -- rejects the
 * WHOLE part if any entry is malformed, never silently drops one (a dropped
 * entry would make a later legitimate `securityRef` fail to resolve, read
 * as a data problem rather than the request-shaping bug it would actually
 * be). */
export function parseScaffoldSecuritiesWire(
  raw: unknown,
): ScaffoldSecurityWire[] | null {
  if (!Array.isArray(raw)) return null;
  const securities: ScaffoldSecurityWire[] = [];
  for (const item of raw) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      !isNonEmptyString((item as Record<string, unknown>).ref) ||
      !isNonEmptyString((item as Record<string, unknown>).portfolioSecurityId)
    ) {
      return null;
    }
    securities.push({
      ref: (item as Record<string, unknown>).ref as string,
      portfolioSecurityId: (item as Record<string, unknown>)
        .portfolioSecurityId as string,
    });
  }
  return securities;
}

export type SystemBackupCorePartRequest =
  | { phase: "scaffold"; backup: unknown; filename: string }
  | {
      phase: "transactions";
      portfolioId: string;
      batchId: string;
      fingerprint: string;
      securities: ScaffoldSecurityWire[];
      transactions: unknown[];
    }
  | {
      phase: "dividends";
      portfolioId: string;
      batchId: string;
      fingerprint: string;
      securities: ScaffoldSecurityWire[];
      records: unknown[];
    }
  | {
      phase: "finalize";
      portfolioId: string;
      batchId: string;
      fingerprint: string;
      securities: ScaffoldSecurityWire[];
      dividendLinkage: unknown;
      dividendSecurityAssumptions: unknown;
      dividendPortfolioAssumption: unknown;
      dividendFyOverrides: unknown;
      dividendEventOverrides: unknown;
      dividendImportFrankingOverrides: unknown;
      whatifScenarios: unknown;
      portfolioStatus: unknown;
      transactionsCount: unknown;
      dividendRecordsCount: unknown;
    };

export function systemBackupCorePartFromBody(
  body: Record<string, unknown>,
):
  | { ok: true; value: SystemBackupCorePartRequest }
  | { ok: false; message: string } {
  const phase = body.phase;
  if (phase === "scaffold") {
    return {
      ok: true,
      value: {
        phase,
        backup: body.backup,
        filename: systemBackupFilenameFromBody(body),
      },
    };
  }
  if (
    phase === "transactions" ||
    phase === "dividends" ||
    phase === "finalize"
  ) {
    const identity = corePartIdentity(body);
    if (!identity) {
      return {
        ok: false,
        message: "This restore part is missing its portfolio/batch identity.",
      };
    }
    const securities = parseScaffoldSecuritiesWire(body.securities);
    if (!securities) {
      return {
        ok: false,
        message: "This restore part's security map is malformed.",
      };
    }
    if (phase === "transactions") {
      if (!Array.isArray(body.transactions)) {
        return {
          ok: false,
          message: "This restore part's transactions are malformed.",
        };
      }
      return {
        ok: true,
        value: {
          phase,
          ...identity,
          securities,
          transactions: body.transactions,
        },
      };
    }
    if (phase === "dividends") {
      if (!Array.isArray(body.records)) {
        return {
          ok: false,
          message: "This restore part's dividend records are malformed.",
        };
      }
      return {
        ok: true,
        value: { phase, ...identity, securities, records: body.records },
      };
    }
    return {
      ok: true,
      value: {
        phase,
        ...identity,
        securities,
        dividendLinkage: body.dividendLinkage,
        dividendSecurityAssumptions: body.dividendSecurityAssumptions,
        dividendPortfolioAssumption: body.dividendPortfolioAssumption,
        dividendFyOverrides: body.dividendFyOverrides,
        dividendEventOverrides: body.dividendEventOverrides,
        dividendImportFrankingOverrides: body.dividendImportFrankingOverrides,
        whatifScenarios: body.whatifScenarios,
        portfolioStatus: body.portfolioStatus,
        transactionsCount: body.transactionsCount,
        dividendRecordsCount: body.dividendRecordsCount,
      },
    };
  }
  return {
    ok: false,
    message: "This restore request's phase is not recognized.",
  };
}
