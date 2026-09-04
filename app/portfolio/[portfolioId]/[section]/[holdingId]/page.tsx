import { notFound } from "next/navigation";
import { PreviewShell } from "../../../../components/preview-shell";
import { type PortfolioSection } from "../../../../portfolio-sections";
import { createPreviewPortfolioPrototypes } from "../../../../preview-route-data";
import { loadPreviewValuationFixture } from "../../../../preview-valuation";
import {
  loadAuthenticatedWorkspace,
  type AuthenticatedWorkspaceSqlContext,
} from "../../../../authenticated-workspace";
import { loadOwnedHoldingIdentity } from "../../../../owned-holding-transactions";
import { marketDataProviderEnabled } from "../../../../market-data-provider-status";
import { HoldingDetailScreen } from "../../../../components/holding-detail";
import { HoldingAreaUnavailable } from "../../../../components/holding-nav";
import { holdingSubtitle } from "../../../../holding-subtitle";

// UI-023: in owned mode this is the per-holding DETAILS view -- the landing
// tab of the standalone holding area (News / Details / Transactions) that
// replaced the holdings list's in-place <dialog> sheet. Owner-scoped and
// force-dynamic like every owned page (`worker/response-security.ts`
// already serves `/portfolio/*` as `private, no-store`).
export const dynamic = "force-dynamic";

const previewValuationFixturePromise = loadPreviewValuationFixture();

type HoldingDetailPageProps = {
  params: Promise<{
    portfolioId: string;
    section: string;
    holdingId: string;
  }>;
};

export default async function HoldingDetailPage({
  params,
}: HoldingDetailPageProps) {
  const { portfolioId, section, holdingId } = await params;
  if (section !== "holdings") {
    notFound();
  }

  if (portfolioId !== "preview") {
    // PRF-005 (Income area census follow-up: the same PRF-002 duplicate-
    // identity-resolution defect, never fixed on the holding sub-tab
    // pages): `sqlContextOut` recovers the client/userId
    // `loadAuthenticatedWorkspace` already resolved instead of paying for
    // a second, duplicate `getAuthenticatedSqlContext` identity
    // resolution (which doubles `touchWithAudit`'s write batch on every
    // load of this page).
    const sqlContextOut: { current: AuthenticatedWorkspaceSqlContext } = {
      current: { ok: false },
    };
    const workspace = await loadAuthenticatedWorkspace(
      portfolioId,
      { includeHoldings: true },
      sqlContextOut,
    );
    if (workspace.status === "unavailable") {
      return (
        <HoldingAreaUnavailable
          portfolioId={portfolioId}
          portfolioSecurityId={holdingId}
          active="details"
          message={
            workspace.message ?? "The owned portfolio could not be verified."
          }
        />
      );
    }
    if (workspace.activePortfolio === null) notFound();

    const context = sqlContextOut.current;
    if (!context.ok) {
      return (
        <HoldingAreaUnavailable
          portfolioId={portfolioId}
          portfolioSecurityId={holdingId}
          active="details"
          message="Portfolio data is temporarily unavailable."
        />
      );
    }

    const identity = await loadOwnedHoldingIdentity(
      context.client,
      context.userId,
      portfolioId,
      holdingId,
    );
    if (!identity) notFound();

    // The published valuation row for this holding, when one exists. A
    // missing row (e.g. a fully exited position) renders an honest
    // unavailable state inside the screen -- never zeros.
    const holding =
      (workspace.holdings ?? []).find((row) => row.id === holdingId) ?? null;

    // MKT-014: read-only, no side effects -- see
    // `app/market-data-provider-status.ts` for why this stays separate from
    // `requestMarketDataRefreshForContext` itself.
    const providerEnabled = await marketDataProviderEnabled();

    return (
      <HoldingDetailScreen
        portfolioId={portfolioId}
        holding={holding}
        symbol={identity.symbol}
        subtitle={holdingSubtitle(identity)}
        portfolioSecurityId={identity.portfolioSecurityId}
        homeCurrencyCode={
          workspace.homeCurrencyCode ??
          workspace.activePortfolio.baseCurrencyCode
        }
        initialView={workspace.holdingCurrencyView ?? "native"}
        marketDataProviderEnabled={providerEnabled}
      />
    );
  }

  const previewFixtureResult = await previewValuationFixturePromise;
  if (!previewFixtureResult.ok) {
    throw new Error(previewFixtureResult.message);
  }

  const symbol = decodeURIComponent(holdingId);
  const portfolios = createPreviewPortfolioPrototypes(
    previewFixtureResult.fixture,
  );
  const portfolio = portfolios.find((item) =>
    item.holdings.some((holding) => holding.symbol === symbol),
  );
  if (!portfolio) {
    notFound();
  }

  return (
    <PreviewShell
      activeSection={"holdings" as PortfolioSection}
      portfolioPrototypesOverride={portfolios}
      overviewHref="/portfolio/preview/overview"
      reviewBadgeLabel="Fixture market data"
      reviewNote="Static review build · fixture market data · no financial writes"
      holdingSymbol={symbol}
    />
  );
}
