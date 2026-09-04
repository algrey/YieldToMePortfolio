// PRF-014 step 2a: pure DTO types and pure helper functions extracted
// verbatim from `portfolio-shell.tsx` (which is "use client"). None of the
// code below renders JSX or calls a React hook, so it never needed to
// cross the client boundary in the first place -- keeping it in a plain
// module lets a future server component import these types/helpers
// directly without pulling in the shell's client runtime, and keeps this
// file eligible to be imported from non-client modules later (see
// PRF-014 step 2 scoping in TASKS.md). `portfolio-shell.tsx` imports back
// everything it still uses from here and re-exports the DTO types that
// were already exported (`OwnedWorkspace`, `OwnedOverviewData`,
// `OwnedPortfolioValueHistoryPoint`, `OwnedPortfolioValueHistory`,
// `OwnedOverviewPoint`) so existing external importers of
// `./portfolio-shell` need no changes.
import type { PortfolioPrototype, Tone } from "../prototype-data";
import type { WatchlistRow } from "../watchlist-contract";
import type {
  OwnedCashSummary,
  OwnedHoldingRow,
  ProjectionPendingState,
} from "../owned-holdings-contract";
import type { SecurityRealisedGainTotal } from "../../domain/gains/index.ts";
import type { HoldingsSummaryFooter } from "../owned-holdings-summary.ts";
import { groupThousands } from "../../domain/calculations/index.ts";
import { type PortfolioSection } from "../portfolio-sections";

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// Financial-year start month options for the settings control (FY-001B).
// Full names label the select; abbreviations compose the helper text's
// window description. This is display-only -- the authoritative FY window
// math lives in domain/calculations/financial-year.ts.
export const FY_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
export const FY_MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
// Non-leap day counts, used only to describe the window's closing date in
// the helper text (e.g. "30 Jun"); the real window math handles leap years
// via domain/calculations/financial-year.ts.
const FY_MONTH_DAY_COUNTS = [
  31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
] as const;

/** "July: FY runs 1 Jul – 30 Jun" for a given 1-12 start month. */
export function financialYearWindowHelperText(startMonth: number): string {
  const startIndex = startMonth - 1;
  const endIndex = (startIndex + 11) % 12;
  return `${FY_MONTH_NAMES[startIndex]}: FY runs 1 ${FY_MONTH_ABBREVIATIONS[startIndex]} – ${FY_MONTH_DAY_COUNTS[endIndex]} ${FY_MONTH_ABBREVIATIONS[endIndex]}`;
}

export type OwnedWorkspace = {
  status: "ready" | "empty" | "unavailable";
  userDisplayName?: string | null;
  homeCurrencyCode?: string | null;
  holdingCurrencyView?: "native" | "home";
  financialYearStartMonth?: number;
  // MKT-009B: which quote source owner-facing read paths PREFER --
  // `undefined` (prototype/empty states) falls back to the same
  // `sharesight_delayed` default the settings column carries.
  priceSourcePreference?:
    "yahoo_authenticated" | "yahoo_anonymous" | "sharesight_delayed";
  // MKT-011A: which source the daily intraday-capture sweep fetches from for
  // this owner -- a WRITE-path choice, distinct from `priceSourcePreference`
  // above (a READ-path preference among already-written observations).
  // `undefined` (prototype/empty states) falls back to the same
  // `sharesight` default the settings column carries.
  dailyCaptureSource?: "sharesight" | "yahoo_anonymous" | "yahoo_authenticated";
  // MKT-011A: intraday-capture sweep cadence in minutes (30 or 60).
  // `undefined` falls back to the same `60` default the settings column
  // carries.
  dailyCaptureIntervalMinutes?: 30 | 60;
  // The user's settings-level IANA timezone (user_settings.timezone). FY
  // window math (FY-001C) must key off this, not `activePortfolio.timezone`
  // -- see AGENTS.md and domain/calculations/financial-year.ts.
  timezone?: string;
  // The server's "now" at the moment this workspace was assembled
  // (`loadAuthenticatedWorkspace`), as a full ISO-8601 instant. FY window
  // math anchors on this, never on a history point's date (stale data must
  // not rename the FY) and never recomputed client-side (see
  // docs/CALCULATIONS.md §9).
  nowInstant?: string;
  // UI-050: the app-bar USD/AUD pill (`app/authenticated-fx-rate.ts`) --
  // already formatted to 2 decimal places, or `null` when no usable
  // observation exists (never a fabricated/zero rate).
  usdAudRate?: string | null;
  settingsVersion?: number;
  message?: string;
  lifecycle?: "disabled" | "deletion_pending" | "purged";
  activePortfolio: {
    id: string;
    name: string;
    homeCurrencyCode: string;
    baseCurrencyCode: string;
    timezone: string;
    accountingMethod: string;
    status: string;
    version: number;
  } | null;
  portfolios: Array<{
    id: string;
    name: string;
    homeCurrencyCode: string;
    status: string;
    version: number;
  }>;
  // WLT-001: the owner's watchlist (USER-scoped -- populated whenever a real
  // userId is known, regardless of `activePortfolio`; see
  // `app/authenticated-workspace.ts`). Deliberately `WatchlistRow[]`, not the
  // portfolio-scoped `QuoteRow[]` the preview-mode `QuotesScreen` still uses.
  quotes?: WatchlistRow[];
  quoteViewState?: ViewState;
  overview?: OwnedOverviewData;
  // HIST-001: portfolio value over time, derived READ-TIME from
  // `price_observations`/ledger facts (`app/historical-portfolio-value.ts`)
  // -- deliberately independent of `overview` above (which stays sourced
  // from the CALC-003/CALC-004 persisted snapshot pipeline). See
  // `docs/ARCHITECTURE.md`'s HIST-001 entry for why these are two separate
  // reads rather than one.
  portfolioValueHistory?: OwnedPortfolioValueHistory;
  holdings?: OwnedHoldingRow[];
  cash?: OwnedCashSummary;
  // UI-032: the securities-coverage-counts field the retired "Cash
  // separate" panel displayed was removed from this workspace type --
  // `loadOwnedHoldings`'s own coverage computation is NOT dead (see
  // `app/owned-income-projection.ts`'s `portfolioValueCoverage`, a
  // different, still-live consumer), only this one passthrough field on
  // the workspace/prop chain that fed the deleted JSX went.
  holdingsViewState?: "complete" | "partial" | "empty" | "unavailable";
  // UI-030: CGT-001A's per-security LIFETIME realised-gain rollup, keyed by
  // `portfolioSecurityId` (matches `OwnedHoldingRow.id`) -- a plain object
  // (not a `Map`) because this workspace crosses the server/client RSC
  // boundary as a prop into `portfolio-shell.tsx`, the "use client" module
  // that actually consumes this type (this module itself is plain, not
  // "use client" -- see the file header above). `undefined` (as a
  // whole, or a missing key) means "never sold OR the enrichment failed to
  // load this request" -- `ownedHoldingRealisedGainLine` treats both the
  // same way (no fourth line), never a fabricated figure. See
  // `app/authenticated-workspace.ts` for the best-effort load.
  realisedGains?: Record<string, SecurityRealisedGainTotal>;
  // UI-031: the holdings list's four-line summary row, pre-composed
  // server-side (`app/owned-holdings-summary.ts`'s
  // `buildHoldingsSummaryFooter`) from `holdings` and `realisedGains` above
  // -- `undefined` only when there are no held securities at all (nothing
  // to summarise, mirroring the holdings screen's own empty state).
  holdingsSummary?: HoldingsSummaryFooter;
  // BUG-017: read-time signal that `holdings`/`holdingsSummary`/
  // `cash`/`realisedGains` above (and, on the Overview tab,
  // `holdingsSummary`'s headline figures) may not yet reflect the
  // ledger's latest state -- see `ProjectionPendingState`'s own doc
  // comment (`app/owned-holdings-contract.ts`). `undefined` only when
  // neither `includeHoldings` nor `includeOverview` was requested (the
  // section that would need it was never loaded) or the read failed
  // outright; both cases render no disclosure, matching every other
  // best-effort field on this type.
  holdingsProjectionPending?: ProjectionPendingState;
};
export type OwnedOverviewData = {
  status:
    "complete" | "partial" | "stale" | "incomplete" | "empty" | "unavailable";
  currencyCode: string;
  current: OwnedOverviewPoint | null;
  history: readonly OwnedOverviewPoint[];
  coverage: {
    pricedHoldingCount: number | null;
    nonZeroHoldingCount: number | null;
    convertedCashAccountCount: number | null;
    nonZeroCashAccountCount: number | null;
    totalHoldingCount: number | null;
    excluded: readonly { id: string; reason: string }[];
    issues: readonly { id: string; reason: string }[];
    marketDataStates: readonly {
      id: string;
      price: string;
      fx: string;
      calendar: string;
    }[];
  };
  allocation: {
    status: "complete" | "partial" | "unavailable";
    rows: readonly {
      id: string;
      label: string;
      value: string | null;
      percent: string | null;
    }[];
  };
};
// HIST-001: one read-time-derived point (never persisted) -- see
// `domain/snapshots/historical-portfolio-value.ts`'s header for the
// valuation rule. `valueDecimal: null` is a genuine gap (no priceable
// holding on this exact date), rendered as a chart gap, never interpolated.
// BUG-002 owner ruling: this series is SECURITIES-ONLY (cash is
// deliberately excluded -- see the domain module's header for the full
// record); it therefore does not necessarily reconcile to the CURRENT
// headline value shown elsewhere on Overview (which still sums cash).
export type OwnedPortfolioValueHistoryPoint = {
  date: string;
  valueDecimal: string | null;
  completeness: "complete" | "partial";
  /** Held-vs-priced counts (review B2b: the caption/table must name the
   * count of unpriced HELD securities, never just say "partial"). */
  heldSecurityCount: number;
  pricedSecurityCount: number;
};
export type OwnedPortfolioValueHistory = {
  status: "ok" | "empty" | "unavailable";
  baseCurrencyCode: string;
  points: readonly OwnedPortfolioValueHistoryPoint[];
  /** `true` when more distinct observation dates existed than the loader's
   * bound could hold -- the OLDEST dates were dropped, most-recent-first. */
  datesTruncated: boolean;
  /** HIST-002 review B3: `true` when this portfolio's stored value-history
   * cache is still catching up (this read's bounded backfill hit its
   * per-read cap) -- some of the NEWEST candidate dates within range are
   * honestly absent from `points` this time, and will appear on a later
   * read (see `app/historical-portfolio-value.ts`'s
   * `HistoricalPortfolioValueResult.backfillPending`). Disclosed on the
   * chart's coverage line rather than silently rendering a mid-catch-up
   * series as if it were complete. */
  backfillPending: boolean;
};
export type OwnedOverviewPoint = {
  date: string;
  value: string | null;
  securities: string | null;
  cash: string | null;
  cost: string | null;
  unrealised: string | null;
  realised: string | null;
  daily: string | null;
  valueDecimal: string | null;
  completeness: "complete" | "partial" | "incomplete";
  barHeight: string;
};
export const primaryPortfolioSections: PortfolioSection[] = [
  "overview",
  "news",
  "quotes",
  "holdings",
  "details",
];
export type ViewState = "populated" | "empty" | "partial" | "provider-error";
export type HoldingSort = "ticker" | "value" | "daily" | "total";
export type QuoteSort = "ticker" | "price" | "change";
export type Direction = "ascending" | "descending";
export type OpenMenu = "portfolio" | "add" | "prototype" | null;

export type OverviewRow = Readonly<{
  id: string;
  name: string;
  holdings: string;
  value: string;
  cost: string;
  daily: string;
  dailyPercent: string;
  total: string;
  totalPercent: string;
  tone: Tone;
}>;

export const prototypeStateLabels: Record<ViewState, string> = {
  populated: "Populated portfolio",
  empty: "Empty portfolio",
  partial: "Partial pricing",
  "provider-error": "Provider unavailable",
};

export function sectionHref(section: PortfolioSection, overviewHref: string) {
  return section === "overview"
    ? overviewHref
    : `/portfolio/preview/${section}`;
}

// UI-024 (owner-reported): before this existed, EVERY owned-mode tab (not
// just the button-styled ones -- these are plain `<Link>`s, never
// `disabled`) hard-coded `href="/"` whenever there was no active portfolio
// to build a `/portfolio/:id/:section` URL from. Every tab therefore linked
// to the SAME URL as the current page, so clicking a tab other than
// Overview was a same-URL no-op navigation -- indistinguishable from a dead
// click, even though nothing was actually disabled. `/` still has no
// portfolio id to route through, so this keeps the section choice in a
// query param `page.tsx` reads back into `activeSection`, giving every tab
// (News included) a distinct, real navigation target.
export function ownedNoPortfolioHref(section: PortfolioSection) {
  return section === "overview" ? "/" : `/?section=${section}`;
}

function compareBigIntStrings(left: string, right: string) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

export function compactAmount(value: string) {
  return value.replace("A$", "");
}

export function overviewRowFromPortfolio(
  portfolio: PortfolioPrototype,
): OverviewRow {
  return {
    id: portfolio.id,
    name: portfolio.name,
    holdings:
      portfolio.holdings.length === 0
        ? "0 holdings"
        : `${portfolio.holdings.length} holdings`,
    value: portfolio.value,
    cost: portfolio.cost,
    daily: portfolio.dailyAmount,
    dailyPercent: portfolio.dailyPercent,
    total: portfolio.allTimeAmount,
    totalPercent: portfolio.allTimePercent,
    tone: portfolio.allTimeAmount.startsWith("−") ? "negative" : "positive",
  };
}

export function wholeDollarAmount(value: string) {
  const amount = value.match(/^([+−-]?)([A-Z]{0,2}\$)([\d,]+)(?:\.(\d+))?$/);
  if (!amount) {
    return value;
  }

  const [, sign, currency, integerPart, fraction = ""] = amount;
  const shouldRoundUp = (fraction + "00").slice(0, 2) >= "50";
  const rounded =
    BigInt(integerPart.replaceAll(",", "")) + (shouldRoundUp ? 1n : 0n);

  // BUG-003 sweep: `BigInt.prototype.toLocaleString` is still Intl/CLDR
  // digit-grouping under the hood, so it carries the same
  // server-vs-browser hydration risk as the date formatters this task
  // fixes -- `groupThousands` (already used elsewhere in this client graph
  // for money display) groups digits by a fixed regex, zero locale data.
  return `${sign}${currency}${groupThousands(rounded.toString())}`;
}

export function sortByExactKey<T>(
  rows: T[],
  selectKey: (row: T) => string,
  direction: Direction,
) {
  return [...rows].sort((left, right) => {
    const compared = compareBigIntStrings(selectKey(left), selectKey(right));
    return direction === "ascending" ? compared : -compared;
  });
}
