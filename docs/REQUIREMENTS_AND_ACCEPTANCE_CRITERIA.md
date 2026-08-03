# Requirements and acceptance criteria

Status: implementation baseline  
Date: 2026-07-28

Requirement IDs are stable. `TASKS.md` and tests must reference them.

## Product and navigation

### PRD-001 — Private portfolio workspace

The application shall provide each authenticated user a private workspace containing only portfolios they own.

Acceptance:

- An unauthenticated request cannot read or mutate portfolio data.
- A valid user cannot enumerate, read, or mutate another user’s portfolio by changing an ID.
- No portfolio row is accessible without an internal `user_id` ownership predicate.

### PRD-002 — Portfolio management and home currency

The user shall choose a home currency in settings and create, rename, archive, restore, and select portfolios with an explicit reporting currency, timezone, and accounting method.

Acceptance:

- Home currency and timezone are required and validated.
- A new portfolio’s reporting/base currency defaults to the user’s home currency.
- FIFO is the only enabled v1 method; the stored method is explicit.
- Archive hides a portfolio from default selection without deleting its ledger.

### PRD-003 — Reference navigation

The application shall expose Overview, Holdings, Quotes, Details, and News navigation for the active portfolio.

Acceptance:

- Direct URLs are stable and refreshable.
- Active state is programmatically and visually identifiable.
- News clearly indicates unavailable status until implemented.

### PRD-004 — Responsive application shell

The shell shall work from 320 px wide through large desktop layouts and respect iPhone safe areas.

Acceptance:

- No primary action or metric is clipped at 320 px.
- Touch targets are at least 44×44 CSS pixels.
- The tab row remains operable without hover.
- Desktop holdings use a dense table and mobile holdings use labelled cards.
- Lists and summaries generally suppress exact timestamps; financially relevant dates remain visible where useful, with exact provenance time available in detail/audit explanations.

### PRD-005 — Native/home-currency display

For a holding whose trading currency differs from the user’s home currency, the application shall provide a menu option to display price and value in either native or home currency.

Acceptance:

- The selected view uses the attributable FX rate for the price/valuation date, not an undated current rate.
- Home-currency display shows the rate, rate date, and source in its explanation.
- The toggle changes presentation only; it does not rewrite native security prices, transaction amounts, quantities, or ledger facts.
- Holding projections, cost basis, snapshots, and portfolio totals retain home-currency monetary values while their native inputs/provenance remain available.
- Missing FX leaves native values visible and home-currency values unavailable rather than zero.
- Compact native/home results omit routine FX provenance, while the adjacent explanation retains the selected rate direction, rate/date, source, exact observation time, inversion evidence, selector state, quality, fallback reason, and actionability.

## Authentication, privacy, and authorization

### AUTH-001 — Cloudflare Access boundary

Production requests shall be protected by Cloudflare Access and the Worker shall independently validate the `Cf-Access-Jwt-Assertion` JWT.

Acceptance:

- Signature uses the current remote JWKS.
- `iss`, `aud`, `exp`, `nbf`, and application token type are validated against configured values; a browser principal also requires a non-empty `sub`.
- Missing configuration fails closed.
- Missing, expired, malformed, wrong-issuer, and wrong-audience tokens return a non-data-bearing 401/403.

### AUTH-002 — Internal identity mapping

The system shall map an Access identity to an internal user using the stable Access subject plus Access organization/application context, not email alone.

Acceptance:

- First authorized access can just-in-time provision a pending/active user according to policy.
- Email changes do not transfer data.
- Removing and re-adding an Access identity cannot silently claim an old account.
- Service-token identities cannot become interactive users.

### AUTH-003 — Per-user authorization

All server operations shall derive the actor from the validated identity and enforce ownership.

Acceptance:

- Client-provided `user_id` is ignored or rejected.
- Child resources are checked through their owned portfolio in the same query/transaction.
- Cross-user unit and integration tests cover reads, writes, imports, overrides, and exports.

### AUTH-004 — Mutation protection

Browser mutations shall be same-origin and protected against CSRF and replay.

Acceptance:

- Mutations reject disallowed `Origin`/`Sec-Fetch-Site` values.
- Quote refresh and manual-override POST/DELETE endpoints apply these checks before authentication or database work.
- State-changing requests use non-idempotent methods appropriately and an application CSRF token if the final cookie policy requires it.
- Import commit and destructive reversals require an idempotency key and explicit confirmation.

### AUTH-005 — Account lifecycle

The first release shall support administrator-invited users, Access-policy offboarding, and an internal disabled/deletion state.

Acceptance:

- Disabled users cannot access data even if an upstream session remains valid.
- Deletion is a deliberate audited job with a retention policy and export option.
- The UI does not claim self-service registration or password recovery.

## Portfolio ledger and cash

### LED-001 — Immutable transaction ledger

The core release shall store normalized trades, explicit splits, and cash events as attributable ledger facts. Income and transfer extensions remain deferred.

Acceptance:

- Transactions have portfolio, type, trade timestamp, currency, quantity/amount fields, source, and created actor.
- Each write persists an owner/portfolio-scoped idempotency key independently of source provenance; an identical retry returns the original result, while reuse for different normalized posting intent conflicts.
- Manual writes require a persisted server-issued key bound to the authenticated owner, portfolio, operation purpose, and correction target. Missing, forged, expired-unused, or cross-target keys reject before posting; an acknowledged or unacknowledged committed retry keeps returning the original result.
- A correction records reversal/supersession; it does not silently overwrite source values.
- Rebuilding projections from ledger facts produces the same result.

### LED-002 — Multi-currency transactions

Transactions shall retain native currency and transaction-date FX provenance.

Acceptance:

- Native and base-currency values are distinguishable.
- The user’s home currency is the canonical portfolio reporting currency; native transaction/security currency remains source truth.
- Missing FX remains missing and blocks only dependent metrics.
- A zero import FX rate is treated as unknown, not as a valid rate.
- A validated explicit transaction FX fact takes precedence over selected market observations; an invalid explicit fact fails closed and is not silently replaced.

### LED-003 — Fees and cash impact

Trade fees and taxes shall be retained and included in cash and cost-basis rules.

Acceptance:

- Buy cash impact equals consideration plus applicable fees/taxes.
- Sell cash impact equals proceeds less applicable fees/taxes.
- Cost-basis fixtures cover fee allocation.

### LED-004 — Holdings and tax lots

Holdings, open tax lots, and lot matches shall be deterministic projections of the ledger using FIFO in v1.

Acceptance:

- Buys create open quantities and sells consume oldest eligible quantities.
- Oversells fail unless a future short-selling feature is explicitly enabled.
- Security quantity mutations stream the complete supported ledger window in bounded pages and commit behind an owner-scoped transaction-count/version guard. Concurrent sells cannot both consume the same quantity; work beyond the declared event/query ceiling fails closed.
- Reversing a trade rebuilds affected lots and snapshots.
- Projection rebuilds persist bounded owner-scoped checkpoints; a failed chunk resumes without replaying committed output, and only a completed ledger high-water run becomes current.

### LED-005 — Cash balances

Cash balances shall be represented by currency-specific cash accounts and ledger entries, separate from securities.

Acceptance:

- The balance equals the ordered sum of posted cash entries.
- A bounded inspection view never presents a partial cash-entry window as a complete balance; it shows the balance as unavailable with an explicit reason instead.
- Imports can flag unbalanced cash when source history is incomplete.
- Currency conversion does not rewrite the native cash balance.

## Securities and market data

### MKT-001 — Canonical security identity

The system shall identify a security independently of its current ticker.

Acceptance:

- Security identity includes asset type, exchange/MIC where known, trading currency, and canonical name.
- Provider symbols are validity-dated mappings.
- Ticker change or delisting retains historical mappings and observations.

### MKT-002 — Provider abstraction

Market data shall enter through provider-neutral interfaces and normalized records.

Acceptance:

- The contract supports typed, independently implementable capabilities. The core release requires reference lookup, latest observation, daily raw-price history, and FX; dividends, provider splits/adjusted history, and fundamentals remain unavailable until their deferred tasks are promoted.
- Provider payloads are not returned directly to the client.
- Unsupported capabilities produce typed unavailable states.

### MKT-003 — Price provenance

Each price observation shall retain source, symbol mapping, currency, observation time/date, ingestion time, interval, raw/adjusted state, and quality status.

Acceptance:

- A displayed price has stored provenance and state.
- Compact views generally suppress timestamps, provider, delay, and fallback labels. Manual, stale, indicative, or fallback state is available through an adjacent accessible explanation, with inline status reserved for an action-required condition.
- Adjusted and unadjusted prices cannot be mixed in one calculation without an explicit rule.
- Duplicate provider observations are idempotent.
- Refresh work is durable, resumable from a stored high-water date, and correction-safe; observation upserts and their guarded checkpoint commit as one bounded D1 batch, concurrent requests leave at most one active target job, configured query/parameter/chunk budgets fail closed, and scheduled chunks do not rely on request-lifetime background execution.

### MKT-004 — FX provenance

FX rates shall be stored as directional base/quote observations with timestamps and source.

Acceptance:

- Conversion direction is explicit and tested.
- Inversion uses decimal arithmetic and rejects zero.
- Missing same-day rates apply the documented calendar fallback and remain attributable.

### MKT-005 — Market-data freshness and partial coverage

The product shall surface freshness and coverage rather than substituting zero.

Acceptance:

- An incomplete total is labelled as a known/partial total and discloses priced/converted counts; it does not claim an unknowable excluded dollar value.
- Coverage applies to non-zero positions and cash balances. An exact zero component with missing price or FX is counted separately and does not make an otherwise complete total partial or unavailable.
- Staleness thresholds differ for EOD and delayed sources.
- Missing quote and FX states identify remediation.
- A last-known stale value may remain visible, but its stale/fallback state cannot be represented as a normal current observation.

### MKT-006 — Manual overrides

Authorized users shall create versioned price, FX, security-map, and selected calculation-input overrides with a reason.

Acceptance:

- An override has scope, effective interval, actor, reason, and supersession history.
- Manual state is available in the adjacent explanation; routine compact rows generally do not add an inline label unless user action is required.
- Removing an override restores the underlying provider/source result.

### MKT-007 — Provider use-policy gate (deprecated)

External provider-use decisions are outside the application requirements. The product shall not implement a provider use-policy gate.

Acceptance:

- Provider enablement is ordinary server configuration and does not depend on user count, owner identity, deployment mode, monetization, redistribution, or an alternative-provider prerequisite.
- No endpoint exposes bulk/raw provider data.
- Normal authentication, portfolio isolation, provenance, input validation, and rate controls apply equally to every configured provider.
- No provider approval, use-scope, or provider-rights field is added to application schema or authorization logic.

### MKT-008 — Delayed quote priority

Active Quotes and Holdings price views shall prefer the freshest validated observation available from the approved source without adding routine provenance or freshness text to compact views.

Acceptance:

- The chosen observation and its actual/unknown delay, timestamp, source scope, quality, and fallback reason are retained in the domain explanation; it is never called real-time without evidence.
- EOD and manual values remain explicit fallbacks when a fresh observation is unavailable, stale, malformed, or over rate budget.
- Compact price views show `Price unavailable` when no usable value exists. They generally suppress timestamps, provider, delay, and fallback labels; anomalous manual/stale/indicative/fallback state remains accessible, with inline status reserved for an action-required condition.
- Provider-unavailable behavior preserves the last valid observation with stale state and never substitutes zero.

## Calculations and history

### CALC-001 — Decimal arithmetic and rounding

All financial calculations shall use decimal arithmetic and the documented display/storage rounding rules.

Acceptance:

- No calculation path uses binary floating point for financial values.
- Intermediate calculations retain provider/import precision.
- Rounding occurs only at defined output or allocation boundaries.
- Decimal length, source scale, exact-result precision, and allocation scale are bounded and fail closed with deterministic reasons when exceeded.
- Calculated values transported between calculation stages use the wider documented 256-digit/96-scale result boundary rather than the narrower source-input parser; CALC-001B consumers return typed unavailable results for malformed or oversized calculated-result transport instead of throwing.
- Production FIFO and ledger projection arithmetic use the same reviewed decimal wrapper and reject malformed or oversized lot, sale, and split values before projection output.

### CALC-002 — Current market value

Market value shall equal position quantity multiplied by the selected price and portfolio-base FX rate.

Acceptance:

- Native and base values are both available.
- Native/home presentation uses the same selected price and that valuation date’s FX observation; toggling cannot change the underlying holding.
- Missing price or FX produces an unavailable component, not zero.
- Cash and securities are subtotaled separately.
- Portfolio invested value and covered basis use the same priced-and-converted holding set; value-only or basis-only positions are excluded from both aligned amounts and disclosed in coverage.
- A portfolio containing explicit all-zero components has a complete zero total; a genuinely empty portfolio remains unavailable.

### CALC-003 — Cost basis and unrealised gain

Open-position cost basis shall include allocated acquisition fees and use transaction-date FX; unrealised gain shall compare current market value with remaining basis.

Acceptance:

- FIFO partial-sale fixtures pass.
- Native and base basis are traceable to lots.
- Percentage is unavailable when basis is zero or missing.

### CALC-004 — Realised gain

Realised gain shall equal base-currency net sale proceeds less matched FIFO basis.

Acceptance:

- Matched lots and allocated fees are inspectable.
- Reversals rebuild matches deterministically.
- Imported trades with unknown FX are marked incomplete.

### CALC-005 — Daily movement

Full base-currency daily movement shall include both local price and FX movement between comparable observations.

Acceptance:

- Formula is `Q × (P_t × FX_t − P_prev × FX_prev)`.
- Quantity is the end-of-day comparison quantity under the documented timing rule.
- Local-price and FX contributions can be shown separately.
- Decomposition assigns the price/FX cross term to the displayed FX contribution so the displayed components reconcile exactly to the headline movement.

### CALC-006 — Portfolio history

Historical value shall combine ledger-derived daily quantities with same-date security and FX observations.

Acceptance:

- History does not back-cast current quantities.
- Missing days follow the documented exchange-calendar fallback.
- Incomplete pre-import activity is labelled and excluded from performance claims.

### CALC-007 — Return metrics

Headline v1 “total gain” shall be price/realised gain based and shall not silently include estimated income.

Acceptance:

- Actual income is shown separately.
- Until the deferred dividend workflow exists, income is omitted or explicitly unavailable rather than inferred.
- TWR/XIRR remain unavailable until explicit external cash-flow classification and complete history exist.
- Any future return metric declares cash-flow and fee treatment.

### DIV-001 — Dividend events and receipts

Declared/paid dividend events and actual portfolio receipts shall be separate records.

Acceptance:

- Event per-share amount, ex-date, record date, payment date, currency, and status are retained where known.
- A receipt records eligible quantity, gross, withholding, net cash, FX, and provenance.
- Forecast events do not post cash.

### DIV-002 — Dividend forecasts

Forecast income shall be visibly estimated and use a deterministic hierarchy.

Acceptance:

- Known declared future events take precedence.
- Otherwise use supported regular payment history/TTM rules.
- Estimate timestamp, method, assumptions, and coverage are exposed in the explanation; the compact forecast view generally suppresses the timestamp.

## CSV import

### IMP-001 — Supported format

The importer shall support the exact supplied 17-column format and distinguish definition from transaction rows.

Acceptance:

- Header normalization tolerates BOM, CRLF/LF, and surrounding whitespace.
- All 244 rows after the header in the supplied file are classified.
- Blank transaction date/type/quantity plus populated `Id`, `Symbol`, `Portfolio`, and `Currency` identifies a portfolio-security definition row only when the remaining row rules pass.
- The exact legacy `<ISO currency>=CASH` shape maps to cash-account events and never creates a security, lot, or quote request; malformed variants block.

### IMP-002 — Staged import

Upload, parse, validate, map, preview, commit, and recalculate shall be separate stages.

Acceptance:

- No portfolio totals change before commit.
- Errors and warnings point to physical row and field.
- Commit summary shows creates, updates, skips, and unresolved items.

### IMP-003 — Mapping workflow

Users shall resolve portfolio and security mappings before dependent transactions commit.

Acceptance:

- Ticker alone never auto-merges ambiguous securities.
- Mapping choices can be reused with explicit scope.
- Changing a mapping after commit creates an audited remap/rebuild operation.

### IMP-004 — Idempotency

Repeated files and repeated commit requests shall not duplicate ledger effects.

Acceptance:

- File hash identifies exact duplicate uploads.
- Normalized row fingerprints identify duplicates across reordered/reformatted files.
- Import commit has a unique idempotency key.
- Commit reconstructs the exact owner-scoped server preview and rejects changed parser, row, issue, mapping, portfolio, or security state before any ledger effect.
- Each request processes at most one bounded atomic chunk; a retry resumes from the durable physical-row high-water without replaying a committed effect.
- Validated row-scoped portfolio/security targets are persisted with their ledger effect, and finalization durably queues one rebuild per affected owned portfolio at its actual ledger high-water before the batch becomes committed.
- Authenticated history reads expose rows, issues, mappings, and audit evidence through fixed-size owner-scoped pages. A reloaded `committing` batch shows its persisted high-water, committed/skipped/remaining counts, and original idempotency key so the owner can resume without presenting partial work as complete.

### IMP-005 — Correction and reversal

A committed batch shall be reversible without deleting source evidence.

Acceptance:

- Reversal creates compensating/superseding ledger state attributable to the batch.
- A corrected batch can be staged against the reversal.
- Audit and original normalized rows remain readable to the owner/admin process.
- The authenticated reversal endpoint rejects cross-site requests and other owners, requires explicit confirmation plus an idempotency key and current batch version, and processes a bounded D1 unit per invocation.

### IMP-006 — Alternative CSV variants (deprecated)

This requirement is resolved by limiting the supported import contract to the supplied 17-column header. No alternative schema is inferred from visual evidence.

Acceptance:

- Unknown headers return a safe compatibility error and header report.
- Adding any future schema requires authoritative field definitions, fixtures, and a separately versioned parser.

## Future broker synchronization

### BRK-001 — Broker adapter compatibility

The architecture shall allow a later documented broker connection to synchronize owned accounts, transactions, cash, and positions without changing the ledger or provider abstractions.

Acceptance:

- Broker integrations implement a provider-neutral adapter and stage data before ledger commit.
- External account/transaction IDs and provider versions/cursors make repeated sync idempotent.
- Broker positions reconcile against, but never silently overwrite, ledger-derived holdings.
- Broker credentials/tokens remain encrypted server-side and never reach logs, client bundles, or CSV exports.
- Broker account-to-portfolio mappings are owner-scoped and cross-user denial paths are testable.
- Broker-supplied quotes, if supported, enter through the market-data abstraction with entitlement/provenance rather than bypassing it.

## Platform, operations, and quality

### PLAT-001 — Cloudflare deployment target

The application shall build as a Vinext/Cloudflare Worker with static assets and D1 bindings configured per environment.

Acceptance:

- Local, preview, and production configuration are distinct.
- Production secrets are Worker secrets, never `NEXT_PUBLIC_*`.
- Missing bindings fail at startup/request boundary with safe errors.
- The generated Worker configuration and Vinext compatibility check are exercised in CI-equivalent verification; unsupported Next/Vinext behavior is not assumed from Next.js documentation alone.
- Cloudflare runtime/binding types are generated with Wrangler and checked for drift; built Worker code references no binding absent from its environment configuration.
- The production deployment profile is Workers Paid for the documented CSV limit and recovery objective. A Free-profile deployment fails closed on CSV upload unless a separately documented Worker-runtime benchmark approves a smaller limit.

### PLAT-002 — PWA foundation

The application shall provide manifest metadata, iPhone-safe viewport behavior, and a minimal service worker.

Acceptance:

- Manifest has name, short name, theme/background colors, start URL, and icon.
- Release assets include installable raster icons appropriate for iOS and standard 192/512-pixel PWA use; SVG-only scaffold metadata is not release completion.
- Service worker caches only an allowlisted public shell/offline asset set.
- Authenticated HTML, APIs, imports, and financial data use network/no-store behavior.

### OPS-001 — Audit logging

Security-sensitive and financially material mutations shall produce append-only audit events.

Acceptance:

- Actor, action, target, request correlation ID, timestamp, and redacted metadata are recorded.
- Audit events do not include raw CSVs, access tokens, or provider secrets.
- User-visible history explains imports, overrides, reversals, and settings changes.

### OPS-002 — Observability

The system shall emit structured, redacted logs and health metrics for auth, imports, calculations, and provider ingestion.

Acceptance:

- Logs correlate a request without logging financial payloads.
- Provider latency, errors, rate limits, and stale-data counts are measurable.
- Calculation/import failures are actionable without exposing another user’s IDs.

### OPS-003 — Backup and recovery

D1 recovery and long-term export procedures shall be documented and tested.

Acceptance:

- Paid production uses D1 Time Travel’s current retention window and records pre-migration bookmarks.
- Encrypted exports are stored outside the primary failure domain for the defined retention period through an explicitly approved manual or automated mechanism; this requirement alone does not authorize R2, Workflows, or another service.
- Restore drill verifies schema, row counts, ownership checks, and representative calculations.

### OPS-004 — Data retention and deletion

Retention shall be explicit for user data, imports, logs, provider data, exports, and deleted accounts.

Acceptance:

- Disabled, deletion-requested, and purged states are distinct.
- Provider data follows the application retention and deletion policy.
- Deletion is idempotent, audited, and verified.

### QUAL-001 — Accessibility

The core experience shall meet WCAG 2.2 AA intent.

Acceptance:

- Semantic landmarks, labels, focus order, keyboard operation, contrast, reduced motion, and error associations are tested.
- Color is not the only gain/loss or status signal.
- Charts have text/table equivalents.

### QUAL-002 — Automated quality gate

Every implementation slice shall pass formatting, lint, strict TypeScript typecheck, production build, relevant unit/integration tests, and rendered-route smoke tests.

Acceptance:

- CI-equivalent commands are documented and deterministic.
- The aggregate quality command includes `tsc --noEmit`; a Vite/Vinext transpile-only build is not treated as a typecheck.
- Financial fixtures are independent of network providers.
- A failed required check blocks task completion.
