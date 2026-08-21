// UI-023: the shared chrome for every full-screen sub-area that replaces
// the portfolio shell's primary tabs (the Income area since UI-022, and now
// the per-holding detail area): a thin-line back control top-left, a heading
// beside it, and a sub-tab bar underneath. One component so the two areas
// cannot drift apart the way the Income screens' hand-written tab rows did
// (UI-022's originating defect).
import Link from "next/link";

export type SubNavTab = {
  key: string;
  label: string;
  href: string;
};

export function SubNav({
  backHref,
  backLabel,
  heading,
  tabs,
  active,
  tabsLabel,
}: {
  backHref: string;
  /** Accessible name for the icon-only back control, e.g. "Back to holdings". */
  backLabel: string;
  heading: React.ReactNode;
  tabs: readonly SubNavTab[];
  active: string;
  /** aria-label for the tab <nav>, e.g. "Income views". */
  tabsLabel: string;
}) {
  return (
    <div className="subnav">
      <div className="subnav-heading">
        <Link className="subnav-back" href={backHref} aria-label={backLabel}>
          {/* Style guide -- Iconography: thin-line, geometric, consistent
              stroke weight, green on dark. Stroke colour/width come from
              `.subnav-back svg` in globals.css. */}
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14.5 5 7.5 12l7 7" />
          </svg>
        </Link>
        {heading}
      </div>
      <nav className="subnav-tabs" aria-label={tabsLabel}>
        {tabs.map((tab) =>
          tab.key === active ? (
            // The current view is a non-link `<span aria-current="page">`,
            // matching the pre-existing Income tab markup the CSS and the
            // CGT-001B/UI-006A tests assert on.
            <span key={tab.key} aria-current="page">
              {tab.label}
            </span>
          ) : (
            <Link key={tab.key} href={tab.href}>
              {tab.label}
            </Link>
          ),
        )}
      </nav>
    </div>
  );
}
