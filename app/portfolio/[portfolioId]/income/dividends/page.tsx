import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../../portfolio-actions";
import { loadOwnedDividendList } from "../../../../owned-dividend-list";
import {
  parseDividendListFilter,
  filterRowsForFyWindow,
  filterRowsForNext12,
} from "../../../../dividend-list-query";
import { OwnedDividendList } from "../../../../components/owned-dividend-list";

// UI-016: owner-scoped, read-only, portfolio-wide list of INDIVIDUAL
// dividends (owner clarification 2026-08-20: "I see the yearly aggregate
// amount. I don't see a list of dividends anywhere"). Mirrors
// `.../income/page.tsx`/`.../securities/[id]/dividends/page.tsx`'s
// established owner-scoped page pattern: `force-dynamic` since every
// request under `/portfolio/*` is already `cache-control: private,
// no-store` (`worker/response-security.ts`), matching the existing
// per-owner-page convention.
export const dynamic = "force-dynamic";

type DividendsPageProps = {
  params: Promise<{ portfolioId: string }>;
  // UI-017: `?fy=<endingYear>` filters to one financial year;
  // `?window=next12` filters to the known (never forecast) next-12-months
  // window. Server-parsed in `parseDividendListFilter` -- see that
  // module's header for the mutual-exclusivity/fallback rules.
  searchParams: Promise<{ fy?: string; window?: string }>;
};

function DividendsUnavailable({ message }: { message: string }) {
  return (
    <main className="income-screen">
      <section className="empty-state" aria-labelledby="dividends-unavailable">
        <p className="eyebrow">Income</p>
        <h1 id="dividends-unavailable">Dividend list is unavailable</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

export default async function DividendsListPage({
  params,
  searchParams,
}: DividendsPageProps) {
  const { portfolioId } = await params;
  const query = await searchParams;
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

  let list: Awaited<ReturnType<typeof loadOwnedDividendList>>;
  try {
    list = await loadOwnedDividendList(
      context.client,
      context.userId,
      portfolioId,
      new Date(),
    );
  } catch {
    return (
      <DividendsUnavailable message="The dividend list could not be loaded." />
    );
  }

  // UI-017: clamp bounds are a sanity check, not a business-date
  // derivation -- `list.today` is the FY-to-date window's own end date
  // (already resolved through the owner's timezone/FY-start-month), so its
  // calendar year is "today" in the same sense every other FY surface uses.
  const currentCalendarYear = Number(list.today.slice(0, 4));
  const filter = parseDividendListFilter(
    query,
    currentCalendarYear,
    list.financialYearStartMonth,
  );

  let rows = list.rows;
  let undatedRowCount = 0;
  if (filter.mode === "fy") {
    const filtered = filterRowsForFyWindow(list.rows, filter.window);
    rows = filtered.rows;
    undatedRowCount = filtered.undatedRowCount;
  } else if (filter.mode === "next12") {
    rows = filterRowsForNext12(list.rows, list.today);
  }

  return (
    <OwnedDividendList
      portfolioId={portfolioId}
      landingHref={`/portfolio/${portfolioId}/income`}
      allYearsHref={`/portfolio/${portfolioId}/income/dividends`}
      today={list.today}
      rows={rows}
      truncated={list.truncated}
      totalCount={list.totalCount}
      filter={filter}
      undatedRowCount={undatedRowCount}
    />
  );
}
