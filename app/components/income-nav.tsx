// UI-022: the single source of truth for the Income area's chrome -- the
// back control that returns to the portfolio's primary tab strip, and the
// sub-tab bar shared by every Income view.
//
// Owner-reported (2026-08-21): the Income routes render their own `<main>`
// WITHOUT `PortfolioShell`, so once an owner opens Income there is no
// primary-tab strip and no way back to `overview/holdings/quotes/details`
// except the browser's own Back. The back control below is that way back,
// and it is rendered by every Income view including the
// degraded/unavailable ones (being stranded matters most there).
//
// Second owner report: the four sub-tabs were hand-written separately in
// income-landing.tsx, income-multi-year.tsx and capital-gains-screen.tsx and
// had drifted -- "All dividends" existed only on the landing view, and the
// dividends list rendered no tab bar at all. Every view now renders THIS
// list, so the four sub-tabs cannot diverge again.
//
// UI-023 generalised the markup into `sub-nav.tsx`'s `SubNav` (shared with
// the per-holding detail area); the Income tab list itself stays here.
import { SubNav } from "./sub-nav";

export type IncomeView = "next12" | "multi-year" | "gains" | "dividends";

const INCOME_VIEWS: readonly {
  key: IncomeView;
  label: string;
  href: (portfolioId: string) => string;
}[] = [
  {
    key: "next12",
    label: "Next 12 months",
    href: (id) => `/portfolio/${id}/income`,
  },
  {
    key: "multi-year",
    label: "Multi-year",
    href: (id) => `/portfolio/${id}/income/multi-year`,
  },
  {
    key: "gains",
    label: "Capital gains",
    // Capital gains lives outside the `/income` subtree (its own top-level
    // `/portfolio/:id/gains` route) but is an Income sub-tab in the UI.
    href: (id) => `/portfolio/${id}/gains`,
  },
  {
    key: "dividends",
    label: "All dividends",
    href: (id) => `/portfolio/${id}/income/dividends`,
  },
];

/**
 * Where the back control returns to. `overview` is the portfolio shell's
 * default section (`app/page.tsx` and `PortfolioShell`'s own `activeSection`
 * default), so this lands the owner back on the primary tab strip rather
 * than on a section they may never have visited.
 */
export function incomeBackHref(portfolioId: string): string {
  return `/portfolio/${portfolioId}/overview`;
}

export function IncomeNav({
  portfolioId,
  active,
}: {
  portfolioId: string;
  // Note the dividends list marks itself current for its filtered `?fy=`/
  // `?window=next12` variants too -- the filtered view is still this
  // section; its own "All years" link clears the filter.
  active: IncomeView;
}) {
  return (
    <SubNav
      backHref={incomeBackHref(portfolioId)}
      backLabel="Back to portfolio"
      heading={<p className="eyebrow">Income</p>}
      tabs={INCOME_VIEWS.map((view) => ({
        key: view.key,
        label: view.label,
        href: view.href(portfolioId),
      }))}
      active={active}
      tabsLabel="Income views"
    />
  );
}
