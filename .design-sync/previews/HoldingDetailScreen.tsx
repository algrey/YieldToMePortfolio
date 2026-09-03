import { HoldingDetailScreen } from "yieldtome-ui";

// `holding` mirrors `OwnedHoldingRow` from app/owned-holdings-contract.ts.
// The screen's price chart fetches `/api/...` on mount; with no server behind
// the preview it settles into its own "Price history unavailable" state.

type Value = {
  status: "available" | "unavailable";
  currencyCode: string;
  value: string | null;
  reason: string | null;
};

function available(currencyCode: string, value: string): Value {
  return { status: "available", currencyCode, value, reason: null };
}

function unavailable(currencyCode: string, reason: string | null): Value {
  return { status: "unavailable", currencyCode, value: null, reason };
}

const vas = {
  id: "ps-vas",
  securityId: "sec-vas",
  symbol: "VAS",
  name: "Vanguard Australian Shares Index ETF",
  exchange: "ASX",
  currencyCode: "AUD",
  quantity: "505",
  averageNativeCost: "93.6412",
  nativeBasis: available("AUD", "47288.81"),
  homeBasis: available("AUD", "47288.81"),
  nativePrice: "101.64",
  nativeValue: available("AUD", "51328.20"),
  homePrice: available("AUD", "101.64"),
  homeValue: available("AUD", "51328.20"),
  dailyMovement: available("AUD", "277.75"),
  dailyPercent: available("AUD", "0.54"),
  unrealisedGain: available("AUD", "4039.39"),
  unrealisedPercent: available("AUD", "8.54"),
  dailyTone: "positive" as const,
  gainTone: "positive" as const,
  priceState: "current" as const,
  actionStatus: "none" as const,
  explanation:
    "Price from Sharesight (20-minute delayed), observed 2026-09-04 15:40 AEST. Cost basis from 4 FIFO lots; unrealised gain compares market value with base-currency cost.",
  sort: { ticker: "VAS", value: "51328.20", daily: "277.75", gain: "4039.39" },
};

const aapl = {
  id: "ps-aapl",
  securityId: "sec-aapl",
  symbol: "AAPL",
  name: "Apple Inc.",
  exchange: "NASDAQ",
  currencyCode: "USD",
  quantity: "105",
  averageNativeCost: "168.2140",
  nativeBasis: available("USD", "17662.47"),
  homeBasis: available("AUD", "26140.45"),
  nativePrice: "228.61",
  nativeValue: available("USD", "24004.05"),
  homePrice: available("AUD", "354.03"),
  homeValue: available("AUD", "37173.15"),
  dailyMovement: available("AUD", "-412.88"),
  dailyPercent: available("AUD", "-1.10"),
  unrealisedGain: available("AUD", "11032.70"),
  unrealisedPercent: available("AUD", "42.21"),
  dailyTone: "negative" as const,
  gainTone: "positive" as const,
  priceState: "current" as const,
  actionStatus: "none" as const,
  explanation:
    "Price from the Yahoo-compatible EOD feed, close of 2026-09-03 (New York). Converted to AUD at 1.5486 (Frankfurter, 2026-09-03). Daily movement compares consecutive closes in AUD.",
  sort: { ticker: "AAPL", value: "37173.15", daily: "-412.88", gain: "11032.70" },
};

const cbaStale = {
  id: "ps-cba",
  securityId: "sec-cba",
  symbol: "CBA",
  name: "Commonwealth Bank of Australia",
  exchange: "ASX",
  currencyCode: "AUD",
  quantity: "125",
  averageNativeCost: null,
  nativeBasis: unavailable("AUD", "missing_basis"),
  homeBasis: unavailable("AUD", "missing_basis"),
  nativePrice: "162.05",
  nativeValue: available("AUD", "20256.25"),
  homePrice: available("AUD", "162.05"),
  homeValue: available("AUD", "20256.25"),
  dailyMovement: unavailable("AUD", "price_basis_changed"),
  dailyPercent: unavailable("AUD", "price_basis_changed"),
  unrealisedGain: unavailable("AUD", "missing_basis"),
  unrealisedPercent: unavailable("AUD", "missing_basis"),
  dailyTone: "neutral" as const,
  gainTone: "neutral" as const,
  priceState: "stale" as const,
  actionStatus: "stale" as const,
  explanation:
    "Last usable price is from 2026-08-28 (Sharesight, delayed) and is older than the freshness window, so it is shown as stale. Cost basis is unavailable: the 2022 opening balance was imported without cost, so gain and unrealised % cannot be computed.",
  sort: { ticker: "CBA", value: "20256.25", daily: null, gain: null },
};

const bhpNoPrice = {
  ...cbaStale,
  id: "ps-bhp",
  securityId: "sec-bhp",
  symbol: "BHP",
  name: "BHP Group Limited",
  exchange: "ASX",
  quantity: "250",
  averageNativeCost: "44.65",
  nativeBasis: available("AUD", "11162.50"),
  homeBasis: available("AUD", "11162.50"),
  nativePrice: null,
  nativeValue: unavailable("AUD", "missing_price"),
  homePrice: unavailable("AUD", "missing_price"),
  homeValue: unavailable("AUD", "missing_price"),
  dailyMovement: unavailable("AUD", "missing_price"),
  dailyPercent: unavailable("AUD", "missing_price"),
  unrealisedGain: unavailable("AUD", "missing_price"),
  unrealisedPercent: unavailable("AUD", "missing_price"),
  priceState: "unavailable" as const,
  actionStatus: "missing_price" as const,
  explanation:
    "No usable quote: the provider mapping for BHP on ASX expired on 2026-08-31 and no manual correction has been recorded. Value, gain and daily movement are unavailable rather than zero.",
  sort: { ticker: "BHP", value: null, daily: null, gain: null },
};

/** Canonical AUD holding with a current price, known basis, and positive gain. */
export function Populated() {
  return (
    <HoldingDetailScreen
      portfolioId="p1"
      holding={vas}
      symbol="VAS"
      subtitle="Vanguard Australian Shares Index ETF · ASX · AUD"
      portfolioSecurityId="ps-vas"
      homeCurrencyCode="AUD"
      initialView="native"
      marketDataProviderEnabled={true}
    />
  );
}

/** USD holding in an AUD portfolio, opened in home-currency view: the Display values select appears and figures are converted. */
export function ForeignCurrencyHomeView() {
  return (
    <HoldingDetailScreen
      portfolioId="p1"
      holding={aapl}
      symbol="AAPL"
      subtitle="Apple Inc. · NASDAQ · USD"
      portfolioSecurityId="ps-aapl"
      homeCurrencyCode="AUD"
      initialView="home"
      marketDataProviderEnabled={true}
    />
  );
}

/** Stale price with missing cost basis: gain, unrealised % and daily movement show their specific unavailable text. */
export function StaleMissingBasis() {
  return (
    <HoldingDetailScreen
      portfolioId="p1"
      holding={cbaStale}
      symbol="CBA"
      subtitle="Commonwealth Bank of Australia · ASX · AUD"
      portfolioSecurityId="ps-cba"
      homeCurrencyCode="AUD"
      initialView="native"
      marketDataProviderEnabled={true}
    />
  );
}

/** No usable quote and the market-data provider gate is off: refresh disabled, every priced figure unavailable. */
export function NoQuoteProviderDisabled() {
  return (
    <HoldingDetailScreen
      portfolioId="p1"
      holding={bhpNoPrice}
      symbol="BHP"
      subtitle="BHP Group Limited · ASX · AUD"
      portfolioSecurityId="ps-bhp"
      homeCurrencyCode="AUD"
      initialView="native"
      marketDataProviderEnabled={false}
    />
  );
}

/** Fully exited position: no row in the published valuation, so the screen shows its honest empty state. */
export function ExitedNoValuation() {
  return (
    <HoldingDetailScreen
      portfolioId="p1"
      holding={null as unknown as Parameters<typeof HoldingDetailScreen>[0]["holding"]}
      symbol="WES"
      subtitle="Wesfarmers Limited · ASX · AUD"
      portfolioSecurityId="ps-wes"
      homeCurrencyCode="AUD"
      initialView="native"
      marketDataProviderEnabled={true}
    />
  );
}
