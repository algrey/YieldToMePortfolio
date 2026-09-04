import { notFound } from "next/navigation";
import { PortfolioShell } from "../../../components/portfolio-shell";
import { PreviewShell } from "../../../components/preview-shell";
import {
  portfolioSections,
  type PortfolioSection,
} from "../../../portfolio-sections";
import { createPreviewPortfolioPrototypes } from "../../../preview-route-data";
import { loadPreviewValuationFixture } from "../../../preview-valuation";
// PRF-014 step 1: this is a Server Component, so importing the fixture's
// runtime `historyBars` here only serialises that one small array into the
// preview route's RSC flight -- it never pulls prototype-data's 447 lines
// into the "use client" portfolio-shell.tsx production bundle.
import { historyBars } from "../../../prototype-data";
import {
  loadAuthenticatedWorkspace,
  type AuthenticatedWorkspaceSqlContext,
} from "../../../authenticated-workspace";
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
    // PRF-002: `sqlContextOut` recovers the SAME `client`/`userId`
    // `loadAuthenticatedWorkspace` already resolved for the "details"
    // section below, instead of `loadAuthenticatedPortfolioInspection`
    // paying for a second, duplicate identity resolution. Every other
    // section ignores it. See TASKS.md's PRF-002 entry.
    const sqlContextOut: { current: AuthenticatedWorkspaceSqlContext } = {
      current: { ok: false },
    };
    const workspace = await loadAuthenticatedWorkspace(
      portfolioId,
      {
        includeQuotes: section === "quotes",
        includeOverview: section === "overview",
        includeHoldings: section === "holdings",
      },
      sqlContextOut,
    );
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
        ? await loadAuthenticatedPortfolioInspection(
            portfolioId,
            sqlContextOut.current,
          )
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
    <PreviewShell
      activeSection={section as PortfolioSection}
      portfolioPrototypesOverride={createPreviewPortfolioPrototypes(
        previewFixtureResult.fixture,
      )}
      historyBarsOverride={historyBars}
      overviewHref="/portfolio/preview/overview"
      reviewBadgeLabel="Fixture market data"
      reviewNote="Static review build · fixture market data · no financial writes"
    />
  );
}
