import { redirect } from "next/navigation";
import { PortfolioShell } from "./components/portfolio-shell";
import {
  ownedSectionRedirectPath,
  resolveSectionSearchParam,
} from "./portfolio-sections";
import { loadAuthenticatedWorkspace } from "./authenticated-workspace";

type HomePageProps = {
  searchParams: Promise<{ section?: string | string[] }>;
};

export default async function Home({ searchParams }: HomePageProps) {
  const { section } = await searchParams;
  // UI-024 (owner-reported): a fresh/no-portfolio workspace has no
  // portfolio id to build a `/portfolio/:id/:section` URL from, so the
  // primary tab bar (`app/components/portfolio-shell.tsx`) links every
  // non-overview tab back to `/?section=<section>` instead of a
  // portfolio-scoped route.
  const requestedSection = resolveSectionSearchParam(section);
  // WLT-001: the watchlist is the one non-overview section this route can
  // legitimately render OWNED content for in place (see
  // `ownedSectionRedirectPath` below -- every other non-overview section
  // with an active portfolio redirects away before rendering). Without
  // `includeQuotes` here, a no-portfolio owner with real watch entries would
  // see a FALSE "No watch entries yet" empty state -- the exact class of bug
  // UI-024's review caught for overview/holdings/quotes previously.
  // UI-051 (owner-directed): once at least one portfolio exists, `/` is no
  // longer its own landing surface -- every visit lands on the Holdings tab
  // of the owner's first portfolio, regardless of any `?section=` on this
  // request. `landingRedirect` is an output slot `loadAuthenticatedWorkspace`
  // fills the moment its own (mandatory, unavoidable) identity+portfolio
  // resolution below discovers an active portfolio -- see that slot's own
  // doc comment in `authenticated-workspace.ts` for why this MUST stay a
  // single call rather than a separate cheap pre-check.
  const landingRedirect: { current: string | null } = { current: null };
  const workspace = await loadAuthenticatedWorkspace(
    undefined,
    {
      includeOverview: true,
      includeQuotes: requestedSection === "quotes",
    },
    undefined,
    landingRedirect,
  );
  if (landingRedirect.current) {
    redirect(`/portfolio/${landingRedirect.current}/holdings`);
  }
  // UI-024 review (BLOCKING fix): this loader only ever requests overview
  // data, so once an active portfolio exists, rendering a non-overview
  // section directly on this route would show a FALSE empty/unavailable
  // state on a populated portfolio. A bookmark or back-button history entry
  // to `/?section=...` (created by the tab bar's own no-portfolio
  // fallback) can reach this route again after a portfolio is created, so
  // redirect to the real portfolio-scoped route -- which does its own
  // loading/validation -- instead of rendering owned content here.
  // UI-051 (superseded-at-route-level, reviewer follow-up): the
  // `landingRedirect` check above already redirects away from `/` whenever
  // an active portfolio exists, unconditionally, before this line is
  // reached -- so `workspace.activePortfolio?.id` is now always `null`
  // here in practice, and this call's non-null-id branch
  // (`ownedSectionRedirectPath`'s own doc comment in `portfolio-sections.ts`
  // has the full explanation) is unreachable. Left in place, unchanged: it
  // is still the correct, cheap guard for the null-portfolio path, and
  // removing it would be a speculative refactor outside this task's scope.
  const redirectPath = ownedSectionRedirectPath(
    workspace.activePortfolio?.id ?? null,
    requestedSection,
  );
  if (redirectPath) redirect(redirectPath);
  return (
    <PortfolioShell
      activeSection={requestedSection}
      ownedWorkspace={workspace}
    />
  );
}
