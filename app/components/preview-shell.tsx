"use client";

// PRF-014 step 2b: the preview/prototype experience, extracted verbatim out
// of `portfolio-shell.tsx` (see TASKS.md's PRF-014 step-2 scoping). This
// subtree -- `PortfolioSummary`, `OverviewScreen`, `HoldingsScreen`,
// `DetailsScreen`, `NewsScreen`, `HoldingSheet`, `StatusBanner`, and the
// preview-only ~330 lines that used to live inside `PortfolioShell` itself
// (the `portfolioPrototypesOverride`/`historyBarsOverride` branches,
// `selectedHolding`/the prototype-state popover/the HoldingSheet mount) --
// is dead code on every production (owned) route: only the two preview
// route branches below ever render it. Moving it into its own "use client"
// module means the owned production bundle no longer statically references
// any of it (previously it was reachable-but-dead from every owned page,
// which is not a stable bundler contract to rely on for keeping it out of
// the client chunk -- see tests/prf-014.test.ts's own reasoning for why a
// SOURCE guard, not a bundle-grep, is the primary guard here).
//
// `SortButton`, `ToneValue`, `EmptyState`, and `QuotesScreen` stay defined
// in `portfolio-shell.tsx` instead of moving here: the first three are
// shared with the OWNED screens' own sorters/tone-coloured values/empty
// states, and `QuotesScreen` sits directly beside (and MKT-014 explicitly
// keeps it beside) `QuoteCorrectionHistory`/`QuoteCorrectionDialog`, which
// `app/components/holding-detail.tsx`'s owned per-holding market-data panel
// reuses -- see that file's own comment. This module imports all four from
// there instead of forking copies.
//
// Callers: `app/portfolio/[portfolioId]/[section]/page.tsx`'s and its
// `[holdingId]` sibling's `portfolioId === "preview"` branches. Discriminated
// from `PortfolioShell`: this component takes `portfolioPrototypesOverride`
// (required) and never `ownedWorkspace`.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { rememberPrimaryTab } from "../last-primary-tab";
import { useEffect, useMemo, useRef, useState } from "react";
// PRF-014 step 1/2b: only TYPES from ../prototype-data (erased at build
// time) -- see portfolio-shell.tsx's own header comment and
// tests/prf-014.test.ts's "use client" walker, which covers this file too.
// The preview routes import the runtime fixture values themselves and pass
// them down as props.
import { type Holding, type PortfolioPrototype } from "../prototype-data";
import { type PortfolioSection } from "../portfolio-sections";
import {
  compactAmount,
  type Direction,
  type HoldingSort,
  type OpenMenu,
  type OverviewRow,
  overviewRowFromPortfolio,
  primaryPortfolioSections,
  prototypeStateLabels,
  sectionHref,
  sortByExactKey,
  type ViewState,
  wholeDollarAmount,
} from "./portfolio-shell-model";
import { BrandMark } from "./brand-mark";
import { ServiceWorkerRegistration } from "./service-worker-registration";
// See the file header above for why these four stay defined in
// portfolio-shell.tsx rather than moving here.
import {
  EmptyState,
  QuotesScreen,
  SortButton,
  ToneValue,
} from "./portfolio-shell";

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

export function PreviewShell({
  activeSection,
  reviewBadgeLabel = "Prototype · mock data",
  reviewNote = "Static review build · local mock data · no financial writes",
  portfolioPrototypesOverride,
  historyBarsOverride = [],
  overviewHref = "/",
  holdingSymbol = null,
}: {
  activeSection: PortfolioSection;
  reviewBadgeLabel?: string;
  reviewNote?: string;
  portfolioPrototypesOverride: readonly PortfolioPrototype[];
  /** PRF-014 step 1: the preview route's demo history-chart bars
   * (`historyBars` in `../prototype-data`), passed in by the caller so this
   * "use client" module never imports the fixture module's runtime values.
   */
  historyBarsOverride?: readonly string[];
  overviewHref?: string;
  holdingSymbol?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // UI-048: mirrors PortfolioShell's own identical effect -- see its
  // comment for why recording the pathname here is safe/correct.
  useEffect(() => {
    if (pathname !== null) rememberPrimaryTab(pathname);
  }, [pathname]);

  const portfolios = portfolioPrototypesOverride;
  const selectorItems = portfolios.map((item) => ({
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

  const portfolio =
    portfolios.find((item) => item.id === portfolioId) ?? portfolios[0];
  const overviewPortfolioRows = portfolios.map(overviewRowFromPortfolio);

  function selectPortfolio(nextId: string) {
    setPortfolioId(nextId);
    setOpenMenu(null);
    setDrawerOpen(false);
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

        {/* PRF-004/PRF-006 (mirrors PortfolioShell's own identical links):
            `prefetch={false}` stops vinext's auto-prefetch from re-fetching
            `/` on every mount of this always-in-viewport link/popover --
            see portfolio-shell.tsx's topbar-brand comment for the full
            history. Preview mode's overview target is always `/`. */}
        <Link
          className="topbar-brand"
          href="/"
          aria-label="YieldToMe overview"
          prefetch={false}
        >
          <BrandMark />
          <span className="wordmark">YieldToMe</span>
        </Link>

        <div className="menu-anchor portfolio-anchor">
          <button
            className="portfolio-button"
            type="button"
            aria-expanded={openMenu === "portfolio"}
            onClick={() =>
              setOpenMenu((current) =>
                current === "portfolio" ? null : "portfolio",
              )
            }
          >
            <span>{portfolio?.name ?? "No portfolios"}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          {openMenu === "portfolio" ? (
            <div className="popover portfolio-popover">
              <p>Portfolios</p>
              {selectorItems.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={item.id === portfolioId}
                  onClick={() => selectPortfolio(item.id)}
                >
                  <span>{item.name}</span>
                  {item.id === portfolioId ? (
                    <span aria-hidden="true">✓</span>
                  ) : null}
                </button>
              ))}
              <Link href="/" onClick={() => setOpenMenu(null)} prefetch={false}>
                <span>All portfolios</span>
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          ) : null}
        </div>

        <span className="prototype-chip desktop-only">{reviewBadgeLabel}</span>

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
                <p>Prototype actions</p>
                <button type="button">
                  <span>Add holding</span>
                  <small>UI only</small>
                </button>
                <button type="button">
                  <span>Add transaction</span>
                  <small>UI only</small>
                </button>
                <button type="button">
                  <span>Import CSV</span>
                  <small>Not connected</small>
                </button>
              </div>
            ) : null}
          </div>
          <div className="menu-anchor">
            <button
              className="icon-button"
              type="button"
              aria-label="Open prototype state menu"
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
                <p>Preview a state</p>
                {(Object.keys(prototypeStateLabels) as ViewState[]).map(
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

      <p className="prototype-chip mobile-only">{reviewBadgeLabel}</p>

      <nav className="primary-tabs" aria-label="Portfolio sections">
        {primaryPortfolioSections.map((section) => (
          <Link
            key={section}
            href={sectionHref(section, overviewHref)}
            aria-current={activeSection === section ? "page" : undefined}
          >
            {section}
          </Link>
        ))}
      </nav>

      <StatusBanner
        viewState={viewState}
        onReset={() => setViewState("populated")}
      />

      <main className={`screen-content screen-${activeSection}`}>
        {activeSection === "overview" ? (
          <OverviewScreen
            portfolio={portfolio}
            rows={overviewPortfolioRows}
            historyBars={historyBarsOverride}
            viewState={viewState}
            onOpenPortfolio={(id) => {
              selectPortfolio(id);
              router.push("/portfolio/preview/holdings");
            }}
          />
        ) : null}
        {activeSection === "holdings" ? (
          <HoldingsScreen
            portfolio={portfolio}
            viewState={viewState}
            onSelectHolding={(holding, unavailable) => {
              setSelectedHolding(holding);
              setSelectedHoldingUnavailable(unavailable);
            }}
            holdingDetailHref={(symbol) =>
              `/portfolio/preview/holdings/${encodeURIComponent(symbol)}`
            }
          />
        ) : null}
        {activeSection === "quotes" ? (
          <QuotesScreen
            portfolio={portfolio}
            portfolioId={portfolio.id}
            readOnly={true}
            viewState={viewState}
          />
        ) : null}
        {activeSection === "details" ? (
          <DetailsScreen portfolio={portfolio} viewState={viewState} />
        ) : null}
        {activeSection === "news" ? <NewsScreen /> : null}
      </main>

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
              <Link
                href="/"
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
              href="/"
              onClick={() => setDrawerOpen(false)}
              prefetch={false}
            >
              Overview
            </Link>
            <p className="drawer-label">Portfolios</p>
            {selectorItems.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={item.id === portfolioId}
                onClick={() => selectPortfolio(item.id)}
              >
                <span>{item.name}</span>
                {item.id === portfolioId ? <span>Selected</span> : null}
              </button>
            ))}
            <p className="drawer-label">Manage</p>
            <button type="button">
              <span>Import / export</span>
              <small>Prototype only</small>
            </button>
            <button type="button">
              <span>Settings</span>
              <small>Prototype only</small>
            </button>
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
