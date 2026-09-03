import { HoldingAreaUnavailable } from "yieldtome-ui";

/** Canonical: the holding could not be loaded; the area chrome (back control + tabs) still renders so the owner is never stranded. */
export function NotFound() {
  return (
    <HoldingAreaUnavailable
      portfolioId="p1"
      portfolioSecurityId="s9"
      active="details"
      message="This holding is not in the selected portfolio, or it has been removed. Return to Holdings to pick another."
    />
  );
}

/** Transactions view degraded: the ledger rows could not be read. */
export function TransactionsUnavailable() {
  return (
    <HoldingAreaUnavailable
      portfolioId="p1"
      portfolioSecurityId="s2"
      active="transactions"
      message="The transaction history for this holding could not be read. Nothing has been changed; try again shortly."
    />
  );
}

/** Dividends view degraded: no published calculation run yet. */
export function DividendsUnavailable() {
  return (
    <HoldingAreaUnavailable
      portfolioId="p1"
      portfolioSecurityId="s4"
      active="dividends"
      message="Dividend history is not available until the portfolio's calculation run has been published. Last attempt: 2026-09-03."
    />
  );
}

/** News view degraded. */
export function NewsUnavailable() {
  return (
    <HoldingAreaUnavailable
      portfolioId="p1"
      portfolioSecurityId="s1"
      active="news"
      message="News for this holding could not be loaded because the security's provider mapping is missing."
    />
  );
}
