import { IncomeNav } from "yieldtome-ui";

/** Canonical: Income landing view (next 12 months) with the exit back control and all five sub-tabs. */
export function Next12Active() {
  return <IncomeNav portfolioId="p1" active="next12" />;
}

/** Multi-year projection view current. */
export function MultiYearActive() {
  return <IncomeNav portfolioId="p1" active="multi-year" />;
}

/** Capital gains: lives outside the /income subtree but is an Income sub-tab in the UI. */
export function GainsActive() {
  return <IncomeNav portfolioId="p1" active="gains" />;
}

/** All dividends list current (also used for the filtered ?fy= variants). */
export function DividendsActive() {
  return <IncomeNav portfolioId="p1" active="dividends" />;
}

/** Assumptions editor current (UI-039: surfaced as the fifth sub-tab). */
export function AssumptionsActive() {
  return <IncomeNav portfolioId="p1" active="assumptions" />;
}
