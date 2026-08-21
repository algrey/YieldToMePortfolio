import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../portfolio-actions";
import { loadOwnedCapitalGains } from "../../../owned-capital-gains";
import {
  CapitalGainsScreen,
  type CapitalGainsScreenResult,
} from "../../../components/capital-gains-screen";
import { IncomeNav } from "../../../components/income-nav";

// CGT-001B: owner-scoped, read-only Capital gains screen -- the Income
// area's third tab. Every request under `/portfolio/*` already gets
// `cache-control: private, no-store` from `worker/response-security.ts`'s
// `isPrivateRequest`; `force-dynamic` matches every other owned page under
// this tree (`../income/page.tsx`, `../income/multi-year/page.tsx`).
export const dynamic = "force-dynamic";

type GainsPageProps = {
  params: Promise<{ portfolioId: string }>;
};

// UI-022: even the degraded states render the Income chrome -- an owner
// who lands here must still have the back control out of the Income area
// (and the sibling sub-tabs), never a dead-end page.
function GainsUnavailable({
  portfolioId,
  message,
}: {
  portfolioId: string;
  message: string;
}) {
  return (
    <main className="income-screen">
      <IncomeNav portfolioId={portfolioId} active="gains" />
      <section
        className="empty-state"
        aria-labelledby="gains-workspace-unavailable"
      >
        <h1 id="gains-workspace-unavailable">Capital gains are unavailable</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

/**
 * `app/owned-capital-gains.ts`'s `loadOwnedCapitalGains` throws typed
 * `Error` messages for every degraded state (see that file's header) --
 * this maps the ones the screen gives distinct copy for (CGT-001B's
 * acceptance: "unpublished projections", "missing dates" must each read
 * honestly, never a generic catch-all pretending to be specific). Every
 * other typed failure (invalid FY window, invalid decimal boundary,
 * unexpected too-many-allocations bound, etc.) falls back to the generic
 * "error" reason -- still typed, still never a fabricated $0 result.
 */
function reasonForError(
  message: string,
): CapitalGainsScreenResult & { status: "unavailable" } {
  if (
    message === "missing_projection_publication" ||
    message === "invalid_projection_publication" ||
    message === "invalid_projection_publication_count"
  ) {
    return { status: "unavailable", reason: "unpublished" };
  }
  if (
    message === "missing_allocation_dates" ||
    message.startsWith("invalid_allocation_dates:")
  ) {
    return { status: "unavailable", reason: "missing_dates" };
  }
  return { status: "unavailable", reason: "error" };
}

export default async function GainsPage({ params }: GainsPageProps) {
  const { portfolioId } = await params;
  const workspace = await loadAuthenticatedWorkspace(portfolioId);

  if (workspace.status === "unavailable") {
    return (
      <GainsUnavailable
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
      <GainsUnavailable
        portfolioId={portfolioId}
        message="Portfolio data is temporarily unavailable."
      />
    );
  }

  let result: CapitalGainsScreenResult;
  try {
    const history = await loadOwnedCapitalGains(
      context.client,
      context.userId,
      portfolioId,
      new Date(),
    );
    result = { status: "ok", history };
  } catch (error) {
    result = reasonForError(error instanceof Error ? error.message : "");
  }

  return (
    <CapitalGainsScreen
      portfolioId={portfolioId}
      holdingsHref={`/portfolio/${portfolioId}/holdings`}
      result={result}
    />
  );
}
