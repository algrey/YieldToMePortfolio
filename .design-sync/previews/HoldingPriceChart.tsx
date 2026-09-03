import { HoldingPriceChart } from "yieldtome-ui";

/**
 * Data-fetching wrapper: mounts, then GETs
 * `/api/portfolios/:id/securities/:sid/price-history?range=year`. The preview
 * host has no API server, so this story settles into the real ERROR state
 * ("Price history unavailable") -- a legitimate, un-mocked capture of the
 * failure path. The populated/loading/empty renders live under
 * PriceHistoryChartView and ChartBody.
 */
export function HoldingPriceChartNoServerError() {
  return <HoldingPriceChart portfolioId="p1" portfolioSecurityId="s1" symbol="VAS" baseCurrencyCode="AUD" />;
}

/** Same fetch path for a foreign-currency holding (VTS, USD) inside an AUD
 * portfolio: without a server it also resolves to the error state. */
export function HoldingPriceChartForeignNoServerError() {
  return <HoldingPriceChart portfolioId="p1" portfolioSecurityId="s3" symbol="VTS" baseCurrencyCode="AUD" />;
}
