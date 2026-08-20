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

### Activation model (MKT-007)

The `market_data_providers` row describing the shipped adapter (`id = 'yahoo-compatible'`, `code = 'yahoo-best-effort'`, `status = 'enabled'`) is static reference data, not per-deployment configuration: it is seeded by the hand-authored data-only migration `drizzle/0037_steady_signal.sql` (`INSERT ... ON CONFLICT DO NOTHING`, untargeted so it also no-ops against the `code`-unique constraint), so every environment that runs the full migration chain has it from a fresh database, with no separate manual seeding step. Seeding this row does **not** itself turn verification or refresh on. The `MARKET_DATA_PROVIDER` Worker env var remains the sole per-deployment activation gate, enforced by a two-stage check that TWO call sites each perform independently (`resolveConfiguredProvider` itself never queries `market_data_providers` and is not the gate): `verifySecurityCandidateWithContext` (`app/security-verification-service.ts:282-291`) and `refreshSecurityDividendHistoryWithContext` (`app/dividend-history-refresh-actions.ts:87-97`, backing the owner-initiated "Refresh historical" re-pull) EACH first read the row's `status` themselves via their own `SELECT status FROM market_data_providers WHERE id = ?`, failing closed with an explicit 503 if it is missing or not `'enabled'` — "Market-data verification is not available for this deployment." and "Market-data refresh is not available for this deployment." respectively — before either ever calls the shared `resolveConfiguredProvider`. Only past that per-call-site 503 check does `resolveConfiguredProvider` run, and only then does it separately consult the env var via `resolveRuntimeConfig`: with the env var absent or set to `disabled`, it returns the disabled provider stub regardless of the registry row's status, and every capability call fails explicitly with `unavailable_capability` and makes no live request. `worker/scheduled-refresh.ts`'s periodic sweep never queries the registry table at all — it reads `resolveRuntimeConfig(env)` directly and skips entirely when the env var is disabled. In other words, `status = 'enabled'` on the registry row means "this codebase knows how to talk to this provider," and the env var means "this deployment has switched it on" — both must independently hold, checked by two different mechanisms at two different points in each call site, before either verification/refresh path can make a live request.

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
2. Server searches provider/reference data using exchange, symbol, currency, and name. Implemented for a brand-new import candidate by IMP-004B: `app/security-verification-service.ts` calls the configured provider's `searchSecurities({ text, exchangeId, currencyCode })` (`domain/market-data/*`) with the candidate's own (never client-trusted) symbol/exchange/currency, re-derived from the server's current preview.
3. User or high-confidence verified rule confirms a canonical mapping. IMP-004B's rule (`domain/securities/verify-identity.ts`'s `evaluateSecurityIdentityCandidates`) requires exactly one provider candidate whose symbol matches and whose currency agrees (and whose exchange agrees, when the row supplied one); zero, ambiguous, or disagreeing matches are explicit failures (`not_found`/`ambiguous`/`mismatched`) that leave the candidate private and unresolved -- no unverified publish, no silent retry. A confirmed match publishes the canonical `securities`/`security_identifiers` rows and a `verified` `security_provider_mappings` row (status transitions directly to `verified`; there is no separate persisted `candidate` stage in this flow), or links to an already-published mapping for the same provider identity if one exists (creation-only; never mutates an existing canonical row or another user's mapping) -- see `docs/DATA_MODEL.md` §4/§11 for the atomic write and dedupe-on-conflict technique.
4. Backfill raw/EOD and validated adjusted series from the earliest relevant transaction date, bounded by available provider history.
5. Backfill required FX pairs/dates and corporate actions.
6. Normalize/upsert idempotently and invalidate affected portfolio snapshots.

Steps 4-6 (historical backfill) are not part of IMP-004B's scope: verification publishes the canonical identity and links the owner's candidate so the batch can reach `ready`/commit; price/FX/corporate-action backfill for a freshly verified security follows the ordinary refresh lifecycle below once the security is held.

IMP-009's owner-attested securities (`db/repositories/security-attestation.ts`, used when this provider is unavailable or a ticker is delisted) carry no `security_provider_mappings` row at all, so none of steps 2-6 above ever run for them until a later provider verification upgrades the same row in place -- no quotes, no dividend/split history, no FX backfill, until that upgrade happens (see `docs/DATA_MODEL.md`'s `security_provider_mappings` section for the write path).

### Refresh

- During market hours, delayed-capable securities refresh no more frequently than the source delay/rate budget permits; identical canonical securities are coalesced.
- After the session, Cron refreshes the completed EOD/correction window.
- Coalesce portfolios sharing one canonical security into one provider fetch.
- Refresh recent EOD window to catch vendor corrections, not only the newest row.
- FX refreshes required currency pairs once per daily window.
- Dividend/split refresh runs at a lower cadence plus targeted post-event correction.
- Manual refresh requests create/coalesce a job and return status; they do not issue one client-side provider request per holding.
- The compact quote UI limits manual price refreshes to the most recent five calendar days. Requests in the same 15-minute target window share a deterministic idempotency key, and a successfully completed target remains rate-limited for that cooldown instead of recreating provider work.
- Scheduled refresh jobs persist their lease and date high-water in D1, process at most five target chunks/provider requests per invocation, and keep each observation write below the 100-bound-parameter limit; observation writes and the matching checkpoint are one guarded D1 batch, active-target coalescing is unique-index enforced, configuration that exceeds query/chunk budgets fails closed, and `waitUntil` is not the durability mechanism.

### Dividend and split capability (MKT-005)

The Yahoo-compatible adapter (`domain/market-data/yahoo-compatible.ts`) implements `getDividendEvents`/`getSplitEvents` against the same chart endpoint used for prices, requested with `events=div,splits`. Both methods validate the provider's `events.dividends`/`events.splits` objects as `unknown` at the boundary (`domain/market-data/normalize.ts`'s `normalizeDividendEventInput`/`normalizeSplitEventInput`, mirroring the price/FX normalizers) and fail closed to a typed `invalid_response` on anything malformed rather than guessing. `ProviderCapabilities.supportsDividends`/`supportsSplits` are now `true` for this provider, but `supportsAdjustedPrices` remains `false` and `getDailyPrices`/`getLatestObservation` continue to report `adjustmentState: 'raw'` unconditionally — the presence of split events in a chart response never triggers any price adjustment, so raw historical prices and split-adjusted quantities cannot double-apply the same split. Provider-shape decisions, documented at the point they matter:

- Yahoo's dividend events carry only an ex-date and per-share amount, never a payment date or a dividend-type classification; `DividendEventInput.paymentDate` is therefore always `null` from this provider (the field exists as a seam for a future richer provider) and every ingested event is written with `kind = 'cash'`. Concretely, this means an economically "special" one-off dividend from Yahoo is indistinguishable from an ordinary one and is counted as `cash` everywhere in this pipeline (including the trailing-yield derivation below) — the `kind` exclusion logic exists for a future provider that DOES classify them separately, not for this one.
- Yahoo's split events carry a single date, not separate ex-date/effective-date; ingestion uses it for both the repository's required `ex_date` and `effective_date` columns.
- Because dividend/split natural keys are (security, provider, ex-date/effective-date) and Yahoo supplies no type classification, two distinct provider events that happen to share the same date within one fetch cannot both be represented; the ingestion reconciler keeps the first and reports the rest as `droppedDuplicates` in its summary rather than silently discarding them. This is a real limitation of the provider's undifferentiated event shape, not a defect in the dedupe logic.

**Franking is never populated.** `dividend_events.franking_percent_decimal`/`franking_credit_per_share_decimal` are a typed seam (nullable columns, present since `DB-005`) that MKT-005's ingestion always writes as explicit `null` (unknown), never a guessed zero — no current provider supplies franking data. Manual/per-dividend franking entry is `DIV-003`/`UI-006B` scope.

**`dividend_events`/`split_events.status` is a lifecycle column, not an immutable provider fact.** A pure lifecycle progression — the same natural key, the same amounts/dates/currency, only the status changing because the ex-date/effective-date has now passed (`declared` → `paid` or `declared` → `effective`) — updates the existing row's `status`/`observed_at` in place. This is explicitly NOT a correction and NOT a supersession; supersession stays reserved for an actual fact change (amount, date, currency). See `docs/DATA_MODEL.md`'s `dividend_events` status-semantics note for the full rule and rationale.

**Ingestion triggers** (`domain/market-data/corporate-action-ingestion.ts`):

- (a) **Security added/verified**: `app/security-verification-service.ts`'s `verifySecurityCandidateWithContext` calls `ingestSecurityCorporateActionHistory` once a candidate is published/linked to a security. This never blocks or fails the verification response (result discarded, wrapped in try/catch), and its worst-case latency is explicitly BOUNDED, not merely failure-tolerant: it runs on a dedicated provider instance configured for a single attempt and a 3-second timeout, separate from the instance used for the search request this endpoint primarily serves (which keeps its default multi-attempt/8s-timeout behaviour). The periodic sweep and an owner-initiated re-pull both cover anything this bounded attempt misses.
- (b) **Normal refresh path**: `worker/index.ts`'s `scheduled()` handler calls `runScheduledCorporateActionRefresh` (`worker/scheduled-refresh.ts`) alongside the existing price/FX refresh. It re-pulls a small bounded batch of verified provider mappings per invocation, ranked oldest-attempted-first via `createCorporateActionRefreshRepository` (`db/repositories/dividends.ts`) against the dedicated `corporate_action_refresh_state` table (one row per security, upserted on every ingestion ATTEMPT — success, failure, or no-op — by `ingestSecurityCorporateActionHistory` regardless of trigger). This sweep runs independently of `MARKET_DATA_REFRESH_LIMITS` (the price/FX request budget); each `MarketDataProvider` instance carries its own circuit breaker, so a struggling corporate-action fetch trips its own breaker without affecting price/FX refresh health.
- (c) **Owner-initiated historical re-pull** (consumed by `UI-006C`'s "Refresh historical"): the same `ingestSecurityCorporateActionHistory` function, called again for one security.

All three triggers are the SAME full-pull-and-reconcile operation: fetch the security's complete provider dividend/split history for a bounded lookback window and reconcile against existing `dividend_events`/`split_events` rows by natural key (ex-date for dividends, effective-date for splits) — unchanged values are a no-op, a pure status/lifecycle progression updates in place (see above), a changed fact supersedes the prior row (`db/repositories/dividends.ts`'s `recordEvent`, prior row preserved with `status = 'superseded'`), and a new natural key creates a row. Nothing is ever deleted, and reconciliation only ever writes to the shared provider-fact tables — it never touches owner override/manual/exclusion rows (`dividend_event_overrides`, `dividend_manual_records`, `dividend_receipts`, the assumptions tables), which live in separate tables.

Concurrent ingestion attempts (the verify trigger and the sweep can race on the same security) are guarded by partial unique indexes — `dividend_events_active_natural_key_unique` on `(security_id, provider_id, ex_date) WHERE status <> 'superseded'` and the `split_events` analogue on `effective_date` — so two concurrent writers can never both create an active row for the same natural key. The reconciler treats the resulting unique-constraint batch failure as benign: it re-reads and proceeds from whatever the concurrent winner left behind, rather than reporting a spurious write failure.

**Owner overrides and supersession — the actual mechanism.** `dividend_event_overrides` stays keyed to the exact event id that was active when the owner created the override. Supersession mints a brand-new event id for the corrected row and moves the prior row's status to `superseded`; it does not rewrite or move the override. Consequently, a naive lookup that only checks the CURRENT active event for an override would miss one attached to a now-superseded prior version — the opposite of "the override still wins". Correctly resolving "does an override apply to this dividend, including through a provider correction" requires walking the `supersedes_event_id` chain from the current active event backward and checking every version in that lineage for an override; `collectEventLineageIds` (`domain/market-data/corporate-action-ingestion.ts`) is a small pure helper that returns exactly that ordered lineage, but the resolution logic itself (matching lineage ids against `dividend_event_overrides`) is `DIV-001` scope and is not implemented by this task.

**Why not the price/FX job queue:** `market_data_refresh_jobs` (`MKT-003B`) is purpose-built for incremental date-chunked polling with a persisted high-water mark and a `target_kind IN ('price', 'fx')` schema check; dividend/split ingestion always re-pulls and reconciles a security's full history in one pass rather than advancing a checkpoint through a date range. Migrating that schema to a shape it was not designed for was judged out of proportion to this capability; trigger (b) above is instead a small, separate bounded sweep over the same D1 store, tracked by its own `corporate_action_refresh_state` table rather than a derived watermark (an earlier version of this design derived "last attempted" from `MAX(ingested_at)` on the events tables themselves, which never advances for a non-paying or unchanged security and would re-select the same security on every sweep).

**Trailing dividend yield** (`domain/market-data/dividend-yield.ts`, feeding `DIV-003`'s assumptions-grid "provider yield" column): `deriveTrailingTwelveMonthDividend` sums actual `kind = 'cash'`, `status IN ('declared', 'paid')` per-share amounts whose ex-date falls in the trailing 365 days, then `deriveTrailingDividendYield` divides that sum by a caller-supplied current price (this module never fetches a price itself). A security with zero qualifying events in the window returns the typed reason `insufficient_history` rather than annualizing from a smaller sample — per the acceptance rule that missing/irregular dividend data must be unavailable, never a guess.

### Corrections

- Same provider key/revision updates normalized values only under an explicit correction rule; retain correction metadata/hash.
- Changed historical observation invalidates snapshots from affected date.
- Corporate-action correction invalidates the security’s affected ledger/snapshot range.
- Manual override takes selection priority for its effective interval but does not delete source data.
- UI price overrides use the canonical `security_id` as both durable target key and security reference, and the submitted currency must match the security master. UI FX overrides use an uppercase `BASE/QUOTE` key, active canonical currencies, and a portfolio-relevant pair whose quote currency is the portfolio base currency.

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

## 17. Sharesight as a secondary price source (BRK-012A/BRK-012B/BRK-012C, 2026-08-20)

`domain/sharesight/` (BRK-003+) was originally scoped as a read-only broker-sync source for trades/holdings/payouts, deliberately out of the market-data-provider abstraction above (§7). BRK-012A/BRK-012B narrow that: `listUserInstruments` (`GET /user_instruments.json`) is now ALSO a delayed-price source, seeded into `market_data_providers` as a second row (`id`/`code` = `sharesight`, migration `0044_seed_sharesight_provider.sql`, mirroring `0037`'s `yahoo-compatible` seed).

- **Entitlement: the owner's OWN Sharesight account, never a shared/public feed.** Every price this source supplies is fetched with the deployment's single `client_credentials` grant against the owner's real Sharesight account (`worker/sharesight-config.ts`). Accordingly every written `price_observations` row is `access_scope = 'user'`/`scope_user_id` = that owner — see §8's `access_scope` distinction — NEVER `'deployment'`, unlike the Yahoo-compatible EOD path. A future multi-owner deployment where two owners hold the same security would NOT share a Sharesight-sourced observation between them the way a deployment-scoped Yahoo observation is shared.
- **Delayed, timestamp-anchored, never labelled live.** `current_price_updated_at` is the ONLY freshness signal this source carries — BRK-012A's live spike found the owner's "~20-minute delay" expectation INCONCLUSIVE (both runs ran after ASX close), so no delay magnitude is ever assumed or displayed; `interval = 'delayed'` with `delayed_minutes = NULL` (an honest "unknown duration", not a fabricated zero). Per AGENTS.md, this is never presented as `live`.
- **No historical backfill — accretion-forward only.** The only documented historical-daily-price route (`GET /instruments/:id/prices.json`) is a confirmed hard HTTP 406 gate for this API client across every policy-compliant Accept/path/query variant (§8.2's BRK-012A follow-up entry) — `domain/sharesight/client.ts`'s `listInstrumentPrices` method was REMOVED, not merely left unpromoted, per that entry's "do not re-attempt" ruling. Instead, each hourly refresh (`app/sharesight-price-refresh-service.ts`) upserts THAT day's observation from the live `current_price`, one row per (security, market_date, source, scope) — a same-day re-fetch OVERWRITES (converges toward the close, `db/schema.ts`'s `price_observations_provider_scope_mapping_date_unique` partial index scoped to `provider_id = 'sharesight'` only, so every OTHER provider's legitimate same-day "correction received later" pattern — e.g. `tests/calc-002-repository.test.ts`'s fixture — is completely unaffected). A pre-Sharesight day for a security has no Sharesight-sourced row at all and never will; existing Yahoo-compatible EOD history is untouched and keeps serving those dates.
- **Scope: the owner's OWN `portfolio_securities`, any status.** Resolved through `security_identifiers(scheme = 'sharesight_instrument')` (BRK-009A) — never ticker text. An instrument Sharesight returns that matches none of the owner's identifiers is ignored, with the count disclosed in the refresh result, never guessed onto a nearest-ticker security.
- **Provenance completeness.** Every write carries `provider_id = 'sharesight'`, `access_scope`/`scope_user_id`, `observation_at`, `market_date` (derived from Sharesight's original timestamp's OWN offset, not a UTC conversion), `market_timezone` (the observed numeric offset, e.g. `+10:00` — Sharesight supplies no IANA zone name, and none is invented from `market_code`), `currency_code`, `ingested_at`, `adjustment_state = 'raw'`, `quality = 'observed'`. **`observation_at` CORRECTION (BRK-012B review finding B1(a), 2026-08-20, BLOCKING):** an earlier version of this note claimed `observation_at` retained Sharesight's raw offset string; that was WRONG and blanked the owner's holdings view on the very first hourly write (`app/owned-holdings.ts`'s `mapPrice` validates `observation_at` against a Z-only ISO regex, which a `+10:00`-suffixed string fails, silently caught into an "unavailable" state). `observation_at` is now normalized to a UTC `...Z` ISO string at write time (`domain/sharesight/price-accretion.ts`'s `normalizeTimestampToUtcIso`) — Sharesight's raw offset-preserving string is not separately retained (`price_observations` has no spare column suited to it); this conversion IS the documented rule. `market_date`'s derivation is UNCHANGED and still reads the ORIGINAL, pre-conversion offset string — the two derivations run independently against the same source string, never chained, so this fix does not reintroduce the UTC-conversion date-shift bug `market_date`'s own derivation exists to avoid.
- **`security_provider_mappings` requirement.** `price_observations.mapping_id` is a hard FK into `security_provider_mappings`; the write path guard-creates a `status = 'candidate'` mapping (`provider_exchange`/`provider_symbol` = Sharesight's own `market_code`/`code`) on a security's first accretion write, since the identity itself was already durably resolved via `sharesight_instrument` before any price write is attempted — this mapping row is a technical FK anchor, not a fresh unverified candidate awaiting owner review the way a CSV-ticker mapping is.
- **Selection for CURRENT holdings (BRK-012C, lifted from BRK-012B's storage-only exclusion): wired in, historical/snapshot valuation UNCHANGED.** `app/owned-holdings.ts`'s `loadOwnedHoldings` (the holdings valuation read path — also the shared source `app/owned-income-projection.ts` and `app/owned-dividend-assumptions.ts` both build on) removed its `provider_id <> 'sharesight'` predicate: a Sharesight accretion row now participates in the EXISTING selection machinery (`domain/market-data/selection.ts`) exactly like any other provider's row, unchanged selection logic — `providerRank` already ranked `interval = 'delayed'` ahead of `'eod'` for the same market date, which is now live behavior rather than dead code. `db/repositories/snapshots.ts`'s snapshot-rebuild fact loader (the Overview daily-history chart) KEEPS its identical predicate — historical/snapshot valuation stays on the Yahoo-compatible EOD feed only, a deliberate BRK-012C ruling, not an oversight. `app/owned-quotes.ts`'s Quotes-page read still needs no predicate (it already reads `access_scope = 'deployment'` only).
- **The delayed-price cache + 10-minute read gate (BRK-012C).** A new table, `sharesight_delayed_prices` (`db/schema.ts`, migration `0045`), holds ONE row per (user, security): the latest observed price/currency, Sharesight's own quote timestamp (`quote_at`), and the ingestion time (`fetched_at`) — an audit/freshness-display store, kept per-security. `app/owned-holdings.ts` calls `app/sharesight-price-gate-service.ts`'s `ensureSharesightPriceFreshness` before reading `price_observations`: if this owner has an enabled Sharesight link and their PER-OWNER attempt watermark (see below) is missing or older than 10 minutes, it makes ONE bounded `listUserInstruments()` call, then upserts BOTH `sharesight_delayed_prices` (the cache) AND `price_observations` (the SAME accretion write BRK-012B's hourly cron already makes, reusing `buildSharesightPriceAccretionPlan`/`upsertSharesightPriceObservations`) from the identical result — so the table the selection machinery actually reads (`price_observations`) is refreshed as a side effect of the gate's own freshness check, never read directly by the holdings display path itself. **Staleness is a PER-OWNER fact, not per-security (review round B1, 2026-08-20, BLOCKING fix):** one `listUserInstruments()` call refreshes everything fetchable for an owner in one shot, so a held security Sharesight never matches can never have a cache row — an earlier per-security cache scan reported "stale" on every load for any portfolio holding even one such security, defeating the 10-minute window entirely. The gate now reads a single-row watermark (`sharesight_sync_state.last_price_refresh_at`/`_status`/`_error_kind` — the SAME trio BRK-012B's cron already stamps, deliberately reused rather than a second near-duplicate column set) instead; a held-but-unmatched security simply has no cache row and its price stays whatever `price_observations` already offers, honestly. Within the 10-minute window, the gate makes ZERO Sharesight requests (asserted by test, including a mixed matched/unmatched-security portfolio and three simulated call sites in one window). Stampede-safe: a single-flight lease (CAS-claimed on the owner's enabled `sharesight_sync_state` row, `price_refresh_lease_owner`/`price_refresh_lease_expires_at`, mirroring `calculation_runs.claim()`'s conditional-UPDATE pattern) means a losing concurrent request skips the fetch and serves whatever is already there. A fetch failure serves the stale cache/observations with their honest, unchanged age AND stamps the shared watermark with `status = 'failed'` + the error kind (review round B2 fix) — the gate never throws for an ordinary outcome, the page never blocks, and a persistently broken fetch cannot be retried on every render since the failed attempt itself holds the window closed.
- **Display label: always "Delayed (Sharesight)", never "live".** `app/owned-holdings.ts`'s row explanation text (the accessible detail panel, per AGENTS.md's "compact views may suppress routine labels, explanations must remain accessible" rule) renders `interval = 'delayed'` selections as `Delayed (Sharesight) as of <quote timestamp>` rather than the bare interval name every other provider gets — the quote timestamp is `price_observations.observation_at` (Sharesight's own `current_price_updated_at`, UTC-normalized). The word "live" is never used to describe this data anywhere in the codebase (AGENTS.md non-negotiable, grep-asserted by `tests/brk-012c.test.ts`). A cross-basis daily-movement comparison (today's price from a different selection class than yesterday's, e.g. Sharesight-delayed vs. Yahoo-compatible EOD) renders its own honest "Movement unavailable (price basis changed)" text rather than the generic "Price unavailable" (review round B3 fix, `docs/CALCULATIONS.md` §2) — the CURRENT price is still shown correctly; only the day-over-day comparison is withheld.
- **Trigger: hourly cron sweep, dual-gated (unchanged from BRK-012B) — the outer freshness bound when nobody is looking.** `worker/index.ts`'s existing `scheduled` handler (cron `0 * * * *`) calls `runScheduledSharesightPriceRefresh` alongside the pre-existing Yahoo/corporate-action/calculation sweeps. Work happens only when BOTH `SHARESIGHT_CLIENT_ID`/`SHARESIGHT_CLIENT_SECRET` are configured AND at least one owner has an ENABLED `sharesight_sync_state` link — either gate absent is a `skipped: true` no-op with zero DB reads and zero Sharesight requests, mirroring the existing Yahoo `marketDataProvider === 'disabled'` skip. `listUserInstruments` is fetched exactly ONCE per run (one Sharesight account covers every owner sharing it); a fetch failure is recorded explicitly (`status = 'failed'` + the error kind) on every enabled link's watermark, never partial-silent; the SAME run also upserts the delayed-price cache from the identical candidates (review follow-up 2). The BRK-012C read gate above is a SEPARATE, per-owner, per-request trigger with its own single-flight lease, but DELIBERATELY SHARES the cron's watermark column (see above) — an hourly cron sweep therefore "resets the gate clock" for free: the very next portfolio load after a cron run sees a fresh watermark and serves cache/`price_observations` with zero Sharesight calls. Either trigger alone keeps `price_observations`/the cache honestly current within its own bound (≤10 minutes while actively viewed, ≤1 hour as the cron backstop otherwise).
