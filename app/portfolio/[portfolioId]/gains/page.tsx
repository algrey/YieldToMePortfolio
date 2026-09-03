import { notFound } from "next/navigation";
import {
  loadAuthenticatedWorkspace,
  type AuthenticatedWorkspaceSqlContext,
} from "../../../authenticated-workspace";
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
 *
 * Exported (PRF-011 correction round 2, review B1) solely so
 * `tests/cgt-001a.test.ts` can drive a real orphan-allocation DB fixture's
 * thrown error through this ACTUAL function (via a `tsx`-loader child
 * process, since this file transitively imports `next/headers` and so
 * cannot be imported by the plain Node test runner -- see
 * `tests/cgt-001b.test.ts`'s `renderComponent` for the same technique)
 * rather than re-implementing/duplicating its mapping in the test.
 */
export function reasonForError(
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
  // PRF-002 (owner-reported production CPU-limit failure across every
  // authenticated page): this page used to call `loadAuthenticatedWorkspace`
  // purely as an auth/ownership gate and then call
  // `getAuthenticatedSqlContext` a SECOND time (same `portfolioId`) to get the
  // `client`/`userId` for `loadOwnedCapitalGains` below -- re-running the
  // SAME identity resolution (including its `touchWithAudit` write) twice
  // per request. `sqlContextOut` recovers the resolution
  // `loadAuthenticatedWorkspace` already did. See
  // `AuthenticatedWorkspaceSqlContext`'s doc comment for the full record.
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
      <GainsUnavailable
        portfolioId={portfolioId}
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
