import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../../../portfolio-actions";
import { loadOwnedSecurityDividendDetail } from "../../../../../owned-security-dividends";
import { SecurityDividendsTab } from "../../../../../components/security-dividends-tab";

// UI-006C: the per-security Dividends tab. Owned holdings has no existing
// per-security detail PAGE to add a tab to -- `portfolio-shell.tsx`'s
// `holdingDetailHref` per-security route only exists on the read-only
// prototype/preview path (`/portfolio/preview/holdings/:symbol`); the owned
// path (`OwnedHoldingsScreen`) opens an in-place detail `<dialog>` sheet, not
// a page. Mirrors UI-006A/UI-006B's standalone-route pattern instead
// (`/portfolio/:id/income*`): a new owner-scoped, force-dynamic page, linked
// from the owned holdings detail sheet (`portfolio-shell.tsx`).
export const dynamic = "force-dynamic";

type SecurityDividendsPageProps = {
  params: Promise<{ portfolioId: string; portfolioSecurityId: string }>;
};

function DividendsUnavailable({ message }: { message: string }) {
  return (
    <main className="income-screen">
      <section
        className="empty-state"
        aria-labelledby="security-dividends-unavailable"
      >
        <p className="eyebrow">Dividends</p>
        <h1 id="security-dividends-unavailable">
          Dividend history is unavailable
        </h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

export default async function SecurityDividendsPage({
  params,
}: SecurityDividendsPageProps) {
  const { portfolioId, portfolioSecurityId } = await params;

  const workspace = await loadAuthenticatedWorkspace(portfolioId);
  if (workspace.status === "unavailable") {
    return (
      <DividendsUnavailable
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
      <DividendsUnavailable message="Portfolio data is temporarily unavailable." />
    );
  }

  let detail: Awaited<ReturnType<typeof loadOwnedSecurityDividendDetail>>;
  try {
    detail = await loadOwnedSecurityDividendDetail(
      context.client,
      context.userId,
      portfolioId,
      portfolioSecurityId,
      new Date(),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") notFound();
    return (
      <DividendsUnavailable message="This security's dividend history could not be loaded." />
    );
  }

  return (
    <SecurityDividendsTab
      portfolioId={portfolioId}
      portfolioSecurityId={detail.portfolioSecurityId}
      symbol={detail.symbol}
      currencyCode={detail.currencyCode}
      today={detail.today}
      rows={detail.rows}
      filteredArtifactCount={detail.filteredArtifactCount}
      lifetimeTotals={detail.lifetimeTotals}
      overridesByEventId={detail.overridesByEventId}
      manualRecordsById={detail.manualRecordsById}
      assumptions={detail.assumptions}
      portfolioAssumptions={detail.portfolioAssumptions}
      holdingsHref={`/portfolio/${portfolioId}/holdings`}
    />
  );
}
