// UI-022: the single source of truth for the Income area's chrome -- the
// back control that returns to the portfolio's primary tab strip, and the
// sub-tab bar shared by every Income view.
//
// Owner-reported (2026-08-21): the Income routes render their own `<main>`
// WITHOUT `PortfolioShell`, so once an owner opens Income there is no
// primary-tab strip and no way back to `overview/holdings/quotes/details`
// except the browser's own Back. The `.income-back` control below is that
// way back, and it is rendered by every Income view including the
// degraded/unavailable ones (being stranded matters most there).
//
// Second owner report: the four sub-tabs were hand-written separately in
// income-landing.tsx, income-multi-year.tsx and capital-gains-screen.tsx and
// had drifted -- "All dividends" existed only on the landing view, and the
// dividends list rendered no tab bar at all. Every view now renders THIS
// list, so the four sub-tabs cannot diverge again.
import Link from "next/link";

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
  active: IncomeView;
}) {
  return (
    <div className="income-nav">
      <div className="income-nav-heading">
        <Link
          className="income-back"
          href={incomeBackHref(portfolioId)}
          aria-label="Back to portfolio"
        >
          {/* Style guide -- Iconography: thin-line, geometric, consistent
              stroke weight, green on dark. Stroke colour/width come from
              `.income-back svg` in globals.css. */}
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14.5 5 7.5 12l7 7" />
          </svg>
        </Link>
        <p className="eyebrow">Income</p>
      </div>
      <nav className="income-view-tabs" aria-label="Income views">
        {INCOME_VIEWS.map((view) =>
          view.key === active ? (
            // The current view is a non-link `<span aria-current="page">`,
            // matching the pre-existing tab markup the CSS and the
            // CGT-001B/UI-006A tests already assert on. Note the dividends
            // list marks itself current for its filtered `?fy=`/
            // `?window=next12` variants too -- the filtered view is still
            // this section; its own "All years" link clears the filter.
            <span key={view.key} aria-current="page">
              {view.label}
            </span>
          ) : (
            <Link key={view.key} href={view.href(portfolioId)}>
              {view.label}
            </Link>
          ),
        )}
      </nav>
    </div>
  );
}
