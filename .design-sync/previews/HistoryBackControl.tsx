import { HistoryBackControl } from "yieldtome-ui";

/** Canonical: inside a SubNav heading row beside an eyebrow, as the manual ledger entry page renders it. */
export function InHeadingRow() {
  return (
    <div className="subnav-heading">
      <HistoryBackControl fallbackHref="/portfolio/p1/details" label="Back" />
      <p className="eyebrow">Manual entry</p>
    </div>
  );
}

/** Beside a full title and subtitle, the way the holding area's heading composes. */
export function WithTitleAndSubtitle() {
  return (
    <div className="subnav-heading">
      <HistoryBackControl fallbackHref="/portfolio/p1/holdings" label="Back to holdings" />
      <h1 className="subnav-title">CBA</h1>
      <p className="subnav-subtitle">Commonwealth Bank of Australia · ASX · AUD</p>
    </div>
  );
}

/** Descriptive accessible name for a specific fallback target. */
export function DescriptiveLabel() {
  return (
    <div className="subnav-heading">
      <HistoryBackControl
        fallbackHref="/portfolio/p1/holdings"
        label="Back to holdings"
      />
      <p className="eyebrow">Import preview</p>
    </div>
  );
}

/** Bare control on its own, showing the 44px hit target around the 20px thin-line glyph. */
export function Bare() {
  return <HistoryBackControl fallbackHref="/portfolio/p1/overview" label="Back" />;
}
