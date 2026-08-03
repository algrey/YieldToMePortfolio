# Market-data strategy

Status: free, best-effort Yahoo Finance source for the private deployment
Research date: 2026-07-28

Coverage, response shapes, limits, and endpoint behavior change. Revalidate technical assumptions before production activation. External provider-use decisions are handled separately by the operator and create no product requirement, runtime gate, schema field, or task dependency.

## 1. Required capabilities

The first release needs:

- listed equities, ETFs, and funds across Australia, the US, and other international markets represented in user portfolios;
- canonical exchange/symbol reference data;
- the freshest validated observation available from the configured source for active Quotes/Holdings views, with delay allowed to be unknown for a best-effort source;
- end-of-day raw prices as fallback and enough adjusted history to reason about corrections/splits;
- latest available delayed/EOD/manual observation and previous comparable close;
- daily foreign-exchange history for portfolio conversion;
- dividends/distributions and splits;
- observation, ingestion, currency, source, delay, and adjustment provenance;
- practical server-to-server use from Cloudflare Workers;
- zero/low initial provider cost.

Fundamentals and genuine exchange real-time prices are upgrades. The freshest validated observation is a v1 priority, but production must fall back honestly to EOD/manual data for any market where the best-effort source is unavailable or unusable.

## 2. Data-state vocabulary

| State      | Meaning                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------- |
| Real-time  | The source identifies a low-latency observation as real-time and its timestamp supports that state |
| Delayed    | Vendor-defined delayed feed, with delay minutes and timestamp retained                             |
| End of day | Completed or most recent daily market-session observation                                          |
| Cached     | A previously ingested observation; it retains its original state and timestamp                     |
| Stale      | Observation exceeds the product’s exchange/calendar freshness rule                                 |
| Indicative | Not guaranteed to be an exchange last trade; retain the vendor methodology                         |
| Manual     | User-entered versioned value with reason and effective time                                        |
| Estimated  | Derived rather than observed, primarily for dividend forecasts                                     |

Caching an EOD value does not make it current, and polling an indicative/delayed endpoint does not make it live.

## 3. Technical provider comparison

Only technical capability and operational fit are in scope here:

| Provider                           | Coverage evidence                                                                                                         | Price/history capability                                                                                                            | Other capability                                                                                            | Operational fit                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Yahoo Finance via a Worker adapter | Broad international security, ETF, index, and FX coverage exposed by Yahoo Finance; exact coverage must be fixture-tested | Latest/previous-close and daily history are available on a best-effort basis; delay is exchange/symbol dependent and not guaranteed | Commonly exposes splits, dividends, FX pairs, and adjusted fields; semantics must be validated per response | Free, no API key or SLA; endpoint and response changes require strict validation and circuit breaks |
| EODHD                              | Advertises ASX plus broad global exchange coverage                                                                        | Long daily history and delayed observations are advertised                                                                          | FX, splits/dividends, adjusted close, and fundamentals by capability                                        | Optional future alternative if measured Yahoo coverage or reliability is inadequate                 |
| Marketstack                        | Advertises ASX and global EOD coverage                                                                                    | EOD/history; intraday documentation is more limited                                                                                 | Splits/dividends; not a complete FX-history source                                                          | Would require a second FX source                                                                    |
| Twelve Data                        | Broad global coverage with explicit ASX documentation                                                                     | Time series with exchange-dependent delay and history                                                                               | FX, dividends, splits, and fundamentals by capability                                                       | Optional future alternative                                                                         |
| Financial Modeling Prep            | Global coverage on higher capability tiers                                                                                | Daily/history and quote APIs with adjusted data                                                                                     | FX, dividends, splits, and broad fundamentals                                                               | Fundamentals exceed core-release need                                                               |
| Alpha Vantage                      | Global ticker support advertised; ASX depth remains fixture-dependent                                                     | Low-volume daily series and quote freshness that varies by endpoint                                                                 | FX and dividends on supported symbols                                                                       | Deferred low-volume fallback candidate                                                              |

Primary technical sources remain linked for later revalidation:

- yfinance project and implementation context: <https://github.com/ranaroussi/yfinance>
- EODHD exchange list/API: <https://eodhd.com/financial-apis/exchanges-api-list-of-tickers-and-trading-hours>
- Marketstack product documentation: <https://marketstack.com/product>
- Twelve Data ASX support: <https://support.twelvedata.com/en/articles/13001919-australian-equities-market-data>
- FMP developer documentation: <https://site.financialmodelingprep.com/developer/docs>
- Alpha Vantage support: <https://www.alphavantage.co/support/>

## 4. Free-source decision

The owner has selected a free Yahoo Finance/yfinance-compatible source for the private v1 deployment:

- `yfinance` is Python-only and cannot run in the Cloudflare Worker. The Worker will instead use a small server-only Yahoo-compatible adapter; no Python runtime or new hosting service is introduced.
- The application applies no source-specific user-count, owner-binding, deployment-mode, monetization, redistribution, or external-use gate. External provider-use decisions are handled separately by the operator and are not represented in product code or schema.
- Provider, returned timestamp, and inferred/known state are retained internally. Compact views generally suppress timestamps and routine market-data metadata; the explanation remains available on demand, and inline status is reserved for an action-required state.
- Provider failure, throttling, malformed data, missing symbols, and suspected anomalies preserve the previous valid observation where available; otherwise compact views show `Price unavailable`. They never produce zero.

Alpha Vantage is a deferred candidate for low-volume daily global history and FX. Do not add a second adapter until a measured Yahoo coverage or reliability failure justifies the operational complexity.

The app remains provider-neutral so another provider or a user-entitled broker quote source can replace Yahoo without changing ledger, calculation, or UI contracts.

## 5. Chosen first implementation

### Recommendation

Implement the normalized provider contract and UI in this priority order:

1. best-effort/latest quote capability (`delayedMinutes` may be unknown; retain market timestamp and provider scope);
2. EOD/daily raw-price history for valuation;
3. FX observations needed by owned portfolios;
4. versioned manual security, price, and FX corrections;
5. adjusted history, dividends, and splits only through later capability-specific tasks.

Use deterministic fixtures until the free-source adapter is implemented. Provider order:

- **Yahoo Finance-compatible Worker adapter** as the free latest/daily/FX source;
- **manual values** as the final, versioned fallback;
- **Alpha Vantage** only through a later low-volume daily-history/FX task if measured need justifies it;
- **EODHD or another provider** only if measured capability, reliability, or cost warrants it;
- a later **broker quote adapter** where the connected user’s market-data entitlement allows display.

The initial FX adapter is deliberately limited to `AUD/USD` and `USD/AUD` through Yahoo's `AUDUSD=X` pair. It preserves direct or decimal-inverted direction evidence, rejects zero/malformed/future observations, and returns typed unavailable results for unsupported pairs; identity conversion remains local and no broad FX universe is backfilled.

The product remains provider-neutral even though Yahoo-compatible best-effort data is the first adapter.

## 6. Rejected or deferred alternatives

- Direct exchange real-time: operational and entitlement complexity is disproportionate to the first release.
- Marketstack-only: it does not satisfy the required FX lifecycle alone.
- FMP first: fundamentals exceed the first slice’s product need.
- Alpha Vantage primary: quotas and unverified ASX depth are weak foundations.
- Multi-provider aggregation in v1: adds symbol reconciliation, correction conflicts, and observability before measured need.

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

`manual` is a selection quality/state, not a provider interval. Manual price/FX records live in the owner-scoped override model and are composed with provider results by the selector.

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

1. User/import creates an owner-scoped unresolved portfolio-security candidate; it does not publish or mutate a shared canonical security.
2. Server searches provider/reference data using exchange, symbol, currency, and name.
3. User or high-confidence verified rule confirms a canonical mapping.
4. Backfill raw/EOD and validated adjusted series from the earliest relevant transaction date, bounded by available provider history.
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

- Delayed/EOD price and FX observations: retain for owned relevant history under the application retention policy.
- Latest-result cache is derived by indexed query; no separate correctness-critical KV.
- Symbol-search negative cache: short-lived, non-authoritative.
- Provider raw body: parse transiently; store only selected normalized fields + payload hash unless a bounded diagnostic policy authorizes temporary raw retention.
- Client/API: `private, no-store` for portfolio-derived responses.
- Service worker: never cache provider/portfolio/API responses.
- On provider removal: purge transient provider payloads and retain normalized observations according to the application retention policy; user-entered ledger/overrides remain independent.

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

If the selected source’s FX quality or coverage fails, evaluate an authoritative daily central-bank source for supported AUD crosses or another capability-specific source through a separate decision. Do not silently triangulate through inconsistent timestamps without storing both legs and the formula.

## 13. Rate limits, retries, and jobs

- Central provider client uses a configured token-budget/rate-limit policy derived from measured endpoint behavior.
- Coalesce identical in-flight requests and batch symbols only where the API/credit model makes it cheaper.
- Retry only transient network/5xx/429 failures with bounded exponential backoff, full jitter, and `Retry-After`.
- Do not retry authentication, entitlement, malformed symbol, or validation failures automatically.
- Jobs have deterministic idempotency keys, status, attempt count, lease owner/token, lease expiry, and next-attempt time.
- Acquire a lease through a conditional D1 update; stale leases may be reclaimed.
- Keep one active logical refresh per provider/capability/key/window.
- Use `ctx.waitUntil` only to finish short non-authoritative work; durable job state exists before returning.
- Cron processes bounded batches. Add Cloudflare Queues when measured work cannot reliably stay within Worker/subrequest limits or needs durable fan-out.
- Circuit-break an unhealthy provider and retain the last valid stale observation. Keep its state inspectable; surface inline status only when user action is required to avoid a misleading current value.

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

- The selected provider, enabled capabilities, technical review date, rate budget, and fallback behavior are recorded.
- Provider activation has no source-specific user-count, owner-binding, deployment-mode, monetization, redistribution, or external-use gate.
- Production key is a Worker secret and cannot appear in client chunks/logs.
- Australian, US, European-or-UK, and FX symbol/date/adjustment fixtures reconcile with independent samples.
- FX direction/inversion fixtures pass.
- Rate budget covers expected securities, backfill, correction window, and retries.
- Raw/adjusted series selection cannot double-count splits.
- Ticker change, delisting, correction, 429, outage, and manual override tests pass.
- Application retention and provider-removal behavior are implemented.
- Compact UI generally suppresses timestamps and routine freshness/source labels and never says “live” without a real-time entitlement. State remains inspectable; inline status is reserved for action-required conditions, and `Price unavailable` appears when no usable quote exists.
- Provider replacement can pass the common contract suite.
