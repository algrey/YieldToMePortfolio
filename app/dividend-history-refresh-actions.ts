// UI-006C: owner-initiated per-security dividend/split provider re-pull
// ("Refresh historical", behind a client-side confirmation dialog).
//
// Reuses MKT-005's `ingestSecurityCorporateActionHistory` UNCHANGED -- the
// same full-pull-and-reconcile function `app/security-verification-service.ts`
// invokes after IMP-004B verification (ingestion trigger a) and the periodic
// sweep (trigger b) already use -- via the identical bounded, short-timeout
// provider config (`BOUNDED_CORPORATE_ACTION_PROVIDER_OPTIONS`) so a
// struggling provider bounds this interactive request's worst-case latency
// rather than leaving it merely failure-tolerant.
//
// Preserves every owner override/exclusion (TASKS.md UI-006C's acceptance
// criterion) BY CONSTRUCTION, not by any special-cased logic here: ingestion
// only ever writes to `dividend_events`/`split_events`/
// `corporate_action_refresh_state`; it never reads, writes, or supersedes
// `dividend_event_overrides` or `dividend_manual_records`. An override stays
// attached to its original `dividend_event_id`, and `domain/dividends/
// history.ts`'s `resolveEventOverrideForLineage` re-resolves it against
// whichever event in that id's supersession lineage is current EVERY time
// history is derived (read time, not write time) -- so a re-pull that
// supersedes a changed event automatically carries the prior override
// forward without this module doing anything about it.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  ingestSecurityCorporateActionHistory,
  type CorporateActionIngestionSummary,
  type MarketDataProvider,
} from "../domain/market-data/index.ts";
import {
  BOUNDED_CORPORATE_ACTION_PROVIDER_OPTIONS,
  PROVIDER_ID,
  resolveConfiguredProvider,
} from "./security-verification-service.ts";

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 502 | 503;
  message: string;
};

export type RefreshSecurityDividendHistoryResult =
  { ok: true; summary: CorporateActionIngestionSummary } | ActionFailure;

export type DividendRefreshActionContext = Readonly<{
  client: SqlClient;
  userId: string;
}>;

async function authenticatedContext(
  portfolioId: string,
): Promise<DividendRefreshActionContext | ActionFailure> {
  const { getAuthenticatedSqlContext } = await import("./portfolio-actions.ts");
  return getAuthenticatedSqlContext(portfolioId);
}

export async function refreshSecurityDividendHistoryWithContext(
  context: DividendRefreshActionContext,
  portfolioId: string,
  portfolioSecurityId: string,
  options: { provider?: MarketDataProvider; now?: () => string } = {},
): Promise<RefreshSecurityDividendHistoryResult> {
  const holding = await context.client.get<{ security_id: string }>(
    `SELECT security_id FROM portfolio_securities
     WHERE id = ? AND user_id = ? AND portfolio_id = ? AND security_id IS NOT NULL
     LIMIT 1`,
    [portfolioSecurityId, context.userId, portfolioId],
  );
  if (!holding) {
    return { ok: false, status: 404, message: "That security was not found." };
  }
  const securityId = holding.security_id;

  const mapping = await context.client.get<{ id: string }>(
    `SELECT id FROM security_provider_mappings
     WHERE security_id = ? AND provider_id = ? AND valid_to IS NULL LIMIT 1`,
    [securityId, PROVIDER_ID],
  );
  if (!mapping) {
    return {
      ok: false,
      status: 404,
      message:
        "This security has no verified market-data mapping to refresh from.",
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
      message: "Market-data refresh is not available for this deployment.",
    };
  }

  const provider =
    options.provider ??
    (await resolveConfiguredProvider(
      context.client,
      BOUNDED_CORPORATE_ACTION_PROVIDER_OPTIONS,
    ));
  const result = await ingestSecurityCorporateActionHistory({
    client: context.client,
    provider,
    providerId: PROVIDER_ID,
    securityId,
    mappingId: mapping.id,
    scope: { kind: "deployment", userId: null },
    now: options.now,
  });
  if (!result.ok) {
    return {
      ok: false,
      status: 502,
      message:
        "The market-data provider could not be reached. Try again later.",
    };
  }
  return { ok: true, summary: result.summary };
}

export async function refreshSecurityDividendHistoryAction(
  portfolioId: string,
  portfolioSecurityId: string,
): Promise<RefreshSecurityDividendHistoryResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return context;
  return refreshSecurityDividendHistoryWithContext(
    context,
    portfolioId,
    portfolioSecurityId,
  );
}
