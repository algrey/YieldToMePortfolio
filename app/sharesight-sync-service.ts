// BRK-005: owner-initiated Sharesight sync business logic -- reads
// trades/payouts for the LINKED Sharesight portfolio via BRK-003's sealed
// GET-only client and stages them through the EXISTING CSV-import pipeline
// (`db/repositories/import-staging.ts`), never through a parallel
// staging/commit path (Orchestrator ruling). Deliberately depends only on
// `db/repositories/index.ts` and pure `domain/` modules -- never
// `./portfolio-actions.ts` (which pulls in `next/headers`/the D1 binding
// resolver) -- so `tests/brk-005.test.ts` can exercise the full
// link/sync/stage flow against a sqlite-backed `SqlClient` and a fake
// `SharesightClient`, matching `security-verification-service.ts`'s and
// `import-ready-service.ts`'s established split. `app/sharesight-sync-actions.ts`
// is the thin wrapper that resolves owner context and calls into this module.
import { randomUUID } from "node:crypto";
import {
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSharesightSyncStateRepository,
  type SqlClient,
} from "../db/repositories/index.ts";
import type {
  ImportParseSuccess,
  ParsedImportRow,
} from "../domain/imports/index.ts";
import {
  SHARESIGHT_SYNC_PARSER_FORMAT,
  SHARESIGHT_SYNC_PARSER_VERSION,
  transformSharesightSync,
} from "../domain/sharesight-sync/index.ts";
import type {
  SharesightClient,
  SharesightPortfolio,
} from "../domain/sharesight/index.ts";
import {
  createSharesightIntegrationConfig,
  type SharesightIntegrationConfig,
} from "../worker/sharesight-config.ts";
import { resolveSharesightBatchSecuritiesWithContext } from "./security-resolution-service.ts";

export type SharesightSyncActionFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 502 | 503;
  message: string;
};

export type SharesightSyncActionContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

export type SharesightSyncActionOptions = {
  /** Test-only seam: an already-resolved integration config (skips the
   * `cloudflare:workers` env import a plain node:sqlite test cannot use). */
  integration?: SharesightIntegrationConfig;
  now?: () => string;
};

async function resolveIntegration(
  options: SharesightSyncActionOptions,
): Promise<SharesightIntegrationConfig> {
  if (options.integration) return options.integration;
  try {
    const { env } = await import("cloudflare:workers");
    return createSharesightIntegrationConfig(
      env as unknown as Parameters<typeof createSharesightIntegrationConfig>[0],
    );
  } catch {
    return { enabled: false, reason: "not_configured" };
  }
}

function disabledIntegrationFailure(
  reason: "not_configured" | "incomplete_configuration",
): SharesightSyncActionFailure {
  return {
    ok: false,
    status: 409,
    message:
      reason === "not_configured"
        ? "Sharesight is not connected for this deployment."
        : "Sharesight is only partially configured for this deployment.",
  };
}

function nowIso(options: SharesightSyncActionOptions): string {
  return options.now ? options.now() : new Date().toISOString();
}

// ---------------------------------------------------------------------------
// List Sharesight portfolios (owner picks one to link).
// ---------------------------------------------------------------------------

export type SharesightPortfolioOption = {
  id: string;
  name: string;
  currencyCode: string;
};

export type ListSharesightPortfoliosResult =
  | { ok: true; portfolios: SharesightPortfolioOption[] }
  | SharesightSyncActionFailure;

export async function listSharesightPortfoliosWithContext(
  context: SharesightSyncActionContext,
  portfolioId: string,
  options: SharesightSyncActionOptions = {},
): Promise<ListSharesightPortfoliosResult> {
  const portfolio = await createOwnedPortfolioRepository(context.client).get(
    context.userId,
    portfolioId,
  );
  if (!portfolio)
    return { ok: false, status: 404, message: "Portfolio not found." };

  const integration = await resolveIntegration(options);
  if (!integration.enabled)
    return disabledIntegrationFailure(integration.reason);

  const result = await integration.client.listPortfolios();
  if (!result.ok) {
    return {
      ok: false,
      status: 502,
      message: "Sharesight did not return a usable portfolio list.",
    };
  }
  const portfolios: SharesightPortfolioOption[] = result.value.map(
    (item: SharesightPortfolio) => ({
      id: item.id,
      name: item.name,
      currencyCode: item.currencyCode,
    }),
  );
  return { ok: true, portfolios };
}

// ---------------------------------------------------------------------------
// Link a Sharesight portfolio to this local portfolio (one-time owner
// action -- BRK-005 ruling 1). Minimal: stores `sharesight_portfolio_id`
// into `sharesight_sync_state` (BRK-004's reserved cursor table).
// ---------------------------------------------------------------------------

export type LinkSharesightPortfolioResult =
  | {
      ok: true;
      sharesightPortfolioId: string;
      version: number;
    }
  | SharesightSyncActionFailure;

export async function linkSharesightPortfolioWithContext(
  context: SharesightSyncActionContext,
  portfolioId: string,
  value: unknown,
  options: SharesightSyncActionOptions = {},
): Promise<LinkSharesightPortfolioResult> {
  const input = value as Record<string, unknown>;
  const sharesightPortfolioId =
    typeof input?.sharesightPortfolioId === "string"
      ? input.sharesightPortfolioId.trim()
      : "";
  if (!sharesightPortfolioId) {
    return {
      ok: false,
      status: 400,
      message: "Choose a Sharesight portfolio to link.",
    };
  }

  const integration = await resolveIntegration(options);
  if (!integration.enabled)
    return disabledIntegrationFailure(integration.reason);

  const syncStateRepository = createSharesightSyncStateRepository(
    context.client,
    options.now,
  );
  const existing = await syncStateRepository.get(
    context.userId,
    portfolioId,
    sharesightPortfolioId,
  );
  // BRK-005 review finding B4: `linkExclusive` (not plain `upsert`)
  // disables every OTHER enabled link for this local portfolio in the SAME
  // atomic batch as creating/re-enabling this one, so a re-link can never
  // leave two enabled rows simultaneously visible to a sync -- see that
  // repository method's header note for the reviewer repro it fixes.
  const result = await syncStateRepository.linkExclusive(
    context.userId,
    portfolioId,
    sharesightPortfolioId,
    {
      enabled: true,
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      lastTradeWatermark: existing?.lastTradeWatermark ?? null,
      expectedVersion: existing?.version ?? null,
      requestId: context.requestId,
    },
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.reason === "invalid_input" ? 400 : 409,
      message: "Could not link this Sharesight portfolio. Try again.",
    };
  }
  return {
    ok: true,
    sharesightPortfolioId,
    version: result.state.version,
  };
}

// ---------------------------------------------------------------------------
// Run a sync: fetch trades+payouts for the linked Sharesight portfolio,
// transform, and stage exactly like a CSV upload (BRK-005 ruling 1).
// ---------------------------------------------------------------------------

export type RunSharesightSyncResult =
  | {
      ok: true;
      batchId: string;
      batchStatus: string;
      rowsStaged: number;
      skippedPayouts: number;
      reused: boolean;
    }
  | SharesightSyncActionFailure;

/**
 * BRK-005 review finding B1 (BLOCKING): the original digest hashed only the
 * trade/payout ID SETS, not their content -- a Sharesight-side CORRECTION
 * to an already-synced trade (reviewer repro: 5 shares @ $10 corrected to
 * 500 shares @ $99, same trade id) left the id set unchanged, so the digest
 * was byte-identical to the prior sync's, `startUpload`'s
 * `ON CONFLICT (user_id, file_sha256, parser_format, parser_version) DO
 * NOTHING` silently resolved to the OLD batch, and the correction was
 * dropped with `ok: true` and no visible signal at all.
 *
 * Fixed by hashing the TRANSFORMED ROWS' own VALUE-BEARING normalized
 * fields (identity, type, quantity, price, commission, dates, franking/
 * totals) instead of bare ids. A corrected re-fetch now changes at least
 * one row's canonical string, so the digest differs, `startUpload` creates
 * a genuinely NEW batch, and that batch's rows -- keyed by the SAME
 * `source_reference` the original committed transaction/dividend record
 * used (`sharesight-trade:<id>` / `sharesight-payout:<id>`, unchanged by a
 * value correction) -- surface the correction VISIBLY through the existing,
 * unmodified reconciliation/preview machinery at ready/commit time (the
 * same "close match, needs a decision" surface a re-uploaded, edited CSV
 * row already produces), rather than an invisible silent no-op. Row order
 * is sorted before joining so two fetches returning the identical row set
 * in a different order still hash identically (true idempotency, not an
 * artifact of API response ordering).
 */
function canonicalRowDigestFields(row: ParsedImportRow): string {
  const normalized = row.normalized;
  return [
    row.fingerprint,
    normalized.type ?? "",
    normalized.symbol ?? "",
    normalized.exchange ?? "",
    normalized.currency ?? "",
    normalized.sharesOwned ?? "",
    normalized.costPerShare ?? "",
    normalized.commission ?? "",
    normalized.localTradeDate ?? "",
    normalized.tradeAtUtc ?? "",
    normalized.frankingPerShare ?? "",
    normalized.totalCashDecimal ?? "",
    normalized.totalFrankingDecimal ?? "",
  ].join("|");
}

// BRK-005B review finding B2 (BLOCKING): the digest omitted the LOCAL
// `portfolioId` entirely -- two different local portfolios linked to the
// SAME Sharesight portfolio produced the byte-identical digest source (same
// `sharesightPortfolioId`, same fetched rows), so `startUpload`'s
// `ON CONFLICT (user_id, file_sha256, parser_format, parser_version)` --
// scoped by USER, not by target portfolio -- silently resolved the second
// portfolio's sync to the FIRST portfolio's already-staged batch. That
// batch's `target_portfolio_id` is the OTHER portfolio, so the rows would
// eventually reconcile/commit against the wrong portfolio with no signal
// before commit. Folding `portfolioId` into the hashed content makes the
// two portfolios' digests differ even for identical fetched data, so each
// gets its own batch correctly targeting its own portfolio.
function canonicalFetchDigestSource(
  portfolioId: string,
  sharesightPortfolioId: string,
  rows: readonly ParsedImportRow[],
): string {
  const canonicalRows = rows.map(canonicalRowDigestFields).sort();
  return JSON.stringify({
    portfolioId,
    sharesightPortfolioId,
    rows: canonicalRows,
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function runSharesightSyncWithContext(
  context: SharesightSyncActionContext,
  portfolioId: string,
  options: SharesightSyncActionOptions = {},
): Promise<RunSharesightSyncResult> {
  const portfolio = await createOwnedPortfolioRepository(context.client).get(
    context.userId,
    portfolioId,
  );
  if (!portfolio)
    return { ok: false, status: 404, message: "Portfolio not found." };

  const integration = await resolveIntegration(options);
  if (!integration.enabled)
    return disabledIntegrationFailure(integration.reason);

  const syncStateRepository = createSharesightSyncStateRepository(
    context.client,
    options.now,
  );
  const links = await syncStateRepository.list(context.userId, portfolioId);
  const enabledLinks = links.filter((candidate) => candidate.enabled);
  if (enabledLinks.length === 0) {
    return {
      ok: false,
      status: 409,
      message: "Link a Sharesight portfolio to this portfolio before syncing.",
    };
  }
  // BRK-005 review finding B4, defense-in-depth: `linkExclusive` (used by
  // `linkSharesightPortfolioWithContext`) is supposed to guarantee at most
  // one enabled link per local portfolio, but a sync must never SILENTLY
  // pick "whichever enabled row happens to be first" if that invariant is
  // ever violated (a pre-existing row from before this fix shipped, a
  // direct DB write, a bug) -- fail closed and visible instead of
  // non-deterministically importing from an unpredictable Sharesight
  // portfolio (the reviewer's exact repro).
  if (enabledLinks.length > 1) {
    return {
      ok: false,
      status: 409,
      message:
        "This portfolio has more than one enabled Sharesight link, which should never happen -- re-link before syncing.",
    };
  }
  const link = enabledLinks[0];
  if (!link) {
    return {
      ok: false,
      status: 409,
      message: "Link a Sharesight portfolio to this portfolio before syncing.",
    };
  }

  const client: SharesightClient = integration.client;
  const tradesResult = await client.listTrades(link.sharesightPortfolioId);
  if (!tradesResult.ok) {
    return {
      ok: false,
      status: 502,
      message: "Sharesight did not return a usable trade list.",
    };
  }
  const payoutsResult = await client.listPayouts(link.sharesightPortfolioId);
  if (!payoutsResult.ok) {
    return {
      ok: false,
      status: 502,
      message: "Sharesight did not return a usable payout list.",
    };
  }

  // BRK-005C: `now` must be resolved BEFORE the transform call -- the pure
  // `transformSharesightSync` needs it (injected, never `Date.now()` inside
  // that module) to classify a null-id payout's `paidOnDate` as past
  // (stage as an "unconfirmed in Sharesight" real record) vs future (still
  // skip with a warning). `nowAt` is otherwise used exactly as before, for
  // the batch filename and the sync-state watermark.
  const nowAt = nowIso(options);
  const transformed = transformSharesightSync({
    portfolioName: portfolio.name,
    trades: tradesResult.value,
    payouts: payoutsResult.value,
    now: nowAt,
  });

  const digestSource = canonicalFetchDigestSource(
    portfolioId,
    link.sharesightPortfolioId,
    transformed.rows,
  );
  const fileFingerprint = await sha256Hex(digestSource);
  const parseResult: ImportParseSuccess = {
    ok: true,
    parserVersion: SHARESIGHT_SYNC_PARSER_VERSION,
    fileFingerprint,
    header: {
      parserVersion: SHARESIGHT_SYNC_PARSER_VERSION,
      observedHeaders: [],
      normalizedHeaders: [],
      missingHeaders: [],
      unknownHeaders: [],
      duplicateHeaders: [],
      signature: SHARESIGHT_SYNC_PARSER_VERSION,
    },
    rows: transformed.rows,
    issues: transformed.issues,
    summary: transformed.summary,
  };

  const staging = createOwnedImportStagingRepository(context.client);
  const started = await staging.startUpload(context.userId, {
    id: randomUUID(),
    targetPortfolioId: portfolioId,
    parserFormat: SHARESIGHT_SYNC_PARSER_FORMAT,
    parserVersion: SHARESIGHT_SYNC_PARSER_VERSION,
    filename: `sharesight-sync-${link.sharesightPortfolioId}-${nowAt.slice(0, 10)}`,
    // Review follow-up: `fileFingerprint.length` (the hex digest's own
    // string length, always 64) was a meaningless constant, not a real size.
    // This is the actual UTF-8 byte length of the canonical payload that was
    // hashed into `fileFingerprint` -- there is no literal uploaded file for
    // a sync the way there is for a CSV upload, so this is the closest
    // honest analogue rather than a fabricated number.
    byteSize: new TextEncoder().encode(digestSource).length,
    fileSha256: fileFingerprint,
  });
  if (!started.ok) {
    return {
      ok: false,
      status: 404,
      message: "The linked portfolio could not be found for this sync.",
    };
  }

  let batchStatus = started.batch.status;
  if (!started.reused && started.batch.status === "uploaded") {
    const recorded = await staging.recordParseResult(
      context.userId,
      started.batch.id,
      { expectedVersion: started.batch.version, parseResult },
    );
    if (!recorded.ok) {
      return {
        ok: false,
        status: recorded.reason === "atomic_failure" ? 503 : 409,
        message:
          recorded.reason === "atomic_failure"
            ? "The sync is still in progress and can be retried safely."
            : "The sync batch changed while it was being staged.",
      };
    }
    batchStatus = recorded.batch.status;
  }

  // BRK-009B: the explicit "resolve securities" pass -- runs automatically
  // right after staging, for a freshly-staged batch AND for a REUSED one
  // (an older batch staged before this feature shipped, or whose sync-time
  // pass only partially completed, still resolves on the next sync of the
  // identical fetch), so the review the owner sees next already reflects
  // resolved/created security state with zero manual verification steps.
  // Idempotent (`app/security-resolution-service.ts`) and best-effort: a
  // resolution failure here never fails the sync itself (the batch is
  // already safely staged) -- it is also re-run, idempotently, as the first
  // step of the atomic accept action for any batch this pass did not fully
  // resolve.
  await resolveSharesightBatchSecuritiesWithContext(
    {
      client: context.client,
      userId: context.userId,
      requestId: context.requestId,
    },
    started.batch.id,
    { now: options.now },
  );

  // Watermark update (BRK-005 ruling 4): `last_synced_at` moves on
  // successful STAGING, never on commit -- commit is a separate, later,
  // owner-driven step through the unmodified review/ready/commit flow.
  // `last_trade_watermark` is left untouched: this task always re-fetches
  // the full trade/payout list (idempotent re-sync dedupes via
  // `source_reference`, not a fetch-side date filter) -- narrowing the
  // fetch by watermark is an unplanned incremental-sync design left for a
  // future task.
  await syncStateRepository.upsert(
    context.userId,
    portfolioId,
    link.sharesightPortfolioId,
    {
      enabled: true,
      lastSyncedAt: nowAt,
      lastTradeWatermark: link.lastTradeWatermark,
      expectedVersion: link.version,
      requestId: context.requestId,
    },
  );

  // Review finding B1: on the REUSED path (this exact fetch already staged
  // as this batch, `started.reused === true`), `transformed.rows.length`/
  // the fresh `transformed.issues` are what THIS invocation would have
  // staged, not necessarily what is actually stored -- reporting them
  // unconditionally would be dishonest on a reused batch (and, before this
  // fix, was the shape a corrected-but-hash-collided resync could slip
  // through unnoticed under). The reused path instead reads the STORED
  // counts back from the persisted batch/issues.
  let rowsStaged = transformed.rows.length;
  let skippedPayouts = transformed.issues.filter(
    (issue) => issue.code === "SHARESIGHT_PAYOUT_UNCONFIRMED",
  ).length;
  if (started.reused) {
    rowsStaged = started.batch.totalRows;
    const storedIssues = await staging.listIssues(
      context.userId,
      started.batch.id,
    );
    skippedPayouts = storedIssues.filter(
      (issue) => issue.code === "SHARESIGHT_PAYOUT_UNCONFIRMED",
    ).length;
  }

  return {
    ok: true,
    batchId: started.batch.id,
    batchStatus,
    rowsStaged,
    skippedPayouts,
    reused: started.reused,
  };
}
