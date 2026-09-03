import { SubNav } from "yieldtome-ui";

const holdingTabs = [
  { key: "news", label: "News", href: "/portfolio/p1/holdings/s1/news" },
  { key: "details", label: "Details", href: "/portfolio/p1/holdings/s1" },
  { key: "transactions", label: "Transactions", href: "/portfolio/p1/holdings/s1/transactions" },
  { key: "dividends", label: "Dividends", href: "/portfolio/p1/holdings/s1/dividends" },
];

const incomeTabs = [
  { key: "next12", label: "Next 12 months", href: "/portfolio/p1/income" },
  { key: "multi-year", label: "Multi-year", href: "/portfolio/p1/income/multi-year" },
  { key: "gains", label: "Capital gains", href: "/portfolio/p1/gains" },
  { key: "dividends", label: "All dividends", href: "/portfolio/p1/income/dividends" },
  { key: "assumptions", label: "Assumptions", href: "/portfolio/p1/income/assumptions" },
];

/** Holding area: static back link, symbol title with a muted identity line. */
export function HoldingArea() {
  return (
    <SubNav
      backHref="/portfolio/p1/holdings"
      backLabel="Back to holdings"
      heading={
        <>
          <h1 className="subnav-title">VAS</h1>
          <p className="subnav-subtitle">Vanguard Australian Shares · ASX · AUD</p>
        </>
      }
      tabs={holdingTabs}
      active="details"
      tabsLabel="Holding views"
    />
  );
}

/** Income area: eyebrow heading, `exit` back mode returning to the remembered primary tab. */
export function IncomeArea() {
  return (
    <SubNav
      backHref="/portfolio/p1/holdings"
      backLabel="Back"
      backMode="exit"
      heading={<p className="eyebrow">Income</p>}
      tabs={incomeTabs}
      active="multi-year"
      tabsLabel="Income views"
    />
  );
}

/** History back mode, for an area reachable from many places. */
export function HistoryBack() {
  return (
    <SubNav
      backHref="/portfolio/p1/details"
      backLabel="Back"
      backMode="history"
      heading={<p className="eyebrow">Manual entry</p>}
      tabs={incomeTabs.slice(0, 3)}
      active="gains"
      tabsLabel="Views"
    />
  );
}
