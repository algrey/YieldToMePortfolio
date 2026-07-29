import type { OwnedPortfolioRecord } from "../db/repositories/owned-portfolios";
import type { resolveAuthenticatedRequestContext } from "../domain/auth/request-context";
import type { OwnedWorkspace } from "./components/portfolio-shell";

export function createOwnedWorkspace(
  result: Awaited<ReturnType<typeof resolveAuthenticatedRequestContext>>,
  portfolioRecords: OwnedPortfolioRecord[] = [],
): OwnedWorkspace {
  if (!result.ok) {
    return {
      status: "unavailable",
      message: "Your private workspace is unavailable.",
      activePortfolio: null,
      portfolios: [],
    };
  }

  const { user, activePortfolio } = result.context;
  const portfolios = portfolioRecords.map((portfolio) => ({
    id: portfolio.id,
    name: portfolio.name,
    homeCurrencyCode: portfolio.homeCurrencyCode,
    status: portfolio.status,
    version: portfolio.version,
  }));
  if (!activePortfolio) {
    return {
      status: "empty",
      userDisplayName: user.displayName ?? user.primaryEmail,
      homeCurrencyCode: null,
      activePortfolio: null,
      portfolios,
      holdingCurrencyView: "native",
      settingsVersion: 1,
    };
  }

  return {
    status: "ready",
    userDisplayName: user.displayName ?? user.primaryEmail,
    homeCurrencyCode: activePortfolio.homeCurrencyCode,
    activePortfolio: {
      id: activePortfolio.id,
      name: activePortfolio.name,
      homeCurrencyCode: activePortfolio.homeCurrencyCode,
      baseCurrencyCode: activePortfolio.baseCurrencyCode,
      timezone: activePortfolio.timezone,
      accountingMethod: activePortfolio.accountingMethod,
      status: activePortfolio.status,
      version: activePortfolio.version,
    },
    portfolios,
    holdingCurrencyView: "native",
    settingsVersion: 1,
  };
}
