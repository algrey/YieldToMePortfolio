"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { rememberPrimaryTab } from "../last-primary-tab";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
// PRF-014 step 1: this file is "use client", so a runtime (value) import
// from ../prototype-data would ship all 447 lines of preview/demo fixture
// data (historyBars/overviewRows/portfolioPrototypes) in every production
// client bundle, even though none of it is reachable outside the
// `_sites-preview`/`/portfolio/preview/*` fixture routes -- every real
// caller (app/page.tsx, [section]/page.tsx, [holdingId]/page.tsx) passes
// either `ownedWorkspace` or `portfolioPrototypesOverride`, never neither.
// Only TYPES are imported here (erased at build time); the preview routes
// import the runtime values themselves and pass them down as props.
import {
  type Holding,
  type PortfolioPrototype,
  type Tone,
} from "../prototype-data";
import {
  quoteDisplayState,
  quoteExplanation,
  type QuoteRow,
} from "../quote-contract";
import { watchlistExplanation, type WatchlistRow } from "../watchlist-contract";
import type { PortfolioInspection } from "../../db/repositories/portfolio-inspection";
import { BrandMark } from "./brand-mark";
import { AccountLifecycleRecovery } from "./account-lifecycle-recovery";
import { AccountLifecycleControls } from "./account-lifecycle-controls";
import { OwnedPortfolioDetails } from "./portfolio-details";
import { PortfolioValueChart } from "./portfolio-value-chart";
import { hasUsableHistoryPoints } from "../price-history-chart-geometry";
import { ServiceWorkerRegistration } from "./service-worker-registration";
import { subtractCalendarMonths } from "../overview-range";
import { sampleOverviewChartPoints } from "../overview-chart";
import { overviewFormulaTotal, overviewStateCopy } from "../overview-copy";
import {
  filterToClosedFyWindow,
  filterToFyToDateWindow,
  fyRangeEyebrow,
  windowChangeAmount,
} from "../overview-fy-range";
import {
  sortOwnedHoldings,
  type OwnedCashSummary,
  type OwnedHoldingRow,
  type ProjectionPendingState,
} from "../owned-holdings-contract";
import {
  ownedHoldingAmount,
  ownedHoldingAmountWhole,
  ownedHoldingDecimalNeverFakeZero,
  ownedHoldingHiddenSoldCount,
  ownedHoldingHiddenSoldDisclosureText,
  ownedHoldingPercent,
  ownedHoldingQuantity,
  ownedHoldingQuantityIsZero,
  ownedHoldingRealisedGainLine,
  ownedHoldingSplitLeadingSign,
  ownedHoldingToneFromDecimal,
  ownedHoldingTrimmed,
  ownedHoldingVisibleWhenHideSold,
} from "../owned-holding-format";
import {
  hideSoldStorageKey,
  loadHideSoldSession,
  saveHideSoldSession,
} from "../owned-holdings-hide-sold";
import type { SecurityRealisedGainTotal } from "../../domain/gains/index.ts";
import type { HoldingsSummaryFooter } from "../owned-holdings-summary.ts";
import { currencyDisplayPrefix } from "../currency-display.ts";
import {
  currentFyWindow,
  groupThousands,
  lastFyWindow,
} from "../../domain/calculations/index.ts";
import { formatDayMonth } from "../date-display.ts";
import { type PortfolioSection } from "../portfolio-sections";

// Type-only re-export for existing callers (e.g. the holding-detail route)
// -- safe across the client boundary because types are erased at compile
// time. The RUNTIME `portfolioSections` array lives in `../portfolio-sections`
// and is intentionally NOT imported/re-exported here: server components must
// import it straight from that shared module rather than through this
// "use client" file, which would turn it back into an opaque client
// reference (see that module's comment for the concrete failure this
// caused).
export { type PortfolioSection };

// UI-008 review: the portfolio create/rename dialog and QuoteCorrectionDialog
// both disable their Cancel button while a save is pending, and
// QuoteCorrectionDialog also blocks Escape while pending -- so a fetch that
// never settles (dropped connection, stalled proxy) turns into a temporary
// keyboard trap with no way out. Every dialog submit in this file races its
// fetch against this bounded timeout via AbortController so pending state
// always resolves, the dialog stays open and operable, and the owner gets an
// explicit in-dialog message instead of a silent hang.
const DIALOG_FETCH_TIMEOUT_MS = 15_000;
// UI-009: every dialog this message can fire from is a mutation submit, so
// "try again" would invite a retry the client can't know is safe -- a
// slow-but-successful save followed by a retry could double the effect
// (see the manual-dividend-create idempotency guard in
// dividend-assumptions-actions.ts for the one path where that mattered
// concretely). Reworded to convey the genuine uncertainty instead.
const DIALOG_TIMEOUT_MESSAGE =
  "The request timed out. It may still have gone through — check before retrying.";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// Financial-year start month options for the settings control (FY-001B).
// Full names label the select; abbreviations compose the helper text's
// window description. This is display-only -- the authoritative FY window
// math lives in domain/calculations/financial-year.ts.
const FY_MONTH_NAMES = [
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
const FY_MONTH_ABBREVIATIONS = [
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
function financialYearWindowHelperText(startMonth: number): string {
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
  // boundary as a prop into this "use client" module. `undefined` (as a
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
const primaryPortfolioSections: PortfolioSection[] = [
  "overview",
  "news",
  "quotes",
  "holdings",
  "details",
];
type ViewState = "populated" | "empty" | "partial" | "provider-error";
type HoldingSort = "ticker" | "value" | "daily" | "total";
type QuoteSort = "ticker" | "price" | "change";
type Direction = "ascending" | "descending";
type OpenMenu = "portfolio" | "add" | "prototype" | null;

type OverviewRow = Readonly<{
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

const prototypeStateLabels: Record<ViewState, string> = {
  populated: "Populated portfolio",
  empty: "Empty portfolio",
  partial: "Partial pricing",
  "provider-error": "Provider unavailable",
};

function sectionHref(section: PortfolioSection, overviewHref: string) {
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
function ownedNoPortfolioHref(section: PortfolioSection) {
  return section === "overview" ? "/" : `/?section=${section}`;
}

function compareBigIntStrings(left: string, right: string) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

function compactAmount(value: string) {
  return value.replace("A$", "");
}

function overviewRowFromPortfolio(portfolio: PortfolioPrototype): OverviewRow {
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

function wholeDollarAmount(value: string) {
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

function sortByExactKey<T>(
  rows: T[],
  selectKey: (row: T) => string,
  direction: Direction,
) {
  return [...rows].sort((left, right) => {
    const compared = compareBigIntStrings(selectKey(left), selectKey(right));
    return direction === "ascending" ? compared : -compared;
  });
}

function ToneValue({
  children,
  tone,
  className = "",
}: {
  children: React.ReactNode;
  tone: Tone;
  className?: string;
}) {
  return <span className={`tone-${tone} ${className}`}>{children}</span>;
}

function StatusBanner({
  viewState,
  onReset,
}: {
  viewState: ViewState;
  onReset: () => void;
}) {
  if (viewState === "populated" || viewState === "empty") {
    return null;
  }

  const isPartial = viewState === "partial";
  return (
    <div className={`status-banner ${isPartial ? "warning" : "error"}`}>
      <span className="status-symbol" aria-hidden="true">
        {isPartial ? "!" : "×"}
      </span>
      <p>
        <strong>{isPartial ? "Known value only" : "Prices unavailable"}</strong>
        <span>
          {isPartial
            ? "One holding is excluded because its current price is unavailable."
            : "Last known values are retained. Refresh is temporarily unavailable."}
        </span>
      </p>
      <button type="button" onClick={onReset}>
        Dismiss
      </button>
    </div>
  );
}

function EmptyState({
  title = "No holdings yet",
  message = "Add a quote or import transactions to start this portfolio.",
  action,
}: {
  title?: string;
  message?: string;
  // UI-021 (owner-reported): every empty state used to offer nothing
  // actionable at all -- this optional slot lets a specific call site (only
  // the "no portfolios yet" state, so far) supply a real, wired action.
  // Review B2 (correction): the OLD `showAction`/"Preview add menu" slot had
  // no `onClick` at all -- it was always inert, never wired to anything --
  // but it DID render at every call site that omitted the prop (its
  // default was `true`): the owned-mode `OwnedHoldingsScreen` empty state,
  // plus the prototype `OverviewScreen`, `HoldingsScreen`, `QuotesScreen`,
  // and `DetailsScreen` empty states (five call sites in total; only the
  // four call sites that explicitly passed `showAction={false}` suppressed
  // it). Its removal here is an intentional, orchestrator-approved cleanup
  // of that dead placeholder everywhere, not a claim that no call site was
  // affected.
  action?: {
    label: string;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    // Review B1 (BLOCKING): every other mutating control in this shell is
    // disabled while a mutation is in flight or the shell is offline
    // (`actionPending || !isOnline` -- see the portfolio dialog's own
    // Save/Cancel buttons). This action button had no such gate, so an
    // offline click could open the create dialog while every OTHER control
    // in this shell already treats offline as blocking -- Save/Cancel both
    // disabled, `submitPortfolioAction` early-returns on `!isOnline`
    // silently, leaving Escape as the only way out. Optional so a future
    // action-bearing call site that has no such state to report can omit it.
    disabled?: boolean;
  };
}) {
  return (
    <section className="empty-state" aria-labelledby="empty-title">
      <span className="empty-mark" aria-hidden="true">
        <BrandMark />
      </span>
      <p className="eyebrow">Empty state</p>
      <h2 id="empty-title">{title}</h2>
      <p>{message}</p>
      {action ? (
        <button
          type="button"
          className="empty-state-primary-action"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </button>
      ) : null}
    </section>
  );
}

function OwnedHoldingsScreen({
  rows,
  homeCurrencyCode,
  view,
  state,
  cash,
  portfolioId,
  realisedGains,
  summary,
  projectionPending,
  initialHideSold = true,
}: {
  rows: readonly OwnedHoldingRow[];
  homeCurrencyCode: string;
  view: "native" | "home";
  state: "complete" | "partial" | "empty" | "unavailable";
  cash?: OwnedCashSummary;
  /** BUG-017: see `OwnedWorkspace.holdingsProjectionPending`'s doc comment. */
  projectionPending?: ProjectionPendingState;
  /** UI-023: builds each row's link to the standalone per-holding detail
   * route (`/portfolio/:id/holdings/:portfolioSecurityId`) -- the owned
   * in-place detail `<dialog>` sheet is gone (owner decision, competitor
   * layout precedent: full-screen sub-tabs with a back control instead of
   * a popup). Always present: the single call site renders only when
   * `activePortfolio` exists. */
  portfolioId: string;
  /** UI-030: CGT-001A's per-security lifetime realised-gain rollup, keyed
   * by `portfolioSecurityId` (== `holding.id`) -- see `OwnedWorkspace`'s
   * own doc comment for why this is a plain object, not a `Map`. */
  realisedGains?: Record<string, SecurityRealisedGainTotal>;
  /** UI-031: the four-line portfolio summary, pre-composed server-side --
   * see `OwnedWorkspace.holdingsSummary`'s own doc comment. `undefined`
   * whenever there are no held securities at all. */
  summary?: HoldingsSummaryFooter;
  /** UI-052 test seam: initial Hide Sold state before the session-storage
   * hydration effect runs. Production always uses the default (`true`,
   * the owner's "hide sold" directive); rendered tests pass `false` to pin
   * the sold-row markup that is only visible in the Show Sold state. */
  initialHideSold?: boolean;
}) {
  const [sortKey, setSortKey] = useState<"ticker" | "value" | "daily" | "gain">(
    "daily",
  );
  const [direction, setDirection] = useState<Direction>("descending");
  const sortableRows = useMemo(
    () =>
      rows.map((row) => {
        const home = view === "home" && row.homeValue.status === "available";
        return {
          ...row,
          sort: {
            ...row.sort,
            value: home ? row.homeValue.value : row.nativeValue.value,
            daily: row.dailyPercent.value,
            gain: row.unrealisedPercent.value,
          },
        };
      }),
    [rows, view],
  );
  const sortedRows = useMemo(
    () => sortOwnedHoldings(sortableRows, sortKey, direction),
    [direction, sortableRows, sortKey],
  );

  // UI-040 (owner directive, verbatim, 2026-08-25): "Let add a 'Hide Sold'
  // button for the holdings." Display state only -- never gated on
  // `isOnline`, works offline -- persisted per PORTFOLIO for the session
  // via the DIV-013 sessionStorage pattern. Default `false` ("Show Sold",
  // the owner's explicit default) on every fresh mount/server render;
  // `hydratedHideSoldKeyRef` below gates when it is safe to start WRITING
  // to sessionStorage, mirroring `income-multi-year.tsx`'s
  // `hydratedKeyRef` guard verbatim (DIV-013 review B3) -- this component
  // can be re-rendered for a different `portfolioId` WITHOUT a full
  // remount (client-side portfolio switch), so a naive save effect could
  // otherwise clobber the newly-entered portfolio's real stored session
  // with the just-left portfolio's still-in-state value.
  // UI-052 (owner directive): default flipped to HIDE sold -- must match
  // `loadHideSoldSession`'s own default so the post-hydration read of an
  // empty session storage is a no-op, not a visible flicker.
  const [hideSold, setHideSold] = useState(initialHideSold);
  const hydratedHideSoldKeyRef = useRef<string | null>(null);

  // Declared BEFORE the load effect below -- same ordering rationale as
  // DIV-013's own save/load pair: effects run in declaration order within a
  // single render pass, so on the exact pass a `portfolioId` change re-runs
  // both, this one must run FIRST and observe the STALE ref (still the
  // previous portfolio's key) and early-return, rather than writing the
  // just-left portfolio's value into the newly-entered portfolio's key.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hydratedHideSoldKeyRef.current !== hideSoldStorageKey(portfolioId)) {
      return;
    }
    saveHideSoldSession(
      window.sessionStorage,
      hideSoldStorageKey(portfolioId),
      hideSold,
    );
  }, [hideSold, portfolioId]);

  // Reads any Hide Sold state left over from earlier in THIS session -- or,
  // on a portfolio switch, that OTHER portfolio's own separate key -- back
  // in. Client-side only (an effect never runs during server render).
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Indirected through a nested callback rather than calling setState
    // directly in the effect body -- the same sanctioned
    // `react-hooks/set-state-in-effect` workaround `QuoteCorrectionHistory`
    // (below in this file) and DIV-013's own load effect already use.
    (() => {
      const key = hideSoldStorageKey(portfolioId);
      setHideSold(loadHideSoldSession(window.sessionStorage, key));
      hydratedHideSoldKeyRef.current = key;
    })();
  }, [portfolioId]);

  // UI-040: hides FULLY-sold rows only (the UI-036 `ownedHoldingQuantityIsZero`
  // convention, reused verbatim) -- partially-sold rows are exact-decimal
  // non-zero and are never touched. `hiddenSoldCount` is computed from the
  // FULL `sortedRows` regardless of the current toggle, so the sr-only
  // disclosure below stays accurate whichever state the toggle is in.
  const hiddenSoldCount = useMemo(
    () => ownedHoldingHiddenSoldCount(sortedRows),
    [sortedRows],
  );
  const visibleRows = useMemo(
    () => ownedHoldingVisibleWhenHideSold(sortedRows, hideSold),
    [sortedRows, hideSold],
  );

  function handleSort(nextKey: "ticker" | "value" | "daily" | "gain") {
    if (nextKey === sortKey) {
      setDirection((current) =>
        current === "ascending" ? "descending" : "ascending",
      );
    } else {
      setSortKey(nextKey);
      setDirection(nextKey === "ticker" ? "ascending" : "descending");
    }
  }

  if (state === "unavailable") {
    return (
      <EmptyState
        title="Holdings unavailable"
        message="The published holdings projection is temporarily unavailable. No values were substituted."
      />
    );
  }
  if (state === "empty" && sortedRows.length === 0 && !cash?.cashSubtotal)
    return <EmptyState />;

  return (
    <div className="holdings-layout owned-holdings-layout">
      <section className="holdings-list" aria-label="Portfolio holdings">
        {sortedRows.length === 0 ? (
          <p className="empty-inline">
            No security holdings. Cash is shown separately.
          </p>
        ) : null}
        {/* BUG-017: honest, visible (non-color) disclosure that these
            figures may not reflect the ledger's latest change -- matches
            the `.unavailable`/`role="status"` advisory convention used
            elsewhere for holdings-row action-required states. */}
        {projectionPending?.pending ? (
          <p className="unavailable" role="status">
            {projectionPending.reason === "failed"
              ? "The last recalculation failed — figures reflect the previous successful calculation."
              : "Recalculating after your latest ledger change — figures may not yet reflect it."}
          </p>
        ) : null}
        <div className="holdings-grid table-heading sticky-heading">
          <SortButton
            label="Ticker"
            sortKey="ticker"
            activeKey={sortKey}
            direction={direction}
            onSort={handleSort}
          />
          <SortButton
            label={`Value / ${view === "home" ? homeCurrencyCode : "native"}`}
            sortKey="value"
            activeKey={sortKey}
            direction={direction}
            onSort={handleSort}
          />
          <SortButton
            label="Daily"
            sortKey="daily"
            activeKey={sortKey}
            direction={direction}
            onSort={handleSort}
          />
          <SortButton
            label="Total"
            sortKey="gain"
            activeKey={sortKey}
            direction={direction}
            onSort={handleSort}
          />
        </div>
        <div className="holding-rows">
          {visibleRows.map((holding) => {
            const rowView = view;
            const homeAvailable =
              holding.homeValue.status === "available" &&
              holding.homePrice.status === "available";
            const usedNativeFallback = rowView === "home" && !homeAvailable;
            const selectedValue =
              rowView === "home" && !usedNativeFallback
                ? holding.homeValue
                : holding.nativeValue;
            const selectedPrice =
              rowView === "home" && !usedNativeFallback
                ? holding.homePrice
                : holding.nativePrice === null
                  ? {
                      status: "unavailable" as const,
                      value: null,
                      currencyCode: holding.currencyCode,
                    }
                  : {
                      status: "available" as const,
                      value: holding.nativePrice,
                      currencyCode: holding.currencyCode,
                    };
            const basis = holding.homeBasis;
            const priceLabel = usedNativeFallback
              ? holding.nativePrice === null
                ? "unavailable"
                : `${currencyDisplayPrefix(holding.currencyCode, homeCurrencyCode)}${ownedHoldingTrimmed(holding.nativePrice)} · native fallback`
              : selectedPrice.status === "available" &&
                  selectedPrice.value !== null
                ? `${currencyDisplayPrefix(selectedPrice.currencyCode, homeCurrencyCode)}${ownedHoldingTrimmed(selectedPrice.value)}`
                : holding.nativePrice === null
                  ? "unavailable"
                  : `${currencyDisplayPrefix(holding.currencyCode, homeCurrencyCode)}${ownedHoldingTrimmed(holding.nativePrice)}`;
            // UI-034 (owner directive 2026-08-23): `missing_previous`
            // renders NO action label -- the daily cell's em-dash remains
            // the honest missing-data signal, the state self-heals via
            // MKT-015's daily accretion, and the owner ruled the label
            // superfluous ("It does not effect the purchase price").
            // Every other action-required label is unchanged.
            const statusLabel =
              holding.actionStatus === "none" ||
              holding.actionStatus === "missing_previous"
                ? ""
                : ` · Action required: ${
                    holding.actionStatus === "stale"
                      ? "stale market data"
                      : holding.actionStatus === "missing_price"
                        ? "price unavailable"
                        : holding.actionStatus === "missing_fx"
                          ? "FX unavailable"
                          : holding.actionStatus === "incomparable"
                            ? "comparison unavailable"
                            : holding.actionStatus === "yahoo_auth_expired"
                              ? "Yahoo login expired"
                              : "Yahoo login not configured"
                  }`;
            const realisedLine = ownedHoldingRealisedGainLine(
              homeCurrencyCode,
              realisedGains?.[holding.id],
            );
            // UI-036 (owner directive, verbatim, 2026-08-23): a fully sold
            // holding (current quantity exactly zero) omits the row-
            // tertiary "avg cost x quantity" line entirely -- regardless
            // of whether the basis figure itself would render or read
            // "Basis unavailable" -- leaving three lines (ticker/value,
            // price/daily, Realised) instead of four. Partially-sold/held
            // rows (quantity > 0) are unaffected.
            const isSoldOut = ownedHoldingQuantityIsZero(holding.quantity);
            return (
              // UI-023: a real link to the standalone per-holding detail
              // route, replacing the in-place <dialog> sheet -- URL-
              // addressable, works with JS disabled, and mirrors the
              // preview path's existing holdingDetailHref link rows.
              <Link
                className="holding-row holdings-grid"
                key={holding.id}
                href={`/portfolio/${portfolioId}/holdings/${holding.id}`}
                aria-label={`${holding.symbol}, ${holding.name}, open details`}
              >
                <span className="row-primary symbol">{holding.symbol}</span>
                <span className="row-primary numeric">
                  {ownedHoldingAmount(homeCurrencyCode, selectedValue)}
                </span>
                <ToneValue
                  tone={holding.dailyTone}
                  className="row-primary numeric"
                >
                  {ownedHoldingAmount(
                    homeCurrencyCode,
                    holding.dailyMovement,
                    2,
                    true,
                  )}
                </ToneValue>
                <ToneValue
                  tone={holding.gainTone}
                  className="row-primary numeric"
                >
                  {ownedHoldingAmount(
                    homeCurrencyCode,
                    holding.unrealisedGain,
                    2,
                    true,
                  )}
                </ToneValue>
                <span className="row-secondary">
                  {priceLabel}
                  {statusLabel}
                </span>
                <span className="row-secondary numeric">
                  Basis {ownedHoldingAmount(homeCurrencyCode, basis)}
                </span>
                <span className="row-secondary numeric">
                  {ownedHoldingPercent(holding.dailyPercent, true)}
                </span>
                <ToneValue
                  tone={holding.gainTone}
                  className="row-primary numeric"
                >
                  {ownedHoldingPercent(holding.unrealisedPercent, true)}
                </ToneValue>
                {isSoldOut ? null : (
                  <span className="row-tertiary">
                    {/* UI-034 (owner directive 2026-08-23): the "Avg " prefix
                        was dropped from this line -- the cost x quantity
                        composition itself is unchanged. */}
                    {holding.averageNativeCost === null
                      ? "Basis unavailable"
                      : /* UI-028 review (B4, BLOCKING): a genuinely non-zero
                           average cost must never render as "0.00" just
                           because 2dp rounds it away -- falls back to the
                           trimmed exact form for that value only (see
                           `ownedHoldingDecimalNeverFakeZero`'s doc comment). */
                        `${currencyDisplayPrefix(holding.currencyCode, homeCurrencyCode)}${ownedHoldingDecimalNeverFakeZero(holding.averageNativeCost, 2)}`}{" "}
                    {/* UI-028 review (B4, BLOCKING) delivered whole-unless-
                        fractional quantity display at this ONE call site;
                        UI-027 then centralised it into the shared
                        `ownedHoldingQuantity` helper (`app/quantity-format.ts`)
                        every quantity-rendering surface now uses -- an
                        INTEGRAL quantity's trailing ".000..." is stripped
                        entirely (no decimal point at all), while a genuinely
                        fractional quantity (e.g. a DRP fractional share)
                        keeps its real trimmed digits instead of being
                        rounded away to a misleading whole number. */}
                    × {ownedHoldingQuantity(holding.quantity)}
                  </span>
                )}
                <span className="desktop-only holding-name">
                  {holding.name} · {holding.exchange} · {holding.currencyCode}
                </span>
                {realisedLine ? (
                  <ToneValue
                    tone={realisedLine.tone}
                    className="row-quaternary"
                  >
                    {realisedLine.content}
                  </ToneValue>
                ) : null}
                <span className="sr-only">{holding.explanation}</span>
              </Link>
            );
          })}
        </div>
        {summary && sortedRows.length > 0 ? (
          <HoldingsSummaryFooterRow
            summary={summary}
            homeCurrencyCode={homeCurrencyCode}
            hideSold={hideSold}
            hiddenSoldCount={hiddenSoldCount}
            onToggleHideSold={() => setHideSold((current) => !current)}
          />
        ) : null}
      </section>
    </div>
  );
}

// UI-031 (owner directive, verbatim): "Holdings should have a summary
// row ... four lines ... static at the bottom of the page (as in the
// holdings scroll past it) but may later change my mind to have it first
// or last." A DELIBERATELY placement-agnostic, pure presentational
// component -- it takes already-composed data (`app/owned-holdings-
// summary.ts`'s `buildHoldingsSummaryFooter`) and knows nothing about
// where its caller puts it; the ONLY thing pinning it to the bottom of
// the holdings scroll flow is the `.holdings-summary-footer` CSS class
// (`app/globals.css`, `position: sticky; bottom: ...`). Moving it first
// or last later is a JSX reorder at the ONE call site above, nothing in
// this component or its CSS class needs to change.
// UI-031B (Orchestrator ruling): when a line's figure is a genuinely
// partial/incomplete sum, the figure itself keeps its honest "available"
// (partial) state -- never a fifth visible summary line -- and the full
// exclusion explanation compresses to accessible text (sr-only for
// screen readers, `title` for pointer/hover users) plus this minimal
// visible "partial" marker rendered INSIDE the affected cell, in the same
// row-tertiary type the rest of the footer's micro-text uses. `null`
// (no qualifier) renders nothing at all.
// Review fold: some qualifiers already begin "partial -- " (e.g. the
// All Time / Realised qualifiers `buildHoldingsSummaryFooter` composes),
// others don't (the plain value/daily exclusion sentences) -- the sr-only
// text below supplies exactly ONE "partial -- " prefix regardless of
// which shape `text` arrives in, so it never stutters "partial --
// partial -- excludes...".
function partialDetail(text: string): string {
  return text.startsWith("partial -- ")
    ? text.slice("partial -- ".length)
    : text;
}
function PartialMarker({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="row-tertiary partial-marker" title={text}>
      {" "}
      partial
      <span className="sr-only"> -- {partialDetail(text)}</span>
    </span>
  );
}

function HoldingsSummaryFooterRow({
  summary,
  homeCurrencyCode,
  hideSold,
  hiddenSoldCount,
  onToggleHideSold,
}: {
  summary: HoldingsSummaryFooter;
  homeCurrencyCode: string;
  /** UI-040: display state only -- never derived from or fed back into
   * `summary`, so the footer's own totals below are BYTE-UNCHANGED
   * regardless of this value (they still include sold history). */
  hideSold: boolean;
  /** Count of fully-sold rows a `true` `hideSold` would remove -- feeds
   * ONLY the sr-only live region (owner ruling: never visible text, and
   * review B3: no `title`/hover disclosure either -- a hover tooltip is
   * still visible text). */
  hiddenSoldCount: number;
  onToggleHideSold: () => void;
}) {
  // UI-030's own tone rule (a plain decimal string's sign), reused
  // verbatim rather than re-implemented -- "unavailable" figures stay
  // neutral (no colour claim about a number that isn't shown).
  const toneOf = (value: {
    status: "available" | "unavailable";
    value: string | null;
  }): Tone =>
    value.status === "available" && value.value !== null
      ? ownedHoldingToneFromDecimal(value.value)
      : "neutral";
  const dailyTone = toneOf(summary.dailyMovement);
  const gainTone = toneOf(summary.unrealisedGain);
  const allTimeTone = toneOf(summary.allTimeGain);
  const realisedTone = toneOf(summary.realisedGain);
  // UI-040 review (B1, BLOCKING): split ONCE per line into { sign, rest }
  // (see `ownedHoldingSplitLeadingSign`'s own doc comment for the full
  // alignment mechanism) -- computed here rather than inline in the JSX
  // below so the same split is never recomputed (and can never diverge)
  // between the sign slot and the rest of the figure.
  const allTimeSplit = ownedHoldingSplitLeadingSign(
    ownedHoldingAmountWhole(homeCurrencyCode, summary.allTimeGain, true),
  );
  const realisedSplit = ownedHoldingSplitLeadingSign(
    ownedHoldingAmountWhole(homeCurrencyCode, summary.realisedGain, true),
  );

  return (
    <div
      className="holdings-summary-footer"
      role="group"
      aria-label="Portfolio totals"
    >
      {/* UI-031B (owner directive, verbatim: "UI-031 has 6 lines not 4,
          remove the extra explanatory text"): the footer renders EXACTLY
          the four owner-specified lines below -- this base-currency
          statement (UI-032, Orchestrator ruling round 2 review fix B1)
          is a ROUTINE label under AGENTS.md's compact-view rule (it
          states the same ISO identity every render, never an action-
          required fact), so it goes sr-only rather than a fifth visible
          line: still reachable to a screen-reader user (the honesty
          guarantee AGENTS.md requires), never rendered as on-screen text.
          Per-row labels only name each HOLDING's own currency
          (`holding.currencyCode`), which is never guaranteed to equal the
          base currency (a portfolio of entirely foreign-currency holdings
          would show it nowhere) -- so the statement is restated here,
          unconditionally, wherever this summary renders. Describes the
          REAL rule instead of "every figure is base currency": `view ===
          "native"` can put a held security's own (foreign) currency on
          its row, so this names the actual bare marker via
          `currencyDisplayPrefix(homeCurrencyCode, homeCurrencyCode)`
          rather than claiming amounts render with "no prefix" --
          `currencyDisplayPrefix` NEVER returns empty (base amounts still
          get a bare $/£/€/¥, or the "CODE " fallback for a symbol-less
          code like CHF). tests/ui-032.test.ts asserts the sr-only
          presence, not visible text. */}
      <p className="sr-only">
        <strong>{homeCurrencyCode} reporting values</strong> -- amounts shown as{" "}
        <strong>
          {currencyDisplayPrefix(homeCurrencyCode, homeCurrencyCode)}
        </strong>{" "}
        are this portfolio&apos;s base currency; other currencies are flagged
        (e.g. US$).
      </p>
      <div
        className="holdings-grid summary-line"
        role="group"
        aria-label="Unrealised total value, daily gain, and total gain"
      >
        <span className="row-primary symbol">Unrealised</span>
        <span className="row-primary numeric">
          {ownedHoldingAmountWhole(homeCurrencyCode, summary.marketValue)}
          <PartialMarker text={summary.valueQualifier} />
        </span>
        <ToneValue tone={dailyTone} className="row-primary numeric">
          {ownedHoldingAmountWhole(
            homeCurrencyCode,
            summary.dailyMovement,
            true,
          )}
          <PartialMarker text={summary.dailyQualifier} />
        </ToneValue>
        <ToneValue tone={gainTone} className="row-primary numeric">
          {ownedHoldingAmountWhole(
            homeCurrencyCode,
            summary.unrealisedGain,
            true,
          )}
        </ToneValue>
      </div>
      <div
        className="holdings-grid summary-line"
        role="group"
        aria-label="Cost basis, daily percent, and total percent"
      >
        <span className="row-secondary" aria-hidden="true" />
        <span className="row-secondary numeric">
          {ownedHoldingAmountWhole(homeCurrencyCode, summary.costBasis)}
        </span>
        <ToneValue tone={dailyTone} className="row-secondary numeric">
          {ownedHoldingPercent(summary.dailyPercent, true)}
        </ToneValue>
        <ToneValue tone={gainTone} className="row-secondary numeric">
          {ownedHoldingPercent(summary.totalPercent, true)}
        </ToneValue>
      </div>
      {/* UI-040 (owner directive, verbatim, 2026-08-25): "We move the
          values to the left side (ie just after the text, though I would
          like the dollar signs to line up), then on the right side in the
          same row have a Hide Sold button ... It should not cause the
          summary row to grow in vertical size." The two lines below stay
          NORMAL in-flow flex children (same line-height/gap as before, so
          `--holdings-summary-h` above is byte-unchanged) -- only the
          toggle is taken OUT of flow (`position: absolute` in
          `app/globals.css`, vertically centered across both lines), so its
          own QA-001B 44px target can exceed the ~41px two-line block's
          height without growing this wrapper at all. Alignment mechanism
          (review B1 fix -- the FULL mechanism has TWO fixed-width slots,
          not one): (1) each line's label carries the shared
          `.summary-line-label` class, fixing an identical column width
          (`min-width`, in `em`) on BOTH lines; (2) each line's SIGN
          (`ownedHoldingSplitLeadingSign`, below) renders in its own fixed
          one-character `.summary-line-sign` slot immediately after the
          label -- "+", "-"/"−", and "" (no sign) all occupy the same slot
          width, so the "$" that follows (the value's real first character
          once the sign is pulled out) lands at the identical x offset on
          both lines regardless of which of the three sign states either
          line is in. Slot (1) alone was insufficient: the sign used to
          render INLINE with the value, so its own variable (or absent)
          width shifted the "$" itself -- pre-fix a mixed +/− pair
          misaligned 2.6px and an unsigned "$0" Realised line misaligned
          9.35px, both now zero. */}
      <div className="summary-lines-lower">
        <div
          className="summary-line-combined"
          role="group"
          aria-label="All time gain"
        >
          <span className="row-primary symbol summary-line-label">
            All Time
          </span>
          <ToneValue tone={allTimeTone} className="row-primary numeric">
            <span className="summary-line-sign">{allTimeSplit.sign}</span>
            {allTimeSplit.rest} (
            {ownedHoldingPercent(summary.allTimePercent, true)})
            <PartialMarker text={summary.allTimeQualifier} />
          </ToneValue>
        </div>
        <div
          className="summary-line-combined"
          role="group"
          aria-label="Realised gain"
        >
          <span className="row-primary symbol summary-line-label">
            Realised
          </span>
          <ToneValue tone={realisedTone} className="row-primary numeric">
            <span className="summary-line-sign">{realisedSplit.sign}</span>
            {realisedSplit.rest} (
            {ownedHoldingPercent(summary.realisedPercent, true)})
            <PartialMarker text={summary.realisedQualifier} />
          </ToneValue>
        </div>
        {/* UI-040 review (owner follow-up, verbatim: "No explanatory text
            on the screen please ... Preserving information density on the
            holding screen is very important"): the button's LABEL is the
            entire visible surface of this feature -- text-as-state
            (QA-001B non-colour signal), `aria-pressed` for assistive tech,
            44px target. No visible helper sentence, count, or disclosure
            line anywhere -- the honesty note below is sr-only ONLY, no
            `title`/hover (review B3: a hover tooltip is still visible
            text). */}
        <button
          type="button"
          className="hide-sold-toggle"
          aria-pressed={hideSold}
          onClick={onToggleHideSold}
        >
          {hideSold ? "Show Sold" : "Hide Sold"}
        </button>
        {/* UI-040 review fold: the live region element is ALWAYS mounted
            (never conditionally added/removed) -- only its TEXT content
            changes with `hideSold`. Assistive tech reliably announces a
            change to an EXISTING live region's content; a region that is
            itself mounted-with-content on the same render (the previous
            shape here) is not reliably announced, since there was no prior
            state for the AT to diff against. */}
        <span className="sr-only" role="status">
          {hideSold
            ? (ownedHoldingHiddenSoldDisclosureText(hiddenSoldCount) ?? "")
            : ""}
        </span>
      </div>
    </div>
  );
}

// UI-025 (owner ruling 2026-08-22): "A new user should see the news in the
// news tab. There are plenty of avenues for a new user to create a
// portfolio." -- the primary News tab embeds the SAME owner news site as the
// per-holding News tab (UI-023B: app/portfolio/[portfolioId]/[section]/
// [holdingId]/news/page.tsx), whether or not a portfolio exists yet, instead
// of the generic "No portfolios yet"/"News is not connected yet" empty
// states OwnedWorkspaceScreen otherwise renders for every section. Same
// origin, same `referrerPolicy="no-referrer"` (portfolio URLs are never at
// risk here since this route carries no portfolio id at all), and the same
// Worker CSP `frame-src` allowance (worker/response-security.ts) already
// covers this one origin -- no widening required. The embed URL carries no
// portfolio/security identifiers, so it is safe to render before a
// portfolio exists.
const PRIMARY_NEWS_EMBED_URL = "https://greeninvestments.au/?embed=1";

function OwnedNewsScreen() {
  return (
    <section
      className="owned-news-embed holding-news-embed"
      aria-labelledby="owned-news-title"
    >
      <h1 id="owned-news-title" className="sr-only">
        News
      </h1>
      <iframe
        className="holding-news-frame"
        src={PRIMARY_NEWS_EMBED_URL}
        title="Green Investments news"
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      />
    </section>
  );
}

type WatchlistSearchCandidate = {
  symbol: string;
  exchangeId: string | null;
  currencyCode: string | null;
  name: string;
  assetType: "equity" | "etf" | "fund";
};

// WLT-001 (owner directive, 2026-08-22): "The Quotes tab is a watch list,
// for stocks and currencies ... it does not record a position, just an
// interest." Renders in EVERY owned state that has a real userId (both
// `OwnedWorkspaceScreen` call sites below, mirroring UI-025's `OwnedNewsScreen`
// precedent exactly) -- the watchlist is USER-scoped, not portfolio-scoped,
// so it works before any portfolio exists. Column spec (owner, verbatim):
// three columns, two lines per row -- (1) Ticker over company name; (2) Last
// price over the time of last price (or date if not today); (3) Day change
// in price over change in percent. Styling reuses the SAME `.quotes-grid`/
// `.quote-row` two-line dense-row idiom the old portfolio-scoped Quotes
// surface used (see `globals.css`) -- no new row CSS. Each row is a
// non-button `role="group"` (not the old single unlabelled `<button>`) so it
// can host real Move/Remove controls without nesting interactive elements
// inside a `<button>`.
function OwnedWatchlistScreen({
  rows,
  viewState,
  isOnline,
}: {
  rows: WatchlistRow[];
  viewState: ViewState;
  isOnline: boolean;
}) {
  const router = useRouter();
  // WLT-001 review (B1, BLOCKING): `sortKey` starts `null` -- "no column
  // sort active", rendering `rows` in the SERVER's stored `display_order`
  // (the owner's own reorder-persisted order). Column sorting is an
  // OPT-IN view on top of that; while it is active, Move up/down are
  // disabled (a column-sorted view's adjacency is not the stored order, so
  // a "move" there would silently reorder relative to the WRONG list).
  const [sortKey, setSortKey] = useState<QuoteSort | null>(null);
  const [direction, setDirection] = useState<Direction>("ascending");
  const [actionPending, setActionPending] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<"security" | "currency" | null>(null);
  const addSecurityButtonRef = useRef<HTMLButtonElement>(null);
  const addCurrencyButtonRef = useRef<HTMLButtonElement>(null);
  const addOpenerRef = useRef<HTMLButtonElement | null>(null);
  const securityInputRef = useRef<HTMLInputElement>(null);
  const currencyInputRef = useRef<HTMLInputElement>(null);
  const [searchText, setSearchText] = useState("");
  const [searchPending, setSearchPending] = useState(false);
  const [searchResults, setSearchResults] = useState<
    WatchlistSearchCandidate[]
  >([]);
  const [baseCurrencyCode, setBaseCurrencyCode] = useState("");
  const [quoteCurrencyCode, setQuoteCurrencyCode] = useState("");

  // Mirrors the correction dialog's UI-007 opener-restore pattern: focus
  // moves into the panel on open, and back to whichever "Add" button opened
  // it on close.
  useEffect(() => {
    if (addMode === "security") securityInputRef.current?.focus();
    if (addMode === "currency") currencyInputRef.current?.focus();
    if (!addMode && addOpenerRef.current) {
      addOpenerRef.current.focus();
      addOpenerRef.current = null;
    }
  }, [addMode]);

  const mutationsDisabled = actionPending || !isOnline;
  const customOrderActive = sortKey === null;
  const moveDisabledTitle = customOrderActive
    ? undefined
    : "Clear the column sort to reorder the watchlist.";

  // B1: `rows` (the prop) IS the stored order -- `app/owned-watchlist.ts`
  // already returns it sorted by `display_order`. `sortedRows` is a
  // DISPLAY-ONLY view; `storedIndexByEntryId` below is derived from `rows`
  // directly so Move up/down's boundary checks and `moveEntry` itself never
  // read position from `sortedRows`.
  const sortedRows = useMemo(() => {
    if (sortKey === null) return rows;
    if (sortKey === "ticker") {
      return [...rows].sort((left, right) => {
        const compared = left.symbol.localeCompare(right.symbol);
        return direction === "ascending" ? compared : -compared;
      });
    }
    return sortByExactKey(rows, (row) => row.sort[sortKey], direction);
  }, [direction, rows, sortKey]);

  const storedIndexByEntryId = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.entryId, index));
    return map;
  }, [rows]);

  function handleSort(nextKey: QuoteSort) {
    if (nextKey === sortKey) {
      setDirection((current) =>
        current === "ascending" ? "descending" : "ascending",
      );
      return;
    }
    setSortKey(nextKey);
    setDirection(nextKey === "ticker" ? "ascending" : "descending");
  }

  async function runSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionMessage(null);
    const text = searchText.trim();
    if (!text) return;
    setSearchPending(true);
    // UI-008 convention (WLT-001 review B3): every fetch in this screen
    // races an AbortController-driven timeout so pending state always
    // resolves and the owner gets an explicit message instead of a silent
    // hang -- see DIALOG_FETCH_TIMEOUT_MS's header comment.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const query = new URLSearchParams({ text });
      const response = await fetch(`/api/watchlist/search?${query}`, {
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        candidates?: WatchlistSearchCandidate[];
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Search failed.");
      setSearchResults(result.candidates ?? []);
      if (!(result.candidates ?? []).length) {
        setActionMessage("No matches found.");
      }
    } catch (error) {
      setSearchResults([]);
      setActionMessage(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Search failed.",
      );
    } finally {
      clearTimeout(timeout);
      setSearchPending(false);
    }
  }

  async function addSecurity(candidate: WatchlistSearchCandidate) {
    setActionMessage(null);
    setActionPending(true);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch("/api/watchlist/securities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: candidate.symbol,
          exchangeAlias: candidate.exchangeId,
          currencyCode: candidate.currencyCode,
        }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Could not add to the watchlist.");
      setAddMode(null);
      setSearchResults([]);
      setSearchText("");
      router.refresh();
    } catch (error) {
      setActionMessage(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Could not add to the watchlist.",
      );
    } finally {
      clearTimeout(timeout);
      setActionPending(false);
    }
  }

  async function addCurrencyPair(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionMessage(null);
    const base = baseCurrencyCode.trim().toUpperCase();
    const quote = quoteCurrencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
      setActionMessage("Enter two valid 3-letter currency codes.");
      return;
    }
    setActionPending(true);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch("/api/watchlist/currency-pairs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseCurrencyCode: base,
          quoteCurrencyCode: quote,
        }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Could not add the currency pair.");
      setAddMode(null);
      setBaseCurrencyCode("");
      setQuoteCurrencyCode("");
      router.refresh();
    } catch (error) {
      setActionMessage(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Could not add the currency pair.",
      );
    } finally {
      clearTimeout(timeout);
      setActionPending(false);
    }
  }

  async function removeEntry(row: WatchlistRow) {
    setActionMessage(null);
    setActionPending(true);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch("/api/watchlist/entries", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: row.entryId,
          expectedVersion: row.version,
        }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Could not remove this entry.");
      router.refresh();
    } catch (error) {
      setActionMessage(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Could not remove this entry.",
      );
    } finally {
      clearTimeout(timeout);
      setActionPending(false);
    }
  }

  // B1: reasons entirely about `rows` (the STORED order), never
  // `sortedRows` -- `row`'s own position is looked up in `rows` directly,
  // and the submitted `orderedIds` is `rows` with that one entry moved,
  // so a persisted reorder can never silently apply against a
  // column-sorted view instead of the real stored order.
  async function moveEntry(row: WatchlistRow, offset: -1 | 1) {
    const storedIndex = storedIndexByEntryId.get(row.entryId);
    if (storedIndex === undefined) return;
    const target = storedIndex + offset;
    if (target < 0 || target >= rows.length) return;
    const reordered = [...rows];
    const [moved] = reordered.splice(storedIndex, 1);
    reordered.splice(target, 0, moved!);
    setActionMessage(null);
    setActionPending(true);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch("/api/watchlist/reorder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderedIds: reordered.map((entry) => entry.entryId),
        }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Could not reorder the watchlist.");
      router.refresh();
    } catch (error) {
      setActionMessage(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Could not reorder the watchlist.",
      );
    } finally {
      clearTimeout(timeout);
      setActionPending(false);
    }
  }

  return (
    <section className="quotes-screen" aria-label="Watchlist">
      <div className="quote-actions" aria-label="Watchlist actions">
        <p className="data-explanation">
          Watchlist entries record interest only -- adding a stock or currency
          pair here never creates a holding or position. Prices come from
          Yahoo-compatible market data; a Sharesight-delayed price source only
          ever covers securities actually held in Sharesight, so a watch-only
          entry prices from Yahoo when available even if Sharesight is the
          preferred source elsewhere.
        </p>
        <div className="quote-action-buttons">
          <button
            ref={addSecurityButtonRef}
            type="button"
            onClick={() => {
              addOpenerRef.current = addSecurityButtonRef.current;
              setAddMode("security");
              setActionMessage(null);
            }}
            disabled={mutationsDisabled}
          >
            Add a stock
          </button>
          <button
            ref={addCurrencyButtonRef}
            type="button"
            onClick={() => {
              addOpenerRef.current = addCurrencyButtonRef.current;
              setAddMode("currency");
              setActionMessage(null);
            }}
            disabled={mutationsDisabled}
          >
            Add a currency pair
          </button>
        </div>
        {actionMessage ? (
          <p className="quote-action-status" role="alert">
            {actionMessage}
          </p>
        ) : null}
      </div>
      {addMode === "security" ? (
        <section
          className="quote-history watchlist-add-panel"
          aria-labelledby="watchlist-add-security-title"
        >
          <div className="quote-history-heading">
            <h2 id="watchlist-add-security-title">Add a stock</h2>
            <button
              type="button"
              onClick={() => setAddMode(null)}
              aria-label="Close add a stock"
            >
              Close
            </button>
          </div>
          <form
            className="watchlist-add-form"
            onSubmit={(event) => void runSearch(event)}
          >
            <label className="watchlist-add-field wide">
              <span>Search by symbol or name</span>
              <input
                ref={securityInputRef}
                type="text"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={searchPending}>
              {searchPending ? "Searching…" : "Search"}
            </button>
          </form>
          {searchPending ? <p role="status">Searching…</p> : null}
          {!searchPending && searchResults.length > 0 ? (
            <ul>
              {searchResults.map((candidate) => (
                <li key={`${candidate.symbol}-${candidate.exchangeId ?? ""}`}>
                  <span>
                    <strong>{candidate.symbol}</strong>
                    <span>
                      {candidate.name}
                      {candidate.exchangeId ? ` · ${candidate.exchangeId}` : ""}
                      {candidate.currencyCode
                        ? ` · ${candidate.currencyCode}`
                        : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void addSecurity(candidate)}
                    disabled={mutationsDisabled}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {addMode === "currency" ? (
        <section
          className="quote-history watchlist-add-panel"
          aria-labelledby="watchlist-add-currency-title"
        >
          <div className="quote-history-heading">
            <h2 id="watchlist-add-currency-title">Add a currency pair</h2>
            <button
              type="button"
              onClick={() => setAddMode(null)}
              aria-label="Close add a currency pair"
            >
              Close
            </button>
          </div>
          {/* UI-045: two compact 3-character code fields and the Add
              button sit on ONE row (wrapping only when the viewport cannot
              hold them), matching the page's dense row/table rhythm rather
              than the full-width stacked form this used to render. */}
          <form
            className="watchlist-add-form"
            onSubmit={(event) => void addCurrencyPair(event)}
          >
            <label className="watchlist-add-field">
              <span>Base</span>
              <input
                ref={currencyInputRef}
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={3}
                placeholder="AUD"
                value={baseCurrencyCode}
                onChange={(event) =>
                  setBaseCurrencyCode(event.target.value.toUpperCase())
                }
                required
              />
            </label>
            <label className="watchlist-add-field">
              <span>Quote</span>
              <input
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={3}
                placeholder="USD"
                value={quoteCurrencyCode}
                onChange={(event) =>
                  setQuoteCurrencyCode(event.target.value.toUpperCase())
                }
                required
              />
            </label>
            <button type="submit" disabled={mutationsDisabled}>
              Add
            </button>
          </form>
        </section>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title="No watch entries yet"
          message="Add a stock or a currency pair to start watching it -- this never creates a holding."
        />
      ) : (
        <>
          <div className="quotes-grid table-heading sticky-heading">
            <SortButton
              label="Ticker"
              sortKey="ticker"
              activeKey={sortKey}
              direction={direction}
              onSort={handleSort}
            />
            <SortButton
              label="Last price"
              sortKey="price"
              activeKey={sortKey}
              direction={direction}
              onSort={handleSort}
            />
            <SortButton
              label="Change"
              sortKey="change"
              activeKey={sortKey}
              direction={direction}
              onSort={handleSort}
            />
          </div>
          {/* B1: column sorting is an OPT-IN view over the stored order --
              this control is the only way back to it once a column has
              been clicked, since Move up/down are disabled for the
              duration (see moveDisabledTitle below). */}
          {!customOrderActive ? (
            <p className="data-explanation">
              Sorted by column -- reordering is disabled while a column sort is
              active.{" "}
              <button
                type="button"
                onClick={() => setSortKey(null)}
                disabled={mutationsDisabled}
              >
                Show stored order
              </button>
            </p>
          ) : null}
          {sortedRows.map((row) => {
            const unavailable = row.state === "unavailable";
            const explanationId = `watchlist-explanation-${row.entryId}`;
            const storedIndex = storedIndexByEntryId.get(row.entryId) ?? 0;
            return (
              <div
                key={row.entryId}
                className="quote-row quotes-grid"
                role="group"
                aria-label={`${row.symbol} watch entry`}
                aria-describedby={explanationId}
              >
                <span className="row-primary symbol">{row.symbol}</span>
                <span className="row-primary numeric">
                  {unavailable ? "unavailable" : row.price}
                </span>
                <ToneValue
                  tone={unavailable ? "neutral" : row.tone}
                  className="row-primary numeric"
                >
                  {unavailable ? "—" : row.change}
                </ToneValue>
                <span className="row-secondary ellipsis">{row.name}</span>
                <span className="row-secondary numeric">{row.timeLine}</span>
                <ToneValue
                  tone={
                    unavailable || row.state === "stale" ? "neutral" : row.tone
                  }
                  className="row-secondary numeric"
                >
                  {unavailable ? "—" : row.percent}
                </ToneValue>
                <div className="watchlist-row-actions quote-action-buttons">
                  <button
                    type="button"
                    onClick={() => void moveEntry(row, -1)}
                    disabled={
                      mutationsDisabled ||
                      !customOrderActive ||
                      storedIndex === 0
                    }
                    title={moveDisabledTitle}
                    aria-label={`Move ${row.symbol} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveEntry(row, 1)}
                    disabled={
                      mutationsDisabled ||
                      !customOrderActive ||
                      storedIndex === rows.length - 1
                    }
                    title={moveDisabledTitle}
                    aria-label={`Move ${row.symbol} down`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeEntry(row)}
                    disabled={mutationsDisabled}
                    aria-label={`Remove ${row.symbol} from your watchlist`}
                  >
                    Remove
                  </button>
                </div>
                <span id={explanationId} className="visually-hidden">
                  {watchlistExplanation(row)}
                </span>
              </div>
            );
          })}
          {viewState === "provider-error" &&
          rows.some((row) => row.state !== "unavailable") ? (
            <p className="data-explanation">
              Last known observations remain visible. Exact source and
              observation times are available in the row explanation, not
              repeated here.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function OwnedWorkspaceScreen({
  activeSection,
  workspace,
  onCreatePortfolio,
  createPortfolioDisabled,
  isOnline,
}: {
  activeSection: PortfolioSection;
  workspace: OwnedWorkspace;
  // UI-021 (owner-reported): every section's empty state offered no way out when no
  // portfolio exists yet -- this is the SAME create-portfolio dialog the
  // header dropdown's "Create portfolio" item opens (see
  // `portfolioDialogOpenerRef`'s header note), never a second dialog.
  onCreatePortfolio: (event: MouseEvent<HTMLButtonElement>) => void;
  // Review B1: mirrors every other mutating control's
  // `actionPending || !isOnline` gate -- that state lives in the enclosing
  // `PortfolioShell`, not here, so it is passed down rather than
  // re-derived.
  createPortfolioDisabled: boolean;
  // WLT-001: threaded to `OwnedWatchlistScreen`'s own mutation gate (its
  // `actionPending` is local, unlike `createPortfolioDisabled` above which
  // reuses the shell's).
  isOnline: boolean;
}) {
  if (workspace.status === "unavailable") {
    return (
      <>
        <section
          className="empty-state"
          aria-labelledby="workspace-error-title"
        >
          <p className="eyebrow">Private workspace</p>
          <h1 id="workspace-error-title">Portfolio data unavailable</h1>
          <p>{workspace.message ?? "Try again shortly."}</p>
        </section>
        {workspace.lifecycle === "purged" ? (
          <section
            className="empty-state"
            aria-labelledby="lifecycle-purged-title"
          >
            <p className="eyebrow">Account lifecycle</p>
            <h2 id="lifecycle-purged-title">Account purged</h2>
            <p>
              This account has been verifiably purged. Financial ledger facts
              and portfolio details are permanently deleted.
            </p>
          </section>
        ) : workspace.lifecycle === "disabled" ||
          workspace.lifecycle === "deletion_pending" ? (
          <AccountLifecycleRecovery lifecycle={workspace.lifecycle} />
        ) : null}
      </>
    );
  }

  if (workspace.status === "empty" || workspace.activePortfolio === null) {
    // UI-025: News is the one tab that has real content with no portfolio
    // at all -- see OwnedNewsScreen's comment. WLT-001 (owner ruling,
    // 2026-08-22): the watchlist is the SECOND such tab -- it is USER-scoped
    // (see `app/owned-watchlist.ts`), not portfolio-scoped, so a brand-new
    // owner with zero portfolios can still build one. Every other tab keeps
    // the UI-021 "No portfolios yet" panel and its create-portfolio action.
    if (activeSection === "news") {
      return (
        <>
          <OwnedNewsScreen />
          <AccountLifecycleControls />
        </>
      );
    }
    if (activeSection === "quotes") {
      return (
        <>
          <OwnedWatchlistScreen
            rows={workspace.quotes ?? []}
            viewState={workspace.quoteViewState ?? "empty"}
            isOnline={isOnline}
          />
          <AccountLifecycleControls />
        </>
      );
    }
    return (
      <>
        <EmptyState
          title="No portfolios yet"
          message="Create a portfolio to begin tracking holdings and history."
          action={{
            label: "Create a new portfolio",
            onClick: onCreatePortfolio,
            disabled: createPortfolioDisabled,
          }}
        />
        <AccountLifecycleControls />
      </>
    );
  }

  // UI-025: with an active portfolio, News also renders the real embed
  // instead of falling through to the generic per-section empty state below
  // (the "News is not connected yet" placeholder this replaces). WLT-001:
  // the watchlist does the same -- it renders in EVERY "ready" state too,
  // never the generic per-section empty panel below.
  if (activeSection === "news") {
    return <OwnedNewsScreen />;
  }
  if (activeSection === "quotes") {
    return (
      <OwnedWatchlistScreen
        rows={workspace.quotes ?? []}
        viewState={workspace.quoteViewState ?? "empty"}
        isOnline={isOnline}
      />
    );
  }

  // UI-025 review (fold), extended by WLT-001: "news" and "quotes" are both
  // excluded from these records' key type -- the early returns above mean
  // this generic per-section empty branch never actually receives either
  // section, so there is no longer a real string to write for them.
  // Narrowing the type (rather than keeping now-unreachable entries only to
  // satisfy Record<PortfolioSection, string>) means TypeScript itself -- not
  // a comment -- guarantees this branch can't silently regress into showing
  // stale, false copy for either tab.
  const titles: Record<Exclude<PortfolioSection, "news" | "quotes">, string> = {
    overview: "No holdings yet",
    holdings: "No holdings yet",
    details: "No valuation history yet",
  };
  const messages: Record<
    Exclude<PortfolioSection, "news" | "quotes">,
    string
  > = {
    overview:
      "This portfolio is ready. Holdings and valuations will appear after ledger data is added.",
    holdings: "Import or add a holding when portfolio entry is available.",
    details: "Historical valuation data will appear here when available.",
  };

  return (
    <EmptyState
      title={titles[activeSection]}
      message={messages[activeSection]}
    />
  );
}

// BUG-003: delegates to the Intl/locale-data-free `date-display.ts`
// formatter -- this fed the Overview table's own `<th scope="row">` rows,
// the exact hydration mismatch the owner's browser console reported
// (server "1 June 2026" vs. browser "1 Jun 2026"); see that module's header
// comment for the full root cause.
function overviewDate(date: string) {
  return formatDayMonth(date);
}

function OverviewFact({
  label,
  value,
  signed = false,
}: {
  label: string;
  value: string | null;
  signed?: boolean;
}) {
  const unavailable = value === null;
  const negative = value?.startsWith("−") || value?.startsWith("-");
  const positive = !negative && value?.startsWith("+");
  const zero = value !== null && /(?:^| )0\.00$/.test(value);
  return (
    <div>
      <dt>{label}</dt>
      <dd
        className={
          unavailable
            ? "muted-copy"
            : negative
              ? "tone-negative"
              : positive
                ? "tone-positive"
                : ""
        }
      >
        {unavailable
          ? "Unavailable"
          : signed && !positive && !negative && !zero
            ? `+${value}`
            : value}
      </dd>
    </div>
  );
}

function OwnedOverviewScreen({
  data,
  portfolioId,
  portfolioName,
  financialYearStartMonth,
  timezone,
  nowInstant,
  portfolioValueHistory,
  holdingsSummary,
  holdingsProjectionPending,
}: {
  data: OwnedOverviewData;
  portfolioId: string;
  portfolioName: string;
  financialYearStartMonth: number;
  timezone: string;
  portfolioValueHistory: OwnedPortfolioValueHistory;
  // A full ISO-8601 instant resolved server-side when the workspace was
  // assembled (see OwnedWorkspace.nowInstant). FY is an ABSOLUTE named
  // period -- unlike the relative 1M/3M/12M cutoffs, which are safe to
  // anchor on the latest published point, "FY"/"Last FY" must anchor on
  // the real current instant. Anchoring on a history point instead would
  // mislabel the window (stale data reads as a false "current FY") and,
  // because that point's date is a bare local calendar date rather than an
  // instant, would also misclassify boundary dates in negative-offset
  // timezones (FY-001C review B1/B2). This must never be computed with
  // `new Date()`/`Date.now()` inside this client component -- it is always
  // threaded in as a prop from the server render.
  nowInstant: string;
  // UI-048 (owner-reported): the hero headline's SOURCE OF TRUTH -- the
  // same securities-only totals `app/owned-holdings-summary.ts`'s
  // `buildHoldingsSummaryFooter` already composes for the Holdings tab
  // (`app/authenticated-workspace.ts` now loads holdings for the Overview
  // read too, best-effort). Never `data.current.value` below, which stays
  // sourced from the cash-inclusive CALC-003/CALC-004 persisted snapshot
  // (CALC-005 follow-up). `undefined` means the best-effort holdings load
  // failed or there are no held securities -- the headline then reads
  // "unavailable" rather than falling back to the wrong number.
  holdingsSummary?: HoldingsSummaryFooter;
  /** BUG-017: see `OwnedWorkspace.holdingsProjectionPending`'s doc comment -- the SAME best-effort holdings read `holdingsSummary` above already came from. */
  holdingsProjectionPending?: ProjectionPendingState;
}) {
  const [range, setRange] = useState<
    "1M" | "3M" | "12M" | "FY" | "Last FY" | "All"
  >("12M");
  const currentFyResult = useMemo(
    () => currentFyWindow(nowInstant, financialYearStartMonth, timezone),
    [nowInstant, financialYearStartMonth, timezone],
  );
  const lastFyResult = useMemo(
    () => lastFyWindow(nowInstant, financialYearStartMonth, timezone),
    [nowInstant, financialYearStartMonth, timezone],
  );
  const history = useMemo(() => {
    if (range === "All") return data.history;
    if (range === "FY")
      return filterToFyToDateWindow(data.history, currentFyResult);
    if (range === "Last FY")
      return filterToClosedFyWindow(data.history, lastFyResult);
    const latest = data.history[data.history.length - 1];
    if (!latest) return [];
    const cutoffDate = subtractCalendarMonths(
      latest.date,
      range === "1M" ? 1 : range === "3M" ? 3 : 12,
    );
    return data.history.filter((point) => point.date >= cutoffDate);
  }, [data.history, range, currentFyResult, lastFyResult]);
  // The FY ranges are the only ones with a computed period change today
  // (1M/3M/12M/All show no delta of their own -- see the hero's `daily`
  // movement, which is independent of the selected range). "Last FY" is a
  // closed window, so its delta must read as change ACROSS that window,
  // never change-to-today; computing first-point-to-last-point of the
  // filtered window satisfies that for both FY ranges.
  const fyWindowChange =
    range === "FY" || range === "Last FY"
      ? windowChangeAmount(history, data.currencyCode)
      : null;
  // A genuine 0.00 change (a flat window) is a known fact, not missing
  // data -- it must render, but neutrally, not as a false "gain" (green).
  // Mirrors OverviewFact's own zero handling below.
  const fyWindowChangeIsZero =
    fyWindowChange !== null && /(?:^| )0\.00$/.test(fyWindowChange);
  const historyEyebrow =
    (range === "FY"
      ? fyRangeEyebrow("FY", currentFyResult, FY_MONTH_ABBREVIATIONS)
      : range === "Last FY"
        ? fyRangeEyebrow("Last FY", lastFyResult, FY_MONTH_ABBREVIATIONS)
        : null) ?? "Portfolio history";
  const chartHistory = useMemo(
    () => sampleOverviewChartPoints(history),
    [history],
  );
  const current = data.current;
  const partial =
    data.status === "partial" ||
    data.status === "stale" ||
    data.status === "incomplete";
  const chartSampled = chartHistory.length < history.length;
  const stateCopy = current ? overviewStateCopy(data, current) : null;
  // UI-048: the hero headline's actual value -- see this component's
  // `holdingsSummary` prop doc comment for why this is never `current.value`.
  const headlineValue = holdingsSummary?.marketValue ?? {
    status: "unavailable" as const,
    currencyCode: data.currencyCode,
    value: null,
    reason: null,
  };
  // UI-048 review (B2, BLOCKING): the movement line directly beneath the
  // headline must come from the SAME holdings read as the headline itself
  // -- `current.daily` is the published snapshot's own day-over-day change,
  // a different figure that can (and, on the account that triggered this
  // report, does) disagree with a live securities-only total. `holdings
  // Summary.dailyMovement` is `owned-holdings.ts`'s `composePortfolioDaily
  // MovementTotal`, computed from the exact same `rows` the headline's
  // `marketValue` is composed from -- no third derivation.
  const headlineDailyMovement = holdingsSummary?.dailyMovement ?? {
    status: "unavailable" as const,
    currencyCode: data.currencyCode,
    value: null,
    reason: null,
  };
  // UI-048 review round 3 (C2, BLOCKING): the SAME holdings read carries a
  // real daily percent (`owned-holdings-summary.ts`'s `buildHoldingsSummary
  // Footer` composes it from the identical `unrealisedSummary.daily` this
  // movement figure comes from) -- the hero must render it, not the
  // hardcoded "Percentage unavailable" literal that used to sit there
  // regardless of what was actually known.
  const headlineDailyPercent = holdingsSummary?.dailyPercent ?? {
    status: "unavailable" as const,
    currencyCode: "%",
    value: null,
    reason: null,
  };
  const headlineDailyTone: Tone | null =
    headlineDailyMovement.status === "available" &&
    headlineDailyMovement.value !== null
      ? ownedHoldingToneFromDecimal(headlineDailyMovement.value)
      : null;

  if (data.status === "unavailable") {
    return (
      <>
        <section
          className="empty-state"
          aria-labelledby="overview-unavailable-title"
        >
          <p className="eyebrow">Private workspace</p>
          <h1 id="overview-unavailable-title">Overview unavailable</h1>
          <p>
            Published valuation data could not be loaded. Try again shortly.
          </p>
        </section>
        {/* HIST-001: the graph is a SEPARATE, independent read from the
            "Published value" panel above (see this file's HIST-001 import
            comment) -- it renders even when the older persisted-snapshot
            pipeline is unavailable, since investigation found that
            pipeline can stay unavailable indefinitely on a real account
            while price history is fully present. */}
        <PortfolioValueChart
          history={portfolioValueHistory}
          financialYearStartMonth={financialYearStartMonth}
          timezone={timezone}
          nowInstant={nowInstant}
        />
      </>
    );
  }

  if (data.status === "empty" || current === null) {
    // UI-041 (owner directive, verbatim: "The graph in overview should be
    // moved up and replace the 'Empty State No Valuation History' which
    // should only be displayed when we don't have the full valuation
    // history"): `data` here is the CALC-003/CALC-004 persisted-snapshot
    // read (`OwnedOverviewData`) -- its "empty" status simply means that
    // pipeline has never published (CALC-005: it never runs for this
    // owner), which is unconditionally true today regardless of whether
    // real portfolio value history exists. `portfolioValueHistory` is a
    // SEPARATE, independent HIST-001 read-time derivation (see this file's
    // HIST-001 import comment) that can be genuinely populated even while
    // `data.status` is always "empty" -- the old unconditional EmptyState
    // above the chart therefore claimed "no valuation history" on screens
    // where the chart right below it was visibly showing real history, a
    // standing contradiction. The chart is now the PRIMARY element in this
    // slot; the EmptyState renders only when the chart ALSO has nothing
    // usable to show (its own `status !== "ok"` or zero plottable points),
    // so the two surfaces never disagree with each other. The underlying
    // CALC-003/CALC-004 published-snapshot machinery itself is untouched --
    // only this redundant duplicate empty shell is conditioned.
    const chartHasHistory = hasUsableHistoryPoints(
      portfolioValueHistory.status,
      portfolioValueHistory.points,
    );
    return (
      <>
        <PortfolioValueChart
          history={portfolioValueHistory}
          financialYearStartMonth={financialYearStartMonth}
          timezone={timezone}
          nowInstant={nowInstant}
        />
        {chartHasHistory ? null : (
          <EmptyState
            title="No valuation history yet"
            message="Add posted transactions and validated market observations to publish portfolio value."
          />
        )}
      </>
    );
  }

  return (
    <div className="overview-screen owned-overview">
      {/* UI-048 (owner ruling): the visible "Known value" / "Stale coverage"
          box is removed -- it explained coverage of the CALC-003/CALC-004
          persisted-snapshot read below (`data`/`current`), which no longer
          drives the headline OR the movement line beside it (see
          `headlineValue`/`headlineDailyMovement` above -- review B2: both
          now come from the same live holdings read, so a stale/partial
          SNAPSHOT no longer silently narrates a LIVE number). It still
          genuinely describes the KPI facts below (Securities/Cash/
          Unrealised/Cost/Realised, still snapshot-sourced), so the text
          stays reachable to a screen-reader user rather than being deleted
          outright -- sr-only, never a visible box, per the owner's
          report. */}
      {stateCopy ? (
        <p className="sr-only" role="status">
          <strong>
            {data.status === "stale"
              ? "Stale coverage"
              : data.status === "incomplete" && current?.value === null
                ? "Value unavailable"
                : "Known value"}
          </strong>
          <span> -- {stateCopy}</span>
        </p>
      ) : null}
      {/* BUG-017: honest, VISIBLE (non-color) disclosure -- unlike the
          sr-only box above, this headline figure genuinely can be stale
          relative to the ledger (see `holdingsProjectionPending`'s doc
          comment), so it must be visible, not screen-reader-only. */}
      {holdingsProjectionPending?.pending ? (
        <p className="unavailable" role="status">
          {holdingsProjectionPending.reason === "failed"
            ? "The last recalculation failed — figures reflect the previous successful calculation."
            : "Recalculating after your latest ledger change — figures may not yet reflect it."}
        </p>
      ) : null}
      <section className="overview-hero" aria-labelledby="owned-overview-title">
        <div>
          <p className="eyebrow">
            {portfolioName} · {data.currencyCode}
          </p>
          <h1 id="owned-overview-title">
            {/* UI-048 review (minor 1): a headline-appropriate phrase, not
                `ownedHoldingAmountWhole`'s bare lowercase "unavailable" --
                this IS the page's accessible name (`aria-labelledby`
                everything else in the hero points at). */}
            {headlineValue.status === "available" &&
            headlineValue.value !== null
              ? ownedHoldingAmountWhole(data.currencyCode, headlineValue)
              : "Value unavailable"}
            <PartialMarker text={holdingsSummary?.valueQualifier ?? null} />
          </h1>
          {/* UI-048 review round 3: no "as of ..." span here -- option 1
              (reviewer's preferred call). `marketValue`/`dailyMovement` sum
              each row's `homeValue`/`dailyMovement`, and a row's own
              `priceState` can be stale/fallback (a days-old close); the
              hero has no aggregate freshness read to disclose honestly, so
              it makes no timestamp claim instead of a false "now" (deleted
              outright, not relabelled -- a freshness aggregation is a
              recorded follow-up, out of scope here). The movement text's
              own "today" already states what it can back: today's change,
              not a batch date. */}
          <p className="overview-movement">
            <span
              className={
                headlineDailyTone === null
                  ? "muted-copy"
                  : `tone-${headlineDailyTone}`
              }
            >
              {headlineDailyTone === null
                ? "Daily movement unavailable"
                : ownedHoldingAmount(
                    data.currencyCode,
                    headlineDailyMovement,
                    2,
                    true,
                  )}
              {/* UI-048 review round 3 (C1, BLOCKING): the Holdings tab
                  reaches this same field's qualifier right after the
                  amount (`summary.dailyQualifier`, above) -- reused here
                  verbatim rather than silently dropped. Self-guards on
                  `null` (nothing excluded), so this is safe to render
                  unconditionally. */}
              <PartialMarker text={holdingsSummary?.dailyQualifier ?? null} />
              {headlineDailyTone === null ? null : (
                <>
                  {" today · "}
                  {/* UI-048 review round 3 (C2, BLOCKING): the SAME read
                      carries a real percent -- rendering it honestly
                      replaces the hardcoded "Percentage unavailable" that
                      used to sit here regardless of what was actually
                      known. `ownedHoldingPercent` itself falls back to
                      that exact honest text for the genuinely-null case
                      (e.g. a zero previous value). */}
                  {ownedHoldingPercent(headlineDailyPercent, true)}
                </>
              )}
            </span>
          </p>
        </div>
        <dl className="overview-kpis">
          <OverviewFact label="Securities" value={current.securities} />
          <OverviewFact label="Cash" value={current.cash} />
          <OverviewFact
            label={partial ? "Known unrealised" : "Unrealised"}
            value={current.unrealised}
            signed
          />
          <OverviewFact label="Cost" value={current.cost} />
          <OverviewFact label="Realised" value={current.realised} signed />
        </dl>
      </section>

      {/* UI-048: this wrapper is the grid item `.overview-screen` places --
          NOT the chart's own `.history-panel` section inside it, which the
          desktop 2-column grid pins to the narrower left column (shared
          with the "Published value" section below). Full-width per owner
          report ("the graph need to go back to being full width"). */}
      <div className="overview-chart-full">
        <PortfolioValueChart
          history={portfolioValueHistory}
          financialYearStartMonth={financialYearStartMonth}
          timezone={timezone}
          nowInstant={nowInstant}
        />
      </div>

      <section className="history-panel" aria-labelledby="owned-history-title">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">{historyEyebrow}</p>
            <h2 id="owned-history-title">Published value</h2>
            {range === "FY" || range === "Last FY" ? (
              <p className="overview-movement">
                <span
                  className={
                    fyWindowChange === null
                      ? "muted-copy"
                      : fyWindowChangeIsZero
                        ? ""
                        : fyWindowChange.startsWith("−")
                          ? "tone-negative"
                          : "tone-positive"
                  }
                >
                  {fyWindowChange === null
                    ? "Change unavailable"
                    : `${fyWindowChange} ${
                        range === "Last FY" ? "across the window" : "this FY"
                      } · Percentage unavailable`}
                </span>
              </p>
            ) : null}
          </div>
          <div className="range-controls" aria-label="History range">
            {(["1M", "3M", "12M", "FY", "Last FY", "All"] as const).map(
              (option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={range === option}
                  onClick={() => setRange(option)}
                >
                  {option}
                </button>
              ),
            )}
          </div>
        </div>
        <div
          className="history-bars"
          role="img"
          aria-label={`Published portfolio value history; ${history.length} daily points. ${chartSampled ? "Visual bars are bounded and gap markers are representative when needed; the table below contains every point." : "All points are shown."}`}
        >
          {chartHistory.map((point) => (
            <span
              key={point.date}
              className={
                point.valueDecimal === null
                  ? "history-gap"
                  : point.completeness !== "complete"
                    ? "history-partial"
                    : undefined
              }
              style={{ "--bar-height": point.barHeight } as React.CSSProperties}
              title={`${overviewDate(point.date)}: ${point.value ?? "Unavailable"}`}
            />
          ))}
        </div>
        <p className="chart-coverage">
          {history.length === 0
            ? "No published points in this range."
            : `${history.length} published daily point${history.length === 1 ? "" : "s"}; incomplete dates remain marked in the table.${chartSampled ? " Visual gap markers are representative; use the table for the complete gap record." : ""}`}
        </p>
        <details className="chart-table-details">
          <summary>View history as a table</summary>
          <table>
            <caption>Published portfolio value history</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Value</th>
                <th scope="col">Daily</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {history.map((point) => (
                <tr key={`${point.date}-row`}>
                  <th scope="row">{overviewDate(point.date)}</th>
                  <td>{point.value ?? "Unavailable"}</td>
                  <td>
                    {point.daily ?? "Unavailable"} (Percentage unavailable)
                  </td>
                  <td>{point.completeness}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section
        className="portfolio-list overview-coverage"
        aria-labelledby="overview-coverage-title"
      >
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Coverage</p>
            <h2 id="overview-coverage-title">What is included</h2>
          </div>
        </div>
        <dl className="overview-kpis">
          <OverviewFact
            label="Priced holdings"
            value={
              data.coverage.pricedHoldingCount === null
                ? null
                : `${data.coverage.pricedHoldingCount} / ${data.coverage.nonZeroHoldingCount ?? "—"} non-zero`
            }
          />
          <OverviewFact
            label="Converted cash"
            value={
              data.coverage.convertedCashAccountCount === null
                ? null
                : `${data.coverage.convertedCashAccountCount} / ${data.coverage.nonZeroCashAccountCount ?? "—"} non-zero`
            }
          />
        </dl>
        <section
          className="allocation-summary"
          aria-labelledby="allocation-title"
        >
          <h3 id="allocation-title">Allocation of valued securities</h3>
          {data.allocation.status === "unavailable" ? (
            <p className="muted-copy">
              Allocation unavailable until current holding valuation facts are
              published.
            </p>
          ) : (
            <ul>
              {data.allocation.rows.map((row) => (
                <li key={row.id}>
                  <span>{row.label}</span>
                  <span>{row.percent ?? "Unavailable"}</span>
                </li>
              ))}
            </ul>
          )}
          {data.allocation.status === "partial" ? (
            <p className="muted-copy">
              Partial allocation: unavailable holdings are excluded.
            </p>
          ) : null}
        </section>
        <p className="muted-copy">Income is not included in this release.</p>
        <details className="overview-drilldown">
          <summary>Coverage and formula details</summary>
          <p>
            Known formula: {current.securities ?? "Unavailable"} securities +{" "}
            {current.cash ?? "Unavailable"} cash ={" "}
            {overviewFormulaTotal(current)}
          </p>
          <dl>
            <div>
              <dt>Priced holdings</dt>
              <dd>
                {data.coverage.pricedHoldingCount ?? "Unavailable"} /{" "}
                {data.coverage.nonZeroHoldingCount ?? "Unavailable"} non-zero
              </dd>
            </div>
            <div>
              <dt>Holding snapshots</dt>
              <dd>{data.coverage.totalHoldingCount ?? "Unavailable"} total</dd>
            </div>
            <div>
              <dt>Converted cash</dt>
              <dd>
                {data.coverage.convertedCashAccountCount ?? "Unavailable"} /{" "}
                {data.coverage.nonZeroCashAccountCount ?? "Unavailable"}{" "}
                non-zero
              </dd>
            </div>
          </dl>
          <h3>
            {data.coverage.issues.length > 0
              ? "Coverage limitations"
              : "Excluded components"}
          </h3>
          {data.coverage.issues.length === 0 ? (
            <p>No exclusions or limitations recorded.</p>
          ) : (
            <ul>
              {data.coverage.issues.map((item) => (
                <li key={`${item.id}-${item.reason}`}>
                  {item.id}: {item.reason}
                </li>
              ))}
            </ul>
          )}
          <h3>Market state explanations</h3>
          {data.coverage.marketDataStates.length === 0 ? (
            <p>No market-data exceptions recorded.</p>
          ) : (
            <ul>
              {data.coverage.marketDataStates.map((state) => (
                <li key={state.id}>
                  {state.id}: price {state.price}, FX {state.fx}, calendar{" "}
                  {state.calendar}
                </li>
              ))}
            </ul>
          )}
          {data.coverage.issues.length > 0 ? (
            <p>
              Review price, FX, and session limitations in{" "}
              <Link href={`/portfolio/${portfolioId}/quotes`}>Quotes</Link>,
              inspect calculation coverage in{" "}
              <Link href={`/portfolio/${portfolioId}/details`}>Details</Link>,
              and review history or quantity issues in the{" "}
              <Link href={`/portfolio/${portfolioId}/ledger/new`}>ledger</Link>.
            </p>
          ) : null}
        </details>
      </section>
    </div>
  );
}

function PortfolioSummary({
  portfolio,
  partial,
}: {
  portfolio: PortfolioPrototype;
  partial: boolean;
}) {
  const summary = partial
    ? {
        value: "A$1,143,903.50",
        cost: "A$865,743.12",
        dailyAmount: "+A$2,934.99",
        dailyPercent: "+0.26%",
        gainAmount: "+A$278,496.60",
        gainPercent: "+32.17%",
        allTimeAmount: "+A$293,496.60",
        allTimePercent: "+33.90%",
      }
    : portfolio;

  return (
    <aside className="portfolio-summary" aria-label="Portfolio totals">
      <div className="summary-primary">
        <span className="summary-label">
          {partial ? "Known value" : "Unrealised"}
        </span>
        <strong>{wholeDollarAmount(summary.value)}</strong>
        <ToneValue tone="positive">
          {compactAmount(wholeDollarAmount(summary.dailyAmount))}
        </ToneValue>
        <ToneValue tone="positive">
          {compactAmount(wholeDollarAmount(summary.gainAmount))}
        </ToneValue>
      </div>
      <div className="summary-secondary">
        <span aria-hidden="true" />
        <span>{wholeDollarAmount(summary.cost)}</span>
        <ToneValue tone="positive">{summary.dailyPercent}</ToneValue>
        <ToneValue tone="positive">{summary.gainPercent}</ToneValue>
      </div>
      <div className="summary-gain-lines">
        <p>
          <span>Realised</span>
          <ToneValue tone="positive">
            {wholeDollarAmount(portfolio.realisedAmount)} (
            {portfolio.realisedPercent})
          </ToneValue>
        </p>
        <p>
          <span>All-Time</span>
          <ToneValue tone="positive">
            {wholeDollarAmount(summary.allTimeAmount)} ({summary.allTimePercent}
            )
          </ToneValue>
        </p>
      </div>
    </aside>
  );
}

function SortButton<T extends string>({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
}: {
  label: string;
  sortKey: T;
  // WLT-001 review (B1): `activeKey` accepts `T | null` so a caller with an
  // opt-in "no column sort active, showing stored order" state (the
  // watchlist's default) can pass `null` and have every column render as
  // inactive -- `sortKey === activeKey` is never true for a `null`
  // `activeKey` since `T` is a non-null string union, so this widening is a
  // no-op for every other existing caller, which always passes a real `T`.
  activeKey: T | null;
  direction: Direction;
  onSort: (key: T) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={`${label}${active ? `, sorted ${direction}` : ", sort column"}`}
      aria-pressed={active}
    >
      <span>{label}</span>
      <span className={active ? "sort-arrow active" : "sort-arrow"}>
        {active && direction === "ascending" ? "↑" : "↓"}
      </span>
    </button>
  );
}

function OverviewScreen({
  portfolio,
  rows,
  historyBars,
  viewState,
  onOpenPortfolio,
}: {
  portfolio?: PortfolioPrototype;
  rows: readonly OverviewRow[];
  /** PRF-014 step 1: caller-supplied demo chart bars (previously a direct
   * module-level import of `../prototype-data`'s `historyBars`). */
  historyBars: readonly string[];
  viewState: ViewState;
  onOpenPortfolio: (id: string) => void;
}) {
  if (viewState === "empty") {
    return (
      <EmptyState
        title="No portfolios yet"
        message="Create a portfolio or preview an import. No financial actions are connected."
      />
    );
  }

  return (
    <div className="overview-screen">
      <section className="overview-hero" aria-labelledby="overview-title">
        <div>
          <p className="eyebrow">
            {portfolio
              ? `${portfolio.name} · ${portfolio.homeCurrency}`
              : "All portfolios · AUD"}
          </p>
          <h1 id="overview-title">
            {portfolio ? portfolio.value : "A$1,695,575.90"}
          </h1>
          <p className="overview-movement">
            {portfolio ? (
              <>
                <ToneValue
                  tone={
                    portfolio.dailyAmount.startsWith("−")
                      ? "negative"
                      : "positive"
                  }
                >
                  {portfolio.dailyAmount.startsWith("−")
                    ? `↓ ${portfolio.dailyAmount}`
                    : `↑ ${portfolio.dailyAmount}`}
                </ToneValue>
                <span>today · {portfolio.dailyPercent}</span>
              </>
            ) : (
              <>
                <ToneValue tone="positive">↑ A$5,359.64</ToneValue>
                <span>today · +0.32%</span>
              </>
            )}
          </p>
        </div>
        <dl className="overview-kpis">
          <div>
            <dt>Invested</dt>
            <dd>{portfolio ? portfolio.cost : "A$1,592,846.40"}</dd>
          </div>
          <div>
            <dt>Cash</dt>
            <dd>{portfolio ? portfolio.cash : "A$103,379.45"}</dd>
          </div>
          <div>
            <dt>Unrealised</dt>
            <dd
              className={
                portfolio?.gainAmount.startsWith("−")
                  ? "tone-negative"
                  : "tone-positive"
              }
            >
              {portfolio ? portfolio.gainAmount : "+A$339,465.78"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="history-panel" aria-labelledby="history-title">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Portfolio history</p>
            <h2 id="history-title">Value over 12 months</h2>
          </div>
          <ToneValue tone="positive">+18.42%</ToneValue>
        </div>
        <div
          className="history-bars"
          role="img"
          aria-label="Portfolio value rose from approximately A$1.37 million to A$1.70 million over twelve months, with several short declines."
        >
          {historyBars.map((height, index) => (
            <span
              key={`${height}-${index}`}
              style={{ "--bar-height": height } as React.CSSProperties}
            />
          ))}
        </div>
        <div className="chart-axis" aria-hidden="true">
          <span>Aug</span>
          <span>Jan</span>
          <span>Jul</span>
        </div>
      </section>

      <section className="portfolio-list" aria-labelledby="portfolios-title">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Breakdown</p>
            <h2 id="portfolios-title">Portfolios</h2>
          </div>
          <span className="muted-copy">2 invested · 1 watchlist</span>
        </div>
        <div className="overview-grid table-heading" aria-hidden="true">
          <span>Name</span>
          <span>Value / cost</span>
          <span>Daily</span>
          <span>Total</span>
        </div>
        {rows.map((row) => (
          <button
            className="portfolio-row overview-grid"
            type="button"
            key={row.id}
            onClick={() => onOpenPortfolio(row.id)}
          >
            <span className="row-primary">{row.name}</span>
            <span className="row-primary numeric">{row.value}</span>
            <ToneValue tone={row.tone} className="row-primary numeric">
              {compactAmount(row.daily)}
            </ToneValue>
            <ToneValue tone={row.tone} className="row-primary numeric">
              {compactAmount(row.total)}
            </ToneValue>
            <span className="row-secondary">{row.holdings}</span>
            <span className="row-secondary numeric">{row.cost}</span>
            <ToneValue tone={row.tone} className="row-secondary numeric">
              {row.dailyPercent}
            </ToneValue>
            <ToneValue tone={row.tone} className="row-secondary numeric">
              {row.totalPercent}
            </ToneValue>
          </button>
        ))}
      </section>
    </div>
  );
}

function HoldingsScreen({
  portfolio,
  viewState,
  onSelectHolding,
  holdingDetailHref,
}: {
  portfolio: PortfolioPrototype;
  viewState: ViewState;
  onSelectHolding: (holding: Holding, unavailable: boolean) => void;
  holdingDetailHref?: (symbol: string) => string;
}) {
  const [sortKey, setSortKey] = useState<HoldingSort>("daily");
  const [direction, setDirection] = useState<Direction>("descending");

  const rows = useMemo(() => {
    if (sortKey === "ticker") {
      return [...portfolio.holdings].sort((left, right) => {
        const compared = left.symbol.localeCompare(right.symbol);
        return direction === "ascending" ? compared : -compared;
      });
    }
    return sortByExactKey(
      portfolio.holdings,
      (holding) => holding.sort[sortKey],
      direction,
    );
  }, [direction, portfolio.holdings, sortKey]);

  function handleSort(nextKey: HoldingSort) {
    if (nextKey === sortKey) {
      setDirection((current) =>
        current === "ascending" ? "descending" : "ascending",
      );
      return;
    }
    setSortKey(nextKey);
    setDirection(nextKey === "ticker" ? "ascending" : "descending");
  }

  if (viewState === "empty" || rows.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="holdings-layout">
      <section className="holdings-list" aria-label="Portfolio holdings">
        <div className="holdings-grid table-heading sticky-heading">
          <SortButton
            label="Ticker"
            sortKey="ticker"
            activeKey={sortKey}
            direction={direction}
            onSort={handleSort}
          />
          <SortButton
            label="Value / cost"
            sortKey="value"
            activeKey={sortKey}
            direction={direction}
            onSort={handleSort}
          />
          <SortButton
            label="Daily"
            sortKey="daily"
            activeKey={sortKey}
            direction={direction}
            onSort={handleSort}
          />
          <SortButton
            label="Total"
            sortKey="total"
            activeKey={sortKey}
            direction={direction}
            onSort={handleSort}
          />
        </div>
        <div className="holding-rows">
          {rows.map((holding, index) => {
            const priceUnavailable =
              viewState === "partial" && index === rows.length - 1;
            const rowContent = (
              <>
                <span className="row-primary symbol">{holding.symbol}</span>
                <span className="row-primary numeric">
                  {priceUnavailable ? "—" : holding.value}
                </span>
                {priceUnavailable ? (
                  <span className="row-primary numeric unavailable">
                    unavailable
                  </span>
                ) : (
                  <ToneValue
                    tone={holding.dailyTone}
                    className="row-primary numeric"
                  >
                    {compactAmount(holding.dailyAmount)}
                  </ToneValue>
                )}
                {priceUnavailable ? (
                  <span className="row-primary numeric unavailable">—</span>
                ) : (
                  <ToneValue
                    tone={holding.totalTone}
                    className="row-primary numeric"
                  >
                    {compactAmount(holding.totalAmount)}
                  </ToneValue>
                )}
                <span className="row-secondary">{holding.price}</span>
                <span className="row-secondary numeric">{holding.cost}</span>
                {priceUnavailable ? (
                  <span className="row-secondary numeric unavailable">—</span>
                ) : (
                  <ToneValue
                    tone={holding.dailyTone}
                    className="row-secondary numeric"
                  >
                    {holding.dailyPercent}
                  </ToneValue>
                )}
                {priceUnavailable ? (
                  <span className="row-secondary numeric unavailable">—</span>
                ) : (
                  <ToneValue
                    tone={holding.totalTone}
                    className="row-secondary numeric"
                  >
                    {holding.totalPercent}
                  </ToneValue>
                )}
                <span className="row-tertiary">{holding.quantityLine}</span>
                <span className="desktop-only holding-name">
                  {holding.name} · {holding.exchange} · {holding.currency}
                </span>
              </>
            );
            const detailHref = holdingDetailHref?.(holding.symbol);
            return detailHref ? (
              <Link
                className={`holding-row holdings-grid${priceUnavailable ? " unavailable-row" : ""}`}
                href={detailHref}
                key={holding.symbol}
                aria-label={`${holding.symbol}, ${holding.name}, open details`}
              >
                {rowContent}
              </Link>
            ) : (
              <button
                className={`holding-row holdings-grid${priceUnavailable ? " unavailable-row" : ""}`}
                type="button"
                key={holding.symbol}
                onClick={() => onSelectHolding(holding, priceUnavailable)}
                aria-label={`${holding.symbol}, ${holding.name}, open details`}
              >
                {rowContent}
              </button>
            );
          })}
        </div>
      </section>
      <PortfolioSummary
        portfolio={portfolio}
        partial={viewState === "partial"}
      />
    </div>
  );
}

// MKT-014: extracted from QuotesScreen's own inline "Correction history"
// panel so the owned-mode per-holding detail sheet
// (`app/components/holding-detail.tsx`, whose refresh/correction entry
// points died with the old owned QuotesScreen when WLT-001 retired it) can
// reuse the exact same fetch/revoke logic and markup instead of forking a
// second copy -- the Orchestrator's MKT-014 placement ruling requires
// reuse, not a duplicate implementation. Behaviour for the preview-mode
// QuotesScreen call site below is unchanged (still no `targetKey`, so the
// full portfolio's history loads); the new owned call site passes
// `targetKey` (the holding's `securityId` -- the same value
// `saveManualOverrideForContext` requires a price correction's `targetKey`
// to equal) to scope the list to this one holding.
export function QuoteCorrectionHistory({
  portfolioId,
  targetKey,
  readOnly,
  onClose,
  onMessage,
}: {
  portfolioId: string;
  targetKey?: string;
  readOnly: boolean;
  onClose: () => void;
  onMessage: (message: string | null) => void;
}) {
  const [historyPending, setHistoryPending] = useState(false);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      type: "price" | "fx_rate" | "security_mapping" | "transaction_fx";
      targetKey: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      reason: string;
      status: "active" | "superseded" | "revoked";
    }>
  >([]);
  // Bumped after a successful revoke to re-run the load effect below --
  // keeps the fetch logic itself inline in ONE effect (mount AND
  // post-revoke reload) instead of a second component-scope function the
  // effect would call indirectly (react-hooks/set-state-in-effect flags
  // exactly that indirection; a direct inline fetch, as `holding-price-
  // chart.tsx` also does, is the sanctioned pattern).
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (readOnly) {
      onMessage("Preview data has no correction history to display.");
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    (async () => {
      setHistoryPending(true);
      try {
        const query = new URLSearchParams({ portfolioId });
        if (targetKey) query.set("targetKey", targetKey);
        const response = await fetch(`/api/market-data/overrides?${query}`, {
          signal: controller.signal,
        });
        const result = (await response.json()) as {
          ok: boolean;
          overrides?: typeof history;
          message?: string;
        };
        if (cancelled) return;
        if (!response.ok || !result.ok)
          throw new Error(
            result.message ?? "Correction history is unavailable.",
          );
        setHistory(result.overrides ?? []);
      } catch (error) {
        if (cancelled) return;
        // A read has no retry-safety ambiguity (nothing was written), so
        // this gets its own honest wording rather than the mutation-submit
        // DIALOG_TIMEOUT_MESSAGE below.
        onMessage(
          isAbortError(error)
            ? "The request timed out. Retry when ready."
            : error instanceof Error
              ? error.message
              : "Correction history is unavailable.",
        );
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setHistoryPending(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [portfolioId, targetKey, readOnly, onMessage, reloadToken]);

  async function revokeCorrection(id: string) {
    setHistoryPending(true);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch("/api/market-data/overrides", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overrideId: id }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(
          result.message ?? "The correction could not be removed.",
        );
      onMessage(
        "Correction revoked; the underlying provider value can be selected again.",
      );
      setReloadToken((token) => token + 1);
    } catch (error) {
      // Revoke is a real mutation, not idempotently retry-safe from the
      // client's perspective -- a timed-out request may still have gone
      // through, matching every other mutation-submit convention in this
      // file.
      onMessage(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "The correction could not be removed.",
      );
      setHistoryPending(false);
    } finally {
      clearTimeout(timeout);
    }
  }

  return (
    <section className="quote-history" aria-labelledby="quote-history-title">
      <div className="quote-history-heading">
        <h2 id="quote-history-title">Correction history</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close correction history"
        >
          Close
        </button>
      </div>
      {historyPending ? <p role="status">Loading correction history…</p> : null}
      {!historyPending && history.length === 0 ? (
        <p className="muted-copy">No owner-entered corrections are recorded.</p>
      ) : null}
      <ul>
        {history.map((item) => (
          <li key={item.id}>
            <span>
              <strong>{item.type === "fx_rate" ? "FX rate" : "Price"}</strong>
              <span>
                {item.targetKey} · effective {item.effectiveFrom}
              </span>
              <span>
                {item.reason} · {item.status}
              </span>
            </span>
            {item.status === "active" && !readOnly ? (
              <button
                type="button"
                onClick={() => void revokeCorrection(item.id)}
                disabled={historyPending}
              >
                Revoke
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuotesScreen({
  portfolio,
  ownedQuotes,
  viewState,
  portfolioId,
  readOnly,
}: {
  portfolio: PortfolioPrototype | null;
  ownedQuotes?: QuoteRow[];
  viewState: ViewState;
  portfolioId: string;
  readOnly: boolean;
}) {
  const [sortKey, setSortKey] = useState<QuoteSort>("change");
  const [direction, setDirection] = useState<Direction>("descending");
  const [refreshState, setRefreshState] = useState<
    "idle" | "pending" | "queued" | "failed"
  >("idle");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const correctionButtonRef = useRef<HTMLButtonElement>(null);
  const correctionOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  // UI-007: mirrors the portfolio-dialog / drawer opener-restore pattern.
  // `correctionOpenerRef` only holds a value once the dialog has actually
  // been opened (set in the button's onClick below), so this effect can't
  // steal focus on initial mount. The "Correct a quote" button is a static,
  // always-rendered control (not inside a popover that unmounts), so it is
  // guaranteed to still be in the DOM when the dialog closes.
  useEffect(() => {
    if (!correctionOpen && correctionOpenerRef.current) {
      correctionOpenerRef.current.focus();
      correctionOpenerRef.current = null;
    }
  }, [correctionOpen]);

  // MKT-014 (F6): the "Correction history" panel gets the SAME
  // opener-restore treatment as the correction dialog above -- Close
  // shouldn't drop focus to <body>.
  useEffect(() => {
    if (!historyOpen && historyOpenerRef.current) {
      historyOpenerRef.current.focus();
      historyOpenerRef.current = null;
    }
  }, [historyOpen]);

  const quoteRows = useMemo<QuoteRow[]>(() => {
    if (ownedQuotes) return ownedQuotes;
    const previewQuotes = portfolio?.quotes ?? [];
    const unavailableSymbol =
      viewState === "partial"
        ? previewQuotes[previewQuotes.length - 1]?.symbol
        : undefined;
    return previewQuotes.map((quote) => {
      const state = quoteDisplayState(
        viewState === "provider-error" ? "stale" : "current",
        quote.symbol !== unavailableSymbol,
      );
      return {
        targetKey: quote.symbol,
        portfolioSecurityId: quote.symbol,
        securityId: quote.symbol,
        symbol: quote.symbol,
        name: quote.name,
        currencyCode: "AUD",
        price: quote.price,
        change: quote.change,
        percent: quote.percent,
        tone: quote.tone,
        marketDate: quote.marketDate,
        state,
        provenance: {
          source: "provider",
          providerId: "fixture-provider",
          observationAt: null,
          delayedMinutes: 20,
          scope: "deployment",
          quality: state === "stale" ? "stale_candidate" : "observed",
          fallbackReason:
            state === "unavailable"
              ? "No validated fixture observation is available."
              : "Static review fixture selected.",
        },
        sort: quote.sort,
      };
    });
  }, [ownedQuotes, portfolio?.quotes, viewState]);

  const rows = useMemo(() => {
    if (sortKey === "ticker") {
      return [...quoteRows].sort((left, right) => {
        const compared = left.symbol.localeCompare(right.symbol);
        return direction === "ascending" ? compared : -compared;
      });
    }
    return sortByExactKey(quoteRows, (quote) => quote.sort[sortKey], direction);
  }, [direction, quoteRows, sortKey]);

  function handleSort(nextKey: QuoteSort) {
    if (nextKey === sortKey) {
      setDirection((current) =>
        current === "ascending" ? "descending" : "ascending",
      );
      return;
    }
    setSortKey(nextKey);
    setDirection(nextKey === "ticker" ? "ascending" : "descending");
  }

  async function requestRefresh() {
    setActionMessage(null);
    if (readOnly) {
      setActionMessage(
        "Preview quotes are read-only; no refresh was requested.",
      );
      return;
    }
    setRefreshState("pending");
    try {
      const response = await fetch("/api/market-data/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portfolioId }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        jobs?: Array<{ id: string }>;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Refresh could not be queued.");
      if (!result.jobs?.length) {
        setRefreshState("idle");
        setActionMessage(
          "No verified quote targets are available; no refresh was queued.",
        );
        return;
      }
      setRefreshState("queued");
      setActionMessage(
        "Refresh queued. Existing values remain displayed until validated observations are written.",
      );
    } catch (error) {
      setRefreshState("failed");
      setActionMessage(
        error instanceof Error ? error.message : "Refresh could not be queued.",
      );
    }
  }

  return (
    <section className="quotes-screen" aria-label="Portfolio quotes">
      <div className="quote-actions" aria-label="Quote actions">
        <p className="data-explanation">
          Validated observations are preferred. EOD and manual values remain
          explicit fallbacks; no quote is presented as live.
        </p>
        <div className="quote-action-buttons">
          <button
            type="button"
            onClick={() => void requestRefresh()}
            disabled={refreshState === "pending"}
          >
            {refreshState === "pending" ? "Queueing…" : "Refresh quotes"}
          </button>
          <button
            ref={correctionButtonRef}
            type="button"
            onClick={() => {
              correctionOpenerRef.current = correctionButtonRef.current;
              setCorrectionOpen(true);
            }}
          >
            Correct a quote
          </button>
          <button
            ref={historyButtonRef}
            type="button"
            onClick={() => {
              historyOpenerRef.current = historyButtonRef.current;
              setHistoryOpen(true);
            }}
          >
            Correction history
          </button>
        </div>
        {refreshState === "queued" ? (
          <p className="quote-action-status" role="status" aria-live="polite">
            Refresh queued; current values are unchanged until the job
            completes.
          </p>
        ) : null}
        {/* UI-007: while the correction dialog is open, everything outside it
            is inert behind the native top-layer backdrop, so this outside
            status line would be neither visible nor announced -- mirrors the
            portfolio-dialog B2 fix. The dialog renders its own failures
            in-dialog; this toast still carries non-dialog messages (refresh,
            history) and success messages that land after the dialog closes. */}
        {actionMessage && !correctionOpen ? (
          <p className="quote-action-status" role="alert">
            {actionMessage}
          </p>
        ) : null}
      </div>
      {historyOpen ? (
        <QuoteCorrectionHistory
          portfolioId={portfolioId}
          readOnly={readOnly}
          onClose={() => setHistoryOpen(false)}
          onMessage={setActionMessage}
        />
      ) : null}
      {viewState === "empty" ? (
        <EmptyState
          title="No quotes yet"
          message="Add securities to watch without creating a holding."
        />
      ) : (
        <>
          <div className="quotes-grid table-heading sticky-heading">
            <SortButton
              label="Ticker"
              sortKey="ticker"
              activeKey={sortKey}
              direction={direction}
              onSort={handleSort}
            />
            <SortButton
              label="Last price"
              sortKey="price"
              activeKey={sortKey}
              direction={direction}
              onSort={handleSort}
            />
            <SortButton
              label="Change"
              sortKey="change"
              activeKey={sortKey}
              direction={direction}
              onSort={handleSort}
            />
          </div>
          {rows.map((quote) => {
            const state = quote.state;
            const unavailable = state === "unavailable";
            const explanationId = `quote-explanation-${quote.symbol.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return (
              <button
                className="quote-row quotes-grid"
                type="button"
                key={quote.symbol}
                aria-describedby={explanationId}
              >
                <span className="row-primary symbol">{quote.symbol}</span>
                <span className="row-primary numeric">
                  {unavailable ? "unavailable" : quote.price}
                </span>
                <ToneValue
                  tone={unavailable ? "neutral" : quote.tone}
                  className="row-primary numeric"
                >
                  {unavailable ? "—" : quote.change}
                </ToneValue>
                <span className="row-secondary ellipsis">{quote.name}</span>
                <span className="row-secondary numeric">
                  {quote.marketDate}
                </span>
                <ToneValue
                  tone={
                    unavailable || state === "stale" ? "neutral" : quote.tone
                  }
                  className="row-secondary numeric"
                >
                  {unavailable ? "—" : quote.percent}
                </ToneValue>
                <span id={explanationId} className="visually-hidden">
                  {quoteExplanation(quote)}
                </span>
              </button>
            );
          })}
          {viewState === "provider-error" &&
          rows.some((quote) => quote.state !== "unavailable") ? (
            <p className="data-explanation">
              Last known observations remain visible. Exact source and
              observation times are available in the row explanation, not
              repeated here.
            </p>
          ) : null}
        </>
      )}
      {correctionOpen ? (
        <QuoteCorrectionDialog
          portfolioId={portfolioId}
          quoteTargets={rows}
          portfolioBaseCurrency={
            portfolio?.homeCurrency ?? rows[0]?.currencyCode ?? "AUD"
          }
          readOnly={readOnly}
          onClose={() => setCorrectionOpen(false)}
          onMessage={setActionMessage}
        />
      ) : null}
    </section>
  );
}

export function QuoteCorrectionDialog({
  portfolioId,
  quoteTargets,
  portfolioBaseCurrency,
  readOnly,
  onClose,
  onMessage,
}: {
  portfolioId: string;
  quoteTargets: QuoteRow[];
  portfolioBaseCurrency: string;
  readOnly: boolean;
  onClose: () => void;
  onMessage: (message: string | null) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState<"price" | "fx_rate">("price");
  const [pending, setPending] = useState(false);
  // UI-007: failures must render INSIDE the dialog (dividend-assumptions-
  // editor pattern) -- once the dialog is a real showModal() top-layer
  // modal, the QuotesScreen's outside toast is inert/unannounced behind it
  // (the exact Blocking-2 finding from the portfolio-dialog fix). A success
  // message still goes through `onMessage` into that outside toast, because
  // it is only shown once the dialog has already closed.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const fxTargetKeys = [
    ...new Set(quoteTargets.map((quote) => quote.currencyCode)),
  ]
    .filter((currency) => currency !== portfolioBaseCurrency)
    .map((currency) => `${currency}/${portfolioBaseCurrency}`);
  const [selectedTargetKey, setSelectedTargetKey] = useState(
    quoteTargets[0]?.targetKey ?? "",
  );
  const [selectedFxBase = "", selectedFxQuote = ""] =
    selectedTargetKey.split("/");

  // UI-007: mirrors the portfolio-dialog ref + showModal() pattern (the old
  // bug: a bare `<dialog open>` renders as inert, non-modal content below
  // the fold, with no ::backdrop). This component only exists in the tree
  // while QuotesScreen's `correctionOpen` is true, so "mount" doubles as
  // "open": showModal() the first time the node exists, and defensively
  // close() the captured element on unmount if it is somehow still open
  // (e.g. a future caller unmounts this without routing through onClose).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      // HTMLElement, not HTMLSelectElement: worker-configuration.d.ts's
      // ambient global `Element` (Cloudflare's HTMLRewriter type, whose
      // `remove()` returns `Element`) merges with lib.dom's `Element` and
      // breaks HTMLSelectElement's constraint check specifically (its own
      // two-overload `remove()` no longer structurally satisfies the
      // polluted constraint); HTMLElement is unaffected and still exposes
      // .focus().
      dialog.querySelector<HTMLElement>("select")?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (readOnly) {
      setDialogError(
        "Preview data is read-only; no financial write was attempted.",
      );
      // B1 review fix: clear any stale parent toast (e.g. a prior "Correction
      // saved" from an earlier successful save in this same dialog mount) so
      // it can't keep showing a false confirmation once this in-dialog error
      // replaces it.
      onMessage(null);
      return;
    }
    const targetKey = String(form.get("targetKey") ?? "").trim();
    const [fxBaseCurrency = "", fxQuoteCurrency = ""] = targetKey.split("/");
    const selectedQuote = quoteTargets.find(
      (quote) => quote.targetKey === targetKey,
    );
    const effectiveFrom = String(form.get("effectiveFrom") ?? "").trim();
    const reason = String(form.get("reason") ?? "").trim();
    const valueJson =
      type === "price"
        ? JSON.stringify({
            closeDecimal: String(form.get("value") ?? "").trim(),
            currencyCode: selectedQuote?.currencyCode ?? "",
          })
        : JSON.stringify({
            rateDecimal: String(form.get("value") ?? "").trim(),
            baseCurrencyCode: fxBaseCurrency,
            quoteCurrencyCode: fxQuoteCurrency,
          });
    setPending(true);
    setDialogError(null);
    // B1 review fix: clear a stale parent toast from a previous save in this
    // same dialog mount (success-toast -> reopen -> failing submit ->
    // Escape/Cancel must not leave "Correction saved..." visible after a
    // subsequent failure).
    onMessage(null);
    // UI-008: Escape is blocked and Cancel is disabled while `pending` (see
    // onCancel below), so a request that never settles would trap the owner
    // in the dialog -- bound the fetch and abort it if it stalls.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch("/api/market-data/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          portfolioId,
          type,
          targetKey,
          securityId: type === "price" ? selectedQuote?.securityId : null,
          effectiveFrom,
          valueJson,
          reason,
        }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "The correction could not be saved.");
      // Success is announced once the dialog has closed, so the outside
      // toast (still live at that point) is the right place for it.
      onMessage("Correction saved with a reason and effective date.");
      dialogRef.current?.close();
    } catch (error) {
      setDialogError(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "The correction could not be saved.",
      );
    } finally {
      clearTimeout(timeout);
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="quote-dialog"
      aria-labelledby="quote-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        // F1 review fix: Escape while a save is in flight must not close
        // (and unmount) the dialog out from under the pending request --
        // the eventual success/failure would land on an unmounted
        // component and the user would be told nothing. Consistent with
        // the Cancel button, which is also disabled while pending.
        if (pending) return;
        dialogRef.current?.close();
      }}
      onClose={() => onClose()}
    >
      <form onSubmit={submit}>
        <p className="eyebrow">Manual correction</p>
        <h2 id="quote-dialog-title">Correct a market value</h2>
        <p className="dialog-note">
          Corrections are versioned, owner-scoped, and reversible. A reason is
          required; provider observations are never overwritten.
        </p>
        <label>
          Correction type
          <select
            value={type}
            onChange={(event) => {
              const nextType =
                event.target.value === "fx_rate" ? "fx_rate" : "price";
              setType(nextType);
              setSelectedTargetKey(
                nextType === "price"
                  ? (quoteTargets[0]?.targetKey ?? "")
                  : (fxTargetKeys[0] ?? ""),
              );
            }}
          >
            <option value="price">Price</option>
            <option value="fx_rate">FX rate</option>
          </select>
        </label>
        <label>
          Target key
          <select
            name="targetKey"
            required
            value={selectedTargetKey}
            onChange={(event) => setSelectedTargetKey(event.target.value)}
          >
            {type === "price"
              ? quoteTargets.map((quote) => (
                  <option key={quote.securityId} value={quote.targetKey}>
                    {quote.symbol} · {quote.name} ({quote.currencyCode})
                  </option>
                ))
              : fxTargetKeys.map((pair) => (
                  <option key={pair} value={pair}>
                    {pair}
                  </option>
                ))}
          </select>
        </label>
        <label>
          Effective date
          <input name="effectiveFrom" type="date" required />
        </label>
        <label>
          {type === "price" ? "Price" : "Rate"}
          <input name="value" inputMode="decimal" required />
        </label>
        {type === "fx_rate" ? (
          <div className="quote-dialog-grid">
            <label>
              Base currency
              <input
                name="baseCurrencyCode"
                value={selectedFxBase}
                readOnly
                maxLength={3}
                required
              />
            </label>
            <label>
              Quote currency
              <input
                name="quoteCurrencyCode"
                value={selectedFxQuote}
                readOnly
                maxLength={3}
                required
              />
            </label>
          </div>
        ) : null}
        <label>
          Reason
          <textarea name="reason" required maxLength={500} />
        </label>
        <div className="dialog-actions">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            disabled={pending}
          >
            Cancel
          </button>
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save correction"}
          </button>
        </div>
        {dialogError ? (
          <p role="alert" className="unavailable">
            {dialogError}
          </p>
        ) : null}
      </form>
    </dialog>
  );
}

function DetailsScreen({
  portfolio,
  viewState,
}: {
  portfolio: PortfolioPrototype;
  viewState: ViewState;
}) {
  // FY/Last FY are inserted here as static labels only (FY-001C item 2):
  // like every other period tab in this prototype, selecting one only
  // changes the interpolated `{period}` eyebrow copy below -- it never
  // recomputes the fixed prototype figures or implies real filtering.
  const periods = ["1W", "1M", "3M", "6M", "YTD", "FY", "Last FY", "1Y", "Max"];
  const [period, setPeriod] = useState("1Y");

  if (viewState === "empty") {
    return (
      <EmptyState
        title="History starts with a portfolio"
        message="Value history is unavailable until transactions and market observations exist."
      />
    );
  }

  return (
    <div className="details-screen">
      <section className="details-history" aria-labelledby="details-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Portfolio value · {period}</p>
            <h1 id="details-title">{portfolio.value}</h1>
            <p className="overview-movement">
              <ToneValue tone="positive">↑ A$197,846.30</ToneValue>
              <span>+18.42%</span>
            </p>
          </div>
          <button className="compact-select" type="button">
            Portfolio value <span aria-hidden="true">⌄</span>
          </button>
        </div>
        <div
          className="detail-chart"
          role="img"
          aria-label="Portfolio value trend with a dip in October and stronger growth from March to July."
        >
          <div className="chart-area" />
          <span className="chart-endpoint" aria-hidden="true" />
        </div>
        <div className="period-tabs" aria-label="Chart period">
          {periods.map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={period === item}
              onClick={() => setPeriod(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      <section className="detail-metrics" aria-labelledby="analysis-title">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Open positions</p>
            <h2 id="analysis-title">Analysis</h2>
          </div>
          <span className="muted-copy">
            {viewState === "partial" ? "7 of 8 priced" : "Complete coverage"}
          </span>
        </div>
        <dl className="metric-list">
          <div>
            <dt>Market value</dt>
            <dd>
              {viewState === "partial"
                ? "A$1,143,903.50 known"
                : portfolio.value}
            </dd>
          </div>
          <div>
            <dt>Open cost basis</dt>
            <dd>{portfolio.cost}</dd>
          </div>
          <div>
            <dt>Unrealised gain</dt>
            <dd className="tone-positive">
              {portfolio.gainAmount} · {portfolio.gainPercent}
            </dd>
          </div>
          <div>
            <dt>Realised gain</dt>
            <dd className="tone-positive">
              {portfolio.realisedAmount} · {portfolio.realisedPercent}
            </dd>
          </div>
          <div>
            <dt>Cash</dt>
            <dd>{portfolio.cash}</dd>
          </div>
          <div>
            <dt>Accounting</dt>
            <dd>FIFO</dd>
          </div>
        </dl>
      </section>

      <section className="allocation-panel" aria-labelledby="allocation-title">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Priced holdings</p>
            <h2 id="allocation-title">Largest positions</h2>
          </div>
          <span className="muted-copy">of invested value</span>
        </div>
        <div className="allocation-list">
          {[
            ["RIO.AX", "10.3%", "100%"],
            ["DRO.AX", "9.8%", "95%"],
            ["CLW.AX", "9.7%", "94%"],
            ["MIN.AX", "9.1%", "88%"],
          ].map(([symbol, percentage, width]) => (
            <div key={symbol}>
              <span>{symbol}</span>
              <span className="allocation-track">
                <i style={{ "--allocation": width } as React.CSSProperties} />
              </span>
              <strong>{percentage}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function NewsScreen() {
  return (
    <section className="news-placeholder" aria-labelledby="news-title">
      <p className="eyebrow">Route reserved</p>
      <h1 id="news-title">Portfolio news is not connected</h1>
      <p>
        This prototype preserves the navigation pattern without inventing a
        provider or showing unattributed market content.
      </p>
      <div className="news-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function HoldingSheet({
  holding,
  onClose,
  directRoute = false,
  unavailable = false,
}: {
  holding: Holding;
  onClose: () => void;
  directRoute?: boolean;
  unavailable?: boolean;
}) {
  return (
    <div className="sheet-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="holding-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="holding-sheet-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-heading">
          <div>
            <p className="eyebrow">
              {holding.exchange} · {holding.currency}
            </p>
            <h2 id="holding-sheet-title">{holding.symbol}</h2>
            <p>{holding.name}</p>
          </div>
          <button
            type="button"
            aria-label="Close holding details"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="sheet-quote">
          <strong>{unavailable ? "unavailable" : holding.price}</strong>
          {unavailable ? (
            <span className="unavailable">Daily movement unavailable</span>
          ) : (
            <ToneValue tone={holding.dailyTone}>
              {holding.dailyAmount} · {holding.dailyPercent}
            </ToneValue>
          )}
        </div>
        <dl className="sheet-facts">
          <div>
            <dt>Market value</dt>
            <dd>{unavailable ? "unavailable" : holding.value}</dd>
          </div>
          <div>
            <dt>Open cost</dt>
            <dd>{holding.cost}</dd>
          </div>
          <div>
            <dt>Total gain</dt>
            <dd
              className={
                unavailable ? "unavailable" : `tone-${holding.totalTone}`
              }
            >
              {unavailable
                ? "unavailable"
                : `${holding.totalAmount} · ${holding.totalPercent}`}
            </dd>
          </div>
          <div>
            <dt>Quantity</dt>
            <dd>{holding.quantityLine}</dd>
          </div>
        </dl>
        <p className="sheet-note">
          {holding.detailExplanation ??
            "Prototype explanation: exact observation time, source, FX evidence, and FIFO lots remain available here without crowding the row."}
        </p>
        {directRoute ? (
          <Link className="sheet-back" href="/portfolio/preview/holdings">
            Back to holdings
          </Link>
        ) : null}
      </section>
    </div>
  );
}

export function PortfolioShell({
  activeSection,
  reviewBadgeLabel = "Prototype · mock data",
  reviewNote = "Static review build · local mock data · no financial writes",
  portfolioPrototypesOverride = null,
  historyBarsOverride = [],
  overviewHref = "/",
  holdingSymbol = null,
  ownedWorkspace,
  ownedDetails = null,
  initialHideSold = true,
}: {
  activeSection: PortfolioSection;
  reviewBadgeLabel?: string;
  reviewNote?: string;
  portfolioPrototypesOverride?: readonly PortfolioPrototype[] | null;
  /** PRF-014 step 1: the preview route's demo history-chart bars
   * (`historyBars` in `../prototype-data`), passed in by the caller so this
   * "use client" module never imports the fixture module's runtime values.
   * Production never passes this (defaults to an empty chart). */
  historyBarsOverride?: readonly string[];
  overviewHref?: string;
  holdingSymbol?: string | null;
  ownedWorkspace?: OwnedWorkspace;
  ownedDetails?: PortfolioInspection | null;
  /** UI-052 test seam, threaded to `OwnedHoldingsScreen` -- see its own
   * doc comment. Production never passes this. */
  initialHideSold?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // UI-048: this shell renders on the primary tabs and nowhere else (the
  // Income and holding areas render their own <main>), so recording the
  // pathname here IS "the last primary tab the owner was on" -- which the
  // Income area's back control returns to instead of walking back through
  // its own sub-tabs. Path only; never portfolio values.
  useEffect(() => {
    if (pathname !== null) rememberPrimaryTab(pathname);
  }, [pathname]);
  // PRF-014 step 1: previously fell back to the raw `portfolioPrototypes`
  // fixture import. Every real caller passes either `ownedWorkspace` or
  // `portfolioPrototypesOverride` (never neither -- see app/page.tsx,
  // app/portfolio/[portfolioId]/[section]/page.tsx and its [holdingId]
  // sibling), so this `?? []` path is unreachable in production -- not
  // merely harmless if it were reached: with neither prop, `portfolios`
  // is `[]` and several unguarded `portfolio.<field>` reads further down
  // (the Holdings sort, and the Quotes/Details screens) throw rather than
  // degrade. A discriminated props union (`{ ownedWorkspace: ... } | {
  // portfolioPrototypesOverride: ... }`) would make that combination
  // unconstructable at the type level and close this gap by construction;
  // recorded as a follow-up in docs/ARCHITECTURE.md §9.12, not implemented
  // in this step.
  const portfolios = portfolioPrototypesOverride ?? [];
  const ownedMode = ownedWorkspace !== undefined;
  const selectorItems: Array<{
    id: string;
    name: string;
    status: string;
    version: number;
  }> = ownedMode
    ? ownedWorkspace.portfolios
    : portfolios.map((item) => ({
        id: item.id,
        name: item.name,
        status: "active",
        version: 0,
      }));
  const [portfolioId, setPortfolioId] = useState(() => {
    const detailPortfolio = holdingSymbol
      ? portfolios.find((item) =>
          item.holdings.some((holding) => holding.symbol === holdingSymbol),
        )
      : null;
    return (
      detailPortfolio?.id ??
      portfolios.find((item) => item.id === "aus-stocks")?.id ??
      portfolios[0]?.id ??
      "aus-stocks"
    );
  });
  const [viewState, setViewState] = useState<ViewState>("populated");
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenerRef = useRef<HTMLButtonElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const [selectedHolding, setSelectedHolding] = useState<Holding | null>(() =>
    holdingSymbol
      ? (portfolios
          .flatMap((item) => item.holdings)
          .find((holding) => holding.symbol === holdingSymbol) ?? null)
      : null,
  );
  const [selectedHoldingUnavailable, setSelectedHoldingUnavailable] =
    useState(false);
  const [portfolioDialog, setPortfolioDialog] = useState<
    "create" | "rename" | null
  >(null);
  const portfolioDialogRef = useRef<HTMLDialogElement>(null);
  const portfolioDialogOpenerRef = useRef<HTMLButtonElement | null>(null);
  // B1 review fix: the Create/Rename buttons live INSIDE the popover, which
  // unmounts the instant setOpenMenu(null) runs (same render pass that opens
  // the dialog). Capturing `event.currentTarget` there would point focus
  // restoration at an already-detached node -- a silent no-op that drops
  // focus to <body>. The `.portfolio-button` toggle survives the popover
  // closing, so it is the opener for both dialog modes.
  const portfolioButtonRef = useRef<HTMLButtonElement>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const updateConnectivity = () => setIsOnline(navigator.onLine);
    updateConnectivity();
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    return () => {
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
    };
  }, []);

  // The navigation drawer is a full-screen overlay: without moving focus in
  // on open, restoring it to the trigger on close, and containing Tab while
  // open, a keyboard user could tab into content visually hidden behind it.
  useEffect(() => {
    if (drawerOpen) {
      drawerCloseRef.current?.focus();
      return;
    }
    if (drawerOpenerRef.current) {
      drawerOpenerRef.current.focus();
      drawerOpenerRef.current = null;
    }
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [drawerOpen]);

  // Mirrors the income-multi-year / dividend-assumptions-editor dialog
  // pattern (QA-001B): showModal() on open (so the native ::backdrop and
  // centering apply and the dialog is a real modal, not inert content at
  // the bottom of the page), focus the first field, and restore focus to
  // the surviving `.portfolio-button` toggle on close (B1 review fix: the
  // popover menu item that was clicked is already unmounted by the time
  // this effect runs, since setOpenMenu(null) and setPortfolioDialog(...)
  // land in the same render pass -- the toggle button is the nearest node
  // guaranteed to still be in the DOM).
  useEffect(() => {
    const dialog = portfolioDialogRef.current;
    if (portfolioDialog && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLInputElement>("input")?.focus();
    }
    if (!portfolioDialog && dialog?.open) dialog.close();
    if (!portfolioDialog && portfolioDialogOpenerRef.current) {
      portfolioDialogOpenerRef.current.focus();
      portfolioDialogOpenerRef.current = null;
    }
  }, [portfolioDialog]);

  const portfolio =
    portfolios.find((item) => item.id === portfolioId) ?? portfolios[0];
  // PRF-014 step 1: the `overviewRows` fixture fallback is unreachable for
  // the same reason as `portfolios` above -- derive rows from `portfolios`
  // unconditionally instead of importing the fixture's runtime value.
  const overviewPortfolioRows = portfolios.map(overviewRowFromPortfolio);

  function selectPortfolio(nextId: string) {
    setPortfolioId(nextId);
    setOpenMenu(null);
    setDrawerOpen(false);
    if (ownedMode) {
      router.push(`/portfolio/${nextId}/${activeSection}`);
    }
  }

  async function submitPortfolioAction(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!ownedWorkspace || !isOnline) return;
    const form = new FormData(event.currentTarget);
    const isRename = portfolioDialog === "rename";
    const endpoint = isRename
      ? `/api/portfolios/${ownedWorkspace.activePortfolio?.id ?? ""}`
      : "/api/portfolios";
    setActionPending(true);
    setActionMessage(null);
    // UI-008: a stalled request must not leave the dialog's Cancel button
    // disabled forever -- bound this fetch and abort it if it never settles.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(endpoint, {
        method: isRename ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: String(form.get("code") ?? ""),
          name: String(form.get("name") ?? ""),
          timezone: String(form.get("timezone") ?? ""),
          expectedVersion: ownedWorkspace.activePortfolio?.version,
        }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
        portfolio?: { id: string };
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Portfolio action failed.");
      portfolioDialogRef.current?.close();
      router.refresh();
      if (!isRename && result.portfolio)
        router.push(`/portfolio/${result.portfolio.id}/overview`);
    } catch (error) {
      setActionMessage(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Portfolio action failed.",
      );
    } finally {
      clearTimeout(timeout);
      setActionPending(false);
    }
  }

  async function changeHomeCurrency(value: string) {
    if (!ownedWorkspace?.settingsVersion || !isOnline) return;
    setActionPending(true);
    setActionMessage(null);
    try {
      const response = await fetch("/api/settings/home-currency", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          homeCurrencyCode: value,
          expectedVersion: ownedWorkspace.settingsVersion,
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(
          result.message ?? "Home currency could not be changed.",
        );
      setOpenMenu(null);
      router.refresh();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Home currency could not be changed.",
      );
    } finally {
      setActionPending(false);
    }
  }

  async function changeHoldingCurrencyView(value: "native" | "home") {
    if (!ownedWorkspace?.settingsVersion || !isOnline) return;
    setActionPending(true);
    setActionMessage(null);
    try {
      const response = await fetch("/api/settings/holding-currency-view", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          view: value,
          expectedVersion: ownedWorkspace.settingsVersion,
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Display view could not be changed.");
      setOpenMenu(null);
      router.refresh();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Display view could not be changed.",
      );
    } finally {
      setActionPending(false);
    }
  }

  async function changeFinancialYearStartMonth(value: number) {
    if (!ownedWorkspace?.settingsVersion || !isOnline) return;
    setActionPending(true);
    setActionMessage(null);
    try {
      const response = await fetch("/api/settings/financial-year", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          financialYearStartMonth: value,
          expectedVersion: ownedWorkspace.settingsVersion,
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(
          result.message ?? "Financial-year start month could not be changed.",
        );
      setOpenMenu(null);
      router.refresh();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Financial-year start month could not be changed.",
      );
    } finally {
      setActionPending(false);
    }
  }

  async function changePriceSourcePreference(
    value: "yahoo_authenticated" | "yahoo_anonymous" | "sharesight_delayed",
  ) {
    if (!ownedWorkspace?.settingsVersion || !isOnline) return;
    setActionPending(true);
    setActionMessage(null);
    try {
      const response = await fetch("/api/settings/price-source-preference", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priceSourcePreference: value,
          expectedVersion: ownedWorkspace.settingsVersion,
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(
          result.message ?? "Price-source preference could not be changed.",
        );
      setOpenMenu(null);
      router.refresh();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Price-source preference could not be changed.",
      );
    } finally {
      setActionPending(false);
    }
  }

  // MKT-011A: mirrors `changePriceSourcePreference` exactly.
  async function changeDailyCaptureSource(
    value: "sharesight" | "yahoo_anonymous" | "yahoo_authenticated",
  ) {
    if (!ownedWorkspace?.settingsVersion || !isOnline) return;
    setActionPending(true);
    setActionMessage(null);
    try {
      const response = await fetch("/api/settings/daily-capture-source", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dailyCaptureSource: value,
          expectedVersion: ownedWorkspace.settingsVersion,
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(
          result.message ?? "Daily-capture source could not be changed.",
        );
      setOpenMenu(null);
      router.refresh();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Daily-capture source could not be changed.",
      );
    } finally {
      setActionPending(false);
    }
  }

  // MKT-011A: mirrors `changePriceSourcePreference` exactly.
  async function changeDailyCaptureIntervalMinutes(value: 30 | 60) {
    if (!ownedWorkspace?.settingsVersion || !isOnline) return;
    setActionPending(true);
    setActionMessage(null);
    try {
      const response = await fetch("/api/settings/daily-capture-interval", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dailyCaptureIntervalMinutes: value,
          expectedVersion: ownedWorkspace.settingsVersion,
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(
          result.message ?? "Daily-capture interval could not be changed.",
        );
      setOpenMenu(null);
      router.refresh();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Daily-capture interval could not be changed.",
      );
    } finally {
      setActionPending(false);
    }
  }

  async function archiveActivePortfolio() {
    const active = ownedWorkspace?.activePortfolio;
    if (!active || !isOnline) return;
    setActionPending(true);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/portfolios/${active.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: active.version }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Portfolio could not be archived.");
      setOpenMenu(null);
      router.push("/");
      router.refresh();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Portfolio could not be archived.",
      );
    } finally {
      setActionPending(false);
    }
  }

  async function restorePortfolio(portfolioId: string, version: number) {
    setActionPending(true);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/portfolios/${portfolioId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Portfolio could not be restored.");
      setOpenMenu(null);
      router.refresh();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Portfolio could not be restored.",
      );
    } finally {
      setActionPending(false);
    }
  }

  return (
    <div className="prototype-app">
      <ServiceWorkerRegistration />
      <header className="app-bar">
        <button
          className="icon-button"
          type="button"
          aria-label="Open navigation menu"
          aria-expanded={drawerOpen}
          onClick={(event) => {
            drawerOpenerRef.current = event.currentTarget;
            setDrawerOpen(true);
          }}
        >
          <span className="hamburger" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </button>

        {/* PRF-004 (owner-reported: tab navigation still 3-10+s on Workers
            Free; production logs showed every navigation ALSO fetching `/`
            as an `.rsc` prefetch, roughly doubling server work per click):
            this brand link is rendered unconditionally in the shared shell
            header on EVERY authenticated page and is essentially always in
            the viewport, so vinext's shared IntersectionObserver auto-
            prefetches its target as soon as it mounts (Vinext's own
            "auto" prefetch mode only skips DYNAMIC-path routes -- e.g.
            `/portfolio/[id]/...` -- never `/` itself, which has no path
            params and is therefore eligible). That silently repeated a full
            root-page RSC render on every single tab navigation, whether or
            not the owner ever clicked the logo. `prefetch={false}` stops
            that background fetch; clicking the logo still navigates
            normally (a single on-demand fetch, same as any other
            already-unprefetched tab), it just no longer happens for free
            on every unrelated page view.
            UI-051 (reviewer B1, owner ruling "keep labels honest"): `/`
            itself now redirects to the active portfolio's Holdings tab on
            initial load, so an "overview"-labelled link that still pointed
            at `/` would silently land the owner on Holdings instead --
            a labelled control not doing what it says. With an active
            portfolio, this link now targets `/portfolio/:id/overview`
            directly (a genuine, explicit "go to Overview" navigation, which
            the owner's redirect directive does not cover); `/` remains the
            target only in preview mode and owned-mode-with-no-portfolio.
            `prefetch={false}` stays regardless of target: the dynamic
            `/portfolio/:id/overview` route is already auto-skipped by
            vinext's own DYNAMIC-path rule above, but the `/` fallback
            (no active portfolio) still needs it. */}
        <Link
          className="topbar-brand"
          href={
            ownedMode && ownedWorkspace.activePortfolio
              ? `/portfolio/${ownedWorkspace.activePortfolio.id}/overview`
              : "/"
          }
          aria-label="YieldToMe overview"
          prefetch={false}
        >
          <BrandMark />
          <span className="wordmark">YieldToMe</span>
        </Link>

        <div className="menu-anchor portfolio-anchor">
          <button
            ref={portfolioButtonRef}
            className="portfolio-button"
            type="button"
            aria-expanded={openMenu === "portfolio"}
            onClick={() =>
              setOpenMenu((current) =>
                current === "portfolio" ? null : "portfolio",
              )
            }
          >
            <span>
              {ownedMode
                ? (ownedWorkspace?.activePortfolio?.name ?? "No portfolios")
                : (portfolio?.name ?? "No portfolios")}
            </span>
            <span aria-hidden="true">⌄</span>
          </button>
          {openMenu === "portfolio" ? (
            <div className="popover portfolio-popover">
              <p>Portfolios</p>
              {selectorItems.map((item) =>
                ownedMode && item.status === "archived" ? (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => void restorePortfolio(item.id, item.version)}
                    disabled={actionPending || !isOnline}
                  >
                    <span>Restore {item.name}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={
                      item.id ===
                      (ownedWorkspace?.activePortfolio?.id ?? portfolioId)
                    }
                    onClick={() => selectPortfolio(item.id)}
                  >
                    <span>{item.name}</span>
                    {item.id === portfolioId ? (
                      <span aria-hidden="true">✓</span>
                    ) : null}
                  </button>
                ),
              )}
              {ownedMode ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      portfolioDialogOpenerRef.current =
                        portfolioButtonRef.current;
                      setOpenMenu(null);
                      setPortfolioDialog("create");
                    }}
                    disabled={actionPending || !isOnline}
                  >
                    <span>Create portfolio</span>
                    <span aria-hidden="true">+</span>
                  </button>
                  {ownedWorkspace.activePortfolio ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          portfolioDialogOpenerRef.current =
                            portfolioButtonRef.current;
                          setOpenMenu(null);
                          setPortfolioDialog("rename");
                        }}
                        disabled={actionPending || !isOnline}
                      >
                        <span>Rename portfolio</span>
                      </button>
                      <button
                        type="button"
                        onClick={archiveActivePortfolio}
                        disabled={actionPending || !isOnline}
                      >
                        <span>Archive portfolio</span>
                      </button>
                    </>
                  ) : null}
                </>
              ) : null}
              {/* PRF-006 (owner-directed final pass): this popover mounts
                  fresh, in-viewport, every time the portfolio menu opens
                  (`openMenu === "portfolio"`), so vinext's auto-prefetch
                  re-triggers a full root-page RSC fetch on every open --
                  the same defect class PRF-004 fixed for the always-mounted
                  topbar-brand link (see its comment above). `prefetch=
                  {false}` stops that; the link still navigates normally on
                  click.
                  UI-051 (reviewer B1): same conditional target as the
                  topbar-brand link above -- see its UI-051 comment. */}
              <Link
                href={
                  ownedMode && ownedWorkspace.activePortfolio
                    ? `/portfolio/${ownedWorkspace.activePortfolio.id}/overview`
                    : "/"
                }
                onClick={() => setOpenMenu(null)}
                prefetch={false}
              >
                <span>All portfolios</span>
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          ) : null}
        </div>

        {!ownedMode ? (
          <span className="prototype-chip desktop-only">
            {reviewBadgeLabel}
          </span>
        ) : null}

        {ownedMode ? (
          <span className="fx-rate-pill">
            USD/AUD{" "}
            <strong>{ownedWorkspace.usdAudRate ?? "unavailable"}</strong>
          </span>
        ) : null}

        <div className="app-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh prices"
          >
            <span className="refresh-icon" aria-hidden="true">
              ↻
            </span>
          </button>
          <div className="menu-anchor">
            <button
              className="icon-button"
              type="button"
              aria-label="Open add menu"
              aria-expanded={openMenu === "add"}
              onClick={() =>
                setOpenMenu((current) => (current === "add" ? null : "add"))
              }
            >
              <span className="plus-icon" aria-hidden="true">
                +
              </span>
            </button>
            {openMenu === "add" ? (
              <div className="popover action-popover">
                <p>{ownedMode ? "Workspace actions" : "Prototype actions"}</p>
                {ownedMode ? (
                  ownedWorkspace.activePortfolio ? (
                    <>
                      <Link
                        href={`/portfolio/${ownedWorkspace.activePortfolio.id}/ledger/new?type=buy`}
                        onClick={() => setOpenMenu(null)}
                      >
                        <span>Add holding</span>
                        <small>Buy a new security · manual ledger entry</small>
                      </Link>
                      <Link
                        href={`/portfolio/${ownedWorkspace.activePortfolio.id}/ledger/new`}
                        onClick={() => setOpenMenu(null)}
                      >
                        <span>Add transaction</span>
                        <small>Manual ledger entry</small>
                      </Link>
                    </>
                  ) : null
                ) : (
                  <>
                    <button type="button">
                      <span>Add holding</span>
                      <small>UI only</small>
                    </button>
                    <button type="button">
                      <span>Add transaction</span>
                      <small>UI only</small>
                    </button>
                  </>
                )}
                {ownedMode ? (
                  <Link href="/import" onClick={() => setOpenMenu(null)}>
                    <span>Import CSV</span>
                    <small>Resolve &amp; commit</small>
                  </Link>
                ) : (
                  <button type="button">
                    <span>Import CSV</span>
                    <small>Not connected</small>
                  </button>
                )}
              </div>
            ) : null}
          </div>
          <div className="menu-anchor">
            <button
              className="icon-button"
              type="button"
              aria-label={
                ownedMode ? "Open account menu" : "Open prototype state menu"
              }
              aria-expanded={openMenu === "prototype"}
              onClick={() =>
                setOpenMenu((current) =>
                  current === "prototype" ? null : "prototype",
                )
              }
            >
              <span className="more-icon" aria-hidden="true">
                •••
              </span>
            </button>
            {openMenu === "prototype" ? (
              <div className="popover prototype-popover">
                {ownedMode ? (
                  <>
                    <p>Signed in</p>
                    <span className="menu-note">
                      {ownedWorkspace.userDisplayName ?? "Private account"}
                    </span>
                    <label className="menu-field">
                      <span>Home currency</span>
                      <select
                        value={ownedWorkspace.homeCurrencyCode ?? "AUD"}
                        onChange={(event) =>
                          void changeHomeCurrency(event.target.value)
                        }
                        disabled={actionPending || !isOnline}
                      >
                        <option value="AUD">AUD</option>
                        <option value="USD">USD</option>
                        <option value="GBP">GBP</option>
                        <option value="EUR">EUR</option>
                      </select>
                    </label>
                    <label className="menu-field">
                      <span>Display values</span>
                      <select
                        value={ownedWorkspace.holdingCurrencyView ?? "native"}
                        onChange={(event) =>
                          void changeHoldingCurrencyView(
                            event.target.value as "native" | "home",
                          )
                        }
                        disabled={actionPending || !isOnline}
                      >
                        <option value="native">Native currency</option>
                        <option value="home">Home currency</option>
                      </select>
                    </label>
                    <div className="menu-field">
                      <label htmlFor="fy-start-month-select">
                        Financial year start
                      </label>
                      <select
                        id="fy-start-month-select"
                        value={ownedWorkspace.financialYearStartMonth ?? 7}
                        onChange={(event) =>
                          void changeFinancialYearStartMonth(
                            Number(event.target.value),
                          )
                        }
                        disabled={actionPending || !isOnline}
                        aria-describedby="fy-start-month-helper"
                      >
                        {FY_MONTH_NAMES.map((name, index) => (
                          <option key={name} value={index + 1}>
                            {name}
                          </option>
                        ))}
                      </select>
                      {/* Outside the label (FY-001B review fold-in): the
                          helper span used to sit inside the label, so its
                          text became part of the select's accessible name
                          AND was re-announced via aria-describedby -- a
                          double announcement. htmlFor/id association keeps
                          the label-select link explicit without wrapping
                          the note text into the name. */}
                      <span className="menu-note" id="fy-start-month-helper">
                        {financialYearWindowHelperText(
                          ownedWorkspace.financialYearStartMonth ?? 7,
                        )}
                      </span>
                    </div>
                    <div className="menu-field">
                      <label htmlFor="price-source-preference-select">
                        Price source
                      </label>
                      <select
                        id="price-source-preference-select"
                        value={
                          ownedWorkspace.priceSourcePreference ??
                          "sharesight_delayed"
                        }
                        onChange={(event) =>
                          void changePriceSourcePreference(
                            event.target.value as
                              | "yahoo_authenticated"
                              | "yahoo_anonymous"
                              | "sharesight_delayed",
                          )
                        }
                        disabled={actionPending || !isOnline}
                        aria-describedby="price-source-preference-helper"
                      >
                        <option value="yahoo_authenticated">
                          Yahoo (logged in)
                        </option>
                        <option value="yahoo_anonymous">
                          Yahoo (not logged in)
                        </option>
                        <option value="sharesight_delayed">Sharesight</option>
                      </select>
                      {/* Outside the label (B5, mirrors FY-001B's identical
                          fix directly above): a helper span inside the
                          label becomes part of the select's accessible name
                          AND gets re-announced via aria-describedby -- a
                          double announcement. htmlFor/id association keeps
                          the label-select link explicit without wrapping
                          the note text into the name. Honest about what
                          this control does NOT guarantee: it is a
                          preference the read path tries first, with honest
                          fallback to whatever is actually usable -- never a
                          promise of real-time data or a login that may not
                          even be configured (see
                          docs/MARKET_DATA_STRATEGY.md §20). */}
                      <span
                        className="menu-note"
                        id="price-source-preference-helper"
                      >
                        Preferred source for prices, with honest fallback when
                        it has none.
                      </span>
                    </div>
                    <div className="menu-field">
                      <label htmlFor="daily-capture-source-select">
                        Daily capture source
                      </label>
                      <select
                        id="daily-capture-source-select"
                        value={
                          ownedWorkspace.dailyCaptureSource ?? "sharesight"
                        }
                        onChange={(event) =>
                          void changeDailyCaptureSource(
                            event.target.value as
                              | "sharesight"
                              | "yahoo_anonymous"
                              | "yahoo_authenticated",
                          )
                        }
                        disabled={actionPending || !isOnline}
                        aria-describedby="daily-capture-source-helper"
                      >
                        <option value="sharesight">Sharesight</option>
                        <option value="yahoo_anonymous">
                          Yahoo (not logged in)
                        </option>
                        <option value="yahoo_authenticated">
                          Yahoo (logged in)
                        </option>
                      </select>
                      {/* Outside the label, same FY-001B/MKT-009B fix as the
                          two fields above -- see those comments. */}
                      <span
                        className="menu-note"
                        id="daily-capture-source-helper"
                      >
                        Source for the daily intraday price sweep that closes
                        each trading day&apos;s history.
                      </span>
                    </div>
                    <div className="menu-field">
                      <label htmlFor="daily-capture-interval-select">
                        Daily capture cadence
                      </label>
                      <select
                        id="daily-capture-interval-select"
                        value={ownedWorkspace.dailyCaptureIntervalMinutes ?? 60}
                        onChange={(event) =>
                          void changeDailyCaptureIntervalMinutes(
                            Number(event.target.value) as 30 | 60,
                          )
                        }
                        disabled={actionPending || !isOnline}
                        aria-describedby="daily-capture-interval-helper"
                      >
                        <option value={30}>Every 30 minutes</option>
                        <option value={60}>Every 60 minutes</option>
                      </select>
                      {/* Outside the label, same FY-001B/MKT-009B fix as the
                          fields above -- see those comments. */}
                      <span
                        className="menu-note"
                        id="daily-capture-interval-helper"
                      >
                        How often the intraday sweep captures a price during
                        market hours.
                      </span>
                    </div>
                  </>
                ) : null}
                {!ownedMode ? <p>Preview a state</p> : null}
                {!ownedMode &&
                  (Object.keys(prototypeStateLabels) as ViewState[]).map(
                    (state) => (
                      <button
                        type="button"
                        key={state}
                        aria-pressed={viewState === state}
                        onClick={() => {
                          setViewState(state);
                          setOpenMenu(null);
                        }}
                      >
                        <span>{prototypeStateLabels[state]}</span>
                        {viewState === state ? (
                          <span aria-hidden="true">✓</span>
                        ) : null}
                      </button>
                    ),
                  )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {!ownedMode ? (
        <p className="prototype-chip mobile-only">{reviewBadgeLabel}</p>
      ) : null}

      <nav className="primary-tabs" aria-label="Portfolio sections">
        {primaryPortfolioSections.map((section) => (
          <Link
            key={section}
            href={
              ownedMode
                ? ownedWorkspace.activePortfolio
                  ? `/portfolio/${ownedWorkspace.activePortfolio.id}/${section}`
                  : ownedNoPortfolioHref(section)
                : sectionHref(section, overviewHref)
            }
            aria-current={activeSection === section ? "page" : undefined}
          >
            {section}
          </Link>
        ))}
        {/* UI-006A: Income has no preview/fixture equivalent (DIV-003 is an
            owner-scoped read service with no prototype-data seam), so this
            tab only appears in owned mode, and links directly to the
            standalone `/portfolio/:id/income` route tree rather than through
            `primaryPortfolioSections`/`[section]/page.tsx`'s preview-aware
            dispatch. */}
        {ownedMode && ownedWorkspace.activePortfolio ? (
          <Link
            href={`/portfolio/${ownedWorkspace.activePortfolio.id}/income`}
            aria-current={
              pathname?.startsWith(
                `/portfolio/${ownedWorkspace.activePortfolio.id}/income`,
              )
                ? "page"
                : undefined
            }
          >
            income
          </Link>
        ) : null}
      </nav>

      <StatusBanner
        viewState={viewState}
        onReset={() => setViewState("populated")}
      />

      <main className={`screen-content screen-${activeSection}`}>
        {ownedMode ? (
          activeSection === "details" && ownedWorkspace.activePortfolio ? (
            <OwnedPortfolioDetails
              inspection={ownedDetails}
              onOpenSettings={() => setOpenMenu("prototype")}
            />
          ) : activeSection === "overview" && ownedWorkspace.activePortfolio ? (
            <OwnedOverviewScreen
              data={
                ownedWorkspace.overview ?? {
                  status: "unavailable",
                  currencyCode: ownedWorkspace.activePortfolio.baseCurrencyCode,
                  current: null,
                  history: [],
                  coverage: {
                    pricedHoldingCount: null,
                    nonZeroHoldingCount: null,
                    convertedCashAccountCount: null,
                    nonZeroCashAccountCount: null,
                    totalHoldingCount: null,
                    excluded: [],
                    issues: [],
                    marketDataStates: [],
                  },
                  allocation: { status: "unavailable", rows: [] },
                }
              }
              portfolioId={ownedWorkspace.activePortfolio.id}
              portfolioName={ownedWorkspace.activePortfolio.name}
              financialYearStartMonth={
                ownedWorkspace.financialYearStartMonth ?? 7
              }
              timezone={
                ownedWorkspace.timezone ??
                ownedWorkspace.activePortfolio.timezone ??
                "Australia/Sydney"
              }
              // Server-resolved "now" (see OwnedWorkspace.nowInstant). No
              // client-side Date() fallback: an absent instant must fail
              // FY window resolution closed (empty state), never guess.
              nowInstant={ownedWorkspace.nowInstant ?? ""}
              portfolioValueHistory={
                ownedWorkspace.portfolioValueHistory ?? {
                  status: "unavailable",
                  baseCurrencyCode:
                    ownedWorkspace.activePortfolio.baseCurrencyCode,
                  points: [],
                  datesTruncated: false,
                  backfillPending: false,
                }
              }
              holdingsSummary={ownedWorkspace.holdingsSummary}
              holdingsProjectionPending={
                ownedWorkspace.holdingsProjectionPending
              }
            />
          ) : activeSection === "holdings" && ownedWorkspace.activePortfolio ? (
            <OwnedHoldingsScreen
              rows={ownedWorkspace.holdings ?? []}
              homeCurrencyCode={
                ownedWorkspace.homeCurrencyCode ??
                ownedWorkspace.activePortfolio.baseCurrencyCode
              }
              view={ownedWorkspace.holdingCurrencyView ?? "native"}
              state={ownedWorkspace.holdingsViewState ?? "empty"}
              cash={ownedWorkspace.cash}
              portfolioId={ownedWorkspace.activePortfolio.id}
              realisedGains={ownedWorkspace.realisedGains}
              initialHideSold={initialHideSold}
              summary={ownedWorkspace.holdingsSummary}
              projectionPending={ownedWorkspace.holdingsProjectionPending}
            />
          ) : (
            <OwnedWorkspaceScreen
              activeSection={activeSection}
              workspace={ownedWorkspace}
              // UI-021 (owner-reported): mirrors the header dropdown's "Create
              // portfolio" item exactly (`portfolioDialogOpenerRef.current =
              // ...; setPortfolioDialog("create")`) -- one dialog, two
              // openers. Unlike the dropdown item (which unmounts the
              // instant its popover closes, forcing it to capture a
              // DIFFERENT surviving node), this empty-state button itself
              // stays mounted while the dialog is open, so it captures
              // itself as the opener.
              onCreatePortfolio={(event) => {
                portfolioDialogOpenerRef.current = event.currentTarget;
                setPortfolioDialog("create");
              }}
              createPortfolioDisabled={actionPending || !isOnline}
              isOnline={isOnline}
            />
          )
        ) : null}
        {!ownedMode && activeSection === "overview" ? (
          <OverviewScreen
            portfolio={portfolioPrototypesOverride ? portfolio : undefined}
            rows={overviewPortfolioRows}
            historyBars={historyBarsOverride}
            viewState={viewState}
            onOpenPortfolio={(id) => {
              selectPortfolio(id);
              router.push("/portfolio/preview/holdings");
            }}
          />
        ) : null}
        {!ownedMode && activeSection === "holdings" ? (
          <HoldingsScreen
            portfolio={portfolio}
            viewState={viewState}
            onSelectHolding={(holding, unavailable) => {
              setSelectedHolding(holding);
              setSelectedHoldingUnavailable(unavailable);
            }}
            holdingDetailHref={
              portfolioPrototypesOverride
                ? (symbol) =>
                    `/portfolio/preview/holdings/${encodeURIComponent(symbol)}`
                : undefined
            }
          />
        ) : null}
        {!ownedMode && activeSection === "quotes" ? (
          <QuotesScreen
            portfolio={portfolio}
            portfolioId={portfolio.id}
            readOnly={!ownedMode}
            viewState={viewState}
          />
        ) : null}
        {!ownedMode && activeSection === "details" ? (
          <DetailsScreen portfolio={portfolio} viewState={viewState} />
        ) : null}
        {!ownedMode && activeSection === "news" ? <NewsScreen /> : null}
      </main>

      {/* B2 review fix: while the portfolio dialog is open, a failure (e.g.
          the prefilled "NEW" code colliding with portfolios_user_id_code_unique
          on a second create) must render INSIDE the dialog -- everything
          outside an open top-layer <dialog> is inert, so this outside toast
          would be neither visible nor announced. Non-dialog actions (archive,
          restore) still use this outside toast. */}
      {actionMessage && !portfolioDialog ? (
        <p className="action-feedback" role="alert">
          {actionMessage}
        </p>
      ) : null}

      {ownedMode && portfolioDialog ? (
        <dialog
          ref={portfolioDialogRef}
          className="portfolio-dialog"
          aria-labelledby="portfolio-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            portfolioDialogRef.current?.close();
            setPortfolioDialog(null);
          }}
          onClose={() => setPortfolioDialog(null)}
        >
          <form onSubmit={submitPortfolioAction}>
            <p className="eyebrow">Portfolio settings</p>
            <h2 id="portfolio-dialog-title">
              {portfolioDialog === "create"
                ? "Create portfolio"
                : "Rename portfolio"}
            </h2>
            {portfolioDialog === "create" ? (
              <label>
                Code
                <input name="code" required maxLength={40} defaultValue="NEW" />
              </label>
            ) : null}
            <label>
              Name
              <input
                name="name"
                required
                maxLength={120}
                defaultValue={
                  portfolioDialog === "rename"
                    ? ownedWorkspace.activePortfolio?.name
                    : "My portfolio"
                }
              />
            </label>
            <label>
              Timezone
              <input
                name="timezone"
                required
                maxLength={80}
                defaultValue={
                  ownedWorkspace.activePortfolio?.timezone ?? "Australia/Sydney"
                }
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                onClick={() => portfolioDialogRef.current?.close()}
                disabled={actionPending || !isOnline}
              >
                Cancel
              </button>
              <button type="submit" disabled={actionPending || !isOnline}>
                {actionPending ? "Working…" : "Save portfolio"}
              </button>
            </div>
            {actionMessage ? (
              <p role="alert" className="unavailable">
                {actionMessage}
              </p>
            ) : null}
          </form>
        </dialog>
      ) : null}

      {drawerOpen ? (
        <div
          className="drawer-layer"
          role="presentation"
          onMouseDown={() => setDrawerOpen(false)}
        >
          <aside
            className="navigation-drawer"
            aria-label="Navigation"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusable = event.currentTarget.querySelectorAll<
                HTMLAnchorElement | HTMLButtonElement
              >("a[href], button:not([disabled])");
              if (focusable.length === 0) return;
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <div className="drawer-heading">
              {/* PRF-006 (owner-directed final pass, closing PRF-004's own
                  recorded follow-up (c)): the drawer mounts fresh, in-
                  viewport, every time it opens (`{drawerOpen ? ... :
                  null}`), so vinext's auto-prefetch re-triggers a full
                  root-page RSC fetch on every open for BOTH of this
                  drawer's links -- the same defect class PRF-004 fixed for
                  the always-mounted topbar-brand link (see its comment
                  above). `prefetch={false}` stops that; both links still
                  navigate normally on click.
                  UI-051 (reviewer B1): both links now target the active
                  portfolio's Overview tab directly rather than `/` -- see
                  the topbar-brand link's UI-051 comment above for why. */}
              <Link
                href={
                  ownedMode && ownedWorkspace.activePortfolio
                    ? `/portfolio/${ownedWorkspace.activePortfolio.id}/overview`
                    : "/"
                }
                onClick={() => setDrawerOpen(false)}
                prefetch={false}
              >
                <BrandMark />
                <span className="wordmark">YieldToMe</span>
              </Link>
              <button
                ref={drawerCloseRef}
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setDrawerOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="drawer-label">Workspace</p>
            <Link
              href={
                ownedMode && ownedWorkspace.activePortfolio
                  ? `/portfolio/${ownedWorkspace.activePortfolio.id}/overview`
                  : "/"
              }
              onClick={() => setDrawerOpen(false)}
              prefetch={false}
            >
              Overview
            </Link>
            <p className="drawer-label">Portfolios</p>
            {selectorItems.map((item) =>
              ownedMode && item.status === "archived" ? (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => void restorePortfolio(item.id, item.version)}
                  disabled={actionPending || !isOnline}
                >
                  <span>Restore {item.name}</span>
                </button>
              ) : (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={item.id === portfolioId}
                  onClick={() => selectPortfolio(item.id)}
                >
                  <span>{item.name}</span>
                  {item.id === portfolioId ? <span>Selected</span> : null}
                </button>
              ),
            )}
            <p className="drawer-label">Manage</p>
            <button type="button">
              <span>Import / export</span>
              <small>Prototype only</small>
            </button>
            {ownedMode ? (
              <button
                type="button"
                onClick={() => {
                  setDrawerOpen(false);
                  setOpenMenu("prototype");
                }}
              >
                <span>Settings</span>
              </button>
            ) : (
              <button type="button">
                <span>Settings</span>
                <small>Prototype only</small>
              </button>
            )}
            <p className="drawer-note">{reviewNote}</p>
          </aside>
        </div>
      ) : null}

      {selectedHolding ? (
        <HoldingSheet
          holding={selectedHolding}
          onClose={() => {
            if (holdingSymbol !== null) {
              router.push("/portfolio/preview/holdings");
              return;
            }
            setSelectedHolding(null);
          }}
          directRoute={holdingSymbol !== null}
          unavailable={selectedHoldingUnavailable}
        />
      ) : null}
    </div>
  );
}
