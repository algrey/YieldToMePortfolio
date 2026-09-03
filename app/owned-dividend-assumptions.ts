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
import { loadOwnedHoldings } from "./owned-holdings.ts";
import { loadOwnedDividendHistory } from "./owned-dividend-history.ts";
import { resolveOwnedPortfolioContext } from "./owned-portfolio-context.ts";
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
  // PRF-012: resolves the portfolio/`user_settings`/held-identity facts
  // ONCE for this whole screen -- this function's own ownership gate plus
  // FY-window settings, its own held-identity read below, and the
  // `loadOwnedHoldings`/`loadOwnedDividendHistory` calls further down all
  // independently re-read the SAME facts. Each still asserts the context
  // belongs to `userId`/`portfolioId` before trusting it.
  const context = await resolveOwnedPortfolioContext(
    client,
    userId,
    portfolioId,
  );
  const settings = context.settings;
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

  // PRF-012: `context.identities`, filtered to held, is the SAME row set
  // this screen's own identity query used to fetch separately -- the
  // `MAX_SECURITIES` cap below is unchanged, still enforced on the same
  // held-only subset.
  const identities = context.identities
    .filter((identity) => identity.status === "held")
    .map((identity) => ({
      id: identity.id,
      securityId: identity.securityId,
      symbol: identity.symbol,
      currencyCode: identity.primaryCurrencyCode,
    }));
  if (identities.length > MAX_SECURITIES)
    throw new Error("too_many_securities");

  if (identities.length === 0) {
    return { today, securities: [], portfolio: portfolioRow };
  }

  const securityIds = [...new Set(identities.map((row) => row.securityId))];
  // PRF-005: `securityAssumptionsRecords`, `holdings`, `history`, and
  // `eventRows` are four more mutually independent reads (none consumes
  // another's output -- `securityIds` above is derived from `identities`,
  // already resolved) -- collapsed into one wave instead of four
  // sequential round trips. `holdings`/`history` keep their ORIGINAL
  // degrade-to-null-on-failure behaviour via `.catch` on each promise
  // directly (a holdings-pipeline or dividend-history failure must stay
  // LOCAL and never fail this whole screen, per each read's own comment
  // below) so neither can reject this `Promise.all`; `securityAssumptionsRecords`/
  // `eventRows` are NOT caught, matching their original propagate-on-
  // failure behaviour.
  const [securityAssumptionsRecords, holdings, history, eventRows] =
    await Promise.all([
      assumptions.listSecurityAssumptions(userId, portfolioId),
      // Provider yield needs a current price -- read-only, so a
      // holdings-pipeline failure (e.g. no published calculation yet)
      // degrades every provider column to `price_unavailable` rather than
      // failing this whole screen.
      //
      // PRF-008 (owner ruling): this screen (`/income/assumptions`) uses
      // `nativePrice` only as an input to `deriveTrailingDividendYield`'s
      // derived "provider TTM yield" column -- it never renders a price
      // itself, live or otherwise. Explicitly opts OUT of the BRK-012C
      // freshness gate ("skip") for the same reason `owned-income-
      // projection.ts` does: no live/current price is displayed here, so
      // forcing a Sharesight fetch on a cold watermark buys nothing.
      // Whatever price data already exists is still read and used exactly
      // as before; the hourly cron remains the refresh path.
      loadOwnedHoldings(
        client,
        userId,
        portfolioId,
        now,
        {},
        "skip",
        context,
      ).catch(() => null),
      // DIV-016 part B: `hasFullYearHistoryEvidence` per security is
      // `computeSecurityDividendForecast`'s OWN already-computed evidence
      // determination (`loadOwnedDividendHistory`'s per-security
      // `forecast`) -- reused here for the bridge-status column, never
      // re-derived. A history-load failure degrades every row WITH an
      // override to `"active"` (bridging -- evidence reads as absent, so
      // the override keeps winning; conservative: never silently claims a
      // live override has gone dormant when evidence genuinely could not
      // be checked) rather than failing this whole screen, matching the
      // holdings-pipeline degrade above.
      loadOwnedDividendHistory(
        client,
        userId,
        portfolioId,
        now,
        undefined,
        context,
      ).catch(() => null),
      client.all<Row>(
        `SELECT security_id, kind, status, ex_date, currency_code, gross_per_share_decimal
         FROM dividend_events
         WHERE security_id IN (${inClause(securityIds.length)})
         LIMIT ?`,
        [...securityIds, MAX_EVENTS_PER_PORTFOLIO + 1],
      ),
    ]);
  const securityAssumptionsById = new Map(
    securityAssumptionsRecords.map((record) => [
      record.portfolioSecurityId,
      record,
    ]),
  );
  const holdingsByPortfolioSecurityId = new Map(
    (holdings?.rows ?? []).map((row) => [row.id, row]),
  );
  const evidenceBySecurityId = new Map<string, boolean>(
    history
      ? history.securities.map((security) => [
          security.portfolioSecurityId,
          security.forecast.hasFullYearHistoryEvidence,
        ])
      : [],
  );

  const eventsBySecurityId = new Map<string, TrailingDividendEventInput[]>();
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
