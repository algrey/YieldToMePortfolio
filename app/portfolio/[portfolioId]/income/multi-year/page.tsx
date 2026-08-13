import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../../portfolio-actions";
import { loadOwnedIncomeProjection } from "../../../../owned-income-projection";
import { IncomeMultiYear } from "../../../../components/income-multi-year";
import {
  clampYears,
  DEFAULT_YEARS_BACK,
  DEFAULT_YEARS_FORWARD,
} from "../../../../income-year-range";

// UI-006A: owner-scoped, read-only Income multi-year FY view. See
// `../page.tsx` for the shared no-store/force-dynamic reasoning.
export const dynamic = "force-dynamic";

type IncomeMultiYearPageProps = {
  params: Promise<{ portfolioId: string }>;
  searchParams: Promise<{ yearsBack?: string; yearsForward?: string }>;
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

export default async function IncomeMultiYearPage({
  params,
  searchParams,
}: IncomeMultiYearPageProps) {
  const { portfolioId } = await params;
  const query = await searchParams;
  const yearsBack = clampYears(query.yearsBack, DEFAULT_YEARS_BACK, 0);
  const yearsForward = clampYears(query.yearsForward, DEFAULT_YEARS_FORWARD, 1);

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
    projection = await loadOwnedIncomeProjection(
      context.client,
      context.userId,
      portfolioId,
      new Date(),
      { yearsBack, yearsForward },
    );
  } catch {
    return (
      <IncomeUnavailable message="The income projection could not be loaded." />
    );
  }

  // Follow-up 1: pass DIV-003's typed results straight through rather than
  // silently collapsing a degraded `ok: false` into `[]`/`null` here --
  // `IncomeMultiYear` renders the same disclosed-banner pattern used for a
  // degraded forward `multiYear` for these too.
  return (
    <IncomeMultiYear
      landingHref={`/portfolio/${portfolioId}/income`}
      assumptionsHref={`/portfolio/${portfolioId}/income/assumptions`}
      baseCurrencyCode={projection.baseCurrencyCode}
      pastFinancialYears={projection.pastFinancialYears}
      currentFinancialYear={projection.currentFinancialYear}
      multiYear={projection.multiYear}
      multiYearBaselineInput={projection.multiYearBaselineInput}
      portfolioValueGrowthPercentDecimal={
        projection.portfolioValueGrowth.growthPercentDecimal
      }
      portfolioDividendGrowthPercentDecimal={
        projection.portfolioDividendGrowth.growthPercentDecimal
      }
      yearsBack={yearsBack}
      yearsForward={yearsForward}
    />
  );
}
