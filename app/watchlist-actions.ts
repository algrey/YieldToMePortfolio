// WLT-001: owner-scoped mutation/search actions behind the watchlist tab.
// USER-scoped throughout (no portfolioId anywhere in this file) -- the
// watchlist exists independently of any portfolio (owner ruling: "it does
// not record a position, just an interest"), so `getAuthenticatedSqlContext()`
// is called with no portfolio argument, matching `createPortfolioAction`'s/
// `changeHomeCurrencyAction`'s existing user-scoped precedent in
// `app/portfolio-actions.ts` (never the portfolio-scoped
// `app/dividend-assumptions-actions.ts` pattern this file otherwise mirrors
// structurally).
//
// Route modules (`app/api/watchlist/*/route.ts`) call `rejectCrossSiteMutation`
// before invoking any mutating action here; the search action is a read and
// needs no CSRF gate, matching this codebase's established "reads are N/A
// for CSRF" convention (see docs/QA-001A_SECURITY_MATRIX.md section 1).
//
// Every mutation is split into a thin `xxxAction(value)` (resolves an
// authenticated context, then delegates) and an exported
// `xxxWithContext(context, value)` that does the actual work against an
// already-resolved context -- mirroring `app/dividend-assumptions-actions.ts`'s
// identical split (see that file's header comment for why: the `Action`
// half transitively imports `next/headers` via `./portfolio-actions.ts`,
// which is only resolvable through vinext's bundler, not Node's strict ESM
// loader under `node --test`).
import { randomUUID } from "node:crypto";
import {
  createOwnedSecurityVerificationRepository,
  createOwnedWatchlistRepository,
  type WatchlistEntryRecord,
  type SqlClient,
} from "../db/repositories/index.ts";
import { evaluateSecurityIdentityCandidates } from "../domain/securities/verify-identity.ts";
import type { MarketDataProvider } from "../domain/market-data/index.ts";
import {
  PROVIDER_ID,
  providerFailureMessage,
  resolveConfiguredProvider,
} from "./security-verification-service.ts";

// WLT-001 review (B2a, BLOCKING): a watch-only security has no portfolio
// membership, so it is invisible to every EXISTING price-writing path in
// this codebase today (the owner-initiated refresh queue and MKT-011A's
// intraday capture sweep are both scoped to HELD securities -- extending
// the capture sweep's OWN candidate resolution to include watchlist
// securities is a separate fix, `db/repositories/intraday-price-capture.ts`).
// Without this, a freshly-added watch entry would show "unavailable"
// indefinitely until something else happened to also hold/capture it.
// Best-effort, ONE request, MARKET_DATA_PROVIDER-gated (the caller already
// checked `providerEnabled` before reaching this point), never blocks or
// fails the add: any failure here (no verified mapping yet, a provider
// error, a write conflict) is silently discarded -- the entry still gets
// added, honestly `unavailable` until the next capture sweep or an
// owner-initiated refresh prices it.
//
// WLT-001 review round 2 (BLOCKING, the exact MKT-011A failure class):
// `getLatestObservation` against a `yahoo-compatible` mapping always
// returns `interval = 'delayed'` (same as MKT-011A's own rollup), so this
// is a SECOND producer of a `yahoo-compatible`/`delayed` row alongside
// MKT-011A's end-of-day rollup (`db/repositories/intraday-price-capture.ts`'s
// `rollupIntradayPricePoint`) -- see that function's own doc comment,
// corrected in the same change set to say so. A plain
// exact-`observation_at` `ON CONFLICT` (this function's round-1 shape)
// throws on the PARTIAL `price_observations_yahoo_scope_mapping_date_unique`
// index (`WHERE provider_id = 'yahoo-compatible' AND interval = 'delayed'`,
// scoped by `market_date`, not `observation_at`) whenever a same-day
// `delayed` row already exists -- guaranteed after any daily-capture tick
// -- and that throw was silently swallowed by the `catch` below, losing
// the prime entirely (reviewer-drilled). Fixed by targeting that SAME
// partial index directly (its `WHERE` predicate repeated verbatim, required
// for SQLite to match `ON CONFLICT` against a partial index) with the
// IDENTICAL converge-to-the-newer-point semantics the rollup uses
// (`WHERE excluded.observation_at > price_observations.observation_at` --
// never downgrades a fresher rollup-written point with a stale prime, and
// a fresher prime still wins over an older rollup point) -- this second
// writer is safe for exactly the reason that index exists: both writers
// converge onto ONE row per (security, market_date) rather than either one
// throwing on the other's row.
async function primeWatchlistSecurityPrice(
  client: SqlClient,
  provider: MarketDataProvider,
  securityId: string,
): Promise<void> {
  try {
    const mapping = await client.get<{ id: string }>(
      `SELECT id FROM security_provider_mappings
       WHERE security_id = ? AND provider_id = ? AND status = 'verified'
         AND valid_to IS NULL
       ORDER BY valid_from DESC LIMIT 1`,
      [securityId, PROVIDER_ID],
    );
    if (!mapping) return;
    const result = await provider.getLatestObservation({
      mappingId: mapping.id,
      securityId,
      scope: { kind: "deployment", userId: null },
    });
    if (!result.ok || result.value === null) return;
    const observation = result.value;
    await client.run(
      `INSERT INTO price_observations (
         id, provider_id, access_scope, scope_user_id, scope_key,
         mapping_id, security_id, interval, observation_at, market_date,
         market_timezone, currency_code, close_decimal, previous_close_decimal,
         adjustment_state, quality, delayed_minutes, ingested_at,
         provider_revision_id, payload_sha256
       ) VALUES (?, ?, 'deployment', NULL, 'deployment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (
         provider_id, scope_key, mapping_id, interval, market_date, adjustment_state
       ) WHERE provider_id = 'yahoo-compatible' AND interval = 'delayed'
       DO UPDATE SET
         observation_at = excluded.observation_at,
         market_timezone = excluded.market_timezone,
         currency_code = excluded.currency_code,
         close_decimal = excluded.close_decimal,
         previous_close_decimal = excluded.previous_close_decimal,
         quality = excluded.quality,
         delayed_minutes = excluded.delayed_minutes,
         ingested_at = excluded.ingested_at,
         provider_revision_id = excluded.provider_revision_id,
         payload_sha256 = excluded.payload_sha256
       WHERE excluded.observation_at > price_observations.observation_at`,
      [
        randomUUID(),
        observation.providerId,
        mapping.id,
        observation.securityId,
        observation.interval,
        observation.observationAt,
        observation.marketDate,
        observation.marketTimezone,
        observation.currencyCode,
        observation.closeDecimal,
        observation.previousCloseDecimal,
        observation.adjustmentState,
        observation.quality,
        observation.delayedMinutes,
        observation.ingestedAt,
        observation.providerRevisionId,
        observation.payloadSha256,
      ],
    );
  } catch {
    // Best-effort -- see the doc comment above. A freshly-added entry that
    // fails to prime here is never blocked from being added; it simply
    // stays honestly `unavailable` until the next successful refresh.
  }
}

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 502 | 503;
  message: string;
};

export type WatchlistActionContext = Readonly<{
  client: SqlClient;
  userId: string;
  requestId: string;
}>;

// Mirrors `SecurityVerifyActionOptions.provider`
// (`app/security-verification-service.ts`): under `node --test`,
// `resolveConfiguredProvider` always falls back to the disabled stub (its
// `cloudflare:workers` import throws outside a Worker runtime), so tests
// need a way to inject a real/fake `MarketDataProvider` directly instead of
// exercising only the "disabled" path.
export type WatchlistSearchActionOptions = { provider?: MarketDataProvider };

async function authenticatedContext(): Promise<
  WatchlistActionContext | ActionFailure
> {
  const { getAuthenticatedSqlContext } = await import("./portfolio-actions.ts");
  return getAuthenticatedSqlContext();
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// Search: the "add a stock" search-box query. Degrades honestly (a 503 with
// an explicit message, never a dead control) when `MARKET_DATA_PROVIDER` is
// disabled for this deployment -- checked the same way
// `verifySecurityCandidateWithContext` (`app/security-verification-service.ts`)
// checks it, against the same `market_data_providers` row.
// ---------------------------------------------------------------------------

export type WatchlistSecurityCandidate = {
  symbol: string;
  exchangeId: string | null;
  currencyCode: string | null;
  name: string;
  assetType: "equity" | "etf" | "fund";
};

export type SearchWatchlistSecuritiesResult =
  { ok: true; candidates: WatchlistSecurityCandidate[] } | ActionFailure;

async function providerEnabled(client: SqlClient): Promise<boolean> {
  const providerRow = await client.get<{ status: string }>(
    `SELECT status FROM market_data_providers WHERE id = ? LIMIT 1`,
    [PROVIDER_ID],
  );
  return Boolean(providerRow) && providerRow!.status === "enabled";
}

export async function searchWatchlistSecuritiesWithContext(
  context: WatchlistActionContext,
  value: unknown,
  options: WatchlistSearchActionOptions = {},
): Promise<SearchWatchlistSecuritiesResult> {
  const input = record(value);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length < 1 || text.length > 80) {
    return { ok: false, status: 400, message: "Enter a search term." };
  }
  if (!(await providerEnabled(context.client))) {
    return {
      ok: false,
      status: 503,
      message:
        "Adding a stock is not available for this deployment -- market-data search is disabled.",
    };
  }
  const provider =
    options.provider ?? (await resolveConfiguredProvider(context.client));
  const search = await provider.searchSecurities({ text });
  if (!search.ok) {
    return {
      ok: false,
      status: 502,
      message: providerFailureMessage(search.error),
    };
  }
  return {
    ok: true,
    candidates: search.value.map((candidate) => ({
      symbol: candidate.symbol,
      exchangeId: candidate.exchangeId,
      currencyCode: candidate.currencyCode,
      name: candidate.name,
      assetType: candidate.assetType,
    })),
  };
}

export async function searchWatchlistSecuritiesAction(
  value: unknown,
): Promise<SearchWatchlistSecuritiesResult> {
  const context = await authenticatedContext();
  if (!("client" in context)) return context;
  return searchWatchlistSecuritiesWithContext(context, value);
}

// ---------------------------------------------------------------------------
// Add a security: the owner picks one row from the search results above.
// The chosen row's (symbol, exchangeAlias, currencyCode) is re-submitted and
// re-verified server-side here -- never trusted directly from the client --
// exactly like `verifySecurityCandidateWithContext`'s own re-search/
// `evaluateSecurityIdentityCandidates` evidence check, then resolved via
// `SecurityVerificationRepository.publishOnly` (creation-only against the
// shared `securities` master; never links/creates a `portfolio_securities`
// row -- see that method's doc comment).
// ---------------------------------------------------------------------------

export type WatchlistEntryActionResult =
  { ok: true; entry: WatchlistEntryRecord } | ActionFailure;

export async function addWatchlistSecurityWithContext(
  context: WatchlistActionContext,
  value: unknown,
  options: WatchlistSearchActionOptions = {},
): Promise<WatchlistEntryActionResult> {
  const input = record(value);
  const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
  const exchangeAlias =
    typeof input.exchangeAlias === "string" &&
    input.exchangeAlias.trim().length > 0
      ? input.exchangeAlias.trim()
      : null;
  const currencyCode =
    typeof input.currencyCode === "string"
      ? input.currencyCode.trim().toUpperCase()
      : "";
  if (!symbol || !CURRENCY_CODE_PATTERN.test(currencyCode)) {
    return {
      ok: false,
      status: 400,
      message: "A symbol and currency are required.",
    };
  }
  if (!(await providerEnabled(context.client))) {
    return {
      ok: false,
      status: 503,
      message:
        "Adding a stock is not available for this deployment -- market-data verification is disabled.",
    };
  }
  const provider =
    options.provider ?? (await resolveConfiguredProvider(context.client));
  const search = await provider.searchSecurities({
    text: symbol,
    exchangeId: exchangeAlias ?? undefined,
    currencyCode,
  });
  if (!search.ok) {
    return {
      ok: false,
      status: 502,
      message: providerFailureMessage(search.error),
    };
  }
  const outcome = evaluateSecurityIdentityCandidates(
    { symbol, exchangeAlias, currencyCode },
    search.value,
  );
  if (!outcome.ok) {
    return { ok: false, status: 502, message: outcome.message };
  }
  const publish = await createOwnedSecurityVerificationRepository(
    context.client,
  ).publishOnly(context.userId, PROVIDER_ID, outcome.identity);
  if (!publish.ok) {
    return {
      ok: false,
      status: publish.reason === "currency_mismatch" ? 502 : 409,
      message:
        publish.reason === "currency_mismatch"
          ? "The existing security for this identity has a different currency than the verified match."
          : "This security could not be resolved; try again.",
    };
  }
  const result = await createOwnedWatchlistRepository(
    context.client,
  ).addSecurity(context.userId, publish.securityId, context.requestId);
  if (!result.ok) {
    return {
      ok: false,
      status: result.reason === "not_found" ? 404 : 503,
      message: "The security could not be added to the watchlist.",
    };
  }
  // B2a: prime a first price so the row does not sit `unavailable` until
  // the next unrelated refresh -- best-effort, never affects this result.
  await primeWatchlistSecurityPrice(
    context.client,
    provider,
    publish.securityId,
  );
  return { ok: true, entry: result.entry };
}

export async function addWatchlistSecurityAction(
  value: unknown,
): Promise<WatchlistEntryActionResult> {
  const context = await authenticatedContext();
  if (!("client" in context)) return context;
  return addWatchlistSecurityWithContext(context, value);
}

// ---------------------------------------------------------------------------
// Add a currency pair: two ISO codes chosen from the `currencies` table --
// no provider search involved.
// ---------------------------------------------------------------------------

export async function addWatchlistCurrencyPairWithContext(
  context: WatchlistActionContext,
  value: unknown,
): Promise<WatchlistEntryActionResult> {
  const input = record(value);
  const baseCurrencyCode =
    typeof input.baseCurrencyCode === "string"
      ? input.baseCurrencyCode.trim().toUpperCase()
      : "";
  const quoteCurrencyCode =
    typeof input.quoteCurrencyCode === "string"
      ? input.quoteCurrencyCode.trim().toUpperCase()
      : "";
  if (
    !CURRENCY_CODE_PATTERN.test(baseCurrencyCode) ||
    !CURRENCY_CODE_PATTERN.test(quoteCurrencyCode)
  ) {
    return {
      ok: false,
      status: 400,
      message: "Two valid currency codes are required.",
    };
  }
  if (baseCurrencyCode === quoteCurrencyCode) {
    return {
      ok: false,
      status: 400,
      message: "Choose two different currencies.",
    };
  }
  const result = await createOwnedWatchlistRepository(
    context.client,
  ).addCurrencyPair(
    context.userId,
    baseCurrencyCode,
    quoteCurrencyCode,
    context.requestId,
  );
  if (!result.ok) {
    return {
      ok: false,
      status:
        result.reason === "not_found"
          ? 404
          : result.reason === "invalid_input"
            ? 400
            : 503,
      message:
        result.reason === "not_found"
          ? "Unknown currency code."
          : "The currency pair could not be added to the watchlist.",
    };
  }
  return { ok: true, entry: result.entry };
}

export async function addWatchlistCurrencyPairAction(
  value: unknown,
): Promise<WatchlistEntryActionResult> {
  const context = await authenticatedContext();
  if (!("client" in context)) return context;
  return addWatchlistCurrencyPairWithContext(context, value);
}

// ---------------------------------------------------------------------------
// Remove: a row affordance, version-guarded.
// ---------------------------------------------------------------------------

export type RemoveWatchlistEntryResult = { ok: true } | ActionFailure;

export async function removeWatchlistEntryWithContext(
  context: WatchlistActionContext,
  value: unknown,
): Promise<RemoveWatchlistEntryResult> {
  const input = record(value);
  const id =
    typeof input.id === "string" && input.id.length > 0 ? input.id : null;
  const expectedVersion = input.expectedVersion;
  if (!id || typeof expectedVersion !== "number") {
    return {
      ok: false,
      status: 400,
      message: "An entry id and its current version are required.",
    };
  }
  const result = await createOwnedWatchlistRepository(context.client).remove(
    context.userId,
    id,
    expectedVersion,
    context.requestId,
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.reason === "not_found" ? 404 : 409,
      message:
        result.reason === "not_found"
          ? "That watch entry was already removed."
          : "This watchlist changed elsewhere -- reload and retry.",
    };
  }
  return { ok: true };
}

export async function removeWatchlistEntryAction(
  value: unknown,
): Promise<RemoveWatchlistEntryResult> {
  const context = await authenticatedContext();
  if (!("client" in context)) return context;
  return removeWatchlistEntryWithContext(context, value);
}

// ---------------------------------------------------------------------------
// Reorder: the drag/move affordance, submitting the owner's whole desired
// order in one request.
// ---------------------------------------------------------------------------

export type ReorderWatchlistActionResult =
  { ok: true; entries: WatchlistEntryRecord[] } | ActionFailure;

export async function reorderWatchlistWithContext(
  context: WatchlistActionContext,
  value: unknown,
): Promise<ReorderWatchlistActionResult> {
  const input = record(value);
  const orderedIds =
    Array.isArray(input.orderedIds) &&
    input.orderedIds.every((entry) => typeof entry === "string")
      ? (input.orderedIds as string[])
      : null;
  if (!orderedIds || orderedIds.length === 0) {
    return {
      ok: false,
      status: 400,
      message: "An ordered list of watch entries is required.",
    };
  }
  const result = await createOwnedWatchlistRepository(context.client).reorder(
    context.userId,
    orderedIds,
    context.requestId,
  );
  if (!result.ok) {
    return {
      ok: false,
      status:
        result.reason === "conflict"
          ? 409
          : result.reason === "invalid_input"
            ? 400
            : 503,
      message:
        result.reason === "conflict"
          ? "The watchlist changed elsewhere -- reload and retry."
          : "The watchlist could not be reordered.",
    };
  }
  return { ok: true, entries: result.entries };
}

export async function reorderWatchlistAction(
  value: unknown,
): Promise<ReorderWatchlistActionResult> {
  const context = await authenticatedContext();
  if (!("client" in context)) return context;
  return reorderWatchlistWithContext(context, value);
}
