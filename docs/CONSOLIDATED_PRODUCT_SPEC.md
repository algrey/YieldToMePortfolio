# YieldToMe consolidated product specification

Status: approved foundation specification  
Date: 2026-07-28  
Source evidence: the four numbered reverse-engineering documents and `YieldToMe_Visual_Style_Guide.md` in `docs/source-evidence/`, and `docs/Example_Portfolio.csv`

## 1. Product statement

YieldToMe is a private, responsive web application for recording and understanding listed investments across currencies. Its core release combines an auditable transaction ledger with cost basis, cash, pricing, foreign exchange, tax-lot, and historical reporting views. Dividend reporting remains a documented later capability.

The product is a faithful rebuild of the reference workflow, not a literal copy of undocumented internals. Where the video or CSV cannot establish behavior, this specification chooses a conservative rule, labels the uncertainty, and creates an explicit validation task.

## 2. Evidence consolidation

### Confirmed by supplied evidence or the project brief

- The target is a private, iPhone-first installable web app with responsive desktop support and Cloudflare hosting.
- Users manage multiple independently named portfolios and require strict separation from other users.
- The reference navigation includes portfolio Overview, Holdings, Quotes, Details, and News areas plus holding/transaction drill-downs, import/export, and settings.
- The supplied CSV contains portfolio/security definitions and transaction-level buys/sells, not merely a current-holdings snapshot.
- The sample states FIFO accounting and contains enough buys/sells to support lot reconstruction for its included history.
- The experience is compact and data-dense; visible metrics include value, cost, daily movement, unrealised/realised results, and income-related information.
- Quotes, FX, history, CSV import, manual records, and correction workflows are core release capabilities. The reference also establishes dividend reporting as a target capability, but its event, receipt, provider, and forecast work is deferred until source quality and the actual-cash workflow are scheduled.
- The Quotes experience should prefer the freshest validated observation allowed by the configured source. Compact views generally suppress timestamps, source, delay, fallback, and quality; those facts remain available in an explanation, while only an action-required state is surfaced inline.
- Users choose a home currency in settings and can toggle a foreign-currency holding’s displayed price/value between its native currency and home currency using that date’s attributable FX rate.
- Broker synchronization is a desired later capability; v1 remains manual/import driven, but ledger/import boundaries must accept future broker adapters.

### Strongly inferred

- Repeated security definition rows are reference/mapping facts and do not create quantity.
- A zero `Purchase Exchange Rate` means missing/unknown rather than a mathematically valid rate.
- `Display Symbol` is a user-facing override, not a canonical security ID.
- The reference’s local responsiveness likely relied on cached data; the rebuild should normalize/cache provider observations server-side.
- Portfolio history needs transaction replay plus historical price/FX, not today’s quantity multiplied backward.
- The displayed average cost can summarize remaining FIFO lots while those lots remain authoritative.

### Reversible assumptions adopted for v1

- FIFO is the only enabled cost-basis method.
- A lawful, reliable delayed feed is preferred; best-effort, end-of-day, and manual values are selected under an explicit precedence rule and never described as real-time without evidence.
- Cloudflare Access serves a small administrator-invited user set.
- Headline price gain excludes estimated dividends. When the deferred income workflow exists, actual income remains separate.
- Cash is a currency-specific ledger, not a synthetic security.
- The service worker stores no private financial data.
- Original CSV bytes are not retained; hashes, normalized source rows, mappings, issues, and audit evidence are retained in D1.
- News is a disabled navigation destination pending an attributable source decision.

### Reference independence and genuine uncertainties

- The sample screens/video and sample CSV were intentionally supplied as independent layout/schema references. Differences in their portfolio contents are expected, are not contradictions, and must not drive reconciliation logic or open questions.
- The supplied 17-column CSV header is the complete supported import contract. Fields visible only in other references are out of scope and must not be inferred.
- Some reference labels do not conclusively reveal whether income is included in “all time” return.
- Current/reference quote states move over time and cannot be used as fixed formula fixtures.
- The CSV includes trades but does not establish complete cash, dividends, transfers, corporate actions, or pre-history.

### Missing information

- Exact source FX direction in every export variant.
- Whether future income needs Australian franking-credit projections or cash only.
- Complete external cash-flow and dividend history needed for TWR/XIRR.
- Whether News is a release requirement and, if so, its attributable source.
- Account deletion cooling-off/retention policy and final Access invitation/session settings.

## 3. Problem

Personal investors frequently assemble portfolio truth from broker exports, spreadsheets, market-data sites, and tax records. Those sources disagree about symbols, currencies, adjusted prices, timing, fees, and dividends. A useful tracker must therefore do more than display current quotes:

- retain the owner’s source transactions;
- explain every derived number;
- distinguish observed data from estimates;
- support corrections without destroying provenance;
- remain useful with delayed or missing market data;
- protect financial data for each authorized user;
- work well on an iPhone as well as a desktop.

## 4. Target users

### Primary

A self-directed investor with one or more portfolios, holdings on Australian and international exchanges, base-currency reporting needs, and a preference for a dense desktop ledger plus a concise mobile overview.

### Initial deployment

V1 supports a small, administrator-invited group of independent users in one deployment while keeping their portfolio, import, override, and audit data strictly isolated. Every real and synthetic user follows the same authentication and ownership rules. The configured Yahoo-compatible source has no product-enforced user-count or deployment-mode gate.

## 5. Goals

1. Import the supplied YieldToMe CSV shape without losing source information.
2. Maintain a canonical per-user ledger for portfolios, securities, trades, fees, cash movements, and manual corrections, with an explicit later extension for dividends.
3. Reproduce the core reference views: overview, holdings, quotes, details, and news navigation.
4. Calculate explainable current value, cost basis, unrealised gain, realised gain, daily movement, and historical value in the portfolio base currency.
5. Use provider-neutral market-data adapters with explicit provenance, timestamps, adjustment rules, and manual fallbacks.
6. Provide responsive and installable web-app foundations, especially for iPhone use.
7. Operate as a private Cloudflare-hosted application with server-enforced tenant isolation, recovery procedures, and auditability.
8. Prefer the freshest validated, lawfully usable quote for active price views, with honest best-effort/EOD/manual fallback and no unsupported real-time claim.
9. Preserve future broker synchronization as another staged, idempotent ledger source rather than a special holding overwrite.

## 6. Non-goals for the first release

- Brokerage execution, bank transfer, or custody.
- Financial, tax, or investment advice.
- Public portfolio pages, sharing, comments, leaderboards, or social features.
- Broker synchronization in v1. A later version may use documented broker APIs/OAuth; screen scraping and storing raw broker passwords remain out of scope.
- Self-service signup, password reset, household invitations, or billing.
- Tax-return preparation or jurisdiction-specific tax advice.
- Options, futures, derivatives, crypto wallets, private assets, short selling, or margin.
- Sub-minute or exchange-certified live pricing.
- Offline viewing or editing of private portfolio records.
- Provider corporate-action ingestion, dividend receipts/forecasting, withholding/franking analytics, and income/yield metrics. Explicit ledger splits remain supported.
- Full performance attribution, benchmark comparison, TWR, or XIRR in the first calculation slice.
- OCR or free-form spreadsheet import.

## 7. Experience principles

### Trust before decoration

Every material figure has a stored definition, currency, as-of time, and state. Compact views do not add routine market-data metadata; `Price unavailable` is shown when no usable quote exists.

User-facing summaries and lists generally suppress exact timestamps. Show a business-relevant date when it helps interpret a transaction, import, or calculation; keep the exact timestamp in the adjacent detail/audit explanation when provenance requires it.

### Dense, not cramped

Desktop screens favor scanning and comparison: compact tables, restrained borders, right-aligned numbers, clear totals, and low-chrome controls. Mobile reflows the hierarchy into cards and summaries rather than shrinking a desktop grid.

### Correctable, not mutable

Users can fix mappings, transactions, prices, and import decisions. Corrections are attributable and reversible.

### Useful under imperfect data

One missing quote must not erase an entire portfolio. The application excludes unavailable market value from known totals and shows `Price unavailable` for the affected holding without adding routine stale badges.

### Familiar reference vocabulary

Use Overview, Holdings, Quotes, Details, News, Quantity, Average Cost, Market Value, Gain/Loss, and Yield where those terms match the reference. Add clarification where the reference was ambiguous.

## 8. Information architecture

### Global shell

- Brand mark and YieldToMe name.
- Active portfolio selector.
- Add/import action.
- User/session menu.
- Primary tab row.
- Actionable partial-data status when a displayed total is incomplete or an observation needs attention.

### Overview

- Portfolio title and base currency.
- Current portfolio value.
- Today’s movement and percentage.
- Total cost and unrealised gain/loss.
- Cash and invested value.
- No income summary in the core release; add it with the deferred actual-receipt workflow.
- Allocation/holdings summary.
- Historical value chart with range controls.
- Clear coverage and freshness state.

### Holdings

- One row per security position.
- Symbol/name/exchange/currency, quantity, average cost, current/previous price, market value, daily movement, and total gain/loss. Income/yield columns are deferred.
- Sort, filter, expand, and mobile card presentation.
- Cash represented separately, never disguised as a security.

### Quotes

- Portfolio watch/quote table.
- Prefer the freshest validated observation allowed by the configured source; otherwise use the selected EOD/manual fallback. Generally suppress timestamps, provider, delay, and fallback text in the compact row. A manual, stale, indicative, or fallback value remains discoverable through an adjacent explanation, and only an action-required state is surfaced inline. `Price unavailable` appears when there is no usable value.
- Manual refresh subject to rate limits.
- Manual price override workflow with reason and effective time.
- Per-holding native/home-currency display toggle using the selected observation date’s FX rate; the toggle changes presentation only.

### Details

- Settings: user home currency, portfolio title, timezone, accounting method, and display preferences. Portfolio reporting currency is initialized from the user’s home currency. Withholding assumptions are deferred with dividends.
- Transaction ledger and entry/edit/reversal workflows.
- Import history, mapping resolutions, warnings, and reversal.
- Security and provider mapping details.
- Data export and account-data deletion controls when implemented.

### News

A navigation placeholder only until an attributable news source and privacy behavior are chosen. News does not block the first release.

## 9. Core workflows

### Create a portfolio

An authenticated invited user creates a portfolio, chooses base currency and timezone, and confirms FIFO accounting. The system records the actor and defaults. Empty-state guidance offers CSV import or manual transaction entry.

### Import a CSV

The user uploads a file, sees parser/header results, reviews inferred portfolios and security mappings, fixes unresolved rows, previews the net changes, and explicitly commits. The committed batch produces immutable source rows and linked ledger records. A batch can later be reversed without deleting its audit trail.

### Record or correct a transaction

The user enters a trade or cash event with currency, timestamps, fees, and source. An edit creates a superseding version or reversal plus replacement. Holdings, lots, cash, snapshots, and metrics rebuild deterministically. Dividend receipts use the same immutable pattern only after that deferred workflow is promoted.

### View a foreign holding in home currency

The user opens the holding/price menu and switches between native and home currency. The application selects the FX observation for the displayed market date and converts price/value for presentation. The rate/date/source remain available in the adjacent explanation and are generally suppressed in the compact view. The security price and transaction facts remain in native currency; canonical holding cost/value projections and portfolio totals are stored/rebuilt in home currency.

### Future broker synchronization

A later connection maps a broker account to an owned portfolio, stages broker transactions/positions through the same validation/reconciliation model as imports, and commits idempotently by broker record ID/version. Broker positions reconcile the ledger but never silently overwrite it. Broker quote access may be another market-data adapter when exposed by the connected account.

### Inspect a number

The user can move from a portfolio total to the contributing holding, quote/FX observation, and ledger records. The interface exposes formula inputs and any exclusions.

### Resolve missing data

An actionable coverage summary identifies a missing security map, quote, FX rate, or cost basis. The user can fix the map, retry the provider, or enter a versioned manual override. Routine healthy rows stay compact; anomalous or calculation-limiting states are never hidden.

## 10. Responsive behavior

### Desktop

- Maximum content width approximately 1,440 px.
- Sticky or persistent tab navigation.
- Dense tables with horizontal scrolling only as a last resort.
- Summary cards remain compact and aligned.
- Keyboard-visible focus and logical tab order.

### iPhone and narrow screens

- Respect safe-area insets and a `viewport-fit=cover` viewport.
- Minimum 44×44 CSS-pixel interactive targets.
- Selector and primary actions remain reachable near the top.
- Tab row may horizontally scroll with the active tab visible.
- Tables become labelled holding cards; critical number first, secondary facts below.
- Charts use fewer ticks and no hover-only information.
- Forms use input modes appropriate for decimal and date entry.
- No feature depends on install mode. Standalone PWA and Safari browser behavior are both supported.

## 11. Product state contract

Every route and workflow must specify these states, not just its populated “happy path”:

| State                     | Product behavior                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial loading           | Preserve shell/navigation dimensions; use restrained labelled progress and do not show fabricated zero values                                  |
| Background refresh        | Keep the last valid value visible; generally suppress timestamps and use a non-intrusive refresh state only while user action is relevant      |
| Empty user                | Explain that no portfolio exists and offer create/import once those actions are implemented                                                    |
| Empty portfolio           | Show base currency/settings plus manual-entry/import next steps; value metrics are unavailable, not `0` unless an explicit zero balance exists |
| Missing quote             | Retain position/basis; exclude unavailable market value from known total; show `Price unavailable`                                             |
| Missing FX                | Show native values; base value and dependent gain are unavailable                                                                              |
| Partial history           | Draw/label only supported range and explain missing ledger/market/FX coverage                                                                  |
| Provider failure          | Keep last valid observation where available and expose its stale/fallback state on demand; otherwise show `Price unavailable`; back off/retry  |
| Validation error          | Associate stable message with row/field/control, preserve user input, and block only unsafe commit                                             |
| Authorization failure     | Return a non-data-bearing denial and no cached private response                                                                                |
| Import commit failure     | Preserve staged batch and resumable/idempotent state; never imply uncommitted rows changed totals                                              |
| Offline loaded session    | Existing in-memory UI may remain, clearly offline/stale; server mutations disabled                                                             |
| Offline reload            | Static safe offline page; no cached portfolio/API/CSV data in v1                                                                               |
| Disabled/deleting account | Access denied; show only an appropriate lifecycle/support response without portfolio details                                                   |

Loading and failure copy must name what is happening (“Refreshing end-of-day prices”, “FX unavailable”) rather than generic “Something went wrong” where a safe reason is known.

## 12. Validation summary

- Server validates authentication, ownership, enums, identifiers, decimal/date/currency formats, effective intervals, payload/file bounds, and domain invariants.
- Client validation improves feedback but is never authoritative.
- Financial unknowns stay nullable/typed; zero is accepted only as an actual value under the relevant rule.
- Market observations require provenance, currency, adjustment state, and timestamps.
- Ledger changes and imports require idempotency; destructive corrections use reversal/supersession.
- CSV errors are retained by physical row/field and never silently discarded.
- Cross-user IDs, ambiguous securities, oversells, bad FX direction, unsupported accounting methods, and unknown parser headers block mutation.

## 13. Calculation summary

The normative formulas are in `CALCULATIONS.md`. Product-level meanings:

- current market value uses current quantity × selected native price × selected FX;
- cost basis comes from remaining FIFO lots including acquisition costs and transaction-date FX;
- daily movement compares compatible current/previous price and FX observations;
- realised and unrealised gain are separate;
- income distinguishes actual, declared, estimated, and annualised;
- historical value replays dated quantities/cash and same-date observations;
- portfolio-wide TWR/XIRR remain unavailable until complete history and external-flow classification exist.

## 14. Offline and stale-data contract

The first release caches only versioned public shell assets and an offline information page. It does not cache authenticated HTML, API responses, CSVs, or portfolio data in the service worker. A network loss during an already loaded session may leave current in-memory content visible, but reload shows the offline page and mutations are disabled.

Market-derived provenance, timestamps, quality, and coverage remain stored and available to calculations/operations. Compact user views generally suppress timestamps, provider, delay, and fallback labels. Manual, stale, indicative, or fallback state remains available through an adjacent explanation, and only an action-required state is surfaced inline. `Price unavailable` appears when no usable price exists.

Later offline private-data support would require a separate threat model, encrypted local storage decision, data-expiry rules, and conflict-safe mutation outbox.

## 15. Market-data product decision

The product priority is the freshest validated observation available from the configured source for active Quotes/Holdings views, with EOD and manual observations as explicit fallbacks. Compact views make no “live” claim and generally suppress timestamps, provider, delay, and fallback labels. Material stale/manual/indicative/fallback state remains inspectable, with inline status reserved for action-required conditions.

The owner has selected a free Yahoo Finance/yfinance-compatible source for v1. `yfinance` itself is a Python library and cannot run in the Worker; the implementation will be a small, server-only adapter to the corresponding public endpoints. This is an explicit best-effort decision: the source is unaffiliated, has no service-level guarantee, and can change without notice.

EODHD and other providers remain optional future upgrades based on measured coverage, reliability, capability, or cost needs. They are not prerequisites for adding users or changing deployment mode.

Therefore:

- treat Yahoo observations as best-effort, retaining source/timestamp/delay uncertainty internally;
- apply no source-specific user-count, deployment-mode, public, paid, redistribution, or owner-binding gate;
- implement provider-neutral contracts and deterministic fixtures before any network adapter;
- keep Alpha Vantage as a separately gated candidate rather than adding a second v1 adapter before a measured need; manual values are the durable fallback;
- evaluate a future broker quote adapter because a user’s broker entitlement may provide better current data.

No implementation may depend directly on a provider-shaped symbol or response.

## 16. Success measures

### Release readiness

- 100% of committed rows in the supplied example CSV are accepted or explicitly rejected with a reason.
- Re-importing the same file creates no duplicate ledger effects.
- Every portfolio query has a tested cross-user denial path.
- Calculation fixtures reproduce independently computed expected values to the documented rounding tolerance.
- Current totals report quote and FX coverage rather than silently treating gaps as zero.
- A committed import can be reversed and recalculated without deleting audit evidence.
- Overview and holding navigation work at 320 px and desktop widths.
- The application builds for Cloudflare Workers and passes lint and automated tests.

### Post-release health

- Provider ingestion success, staleness, and owner-scope denials are observable.
- No unresolved reconciliation drift between ledger and projections.
- Restore drills complete within the documented recovery objective.
- Support incidents can be traced through structured logs and audit events without exposing financial payloads.

## 17. Open decisions and validation spikes

1. Confirm whether the reference’s “all time” percentage excludes income, as assumed.
2. Decide whether dividend forecasts include Australian franking-credit information or only cash.
3. Decide if News remains out of scope or requires an attributable source.
4. Validate Cloudflare Access session length, allowed identities, and account offboarding policy.
5. Verify iOS install/offline behavior on physical devices before release.
6. Evaluate another provider only when measured coverage, reliability, capability, or cost warrants it.
