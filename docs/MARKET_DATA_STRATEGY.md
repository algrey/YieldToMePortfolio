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
- Provider failure, throttling, malformed data, missing symbols, and suspected anomalies preserve the previous valid observation where available; otherwise compact views show `unavailable`. They never produce zero.

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
- Compact UI generally suppresses timestamps and routine freshness/source labels and never says “live” without a real-time entitlement. State remains inspectable; inline status is reserved for action-required conditions, and `unavailable` appears when no usable quote exists.
- Provider replacement can pass the common contract suite.

## 17. Sharesight as a secondary price source (BRK-012A/BRK-012B/BRK-012C, 2026-08-20)

`domain/sharesight/` (BRK-003+) was originally scoped as a read-only broker-sync source for trades/holdings/payouts, deliberately out of the market-data-provider abstraction above (§7). BRK-012A/BRK-012B narrow that: `listUserInstruments` (`GET /user_instruments.json`) is now ALSO a delayed-price source, seeded into `market_data_providers` as a second row (`id`/`code` = `sharesight`, migration `0044_seed_sharesight_provider.sql`, mirroring `0037`'s `yahoo-compatible` seed).

- **Entitlement: the owner's OWN Sharesight account, never a shared/public feed.** Every price this source supplies is fetched with the deployment's single `client_credentials` grant against the owner's real Sharesight account (`worker/sharesight-config.ts`). Accordingly every written `price_observations` row is `access_scope = 'user'`/`scope_user_id` = that owner — see §8's `access_scope` distinction — NEVER `'deployment'`, unlike the Yahoo-compatible EOD path. A future multi-owner deployment where two owners hold the same security would NOT share a Sharesight-sourced observation between them the way a deployment-scoped Yahoo observation is shared.
- **Delayed, timestamp-anchored, never labelled live.** `current_price_updated_at` is the ONLY freshness signal this source carries — BRK-012A's live spike found the owner's "~20-minute delay" expectation INCONCLUSIVE (both runs ran after ASX close), so no delay magnitude is ever assumed or displayed; `interval = 'delayed'` with `delayed_minutes = NULL` (an honest "unknown duration", not a fabricated zero). Per AGENTS.md, this is never presented as `live`.
- **No historical backfill — accretion-forward only.** The only documented historical-daily-price route (`GET /instruments/:id/prices.json`) is a confirmed hard HTTP 406 gate for this API client across every policy-compliant Accept/path/query variant (§8.2's BRK-012A follow-up entry) — `domain/sharesight/client.ts`'s `listInstrumentPrices` method was REMOVED, not merely left unpromoted, per that entry's "do not re-attempt" ruling. Instead, each hourly refresh (`app/sharesight-price-refresh-service.ts`) upserts THAT day's observation from the live `current_price`, one row per (security, market_date, source, scope) — a same-day re-fetch OVERWRITES (converges toward the close, `db/schema.ts`'s `price_observations_provider_scope_mapping_date_unique` partial index scoped to `provider_id = 'sharesight'` only, so every OTHER provider's legitimate same-day "correction received later" pattern — e.g. `tests/calc-002-repository.test.ts`'s fixture — is completely unaffected). A pre-Sharesight day for a security has no Sharesight-sourced row at all and never will; existing Yahoo-compatible EOD history is untouched and keeps serving those dates.
- **Scope: the owner's OWN `portfolio_securities`, any status.** Resolved through `security_identifiers(scheme = 'sharesight_instrument')` (BRK-009A) — never ticker text. An instrument Sharesight returns that matches none of the owner's identifiers is ignored, with the count disclosed in the refresh result, never guessed onto a nearest-ticker security.
- **Provenance completeness.** Every write carries `provider_id = 'sharesight'`, `access_scope`/`scope_user_id`, `observation_at`, `market_date` (derived from Sharesight's original timestamp's OWN offset, not a UTC conversion), `market_timezone` (the observed numeric offset, e.g. `+10:00` — Sharesight supplies no IANA zone name, and none is invented from `market_code`), `currency_code`, `ingested_at`, `adjustment_state = 'raw'`, `quality = 'observed'`. **`observation_at` CORRECTION (BRK-012B review finding B1(a), 2026-08-20, BLOCKING):** an earlier version of this note claimed `observation_at` retained Sharesight's raw offset string; that was WRONG and blanked the owner's holdings view on the very first hourly write (`app/owned-holdings.ts`'s `mapPrice` validates `observation_at` against a Z-only ISO regex, which a `+10:00`-suffixed string fails, silently caught into an "unavailable" state). `observation_at` is now normalized to a UTC `...Z` ISO string at write time (`domain/sharesight/price-accretion.ts`'s `normalizeTimestampToUtcIso`) — Sharesight's raw offset-preserving string is not separately retained (`price_observations` has no spare column suited to it); this conversion IS the documented rule. `market_date`'s derivation is UNCHANGED and still reads the ORIGINAL, pre-conversion offset string — the two derivations run independently against the same source string, never chained, so this fix does not reintroduce the UTC-conversion date-shift bug `market_date`'s own derivation exists to avoid.
- **`security_provider_mappings` requirement.** `price_observations.mapping_id` is a hard FK into `security_provider_mappings`; the write path guard-creates a `status = 'candidate'` mapping (`provider_exchange`/`provider_symbol` = Sharesight's own `market_code`/`code`) on a security's first accretion write, since the identity itself was already durably resolved via `sharesight_instrument` before any price write is attempted — this mapping row is a technical FK anchor, not a fresh unverified candidate awaiting owner review the way a CSV-ticker mapping is.
- **Selection for CURRENT holdings (BRK-012C, lifted from BRK-012B's storage-only exclusion): wired in, historical/snapshot valuation UNCHANGED.** `app/owned-holdings.ts`'s `loadOwnedHoldings` (the holdings valuation read path — also the shared source `app/owned-income-projection.ts` and `app/owned-dividend-assumptions.ts` both build on) removed its `provider_id <> 'sharesight'` predicate: a Sharesight accretion row now participates in the EXISTING selection machinery (`domain/market-data/selection.ts`) exactly like any other provider's row, unchanged selection logic — `providerRank` ranks `interval = 'delayed'` ahead of `'eod'` for the same market date, and STILL does (§21's MKT-012 note: that ordinary tie-break was never changed). **MKT-012 round 2 (owner ruling, 2026-08-22) adds a NARROWER, separate owner-import precedence tier** (`§21`) ahead of `providerRank`, not a change to `providerRank` itself: a same-or-newer-date owner-uploaded CSV close (`provider_id = 'owner-import'`) now outranks a same-date Sharesight accretion row here — the practical outcome for THIS bullet's worked example is unchanged from a round-1 attempt at this task (CSV still wins), but the mechanism is narrower and does not touch ordinary provider-vs-provider (e.g. Yahoo eod vs Yahoo delayed) same-date ties elsewhere. A same-date Sharesight row still wins against an older owner-import date and against no owner-import row at all. `db/repositories/snapshots.ts`'s snapshot-rebuild fact loader (the Overview daily-history chart) KEEPS its identical predicate — historical/snapshot valuation stays on the Yahoo-compatible EOD feed only, a deliberate BRK-012C ruling, not an oversight. The Quotes-page read this bullet originally described, `app/owned-quotes.ts`, is retired (WLT-001, 2026-08-22, superseded by the user-scoped watchlist) — its successor `app/owned-watchlist.ts` is NOT deployment-only: it merges deployment- and this-owner's-own-user-scope observations in ONE `selectPriceObservation` call (the same shape `app/owned-holdings.ts` uses), so a Sharesight accretion row already participates there by design, with no exclusion predicate to describe. (§19's per-holding price-history chart DELIBERATELY diverges from this exclusion and includes Sharesight rows — see that section for why a historical DISPLAY is not the same honesty problem as a valuation input.)
- **The delayed-price cache + 10-minute read gate (BRK-012C).** A new table, `sharesight_delayed_prices` (`db/schema.ts`, migration `0045`), holds ONE row per (user, security): the latest observed price/currency, Sharesight's own quote timestamp (`quote_at`), and the ingestion time (`fetched_at`) — an audit/freshness-display store, kept per-security. `app/owned-holdings.ts` calls `app/sharesight-price-gate-service.ts`'s `ensureSharesightPriceFreshness` before reading `price_observations`: if this owner has an enabled Sharesight link and their PER-OWNER attempt watermark (see below) is missing or older than 10 minutes, it makes ONE bounded `listUserInstruments()` call, then upserts BOTH `sharesight_delayed_prices` (the cache) AND `price_observations` (the SAME accretion write BRK-012B's hourly cron already makes, reusing `buildSharesightPriceAccretionPlan`/`upsertSharesightPriceObservations`) from the identical result — so the table the selection machinery actually reads (`price_observations`) is refreshed as a side effect of the gate's own freshness check, never read directly by the holdings display path itself. **Staleness is a PER-OWNER fact, not per-security (review round B1, 2026-08-20, BLOCKING fix):** one `listUserInstruments()` call refreshes everything fetchable for an owner in one shot, so a held security Sharesight never matches can never have a cache row — an earlier per-security cache scan reported "stale" on every load for any portfolio holding even one such security, defeating the 10-minute window entirely. The gate now reads a single-row watermark (`sharesight_sync_state.last_price_refresh_at`/`_status`/`_error_kind` — the SAME trio BRK-012B's cron already stamps, deliberately reused rather than a second near-duplicate column set) instead; a held-but-unmatched security simply has no cache row and its price stays whatever `price_observations` already offers, honestly. Within the 10-minute window, the gate makes ZERO Sharesight requests (asserted by test, including a mixed matched/unmatched-security portfolio and three simulated call sites in one window). Stampede-safe: a single-flight lease (CAS-claimed on the owner's enabled `sharesight_sync_state` row, `price_refresh_lease_owner`/`price_refresh_lease_expires_at`, mirroring `calculation_runs.claim()`'s conditional-UPDATE pattern) means a losing concurrent request skips the fetch and serves whatever is already there. A fetch failure serves the stale cache/observations with their honest, unchanged age AND stamps the shared watermark with `status = 'failed'` + the error kind (review round B2 fix) — the gate never throws for an ordinary outcome, the page never blocks, and a persistently broken fetch cannot be retried on every render since the failed attempt itself holds the window closed.
- **Day-change guarantee: the gate backfills a still-recoverable prior trading day BEFORE its cache is overwritten (MKT-015, 2026-08-22).** Day-change display needs two consecutive comparable-basis `price_observations` days; before this, a day accreted ONLY via the read gate above (which never fires unless the app is opened) or the hourly cron (§ above), so any day nobody opened the app AND no cron tick landed for went honestly `missing_previous` — locally this was every day, since local dev runs no cron at all (`wrangler dev` delivers no scheduled events by default; see `docs/ARCHITECTURE.md`'s local-dev note for exercising the cron manually). Fix: `refreshAndCache` (`app/sharesight-price-gate-service.ts`) now reads the delayed-price cache's PRE-refresh row for every matched security — via the SAME chunked `loadSharesightDelayedPriceCache` the cache already uses elsewhere — BEFORE the fresh fetch's candidates overwrite it, and derives a backfill candidate (`domain/sharesight/price-accretion.ts`'s `buildSharesightPriceGateBackfillCandidates`) for any market date the cache still evidences that has no corresponding `price_observations` row. That candidate is written through the SAME idempotent `upsertSharesightPriceObservations` upsert (`price_observations_provider_scope_mapping_date_unique`, converge-never-duplicate) every other candidate uses, so it can never collide with or duplicate the fresh write for the CURRENT day.
  - **The backfilled date is stored verbatim, never re-derived (review round B1, 2026-08-22, BLOCKING fix).** An earlier version of this mechanism re-derived the backfill date by slicing the cache's `quote_at` — already a UTC-normalized instant — which is exactly the date-shift bug `deriveMarketDateFromTimestamp`'s own doc comment forbids elsewhere in this same section: an AEDT `+11:00` morning quote UTC-converts onto the PREVIOUS calendar day, so that approach fabricated a date Sharesight never quoted (and, symmetrically, could fire a spurious backfill on a genuine same-day re-read). **Migration `0052`** adds `market_date`/`market_timezone` columns directly to `sharesight_delayed_prices`, populated at cache-write time from the SAME correctly-derived-from-the-original-offset-string values every other candidate uses — the backfill mechanism now reads those two columns back VERBATIM, no re-derivation, no slicing, no approximation of the date OR the offset. A cache row written before migration `0052` has both columns `NULL` (a legacy row) and is skipped honestly rather than ever guessed at — the very next ordinary refresh repopulates both together, so the gap self-heals within one refresh cycle.
  - **Never downgrades an already-fresher row (review round B3, 2026-08-22, BLOCKING fix).** A backfill candidate is built from a cache snapshot that can be hours or days stale by the time it is finally written (e.g. the app was not opened again until well after the rollover), so it is possible — though narrow — for `price_observations` to already hold a MORE RECENT write for that exact prior day by the time the backfill runs (e.g. the hourly cron wrote it independently, more recently than this gate's own cache read). `upsertSharesightPriceObservations` takes a `noDowngrade` option (`app/watchlist-actions.ts`'s existing `WHERE excluded.observation_at > price_observations.observation_at` never-downgrade pattern) that the backfill write path alone passes; the ordinary same-day converge-toward-the-close write is completely unchanged and never gains this guard.
  - **Honesty limits, deliberate.** Only the SINGLE date the cache still holds ever backfills — `listUserInstruments` exposes only Sharesight's current price, never history (the same BRK-012A 406 dead-end above), so if the cache itself last saw a quote several trading days before the next refresh (e.g. the owner's last read was Wednesday and the next is the following Monday), only Wednesday recovers; the days between are never observed by anything and stay honestly `missing_previous`, never guessed. A security entirely ABSENT from the fresh fetch's own plan (e.g. it drops out of Sharesight's response for a refresh) is never even considered for backfill — the mechanism only ever looks up the cache for a security that DID appear in that refresh's fresh candidates. `instrumentCode`/`marketCode` are reused from the fresh candidate for the same security (stable instrument identity, not a per-day fact); price, currency, market date, and market timezone are ALL verbatim from the cache's own stored values, never approximated. A security whose only prior-day row is owner-import EOD (not Sharesight) stays honestly `price_basis_changed` for day-change until two Sharesight days exist — expected, self-heals (unchanged by this fix, see the cross-basis note two bullets above).
- **Display label: always "Delayed (Sharesight)", never "live".** `app/owned-holdings.ts`'s row explanation text (the accessible detail panel, per AGENTS.md's "compact views may suppress routine labels, explanations must remain accessible" rule) renders `interval = 'delayed'` selections as `Delayed (Sharesight) as of <quote timestamp>` rather than the bare interval name every other provider gets — the quote timestamp is `price_observations.observation_at` (Sharesight's own `current_price_updated_at`, UTC-normalized). The word "live" is never used to describe this data anywhere in the codebase (AGENTS.md non-negotiable, grep-asserted by `tests/brk-012c.test.ts`). A cross-basis daily-movement comparison (today's price from a different selection class than yesterday's, e.g. Sharesight-delayed vs. Yahoo-compatible EOD) renders its own honest "Movement unavailable (price basis changed)" text rather than the generic "unavailable" (review round B3 fix, `docs/CALCULATIONS.md` §2) — the CURRENT price is still shown correctly; only the day-over-day comparison is withheld.
- **Trigger: hourly cron sweep, dual-gated (unchanged from BRK-012B) — the outer freshness bound when nobody is looking.** `worker/index.ts`'s existing `scheduled` handler (cron `0 * * * *`) calls `runScheduledSharesightPriceRefresh` alongside the pre-existing Yahoo/corporate-action/calculation sweeps. Work happens only when BOTH `SHARESIGHT_CLIENT_ID`/`SHARESIGHT_CLIENT_SECRET` are configured AND at least one owner has an ENABLED `sharesight_sync_state` link — either gate absent is a `skipped: true` no-op with zero DB reads and zero Sharesight requests, mirroring the existing Yahoo `marketDataProvider === 'disabled'` skip. `listUserInstruments` is fetched exactly ONCE per run (one Sharesight account covers every owner sharing it); a fetch failure is recorded explicitly (`status = 'failed'` + the error kind) on every enabled link's watermark, never partial-silent; the SAME run also upserts the delayed-price cache from the identical candidates (review follow-up 2). The BRK-012C read gate above is a SEPARATE, per-owner, per-request trigger with its own single-flight lease, but DELIBERATELY SHARES the cron's watermark column (see above) — an hourly cron sweep therefore "resets the gate clock" for free: the very next portfolio load after a cron run sees a fresh watermark and serves cache/`price_observations` with zero Sharesight calls. Either trigger alone keeps `price_observations`/the cache honestly current within its own bound (≤10 minutes while actively viewed, ≤1 hour as the cron backstop otherwise).

## 18. Owner-uploaded price history (MKT-008, 2026-08-21)

The "Historical Data" section on the import page fills the historical
backfill Sharesight structurally cannot provide (§17's "no historical
backfill" ruling, BRK-012A's 406 evidence): the owner can upload a
per-security daily-price CSV (Intelligent Investor's export shape today),
export a full backup of everything this feature and Sharesight's accretion
have written for them, and re-import that backup.

- **One generic provider row, source detail lives per-upload.** `market_data_providers` gains a THIRD seeded row, `id`/`code` = `owner-import` (migration `0046_mkt_008_price_uploads.sql`, mirroring 0037/0044's identical idempotent-seed technique). The upload's actual source (`"intelligent-investor"` today) is a `price_upload_batches.source_label` value, never a second provider row — a future different CSV shape/broker fits by choosing a new `source_label`, never a schema or seed change.
- **Attribution, not staging.** A new table, `price_upload_batches` (`db/schema.ts`; owner-scoped, purge-lock triggers hand-appended per the 0034/0045 precedent), records who uploaded what and the resulting row/malformed counts — one row per upload (single-security CSV or backup re-import). `price_observations` gains a nullable `upload_batch_id` (plain ADD COLUMN, deliberately no FK — see that column's schema comment for why a real FK would force a `price_observations` table rebuild for a soft attribution link the write path already enforces by construction). Unlike the ledger CSV flow, this feature has NO staging-row table: parsing and ticker resolution are pure/deterministic over the uploaded bytes plus the owner's already-existing securities, so "preview" is simply running the same read-only computation "confirm" is about to run and showing the result — the client resubmits the identical file on confirm (`app/price-upload-service.ts`'s header comment).
- **Ticker resolution: match-only, same-user scope, never auto-create.** `domain/market-data/resolve-price-upload-security.ts` resolves the file's ticker plus the settings' exchange/currency (defaulting ASX/AUD) against the owner's OWN `portfolio_securities`/active ticker `security_identifiers` evidence only — no cross-owner tier, no creation tier (unlike BRK-009B's Sharesight auto-create): a price file for a security the owner does not hold is meaningless here, so a `no_match` is an honest, named error, and ambiguous evidence (contradicting or multiple non-contradicting exchange candidates) lists the candidates rather than guessing.
- **Timezone: an explicit, honest allow-list, not exchange-table lookup.** `exchanges.timezone` is unpopulated in this deployment (BRK-009A's carried F2 finding), so `domain/market-data/exchange-timezone.ts` keeps a small, explicit `{ ASX: "Australia/Sydney" }` map instead of inventing exchange metadata the schema does not actually have; an exchange alias outside this map is rejected, never given a guessed timezone. `observation_at` is the UTC instant of MIDNIGHT on the file's date in that timezone (the "midnight-exchange-timezone convention") — the file's own `HH:MM:SS`, when present, is discarded (an export artifact, never genuine intraday precision); `market_date` is the literal exchange-local date from the file. Follow-up (5, documented, not fixed): the convention names midnight in the EXCHANGE's own timezone, never a portfolio's `timezone` column — correct today since ASX is this feature's only supported exchange and every owner using it observes an Eastern-Australia-adjacent local day, but a future exchange west of the exchange's own date line relative to a portfolio's configured timezone (unreachable while the allow-list holds one exchange) would need this re-examined before extending the allow-list.
- **Follow-up (2): the backup format's "lossless" claim is bound to the SAME provider allow-list `domain/market-data/price-backup-csv.ts` enforces on re-import (`sharesight`, `owner-import` today) — a row this deployment could not honestly have exported never appears, so the round trip is lossless FOR THOSE PROVIDERS, not a universal guarantee across a hypothetical future provider set. Re-import also always RE-STAMPS `ingested_at` to the restore's own write time (never preserves the original ingestion instant) — this is intentional, not a fidelity gap: `ingested_at` is defined as "when THIS deployment ingested the fact," and a restore is itself a real ingestion event, not a replay of history.
- **Write semantics: `interval = 'eod'`, `quality = 'observed'`, `adjustment_state = 'raw'`, natural-key idempotent upsert.** Unlike Sharesight's same-day-converging accretion model, owner-import (and any future non-Sharesight backup-preserved provider) needs NO new partial unique index: `observation_at` is a DETERMINISTIC function of `market_date` for this write path (the midnight convention above), so re-importing an identical date always produces the identical `observation_at` and upserts onto the SAME row via the PRE-EXISTING general `price_observations_provider_scope_mapping_unique` index. `db/repositories/price-uploads.ts`'s `writePriceUploadObservations` guard-creates a `security_provider_mappings` candidate row per (provider, security) exactly like `sharesight-price-refresh.ts` does (the same hard-FK-anchor requirement), chunked at 25 candidates/`batch()` call for the same D1 statement-budget reasons BRK-012B documents.
- **Backup export/import: user-scoped rows only, provider preserved.** The export streams a self-describing CSV (`domain/market-data/price-backup-csv.ts`, `format_version = "yieldtome-price-backup-v1"` per row) of every one of the owner's `access_scope = 'user'` `price_observations` rows — Sharesight's accretion rows included, deployment-scoped rows excluded (never the owner's to export). Each row carries its provenance via `security_provider_mappings` (symbol/exchange evidence anchored by `mapping_id`), the provider id, market date/price/observation instant, and quote metadata. Re-importing a backup resolves each row's identity through the SAME same-user-scope resolver above, then writes it back under its ORIGINAL `provider_id` — a Sharesight-sourced row re-imports as `sharesight`, never relabelled `owner-import` — so overlaying a backup onto live data (including onto Sharesight's own ongoing accretion) is natural-key safe by construction. Only `sharesight`/`owner-import` are accepted provider values on re-import today (an explicit allow-list, not a schema constraint — a future new provider extends the list, never a migration).
- **Deletion is creation-scoped, not a snapshot restore. Attribution is stamped on INSERT only, never reassigned by a later overlay (review B1 fix, BLOCKING, 2026-08-21).** The reviewer drilled the original design (an overlay's `ON CONFLICT` clause unconditionally reassigned `upload_batch_id` to the OVERLAYING upload) and found a data-destruction hazard: deleting a backup import that had merely overlaid an existing Sharesight-accreted observation silently destroyed that observation — data Sharesight cannot re-supply (no historical backfill, §17) — even though the deleting upload never created it. Fixed: `writePriceUploadObservations`'s `ON CONFLICT DO UPDATE SET` updates price/quote fields only and leaves `upload_batch_id` untouched, so it always names whoever CREATED the row. Deleting an upload therefore removes EXACTLY the `price_observations` rows it created (`upload_batch_id = ?`); a row it merely overlaid keeps the value it last wrote (NOT reverted — no versioned-override history for market-data facts, out of scope) but stays attributed to its original creator, so a LATER delete of that original upload still correctly removes it. `price_upload_batches.row_count` (every valid row the upload's file contained) and `inserted_row_count` (the subset it created) can therefore differ; the owner-facing delete-confirmation copy and past-uploads list both state the real number a delete will remove, never implying created/overwritten are the same thing. **Follow-up (review, 2026-08-21): that owner-facing number is a LIVE `COUNT(*) WHERE upload_batch_id = ?`, not the stored column.** Writing the count happens in two steps (the chunked write, then an `UPDATE` stamping `inserted_row_count`) -- a crash between them would otherwise show a stale count (e.g. `0` while attributed rows already exist). `listPriceUploadBatches` computes it live per batch instead (self-healing, cheap via the existing `upload_batch_id` index); the stored column is retained only as an internal summary artifact, never trusted for the delete-facing figure. Re-uploading the identical file after a delete reconstructs byte-identical facts under a new batch id — market-data observations have no versioned-override ledger the way ledger transactions do, so "restore" means "the same facts exist again," not "the same row ids return."
- **Selection: owner-import rows feed BOTH current holdings AND historical snapshot valuation.** Unlike Sharesight (§17: current-holdings-only, snapshot valuation deliberately excludes it), `db/repositories/snapshots.ts`'s fact loader excludes ONLY `provider_id = 'sharesight'` — an owner-import EOD row is a genuine historical daily close, exactly the same shape as the Yahoo-compatible feed, so it participates in the Overview daily-history chart without any code change (verified by test: the exclusion predicate was already `provider_id <> 'sharesight'`, not an allow-list). This is the entire point of the feature — filling gaps in the historical chart Sharesight cannot backfill.

## 19. Per-holding price-history chart (UI-018, 2026-08-21)

The holding-detail price-history chart (`app/owned-price-history.ts`, `app/components/holding-price-chart.tsx`) reads every provider the owner's account may see for that security — deployment rows plus the owner's own `owner-import`/`sharesight` user-scoped rows, deliberately WITHOUT §17's `provider_id <> 'sharesight'` holdings/snapshot exclusion (this is a historical display, not a valuation input) — and where two providers cover the same `market_date` picks one honest per-date value (an `eod` close beats a `delayed` quote; otherwise the most recently observed row wins) rather than plotting conflicting lines; long ranges are bounded server-side to ≤400 points via last-observation-per-bucket downsampling, never an averaged or interpolated value. **Single-currency constraint (review round-1 fix, B1, 2026-08-21, BLOCKING):** the series is constrained to the holding's own identity currency (`securities.primary_currency_code`, the same value `app/owned-holdings.ts` treats as authoritative) — a `price_observations` row in any OTHER currency sharing that `security_id` is excluded from the plotted line rather than mixed onto it, with the exclusion count disclosed in `provenance.excludedCurrencyCount`; the resolved currency code is always returned and rendered alongside every price. Malformed rows are similarly excluded and counted (`provenance.excludedMalformedCount`), never silently dropped. **Gap classification is scaled to the sampling cadence (review round-2 fix, 2026-08-21, BLOCKING):** a plain absolute day-count floor (added to catch a 2-3-point series' degenerate case, where too few deltas exist for a meaningful median) initially dashed EVERY segment of a heavily downsampled long range, since the RETURNED point spacing on such a range is itself roughly `bucketSize` observations apart — falsely implying a hole where downsampling had simply not returned every point. `classifyPriceHistorySegments` (`app/price-history-chart-geometry.ts`) now scales that floor to `max(10, bucketSize × ~4 calendar days)`, so ordinary bucket-to-bucket spacing on a downsampled range is never itself mistaken for a hole while a genuine hole (many multiples of that spacing) still dashes. A dashed segment's title also varies honestly by `bucketSize`: "No observations between X and Y" only when the series was NOT downsampled (`bucketSize === 1`); a downsampled gap instead states "Downsampled: a hole in the stored data wider than this series' sampling spacing (between X and Y)" — the chart never claims certainty about zero raw rows it did not itself verify, and (review round-3 fix) never states a numeric cadence figure either, since the CLASSIFICATION threshold used to flag the gap is not the same thing as this series' actual observed spacing (an earlier "about one point per N days" wording overstated sparsity by quoting that threshold as if it were the real cadence).

## 20. Yahoo authenticated-session evidence spike (MKT-009A, 2026-08-21)

Owner directive (2026-08-21): "add a login for Yahoo Finance — I suspect YF will work better with a login." Evidence-first per the BRK-008/BRK-012A pattern: this section establishes what an authenticated Yahoo session actually buys BEFORE any integration code is written (MKT-009B). Yahoo has never published a public API or an authentication contract for `finance.yahoo.com`'s JSON endpoints — everything below, auth or anonymous, is reverse-engineered third-party evidence, not vendor documentation. Findings are labelled **VERIFIED** (this spike, or `domain/market-data/yahoo-compatible.ts`, directly observed it) or **COMMUNITY-REPORTED** (a third-party client's source/issue tracker claims it; not independently confirmed here). `scripts/yahoo-auth-spike.mjs` is the evidence tool; it runs an always-on anonymous leg against public tickers (AAPL, BHP.AX) and a gated authenticated leg that only runs if the owner has supplied login cookies (none were supplied for this run — see below).

- **Auth mechanism for a headless Worker: owner-exported browser cookies, no headless grant exists.** Yahoo login is interactive (password + 2FA/captcha-gated). INFERENCE, not directly tested (Yahoo publishes no auth contract at all to confirm or rule this out against): there is no client-credentials-style grant a Cloudflare Worker could obtain unattended, drawn from the absence of any documented non-interactive grant anywhere in this research, not from an attempt that was refused. The only realistic path is the owner exporting session cookies from an already-logged-in browser. **COOKIE NAMES, VERIFIED against current source, correcting this task's own brief:** this task's brief guessed the general Yahoo browser cookies `A1`/`A3`/`A1S`. The authoritative correction comes from `yfinance`'s current `main` branch (`ranaroussi/yfinance`, `yfinance/data.py`, read 2026-08-21, actively maintained — commits as recent as 2026-07-22): its `Auth.set_login_cookies(cookie_t, cookie_y)` docstring instructs the user to log in to `https://finance.yahoo.com`, open DevTools → Application/Storage → Cookies → `https://finance.yahoo.com`, and copy the cookies named exactly **`T`** and **`Y`** — distinct from the anonymous session cookie. `A3` is real but serves a DIFFERENT purpose: it is the anonymous, unauthenticated session cookie `fc.yahoo.com` issues (yfinance's own `_load_cookie_curlCffi` reads `cookies[domain]['/']['A3']` to cache it across runs) — this spike's own anonymous leg VERIFIED `fc.yahoo.com` sets exactly one cookie, named `A3`, with a ~1-year expiry (`Sat, 21 Aug 2027`) from this run's IP; no `A1`/`A1S` cookie was observed in this environment. So: `A3` ≠ a login cookie; `T`/`Y` are the login cookies, and this codebase's own spike script uses `YAHOO_COOKIE_T`/`YAHOO_COOKIE_Y` accordingly.
- **The crumb handshake is SEPARATE from login and applies to both anonymous and authenticated sessions.** VERIFIED: `GET https://query1.finance.yahoo.com/v1/test/getcrumb`, sent with whichever cookie jar (anonymous `A3` or login `T`/`Y`) is in hand, returns a short opaque text token paired to that cookie's session — required by SOME endpoints, not the ones this adapter calls (see below). COMMUNITY-REPORTED (yfinance `data.py`, same file): Yahoo tightened this path since mid-2023; the crumb is minted server-side per cookie session (not extractable from static HTML any more), and yfinance maintains TWO independent anonymous strategies (`basic` via `fc.yahoo.com`, `csrf` via a `guce.yahoo.com` consent-form flow) with automatic fallback between them because either can intermittently break — this spike deliberately probed only the `basic` strategy to keep the request count small (see "Constraints"; the `csrf` fallback is documented, not re-probed live here).
- **Lifetime/rot: VERIFIED partially, one clear negative result, one still-open question.** VERIFIED: the anonymous `A3` cookie itself is long-lived (~1 year) — cookie EXPIRY is not the practical constraint. VERIFIED, reproduced twice in this spike (two separate runs, each with a freshly minted `A3` cookie), both run from the same machine that executed this spike: `GET /v1/test/getcrumb` returned **HTTP 429 both times**, immediately, on the very first attempt — not a rot/expiry symptom, a rate-limit/block symptom, currently affecting that machine's own egress IP on this specific endpoint. **This spike ran on a local workstation, not the production Cloudflare Worker** — the Worker's egress is a DIFFERENT IP this spike never tested, so whether the same block applies there is an open question this evidence does not resolve either way. This is exactly the kind of intermittent breakage `yfinance`'s own crumb code anticipates (its `_get_crumb_basic` explicitly checks for a `429`/"Too Many Requests" body and raises a dedicated rate-limit error rather than treating it as a hard failure). COMMUNITY-REPORTED (no source-code confirmation found): whether a login cookie's PAIRED crumb rots faster/slower than an anonymous one, or whether Yahoo signals crumb expiry any differently once logged in — not established either way; the owner would need to observe this over a real logged-in session to know. **Renewal, if it does rot: owner re-export required.** There is no refresh-token-style renewal path (unlike Sharesight's OAuth `refresh_token` grant, §17/BRK-008) — `T`/`Y` are themselves a live browser session snapshot; when they stop authenticating, the only fix is the owner logging in again and re-exporting.
- **What auth actually changes vs anonymous: narrower than the "will work better" hope, and NOT rate limits.** VERIFIED (this spike): the account-entitlement endpoint `GET https://query1.finance.yahoo.com/ws/obi-integration/v1/subscriptions` — the SAME endpoint `yfinance`'s `Auth.check_login`/`Auth.subscription_tier` use to determine login state and paid-tier ("free"/"bronze"/"silver"/"gold"/"premium") — returned a clean **HTTP 401** anonymously in this spike, confirming it as a reliable, crumb-free, cookie-only signal of "not logged in." What it would return authenticated was NOT verified (no owner cookies were available this run — see "What could not be completed" below). VERIFIED: the endpoints this codebase's OWN adapter actually calls (`v8/finance/chart/<symbol>` for prices/dividends/splits, `v1/finance/search`) already work fully anonymously, need NO crumb at all today (confirmed both by re-reading `yahoo-compatible.ts`, which never sends one, and by this spike's live anonymous chart/search calls, both HTTP 200 with no crumb), and returned `exchangeDataDelayedBy: null` for both AAPL and BHP.AX in this run (an "unknown/unstated delay," the same honest state the adapter already normalizes to `delayed_minutes = null` when absent — not evidence either way of real-time vs delayed). COMMUNITY-REPORTED, and the single most important expectation-setting fact for the owner: multiple independent `yfinance` rate-limit discussions (e.g. `ranaroussi/yfinance` issue #2220, "How to increase rate limit," and issue threads around the November 2024 rate-limiting tightening) treat 429s as IP-pattern-based, not account-based, and no maintainer or community source found in this research confirms that a logged-in (let alone a FREE logged-in) session raises the request-volume ceiling. In short: the crumb-free anonymous **401** on the entitlement endpoint is VERIFIED as a reliable "not logged in" signal; what an AUTHENTICATED call to that same endpoint actually returns (a 200 with `guid`/`subscriptionView` tier data, per `yfinance`'s `Auth._fetch_entitlement`) is COMMUNITY-REPORTED only — this spike never observed it (no owner cookies were available). Login is NOT verified to buy higher rate limits or real-time (vs delayed) quotes — those would only plausibly follow from an actual PAID Yahoo Finance subscription, which is unconfirmed for the owner's account.
- **ToS/redistribution reality, stated plainly.** Yahoo's general Terms of Service (`legal.yahoo.com/us/en/yahoo/terms/otos/`, read 2026-08-21), §2(a)(ix), prohibit accessing or collecting data "using any automated means... robots, spiders, scrapers, data mining tools, or data gathering or extraction tools... without our express, prior permission"; §2(a)(x) separately bars using Yahoo content to build a database/data feed that "competes with or constitutes a material substitute for the Services." Yahoo's DEVELOPER API terms (a different, narrower document, for the officially retired public API) are not the governing document here — there is no published terms document for the unofficial `query1`/`query2` JSON endpoints at all, anonymous or authenticated; using them, logged in or not, sits outside any Yahoo-sanctioned access path. This is unchanged risk this repository already accepts for the anonymous adapter (§3–§5); adding a login does not reduce it and arguably raises the personal-identifiability stakes slightly (a request now carries the owner's own session cookie rather than an anonymous one). Personal, non-redistributed, single-owner use — this deployment's actual shape — is the lowest-risk end of that spectrum, consistent with community consensus that enforcement risk concentrates on commercial/redistributive use, but "lowest-risk" is not "zero-risk," and this remains a `robots`/ToS-noncompliant path either way.
- **Failure-mode requirements for MKT-009B (binding on that task, not just descriptive here).** (1) An expired/invalid login cookie must degrade to TODAY's anonymous behaviour (or explicit `unavailable`/error, per AGENTS.md) — never a fabricated or stale-but-unlabelled price. VERIFIED signal to detect this: the entitlement endpoint's clean anonymous 401 (confirmed above) is the right primitive to check login validity BEFORE trusting an authenticated call, mirroring `yfinance`'s own `Auth.check_login`. (2) The crumb endpoint's observed 429 (this spike, reproduced twice) must NOT be misread as "cookies invalid/logged out" — it is a rate-limit signal, not an auth signal, and a 429 must be handled exactly like the existing adapter's `rate_limit` error kind (retryable, circuit-breaker-eligible per `yahoo-compatible.ts`'s existing `circuitOpen`/`recordFailure` machinery), never as a trigger to discard stored login cookies. (3) Because the endpoints this adapter actually calls today need no crumb at all, MKT-009B's SAFEST scope is adding the `T`/`Y` cookie header to those SAME existing calls (chart/search) without introducing a new hard dependency on `/v1/test/getcrumb` — only endpoints proven (by a future, cookie-equipped spike run) to actually require a crumb should pull that handshake in, keeping today's crumb-free reliability intact for everything else.
- **BRK-013A pre-seed (cheap, same spike run — read-only, no authenticated portfolio calls attempted).** A portfolio-read endpoint family is reachable at `GET https://query1.finance.yahoo.com/v7/finance/desktop/portfolio` (path sourced from a third-party unofficial client, `github.com/adriengivry/portfolyahoo`, `portfolyahoo/manager.py` on branch `master` (the repo's default branch), read 2026-08-21 — COMMUNITY-REPORTED, not Yahoo-documented); this spike's anonymous, crumb-less, no-`userId` call to it returned **HTTP 403** (VERIFIED), distinct from the entitlement endpoint's 401 — consistent with a family that exists and is gated on crumb+cookie+`userId` (a Yahoo account GUID) together, not on cookie presence alone. The same third-party client's source additionally references WRITE endpoints for this family — `POST /v1/finance/w/importPortfolio` (create from CSV), `PUT /v6/finance/portfolio/update`, `DELETE /v6/finance/portfolio` — all gated the same way, all plain HTTP verbs with no visible additional confirmation step in that source. COMMUNITY-REPORTED, not verified live (per this task's explicit scope, no authenticated portfolio call of any kind was attempted): flag this plainly for BRK-013A's own risk statement — a write endpoint reachable by three ordinary HTTP verbs, on a consumer account, with no separate confirmation step visible in the unofficial client that documents it, is exactly the kind of surface a scripted mistake could hit destructively; BRK-013C's mandatory preview-diff-before-write design should assume no server-side undo.
- **What could not be completed, and why that is still a valid deliverable.** No owner login cookies (`YAHOO_COOKIE_T`/`YAHOO_COOKIE_Y`) were available during this task — per this task's own constraints, the owner was not asked for them mid-task. `scripts/yahoo-auth-spike.mjs`'s authenticated leg is fully implemented and fails closed with an explicit, instructive skip message rather than fabricating or guessing authenticated evidence (verified live: the anonymous leg above is this spike's actual output; the authenticated leg printed its documented skip message). Once the owner supplies real `T`/`Y` cookies in a local, gitignored `.dev.vars`, re-running the same script would close the two open questions above: (a) what the entitlement endpoint actually returns for this owner's real account (tier name, confirming free vs paid), and (b) whether the crumb 429 observed anonymously also affects an authenticated crumb request from the same egress.

**Go/no-go recommendation for MKT-009B: CONDITIONAL GO, scoped down from the owner's stated hope.** Build a small, structurally optional enhancement — `T`/`Y` cookies added to the adapter's EXISTING chart/search calls (no new crumb dependency), graceful degradation to today's fully-anonymous behaviour whenever cookies are absent/invalid (entitlement 401) or the provider is rate-limited (429, handled by the existing circuit breaker, not miscategorized as a login failure) — because the value that IS verified here (a crumb-free, reliable not-logged-in signal on the entitlement endpoint, and a session that would be the owner's own rather than a shared anonymous cookie) is real but modest — the authenticated response itself (login confirmation plus subscription tier) remains COMMUNITY-REPORTED, not verified by this spike. Do NOT sell this to the owner as a rate-limit or real-time-data fix: the evidence found here (community rate-limit discussion, and this spike's own reproduced 429 against a completely fresh anonymous cookie) points the other way — Yahoo's throttling looks IP/pattern-based, not account-based, and nothing here confirms a free logged-in tier is treated any differently from anonymous for the specific endpoints this adapter uses. Before scoping MKT-009B further, the Orchestrator should ask the owner one direct question this evidence cannot answer: does the owner hold a PAID Yahoo Finance subscription (gold/silver/bronze)? If yes, entitlement-gated premium fields become a real, worth-scoping target and MKT-009B should be sized to detect and use that tier explicitly (never assumed). If no (a free account), the honest expectation is a marginal reliability/identity improvement only, and the owner may reasonably decide the added cookie-rotation maintenance burden (manual re-export whenever `T`/`Y` stop authenticating, no refresh path) is not worth it relative to today's working anonymous adapter.

### MKT-009B implementation (2026-08-21)

Owner rulings closed both open questions from MKT-009A's go/no-go: no paid Yahoo Finance subscription, and "make it configurable: logged in, not logged in, or sharesight." **Dated authenticated-leg evidence, owner-run 2026-08-21** (reported to this task by the owner/Orchestrator; NOT independently re-executed by this implementation task, which has no network access to Yahoo and never receives cookie values — recorded here as reported evidence, distinct from this task's own direct observation): with real `YAHOO_COOKIE_T`/`YAHOO_COOKIE_Y` values in `.dev.vars`, the entitlement endpoint (`GET /ws/obi-integration/v1/subscriptions`) returned **HTTP 200** with `loggedIn=true` and `activeSubscriptionCount=0` — closing MKT-009A's open question: the cookies authenticate a real, free (non-subscribed) account. An authenticated `v8/finance/chart/<symbol>` call also returned **200**. `GET /v1/test/getcrumb` returned **429 on BOTH legs** (anonymous and authenticated) from the owner's own workstation IP, consistent with MKT-009A's anonymous-leg 429 finding — reinforcing that the crumb endpoint's rate limiting is IP/pattern-based, not account/login-based, and that this implementation's decision to keep the crumb handshake out of scope (§20 above, "safest scope") remains correct.

**What this implementation actually does**, scoped exactly to MKT-009A's "CONDITIONAL GO":

1. **Config** (`worker/yahoo-auth-config.ts`, mirrors `worker/sharesight-config.ts`'s precedent exactly): `YAHOO_COOKIE_T`/`YAHOO_COOKIE_Y`, read only from Worker env/`.dev.vars`, inert (`{ enabled: false }`) when absent or half-configured, values never logged/echoed/returned outside the sealed credentials object.
2. **Adapter** (`domain/market-data/yahoo-compatible.ts`): a `Cookie: T=...; Y=...` header is attached ONLY to the adapter's pre-existing crumb-free chart/search calls (`fetchJsonAuthAware`) — no new dependency on `/v1/test/getcrumb`. A `401` on an authenticated attempt is treated as "this login session is invalid" and degrades that request (and every later one, via a sticky per-instance `authInvalid` flag — there is no cookie refresh path) to the SAME anonymous call, never a silent failure. A `429` is left to the adapter's pre-existing retry/circuit-breaker machinery untouched — never reinterpreted as a login failure, per MKT-009A's binding requirement. **Honesty caveat, INFERENCE not VERIFIED**: MKT-009A's own evidence only confirms the entitlement endpoint's 401 as a reliable not-logged-in signal; whether Yahoo's chart/search endpoints (which MKT-009A separately confirmed already work fully anonymously, needing no crumb or cookie at all) actually REJECT an invalid/expired login cookie with 401 — as opposed to silently ignoring it and serving the identical anonymous response — was not directly verified for those specific endpoints by any spike run. This adapter defensively treats any 401 received while sending cookies as an invalid-session signal (a reasonable, conservative default), but a future spike deliberately sending a KNOWN-invalid cookie pair to `v8/finance/chart` would be needed to upgrade this from inference to verified fact.
3. **Provenance**: recorded per observation in the existing `providerRevisionId` free-text field (no new `price_observations` column/migration — same technique this file's FX rows already use for direct/inverted tagging) as `session:authenticated` or `session:anonymous`, but ONLY when `auth` is actually configured; an unconfigured deployment keeps `providerRevisionId: null` for prices, byte-for-byte unchanged from before this task. Because Yahoo prices accrete one row per provider/mapping/date (last write wins), there is no separate stored "authenticated" and "anonymous" row to choose between at read time — the tag simply records what the LAST successful write actually was. Every price remains labelled with whatever `exchangeDataDelayedBy` says (`null`/unknown, or a real delay in minutes) exactly as before; this task adds no new "live" claim of any kind.
4. **Price-source preference** (`user_settings.price_source_preference`, migration `0048_mkt_009b_price_source_preference.sql`, FY-001 precedent): three owner-facing options, `yahoo_authenticated` / `yahoo_anonymous` / `sharesight_delayed`. This is a READ-TIME PREFERENCE over `domain/market-data/selection.ts`'s existing freshest-wins ranking (`selectPriceObservation`'s new `preferredProviderIds`), not a second activation gate — `MARKET_DATA_PROVIDER` remains the sole deployment-level kill switch for Yahoo, unaffected by this column. Both Yahoo options prefer the same `providerId` (`yahoo-compatible`) since, per point 3 above, there is no separately stored authenticated/anonymous row; `yahoo_authenticated` additionally surfaces an explicit, accessible "action required: re-export cookies" note (`app/owned-holdings.ts`'s `yahooAuthPreferenceUnmet`) whenever the selected Yahoo observation is NOT tagged `session:authenticated` — never silent anonymous data presented as satisfying the login preference. `sharesight_delayed` prefers `providerId = 'sharesight'` (BRK-012C's delayed-price cache/gate pipeline). In every case, a preferred source with zero usable (freshness/currency/scope-filtered) candidates falls through, honestly, to the best candidate from ANY source — never `unavailable` merely because the PREFERRED source is silent while another source has a valid observation. **Default: `sharesight_delayed`** — a deliberate choice to avoid silently regressing an existing linked owner's price freshness the day this column ships (BRK-012C's whole purpose is keeping Sharesight ≤10-minutes fresh at read time, so preferring it changes nothing material for that owner) while remaining a complete no-op for an owner with no Sharesight link at all (Sharesight never writes a row for them, so selection falls straight through to Yahoo — identical to this task's pre-existing behaviour). See `docs/ARCHITECTURE.md`'s decision note for the full reasoning and rejected alternative (defaulting to `yahoo_anonymous`, rejected as a real behaviour regression for linked owners).
5. **Out of scope, explicitly**: BRK-013A/B/C (Yahoo portfolio read/write) remain untouched by this task; this task adds no crumb dependency, no new Cloudflare product, and no change to `MARKET_DATA_PROVIDER`'s deployment-gate semantics.

## 21. Daily price capture: intraday sweep + end-of-day rollup (MKT-011A, 2026-08-22)

Owner-uploaded price CSVs (MKT-008) seed history up to the upload day; without
a daily mechanism the gap between "last upload" and "today" grows forever.
MKT-011A closes it: a NEW cron sweep (`25,55 * * * *`, alongside the existing
`0 * * * *` — `wrangler.json`'s `triggers.crons`, dispatched by
`controller.cron` in `worker/index.ts`) captures an intraday price for every
owner's held securities during their market's own 10:25–16:25 local
wall-clock trading window, then promotes the day's LAST captured point per
security into `price_observations` once that window closes.

**Two tables, two lifetimes.** `intraday_price_points` (migration
`0049_mkt_011a_daily_price_capture.sql`) is a NEW, small, owner-scoped cache
— one row per captured tick, retained ONLY for the current trading day and
purged immediately after a successful rollup. It is deliberately NOT
`price_observations`: that table's job stays "one durable, honestly-labelled
observation per (security, market_date, provider)"; the intraday cache exists
so `MKT-011B`'s "today" graph has something to draw from before the day's
close. The rollup write into `price_observations` uses `interval = 'delayed'`
and `adjustment_state = 'raw'` — it is the LAST delayed observation the
configured source gave for that trading day, NEVER labelled an official
exchange close (AGENTS.md).

**Source is a per-owner setting**, `user_settings.daily_capture_source`
(`sharesight` | `yahoo_anonymous` | `yahoo_authenticated`, default
`sharesight`) — distinct from MKT-009B's `price_source_preference` (a
READ-path preference among already-written observations); this is a
WRITE-path choice of which provider the sweep fetches FROM for this owner.
Cadence is a second per-owner setting, `daily_capture_interval_minutes` (30 or
60, default 60) — the cron fires every `:25`/`:55`, and a 60-minute owner's
captures are gated to the `:25` tick only (`app/daily-price-capture-service.ts`'s
`isCaptureTickEligible`); the actual fired minute is read from
`controller.scheduledTime`, since both ticks share one cron pattern string.
**Honest scope caveat (review round, 2026-08-22)**: the `:25`/`:55` cron
minutes are fixed in UTC, and this only aligns cleanly with a WHOLE-HOUR-offset
market's own local `:25`/`:55` wall clock — verified for the owner's actual
market, `Australia/Sydney` (ASX), across both of 2026's DST transitions
(AEST `UTC+10:00`, AEDT `UTC+11:00`, both whole-hour offsets). A
HALF-HOUR-offset market (e.g. `Asia/Kolkata`, `UTC+5:30`) would need its own
cron pattern before onboarding — this codebase has not verified what tick
alignment (and `isSecondaryTick` cadence-gating correctness) such a market
would actually get from the current fixed `:25`/`:55` schedule.

**Provider-ranking disclosure (MKT-012 round 2, Orchestrator ruling,
2026-08-22 — supersedes a round-1 fix to this task that a review round
rejected before it reached this document in its final form)**: the
freshest-wins provider ranking (`domain/market-data/selection.ts`'s
`providerRank`) decides purely by INTERVAL CLASS, never by `observation_at`
granularity or recency, and is UNCHANGED by MKT-012 — `intervalRank` is
still `0` for `delayed`, `1` for `intraday`, `2` for `eod` (lower wins), plus
a quality penalty (`stale_candidate` +4, `indicative` +2, `observed` +0). A
round-1 attempt at implementing the owner's ruling ("csv uploads should
outrank") flipped this table generically (`eod` ranked ahead of `delayed`
for EVERY provider at equal date age). Review rejected that: it never
reached the owner's own default configuration (MKT-009B's
`preferredProviderIds` narrowing ran BEFORE this tie-break and excluded the
owner-import row whenever a preference was configured, so `sharesight_delayed`
still selected Sharesight over the owner's own CSV close end-to-end), and it
silently regressed MKT-011A itself: Yahoo's own same-day PROVISIONAL `eod`
bar started beating MKT-011A's honest 16:25 `delayed` rollup capture on the
deployment scope (this section's own capture, read by `app/owned-watchlist.ts`
-- WLT-001's successor to the retired `app/owned-quotes.ts` this note
originally cited -- and `domain/snapshots/history.ts`) — nobody asked for
that, and it partially defeated the point of this section's own
daily-capture rollup.

**The fix (final): a NARROWER, separate owner-import precedence tier, ahead
of `providerRank`, not a change to it.** An owner-uploaded observation
(`provider_id = 'owner-import'`, `domain/market-data/selection.ts`'s
exported `OWNER_IMPORT_PROVIDER_ID` — the rows CSV upload/backup restore
create, §18) at the SAME market-date age as the best remaining candidate now
wins outright, regardless of that candidate's own interval — so an
owner-uploaded EOD close still systematically outranks a same-date
rollup/accretion observation (this section's own rollup, or BRK-012B's
hourly Sharesight accretion, `docs/CALCULATIONS.md` §2's MKT-012 note),
which is the owner's actual stated intent, but an ORDINARY provider-vs-provider
same-date tie (e.g. this section's own Yahoo `delayed` rollup vs. Yahoo's own
same-day `eod` bar, neither of which is owner-import) is UNCHANGED from
before this task: `delayed` still wins. `preferredProviderIds` narrowing
(MKT-009B, amended after review F6) admits the owner-import row into the
narrowed set when the configured preference matches at least one candidate,
and skips narrowing entirely — falling back to the FULL candidate set,
owner-import included alongside every other provider — when the preference
matches nothing; an earlier, rejected shape admitted owner-import
unconditionally even into an empty-match narrowing, which trapped selection
inside `{owner-import}` alone and let an OLDER owner-import row beat a
FRESHER non-preferred quote. Either way this tier honestly reaches every
`price_source_preference` setting, not merely the no-preference default; the
cross-scope combiner
(`app/owned-holdings.ts`'s `combineScopedPriceSelections`, since owner-import
rows are always user-scope) applies the identical rule before its own
preference-match branch, so a `yahoo_authenticated`/`yahoo_anonymous`
preference can never hand the deployment scope a win over a valid same-date
owner-import close purely because that scope's own selection happens to
match the preferred provider. A same-date owner-import row never beats a
STRICTLY NEWER market date from another source — the prior `dayAge`
comparison still runs first — and a non-owner-import observation still wins
outright when it is the only same-date candidate. Scoped to PRICE selection
only: no owner-uploaded FX rows exist, so `fx_rate_observations` selection
(`selectFxObservation`) is entirely unaffected by MKT-012, in either round.
`intraday` is not written into `price_observations` by any SCHEDULED
pipeline today (an owner backup restore CAN write an `interval = 'intraday'`
row, `domain/market-data/price-backup-csv.ts`'s `INTERVALS` set) and its
`providerRank` slot is unchanged from before this task either way.

**Sharesight capture** reuses BRK-012B/012C's candidate machinery exactly:
one shared `listUserInstruments()` fetch per sweep tick (never one call per
owner), `resolveScopedSharesightInstrumentSecurities` +
`buildSharesightPriceAccretionPlan` to resolve this owner's scope, and the
SAME guarded `security_provider_mappings` insert BRK-012B's accretion write
uses — performed here at CAPTURE time (not deferred to rollup), so that by
construction any cached `sharesight` row already has a resolvable mapping by
the time rollup runs. **Sharesight structurally cannot cover a WATCH-ONLY
security (WLT-001 review, B2c, 2026-08-22)**: `listUserInstruments()` lists
this owner's actual Sharesight HOLDINGS, so a `watchlist_entries` security
with no corresponding position is invisible to Sharesight capture by
construction, not by an implementation gap — an owner with
`daily_capture_source = 'sharesight'` sees Yahoo-sourced watchlist prices
instead whenever Yahoo capture (below) or WLT-001's own best-effort
on-add priming resolved one, and honestly `unavailable` otherwise;
`selectPriceObservation`'s existing provenance already names the actual
source that supplied each price, so this is never silently mislabelled as
Sharesight. **Yahoo capture** (`yahoo_anonymous`/`yahoo_authenticated`)
resolves the owner's already-verified `security_provider_mappings` rows
**and, as of WLT-001's review (B2b, 2026-08-22), this owner's watch-only
securities with a verified mapping too** (`resolveScopedYahooCaptureSecurities`,
`db/repositories/intraday-price-capture.ts` — a plain SQL `UNION` of the
held-security set with `watchlist_entries.kind = 'security'`, deduplicated
so a security that is both held and watched is captured once) and calls
the existing `yahoo-compatible` adapter's `getLatestObservation` per
security, budget-bounded across the WHOLE sweep tick
(`DAILY_CAPTURE_LIMITS.maxYahooRequestsPerSweep`) — that fixed per-tick
budget is UNCHANGED by the larger candidate set; a larger candidate list
only changes which securities compete for the same bound, never the
sweep's worst-case request count. **Honest crowding consequence (WLT-001
review round 2 fold, 2026-08-22, no behaviour change -- naming what
already happens):** `resolveScopedYahooCaptureSecurities`'s candidates
iterate in plain `security_id` ASCII order, and the sweep's own capture
loop (`app/daily-price-capture-service.ts`) stops the instant
`yahooBudgetRemaining` hits zero -- so a large watchlist can crowd out a
HELD security's capture within the same tick if the held security's id
happens to sort AFTER enough watch-only ids to exhaust the budget first.
No priority ordering (e.g. held-before-watched) is applied. `yahoo_authenticated` owners get the
login-cookie jar attached when configured (MKT-009B), the adapter still
degrades per-request on a 401; `yahoo_anonymous` owners never get it, even
when the deployment has one configured. A captured Yahoo observation's
`providerRevisionId` (`session:authenticated`/`session:anonymous`) is
carried through verbatim into the rollup row, so `app/owned-holdings.ts`'s
existing MKT-009B session-state labelling never regresses for a
rollup-sourced price.

**Honesty rules, all enforced structurally, not by convention**: a captured
point is only ever stored when the source's own `marketDate` equals TODAY in
the security's market timezone (a stale/prior-close observation, e.g. on a
public holiday with no calendar, is never captured — "the sweep stores
nothing new" beats a fabricated point); the window/DST/weekday gate
(`domain/market-data/daily-capture-window.ts`) derives local wall-clock time
via `Intl.DateTimeFormat` against the security's OWN stored `exchanges.timezone`
(never a fixed UTC offset — Sydney's AEST/AEDT both fire their capture ticks
at local `:25`); purge only ever follows a successful rollup, so a crash
between write and purge leaves the intraday cache intact for the next tick
to retry, and a genuinely abandoned day (a missed 16:25 close) is rolled up
by the FIRST sweep tick of a LATER day, before that day's own window logic
even applies (`isDailyCaptureRollupEligible`).

**Rollup idempotency is provider-specific, not one shared mechanism (review
round correction, 2026-08-22)** — price observations are a CONVERGING CACHE
here, not immutable ledger facts:

- `sharesight` rollups target BRK-012B's own PARTIAL unique index
  (`price_observations_provider_scope_mapping_date_unique`, scoped to
  `provider_id = 'sharesight'`) with `ON CONFLICT ... DO UPDATE`, converging
  the row to the sweep's own last-captured (16:25) value. This is
  deliberate, not accidental: BRK-012B's hourly refresh already writes/
  overwrites the SAME row all day through that identical index, so any
  Sharesight intraday point this sweep captures has a near-certain colliding
  same-day row already there — targeting the plain exact-`observation_at`
  index instead throws on that collision (review finding B1, reproduced
  live: the whole rollup loop wedges on the oldest unrolled day, and every
  LATER day for that owner silently stops rolling up too, forever, since
  intraday purge never runs on a thrown rollup). `DO UPDATE` is correct here
  specifically because the sweep's own end-of-window value is MORE
  authoritative than BRK-012B's earlier same-day write — a bare
  `DO NOTHING` would perversely keep the hourly job's stale intraday value
  over the sweep's own close-of-window observation.
- `yahoo-compatible` rollups target a NEW, symmetric partial index,
  `price_observations_yahoo_scope_mapping_date_unique` (migration
  `0050_mkt_011a_yahoo_rollup_index.sql`, `WHERE provider_id =
'yahoo-compatible' AND interval = 'delayed'`). An earlier draft of this
  task incorrectly assumed a pre-existing multi-row-per-day
  `yahoo-compatible` `delayed` writer that a DB uniqueness rule would
  collide with; tracing the actual write paths found NONE exists — the
  ordinary hourly Yahoo refresh writes only `interval = 'eod'` rows
  (`getDailyPrices`, hardcoded), and `getLatestObservation` (the only
  producer of a `delayed` yahoo row) has no call site anywhere in this
  codebase except MKT-011A's own sweep. The index is therefore scoped to
  `interval = 'delayed'` (narrower than the `sharesight` index, which needs
  only `provider_id` since Sharesight never writes `eod` rows) specifically
  so `yahoo-compatible`'s OWN `eod` same-day-correction pattern (two rows,
  same `market_date`, different `observation_at` — the ORIGINAL unique
  index's whole reason for existing) stays completely untouched. The
  rollup's `ON CONFLICT ... DO UPDATE SET ... WHERE excluded.observation_at
  > price_observations.observation_at`guard makes an out-of-order arrival
(an older capture landing after a newer one) a safe no-op — SQLite's
upsert`RETURNING`reports zero affected rows when the`WHERE`guard
suppresses the update — while a genuinely newer arrival converges the SAME
row. Since`yahoo-compatible`rollups are`access_scope = 'deployment'`(the same public market data regardless of which owner's sweep captured
it, MKT-007/009B precedent), this same guard is ALSO what makes two
different owners' Yahoo captures for the same security+day converge onto
ONE row rather than accumulating duplicates — enforced by the partial
unique index itself, not an application-level check.`sharesight` rollups
stay user-scoped (`access_scope = 'user'`, fetched with the owner's own
  > credentials, BRK-012B precedent).

## 22. Today graph from the intraday cache (MKT-011B, 2026-08-22)

Extends §19's per-holding price-history chart with a today-series read from
§21's `intraday_price_points` cache (`app/owned-price-history.ts`,
`app/components/holding-price-chart.tsx`, repository read in
`db/repositories/intraday-price-capture.ts`'s
`listOwnedIntradayPricePointsForDate`).

**"Today" is the SECURITY's own market timezone, not the portfolio's.** The
range-window math (§19) already resolves "today" from the portfolio's
timezone for day/week/YTD/etc. window boundaries; the intraday overlay
deliberately uses a SEPARATE derivation — `exchanges.timezone` via
`resolveSecurityMarketTimezones` and
`domain/market-data/daily-capture-window.ts`'s `resolveDailyCaptureWindowStatus`
— the SAME timezone source the capture/rollup sweep itself uses, so the
overlay's "today" always matches what the sweep considers "today" for that
security. An unresolvable exchange timezone (no exchange linked) means the
overlay stays empty rather than guessing a date.

**Honest empty state.** Zero cached intraday rows for today (market closed,
capture not yet run this tick, or the owner's capture source disabled) all
read identically from `listOwnedIntradayPricePointsForDate` as an empty
array — the chart simply renders the historical series with no today
overlay and no fabricated point. A FOURTH cause reaches the same empty
`todayPoints` array by a different path: rows WERE cached, but every one
was excluded (off-currency or malformed) — `loadOwnedPriceHistory` still
discloses this via `provenance.todayExcludedCurrencyCount`/
`todayExcludedMalformedCount`, and the component renders that disclosure
even with zero surviving points (review round-1 fix, B1, BLOCKING:
gating the whole today-provenance paragraph on "at least one surviving
point" made an all-excluded day render pixel-identical to "nothing
captured today" — an exclusion count silently discarded is exactly the
kind of real data problem AGENTS.md's disclosure discipline exists to
surface). The component adds no "0" or synthetic PRICE value in any of
these four cases; when it says anything about today at all, it is either
a real captured count/price or an honest exclusion count, never an
invented one.

**Same-day dedupe (the coexistence case the task called out).** The window
between a successful rollup and its purge (§21), or a crash-recovery rollup
racing this exact read, can briefly leave a `price_observations` row AND
`intraday_price_points` rows for the SAME (security, market_date). DECISION:
the intraday series wins — `loadOwnedPriceHistory` drops any historical
winner sharing `todayMarketDate` from the plotted series whenever
`todayPoints` is non-empty, rather than the reverse (dropping the intraday
points in favour of the rolled-up daily value). Rationale: the intraday
series is strictly more current and more granular than the single value it
would otherwise duplicate; once the purge actually runs, the intraday series
naturally disappears and the daily point reappears with no special-casing
needed on either side.

**Rendering.** Reuses `scalePriceHistoryPoints` (§19) UNMODIFIED: historical
and today points are scaled together as one array so both share one
price/date domain, then split back out by array position. Every intraday
tick for today shares ONE x-axis column (today's calendar date — the
existing date-offset x-axis, never a fabricated sub-day time axis); the
vertical spread across that column is today's real observed price range.
Rendered as diamond markers (`<rect>` rotated 45°) on a dashed line, visually
distinct from the historical series' circular markers/solid line by SHAPE
and dash pattern, not color alone (QA-001B non-color-distinction
convention) — CSS in `app/globals.css` (`.price-history-intraday-*`).
Provenance is disclosed compactly beneath the chart ("Today (…), intraday,
delayed (…): last N.NN CCY; k points captured — not a close.") mirroring
the existing `latestDelayed` line's style; the SVG's accessible `<title>`
on the overlay polyline carries the same explanation for assistive tech.
The label NEVER says "live" or "close" (AGENTS.md) — intraday captures are
always `interval: 'intraday'`, delayed, unsettled data.

## 23. True intraday time axis for the today overlay (MKT-011C, 2026-08-22)

Owner ruling: "the day chart should show the hourly values. Optionally
they could be plotted on the weekly chart." §22's overlay plotted every
one of today's intraday ticks at ONE shared calendar-date x-column, spread
vertically by price — honest (the real observed range, explained in the
accessible text) but visually close to a range wick, and it exaggerated
the last column's apparent volatility. This section replaces that with a
true sub-day time axis on the DAY range, and the SAME time axis narrowed
to today's own column on the WEEK range (implemented, not dropped — the
owner's "optional" carve-out).

**Contract change: `observedAt`/`quality` are plumbed through.**
`PriceHistoryPoint` (`app/owned-price-history.ts`) gains two OPTIONAL
fields — `observedAt` (the point's own UTC observation instant) and
`quality` (`ProviderDataQuality`) — populated for every point the loader
returns (historical, today, and `latestDelayed` alike). Review round-1 fact
correction (F4): this is true of `observedAt` in only ONE sense — the
historical `price_observations` read already SELECTed `observation_at`
(§19), it was simply dropped before reaching `toApiPoint`'s returned
shape — but `quality` was NOT already carried through; this task adds
`po.quality`/`quality` to BOTH the historical (`fetchObservations`,
`latestDelayedRow`) and intraday (`listOwnedIntradayPricePointsForDate`)
SQL selects for the first time. Optional at the TYPE level only for
backward/forward compatibility with older cached client state or test
fixtures that predate this field — the loader itself always populates
both. `PriceHistorySuccess` also gains `marketTimezone` (the SAME
`exchanges.timezone` §22's `todayMarketDate` was resolved against), so the
client can convert `observedAt` into a market-local time without a second
server round-trip.

**Geometry: a separate pure function, `scalePriceHistoryPoints` untouched.**
`app/price-history-chart-geometry.ts` adds
`positionTodayPointsByObservedTime` (given today's points, their
already-Y-scaled values, the market timezone, a pixel column, and plot
bounds, returns each point's TIME-based x) and `calendarColumnWidth` (one
calendar day's pixel width within a multi-day date-offset domain) —
neither changes `scalePriceHistoryPoints` itself, which keeps driving
every range's shared price/date domain (§22's Y-domain-sharing behaviour
is unchanged) and every non-day/week range's date-offset x-axis exactly as
before. Both new functions reuse
`domain/market-data/daily-capture-window.ts`'s `resolveDailyCaptureWindowStatus`
and its now-exported `WINDOW_OPEN_MINUTES`/`WINDOW_CLOSE_MINUTES` (10:25/
16:25) — the EXACT derivation the capture sweep itself gates on — rather
than a second bespoke time-zone calculation that could drift out of sync.

**DAY range:** the full plot width represents the 10:25–16:25 market-local
window when there is no historical context point; each intraday tick's x
is proportional to its own observed time-of-day. A same-day "previous
close" context point (§19's sparse-day supplement), when present, still
lands wherever the ordinary date-offset scale puts the earliest date in
the combined domain — the chart's left edge. Review round-1 fact
correction (F2, BLOCKING): an earlier version of this section described
that as reading visually "before market open" — false as shipped: the
window's own left edge sits at that SAME pixel, so the context point and
the window-OPEN (10:25) tick rendered pixel-identical, with the context
point's `<title>` (a pre-existing gap; lone historical points had none)
effectively unreachable under the diamond drawn on top of it. Fixed by (1)
giving every lone historical point (not just this case) its own `<title>`
naming its date, and (2) reserving a small pixel gap before the DAY
window starts whenever a context point is present, so it renders visibly
separate from — genuinely before — the window rather than inside it. The
gap is skipped when there is no context point, so an ordinary "day" view
with no historical data still uses the full plot width.

**WEEK range (owner's optional carve-out, IMPLEMENTED):** today's ticks
spread across ONE calendar day's width within the existing multi-day
date-offset axis, ENDING at today's own already-computed date position
rather than centred on it — the range window always ends "today," so today
is normally the rightmost/latest date on the axis, and a column centred
there would overflow the chart's right edge and clamp every afternoon tick
to the same pixel. Ending at that position instead gives a clean invariant:
the window's own last tick (16:25) lands exactly where the pre-MKT-011C
shared-column marker used to sit. Review round-1 fix (F1, BLOCKING): this
per-day column math only applies when the combined historical+today domain
genuinely spans 2+ calendar dates. When it spans exactly ONE date — a
brand-new holding with no historical observation at all, or §22's own
dedupe rule removing the only same-day historical winner once intraday
data exists (the only way to reach a one-date domain here) — the WEEK
range now falls back to the SAME full plot width the DAY range uses.
Reviewer-caught: the un-fixed code instead sized the per-day column from
`calendarColumnWidth`'s own single-date fallback (the full inner width)
and subtracted it from an anchor sitting at the domain's LEFT edge, not
its right, pushing the whole column hundreds of pixels off-screen — every
tick then bounds-clamped onto ONE pixel with `withinCaptureWindow` still
reporting `true` (a PIXEL-bounds clamp is not a capture-WINDOW clamp, so
the window-clamp disclosure never caught it). `positionTodayPointsByObservedTime`
now also independently rejects (returns `null` for every point) any
`column` that does not overlap the plot's own bounds at all, as a second,
caller-independent safety net against the same failure shape.

**Out-of-window ticks: CLAMPED, never excluded — and ORDINARY, not
exceptional.** A tick's `observedAt` is the PROVIDER's own reported
observation instant, not this app's capture timestamp; the 10:25–16:25
window only gates WHEN this app's sweep fires a new capture tick
(§21), and a delayed source's reporting lag relative to that tick is
unknown (§17). Review round-1 fold (F5): a pre-10:25 `observedAt` on a
day's FIRST capture is therefore the ROUTINE case, not a rare edge case —
clamping exists to handle it honestly every day, not as a defensive
fallback for a corner case. A tick landing outside the window is
positioned at the nearest window edge rather than dropped from the chart —
a real captured observation is never hidden for landing outside the window
this app happens to gate NEW capture ticks on. The returned
`withinCaptureWindow: false` flag (surfaced in the tick's own accessible
`<title>`, e.g. "outside the 10:25-16:25 capture window — shown at the
nearest window edge, not its true relative time") distinguishes a clamp
from an ordinary in-window tick, so the chart's geometry is never silently
misleading about a tick's true time.

**Quality-tier ticks visually and textually distinguished (QA-001B).**
Review round-1 fact correction (F3): only `stale_candidate` is currently
PRODUCIBLE on the intraday overlay — reachable via the Yahoo-compatible
capture adapter's cached-fallback path (`domain/market-data/yahoo-compatible.ts`,
the `quality: "stale_candidate"` cached-fallback branch); every other
intraday-capture code path hardcodes `quality: "observed"`. `indicative`
and `corrected` are NOT currently reachable on this overlay — handled
defensively per the four-value DB enum (`intraday_price_points_quality_check`)
in case a future capture path or a hand-run write produces one, not
because either is exercised today. When a `stale_candidate` (or, if it
ever becomes reachable, `indicative`) tick DOES render, it shows HOLLOW
with a dashed outline (`.price-history-intraday-uncertain` in
`app/globals.css`) instead of the ordinary filled diamond — a SHAPE/
pattern distinction, not color alone — and its own `<title>` names the
tier in words ("stale candidate — not a freshly confirmed price" /
"indicative — not a confirmed trade"). A `corrected` tick gets its own
textual caveat ("corrected") but keeps the ORDINARY filled marker — a
correction is more trustworthy than a plain `observed` tick, not less, so
the "uncertain" hollow styling would misrepresent it. An `observed` tick
(the ordinary case) gets neither a caveat nor a styling change.

**Folded-in residuals from §22's review:**

- **Today-only coverage line.** A today-only chart (no settled historical
  point survives the range) no longer renders the misleading
  "No date range · 0 points · No provider" while the intraday diamonds are
  visibly plotting real data — it renders "No settled historical points in
  this range" (plus any real historical exclusion counts) instead. The
  ordinary coverage line is unchanged whenever a historical point exists.
- **Axis min/max attribution.** `scaled.min/maxPriceDecimal` can be set by
  an intraday tick (the combined domain is unchanged from §22) — the axis
  now appends "(today, intraday)" whenever the displayed extreme's exact
  decimal string does not appear among the historical series at all (i.e.
  it can only have come from today's overlay).
- **`latestDelayed` pairing.** The delayed-quote summary line can name the
  SAME calendar date as the "Today" line below it — now disambiguated with
  a market-local TIME (from the newly-plumbed `observedAt`), e.g.
  "…as of 20 Aug 2026, 15:55 market-local." — labelled "market-local"
  everywhere a time is shown, never a bare clock time that could be
  misread as the viewer's own local time.

**What did NOT change:** the same-day dedupe rule (§22), the delayed
provenance wording ("intraday capture, delayed — not a close," never
"live"/"close"), the honest empty-state paths, and `scalePriceHistoryPoints`
itself (byte-for-byte unmodified).

## 24. Intelligent Investor price-endpoint evidence spike (MKT-018A, 2026-08-24)

Owner directive (2026-08-24): "In the import dialog, lets add a button to
download the historical values for all shares in the portfolio using this
method [`docs/ASXCSVDownloadGuide.md`]." That guide's method is a
CLIENT-SIDE Highcharts CSV export (`chart.downloadCSV()`) run in a real
browser tab against `intelligentinvestor.com.au` share pages — a Cloudflare
Worker cannot execute page JS, so the button cannot literally run the
guide's script server-side. Per the Orchestrator's evidence-first ruling
(BRK-008/MKT-009A pattern), this spike checks whether the chart's underlying
data instead arrives over a plain, fetchable HTTP endpoint a Worker COULD
call directly, BEFORE any MKT-018B implementation is written.
`scripts/ii-price-endpoint-spike.mjs` is the re-runnable evidence tool
(default tickers SHL/CBA/BHP; all findings below are VERIFIED by this
spike's own live run against those three tickers on 2026-08-24, not
third-party/community-reported — unlike MKT-009A's Yahoo spike, this site
publishes no unofficial-client literature this research found, so there is
no COMMUNITY-REPORTED tier to separate out here).

**An unauthenticated, fetchable endpoint exists and returns the full price
series.** The share page (`/shares/asx-{ticker}/`, redirecting to a slugged
canonical URL, e.g. `/shares/asx-shl/sonic-healthcare-limited`) embeds a
hidden `<input class="ajax-loader-data" data-content="…">` element naming an
AJAX fragment path lazy-loaded client-side:
`/shares/asx-{ticker}/{slug}/_price-chart?loadEntity=True&DisplayStockCode=True`.
`GET`-ing that path directly, with no cookies and no session of any kind,
returns HTTP 200 and an HTML fragment containing the page's actual
`Highcharts.StockChart` config inline — including a `series: [{ id:
'dataseries', name: '{TICKER}', data: [ [timestampMs, price], … ] }]` array
holding the FULL price history, not a preview/paginated slice. This array's
tuples are plain `[number, number]` pairs, so it happens to be valid JSON
once isolated (bracket-depth extraction, no eval needed) — see the spike
script's `extractDataArray`.

**Coverage observed, this run (2026-08-24):**

| Ticker | Points | First date | Last observation (UTC) | First close | Last close |
| ------ | ------ | ---------- | ---------------------- | ----------- | ---------- |
| SHL    | 9,216  | 1990-09-06 | 2026-08-21T00:00:00Z   | 0.029445    | 21.08      |
| CBA    | 8,960  | 1991-09-12 | 2026-08-21T16:35:00Z   | 6.46        | 157.99     |
| BHP    | 10,147 | 1987-01-02 | 2026-08-21T00:00:00Z   | 2.68838     | 65.16      |

Granularity is daily (timestamps are UTC midnight for ordinary trading days,
confirmed by inspecting gap spacing across a run of consecutive points — 24h
between weekdays, 72h across a weekend, matching ASX's trading calendar);
the single most-recent point can instead carry a same-day intraday
timestamp (CBA's run above shows `16:35:00Z`), i.e. the series' tail is a
live-updating "latest" point layered onto an otherwise-daily series, not a
second data source. **Currency**: the fragment's own visible heading states
it plainly per ticker — `"{TICKER} Share Price Chart - AUD ($)"` — VERIFIED
for all three tickers this run; the endpoint never returns a currency code
in the data payload itself, only in this heading text, so a Worker consumer
would need to parse that heading (fragile) or hard-code the
ASX-is-always-AUD assumption this codebase's `domain/market-data/
exchange-timezone.ts` already makes for MKT-008 (§18) — reasonable, but a
real coupling. **Adjustment status: NOT STATED by the source, and this
spike's own evidence points toward the series being adjusted, not raw** —
SHL's first-recorded close of $0.029445 (2.9 cents) in 1990 for a company
whose price series is described only as "Share Price Chart," combined with
this magnitude of multi-decade compression across all three tickers, is far
more consistent with a split-adjusted series than a literal nominal 1990
trading price. This is INFERENCE, not verified against any documented
methodology — the page states no adjustment policy anywhere this spike
found. `price_observations.adjustment_state` is a three-way CHECK constraint
(`'raw' | 'split_adjusted' | 'total_return_adjusted'`, `docs/DATA_MODEL.md`)
that any MKT-018B write path would need to pick a real, defensible value
for; this spike cannot resolve that question, only flag it as open and
likely NOT `'raw'`.

**Bonus, tangential finding: a second embedded series carries dividend
events**, `{ type: 'flags', name: 'divFlag', data: [ { x: timestampMs,
title: 'D', text: '2 ¢' }, … ] }`, in the SAME fragment — but as a genuine
JS object literal (unquoted keys, single-quoted strings), not valid JSON, so
the spike script's JSON-based extractor correctly reports "present but did
not parse as JSON" rather than silently dropping or fabricating dividend
data. Out of MKT-018's price-history scope; noted for a future task should
dividend backfill ever target this source.

**robots.txt explicitly disallows this exact endpoint, and the site
actively blocks non-browser clients — the strongest evidence in this
spike, and it points the other way from a straightforward technical
"yes."** VERIFIED, this run:

- `GET https://www.intelligentinvestor.com.au/robots.txt` (HTTP 200)
  contains `Disallow: /*_price-chart` — a wildcard rule matching EXACTLY the
  endpoint this spike just used, under `User-agent: *` (no exemption for any
  named crawler), alongside `Crawl-delay: 20`.
- The site's WAF returns a bare HTTP 403 ("Oops! You do not have access") to
  ANY request carrying no `User-Agent` header at all — VERIFIED against both
  a share page and the `_price-chart` fragment itself. A real browser-shaped
  `User-Agent` string is sufficient to get a normal 200 (this spike used
  one throughout, documented at the top of `USER_AGENT` in the script). This
  is a materially different posture from the Yahoo-compatible adapter this
  codebase already ships (§3–§5, no UA gate, no path-specific robots
  disallow found) or Sharesight's contractual API (§17) — here, a compliant
  automated client is asked by the site's own robots.txt not to fetch this
  path at all, and reaching it anyway requires presenting as a browser the
  request plainly is not.
- The general Terms & Conditions page (`investsmart.com.au/terms-and-conditions`)
  is a client-rendered SPA (Framer-hosted per its CSP; the raw HTML this
  spike fetched contains no readable terms text, only the page shell) — this
  spike could not retrieve scraping/automation language from it by a plain
  GET. Recorded honestly as an open gap, NOT as evidence the terms permit
  automated access; robots.txt above is the clear, direct, machine-readable
  signal already in hand and it is a negative one.
- No login, account, or cookie of any kind was needed to reach any endpoint
  in this spike — the data itself is genuinely public/delayed, consistent
  with the guide's own framing. The robots.txt/WAF findings above are about
  AUTOMATED access, not about the data being paywalled.

**Go/no-go recommendation for MKT-018B: NO-GO for a Worker-side automated
fetch directly against this endpoint.** The data is technically reachable,
unauthenticated, and shaped exactly right (full daily history, one HTTP call
per resolved ticker slug) — but the site's own robots.txt names this precise
path `Disallow` for every crawler with no exemption, and reaching it at all
requires a request that presents as a browser when it structurally is not
(no UA header = 403). Unlike MKT-009A's Yahoo finding (general ToS
boilerplate against "automated means," no per-endpoint robots rule, no UA
gate observed) or BRK-012A's Sharesight finding (a real, owner-authorized
OAuth API), this is a specific, unambiguous, machine-readable "do not crawl
this" instruction attached to the exact endpoint MKT-018B would need to call
on a recurring, owner-triggered basis. Building an import feature that
routinely disregards that instruction — however low-volume and
personal-use — is a materially different risk posture than this codebase's
existing market-data integrations, and the Orchestrator should treat it as
requiring an explicit, informed owner decision before any code change, not
a default "public data, so it's fine" call.

**Recommended fallback, per MKT-018's own contingency plan:** the GUIDED
flow — the import dialog's "Download price history" button lists the
portfolio's zero-history tickers with per-ticker links to the guide's own
share-page URL pattern (`docs/ASXCSVDownloadGuide.md`), plus a drop-zone
feeding the downloaded CSVs into the existing MKT-008 owner-upload importer
(preview/idempotent/reversible, already shipped, §18). This keeps the
actual `_price-chart` fetch exactly where the guide already puts it — an
owner-initiated action in their own browser tab, which the robots.txt
`Disallow` (aimed at automated crawlers, not an owner's own interactive
browsing) does not implicate — and avoids introducing a new WAF-evasion
dependency into deployed Worker code.
