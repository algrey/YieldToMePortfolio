import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../../../portfolio-actions";
import { loadOwnedHoldingIdentity } from "../../../../../owned-holding-transactions";
import {
  HoldingAreaUnavailable,
  HoldingNav,
} from "../../../../../components/holding-nav";
import { holdingSubtitle } from "../../../../../holding-subtitle";

// UI-023: the per-holding News tab. A declared placeholder (owner decision
// 2026-08-21: "News should be a placeholder for now") -- like the
// portfolio-level News tab it reserves the navigation pattern without
// inventing a provider or showing unattributed market content.
export const dynamic = "force-dynamic";

type HoldingNewsPageProps = {
  params: Promise<{
    portfolioId: string;
    section: string;
    holdingId: string;
  }>;
};

export default async function HoldingNewsPage({
  params,
}: HoldingNewsPageProps) {
  const { portfolioId, section, holdingId } = await params;
  if (section !== "holdings" || portfolioId === "preview") {
    notFound();
  }

  const workspace = await loadAuthenticatedWorkspace(portfolioId);
  if (workspace.status === "unavailable") {
    return (
      <HoldingAreaUnavailable
        portfolioId={portfolioId}
        portfolioSecurityId={holdingId}
        active="news"
        message={
          workspace.message ?? "The owned portfolio could not be verified."
        }
      />
    );
  }
  if (workspace.activePortfolio === null) notFound();

  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) {
    return (
      <HoldingAreaUnavailable
        portfolioId={portfolioId}
        portfolioSecurityId={holdingId}
        active="news"
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

  return (
    <main className="income-screen holding-screen">
      <HoldingNav
        portfolioId={portfolioId}
        portfolioSecurityId={identity.portfolioSecurityId}
        symbol={identity.symbol}
        subtitle={holdingSubtitle(identity)}
        active="news"
      />
      <section
        className="news-placeholder"
        aria-labelledby="holding-news-title"
      >
        <p className="eyebrow">Route reserved</p>
        <h2 id="holding-news-title">
          News for {identity.symbol} is not connected
        </h2>
        <p>
          This tab reserves the navigation pattern without inventing a news
          provider or showing unattributed market content.
        </p>
        <div className="news-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    </main>
  );
}
