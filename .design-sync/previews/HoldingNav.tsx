import { HoldingNav } from "yieldtome-ui";

/** Canonical: Details is the landing view; symbol title with the muted identity line beside it. */
export function DetailsActive() {
  return (
    <HoldingNav
      portfolioId="p1"
      portfolioSecurityId="s1"
      symbol="VAS"
      subtitle="Vanguard Australian Shares · ASX · AUD"
      active="details"
    />
  );
}

/** News sub-tab current for a bank holding. */
export function NewsActive() {
  return (
    <HoldingNav
      portfolioId="p1"
      portfolioSecurityId="s2"
      symbol="CBA"
      subtitle="Commonwealth Bank of Australia · ASX · AUD"
      active="news"
    />
  );
}

/** Transactions sub-tab current. */
export function TransactionsActive() {
  return (
    <HoldingNav
      portfolioId="p1"
      portfolioSecurityId="s3"
      symbol="WES"
      subtitle="Wesfarmers · ASX · AUD"
      active="transactions"
    />
  );
}

/** Dividends sub-tab current (UI-023C: the fourth tab that replaced the orphaned securities route). */
export function DividendsActive() {
  return (
    <HoldingNav
      portfolioId="p1"
      portfolioSecurityId="s4"
      symbol="VGS"
      subtitle="Vanguard MSCI Index International Shares · ASX · AUD"
      active="dividends"
    />
  );
}

/** Symbol only: no identity subtitle when the security name is not yet resolved. */
export function SymbolWithoutSubtitle() {
  return (
    <HoldingNav
      portfolioId="p1"
      portfolioSecurityId="s5"
      symbol="BHP"
      active="details"
    />
  );
}

/** Degraded: identity could not be loaded, so the heading falls back to a generic "Holding" eyebrow -- never a fabricated symbol. */
export function IdentityUnavailable() {
  return (
    <HoldingNav portfolioId="p1" portfolioSecurityId="s6" active="details" />
  );
}
