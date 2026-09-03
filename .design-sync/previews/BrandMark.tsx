import { BrandMark } from "yieldtome-ui";

/** The four-bar mark on its own, as the app bar renders it. */
export function Mark() {
  return <BrandMark />;
}

/** Inside an empty state: the app's own `.empty-state` composition from PortfolioShell. */
export function InEmptyState() {
  return (
    <section className="empty-state" aria-labelledby="empty-title">
      <span className="empty-mark" aria-hidden="true">
        <BrandMark />
      </span>
      <p className="eyebrow">Empty state</p>
      <h2 id="empty-title">No holdings yet</h2>
      <p>Import a Sharesight export or add a manual ledger entry to begin.</p>
    </section>
  );
}

/** Non-decorative: carries the accessible name "YieldToMe" for screen readers. */
export function Accessible() {
  return <BrandMark decorative={false} />;
}
