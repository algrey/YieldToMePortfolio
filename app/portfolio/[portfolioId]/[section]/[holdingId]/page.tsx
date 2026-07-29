import { notFound } from "next/navigation";
import {
  PortfolioShell,
  type PortfolioSection,
} from "../../../../components/portfolio-shell";
import { createPreviewPortfolioPrototypes } from "../../../../preview-route-data";
import { loadPreviewValuationFixture } from "../../../../preview-valuation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";

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
    const workspace = await loadAuthenticatedWorkspace(portfolioId);
    if (workspace.status === "unavailable") {
      return (
        <PortfolioShell activeSection="holdings" ownedWorkspace={workspace} />
      );
    }
    notFound();
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
    <PortfolioShell
      activeSection={"holdings" as PortfolioSection}
      portfolioPrototypesOverride={portfolios}
      overviewHref="/portfolio/preview/overview"
      reviewBadgeLabel="Fixture market data"
      reviewNote="Static review build · fixture market data · no financial writes"
      holdingSymbol={symbol}
    />
  );
}
