import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../../portfolio-actions";
import { loadOwnedIncomeProjection } from "../../../../owned-income-projection";
import {
  loadOwnedIncomeScenarios,
  type IncomeScenarioRecord,
} from "../../../../owned-income-scenarios";
import { IncomeMultiYear } from "../../../../components/income-multi-year";
import { IncomeNav } from "../../../../components/income-nav";
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
      <IncomeNav portfolioId={portfolioId} active="multi-year" />
      <section className="empty-state" aria-labelledby="income-unavailable">
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
    projection = await loadOwnedIncomeProjection(
      context.client,
      context.userId,
      portfolioId,
      new Date(),
      { yearsBack, yearsForward },
    );
  } catch {
    return (
      <IncomeUnavailable
        portfolioId={portfolioId}
        message="The income projection could not be loaded."
      />
    );
  }

  // DIV-014: saved what-if scenarios load server-side alongside the rest of
  // this page's data -- a failure here degrades honestly to an empty list
  // plus an explicit "unavailable" disclosure (never silently claimed as
  // "no scenarios saved yet", which would misrepresent a fetch failure as a
  // real fact) rather than failing the WHOLE page the way a degraded
  // `projection` load does above; this list is a non-critical convenience
  // layered on top of the always-available what-if inputs.
  let scenarios: IncomeScenarioRecord[] = [];
  let scenariosUnavailable = false;
  try {
    scenarios = await loadOwnedIncomeScenarios(
      context.client,
      context.userId,
      portfolioId,
    );
  } catch {
    scenariosUnavailable = true;
  }

  // Follow-up 1: pass DIV-003's typed results straight through rather than
  // silently collapsing a degraded `ok: false` into `[]`/`null` here --
  // `IncomeMultiYear` renders the same disclosed-banner pattern used for a
  // degraded forward `multiYear` for these too.
  return (
    <IncomeMultiYear
      portfolioId={portfolioId}
      assumptionsHref={`/portfolio/${portfolioId}/income/assumptions`}
      dividendsHref={`/portfolio/${portfolioId}/income/dividends`}
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
      financialYearStartMonth={projection.financialYearStartMonth}
      yearsBack={yearsBack}
      yearsForward={yearsForward}
      initialScenarios={scenarios}
      scenariosUnavailable={scenariosUnavailable}
    />
  );
}
