import { AreaExitBackControl } from "yieldtome-ui";

/** Canonical: inside the Income area's heading row beside its eyebrow; href upgrades to the remembered primary tab after hydration. */
export function InIncomeHeading() {
  return (
    <div className="subnav-heading">
      <AreaExitBackControl fallbackHref="/portfolio/p1/holdings" label="Back" />
      <p className="eyebrow">Income</p>
    </div>
  );
}

/** Beside a holding title and identity line. */
export function WithTitleAndSubtitle() {
  return (
    <div className="subnav-heading">
      <AreaExitBackControl fallbackHref="/portfolio/p1/holdings" label="Back to holdings" />
      <h1 className="subnav-title">WES</h1>
      <p className="subnav-subtitle">Wesfarmers · ASX · AUD</p>
    </div>
  );
}

/** Fallback to the workspace root for a deep-linked arrival with nothing remembered. */
export function WorkspaceRootFallback() {
  return (
    <div className="subnav-heading">
      <AreaExitBackControl fallbackHref="/" label="Back to portfolios" />
      <p className="eyebrow">Capital gains</p>
    </div>
  );
}

/** Bare control on its own, showing the 44px hit target around the 20px thin-line glyph. */
export function Bare() {
  return <AreaExitBackControl fallbackHref="/portfolio/p1/overview" label="Back" />;
}
