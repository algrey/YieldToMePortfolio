import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";
import { getAuthenticatedSqlContext } from "../../../../portfolio-actions";
import { loadOwnedDividendList } from "../../../../owned-dividend-list";
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
}: DividendsPageProps) {
  const { portfolioId } = await params;
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

  return (
    <OwnedDividendList
      portfolioId={portfolioId}
      landingHref={`/portfolio/${portfolioId}/income`}
      today={list.today}
      rows={list.rows}
      truncated={list.truncated}
      totalCount={list.totalCount}
    />
  );
}
