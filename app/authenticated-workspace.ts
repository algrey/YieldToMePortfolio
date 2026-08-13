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
import { loadOwnedQuotes } from "./owned-quotes";
import { loadOwnedHoldings } from "./owned-holdings";
import { createHistoricalSnapshotRepository } from "../db/repositories/snapshots.ts";
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
          timezone: settings.timezone,
          settingsVersion: settings.version,
          nowInstant,
        }
      : { ...workspace, nowInstant };
    if (configuredWorkspace.activePortfolio === null)
      return configuredWorkspace;
    if (
      !options.includeQuotes &&
      !options.includeOverview &&
      !options.includeHoldings
    )
      return configuredWorkspace;
    if (options.includeHoldings) {
      try {
        const holdings = await loadOwnedHoldings(
          client,
          result.context.user.id,
          configuredWorkspace.activePortfolio.id,
        );
        return {
          ...configuredWorkspace,
          holdings: holdings.rows,
          holdingsViewState: holdings.status,
          cash: holdings.cash,
          holdingCoverage: holdings.coverage,
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
        const overview = await createHistoricalSnapshotRepository(
          client,
        ).loadPublishedOverview(
          result.context.user.id,
          configuredWorkspace.activePortfolio.id,
        );
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
    const quotes = await loadOwnedQuotes(
      client,
      result.context.user.id,
      configuredWorkspace.activePortfolio.id,
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
  } catch {
    return unavailableWorkspace("Portfolio data is temporarily unavailable.");
  }
}
