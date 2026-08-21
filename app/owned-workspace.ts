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
      message:
        result.reason === "lifecycle"
          ? result.lifecycle === "deletion_pending"
            ? "Deletion is pending. Use the lifecycle support path to resume the existing export; portfolio details remain unavailable."
            : result.lifecycle === "purged"
              ? "Account has been verifiably purged. Financial ledger facts and portfolio details are permanently deleted."
              : "Account access is disabled. Use the lifecycle support path to resume an existing export; portfolio details remain unavailable."
          : "Your private workspace is unavailable.",
      lifecycle: result.reason === "lifecycle" ? result.lifecycle : undefined,
      activePortfolio: null,
      portfolios: [],
      quotes: [],
      quoteViewState: "empty",
      holdings: [],
      holdingsViewState: "empty",
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
      financialYearStartMonth: 7,
      priceSourcePreference: "sharesight_delayed",
      settingsVersion: 1,
      quotes: [],
      quoteViewState: "empty",
      holdings: [],
      holdingsViewState: "empty",
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
    financialYearStartMonth: 7,
    priceSourcePreference: "sharesight_delayed",
    settingsVersion: 1,
    quotes: [],
    quoteViewState: "empty",
    holdings: [],
    holdingsViewState: "empty",
  };
}
