// EXP-002 (owner-directed, TASKS.md "### EXP-002"): the full-system backup's
// staged/previewed/validated/idempotent/batch-attributable/reversible
// orchestration (AGENTS.md's CSV non-negotiables, applied to a JSON artifact
// that NESTS EXP-001's own per-portfolio bundle format rather than
// reinventing it). Server is the SOLE validation authority (IMP-010B).
//
// DELIBERATE REUSE over reinvention -- every write below calls EXISTING,
// already-tested machinery unchanged:
//  - each nested portfolio is committed via EXP-001's OWN
//    `commitPortfolioBundleImport` (its idempotency, retry-on-failure, and
//    chain-replay logic are untouched and apply per portfolio exactly as
//    they do for a standalone EXP-001 import).
//  - the embedded price-history section is the pre-existing MKT-008 backup
//    CSV TEXT, parsed with the UNCHANGED `parsePriceBackupCsv` and written
//    with the UNCHANGED `confirmBackupPriceUpload` -- this module never
//    re-implements price-row parsing, resolution, or D1 write batching.
//
// PRECONDITION ("fresh account"): restore is rejected if the owner
// currently has any portfolio NOT accounted for by one of THIS backup's own
// nested bundles (`countUnrelatedPortfolios`, `db/repositories/
// system-backup.ts`) -- this is what makes retrying an INTERRUPTED restore
// safe while still refusing to merge into a populated, unrelated account.
// See `docs/BACKUP_FORMAT.md`.
//
// B1 ruling (reviewer, 2026-08-27): the realistic migration-restore failure
// is an INTERRUPTION mid-replay, not a clean "start over" -- so (1) the
// precondition treats a portfolio as RELATED to this backup when it is
// attributable to an `import_batches` row of ANY status (not only
// `committed`) matching one of this backup's own nested fingerprints, and
// (2) before each nested portfolio's retry (which resets a failed batch's
// `target_portfolio_id`), this module captures that batch's CURRENT
// leftover portfolio and archives it -- so a retry never accumulates
// unattributable orphan portfolios, and the account converges on exactly
// one live portfolio per nested bundle regardless of how many attempts it
// took.
//
// FAILURE ISOLATION: portfolios commit ONE AT A TIME, in the backup's own
// array order; the FIRST failure stops the whole commit immediately --
// account settings and any EARLIER portfolios already committed are left in
// place (never rolled back), watchlist and price-history are never even
// attempted. A retry of the identical backup resumes: earlier portfolios
// short-circuit as idempotent no-ops, and the failed one is retried via
// EXP-001's own failed-batch reuse (its own leftover partial portfolio
// archived first, per B1 above). This is "atomic per portfolio", not
// atomic for the whole artifact -- stated honestly, mirroring EXP-001's own
// documented lack of whole-bundle atomicity.
import {
  validateSystemBackup,
  type SystemBackupV1,
} from "../domain/exports/system-backup.ts";
import type { PortfolioBundleV1 } from "../domain/exports/portfolio-bundle.ts";
import { parsePriceBackupCsv } from "../domain/market-data/price-backup-csv.ts";
import {
  countUnrelatedPortfolios,
  findLeftoverPortfolioForRetry,
  readAccountSettingsForBackup,
  readWatchlistForBackup,
  restoreAccountSettings,
  restoreWatchlist,
  type WatchlistRestoreCounts,
} from "../db/repositories/system-backup.ts";
import { readPortfolioBundle } from "../db/repositories/portfolio-bundle.ts";
import { createOwnedPortfolioRepository } from "../db/repositories/owned-portfolios.ts";
import {
  commitPortfolioBundleImport,
  fingerprintBundle,
} from "./portfolio-bundle-service.ts";
import {
  confirmBackupPriceUpload,
  exportOwnerPriceHistoryCsv,
  previewBackupPriceUpload,
  type PriceUploadContext,
} from "./price-upload-service.ts";
import { MAX_BUNDLE_ENTITIES } from "../domain/exports/portfolio-bundle.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";

export type SystemBackupServiceContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

export type SystemBackupServiceFailure = {
  ok: false;
  status: 400 | 404 | 409 | 413;
  message: string;
};

function totalPortfolioEntities(bundle: {
  securities: readonly unknown[];
  transactions: readonly unknown[];
  dividendManualRecords: readonly unknown[];
  dividendSecurityAssumptions: readonly unknown[];
  dividendFyOverrides: readonly unknown[];
  dividendEventOverrides: readonly unknown[];
  dividendImportFrankingOverrides: readonly unknown[];
  whatifScenarios: readonly unknown[];
}): number {
  return (
    bundle.securities.length +
    bundle.transactions.length +
    bundle.dividendManualRecords.length +
    bundle.dividendSecurityAssumptions.length +
    bundle.dividendFyOverrides.length +
    bundle.dividendEventOverrides.length +
    bundle.dividendImportFrankingOverrides.length +
    bundle.whatifScenarios.length
  );
}

export async function exportSystemBackup(
  ctx: SystemBackupServiceContext,
): Promise<{ ok: true; backup: SystemBackupV1 } | SystemBackupServiceFailure> {
  const settings = await readAccountSettingsForBackup(ctx.client, ctx.userId);
  if (!settings) {
    return {
      ok: false,
      status: 404,
      message: "Account settings were not found.",
    };
  }
  const watchlistEntries = await readWatchlistForBackup(ctx.client, ctx.userId);

  // EXP-002 review (B2 ruling): archived portfolios are DATA, not noise --
  // included alongside active ones. `readPortfolioBundle` now carries each
  // portfolio's own `status` (EXP-001 format addition), and
  // `commitPortfolioBundleImport` restores an archived source AS archived
  // (see that function's own comment) -- so an archived portfolio round-
  // trips archived, never silently resurrected as active.
  const portfolioRecords = await createOwnedPortfolioRepository(
    ctx.client,
  ).list(ctx.userId, { includeArchived: true });
  const exportedAt = new Date().toISOString();
  const portfolios: PortfolioBundleV1[] = [];
  for (const record of portfolioRecords) {
    const bundle = await readPortfolioBundle(
      ctx.client,
      ctx.userId,
      record.id,
      exportedAt,
    );
    if (totalPortfolioEntities(bundle) > MAX_BUNDLE_ENTITIES) {
      // Same honest early-warning EXP-001's own `exportPortfolioBundle`
      // gives for a single portfolio, applied here so the owner learns
      // BEFORE downloading a system backup that could never fully restore.
      return {
        ok: false,
        status: 413,
        message: `Portfolio "${record.name}" has ${totalPortfolioEntities(bundle)} bundle entries, over the ${MAX_BUNDLE_ENTITIES} this app version can restore from a bundle. This system backup would not be fully restorable.`,
      };
    }
    portfolios.push(bundle);
  }

  const priceBackupCsv = await exportOwnerPriceHistoryCsv({
    client: ctx.client,
    userId: ctx.userId,
  });

  return {
    ok: true,
    backup: {
      schemaVersion: 1,
      exportedAt,
      account: settings,
      watchlistEntries,
      portfolios,
      priceBackupCsv,
    },
  };
}

export type SystemBackupPreview = {
  // The backup's OWN recorded settings, echoed back verbatim (the browser
  // already has these from the parsed file, but returning them here too
  // keeps the preview response self-contained for the UI's "current ->
  // new" disclosure -- see `currentAccount` below).
  account: SystemBackupV1["account"];
  /** S2 fold: the account's CURRENT settings (read live, zero writes) --
   * `null` only if account settings are somehow missing (should not happen
   * for an authenticated owner; the commit path would fail the same way).
   * Paired with `account` above so the UI can disclose "current -> new" per
   * field before the owner confirms an unconditional overwrite. */
  currentAccount: SystemBackupV1["account"] | null;
  watchlistCounts: { securities: number; currencyPairs: number };
  portfolios: ReadonlyArray<{
    name: string;
    code: string;
    status: "active" | "archived";
    baseCurrencyMismatch: boolean;
    counts: {
      securities: number;
      transactions: number;
      dividendManualRecords: number;
      whatifScenarios: number;
    };
  }>;
  priceBackup: { rowCount: number; malformedCount: number };
  precondition: { fresh: boolean; unrelatedPortfolioCount: number };
};

export async function previewSystemBackupImport(
  ctx: SystemBackupServiceContext,
  raw: unknown,
): Promise<
  { ok: true; preview: SystemBackupPreview } | SystemBackupServiceFailure
> {
  const validation = validateSystemBackup(raw);
  if (!validation.ok)
    return { ok: false, status: 400, message: validation.message };
  const backup = validation.backup;

  const fingerprints = await Promise.all(
    backup.portfolios.map((bundle) => fingerprintBundle(bundle)),
  );
  const unrelatedPortfolioCount = await countUnrelatedPortfolios(
    ctx.client,
    ctx.userId,
    fingerprints,
  );
  const currentAccount = await readAccountSettingsForBackup(
    ctx.client,
    ctx.userId,
  );

  const parsedPrice = parsePriceBackupCsv(
    new TextEncoder().encode(backup.priceBackupCsv),
  );
  // Zero DB writes for this preview -- the price-history section is
  // reported by RAW parse counts only (never resolved against the owner's
  // securities: those do not exist yet at preview time, before any
  // portfolio has been committed, so an "unresolved" figure here would be
  // structurally misleading, not informative).
  const priceBackup = parsedPrice.ok
    ? {
        rowCount: parsedPrice.rows.length,
        malformedCount: parsedPrice.malformed.length,
      }
    : { rowCount: 0, malformedCount: 0 };

  return {
    ok: true,
    preview: {
      account: backup.account,
      currentAccount,
      watchlistCounts: {
        securities: backup.watchlistEntries.filter((e) => e.kind === "security")
          .length,
        currencyPairs: backup.watchlistEntries.filter(
          (e) => e.kind === "currency_pair",
        ).length,
      },
      portfolios: backup.portfolios.map((bundle) => ({
        name: bundle.portfolio.name,
        code: bundle.portfolio.code,
        status: bundle.portfolio.status,
        baseCurrencyMismatch:
          bundle.portfolio.baseCurrencyCode !== backup.account.homeCurrencyCode,
        counts: {
          securities: bundle.securities.length,
          transactions: bundle.transactions.length,
          dividendManualRecords: bundle.dividendManualRecords.length,
          whatifScenarios: bundle.whatifScenarios.length,
        },
      })),
      priceBackup,
      precondition: {
        fresh: unrelatedPortfolioCount === 0,
        unrelatedPortfolioCount,
      },
    },
  };
}

export type SystemBackupCommitResult = {
  portfolios: ReadonlyArray<{
    name: string;
    code: string;
    idempotent: boolean;
    portfolioId: string;
  }>;
  watchlist: WatchlistRestoreCounts;
  priceBackup: {
    written: number;
    unresolvedRowCount: number;
    malformedCount: number;
    unchangedCount: number;
    /** S3 fold: set (non-null) when the section had rows in the file but
     * NONE resolved to a security this restore could match -- an honest,
     * non-fatal outcome (see the price-history block's own comment), never
     * silently indistinguishable from "no price history in this backup at
     * all" (`priceBackup: null`). */
    note: string | null;
  } | null;
};

/** B1 ruling: archives a leftover portfolio from an earlier failed/
 * interrupted attempt at ONE nested bundle, before that bundle is retried
 * (which would otherwise re-point the batch's `target_portfolio_id` at a
 * NEW portfolio, leaving the old one an unattributable orphan -- see
 * `findLeftoverPortfolioForRetry`'s own comment). Failing to archive it is
 * treated as a hard failure for the whole commit: proceeding anyway would
 * let the account silently accumulate a duplicate, un-cleaned-up portfolio
 * that a later restore attempt could no longer even find via this
 * fingerprint.
 */
async function archiveLeftoverPortfolio(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  requestId: string,
): Promise<{ ok: true } | { ok: false }> {
  const current = await client.get<{ version: number }>(
    "SELECT version FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
    [portfolioId, userId],
  );
  // Already gone (e.g. the owner manually cleaned it up already) -- nothing
  // left to archive, not a failure.
  if (!current) return { ok: true };
  const result = await createOwnedPortfolioRepository(client, undefined, {
    requestId,
  }).archive(userId, portfolioId, { expectedVersion: current.version });
  return result.ok ? { ok: true } : { ok: false };
}

export async function commitSystemBackupImport(
  ctx: SystemBackupServiceContext,
  raw: unknown,
  filename: string,
): Promise<
  { ok: true; result: SystemBackupCommitResult } | SystemBackupServiceFailure
> {
  const validation = validateSystemBackup(raw);
  if (!validation.ok)
    return { ok: false, status: 400, message: validation.message };
  const backup = validation.backup;

  const fingerprints = await Promise.all(
    backup.portfolios.map((bundle) => fingerprintBundle(bundle)),
  );
  const unrelatedPortfolioCount = await countUnrelatedPortfolios(
    ctx.client,
    ctx.userId,
    fingerprints,
  );
  if (unrelatedPortfolioCount > 0) {
    return {
      ok: false,
      status: 409,
      message: `This account already has ${unrelatedPortfolioCount} portfolio(s) unrelated to this backup. Full-system restore requires a fresh account (no existing portfolios outside this backup) -- archive or export/remove them first, or restore into a fresh deployment.`,
    };
  }

  const settingsResult = await restoreAccountSettings(
    ctx.client,
    ctx.userId,
    backup.account,
    ctx.requestId,
  );
  if (!settingsResult.ok) {
    return {
      ok: false,
      status: 409,
      message: "Account settings could not be restored.",
    };
  }

  const portfolioResults: Array<{
    name: string;
    code: string;
    idempotent: boolean;
    portfolioId: string;
  }> = [];
  for (const [index, bundle] of backup.portfolios.entries()) {
    // B1 ruling: capture (and archive) any leftover portfolio from an
    // earlier failed/interrupted attempt at THIS bundle BEFORE calling
    // `commitPortfolioBundleImport`, which would otherwise reset the
    // batch's `target_portfolio_id` as part of its own retry-reuse,
    // orphaning the leftover portfolio beyond this point.
    const leftover = await findLeftoverPortfolioForRetry(
      ctx.client,
      ctx.userId,
      fingerprints[index]!,
    );
    if (leftover) {
      const archived = await archiveLeftoverPortfolio(
        ctx.client,
        ctx.userId,
        leftover.portfolioId,
        ctx.requestId,
      );
      if (!archived.ok) {
        return {
          ok: false,
          status: 409,
          message: `Portfolio #${index + 1} ("${bundle.portfolio.name}") has a leftover partial portfolio from an earlier attempt that could not be cleaned up automatically. ${portfolioResults.length} of ${backup.portfolios.length} portfolio(s) in this backup were already restored and remain in place. Re-run this restore after resolving the issue to resume.`,
        };
      }
    }
    const result = await commitPortfolioBundleImport(
      {
        client: ctx.client,
        userId: ctx.userId,
        requestId: ctx.requestId,
      },
      bundle,
      filename,
      // Byte length is only used for the `import_batches.byte_size`
      // bookkeeping column -- reconstructing the nested bundle's own JSON
      // length is more honest than the whole-artifact byte length.
      new TextEncoder().encode(JSON.stringify(bundle)).length,
    );
    if (!result.ok) {
      return {
        ok: false,
        status: 409,
        message: `Portfolio #${index + 1} ("${bundle.portfolio.name}") could not be restored: ${result.message} ${portfolioResults.length} of ${backup.portfolios.length} portfolio(s) in this backup were already restored and remain in place. Re-run this restore after resolving the issue to resume -- any leftover partial portfolio from this attempt is archived automatically on the next retry.`,
      };
    }
    // The ACTUAL persisted code, not `bundle.portfolio.code` -- EXP-001's
    // own `commitPortfolioBundleImport` silently falls back to a
    // `-restored`-suffixed code on a collision (`portfolios_user_id_code_
    // unique` is unconditional, not status-scoped, so even an ARCHIVED
    // leftover from an earlier attempt at THIS SAME bundle can collide with
    // its own requested code) -- reporting the requested code instead of
    // what was actually stored would be a real (if minor) inaccuracy.
    const persisted = await ctx.client.get<{ code: string }>(
      "SELECT code FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
      [result.result.portfolioId, ctx.userId],
    );
    portfolioResults.push({
      name: result.result.portfolioName,
      code: persisted?.code ?? bundle.portfolio.code,
      idempotent: result.result.idempotent,
      portfolioId: result.result.portfolioId,
    });
  }

  const watchlist = await restoreWatchlist(
    ctx.client,
    ctx.userId,
    backup.watchlistEntries,
    ctx.requestId,
  );

  // A genuinely empty section (`""`, never produced by `exportSystemBackup`
  // itself -- `formatPriceBackupCsv` always writes at least the header row
  // -- but a hand-edited/older file could carry one) means "no price
  // history to restore", not an error: skip entirely, `priceBackup` stays
  // `null`. A header-only export (real zero-row case) is handled the same
  // way below once parsed.
  //
  // S3 fold: `confirmBackupPriceUpload` itself hard-fails when NO row
  // resolves to a security this owner holds -- correct for a STANDALONE
  // price-backup restore (nothing to do IS suspicious there, since the
  // owner is uploading into an account that presumably already holds the
  // relevant securities) but wrong for THIS artifact: a system restore's
  // price section can legitimately have rows that fail to resolve (a
  // security genuinely wasn't restorable -- see the watch-only-security
  // limitation's identical reasoning) while every OTHER piece of the backup
  // still committed successfully. This module previews resolution FIRST
  // (zero DB writes) so it can apply the SAME "no usable price history is a
  // legitimate outcome, never a fatal error" rule the empty-file case above
  // already uses, rather than letting a downstream 400 from
  // `confirmBackupPriceUpload` turn an otherwise-successful restore into an
  // overall failure.
  let priceBackup: SystemBackupCommitResult["priceBackup"] = null;
  if (backup.priceBackupCsv.trim().length > 0) {
    const parsed = parsePriceBackupCsv(
      new TextEncoder().encode(backup.priceBackupCsv),
    );
    if (!parsed.ok && parsed.code !== "EMPTY_FILE") {
      return {
        ok: false,
        status: 409,
        message: `The account, watchlist, and ${portfolioResults.length} portfolio(s) were restored, but the embedded price-history section could not be read (${parsed.message}). Re-run this restore, or restore price history separately via the price-history backup section.`,
      };
    }
    if (parsed.ok && parsed.rows.length > 0) {
      const priceContext: PriceUploadContext = {
        client: ctx.client,
        userId: ctx.userId,
      };
      const preview = await previewBackupPriceUpload(priceContext, {
        rows: parsed.rows,
      });
      if (preview.ok && preview.preview.rowCount === 0) {
        // Every row in the file failed to resolve -- honest, non-fatal:
        // report it in the result rather than 409ing a restore whose other
        // pieces already committed.
        priceBackup = {
          written: 0,
          unresolvedRowCount: preview.preview.unresolvedRowCount,
          malformedCount: preview.preview.malformedCount,
          unchangedCount: 0,
          note: "No price-history rows in this backup resolved to a restored security -- nothing was written.",
        };
      } else {
        const confirmed = await confirmBackupPriceUpload(
          priceContext,
          { rows: parsed.rows },
          { filename: `${filename}-prices.csv` },
        );
        if (!confirmed.ok) {
          return {
            ok: false,
            status: 409,
            message: `The account, watchlist, and ${portfolioResults.length} portfolio(s) were restored, but price history could not be restored (${confirmed.message}). Re-run this restore, or restore price history separately via the price-history backup section.`,
          };
        }
        priceBackup = {
          written: confirmed.value.written,
          unresolvedRowCount: confirmed.value.unresolvedRowCount,
          malformedCount: parsed.malformed.length,
          unchangedCount: confirmed.value.unchangedCount,
          note: null,
        };
      }
    }
  }

  return {
    ok: true,
    result: {
      portfolios: portfolioResults,
      watchlist,
      priceBackup,
    },
  };
}
