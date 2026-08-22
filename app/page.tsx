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
  const workspace = await loadAuthenticatedWorkspace(undefined, {
    includeOverview: true,
  });
  // UI-024 review (BLOCKING fix): this loader only ever requests overview
  // data, so once an active portfolio exists, rendering a non-overview
  // section directly on this route would show a FALSE empty/unavailable
  // state on a populated portfolio. A bookmark or back-button history entry
  // to `/?section=...` (created by the tab bar's own no-portfolio
  // fallback) can reach this route again after a portfolio is created, so
  // redirect to the real portfolio-scoped route -- which does its own
  // loading/validation -- instead of rendering owned content here.
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
