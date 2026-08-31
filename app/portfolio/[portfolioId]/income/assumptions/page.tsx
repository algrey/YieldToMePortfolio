import { notFound } from "next/navigation";
import {
  loadAuthenticatedWorkspace,
  type AuthenticatedWorkspaceSqlContext,
} from "../../../../authenticated-workspace";
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

  // PRF-002: see `../gains/page.tsx`'s identical comment / TASKS.md's
  // PRF-002 entry -- `sqlContextOut` recovers the client/userId
  // `loadAuthenticatedWorkspace` already resolved instead of paying for a
  // second, duplicate `getAuthenticatedSqlContext` identity resolution.
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
      <AssumptionsUnavailable
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
      <AssumptionsUnavailable message="Portfolio data is temporarily unavailable." />
    );
  }

  // PRF-005: `loadOwnedDividendAssumptions` and the FY-overrides list are
  // mutually independent reads -- started concurrently instead of two
  // sequential waterfalls. `fyOverrideRecordsPromise` must be observed on
  // EVERY path, including the `assumptions` failure path below which
  // returns early without ever awaiting it (the PRF-004 orphan-promise
  // class) -- this side observer prevents an unhandled rejection; the
  // ORIGINAL promise is still awaited (and any real rejection still
  // propagates uncaught, exactly as before this change) further down.
  const fyOverrideRecordsPromise = createDividendFyOverrideRepository(
    context.client,
  ).list(context.userId, portfolioId);
  fyOverrideRecordsPromise.catch(() => {});

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

  const fyOverrideRecords = await fyOverrideRecordsPromise;

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
      initialOverrideYear={initialOverrideYear}
    />
  );
}
