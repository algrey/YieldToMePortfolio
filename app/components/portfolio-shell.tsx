"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { rememberPrimaryTab } from "../last-primary-tab";
import { useEffect, useMemo, useRef, useState } from "react";
// PRF-014 step 1: this file is "use client", so a runtime (value) import
// from ../prototype-data would ship all 447 lines of preview/demo fixture
// data (historyBars/overviewRows/portfolioPrototypes) in every production
// client bundle, even though none of it is reachable outside the
// `_sites-preview`/`/portfolio/preview/*` fixture routes -- every real
// caller (app/page.tsx, [section]/page.tsx, [holdingId]/page.tsx) passes
// either `ownedWorkspace` or `portfolioPrototypesOverride`, never neither.
// Only TYPES are imported here (erased at build time); the preview routes
// import the runtime values themselves and pass them down as props.
import { type PortfolioPrototype } from "../prototype-data";
import {
  quoteDisplayState,
  quoteExplanation,
  type QuoteRow,
} from "../quote-contract";
import { watchlistExplanation, type WatchlistRow } from "../watchlist-contract";
import type { PortfolioInspection } from "../../db/repositories/portfolio-inspection";
import { BrandMark } from "./brand-mark";
import { OwnedPortfolioDetails } from "./portfolio-details";
import { ServiceWorkerRegistration } from "./service-worker-registration";
import {
  sortOwnedHoldings,
  type OwnedCashSummary,
  type OwnedHoldingRow,
  type ProjectionPendingState,
} from "../owned-holdings-contract";
import {
  ownedHoldingAmount,
  ownedHoldingDecimalNeverFakeZero,
  ownedHoldingHiddenSoldCount,
  ownedHoldingPercent,
  ownedHoldingQuantity,
  ownedHoldingQuantityIsZero,
  ownedHoldingRealisedGainLine,
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
import { type PortfolioSection } from "../portfolio-sections";
// PRF-014 step 2a: the pure DTO types and pure helper functions that used
// to live inline here (no JSX, no hooks) now live in this plain (non
// "use client") sibling module -- see its header comment. Re-exporting the
// already-exported DTO types keeps every existing `from "./portfolio-shell"`
// importer (tests, portfolio-value-chart.tsx) working unchanged.
import {
  financialYearWindowHelperText,
  FY_MONTH_NAMES,
  isAbortError,
  type OwnedOverviewData,
  type OwnedOverviewPoint,
  type OwnedPortfolioValueHistory,
  type OwnedPortfolioValueHistoryPoint,
  type OwnedWorkspace,
  ownedNoPortfolioHref,
  type Direction,
  type OpenMenu,
  primaryPortfolioSections,
  type QuoteSort,
  sortByExactKey,
  type ViewState,
} from "./portfolio-shell-model";
// PRF-014 step 2c: the zero-hook leaves (see that module's own header
// comment) -- `ToneValue`/`EmptyState` are re-exported below under their
// original names so every existing `from "./portfolio-shell"` importer
// (preview-shell.tsx, tests) keeps working unchanged; `HoldingsSummaryFooterRow`
// and `OwnedWorkspaceScreen` are used only inside this file, at the call
// sites their own comments in that module describe.
import {
  EmptyState,
  HoldingsSummaryFooterRow,
  OwnedWorkspaceScreen,
  ToneValue,
} from "./portfolio-shell-leaves";
import {
  HideSoldToggle,
  OverviewRangeSelector,
} from "./portfolio-shell-client-leaves";

// Type-only re-export for existing callers (e.g. the holding-detail route)
// -- safe across the client boundary because types are erased at compile
// time. The RUNTIME `portfolioSections` array lives in `../portfolio-sections`
// and is intentionally NOT imported/re-exported here: server components must
// import it straight from that shared module rather than through this
// "use client" file, which would turn it back into an opaque client
// reference (see that module's comment for the concrete failure this
// caused).
export { type PortfolioSection };
// PRF-014 step 2a: re-export the DTO types that were already exported from
// this file before the extraction (portfolio-value-chart.tsx and
// tests/ui-002.test.ts import OwnedPortfolioValueHistory/OwnedOverviewPoint
// directly from "./portfolio-shell") -- type-only, erased at build time.
export type {
  OwnedOverviewData,
  OwnedOverviewPoint,
  OwnedPortfolioValueHistory,
  OwnedPortfolioValueHistoryPoint,
  OwnedWorkspace,
};
// PRF-014 step 2c: re-export -- these two are now DEFINED in
// portfolio-shell-leaves.tsx (see that module's header comment), but
// preview-shell.tsx and several tests still import them `from
// "./portfolio-shell"`, so the public surface of this module is unchanged.
export { EmptyState, ToneValue };

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
            hideSoldToggle={
              <HideSoldToggle
                hideSold={hideSold}
                onToggleHideSold={() => setHideSold((current) => !current)}
              />
            }
          />
        ) : null}
      </section>
    </div>
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

// PRF-014 step 2d: `OwnedOverviewScreen` moved out of this file --
// `portfolio-shell-client-leaves.tsx`'s `OverviewRangeSelector` now owns
// the one piece of client state it ever held (the history chart's `range`)
// and renders `portfolio-shell-overview.tsx`'s `OwnedOverviewScreenBody`
// (the plain, server-renderable render body) as its child. See both
// modules' own header comments. The call site below renders
// `OverviewRangeSelector` directly, with an unchanged prop list.

// PRF-014 step 2b: `PortfolioSummary` moved to `preview-shell.tsx` -- its
// only caller was the preview-mode `HoldingsScreen`, also moved there.
//
// PRF-014 step 2b: exported (rather than moved) -- shared with the owned
// holdings/watchlist sorters as well as preview-shell.tsx's HoldingsScreen.
export function SortButton<T extends string>({
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

// PRF-014 step 2b: `OverviewScreen` moved to `preview-shell.tsx` -- its only
// caller was the preview-mode `PortfolioShell` render (`!ownedMode &&
// activeSection === "overview"`), never reachable from an owned route.

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

// PRF-014 step 2b: exported so preview-shell.tsx's PreviewShell (the only
// remaining caller of the preview-mode branch below) can render this --
// see the MKT-014 comment above QuoteCorrectionHistory for why this stays
// defined here rather than moving out with the other preview screens.
export function QuotesScreen({
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

// PRF-014 step 2b: `DetailsScreen`, `NewsScreen`, and `HoldingSheet` moved
// to `preview-shell.tsx` -- each was reachable only from the preview-mode
// branches of the old `PortfolioShell` render below, never from an owned
// route. `PortfolioShell` itself is now owned-only: `ownedWorkspace` is
// required and the preview-only props/state/branches (`portfolioPrototypesOverride`,
// `historyBarsOverride`, `holdingSymbol`, `viewState`'s prototype-state
// simulator, the `selectedHolding`/`HoldingSheet` mount, the portfolio
// dialog's now-impossible "no ownedWorkspace" path) moved to
// `preview-shell.tsx`'s `PreviewShell`, the discriminated preview
// counterpart of this component.
export function PortfolioShell({
  activeSection,
  reviewNote = "Static review build · local mock data · no financial writes",
  ownedWorkspace,
  ownedDetails = null,
  initialHideSold = true,
}: {
  activeSection: PortfolioSection;
  // Rendered unconditionally in the navigation drawer below; no owned route
  // has ever overridden this default (only the retired preview call sites
  // did -- see preview-shell.tsx's own `reviewNote`), so it is not a
  // preview-only prop despite the "prototype"-sounding copy in its default.
  // Left exactly as-is (PRF-014 step 2b is a boundary move, not a content
  // fix): pre-existing, out of this task's scope.
  reviewNote?: string;
  ownedWorkspace: OwnedWorkspace;
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
  const selectorItems = ownedWorkspace.portfolios;
  // PRF-014 step 2b: this used to derive from the (now-removed)
  // `portfolioPrototypesOverride`/`holdingSymbol` preview props, which were
  // always absent for every owned caller -- so this literal "aus-stocks"
  // fallback was already the ONLY value this could ever initialise to in
  // owned mode. `selectPortfolio` below still updates it on selection.
  const [portfolioId, setPortfolioId] = useState("aus-stocks");
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenerRef = useRef<HTMLButtonElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
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

  function selectPortfolio(nextId: string) {
    setPortfolioId(nextId);
    setOpenMenu(null);
    setDrawerOpen(false);
    router.push(`/portfolio/${nextId}/${activeSection}`);
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
            ownedWorkspace.activePortfolio
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
              {ownedWorkspace?.activePortfolio?.name ?? "No portfolios"}
            </span>
            <span aria-hidden="true">⌄</span>
          </button>
          {openMenu === "portfolio" ? (
            <div className="popover portfolio-popover">
              <p>Portfolios</p>
              {selectorItems.map((item) =>
                item.status === "archived" ? (
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
              <button
                type="button"
                onClick={() => {
                  portfolioDialogOpenerRef.current = portfolioButtonRef.current;
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
                  ownedWorkspace.activePortfolio
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

        <span className="fx-rate-pill">
          USD/AUD <strong>{ownedWorkspace.usdAudRate ?? "unavailable"}</strong>
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
                <p>Workspace actions</p>
                {ownedWorkspace.activePortfolio ? (
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
                ) : null}
                <Link href="/import" onClick={() => setOpenMenu(null)}>
                  <span>Import CSV</span>
                  <small>Resolve &amp; commit</small>
                </Link>
              </div>
            ) : null}
          </div>
          <div className="menu-anchor">
            <button
              className="icon-button"
              type="button"
              aria-label="Open account menu"
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
                    Preferred source for prices, with honest fallback when it
                    has none.
                  </span>
                </div>
                <div className="menu-field">
                  <label htmlFor="daily-capture-source-select">
                    Daily capture source
                  </label>
                  <select
                    id="daily-capture-source-select"
                    value={ownedWorkspace.dailyCaptureSource ?? "sharesight"}
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
                  <span className="menu-note" id="daily-capture-source-helper">
                    Source for the daily intraday price sweep that closes each
                    trading day&apos;s history.
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
                    How often the intraday sweep captures a price during market
                    hours.
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <nav className="primary-tabs" aria-label="Portfolio sections">
        {primaryPortfolioSections.map((section) => (
          <Link
            key={section}
            href={
              ownedWorkspace.activePortfolio
                ? `/portfolio/${ownedWorkspace.activePortfolio.id}/${section}`
                : ownedNoPortfolioHref(section)
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
        {ownedWorkspace.activePortfolio ? (
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

      <main className={`screen-content screen-${activeSection}`}>
        {activeSection === "details" && ownedWorkspace.activePortfolio ? (
          <OwnedPortfolioDetails
            inspection={ownedDetails}
            onOpenSettings={() => setOpenMenu("prototype")}
          />
        ) : activeSection === "overview" && ownedWorkspace.activePortfolio ? (
          <OverviewRangeSelector
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
            holdingsProjectionPending={ownedWorkspace.holdingsProjectionPending}
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
            // PRF-014 step 2c: OwnedWorkspaceScreen (portfolio-shell-leaves.tsx)
            // no longer holds OwnedWatchlistScreen's props itself -- see
            // that function's own comment for why (avoiding a circular
            // module import between this "use client" file and the
            // non-client leaves module). Built once, reused for both of
            // OwnedWorkspaceScreen's "quotes" branches.
            quotesScreen={
              <OwnedWatchlistScreen
                rows={ownedWorkspace.quotes ?? []}
                viewState={ownedWorkspace.quoteViewState ?? "empty"}
                isOnline={isOnline}
              />
            }
            // PRF-014 step 2c: was threaded into OwnedWorkspaceScreen as
            // `onCreatePortfolio`/`createPortfolioDisabled` and built into
            // an `<EmptyState action={{...}}>` INSIDE that function -- a
            // plain closure can't cross a real server/client boundary, so
            // the finished element is now built here instead (still
            // "use client", where `portfolioDialogOpenerRef`/
            // `setPortfolioDialog`/`actionPending`/`isOnline` actually
            // live) and handed down whole. Rendered HTML is unchanged.
            createPortfolioAction={
              <EmptyState
                title="No portfolios yet"
                message="Create a portfolio to begin tracking holdings and history."
                action={{
                  label: "Create a new portfolio",
                  // UI-021 (owner-reported): mirrors the header dropdown's
                  // "Create portfolio" item exactly
                  // (`portfolioDialogOpenerRef.current = ...;
                  // setPortfolioDialog("create")`) -- one dialog, two
                  // openers. Unlike the dropdown item (which unmounts the
                  // instant its popover closes, forcing it to capture a
                  // DIFFERENT surviving node), this empty-state button
                  // itself stays mounted while the dialog is open, so it
                  // captures itself as the opener.
                  onClick: (event) => {
                    portfolioDialogOpenerRef.current = event.currentTarget;
                    setPortfolioDialog("create");
                  },
                  disabled: actionPending || !isOnline,
                }}
              />
            }
          />
        )}
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

      {portfolioDialog ? (
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
                  ownedWorkspace.activePortfolio
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
                ownedWorkspace.activePortfolio
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
              item.status === "archived" ? (
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
            <button
              type="button"
              onClick={() => {
                setDrawerOpen(false);
                setOpenMenu("prototype");
              }}
            >
              <span>Settings</span>
            </button>
            <p className="drawer-note">{reviewNote}</p>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
