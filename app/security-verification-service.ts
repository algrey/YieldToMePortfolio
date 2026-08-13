import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createOwnedSecurityVerificationRepository,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview.ts";
import type { ImportPreviewSecurityCandidate } from "../domain/imports/reconciliation.ts";
import { evaluateSecurityIdentityCandidates } from "../domain/securities/verify-identity.ts";
import {
  createDisabledMarketDataProvider,
  createYahooCompatibleProvider,
  ingestSecurityCorporateActionHistory,
  type MarketDataError,
  type MarketDataProvider,
} from "../domain/market-data/index.ts";
import {
  resolveRuntimeConfig,
  type RuntimeEnvInput,
} from "../worker/runtime-config.ts";

const PROVIDER_ID = "yahoo-compatible";

export type SecurityVerifyActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 502 | 503;
  message: string;
};

export type SecurityVerifyActionSuccess = {
  ok: true;
  review: ImportReviewPreview;
};

export type SecurityVerifyActionContext = {
  client: SqlClient;
  userId: string;
};

export type SecurityVerifyActionOptions = {
  provider?: MarketDataProvider;
  now?: () => string;
};

// A standalone copy of `loadReview` (app/import-actions.ts) / `loadImportReview`
// (app/import-ready-service.ts) for the same reason those two already
// duplicate it: this module must only depend on `db/repositories/index.ts`
// and `import-preview.ts`, never `./portfolio-actions.ts` (which pulls in
// `next/headers` and the D1 binding resolver), so `verifySecurityCandidateWithContext`
// stays directly testable against a plain sqlite-backed `SqlClient`.
async function loadImportReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | SecurityVerifyActionFailure> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows(userId, batchId),
      staging.listIssues(userId, batchId),
      createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
      createOwnedPortfolioRepository(client).list(userId),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
        source_currency_code, security_id
       FROM portfolio_securities
       WHERE user_id = ?
       ORDER BY source_symbol ASC, id ASC`,
        [userId],
      ),
    ],
  );
  const securityCandidates: ImportPreviewSecurityCandidate[] =
    candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    }));
  return buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates,
  });
}

function providerFailureMessage(error: MarketDataError): string {
  switch (error.kind) {
    case "symbol_not_found":
      return "The provider found no security matching this symbol.";
    case "rate_limit":
      return "The market-data provider is rate-limited. Try again later.";
    case "timeout":
    case "transient_upstream":
      return "The market-data provider is temporarily unavailable. Try again later.";
    case "authentication":
    case "entitlement":
      return "The market-data provider rejected this request.";
    case "unavailable_capability":
      return "Security verification is unavailable for this deployment.";
    case "invalid_response":
    default:
      return "The market-data provider returned an unexpected response.";
  }
}

// Mirrors `worker/scheduled-refresh.ts`'s provider construction (the only
// existing precedent for building a live `MarketDataProvider`): read
// `MARKET_DATA_PROVIDER` from the Worker env and fall back to the disabled
// stub (which fails every call with `unavailable_capability`) rather than a
// special-cased null, so callers always get a real `MarketDataProvider` and
// "disabled" flows through the same explicit-failure path as any other
// provider error. `boundedRequest`, when set, tightens retry/timeout for a
// caller that cannot tolerate the adapter's default worst-case latency (see
// `BOUNDED_CORPORATE_ACTION_PROVIDER_OPTIONS` below).
async function resolveConfiguredProvider(
  client: SqlClient,
  boundedRequest?: { maxAttempts: number; timeoutMs: number },
): Promise<MarketDataProvider> {
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeConfig = resolveRuntimeConfig(env as RuntimeEnvInput);
    if (
      !runtimeConfig.ok ||
      runtimeConfig.config.marketDataProvider === "disabled"
    ) {
      return createDisabledMarketDataProvider();
    }
    return createYahooCompatibleProvider({
      providerId: PROVIDER_ID,
      fetcher: fetch,
      resolveSymbol: async (mappingId) => {
        const mapping = await client.get<{ provider_symbol: string }>(
          `SELECT provider_symbol FROM security_provider_mappings
           WHERE id = ? AND provider_id = ? AND status = 'verified' LIMIT 1`,
          [mappingId, PROVIDER_ID],
        );
        return mapping?.provider_symbol ?? null;
      },
      ...boundedRequest,
    });
  } catch {
    return createDisabledMarketDataProvider();
  }
}

// MKT-005 review fix (B2): the default adapter allows up to 3 attempts at
// an 8s timeout each plus backoff, i.e. tens of seconds of worst-case
// latency. That is acceptable for the primary search request this
// interactive endpoint exists to serve, but NOT for the best-effort
// corporate-action ingestion that follows a successful verify -- a single
// attempt with a short timeout bounds this call to a few seconds instead of
// leaving it merely "eventually catches its own failure".
const BOUNDED_CORPORATE_ACTION_PROVIDER_OPTIONS = {
  maxAttempts: 1,
  timeoutMs: 3_000,
};

// Implements IMP-004B: an owner requests server-side verification for one
// brand-new unresolved import security candidate. Verification is
// evidence-based (a provider identity lookup with currency/exchange
// agreement, per AGENTS.md's market-data non-negotiables) and this function
// is the ONLY production write path into the shared `securities` master --
// user input alone never publishes (see `createOwnedSecurityVerificationRepository`
// for the creation-only/dedupe/atomicity guarantees).
export async function verifySecurityCandidateWithContext(
  context: SecurityVerifyActionContext,
  batchId: string,
  value: unknown,
  options: SecurityVerifyActionOptions = {},
): Promise<SecurityVerifyActionSuccess | SecurityVerifyActionFailure> {
  const input = value as Record<string, unknown>;
  const portfolioId =
    typeof input?.portfolioId === "string" ? input.portfolioId.trim() : "";
  const sourceSymbol =
    typeof input?.sourceSymbol === "string" ? input.sourceSymbol.trim() : "";
  const sourceExchangeAlias =
    typeof input?.sourceExchangeAlias === "string" &&
    input.sourceExchangeAlias.trim().length > 0
      ? input.sourceExchangeAlias.trim()
      : null;
  const sourceCurrencyCode =
    typeof input?.sourceCurrencyCode === "string"
      ? input.sourceCurrencyCode.trim()
      : "";
  const expectedVersion = input?.expectedVersion;
  const expectedPreviewVersion = input?.expectedPreviewVersion;
  if (
    !portfolioId ||
    !sourceSymbol ||
    !sourceCurrencyCode ||
    typeof expectedVersion !== "number" ||
    typeof expectedPreviewVersion !== "string"
  ) {
    return {
      ok: false,
      status: 400,
      message: "Complete the labelled verification fields.",
    };
  }

  const staging = createOwnedImportStagingRepository(context.client);
  const batch = await staging.get(context.userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  if (batch.version !== expectedVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before verifying.",
    };
  }

  const review = await loadImportReview(
    context.client,
    context.userId,
    batchId,
  );
  if ("ok" in review) return review;
  if (review.previewVersion !== expectedPreviewVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before verifying.",
    };
  }

  const portfolio = await createOwnedPortfolioRepository(context.client).get(
    context.userId,
    portfolioId,
  );
  if (!portfolio)
    return { ok: false, status: 404, message: "Portfolio not found." };

  // Re-derive the request server-side from the current, database-backed
  // preview rather than trusting the client's fields directly: only a
  // symbol that the server itself currently reports as an unresolved
  // candidate (never mutated/overwritten by this request, per IMP-004B's
  // decision constraints) is eligible for verification.
  const candidateStillUnresolved = review.preview.unresolvedCandidates.some(
    (candidate) =>
      candidate.portfolioId === portfolioId &&
      candidate.sourceSymbol === sourceSymbol &&
      (candidate.sourceExchangeAlias ?? null) === sourceExchangeAlias &&
      candidate.sourceCurrencyCode === sourceCurrencyCode &&
      candidate.securityId === null,
  );
  if (!candidateStillUnresolved) {
    return {
      ok: false,
      status: 409,
      message:
        "This symbol is no longer an unresolved candidate. Reload the preview.",
    };
  }

  const providerRow = await context.client.get<{ status: string }>(
    `SELECT status FROM market_data_providers WHERE id = ? LIMIT 1`,
    [PROVIDER_ID],
  );
  if (!providerRow || providerRow.status !== "enabled") {
    return {
      ok: false,
      status: 503,
      message: "Market-data verification is not available for this deployment.",
    };
  }

  const provider =
    options.provider ?? (await resolveConfiguredProvider(context.client));
  const search = await provider.searchSecurities({
    text: sourceSymbol,
    exchangeId: sourceExchangeAlias ?? undefined,
    currencyCode: sourceCurrencyCode,
  });
  if (!search.ok) {
    return {
      ok: false,
      status: 502,
      message: providerFailureMessage(search.error),
    };
  }

  const outcome = evaluateSecurityIdentityCandidates(
    {
      symbol: sourceSymbol,
      exchangeAlias: sourceExchangeAlias,
      currencyCode: sourceCurrencyCode,
    },
    search.value,
  );
  if (!outcome.ok) {
    return { ok: false, status: 502, message: outcome.message };
  }

  const repository = createOwnedSecurityVerificationRepository(
    context.client,
    options.now,
  );
  const link = await repository.publishAndLink(
    context.userId,
    PROVIDER_ID,
    outcome.identity,
    { portfolioId, sourceSymbol, sourceExchangeAlias, sourceCurrencyCode },
  );
  if (!link.ok) {
    if (link.reason === "currency_mismatch") {
      return {
        ok: false,
        status: 502,
        message:
          "The existing security for this identity has a different currency than the verified match.",
      };
    }
    return {
      ok: false,
      status: 409,
      message:
        "This security could not be linked; it may already be linked to another symbol in this portfolio.",
    };
  }

  // MKT-005 ingestion trigger (a): pull the newly verified security's full
  // provider dividend/split history now that it is held. This never fails
  // the verification response (result is discarded, wrapped in try/catch),
  // and its worst-case latency is bounded rather than merely
  // failure-tolerant: it runs on a DEDICATED provider instance configured
  // with a single attempt and a short (3s) timeout
  // (`BOUNDED_CORPORATE_ACTION_PROVIDER_OPTIONS`), separate from the
  // `provider` instance used for search above (which keeps the default
  // multi-attempt/8s-timeout behaviour appropriate for the primary request
  // this endpoint exists to serve). A transient provider/network failure
  // here must not prevent the owner's import from proceeding, and the
  // periodic refresh sweep (`runScheduledCorporateActionRefresh`) and the
  // owner-initiated re-pull (DIV-001/UI-006C, same underlying function)
  // both pick up anything missed here later. When a test supplies
  // `options.provider` directly, that same instance is reused here (its
  // latency is already test-controlled).
  const mapping = await context.client.get<{ id: string }>(
    `SELECT id FROM security_provider_mappings
     WHERE security_id = ? AND provider_id = ? AND valid_to IS NULL LIMIT 1`,
    [link.securityId, PROVIDER_ID],
  );
  if (mapping) {
    try {
      const ingestionProvider =
        options.provider ??
        (await resolveConfiguredProvider(
          context.client,
          BOUNDED_CORPORATE_ACTION_PROVIDER_OPTIONS,
        ));
      await ingestSecurityCorporateActionHistory({
        client: context.client,
        provider: ingestionProvider,
        providerId: PROVIDER_ID,
        securityId: link.securityId,
        mappingId: mapping.id,
        scope: { kind: "deployment", userId: null },
        now: options.now,
      });
    } catch {
      // Best-effort: see the comment above.
    }
  }

  const refreshed = await loadImportReview(
    context.client,
    context.userId,
    batchId,
  );
  return "ok" in refreshed ? refreshed : { ok: true, review: refreshed };
}
