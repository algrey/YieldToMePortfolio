// UI-006B: owner-scoped read service for the dividend assumptions editor
// (`/portfolio/:id/income/assumptions`). Composes the same DB-005
// repositories DIV-003's assumption grid consumes, but returns the RAW
// owner-entered values (not DIV-003's resolved owner-vs-provider merge)
// plus each row's `version`, because an EDITOR must show the provider value
// and the owner override side by side and let a blank owner cell fall back
// to the provider value -- `domain/dividends/projection.ts`'s
// `YieldAssumptionResolution` intentionally collapses the two into a single
// applied figure, which is the wrong shape for this screen.
//
// Provider TTM yield reuses `domain/market-data/dividend-yield.ts`'s
// `deriveTrailingDividendYield`, fed by this screen's own `dividend_events` +
// current-price-from-holdings read (below) -- a raw provider-events-only
// figure, deliberately not the owner's resolved figure, matching this
// screen's own "show provider vs. owner side by side" charter above.
//
// DIV-009 note (review round-1, recorded as a follow-up, not fixed here):
// `app/owned-income-projection.ts`'s DIV-003 assumption grid no longer
// mirrors this -- it now resolves its "yield" column from each security's
// ALREADY-COMPUTED forecast TTM (`SecurityDividendForecast.ttmPerShareDecimal`/
// `ttmSource`, which can be provider- OR history-derived, DIV-008's
// fallback), not from a second `deriveTrailingDividendYield(dividend_events, ...)`
// call. This EDITOR's "provider yield" column therefore no longer reflects
// what DIV-003's grid actually bases its resolved yield on for a
// history-derived security (it still shows a raw, possibly-`insufficient_history`
// provider-only figure even when DIV-003 successfully resolved a real
// history-derived yield for the same security) -- a scope decision left for
// a future task, not addressed by DIV-009. Provider franking has no source
// in this codebase (an honest, always-"unavailable" seam for a future
// provider, per the owner's 2026-08-13 wireframe decision), so it is a
// constant, never derived.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { createDividendAssumptionsRepository } from "../db/repositories/dividends.ts";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios.ts";
import { loadOwnedHoldings } from "./owned-holdings.ts";
import { loadOwnedDividendHistory } from "./owned-dividend-history.ts";
import { currentFyWindow } from "../domain/calculations/financial-year.ts";
import {
  deriveTrailingDividendYield,
  type TrailingDividendEventInput,
  type TrailingDividendYieldResult,
} from "../domain/market-data/dividend-yield.ts";
import {
  resolveAssumptionBridgeStatus,
  type AssumptionBridgeStatus,
} from "../domain/dividends/projection.ts";

const MAX_SECURITIES = 500;
const MAX_EVENTS_PER_PORTFOLIO = 20_000;

type Row = Record<string, unknown>;

function inClause(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

export type DividendAssumptionsSecurityRow = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  /** Read-only. `ok: false` (most commonly `insufficient_history`/`price_unavailable`) is an honest "unavailable", never a fabricated 0%. */
  providerYield: TrailingDividendYieldResult;
  /** Always `"unavailable"` -- no provider in this codebase reports a franked proportion (owner wireframe decision, 2026-08-13). Kept as an explicit column rather than omitted, as a seam for a future source. */
  providerFrankingStatus: "unavailable";
  ownerYieldPercentDecimal: string | null;
  ownerFrankingPercentDecimal: string | null;
  ownerGrowthPercentDecimal: string | null;
  /** DIV-016 part B (override-as-bridge): the owner's explicit
   * `force_assumption` flag -- `true` restores override-wins regardless of
   * `hasFullYearHistoryEvidence`. Defaults to `false`. */
  forceAssumption: boolean;
  /** DIV-016 part B: this security's per-security bridge status, covering
   * BOTH the yield and franking assumption fields together (they share the
   * same evidence/force gate) -- `"not_set"` when neither is set,
   * `"active"` while bridging (<12 months of history evidence),
   * `"dormant"` once 12+ months of evidence exists and the override was
   * not forced (still shown, excluded from the forecast/projection),
   * `"forced"` when the owner's `force_assumption` flag is set. Derived
   * from `SecurityDividendForecast.hasFullYearHistoryEvidence` --
   * `computeSecurityDividendForecast`'s own already-computed evidence
   * determination, never a second 12-months formula. */
  bridgeStatus: AssumptionBridgeStatus;
  /** `null` when the owner has never saved assumptions for this security -- the grid save must send `expectedVersion: null` (create) for this row. */
  version: number | null;
};

export type DividendAssumptionsPortfolioRow = {
  valueGrowthPercentDecimal: string | null;
  portfolioDividendGrowthPercentDecimal: string | null;
  /** `null` when the owner has never saved portfolio-level assumptions -- save must send `expectedVersion: null` (create). */
  version: number | null;
};

export type OwnedDividendAssumptions = {
  today: string;
  securities: DividendAssumptionsSecurityRow[];
  portfolio: DividendAssumptionsPortfolioRow;
};

export async function loadOwnedDividendAssumptions(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
): Promise<OwnedDividendAssumptions> {
  const portfolio = await client.get<Row>(
    `SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) throw new Error("not_owned");

  const settings = await createOwnedUserSettingsRepository(client).get(userId);
  if (!settings) throw new Error("missing_user_settings");
  const currentWindow = currentFyWindow(
    now.toISOString(),
    settings.financialYearStartMonth,
    settings.timezone,
  );
  if (!currentWindow.ok)
    throw new Error(`invalid_fy_window:${currentWindow.reason}`);
  const today = currentWindow.window.endDate;

  const assumptions = createDividendAssumptionsRepository(client);
  const portfolioAssumptions = await assumptions.getPortfolioAssumptions(
    userId,
    portfolioId,
  );
  const portfolioRow: DividendAssumptionsPortfolioRow = {
    valueGrowthPercentDecimal:
      portfolioAssumptions?.valueGrowthPercentDecimal ?? null,
    portfolioDividendGrowthPercentDecimal:
      portfolioAssumptions?.portfolioDividendGrowthPercentDecimal ?? null,
    version: portfolioAssumptions?.version ?? null,
  };

  const identityRows = await client.all<Row>(
    `SELECT ps.id, ps.security_id, COALESCE(ps.display_symbol, ps.source_symbol) AS symbol,
            s.primary_currency_code
     FROM portfolio_securities ps
     JOIN securities s ON s.id = ps.security_id
     WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held'
     ORDER BY ps.id LIMIT ?`,
    [userId, portfolioId, MAX_SECURITIES + 1],
  );
  if (identityRows.length > MAX_SECURITIES)
    throw new Error("too_many_securities");
  const identities = identityRows.map((row) => ({
    id: String(row.id),
    securityId: String(row.security_id),
    symbol: String(row.symbol),
    currencyCode: String(row.primary_currency_code),
  }));

  if (identities.length === 0) {
    return { today, securities: [], portfolio: portfolioRow };
  }

  const securityAssumptionsRecords = await assumptions.listSecurityAssumptions(
    userId,
    portfolioId,
  );
  const securityAssumptionsById = new Map(
    securityAssumptionsRecords.map((record) => [
      record.portfolioSecurityId,
      record,
    ]),
  );

  // Provider yield needs a current price -- read-only, so a holdings-pipeline
  // failure (e.g. no published calculation yet) degrades every provider
  // column to `price_unavailable` rather than failing this whole screen.
  let holdings: Awaited<ReturnType<typeof loadOwnedHoldings>> | null = null;
  try {
    holdings = await loadOwnedHoldings(client, userId, portfolioId, now);
  } catch {
    holdings = null;
  }
  const holdingsByPortfolioSecurityId = new Map(
    (holdings?.rows ?? []).map((row) => [row.id, row]),
  );

  // DIV-016 part B: `hasFullYearHistoryEvidence` per security is
  // `computeSecurityDividendForecast`'s OWN already-computed evidence
  // determination (`loadOwnedDividendHistory`'s per-security `forecast`)
  // -- reused here for the bridge-status column, never re-derived. A
  // history-load failure degrades every row WITH an override to `"active"`
  // (bridging -- evidence reads as absent, so the override keeps winning;
  // conservative: never silently claims a live override has gone
  // dormant when evidence genuinely could not be checked) rather than
  // failing this whole screen, matching the holdings-pipeline degrade
  // above.
  let evidenceBySecurityId = new Map<string, boolean>();
  try {
    const history = await loadOwnedDividendHistory(
      client,
      userId,
      portfolioId,
      now,
    );
    evidenceBySecurityId = new Map(
      history.securities.map((security) => [
        security.portfolioSecurityId,
        security.forecast.hasFullYearHistoryEvidence,
      ]),
    );
  } catch {
    evidenceBySecurityId = new Map();
  }

  const securityIds = [...new Set(identities.map((row) => row.securityId))];
  const eventsBySecurityId = new Map<string, TrailingDividendEventInput[]>();
  const eventRows = await client.all<Row>(
    `SELECT security_id, kind, status, ex_date, currency_code, gross_per_share_decimal
     FROM dividend_events
     WHERE security_id IN (${inClause(securityIds.length)})
     LIMIT ?`,
    [...securityIds, MAX_EVENTS_PER_PORTFOLIO + 1],
  );
  if (eventRows.length > MAX_EVENTS_PER_PORTFOLIO)
    throw new Error("too_many_dividend_events");
  for (const row of eventRows) {
    if (row.gross_per_share_decimal === null || row.ex_date === null) continue;
    const securityId = String(row.security_id);
    const list = eventsBySecurityId.get(securityId) ?? [];
    list.push({
      exDate: String(row.ex_date),
      currencyCode: String(row.currency_code),
      grossPerShareDecimal: String(row.gross_per_share_decimal),
      kind: String(row.kind) as TrailingDividendEventInput["kind"],
      status: String(row.status) as TrailingDividendEventInput["status"],
    });
    eventsBySecurityId.set(securityId, list);
  }

  const securities: DividendAssumptionsSecurityRow[] = identities.map(
    (identity) => {
      const holdingRow = holdingsByPortfolioSecurityId.get(identity.id);
      const nativePrice = holdingRow?.nativePrice ?? null;
      const events = eventsBySecurityId.get(identity.securityId) ?? [];
      const providerYield = deriveTrailingDividendYield(
        events,
        today,
        nativePrice !== null
          ? { amountDecimal: nativePrice, currencyCode: identity.currencyCode }
          : null,
      );
      const ownerAssumptions = securityAssumptionsById.get(identity.id);
      const forceAssumption = ownerAssumptions?.forceAssumption ?? false;
      const hasFullYearHistoryEvidence =
        evidenceBySecurityId.get(identity.id) ?? false;
      const hasAnyOverride =
        (ownerAssumptions?.dividendYieldPercentDecimal ?? null) !== null ||
        (ownerAssumptions?.frankingPercentDecimal ?? null) !== null;
      const bridgeStatus = resolveAssumptionBridgeStatus(
        hasAnyOverride,
        hasFullYearHistoryEvidence,
        forceAssumption,
      );
      return {
        portfolioSecurityId: identity.id,
        symbol: identity.symbol,
        currencyCode: identity.currencyCode,
        providerYield,
        providerFrankingStatus: "unavailable",
        ownerYieldPercentDecimal:
          ownerAssumptions?.dividendYieldPercentDecimal ?? null,
        ownerFrankingPercentDecimal:
          ownerAssumptions?.frankingPercentDecimal ?? null,
        forceAssumption,
        bridgeStatus,
        ownerGrowthPercentDecimal:
          ownerAssumptions?.dividendGrowthPercentDecimal ?? null,
        version: ownerAssumptions?.version ?? null,
      };
    },
  );

  return { today, securities, portfolio: portfolioRow };
}
