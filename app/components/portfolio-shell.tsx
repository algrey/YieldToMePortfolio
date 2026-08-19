"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  historyBars,
  overviewRows,
  portfolioPrototypes,
  type Holding,
  type PortfolioPrototype,
  type Tone,
} from "../prototype-data";
import {
  quoteDisplayState,
  quoteExplanation,
  type QuoteRow,
} from "../quote-contract";
import type { PortfolioInspection } from "../../db/repositories/portfolio-inspection";
import { BrandMark } from "./brand-mark";
import { AccountLifecycleRecovery } from "./account-lifecycle-recovery";
import { AccountLifecycleControls } from "./account-lifecycle-controls";
import { OwnedPortfolioDetails } from "./portfolio-details";
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
  type OwnedHoldingCoverage,
  type OwnedHoldingRow,
} from "../owned-holdings-contract";
import {
  formatDecimalFixed,
  formatDecimalTrimmed,
  groupThousands,
} from "../preview-decimal";
import {
  currentFyWindow,
  lastFyWindow,
  parseDecimalResult,
} from "../../domain/calculations/index.ts";

export const portfolioSections = [
  "overview",
  "holdings",
  "quotes",
  "details",
  "news",
] as const;

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

export type PortfolioSection = (typeof portfolioSections)[number];
export type OwnedWorkspace = {
  status: "ready" | "empty" | "unavailable";
  userDisplayName?: string | null;
  homeCurrencyCode?: string | null;
  holdingCurrencyView?: "native" | "home";
  financialYearStartMonth?: number;
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
  quotes?: QuoteRow[];
  quoteViewState?: ViewState;
  overview?: OwnedOverviewData;
  holdings?: OwnedHoldingRow[];
  cash?: OwnedCashSummary;
  holdingCoverage?: OwnedHoldingCoverage;
  holdingsViewState?: "complete" | "partial" | "empty" | "unavailable";
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

  return `${sign}${currency}${rounded.toLocaleString("en-AU")}`;
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
  showAction = true,
}: {
  title?: string;
  message?: string;
  showAction?: boolean;
}) {
  return (
    <section className="empty-state" aria-labelledby="empty-title">
      <span className="empty-mark" aria-hidden="true">
        <BrandMark />
      </span>
      <p className="eyebrow">Empty state</p>
      <h2 id="empty-title">{title}</h2>
      <p>{message}</p>
      {showAction ? <button type="button">Preview add menu</button> : null}
    </section>
  );
}

// Gain/movement figures must carry an explicit +/− sign so the direction
// does not depend on colour alone (UI_SPEC §10, QUAL-001). Negative values
// already come back "-"-prefixed from formatDecimalFixed/Trimmed; this only
// adds the missing "+" for positive, non-zero values.
function signPrefixed(formatted: string, signed: boolean): string {
  if (!signed) return formatted;
  if (formatted.startsWith("-") || formatted.startsWith("−")) return formatted;
  if (/^0(?:\.0+)?$/.test(formatted)) return formatted;
  return `+${formatted}`;
}

function ownedHoldingAmount(
  value: {
    status: "available" | "unavailable";
    currencyCode: string;
    value: string | null;
    reason?: string | null;
  },
  scale = 2,
  signed = false,
) {
  if (value.status !== "available" || value.value === null)
    return value.reason === "missing_basis"
      ? "Basis unavailable"
      : "Price unavailable";
  try {
    const formatted = signPrefixed(
      groupThousands(
        formatDecimalFixed(parseDecimalResult(value.value), scale),
      ),
      signed,
    );
    return `${value.currencyCode} ${formatted}`;
  } catch {
    return value.reason === "missing_basis"
      ? "Basis unavailable"
      : "Price unavailable";
  }
}
function ownedHoldingDecimal(value: string | null, scale = 2): string {
  if (value === null) return "—";
  try {
    return groupThousands(formatDecimalFixed(parseDecimalResult(value), scale));
  } catch {
    return "—";
  }
}
function ownedHoldingTrimmed(value: string | null, scale = 6): string {
  if (value === null) return "—";
  try {
    return groupThousands(
      formatDecimalTrimmed(parseDecimalResult(value), scale, {
        trimTrailingZeros: true,
      }),
    );
  } catch {
    return "—";
  }
}
function ownedHoldingPercent(
  value: OwnedHoldingRow["dailyPercent"],
  signed = false,
): ReactNode {
  return value.status === "available" && value.value !== null ? (
    (() => {
      try {
        const formatted = signPrefixed(
          formatDecimalTrimmed(parseDecimalResult(value.value), 2, {
            trimTrailingZeros: true,
          }),
          signed,
        );
        return `${formatted}%`;
      } catch {
        return (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">Percentage unavailable</span>
          </>
        );
      }
    })()
  ) : (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">Percentage unavailable</span>
    </>
  );
}

function OwnedHoldingsScreen({
  rows,
  homeCurrencyCode,
  view,
  state,
  cash,
  coverage,
  portfolioId,
}: {
  rows: readonly OwnedHoldingRow[];
  homeCurrencyCode: string;
  view: "native" | "home";
  state: "complete" | "partial" | "empty" | "unavailable";
  cash?: OwnedCashSummary;
  coverage?: OwnedHoldingCoverage;
  /** UI-006C: builds the "Dividends" link in each holding's detail sheet. Optional so preview/prototype callers of this screen (none currently pass owned rows without a real portfolio id, but the type stays defensive) never need a fabricated id. */
  portfolioId?: string;
}) {
  const [sortKey, setSortKey] = useState<"ticker" | "value" | "daily" | "gain">(
    "daily",
  );
  const [direction, setDirection] = useState<Direction>("descending");
  const [selectedHolding, setSelectedHolding] =
    useState<OwnedHoldingRow | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const [holdingViews, setHoldingViews] = useState<
    Record<string, "native" | "home">
  >({});
  const sortableRows = useMemo(
    () =>
      rows.map((row) => {
        const rowView = holdingViews[row.id] ?? view;
        const home = rowView === "home" && row.homeValue.status === "available";
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
    [holdingViews, rows, view],
  );
  const sortedRows = useMemo(
    () => sortOwnedHoldings(sortableRows, sortKey, direction),
    [direction, sortableRows, sortKey],
  );
  useEffect(() => {
    const dialog = dialogRef.current;
    if (selectedHolding && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!selectedHolding && openerRef.current) {
      openerRef.current.focus();
      openerRef.current = null;
    }
  }, [selectedHolding]);

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
        showAction={false}
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
          {sortedRows.map((holding) => {
            const rowView = holdingViews[holding.id] ?? view;
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
                ? "Price unavailable"
                : `${holding.currencyCode} ${ownedHoldingTrimmed(holding.nativePrice)} · native fallback`
              : selectedPrice.status === "available" &&
                  selectedPrice.value !== null
                ? `${selectedPrice.currencyCode} ${ownedHoldingTrimmed(selectedPrice.value)}`
                : holding.nativePrice === null
                  ? "Price unavailable"
                  : `${holding.currencyCode} ${ownedHoldingTrimmed(holding.nativePrice)}`;
            const statusLabel =
              holding.actionStatus === "none"
                ? ""
                : ` · Action required: ${
                    holding.actionStatus === "stale"
                      ? "stale market data"
                      : holding.actionStatus === "missing_price"
                        ? "price unavailable"
                        : holding.actionStatus === "missing_fx"
                          ? "FX unavailable"
                          : holding.actionStatus === "missing_previous"
                            ? "previous comparison unavailable"
                            : "comparison unavailable"
                  }`;
            return (
              <button
                className="holding-row holdings-grid"
                type="button"
                key={holding.id}
                aria-label={`${holding.symbol}, ${holding.name}, open details`}
                aria-haspopup="dialog"
                onClick={(event) => {
                  openerRef.current = event.currentTarget;
                  setSelectedHolding(holding);
                }}
              >
                <span className="row-primary symbol">{holding.symbol}</span>
                <span className="row-primary numeric">
                  {ownedHoldingAmount(selectedValue)}
                </span>
                <ToneValue
                  tone={holding.dailyTone}
                  className="row-primary numeric"
                >
                  {ownedHoldingAmount(holding.dailyMovement, 2, true)}
                </ToneValue>
                <ToneValue
                  tone={holding.gainTone}
                  className="row-primary numeric"
                >
                  {ownedHoldingAmount(holding.unrealisedGain, 2, true)}
                </ToneValue>
                <span className="row-secondary">
                  {priceLabel}
                  {statusLabel}
                </span>
                <span className="row-secondary numeric">
                  Basis {ownedHoldingAmount(basis)}
                </span>
                <span className="row-secondary numeric">
                  {ownedHoldingPercent(holding.dailyPercent, true)}
                </span>
                <span className="row-secondary numeric">
                  {ownedHoldingPercent(holding.unrealisedPercent, true)}
                </span>
                <span className="row-tertiary">
                  Avg{" "}
                  {holding.averageNativeCost === null
                    ? "Basis unavailable"
                    : `${holding.currencyCode} ${ownedHoldingTrimmed(holding.averageNativeCost)}`}{" "}
                  × {ownedHoldingDecimal(holding.quantity, 4)}
                </span>
                <span className="desktop-only holding-name">
                  {holding.name} · {holding.exchange} · {holding.currencyCode}
                </span>
                <span className="sr-only">{holding.explanation}</span>
              </button>
            );
          })}
        </div>
      </section>
      <aside className="portfolio-summary" aria-label="Holdings summary">
        <p className="eyebrow">Cash separate</p>
        <strong>{homeCurrencyCode} reporting values</strong>
        <p>
          Cash is not included in security rows. Price, FX, and basis gaps
          remain unavailable rather than zero.
        </p>
        {cash ? (
          <p>
            Securities subtotal:{" "}
            {cash.securitiesSubtotal === null
              ? "Partial"
              : `${cash.currencyCode} ${ownedHoldingDecimal(cash.securitiesSubtotal)}`}{" "}
            · Cash subtotal:{" "}
            {cash.cashSubtotal === null
              ? "Unavailable"
              : `${cash.currencyCode} ${ownedHoldingDecimal(cash.cashSubtotal)}`}{" "}
            · Known total:{" "}
            {cash.knownTotal === null
              ? "Partial"
              : `${cash.currencyCode} ${ownedHoldingDecimal(cash.knownTotal)}`}
            <br />
            Coverage: {cash.coverage.converted}/{cash.coverage.nonZero} non-zero
            cash accounts converted ({cash.coverage.zero} zero).
            {coverage ? (
              <>
                <br />
                Securities: {coverage.converted}/{coverage.nonZero} non-zero
                converted, {coverage.basis}/{coverage.nonZero} basis-covered (
                {coverage.zero} zero).
              </>
            ) : null}
          </p>
        ) : null}
      </aside>
      {selectedHolding ? (
        <dialog
          ref={dialogRef}
          className="holding-sheet"
          aria-labelledby="owned-holding-sheet-title"
          onCancel={(event) => {
            event.preventDefault();
            dialogRef.current?.close();
            setSelectedHolding(null);
          }}
          onClose={() => setSelectedHolding(null)}
        >
          <button
            className="sheet-close"
            type="button"
            onClick={() => dialogRef.current?.close()}
          >
            Close
          </button>
          <p className="eyebrow">Holding detail</p>
          <h2 id="owned-holding-sheet-title">{selectedHolding.symbol}</h2>
          <p>
            {selectedHolding.name} · {selectedHolding.exchange} ·{" "}
            {selectedHolding.currencyCode}
          </p>
          {selectedHolding.currencyCode !== homeCurrencyCode ? (
            <label className="menu-field">
              <span>Display values</span>
              <select
                value={holdingViews[selectedHolding.id] ?? view}
                aria-label={`Display ${selectedHolding.symbol} values in native or home currency`}
                onChange={(event) =>
                  setHoldingViews((current) => ({
                    ...current,
                    [selectedHolding.id]: event.target.value as
                      "native" | "home",
                  }))
                }
              >
                <option value="native">Native currency</option>
                <option value="home">Home currency</option>
              </select>
            </label>
          ) : null}
          <dl className="detail-facts">
            <div>
              <dt>Quantity</dt>
              <dd>{ownedHoldingDecimal(selectedHolding.quantity, 4)}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>
                {(() => {
                  const selectedView = holdingViews[selectedHolding.id] ?? view;
                  const home =
                    selectedView === "home" &&
                    selectedHolding.homePrice.status === "available";
                  const price = home
                    ? selectedHolding.homePrice
                    : selectedHolding.nativePrice === null
                      ? {
                          status: "unavailable" as const,
                          value: null,
                          currencyCode: selectedHolding.currencyCode,
                        }
                      : {
                          status: "available" as const,
                          value: selectedHolding.nativePrice,
                          currencyCode: selectedHolding.currencyCode,
                        };
                  if (price.status !== "available" || price.value === null)
                    return selectedHolding.nativePrice === null
                      ? "Price unavailable"
                      : `${selectedHolding.currencyCode} native fallback`;
                  try {
                    return `${price.currencyCode} ${ownedHoldingTrimmed(price.value)}${selectedView === "home" && !home ? " · native fallback" : ""}`;
                  } catch {
                    return "Price unavailable";
                  }
                })()}
              </dd>
            </div>
            <div>
              <dt>Value</dt>
              <dd>
                {ownedHoldingAmount(
                  (holdingViews[selectedHolding.id] ?? view) === "home" &&
                    selectedHolding.homeValue.status === "available"
                    ? selectedHolding.homeValue
                    : selectedHolding.nativeValue,
                )}
              </dd>
            </div>
            <div>
              <dt>Gain</dt>
              <dd className={`tone-${selectedHolding.gainTone}`}>
                {ownedHoldingAmount(selectedHolding.unrealisedGain, 2, true)}
              </dd>
            </div>
            <div>
              <dt>Daily %</dt>
              <dd className={`tone-${selectedHolding.dailyTone}`}>
                {ownedHoldingPercent(selectedHolding.dailyPercent, true)}
              </dd>
            </div>
            <div>
              <dt>Unrealised %</dt>
              <dd className={`tone-${selectedHolding.gainTone}`}>
                {ownedHoldingPercent(selectedHolding.unrealisedPercent, true)}
              </dd>
            </div>
            <div>
              <dt>Average cost × quantity</dt>
              <dd>
                {selectedHolding.averageNativeCost === null
                  ? "Basis unavailable"
                  : `${selectedHolding.currencyCode} ${ownedHoldingTrimmed(selectedHolding.averageNativeCost)} × ${ownedHoldingDecimal(selectedHolding.quantity, 4)}`}
              </dd>
            </div>
          </dl>
          <p className="detail-explanation">{selectedHolding.explanation}</p>
          {portfolioId ? (
            <p>
              {/* UI-016: the sheet is a real showModal() top-layer dialog
                  (see the `.sheet-back`/QuotesScreen precedent above) --
                  leaving it open while the client router's async RSC
                  transition swaps in the dividends page left the new page
                  rendering underneath a still-open top-layer element, so
                  the click looked dead. Close the dialog synchronously on
                  activation (before Link's own async navigate runs) and
                  keep a real `href` so the anchor still works with JS
                  disabled. Styled as a visible action (`.sheet-back`),
                  not a trailing word.

                  Review follow-up (c): a modified click (cmd/ctrl/shift/
                  alt, or a non-primary button such as a middle click) is
                  the browser's own "open in a new tab/window" gesture --
                  Link's OWN handler already skips its SPA navigate for
                  exactly this case (`vinext/dist/shims/link.js`'s
                  `e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey ||
                  e.altKey` guard) and lets the native browser action open a
                  second tab while THIS tab's sheet stays put. Mirror the
                  identical guard here so this dialog does not close (and
                  the sheet does not vanish) out from under an owner who
                  never left the current tab. */}
              <Link
                className="sheet-back"
                href={`/portfolio/${portfolioId}/securities/${selectedHolding.id}/dividends`}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  dialogRef.current?.close();
                }}
              >
                View dividends
              </Link>
            </p>
          ) : null}
        </dialog>
      ) : null}
    </div>
  );
}

function OwnedWorkspaceScreen({
  activeSection,
  workspace,
}: {
  activeSection: PortfolioSection;
  workspace: OwnedWorkspace;
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
    return (
      <>
        <EmptyState
          title="No portfolios yet"
          message="Create a portfolio to begin tracking holdings and history."
          showAction={false}
        />
        <AccountLifecycleControls />
      </>
    );
  }

  const titles: Record<PortfolioSection, string> = {
    overview: "No holdings yet",
    holdings: "No holdings yet",
    quotes: "No quotes yet",
    details: "No valuation history yet",
    news: "News is not connected yet",
  };
  const messages: Record<PortfolioSection, string> = {
    overview:
      "This portfolio is ready. Holdings and valuations will appear after ledger data is added.",
    holdings: "Import or add a holding when portfolio entry is available.",
    quotes: "Validated market observations will appear here when available.",
    details: "Historical valuation data will appear here when available.",
    news: "YieldToMe does not provide investment news in this release.",
  };

  return (
    <EmptyState
      title={titles[activeSection]}
      message={messages[activeSection]}
      showAction={false}
    />
  );
}

function overviewDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return `${date.slice(8)} ${new Date(`${date}T00:00:00Z`).toLocaleDateString(
    "en-AU",
    { month: "short", timeZone: "UTC" },
  )}`;
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
}: {
  data: OwnedOverviewData;
  portfolioId: string;
  portfolioName: string;
  financialYearStartMonth: number;
  timezone: string;
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

  if (data.status === "unavailable") {
    return (
      <section
        className="empty-state"
        aria-labelledby="overview-unavailable-title"
      >
        <p className="eyebrow">Private workspace</p>
        <h1 id="overview-unavailable-title">Overview unavailable</h1>
        <p>Published valuation data could not be loaded. Try again shortly.</p>
      </section>
    );
  }

  if (data.status === "empty" || current === null) {
    return (
      <EmptyState
        title="No valuation history yet"
        message="Add posted transactions and validated market observations to publish portfolio value."
        showAction={false}
      />
    );
  }

  return (
    <div className="overview-screen owned-overview">
      {stateCopy ? (
        <p className="status-banner warning" role="status">
          <strong>
            {data.status === "stale"
              ? "Stale coverage"
              : data.status === "incomplete" && current?.value === null
                ? "Value unavailable"
                : "Known value"}
          </strong>
          <span>{stateCopy}</span>
        </p>
      ) : null}
      <section className="overview-hero" aria-labelledby="owned-overview-title">
        <div>
          <p className="eyebrow">
            {portfolioName} · {data.currencyCode}
          </p>
          <h1 id="owned-overview-title">
            {current.value ?? "Value unavailable"}
          </h1>
          <p className="overview-movement">
            <span
              className={
                current.daily === null
                  ? "muted-copy"
                  : current.daily.startsWith("−")
                    ? "tone-negative"
                    : "tone-positive"
              }
            >
              {current.daily === null
                ? "Daily movement unavailable"
                : `${current.daily} today · Percentage unavailable`}
            </span>
            <span>as of {overviewDate(current.date)}</span>
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
  activeKey: T;
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
  viewState,
  onOpenPortfolio,
}: {
  portfolio?: PortfolioPrototype;
  rows: readonly OverviewRow[];
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
                    Price unavailable
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

  async function loadHistory() {
    setHistoryOpen(true);
    if (readOnly) {
      setActionMessage("Preview data has no correction history to display.");
      return;
    }
    setHistoryPending(true);
    try {
      const query = new URLSearchParams({ portfolioId });
      const response = await fetch(`/api/market-data/overrides?${query}`);
      const result = (await response.json()) as {
        ok: boolean;
        overrides?: typeof history;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Correction history is unavailable.");
      setHistory(result.overrides ?? []);
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Correction history is unavailable.",
      );
    } finally {
      setHistoryPending(false);
    }
  }

  async function revokeCorrection(id: string) {
    setHistoryPending(true);
    try {
      const response = await fetch("/api/market-data/overrides", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overrideId: id }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(
          result.message ?? "The correction could not be removed.",
        );
      setActionMessage(
        "Correction revoked; the underlying provider value can be selected again.",
      );
      await loadHistory();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "The correction could not be removed.",
      );
    } finally {
      setHistoryPending(false);
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
          <button type="button" onClick={() => void loadHistory()}>
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
        <section
          className="quote-history"
          aria-labelledby="quote-history-title"
        >
          <div className="quote-history-heading">
            <h2 id="quote-history-title">Correction history</h2>
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              aria-label="Close correction history"
            >
              Close
            </button>
          </div>
          {historyPending ? (
            <p role="status">Loading correction history…</p>
          ) : null}
          {!historyPending && history.length === 0 ? (
            <p className="muted-copy">
              No owner-entered corrections are recorded.
            </p>
          ) : null}
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <span>
                  <strong>
                    {item.type === "fx_rate" ? "FX rate" : "Price"}
                  </strong>
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
                  {unavailable ? "Price unavailable" : quote.price}
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

function QuoteCorrectionDialog({
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
          <strong>{unavailable ? "Price unavailable" : holding.price}</strong>
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
            <dd>{unavailable ? "Price unavailable" : holding.value}</dd>
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
                ? "Price unavailable"
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
  overviewHref = "/",
  holdingSymbol = null,
  ownedWorkspace,
  ownedDetails = null,
}: {
  activeSection: PortfolioSection;
  reviewBadgeLabel?: string;
  reviewNote?: string;
  portfolioPrototypesOverride?: readonly PortfolioPrototype[] | null;
  overviewHref?: string;
  holdingSymbol?: string | null;
  ownedWorkspace?: OwnedWorkspace;
  ownedDetails?: PortfolioInspection | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const portfolios = portfolioPrototypesOverride ?? portfolioPrototypes;
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
  const overviewPortfolioRows = portfolioPrototypesOverride
    ? portfolios.map(overviewRowFromPortfolio)
    : overviewRows;

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

        <Link className="topbar-brand" href="/" aria-label="YieldToMe overview">
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
              <Link href="/" onClick={() => setOpenMenu(null)}>
                <span>All portfolios</span>
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          ) : null}
        </div>

        <span className="prototype-chip desktop-only">
          {ownedMode
            ? `${ownedWorkspace.homeCurrencyCode ?? "AUD"} workspace`
            : reviewBadgeLabel}
        </span>

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

      <p className="prototype-chip mobile-only">
        {ownedMode
          ? `${ownedWorkspace.homeCurrencyCode ?? "AUD"} workspace`
          : reviewBadgeLabel}
      </p>

      <nav className="primary-tabs" aria-label="Portfolio sections">
        {primaryPortfolioSections.map((section) => (
          <Link
            key={section}
            href={
              ownedMode
                ? ownedWorkspace.activePortfolio
                  ? `/portfolio/${ownedWorkspace.activePortfolio.id}/${section}`
                  : "/"
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
              coverage={ownedWorkspace.holdingCoverage}
              portfolioId={ownedWorkspace.activePortfolio.id}
            />
          ) : (
            <OwnedWorkspaceScreen
              activeSection={activeSection}
              workspace={ownedWorkspace}
            />
          )
        ) : null}
        {!ownedMode && activeSection === "overview" ? (
          <OverviewScreen
            portfolio={portfolioPrototypesOverride ? portfolio : undefined}
            rows={overviewPortfolioRows}
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
        {ownedMode &&
        activeSection === "quotes" &&
        ownedWorkspace.activePortfolio ? (
          <QuotesScreen
            portfolio={null}
            ownedQuotes={ownedWorkspace.quotes ?? []}
            portfolioId={ownedWorkspace.activePortfolio.id}
            readOnly={false}
            viewState={ownedWorkspace.quoteViewState ?? "empty"}
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
              <Link href="/" onClick={() => setDrawerOpen(false)}>
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
            <Link href="/" onClick={() => setDrawerOpen(false)}>
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
