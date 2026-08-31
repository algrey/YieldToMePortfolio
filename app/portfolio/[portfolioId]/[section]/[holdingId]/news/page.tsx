import { notFound } from "next/navigation";
import {
  loadAuthenticatedWorkspace,
  type AuthenticatedWorkspaceSqlContext,
} from "../../../../../authenticated-workspace";
import { loadOwnedHoldingIdentity } from "../../../../../owned-holding-transactions";
import {
  HoldingAreaUnavailable,
  HoldingNav,
} from "../../../../../components/holding-nav";
import { holdingSubtitle } from "../../../../../holding-subtitle";

// UI-023B: the per-holding News tab embeds the owner's own news site
// (owner directive 2026-08-22, superseding UI-023's placeholder). The
// browser's cross-origin isolation keeps the framed site away from this
// app's DOM/session; the Worker CSP's `frame-src` allows exactly this one
// origin (worker/response-security.ts) and `referrerPolicy="no-referrer"`
// keeps portfolio URLs (which carry portfolio/security ids) out of the news
// site's logs. The content is attributed to its source beneath the frame.
export const dynamic = "force-dynamic";

// Exactly the owner-supplied embed URL. `?embed=1` is greeninvestments.au's
// own chrome-less embed mode.
const HOLDING_NEWS_EMBED_URL = "https://greeninvestments.au/?embed=1";

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

  // PRF-005 (Income area census follow-up: the same PRF-002 duplicate-
  // identity-resolution defect, never fixed on the holding sub-tab pages):
  // `sqlContextOut` recovers the client/userId `loadAuthenticatedWorkspace`
  // already resolved instead of paying for a second, duplicate
  // `getAuthenticatedSqlContext` identity resolution (which doubles
  // `touchWithAudit`'s write batch on every load of this page).
  const sqlContextOut: { current: AuthenticatedWorkspaceSqlContext } = {
    current: { ok: false },
  };
  const workspace = await loadAuthenticatedWorkspace(
    portfolioId,
    {},
    sqlContextOut,
  );
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

  const context = sqlContextOut.current;
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
      <section className="holding-news-embed" aria-label="News">
        <iframe
          className="holding-news-frame"
          src={HOLDING_NEWS_EMBED_URL}
          title="Green Investments news"
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        />
        <p className="holding-news-source">
          Source:{" "}
          <a
            href="https://greeninvestments.au/"
            target="_blank"
            rel="noreferrer noopener"
          >
            greeninvestments.au
          </a>{" "}
          — use this link if the embedded view does not load.
        </p>
      </section>
    </main>
  );
}
