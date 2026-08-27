import { headers } from "next/headers";
import {
  decodeAccessJwtBase64Url,
  type VerifiedAccessPrincipal,
} from "../domain/auth/access-jwt";
import { resolveAuthenticatedRequestContext } from "../domain/auth/request-context";
import { VERIFIED_PRINCIPAL_HEADER } from "../domain/auth/verified-principal-header";
import {
  REQUEST_NOW_HEADER,
  resolveRequestNow,
} from "../domain/observability/index.ts";
import { createOwnedPortfolioRepository } from "../db/repositories/owned-portfolios";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios";
import { createOwnedWorkspace } from "./owned-workspace";
import type { OwnedWorkspace } from "./components/portfolio-shell";
import { loadOwnedWatchlist } from "./owned-watchlist";
import { loadOwnedHoldings } from "./owned-holdings";
import { loadOwnedRealisedGainTotals } from "./owned-capital-gains";
import { buildHoldingsSummaryFooter } from "./owned-holdings-summary";
import { createHistoricalSnapshotRepository } from "../db/repositories/snapshots.ts";
import {
  advanceCalculationRuns,
  READ_TIME_SNAPSHOT_CALCULATION_BUDGET,
} from "./calculation-executor-service.ts";
import {
  createOverviewData,
  createUnavailableOverviewData,
} from "./overview-read-model";
import { loadHistoricalPortfolioValueSeries } from "./historical-portfolio-value.ts";
import { loadUsdAudRate } from "./authenticated-fx-rate.ts";

function isPrincipal(value: unknown): value is VerifiedAccessPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.tokenType === "app" &&
    typeof candidate.issuer === "string" &&
    typeof candidate.audience === "string" &&
    typeof candidate.subject === "string" &&
    (candidate.email === null || typeof candidate.email === "string") &&
    (candidate.issuedAt === null || typeof candidate.issuedAt === "number") &&
    typeof candidate.notBefore === "number" &&
    typeof candidate.expiresAt === "number" &&
    typeof candidate.keyId === "string"
  );
}

function unavailableWorkspace(message: string): OwnedWorkspace {
  return {
    status: "unavailable",
    message,
    activePortfolio: null,
    portfolios: [],
    quotes: [],
    quoteViewState: "empty",
  };
}

export async function loadAuthenticatedWorkspace(
  requestedPortfolioId?: string,
  options: {
    includeQuotes?: boolean;
    includeOverview?: boolean;
    includeHoldings?: boolean;
  } = {},
): Promise<OwnedWorkspace> {
  const requestHeaders = await headers();
  const principalHeader = requestHeaders.get(VERIFIED_PRINCIPAL_HEADER);
  if (!principalHeader) {
    return unavailableWorkspace("Authentication is unavailable.");
  }

  let principal: VerifiedAccessPrincipal;
  try {
    const decoded = decodeAccessJwtBase64Url(principalHeader);
    if (!isPrincipal(decoded)) throw new Error("Invalid verified principal.");
    principal = decoded;
  } catch {
    return unavailableWorkspace("Authentication is unavailable.");
  }

  try {
    const { getSqlClient } = await import("../db/d1-sql-client");
    const client = await getSqlClient();
    const result = await resolveAuthenticatedRequestContext(
      client,
      principal,
      requestedPortfolioId,
    );
    const portfolioRecords = result.ok
      ? await createOwnedPortfolioRepository(client).list(
          result.context.user.id,
          {
            includeArchived: true,
          },
        )
      : [];
    const workspace = createOwnedWorkspace(result, portfolioRecords);
    if (!result.ok) return workspace;
    const settings = await createOwnedUserSettingsRepository(client).get(
      result.context.user.id,
    );
    // Resolved once, server-side, per request -- this is the single "now"
    // FY window math anchors on (see domain/calculations/financial-year.ts
    // and docs/CALCULATIONS.md §9). It must never be re-derived from a
    // history point's date (stale data would then falsely rename/mislabel
    // the FY) or recomputed client-side (non-deterministic across
    // server/client render, and drifts from the request's real "now").
    //
    // BUG-002 (hydration half): read from the Worker-stamped
    // `REQUEST_NOW_HEADER` (see `worker/index.ts` and
    // `domain/observability/request-correlation.ts`) rather than calling
    // `new Date()` directly here -- Vinext invokes this async Server
    // Component TWICE per request (a discarded probe pass, then the real
    // render), so a bare `new Date()` here could return two different
    // instants for the SAME request if a second/minute boundary fell
    // between the two invocations, desyncing the server-rendered HTML from
    // the RSC flight payload (a React hydration mismatch). The header
    // guarantees both invocations read the identical instant.
    // `resolveRequestNow` falls back to a fresh `new Date()` only when the
    // header is absent/malformed (tests, dev paths that bypass
    // `worker/index.ts`) -- it never throws on a missing header.
    const nowInstant = resolveRequestNow(
      requestHeaders.get(REQUEST_NOW_HEADER),
    );
    // UI-049: the app-bar USD/AUD pill is USER-scoped and renders on every
    // primary-tab page (the header itself, not any one section), so it is
    // resolved here -- unconditionally, before `configuredWorkspace` is
    // built and before the `options.includeX` branches below early-return
    // -- and folded into `configuredWorkspace` so every branch's
    // `...configuredWorkspace` spread carries it through. Best-effort: a
    // failure here must never take down the rest of the workspace,
    // mirroring `realisedGains`'s `.catch(() => undefined)` pattern below.
    const usdAudRate = await loadUsdAudRate(
      client,
      result.context.user.id,
      nowInstant.slice(0, 10),
    ).catch(() => null);
    const configuredWorkspace = settings
      ? {
          ...workspace,
          holdingCurrencyView: settings.defaultHoldingCurrencyView,
          financialYearStartMonth: settings.financialYearStartMonth,
          priceSourcePreference: settings.priceSourcePreference,
          dailyCaptureSource: settings.dailyCaptureSource,
          dailyCaptureIntervalMinutes: settings.dailyCaptureIntervalMinutes,
          timezone: settings.timezone,
          settingsVersion: settings.version,
          nowInstant,
          usdAudRate,
        }
      : { ...workspace, nowInstant, usdAudRate };
    // WLT-001: the watchlist is USER-scoped, not portfolio-scoped (owner
    // ruling, 2026-08-22) -- it must load whenever a real userId is known
    // (this point, `result.ok`), regardless of whether an active portfolio
    // exists. This branch therefore runs BEFORE the `activePortfolio ===
    // null` early return below, unlike the holdings/overview branches,
    // which genuinely need one.
    if (options.includeQuotes) {
      try {
        const quotes = await loadOwnedWatchlist(
          client,
          result.context.user.id,
          {
            now: new Date(nowInstant),
            priceSourcePreference: configuredWorkspace.priceSourcePreference,
            // UI-026: the watchlist is user-scoped (no portfolio of its
            // own), but this workspace load already knows whether ONE is
            // active -- pass its base currency through explicitly rather
            // than letting the watchlist module fall back to its own
            // no-portfolio default every time a portfolio genuinely exists.
            baseCurrencyCode:
              configuredWorkspace.activePortfolio?.baseCurrencyCode,
          },
        );
        const unavailable = quotes.filter(
          (quote) => quote.state === "unavailable",
        ).length;
        return {
          ...configuredWorkspace,
          quotes,
          quoteViewState:
            quotes.length === 0
              ? "empty"
              : unavailable === quotes.length
                ? "provider-error"
                : unavailable > 0
                  ? "partial"
                  : "populated",
        };
      } catch (error) {
        console.error("loadOwnedWatchlist failed", error);
        return {
          ...configuredWorkspace,
          quotes: [],
          quoteViewState: "provider-error",
        };
      }
    }
    if (configuredWorkspace.activePortfolio === null)
      return configuredWorkspace;
    if (!options.includeOverview && !options.includeHoldings)
      return configuredWorkspace;
    if (options.includeHoldings) {
      try {
        const holdings = await loadOwnedHoldings(
          client,
          result.context.user.id,
          configuredWorkspace.activePortfolio.id,
        );
        // UI-030: the holdings row's "Realised:" fourth line is a
        // best-effort enrichment on top of the already-working holdings
        // read above, mirroring `owned-holdings.ts`'s own Sharesight
        // price-freshness gate (`.catch(() => undefined)`) -- a failure
        // here (e.g. the CGT domain's calculation run not yet published,
        // a genuinely rare edge since `loadOwnedHoldings` above already
        // requires the SAME publication to exist) must never take down the
        // primary, already-honest holdings figures. `realisedGains` is
        // simply omitted on failure; `ownedHoldingRealisedGainLine`
        // (`owned-holding-format.tsx`) then omits the fourth line entirely
        // rather than rendering a guess.
        const realised = await loadOwnedRealisedGainTotals(
          client,
          result.context.user.id,
          configuredWorkspace.activePortfolio.id,
        ).catch(() => undefined);
        const realisedGains = realised
          ? Object.fromEntries(realised.bySecurity)
          : undefined;
        // UI-031: the holdings summary row's four lines, composed from
        // `holdings.unrealisedSummary` (server-computed in
        // `loadOwnedHoldings` from the SAME rows returned above) and this
        // SAME `realisedGains` map UI-030 already loads -- no additional
        // read, no second calculation path. `unrealisedSummary` is
        // `undefined` only when there are no held securities at all (see
        // its own doc comment), in which case there is nothing to
        // summarise and the holdings screen renders no summary row.
        const holdingsSummary = holdings.unrealisedSummary
          ? buildHoldingsSummaryFooter(
              configuredWorkspace.activePortfolio.baseCurrencyCode,
              holdings.unrealisedSummary,
              realisedGains,
            )
          : undefined;
        // UI-032: the securities-coverage-counts field the retired "Cash
        // separate" panel displayed is no longer threaded onto the
        // workspace -- `holdings.coverage` itself stays computed in
        // `loadOwnedHoldings` (it feeds `owned-income-projection.ts`'s
        // `portfolioValueCoverage`, a different, still-live consumer),
        // only this now-unread passthrough went.
        return {
          ...configuredWorkspace,
          holdings: holdings.rows,
          holdingsViewState: holdings.status,
          cash: holdings.cash,
          realisedGains,
          holdingsSummary,
        };
      } catch {
        return {
          ...configuredWorkspace,
          holdings: [],
          holdingsViewState: "unavailable",
        };
      }
    }
    if (options.includeOverview) {
      // HIST-001: the "portfolio value over time" graph is a SEPARATE,
      // best-effort read from the `overview`/`loadPublishedOverview` block
      // below -- it never depends on the CALC-003/CALC-004 persisted
      // snapshot pipeline (investigation found that pipeline had never
      // published for the real account under review; see
      // `docs/ARCHITECTURE.md`'s HIST-001 entry). A failure here must never
      // take down the existing Overview hero/coverage sections, so it gets
      // its OWN try/catch and its own honest "unavailable" fallback,
      // mirroring the `realisedGains` best-effort pattern above.
      const portfolioValueHistory = await loadHistoricalPortfolioValueSeries(
        client,
        result.context.user.id,
        configuredWorkspace.activePortfolio.id,
        new Date(nowInstant),
      )
        .then((result) =>
          result === null
            ? {
                status: "unavailable" as const,
                points: [],
                baseCurrencyCode:
                  configuredWorkspace.activePortfolio!.baseCurrencyCode,
                datesTruncated: false,
                backfillPending: false,
              }
            : {
                status:
                  result.points.length === 0
                    ? ("empty" as const)
                    : ("ok" as const),
                points: result.points,
                baseCurrencyCode: result.baseCurrencyCode,
                datesTruncated: result.datesTruncated,
                backfillPending: result.backfillPending,
              },
        )
        .catch(() => ({
          status: "unavailable" as const,
          points: [],
          baseCurrencyCode:
            configuredWorkspace.activePortfolio!.baseCurrencyCode,
          datesTruncated: false,
          backfillPending: false,
        }));
      // UI-047 (owner-reported): the Overview hero headline must show the
      // SAME securities-only current portfolio value the Holdings tab
      // (`buildHoldingsSummaryFooter`'s `marketValue`) and the HIST-001/
      // BUG-002 value-history graph already show -- never the
      // CALC-003/CALC-004 persisted-snapshot total below, which stays
      // cash-inclusive (BUG-002 only touched the HIST-001 series and live
      // holdings reads, not this dormant snapshot pipeline; the mismatch is
      // recorded as the existing CALC-005 follow-up in TASKS.md). Loaded
      // independently, mirroring `portfolioValueHistory` above: a failure
      // here must never take down the rest of Overview, so the headline
      // simply reads "unavailable" rather than dragging the whole screen
      // down with it.
      const holdingsSummary = await loadOwnedHoldings(
        client,
        result.context.user.id,
        configuredWorkspace.activePortfolio.id,
      )
        .then((holdings) =>
          holdings.unrealisedSummary
            ? buildHoldingsSummaryFooter(
                configuredWorkspace.activePortfolio!.baseCurrencyCode,
                holdings.unrealisedSummary,
                undefined,
              )
            : undefined,
        )
        .catch(() => undefined);
      try {
        const snapshotRepo = createHistoricalSnapshotRepository(client);
        const userId = result.context.user.id;
        const portfolioId = configuredWorkspace.activePortfolio.id;
        let overview = await snapshotRepo.loadPublishedOverview(
          userId,
          portfolioId,
        );
        if (overview === null) {
          // CALC-004 trigger 2 (read-time self-heal), mirroring
          // `owned-holdings.ts`'s identical CALC-003 pattern for the
          // projection pipeline: this is the choke point every Overview
          // read passes through when the snapshot pipeline's calculation
          // runs were queued (by a ledger post or import commit) but never
          // advanced -- e.g. local dev with no cron, or trigger 1's
          // post-commit snapshot budget exhausting before this portfolio's
          // (typically much larger) history rebuild finished. Best-effort,
          // bounded, and re-read exactly once: if nothing is claimable (or
          // another reader already claimed it -- lease semantics prevent
          // stampedes) this falls through to the existing honest
          // unavailable overview state below, never a fabricated chart.
          await advanceCalculationRuns(
            { client, now: () => nowInstant },
            {
              userId,
              portfolioId,
              pipeline: "snapshot",
              budget: READ_TIME_SNAPSHOT_CALCULATION_BUDGET,
            },
          ).catch(() => undefined);
          overview = await snapshotRepo.loadPublishedOverview(
            userId,
            portfolioId,
          );
        }
        return {
          ...configuredWorkspace,
          overview: createOverviewData(overview),
          portfolioValueHistory,
          holdingsSummary,
        };
      } catch {
        return {
          ...configuredWorkspace,
          overview: createUnavailableOverviewData(
            configuredWorkspace.activePortfolio.baseCurrencyCode,
          ),
          portfolioValueHistory,
          holdingsSummary,
        };
      }
    }
    return configuredWorkspace;
  } catch (error) {
    // UI-023B follow-up: same rationale as getAuthenticatedSqlContext's
    // catch -- keep the user-facing message generic, but never swallow the
    // underlying error silently (a missing local migration column produced
    // an undiagnosable blanket outage here).
    console.error("loadAuthenticatedWorkspace failed", error);
    return unavailableWorkspace("Portfolio data is temporarily unavailable.");
  }
}
