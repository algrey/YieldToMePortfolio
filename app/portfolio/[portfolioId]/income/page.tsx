import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../portfolio-actions";
import { loadOwnedIncomeProjection } from "../../../owned-income-projection";
import { IncomeLanding } from "../../../components/income-landing";
import { IncomeNav } from "../../../components/income-nav";

// UI-006A: owner-scoped, read-only Income landing (next 12 months). Every
// request under `/portfolio/*` already gets `cache-control: private,
// no-store` from `worker/response-security.ts`'s `isPrivateRequest`;
// `force-dynamic` additionally stops this page from being statically
// optimized, matching `app/import/page.tsx`'s established convention for
// an authenticated, per-owner page.
export const dynamic = "force-dynamic";

type IncomePageProps = {
  params: Promise<{ portfolioId: string }>;
};

// UI-022: even the degraded states render the Income chrome -- an owner
// who lands here must still have the back control out of the Income area
// (and the sibling sub-tabs), never a dead-end page.
function IncomeUnavailable({
  portfolioId,
  message,
}: {
  portfolioId: string;
  message: string;
}) {
  return (
    <main className="income-screen">
      <IncomeNav portfolioId={portfolioId} active="next12" />
      <section className="empty-state" aria-labelledby="income-unavailable">
        <h1 id="income-unavailable">Income is unavailable</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

export default async function IncomePage({ params }: IncomePageProps) {
  const { portfolioId } = await params;
  const workspace = await loadAuthenticatedWorkspace(portfolioId);

  if (workspace.status === "unavailable") {
    return (
      <IncomeUnavailable
        portfolioId={portfolioId}
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
      <IncomeUnavailable
        portfolioId={portfolioId}
        message="Portfolio data is temporarily unavailable."
      />
    );
  }

  let projection: Awaited<ReturnType<typeof loadOwnedIncomeProjection>>;
  try {
    // UI-016: the landing view previously read only `status`/`breakdown`/
    // `aggregateYield.method` (the next-12-months figures), so Follow-up 3
    // asked for the smallest valid range (0 years back). The owner reported
    // there was NO way to see past-FY dividend history from this tab at
    // all -- the landing view now also renders `pastFinancialYears` (a
    // compact recent-history table), so it needs real history. 5 years back
    // (not the multi-year sub-page's own 2-year default) covers the recent
    // range the owner actually cares about at a glance -- the owner's real
    // data spans roughly six FYs -- while the full range stays one click
    // away via the "See the full multi-year range" link.

    projection = await loadOwnedIncomeProjection(
      context.client,
      context.userId,
      portfolioId,
      new Date(),
      { yearsBack: 5, yearsForward: 1 },
    );
  } catch {
    return (
      <IncomeUnavailable
        portfolioId={portfolioId}
        message="The income projection could not be loaded."
      />
    );
  }

  return (
    <IncomeLanding
      projection={projection}
      portfolioId={portfolioId}
      multiYearHref={`/portfolio/${portfolioId}/income/multi-year`}
      assumptionsHref={`/portfolio/${portfolioId}/income/assumptions`}
      dividendsHref={`/portfolio/${portfolioId}/income/dividends`}
    />
  );
}
