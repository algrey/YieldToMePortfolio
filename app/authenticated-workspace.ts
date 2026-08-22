import { headers } from "next/headers";
import {
  decodeAccessJwtBase64Url,
  type VerifiedAccessPrincipal,
} from "../domain/auth/access-jwt";
import { resolveAuthenticatedRequestContext } from "../domain/auth/request-context";
import { VERIFIED_PRINCIPAL_HEADER } from "../domain/auth/verified-principal-header";
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
  const principalHeader = (await headers()).get(VERIFIED_PRINCIPAL_HEADER);
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
    const nowInstant = new Date().toISOString();
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
        }
      : { ...workspace, nowInstant };
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
        };
      } catch {
        return {
          ...configuredWorkspace,
          overview: createUnavailableOverviewData(
            configuredWorkspace.activePortfolio.baseCurrencyCode,
          ),
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
