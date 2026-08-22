import { notFound } from "next/navigation";
import { PortfolioShell } from "../../../components/portfolio-shell";
import {
  portfolioSections,
  type PortfolioSection,
} from "../../../portfolio-sections";
import { createPreviewPortfolioPrototypes } from "../../../preview-route-data";
import { loadPreviewValuationFixture } from "../../../preview-valuation";
import { loadAuthenticatedWorkspace } from "../../../authenticated-workspace";
import { loadAuthenticatedPortfolioInspection } from "../../../portfolio-inspection";

type PortfolioSectionPageProps = {
  params: Promise<{ portfolioId: string; section: string }>;
};

const previewValuationFixturePromise = loadPreviewValuationFixture();

export default async function PortfolioSectionPage({
  params,
}: PortfolioSectionPageProps) {
  const { portfolioId, section } = await params;

  if (!portfolioSections.includes(section as PortfolioSection)) {
    notFound();
  }

  if (portfolioId !== "preview") {
    const workspace = await loadAuthenticatedWorkspace(portfolioId, {
      includeQuotes: section === "quotes",
      includeOverview: section === "overview",
      includeHoldings: section === "holdings",
    });
    if (workspace.status === "unavailable") {
      return (
        <PortfolioShell
          activeSection={section as PortfolioSection}
          ownedWorkspace={workspace}
        />
      );
    }
    if (workspace.activePortfolio === null) notFound();
    const inspection =
      section === "details"
        ? await loadAuthenticatedPortfolioInspection(portfolioId)
        : null;
    return (
      <PortfolioShell
        activeSection={section as PortfolioSection}
        ownedWorkspace={workspace}
        ownedDetails={inspection}
      />
    );
  }

  const previewFixtureResult = await previewValuationFixturePromise;
  if (!previewFixtureResult.ok) {
    throw new Error(previewFixtureResult.message);
  }

  return (
    <PortfolioShell
      activeSection={section as PortfolioSection}
      portfolioPrototypesOverride={createPreviewPortfolioPrototypes(
        previewFixtureResult.fixture,
      )}
      overviewHref="/portfolio/preview/overview"
      reviewBadgeLabel="Fixture market data"
      reviewNote="Static review build · fixture market data · no financial writes"
    />
  );
}
