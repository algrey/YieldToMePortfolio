import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../../portfolio-actions";
import { loadOwnedDividendAssumptions } from "../../../../owned-dividend-assumptions";
import { createDividendFyOverrideRepository } from "../../../../../db/repositories/dividends.ts";
import { DividendAssumptionsEditor } from "../../../../components/dividend-assumptions-editor";

// UI-006B: the dividend assumptions editor -- the entry point UI-006A's
// Income landing/multi-year screens link to (coverage link, empty-state
// link, and a past-FY row's "Override this FY" link via `?overrideYear=`).
// Owner-scoped, no-store (see `../page.tsx`'s shared reasoning).
export const dynamic = "force-dynamic";

type AssumptionsPageProps = {
  params: Promise<{ portfolioId: string }>;
  searchParams: Promise<{ overrideYear?: string }>;
};

function AssumptionsUnavailable({ message }: { message: string }) {
  return (
    <main className="income-screen">
      <section
        className="empty-state"
        aria-labelledby="dividend-assumptions-unavailable"
      >
        <p className="eyebrow">Income</p>
        <h1 id="dividend-assumptions-unavailable">
          Dividend assumptions are unavailable
        </h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

export default async function DividendAssumptionsPage({
  params,
  searchParams,
}: AssumptionsPageProps) {
  const { portfolioId } = await params;
  const query = await searchParams;
  const overrideYear = query.overrideYear ? Number(query.overrideYear) : null;
  const initialOverrideYear =
    overrideYear !== null && Number.isInteger(overrideYear)
      ? overrideYear
      : null;

  const workspace = await loadAuthenticatedWorkspace(portfolioId);
  if (workspace.status === "unavailable") {
    return (
      <AssumptionsUnavailable
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
      <AssumptionsUnavailable message="Portfolio data is temporarily unavailable." />
    );
  }

  let assumptions: Awaited<ReturnType<typeof loadOwnedDividendAssumptions>>;
  try {
    assumptions = await loadOwnedDividendAssumptions(
      context.client,
      context.userId,
      portfolioId,
      new Date(),
    );
  } catch {
    return (
      <AssumptionsUnavailable message="The dividend assumptions could not be loaded." />
    );
  }

  const fyOverrideRecords = await createDividendFyOverrideRepository(
    context.client,
  ).list(context.userId, portfolioId);

  return (
    <DividendAssumptionsEditor
      portfolioId={portfolioId}
      baseCurrencyCode={workspace.activePortfolio.baseCurrencyCode}
      today={assumptions.today}
      securities={assumptions.securities}
      portfolio={assumptions.portfolio}
      fyOverrides={fyOverrideRecords.map((override) => ({
        financialYearEndingYear: override.financialYearEndingYear,
        grossedAmountDecimal: override.grossedAmountDecimal,
        frankingAmountDecimal: override.frankingAmountDecimal,
        version: override.version,
      }))}
      incomeHref={`/portfolio/${portfolioId}/income`}
      initialOverrideYear={initialOverrideYear}
    />
  );
}
