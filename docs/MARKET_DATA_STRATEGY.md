# Market-data strategy

Status: EODHD-preferred delayed-data target with unresolved commercial-rights gate  
Research date: 2026-07-28

Prices, plans, coverage, limits, and terms change. Revalidate this document before contracting or production activation.

## 1. Required capabilities

The first release needs:

- listed equities, ETFs, and funds across Australia, the US, and other international markets represented in user portfolios;
- canonical exchange/symbol reference data;
- approximately 20-minute-delayed observations for active Quotes/Holdings views where lawfully available;
- end-of-day raw prices as fallback and enough adjusted history to reason about corrections/splits;
- latest available delayed/EOD/manual observation and previous comparable close;
- daily foreign-exchange history for portfolio conversion;
- dividends/distributions and splits;
- observation, ingestion, currency, source, delay, and adjustment provenance;
- practical server-to-server use from Cloudflare Workers;
- low cost for a small private invited-user deployment;
- a legal right to store normalized data and display it to authorized users.

Fundamentals and genuine exchange real-time prices are upgrades. Approximately 20-minute-delayed data is a v1 priority, but production must fall back honestly to EOD/manual data for any market where a lawful delayed source is unavailable or unaffordable.

## 2. Data-state vocabulary

| State      | Meaning                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| Real-time  | Exchange/vendor contract permits a very low-latency observation to be displayed as real-time |
| Delayed    | Vendor-defined delayed feed, with delay minutes and timestamp shown                          |
| End of day | Completed or most recent daily market-session observation                                    |
| Cached     | A previously ingested observation; it retains its original state and timestamp               |
| Stale      | Observation exceeds the product’s exchange/calendar freshness rule                           |
| Indicative | Not guaranteed to be an exchange last trade; label the vendor’s methodology                  |
| Manual     | User-entered versioned value with reason and effective time                                  |
| Estimated  | Derived rather than observed, primarily for dividend forecasts                               |

Caching an EOD value does not make it current, and polling an indicative/delayed endpoint does not make it live.

## 3. Provider comparison

Published plan details observed on the research date:

| Provider                | ASX / global coverage                                                                                            | Prices and history                                                                                                                         | FX / dividends / adjustments / fundamentals                                                                                                 | Limits and indicative cost                                                                                                             | Licensing and operational concerns                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EODHD                   | Advertises ASX plus 60+ global exchanges, 150,000+ tickers, ETFs, indices, and FX pairs                          | 30+ years advertised; EOD package; delayed data is generally 15 minutes unless stated; ASX delayed quotes are advertised at 15–20 minutes  | FX pairs, splits/dividends, adjusted close, fundamentals on higher/all-in-one capability; ASX corporate actions have evolving/beta coverage | Personal plans: free 20 calls/day; All World EOD US$19.99/month; All-in-One US$99.99/month; commercial price is by quote               | Best functional fit, but personal plans prohibit group display. A written commercial agreement must confirm display, exchange redistribution, storage, derived data, and deletion obligations; some observations are indicative rather than exchange last trades |
| Marketstack             | Advertises Australian Stock Exchange and global EOD coverage                                                     | Free 1-year EOD; Basic 10-year EOD; higher tiers advertise 15+ years and real-time stock prices; intraday documentation is US/IEX-oriented | Splits/dividends available; currency metadata is not a complete FX history service; fundamentals are not the core low tier                  | Free 100 requests/month; Basic US$9.99/month / 10,000 requests; Professional US$49.99/month / 100,000 requests; Business higher        | Generic commercial-use claims do not replace ASX-specific display verification; would need a second FX source and careful adjusted-series validation                                                                                                             |
| Twelve Data             | Broad global; explicitly documents ASX 20-minute delayed/EOD/historical support                                  | `time_series`; delay and exchange-specific plans; current ASX last trade is not uniformly supported                                        | FX, dividends (higher credits/tier), splits/fundamentals by capability                                                                      | Basic free 8 credits/min and 800/day with limited markets; Grow US$79/month; Pro US$229/month plus applicable ASX/data add-ons         | Explicit ASX support is clearer, but exchange licensing/display fees can greatly exceed API subscription; external display/redistribution and even plan category require confirmation                                                                            |
| Financial Modeling Prep | Global support on upper tier; useful US/global reference                                                         | Daily/history and quote APIs with adjusted data                                                                                            | FX, dividends, splits, broad fundamentals                                                                                                   | Starter US$22/month is US-limited; Premium US$59/month covers more markets; Ultimate about US$149/month for global and 3,000 calls/min | Display/redistribution needs the appropriate agreement; global/fundamental tier cost is hard to justify before the Details product is specified                                                                                                                  |
| Alpha Vantage           | Describes global ticker support, but ASX depth/quality was not explicit enough to accept without a fixture spike | Free daily series; premium daily adjusted with long history; quote freshness depends on market/tier                                        | FX daily/intraday APIs and dividends; fundamentals on supported symbols                                                                     | Free 25 requests/day; paid per-minute plans without the free daily cap                                                                 | Commercial use requires discussion; low free quota is useful only for development; ASX and production rights remain unverified                                                                                                                                   |

Primary sources:

- ASX delayed price data and redistribution requirement: <https://www.asx.com.au/connectivity-and-data/information-services/price-data/delayed-price-data>
- ASX website terms (generally 20-minute-delayed, private/personal access terms): <https://www.asx.com.au/legals/terms-of-use>
- EODHD pricing: <https://eodhd.com/pricing>
- EODHD ASX and global commercial coverage: <https://eodhd.com/asx-data>
- EODHD data sources: <https://eodhd.com/financial-apis/our-data-sources-and-data-partners>
- EODHD commercial-use guidance: <https://eodhd.com/financial-apis/commercial-vs-personal-license-use>
- EODHD terms: <https://eodhd.com/financial-apis/terms-conditions>
- EODHD exchange list/API: <https://eodhd.com/financial-apis/exchanges-api-list-of-tickers-and-trading-hours>
- Marketstack product/pricing: <https://marketstack.com/product>
- Twelve Data pricing: <https://twelvedata.com/pricing>
- Twelve Data ASX support: <https://support.twelvedata.com/en/articles/13001919-australian-equities-market-data>
- FMP pricing: <https://site.financialmodelingprep.com/developer/docs/pricing>
- Alpha Vantage support: <https://www.alphavantage.co/support/>

Subscription cost alone is not a licensing decision. Free delayed viewing on a vendor website does not confer a free API or redistribution right.

## 4. Yahoo and free-data finding

Yahoo Finance is not suitable for the production adapter:

- Yahoo does not document or support the Finance quote endpoints commonly accessed by community wrappers as a public market-data API.
- A wrapper does not create a data licence, service-level agreement, stable response contract, or redistribution right.
- Scraping exposes portfolio prices to silent endpoint, cookie, throttling, and schema changes.

As of the research date, no official source reviewed establishes a free, licensed, international delayed-price API for this hosted multi-user display model. Free tiers generally cover trials, personal/internal use, EOD data, limited symbols, or US-only intraday data.

Consequently, low cost remains a goal, but lawful international coverage and supported APIs take priority over a nominally free source.

## 5. Chosen first implementation

### Recommendation

Implement the normalized provider contract and UI in this priority order:

1. delayed quote capability (`delayedMinutes`, market timestamp, provider/entitlement);
2. EOD/latest fallback;
3. daily historical raw/adjusted prices;
4. FX, dividends, and splits;
5. versioned manual security, price, FX, and dividend corrections.

Use deterministic fixtures until the rights/cost spike approves production terms. Provider order:

- **EODHD commercial plan** as the preferred single-provider delayed + EOD + international + FX/corporate-action candidate;
- **Twelve Data business plan plus required exchange licensing** only if EODHD coverage, quality, or terms fail;
- **EODHD All World EOD** or manual values as the lower-cost fallback, not the preferred active quote source;
- a later **broker quote adapter** where the connected user’s market-data entitlement allows display.

The product remains provider-neutral even though EODHD is the preferred first adapter.

### Mandatory condition

Do not enable any provider in production, and do not add a second real user, until written permission covers:

- private display to the intended number/type of authorized users;
- server-side storage/cache of normalized observations and derived portfolio values;
- every required Australian and international exchange;
- historical retention and backups;
- whether calculated/aggregated values are derivative data;
- acceptable refresh patterns;
- termination/deletion obligations.

Store the approval scope/date/owner in provider configuration. `MARKET_DATA_RIGHTS_APPROVED=false` must fail closed in production.

### Cost envelope

Desired target: inexpensive delayed data for the small initial user base. Verified public personal-plan ranges are:

- free only for narrow trial/internal/non-display coverage;
- about US$100/month for EODHD All-in-One before any additional display rights;
- US$229/month individual Twelve Data Pro or US$499/month business Venture before applicable ASX/data add-ons and exchange licensing;
- about US$20/month for EODHD EOD as a lower-freshness fallback.

EODHD commercial pricing is by quote. The owner must approve that quote or explicitly choose labelled EOD/manual fallback. The product remains functional as a ledger/cost-basis tool without a delayed provider.

## 6. Rejected or deferred alternatives

- Yahoo Finance/community wrappers: no supported Finance API contract, unclear display rights, no SLA, and endpoint changes can silently corrupt data.
- Direct exchange real-time: cost, entitlement reporting, and display agreements are disproportionate to the first user base.
- Twelve Data free ASX assumption: Basic does not provide general delayed AU display; paid plan and ASX rights are still required.
- Marketstack-only: attractive price, but it does not satisfy the required FX lifecycle alone and its ASX/adjusted-data rights need validation.
- FMP first: fundamentals are strong, but global tier cost funds a feature the first slice does not need.
- Alpha Vantage primary: quotas and ASX/production-use uncertainty are poor foundations despite useful experiments.
- Multi-provider aggregation in v1: more licensing, symbol reconciliation, correction conflicts, and observability before there is measured need.

## 7. Provider abstraction

```ts
type DataQuality =
  "observed" | "corrected" | "indicative" | "manual" | "stale_candidate";

interface ProviderCapabilities {
  exchanges: string[];
  intervals: Array<"eod" | "delayed" | "intraday">;
  supportsRawPrices: boolean;
  supportsAdjustedPrices: boolean;
  supportsFx: boolean;
  supportsDividends: boolean;
  supportsSplits: boolean;
  supportsFundamentals: boolean;
  historicalStart?: string;
  delayedMinutes?: number;
  authorizedUseScope: string;
}

interface MarketDataProvider {
  capabilities(): ProviderCapabilities;
  searchSecurities(query: SecurityQuery): Promise<SecurityCandidate[]>;
  getDailyPrices(request: DailyPriceRequest): Promise<PriceObservation[]>;
  getLatestObservation(
    request: LatestRequest,
  ): Promise<PriceObservation | null>;
  getFxRates(request: FxRequest): Promise<FxObservation[]>;
  getDividendEvents(request: DividendRequest): Promise<DividendEventInput[]>;
  getSplitEvents(request: SplitRequest): Promise<SplitEventInput[]>;
  getFundamentals?(
    request: FundamentalRequest,
  ): Promise<FundamentalSnapshot | null>;
}
```

A later `BrokerMarketDataAdapter` may implement the same interface, but only for the connected user/account entitlement. It must preserve broker/source/entitlement provenance and cannot make broker prices globally available to other users.

Normalized results contain no provider-specific response objects. They include:

- canonical security/provider mapping ID;
- interval and observation instant/market date/timezone;
- currency or explicit FX base/quote pair;
- raw/adjusted state and factor where supplied;
- source/provider revision;
- delay/quality;
- ingestion time and payload hash.

Provider errors are typed as authentication, entitlement, rate limit, unavailable capability, symbol not found, invalid response, timeout, or transient upstream.

## 8. Security and identifier lifecycle

- Canonical `security_id` is stable; ticker is a validity-dated identifier.
- Provider mappings are validity-dated and verified against exchange/MIC + currency.
- A ticker change expires the old mapping and creates the new mapping without rewriting old observations.
- A delisted security remains canonical and historical; current selection returns last observation with delisted/stale state, not a fabricated zero.
- Re-used tickers cannot claim prior observations because mapping intervals/security IDs differ.
- Provider API keys are Worker secrets and all calls are server-side.
- Browser endpoints return only the user-needed normalized/derived fields, never bulk/raw provider data.

## 9. Ingestion lifecycle

### Initial mapping/backfill

1. User/import creates an unresolved security candidate.
2. Server searches provider/reference data using exchange, symbol, currency, and name.
3. User or high-confidence verified rule confirms a canonical mapping.
4. Backfill raw/EOD and approved adjusted series from earliest relevant transaction date, bounded by provider rights/history.
5. Backfill required FX pairs/dates and corporate actions.
6. Normalize/upsert idempotently and invalidate affected portfolio snapshots.

### Refresh

- During market hours, delayed-capable securities refresh no more frequently than the source delay/rate budget permits; identical canonical securities are coalesced.
- After the session, Cron refreshes the completed EOD/correction window.
- Coalesce portfolios sharing one canonical security into one provider fetch.
- Refresh recent EOD window to catch vendor corrections, not only the newest row.
- FX refreshes required currency pairs once per daily window.
- Dividend/split refresh runs at a lower cadence plus targeted post-event correction.
- Manual refresh requests create/coalesce a job and return status; they do not issue one client-side provider request per holding.

### Corrections

- Same provider key/revision updates normalized values only under an explicit correction rule; retain correction metadata/hash.
- Changed historical observation invalidates snapshots from affected date.
- Corporate-action correction invalidates the security’s affected ledger/snapshot range.
- Manual override takes selection priority for its effective interval but does not delete source data.

## 10. Cache and retention rules

D1 is the first normalized server cache:

- Delayed/EOD price and FX observations: retain for owned relevant history within contract.
- Latest-result cache is derived by indexed query; no separate correctness-critical KV.
- Symbol-search negative cache: short-lived, non-authoritative.
- Provider raw body: parse transiently; store only selected normalized fields + payload hash unless contract and a diagnostic need authorize temporary raw retention.
- Client/API: `private, no-store` for portfolio-derived responses.
- Service worker: never cache provider/portfolio/API responses.
- On provider termination: purge provider-derived observations/payloads within contract timing, keep user-entered ledger/overrides and lawfully derived values only if the agreement permits.

R2 is unnecessary for routine market data. KV may later cache non-sensitive shared reference lookups, but never authorization, portfolio truth, or balances.

## 11. Historical strategy

Use a hybrid:

- ledger replay produces each date’s quantity, cost lots, and cash;
- cached provider daily raw prices value actual quantities;
- adjusted series supports continuity/corporate-action diagnostics, never double-adjusts split-processed quantities;
- cached daily FX converts native observations;
- versioned holding/portfolio daily snapshots make charts fast and reproducible;
- corrections invalidate/rebuild only affected ranges.

Do not back-cast current holdings. Do not call an incomplete value series performance. TWR/XIRR remain staged until complete external-flow history.

Provider history is fetched on mapping/import and on demand for range expansion, then periodically refreshed only for recent correction windows. It is not re-downloaded on each chart request.

## 12. Exchange-rate strategy

Store directional observations:

`one base currency unit = rate × quote currency units`

Calculation normalizes to native→portfolio-base with decimal arithmetic and records whether inversion occurred. Selection:

1. same-date approved observation at/before cutoff;
2. prior business-day observation within five calendar days;
3. manual override;
4. unavailable.

Never use a future date for transaction cost basis. Identity conversion is exact `1`. Forecast dividends may use the latest FX only when labelled estimated/as-of; actual receipts use payment-date FX.

If EODHD FX rights/quality fail, evaluate an authoritative daily central-bank source for supported AUD crosses plus a licensed broader FX provider. Do not silently triangulate through inconsistent timestamps without storing both legs and the formula.

## 13. Rate limits, retries, and jobs

- Central provider client uses a token-budget/rate-limit policy derived from the contracted tier.
- Coalesce identical in-flight requests and batch symbols only where the API/credit model makes it cheaper.
- Retry only transient network/5xx/429 failures with bounded exponential backoff, full jitter, and `Retry-After`.
- Do not retry authentication, entitlement, malformed symbol, or validation failures automatically.
- Jobs have deterministic idempotency keys, status, attempt count, lease owner/token, lease expiry, and next-attempt time.
- Acquire a lease through a conditional D1 update; stale leases may be reclaimed.
- Keep one active logical refresh per provider/capability/key/window.
- Use `ctx.waitUntil` only to finish short non-authoritative work; durable job state exists before returning.
- Cron processes bounded batches. Add Cloudflare Queues when measured work cannot reliably stay within Worker/subrequest limits or needs durable fan-out.
- Circuit-break an unhealthy provider and serve last valid stale observations with visible status.

## 14. Data gaps and manual fallback

Missing provider data never becomes zero.

- Mapping gap: user confirms exchange/security or creates an unresolved manual security.
- Price gap: base metric unavailable; allow effective-dated manual price with reason.
- FX gap: show native amount; allow effective-dated manual FX.
- Dividend gap: actual receipts may be entered manually; forecast unavailable or TTM-only under the calculation rules.
- Suspect outlier: quarantine/flag observation, retain prior known value as stale, request manual/provider review.
- Delisted security: preserve last data and allow disposal/cash-in-lieu ledger facts.

Overrides are owner-scoped, versioned, effective-dated, auditable, visually labelled, and reversible.

## 15. Reliability and observability

Measure without logging financial payloads:

- request counts/credits by capability and outcome;
- provider latency, 429, entitlement, timeout, parsing, and correction counts;
- oldest/newest observation and staleness aggregates;
- security/FX/dividend coverage counts;
- job queue age, attempts, lease expiry, and terminal failures;
- snapshot invalidations caused by provider corrections.

Alert on sustained provider failure, entitlement changes, high staleness, rate-budget exhaustion, or normalization rejection. The user sees a safe, specific state; operators use correlation IDs and provider request IDs.

## 16. Production readiness checklist

- Written rights approval matches deployment/user/exchange/storage scope.
- The provider spike has documented whether the delayed source is genuinely free for this exact use; if not, the owner has approved the recurring/exchange cost or EOD fallback.
- Production key is a Worker secret and cannot appear in client chunks/logs.
- Australian, US, European-or-UK, and FX symbol/date/adjustment fixtures reconcile with independent samples.
- FX direction/inversion fixtures pass.
- Rate budget covers expected securities, backfill, correction window, and retries.
- Raw/adjusted series selection cannot double-count splits.
- Ticker change, delisting, correction, 429, outage, and manual override tests pass.
- Retention/termination purge is implemented.
- UI says `Delayed 20 min`, EOD, manual, or the provider’s actual as-of state; never “live” without a real-time entitlement.
- Provider replacement can pass the common contract suite.
