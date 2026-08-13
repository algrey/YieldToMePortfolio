import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../portfolio-actions";
import { loadOwnedIncomeProjection } from "../../../owned-income-projection";
import { IncomeLanding } from "../../../components/income-landing";

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

function IncomeUnavailable({ message }: { message: string }) {
  return (
    <main className="income-screen">
      <section className="empty-state" aria-labelledby="income-unavailable">
        <p className="eyebrow">Income</p>
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
      <IncomeUnavailable message="Portfolio data is temporarily unavailable." />
    );
  }

  let projection: Awaited<ReturnType<typeof loadOwnedIncomeProjection>>;
  try {
    // Follow-up 3: the landing view only ever reads `status`, `breakdown`,
    // and `aggregateYield.method` (the next-12-months figures) -- never
    // `multiYear`/`pastFinancialYears`/`currentFinancialYear` -- so it asks
    // for the smallest valid range (0 years back, 1 year forward) instead of
    // the service's 10/10 default, which would otherwise run the historical
    // snapshot lookups and the full past-FY loop on every landing-page
    // request for data this page never renders.
    projection = await loadOwnedIncomeProjection(
      context.client,
      context.userId,
      portfolioId,
      new Date(),
      { yearsBack: 0, yearsForward: 1 },
    );
  } catch {
    return (
      <IncomeUnavailable message="The income projection could not be loaded." />
    );
  }

  return (
    <IncomeLanding
      projection={projection}
      portfolioId={portfolioId}
      multiYearHref={`/portfolio/${portfolioId}/income/multi-year`}
      assumptionsHref={`/portfolio/${portfolioId}/income/assumptions`}
    />
  );
}
