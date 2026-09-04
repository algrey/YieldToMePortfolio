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
  loadCommittedSharesightRowValues,
  loadCommittedSharesightWatermarks,
  loadResolvedPortfolioInstrumentCurrencies,
  type SharesightCommittedRowValues,
  type SqlClient,
} from "../db/repositories/index.ts";
import type {
  ImportParseSuccess,
  NormalizedImportRow,
  ParsedImportRow,
} from "../domain/imports/index.ts";
// BRK-019 slice 1: the field-comparison helpers this function used to define
// privately now live in `domain/imports/committed-value-comparison.ts`, so
// this module and `domain/imports/reconciliation.ts`'s preview-time
// `ROW_DIFFERS_FROM_COMMITTED_RECORD` detection share the SAME comparison --
// see that module's header comment for why a shared module, not a duplicate.
import {
  dividendValueDifferences,
  tradeValueDifferences,
} from "../domain/imports/committed-value-comparison.ts";
import {
  computeRoutineSyncFromDate,
  SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS,
  SHARESIGHT_SYNC_PARSER_FORMAT,
  SHARESIGHT_SYNC_PARSER_VERSION,
  SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS,
  transformSharesightSync,
  type SharesightStreamWindow,
  type SharesightSyncWindow,
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

export type RunSharesightSyncOptions = SharesightSyncActionOptions & {
  /** BRK-015: defaults to `"routine"` -- see `SharesightSyncMode`'s doc
   * comment. Only `runSharesightSyncWithContext` reads this; the link/list
   * actions above have no notion of a sync window. */
  mode?: SharesightSyncMode;
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
      // BRK-014 (owner-reported): of the `rowsStaged` rows, how many are
      // genuinely NEW versus already match a currently-committed
      // transaction/dividend record for this portfolio -- see
      // `classifySharesightRow`'s doc comment for the exact "unchanged
      // identity + unchanged value" definition.
      //
      // BRK-019 slice 1: a Sharesight-side value CORRECTION under an
      // identity that already exists committed used to be folded into
      // `newRows` (a decision the owner still needed to see, but
      // indistinguishable in the count from a row Sharesight has never
      // reported before) -- it is now its own bucket, `needsDecisionRows`,
      // so the sync result can say "N new rows" and "N need a decision"
      // separately. Always `newRows + alreadyImportedRows +
      // needsDecisionRows === rowsStaged`.
      newRows: number;
      alreadyImportedRows: number;
      // BRK-019 slice 1: of the `rowsStaged` rows, how many match an
      // already-committed identity (same `source_reference`) but whose
      // economic value differs from what is currently stored -- see
      // `domain/imports/committed-value-comparison.ts`'s
      // `tradeValueDifferences`/`dividendValueDifferences` for the
      // field-by-field comparison. These rows stage normally (the owner can
      // still review/exclude them) but `db/repositories/import-commit.ts`'s
      // commit-time fail-closed check skips one rather than silently
      // accepting either the old or the new value -- see that module's
      // header comment.
      needsDecisionRows: number;
      // BRK-015: what this call actually asked Sharesight for -- honest UI
      // copy must state the window rather than ever implying "fully in
      // sync" after a narrowed routine sync. See
      // `domain/sharesight-sync/window.ts`'s `SharesightSyncWindow` doc
      // comment for the `full` vs `narrowed` distinction.
      window: SharesightSyncWindow;
    }
  | SharesightSyncActionFailure;

/**
 * BRK-015: `"routine"` (the default) narrows the fetch to a window derived
 * from what this portfolio has actually COMMITTED from Sharesight so far,
 * plus a trailing overlap; `"full"` preserves today's unconditional
 * inception-to-now fetch, unchanged, for the owner-triggered "Full resync"
 * action (needed to still catch a Sharesight-side correction to an old
 * record -- the BRK-005 finding-B1 case -- which a narrowed window would
 * never see).
 */
export type SharesightSyncMode = "routine" | "full";

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
    // BRK-010 review finding B2: `exchangeRateDecimal` is VALUE-BEARING
    // money data (unlike `sharesightInstrumentId`/`instrumentName`/`isin`,
    // deliberately digest-excluded matching aids) -- a corrected/late rate
    // from Sharesight must re-stage as a genuinely new batch, mirroring
    // this exact B1 fix's own "hash the transformed rows' VALUE-BEARING
    // fields" rationale above (a Sharesight-side correction with the id set
    // unchanged must still change the digest). `startUpload`'s
    // `ON CONFLICT ... DO NOTHING` would otherwise silently resolve a
    // corrected-rate re-sync to the OLD batch, exactly the B1 failure mode
    // this function exists to prevent.
    normalized.exchangeRateDecimal ?? "",
  ].join("|");
}

/**
 * BRK-014 (owner-reported: a re-sync that staged 14 rows, all of them
 * already-imported duplicates, read exactly like a fresh 14-row import).
 * True only when this row's own commit-time identity (`source_reference`)
 * already exists among this portfolio's currently-committed
 * trades/dividends AND its economic value is unchanged from what is
 * already stored there -- i.e. accepting this row would be a true no-op.
 *
 * A Sharesight-side value CORRECTION to an existing payout/trade shares the
 * SAME identity (a payout/trade's `fingerprint` is identity-only --
 * `payoutIdentityKey`/`sharesight-trade:<id>`, never value-bearing) but a
 * DIFFERENT value, so this deliberately returns `false` for it -- it must
 * read as `newRows` (a decision the owner still needs to see), never
 * `alreadyImportedRows`. See `canonicalRowDigestFields`'s BRK-005
 * finding-B1 doc comment for the incident this distinction guards against
 * (a corrected trade silently resolving to the OLD batch with no visible
 * signal at all).
 *
 * Review round B1 (BLOCKING, correction to the original version of this
 * function): comparing only trade quantity/price and payout cash-total (a
 * strict subset of `canonicalRowDigestFields`'s thirteen value-bearing
 * fields) meant a franking-only or trade-date-only Sharesight correction
 * staged as a genuinely NEW batch (the digest differed) while this function
 * still reported it as `alreadyImportedRows` (its narrower three fields
 * happened to match) -- a directly self-contradictory sync result ("no new
 * rows" printed for a batch that exists only because something changed).
 * Fixed by comparing every digest field a payout/trade row can independently
 * vary on:
 *
 * - payout: `totalCashDecimal` vs `cash_total_decimal`, `totalFrankingDecimal`
 *   vs `total_franking_decimal` (both `decimalValuesMatch`), and
 *   `localTradeDate` (holds the payment date for a dividend-class row --
 *   see `strict-versioned-parser.ts`/`reconciliation.ts`'s `paymentDate:
 *   row.normalized.localTradeDate` precedent) vs `payment_date` (exact
 *   string equality -- a business date, not a decimal).
 * - trade: `sharesOwned`/`costPerShare` vs `quantity_decimal`/
 *   `unit_price_decimal` (`decimalValuesMatch`, as before); `commission ??
 *   "0"` vs `fee_amount_decimal` (`decimalValuesMatch`, mirroring
 *   `import-commit.ts`'s own `feeAmountDecimal: normalized.commission ??
 *   "0"` mapping exactly -- commission is not asserted non-null upstream,
 *   so comparing the raw field against a NOT-NULL-default column would
 *   spuriously mismatch); `localTradeDate` vs `local_trade_date` (exact
 *   string); `type` vs `type` (exact string -- the Sharesight transform
 *   never sets `cashEvent`, so `normalized.type` alone, "buy"/"sell",
 *   already matches the vocabulary `transactions.type` stores; no
 *   `cashEvent ?? type` remapping is needed here the way `import-commit.ts`
 *   does for the general CSV path).
 *
 * Review round 2 (BLOCKING, correction to round-1's own doc comment above):
 * round 1 claimed `symbol`/`exchange`/`currency` were "identity fields
 * already folded into `sourceReference`" -- false, `sourceReference` is
 * `sharesight-trade:<id>` / `<portfolioId>:<holdingId>:<paidOnDate>` and
 * never encodes any of the three -- and that `exchangeRateDecimal` "has no
 * committed counterpart on either table" -- also false,
 * `dividend_manual_records.fx_rate_to_portfolio_decimal` IS its committed
 * counterpart (`import-commit.ts`'s dividend branch writes it, with
 * `fx_rate_source = 'sharesight'`, whenever the payout is foreign to its
 * security and a rate was supplied).
 *
 * Round 3 widens the comparison again with the two faithful counterparts
 * round 2 wrongly wrote off:
 *
 * - trade: `currency` vs `currency_code` (exact string -- `NOT NULL`,
 *   stored verbatim from `normalized.currency` on every trade,
 *   `import-commit.ts:909`; no not-comparable case exists for trades).
 * - payout: `exchangeRateDecimal` vs `fx_rate_to_portfolio_decimal`, but
 *   ONLY when the STORED value is non-null. `import-commit.ts`'s dividend
 *   branch writes this column only when the payout is foreign to its
 *   security's own currency AND Sharesight supplied a rate -- a NATIVE
 *   payout (this owner's common case) always commits with this column NULL,
 *   even though `normalized.exchangeRateDecimal` may hold a real value.
 *   A stored NULL therefore means "not independently recorded", not
 *   "changed" -- see `fxRateNotComparableOrMatches` below for why this is a
 *   pass, not a `decimalValuesMatch` call, and why getting this wrong would
 *   report every native-currency payout as "new" on every routine re-sync.
 *
 * Round 4 (small, Orchestrator-approved widening, same pattern as the FX
 * rate above, reviewer-confirmed no false-positive risk): payout `currency`
 * is now ALSO compared, three-way exactly like `exchangeRateDecimal` --
 * `dividend_manual_records.currency_code` vs `normalized.currency`, exact
 * string match, but ONLY when the STORED value is non-null (see
 * `currencyNotComparableOrMatches` below). `import-commit.ts` stores this
 * column under the SAME `isForeignToSecurity` condition as the FX rate, but
 * only the rate-present branch (case B) ALSO stores a rate -- a foreign
 * payout committed with NO rate (case C-no-rate) is therefore a per-row MIX:
 * its `currency` is now comparable while its `exchangeRateDecimal` on that
 * SAME row stays not-comparable (still NULL), named explicitly here since
 * it is not an all-or-nothing distinction.
 *
 * `symbol`/`exchange`/`fingerprint` remain the only fields genuinely
 * RESIDUAL for both trades and payouts: no committed column records them
 * independently of security resolution, and a mapping decision can point
 * the same Sharesight identity at a different resolved security without
 * changing any other digest-adjacent stored value here. Every comparison
 * stays conservative: an unrecognised/malformed value or a missing
 * committed row returns `false` ("new"), never a false "already imported".
 *
 * Note: this is honest about what the SYNC RESULT reports, not a claim
 * about commit behaviour -- `db/repositories/import-commit.ts`'s own
 * exact-`source_reference` skip check is identity-only and will, today,
 * still skip a value-corrected row at commit time exactly as it would a
 * true duplicate (out of scope for this task: changing commit-time dedupe
 * semantics). Reporting the correction as `newRows` here is what keeps it
 * visible to the owner as a decision, even though this task does not
 * change what accepting it actually does.
 *
 * BRK-019 slice 1 UPDATE: the "reporting the correction as `newRows`" note
 * above is now more precise -- a value-changed row is classified
 * `"needs_decision"`, a distinct bucket from a genuinely new identity
 * (`"new"`), so the sync result can say "N new rows" and "N need a
 * decision" separately rather than folding a correction into the same
 * count as a row Sharesight has never reported before. Both buckets are
 * still rows the owner must look at before they land -- `import-commit.ts`'s
 * own commit-time fail-closed check (this task) skips a `needs_decision`
 * row rather than silently accepting either its old or new value.
 */
type SharesightRowClassification =
  "already_imported" | "needs_decision" | "new";

/**
 * BRK-019 slice 1: three-way classification, replacing BRK-014's plain
 * boolean already-imported check -- built on the SAME field-by-field
 * comparison (`domain/imports/committed-value-comparison.ts`'s
 * `tradeValueDifferences`/`dividendValueDifferences`, extracted from this
 * function's own pre-this-task body) so the three-way split can never drift
 * from the boolean version's own long-reviewed field list. No committed row
 * under this identity at all -> `"new"`; a committed row exists and every
 * comparable field matches -> `"already_imported"`; a committed row exists
 * but at least one comparable field differs (a Sharesight-side correction)
 * -> `"needs_decision"`.
 */
function classifySharesightRow(
  row: {
    fingerprint: string;
    normalized: Pick<
      NormalizedImportRow,
      | "type"
      | "sharesOwned"
      | "costPerShare"
      | "totalCashDecimal"
      | "totalFrankingDecimal"
      | "localTradeDate"
      | "commission"
      | "currency"
      | "exchangeRateDecimal"
    >;
  },
  existing: SharesightCommittedRowValues,
): SharesightRowClassification {
  const sourceReference = `import-fingerprint:${row.fingerprint}`;
  if (row.normalized.type === "dividend") {
    const existingPayout = existing.payouts.get(sourceReference);
    if (!existingPayout) return "new";
    // Every Sharesight-sourced dividend row is totals-mode (`transform.ts`
    // never sets `sharesOwned`/`costPerShare` on one), so the raw
    // `totalCashDecimal` field IS already the comparable amount -- matches
    // this function's pre-this-task behaviour exactly (no
    // `safeComputeDividendCashTotal` call needed here the way
    // `reconciliation.ts`'s CSV-inclusive comparison needs one, since a CSV
    // per-share row never reaches this Sharesight-only function).
    const differences = dividendValueDifferences(
      {
        cashTotalDecimal: row.normalized.totalCashDecimal ?? null,
        totalFrankingDecimal: row.normalized.totalFrankingDecimal ?? null,
        paymentDate: row.normalized.localTradeDate,
        fxRateToPortfolioDecimal: row.normalized.exchangeRateDecimal ?? null,
        currencyCode: row.normalized.currency ?? null,
      },
      existingPayout,
    );
    return differences.length === 0 ? "already_imported" : "needs_decision";
  }
  const existingTrade = existing.trades.get(sourceReference);
  if (!existingTrade) return "new";
  const differences = tradeValueDifferences(
    {
      type: row.normalized.type,
      localTradeDate: row.normalized.localTradeDate,
      quantityDecimal: row.normalized.sharesOwned,
      priceDecimal: row.normalized.costPerShare,
      feeAmountDecimal: row.normalized.commission ?? "0",
      currencyCode: row.normalized.currency ?? null,
    },
    existingTrade,
  );
  return differences.length === 0 ? "already_imported" : "needs_decision";
}

function countByClassification(
  rows: readonly Parameters<typeof classifySharesightRow>[0][],
  existing: SharesightCommittedRowValues,
  classification: SharesightRowClassification,
): number {
  let count = 0;
  for (const row of rows) {
    if (classifySharesightRow(row, existing) === classification) count += 1;
  }
  return count;
}

function countAlreadyImported(
  rows: readonly Parameters<typeof classifySharesightRow>[0][],
  existing: SharesightCommittedRowValues,
): number {
  return countByClassification(rows, existing, "already_imported");
}

// BRK-019 slice 1: the "needs a decision" analog of `countAlreadyImported`
// above -- see `RunSharesightSyncResult.needsDecisionRows`'s doc comment for
// what this count means and why it is reported separately from `newRows`.
function countNeedsDecision(
  rows: readonly Parameters<typeof classifySharesightRow>[0][],
  existing: SharesightCommittedRowValues,
): number {
  return countByClassification(rows, existing, "needs_decision");
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
  options: RunSharesightSyncOptions = {},
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

  // BRK-015: routine (default) narrows EACH stream's fetch independently to
  // what this portfolio has actually COMMITTED of THAT stream from
  // Sharesight so far, minus that stream's own overlap -- NEVER to
  // `sharesight_sync_state.last_synced_at`/`last_trade_watermark` (see
  // `loadCommittedSharesightWatermarks`'s doc comment for why: those are
  // staging-time signals, and staging-without-accepting is a LIKELY,
  // expected path on this account -- keying off them would silently drop
  // whatever an abandoned batch staged).
  //
  // Review round B1 fix (BLOCKING): trades and payouts get SEPARATE
  // watermarks and SEPARATE overlap constants, computed and applied
  // independently -- a single shared value previously let the LEADING
  // stream's watermark silently govern the LAGGING stream's window (a
  // trade committed well after the last committed payout pushed the
  // payout fetch's `from` bound forward too, past a late-entered dividend
  // that was still well inside ITS OWN stream's intended overlap). See
  // `loadCommittedSharesightWatermarks`'s doc comment for the full
  // incident and `window.ts`'s two distinct overlap constants
  // (`SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS` / `SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS`,
  // deliberately different sizes -- payouts need a much larger one; see
  // that constant's own doc comment for the live ex-date-vs-paid-date
  // finding driving its size).
  //
  // No committed watermark yet for a given stream (first sync of that
  // stream, or every prior sync of it was staged and never accepted) falls
  // back to an unbounded fetch for THAT STREAM ALONE -- there is nothing
  // safe to narrow it against; the other stream's window is unaffected.
  // `mode: "full"` always uses an unbounded fetch for BOTH streams,
  // preserving today's behaviour exactly (needed to still catch a
  // Sharesight-side correction to an old record outside any window -- the
  // BRK-005 finding-B1 case).
  const mode: SharesightSyncMode = options.mode ?? "routine";
  let tradeWindow: SharesightStreamWindow = { kind: "full" };
  let payoutWindow: SharesightStreamWindow = { kind: "full" };
  if (mode === "routine") {
    const watermarks = await loadCommittedSharesightWatermarks(
      context.client,
      context.userId,
      portfolioId,
    );
    if (watermarks.tradeWatermark) {
      tradeWindow = {
        kind: "narrowed",
        sinceDate: computeRoutineSyncFromDate(
          watermarks.tradeWatermark,
          SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS,
        ),
      };
    }
    if (watermarks.payoutWatermark) {
      payoutWindow = {
        kind: "narrowed",
        sinceDate: computeRoutineSyncFromDate(
          watermarks.payoutWatermark,
          SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS,
        ),
      };
    }
  }
  const tradeListParams =
    tradeWindow.kind === "narrowed"
      ? { from: tradeWindow.sinceDate }
      : undefined;
  const payoutListParams =
    payoutWindow.kind === "narrowed"
      ? { from: payoutWindow.sinceDate }
      : undefined;

  const client: SharesightClient = integration.client;
  // BRK-016: the trade and payout streams are independent fetches -- issue
  // both before waiting on either, rather than paying their two timeouts
  // back-to-back. Failure handling is UNCHANGED from the prior sequential
  // code for every TYPED result: the trades check runs first, so if both
  // streams fail the trades message is what's reported (matches what a
  // sequential await would have surfaced first, since `listTrades` used to
  // run to completion before `listPayouts` was even attempted); either
  // stream failing alone still reports that stream's own message. This is
  // NOT true for a rejection: if `listTrades` resolves `ok: false` while
  // `listPayouts` REJECTS, the prior sequential code returned the trades 502
  // without ever calling `listPayouts`, but `Promise.all` here lets that
  // rejection propagate and throw instead of returning the typed 502. This
  // is unreachable through the real `SharesightClient` -- every real path
  // resolves a typed `{ ok: true | false }` result, never rejects -- so it
  // is deliberately not handled with `Promise.allSettled`; only a
  // hypothetical non-conforming client could hit it.
  const [tradesResult, payoutsResult] = await Promise.all([
    client.listTrades(link.sharesightPortfolioId, tradeListParams),
    client.listPayouts(link.sharesightPortfolioId, payoutListParams),
  ]);
  if (!tradesResult.ok) {
    return {
      ok: false,
      status: 502,
      message: "Sharesight did not return a usable trade list.",
    };
  }
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
  // BRK-010 review round 3 (BLOCKING): REAL, DB-resolved currency evidence
  // for every instrument this user has already linked in THIS portfolio,
  // from any source -- queried BEFORE the pure transform runs so
  // `payoutSecurityCurrencyProxy` can prefer it over both the same-fetch
  // trade heuristic and (removed) the portfolio-base guess. See
  // `db/repositories/security-resolution.ts`'s
  // `loadResolvedPortfolioInstrumentCurrencies` doc comment for why this
  // was necessary: "no same-fetch trade evidence" is the realistic steady
  // state for a recurring payout (trades are historical), not a rare edge
  // case, so guessing there was never safe.
  // BRK-014: loaded alongside `resolvedInstrumentCurrencies` (independent
  // reads, same round trip depth) -- the currently-committed identity/value
  // state this sync's own fetch will be compared against below to report
  // new-versus-already-imported counts. Needed on BOTH the fresh and
  // REUSED paths (unlike `transformed.rows`/`transformed.issues`, which the
  // reused path deliberately does NOT trust -- see the honesty rule at
  // `rowsStaged`'s assignment below), since "already committed" reflects
  // the account's CURRENT state, not a snapshot from whenever the batch was
  // first staged.
  const [resolvedInstrumentCurrencies, existingSharesightRowValues] =
    await Promise.all([
      loadResolvedPortfolioInstrumentCurrencies(
        context.client,
        context.userId,
        portfolioId,
      ),
      loadCommittedSharesightRowValues(
        context.client,
        context.userId,
        portfolioId,
      ),
    ]);
  const transformed = transformSharesightSync({
    portfolioName: portfolio.name,
    trades: tradesResult.value,
    payouts: payoutsResult.value,
    portfolioBaseCurrencyCode: portfolio.baseCurrencyCode,
    resolvedInstrumentCurrencies,
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
  // owner-driven step through the unmodified review/ready/commit flow. This
  // remains true unchanged by BRK-015: `last_synced_at` is still purely a
  // staging-time UI signal, never consulted for fetch narrowing.
  // `last_trade_watermark` is STILL left untouched, deliberately -- BRK-015
  // added routine-sync narrowing, but keyed to TWO values (one per stream)
  // DERIVED from committed `transactions`/`dividend_manual_records` state
  // (`loadCommittedSharesightWatermarks`), never to a column that could be
  // advanced by staging alone. See that function's doc comment and this
  // sync's own window computation above for why: staging a batch and never
  // accepting it is a LIKELY path on this account, and a staging-advanced
  // watermark would silently drop whatever an abandoned batch staged.
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
  // BRK-014: same honesty discipline as `rowsStaged`/`skippedPayouts` above
  // -- on the fresh path, count directly from `transformed.rows` (what was
  // just staged); on the REUSED path, re-derive from the STORED staged rows
  // (`staging.listRows`), never from the fresh transform.
  let alreadyImportedRows = countAlreadyImported(
    transformed.rows,
    existingSharesightRowValues,
  );
  // BRK-019 slice 1: same honesty discipline as `alreadyImportedRows` above
  // -- a row whose identity already exists committed but whose value
  // differs (a Sharesight-side correction) must not be silently folded into
  // `newRows`; see `RunSharesightSyncResult.needsDecisionRows`'s doc comment.
  let needsDecisionRows = countNeedsDecision(
    transformed.rows,
    existingSharesightRowValues,
  );
  if (started.reused) {
    rowsStaged = started.batch.totalRows;
    const storedIssues = await staging.listIssues(
      context.userId,
      started.batch.id,
    );
    skippedPayouts = storedIssues.filter(
      (issue) => issue.code === "SHARESIGHT_PAYOUT_UNCONFIRMED",
    ).length;
    const storedRows = await staging.listRows(context.userId, started.batch.id);
    const economicRows = storedRows.flatMap((row) =>
      row.rowClass === "transaction" &&
      row.normalizedFingerprint !== null &&
      row.normalizedFields !== null
        ? [
            {
              fingerprint: row.normalizedFingerprint,
              normalized: row.normalizedFields,
            },
          ]
        : [],
    );
    alreadyImportedRows = countAlreadyImported(
      economicRows,
      existingSharesightRowValues,
    );
    needsDecisionRows = countNeedsDecision(
      economicRows,
      existingSharesightRowValues,
    );
  }
  // BRK-019 slice 1: `newRows` now excludes `needsDecisionRows` too -- a
  // value-changed row is neither a true no-op (`alreadyImportedRows`) nor a
  // decision-free fresh identity (`newRows`); it is its own bucket. Always
  // `newRows + alreadyImportedRows + needsDecisionRows === rowsStaged`.
  const newRows = rowsStaged - alreadyImportedRows - needsDecisionRows;

  return {
    ok: true,
    batchId: started.batch.id,
    batchStatus,
    rowsStaged,
    skippedPayouts,
    newRows,
    alreadyImportedRows,
    needsDecisionRows,
    reused: started.reused,
    window: { trades: tradeWindow, payouts: payoutWindow },
  };
}
