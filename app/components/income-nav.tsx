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

export type IncomeView =
  "next12" | "multi-year" | "gains" | "dividends" | "assumptions";

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
  {
    key: "assumptions",
    // UI-039 (owner directive 2026-08-24): the dividend assumptions editor
    // (UI-006B) existed only as an orphaned route the owner could not
    // discover -- surfaced here as a fifth sub-tab. UI-042 then gave the
    // page itself this same nav, so it is a full peer of the other four.
    label: "Assumptions",
    href: (id) => `/portfolio/${id}/income/assumptions`,
  },
];

/**
 * FALLBACK target for the back control, used only when no primary tab was
 * remembered (a direct/deep-linked arrival, or blocked storage) -- UI-048
 * makes the control itself return to the tab the owner entered from.
 * `holdings` per the owner's own instruction: "just go back to Holdings,
 * which is where I would usually call it from."
 */
export function incomeBackHref(portfolioId: string): string {
  return `/portfolio/${portfolioId}/holdings`;
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
      backLabel="Back"
      // UI-046/UI-048 (owner-reported, twice): Income is a PRIMARY tab, so
      // it is opened from whichever tab the owner happened to be on --
      // always returning to Overview was wrong for every arrival but one.
      // Plain history-back then walked back through each Income sub-tab
      // before leaving the area. `"exit"` leaves in ONE step, landing on the
      // primary tab the owner entered from; `backHref` is the fallback when
      // nothing was remembered.
      backMode="exit"
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
