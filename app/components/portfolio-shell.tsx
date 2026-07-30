"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  historyBars,
  overviewRows,
  portfolioPrototypes,
  type Holding,
  type PortfolioPrototype,
  type Tone,
} from "../prototype-data";
import { BrandMark } from "./brand-mark";
import { ServiceWorkerRegistration } from "./service-worker-registration";

export const portfolioSections = [
  "overview",
  "holdings",
  "quotes",
  "details",
  "news",
] as const;

export type PortfolioSection = (typeof portfolioSections)[number];
export type OwnedWorkspace = {
  status: "ready" | "empty" | "unavailable";
  userDisplayName?: string | null;
  homeCurrencyCode?: string | null;
  holdingCurrencyView?: "native" | "home";
  settingsVersion?: number;
  message?: string;
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

function OwnedWorkspaceScreen({
  activeSection,
  workspace,
}: {
  activeSection: PortfolioSection;
  workspace: OwnedWorkspace;
}) {
  if (workspace.status === "unavailable") {
    return (
      <section className="empty-state" aria-labelledby="workspace-error-title">
        <p className="eyebrow">Private workspace</p>
        <h1 id="workspace-error-title">Portfolio data unavailable</h1>
        <p>{workspace.message ?? "Try again shortly."}</p>
      </section>
    );
  }

  if (workspace.status === "empty" || workspace.activePortfolio === null) {
    return (
      <EmptyState
        title="No portfolios yet"
        message="Create a portfolio to begin tracking holdings and history."
        showAction={false}
      />
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
  viewState,
}: {
  portfolio: PortfolioPrototype;
  viewState: ViewState;
}) {
  const [sortKey, setSortKey] = useState<QuoteSort>("change");
  const [direction, setDirection] = useState<Direction>("descending");

  const rows = useMemo(() => {
    if (sortKey === "ticker") {
      return [...portfolio.quotes].sort((left, right) => {
        const compared = left.symbol.localeCompare(right.symbol);
        return direction === "ascending" ? compared : -compared;
      });
    }
    return sortByExactKey(
      portfolio.quotes,
      (quote) => quote.sort[sortKey],
      direction,
    );
  }, [direction, portfolio.quotes, sortKey]);

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

  if (viewState === "empty") {
    return (
      <EmptyState
        title="No quotes yet"
        message="Add securities to watch without creating a holding."
      />
    );
  }

  return (
    <section className="quotes-screen" aria-label="Portfolio quotes">
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
      {rows.map((quote, index) => {
        const unavailable =
          viewState === "partial" && index === rows.length - 1;
        return (
          <button
            className="quote-row quotes-grid"
            type="button"
            key={quote.symbol}
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
            <span className="row-secondary numeric">{quote.marketDate}</span>
            <ToneValue
              tone={unavailable ? "neutral" : quote.tone}
              className="row-secondary numeric"
            >
              {unavailable ? "—" : quote.percent}
            </ToneValue>
          </button>
        );
      })}
      {viewState === "provider-error" ? (
        <p className="data-explanation">
          Last known observations remain visible. Exact source and observation
          times are available in the row explanation, not repeated here.
        </p>
      ) : null}
    </section>
  );
}

function DetailsScreen({
  portfolio,
  viewState,
}: {
  portfolio: PortfolioPrototype;
  viewState: ViewState;
}) {
  const periods = ["1W", "1M", "3M", "6M", "YTD", "1Y", "Max"];
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
}: {
  activeSection: PortfolioSection;
  reviewBadgeLabel?: string;
  reviewNote?: string;
  portfolioPrototypesOverride?: readonly PortfolioPrototype[] | null;
  overviewHref?: string;
  holdingSymbol?: string | null;
  ownedWorkspace?: OwnedWorkspace;
}) {
  const router = useRouter();
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
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

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
    if (!ownedWorkspace) return;
    const form = new FormData(event.currentTarget);
    const isRename = portfolioDialog === "rename";
    const endpoint = isRename
      ? `/api/portfolios/${ownedWorkspace.activePortfolio?.id ?? ""}`
      : "/api/portfolios";
    setActionPending(true);
    setActionMessage(null);
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
      });
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
        portfolio?: { id: string };
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Portfolio action failed.");
      setPortfolioDialog(null);
      router.refresh();
      if (!isRename && result.portfolio)
        router.push(`/portfolio/${result.portfolio.id}/overview`);
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "Portfolio action failed.",
      );
    } finally {
      setActionPending(false);
    }
  }

  async function changeHomeCurrency(value: string) {
    if (!ownedWorkspace?.settingsVersion) return;
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
    if (!ownedWorkspace?.settingsVersion) return;
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

  async function archiveActivePortfolio() {
    const active = ownedWorkspace?.activePortfolio;
    if (!active) return;
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
          onClick={() => setDrawerOpen(true)}
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
                    disabled={actionPending}
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
                    onClick={() => setPortfolioDialog("create")}
                  >
                    <span>Create portfolio</span>
                    <span aria-hidden="true">+</span>
                  </button>
                  {ownedWorkspace.activePortfolio ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setPortfolioDialog("rename")}
                      >
                        <span>Rename portfolio</span>
                      </button>
                      <button
                        type="button"
                        onClick={archiveActivePortfolio}
                        disabled={actionPending}
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
                        disabled={actionPending}
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
                        disabled={actionPending}
                      >
                        <option value="native">Native currency</option>
                        <option value="home">Home currency</option>
                      </select>
                    </label>
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
      </nav>

      <StatusBanner
        viewState={viewState}
        onReset={() => setViewState("populated")}
      />

      <main className={`screen-content screen-${activeSection}`}>
        {ownedMode ? (
          <OwnedWorkspaceScreen
            activeSection={activeSection}
            workspace={ownedWorkspace}
          />
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
          <QuotesScreen portfolio={portfolio} viewState={viewState} />
        ) : null}
        {!ownedMode && activeSection === "details" ? (
          <DetailsScreen portfolio={portfolio} viewState={viewState} />
        ) : null}
        {!ownedMode && activeSection === "news" ? <NewsScreen /> : null}
      </main>

      {actionMessage ? (
        <p className="action-feedback" role="alert">
          {actionMessage}
        </p>
      ) : null}

      {ownedMode && portfolioDialog ? (
        <dialog
          open
          className="portfolio-dialog"
          aria-labelledby="portfolio-dialog-title"
        >
          <form method="dialog" onSubmit={submitPortfolioAction}>
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
                onClick={() => setPortfolioDialog(null)}
                disabled={actionPending}
              >
                Cancel
              </button>
              <button type="submit" disabled={actionPending}>
                {actionPending ? "Working…" : "Save portfolio"}
              </button>
            </div>
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
          >
            <div className="drawer-heading">
              <Link href="/" onClick={() => setDrawerOpen(false)}>
                <BrandMark />
                <span className="wordmark">YieldToMe</span>
              </Link>
              <button
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
                  disabled={actionPending}
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
