import { notFound } from "next/navigation";
import {
  PortfolioShell,
  type PortfolioSection,
} from "../../../components/portfolio-shell";
import { createPreviewPortfolioPrototypes } from "../../../preview-route-data";
import { loadPreviewValuationFixture } from "../../../preview-valuation";

const portfolioSections = [
  "overview",
  "holdings",
  "quotes",
  "details",
  "news",
] as const;

type PortfolioSectionPageProps = {
  params: Promise<{ portfolioId: string; section: string }>;
};

const previewValuationFixturePromise = loadPreviewValuationFixture();

export default async function PortfolioSectionPage({
  params,
}: PortfolioSectionPageProps) {
  const { portfolioId, section } = await params;

  if (portfolioId !== "preview") {
    notFound();
  }

  if (!portfolioSections.includes(section as PortfolioSection)) {
    notFound();
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
