# YieldToMe consolidated product specification

Status: approved foundation specification  
Date: 2026-07-28  
Source evidence: the four numbered reverse-engineering documents, `YieldToMe_Visual_Style_Guide.md`, and `Example_Portfolio.csv`

## 1. Product statement

YieldToMe is a private, responsive web application for recording and understanding listed investments across currencies. It combines an auditable transaction ledger with cost basis, cash, pricing, foreign exchange, dividend, tax-lot, and historical reporting views.

The product is a faithful rebuild of the reference workflow, not a literal copy of undocumented internals. Where the video or CSV cannot establish behavior, this specification chooses a conservative rule, labels the uncertainty, and creates an explicit validation task.

## 2. Evidence consolidation

### Confirmed by supplied evidence or the project brief

- The target is a private, iPhone-first installable web app with responsive desktop support and Cloudflare hosting.
- Users manage multiple independently named portfolios and require strict separation from other users.
- The reference navigation includes portfolio Overview, Holdings, Quotes, Details, and News areas plus holding/transaction drill-downs, import/export, and settings.
- The supplied CSV contains portfolio/security definitions and transaction-level buys/sells, not merely a current-holdings snapshot.
- The sample states FIFO accounting and contains enough buys/sells to support lot reconstruction for its included history.
- The experience is compact and data-dense; visible metrics include value, cost, daily movement, unrealised/realised results, and income-related information.
- Quotes, FX, history, dividends, CSV import, manual records, and correction workflows are required product capabilities.
- The Quotes experience should prefer approximately 20-minute-delayed observations over end-of-day values and clearly distinguish delayed/EOD/manual states.
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
- A lawful, reliable 20-minute-delayed feed is preferred; end-of-day and manual values are explicit fallbacks when the preferred feed is unavailable or unlicensed.
- Cloudflare Access serves a small administrator-invited user set.
- Headline price gain excludes estimated dividends; actual income is separate.
- Cash is a currency-specific ledger, not a synthetic security.
- The service worker stores no private financial data.
- Original CSV bytes are not retained; hashes, normalized source rows, mappings, issues, and audit evidence are retained in D1.
- News is a disabled navigation destination pending a licensed source decision.

### Reference independence and genuine uncertainties

- The sample screens/video and sample CSV were intentionally supplied as independent layout/schema references. Differences in their portfolio contents are expected, are not contradictions, and must not drive reconciliation logic or open questions.
- The supplied 17-column CSV header is the complete supported import contract. Fields visible only in other references are out of scope and must not be inferred.
- Some reference labels do not conclusively reveal whether income is included in “all time” return.
- Current/reference quote states move over time and cannot be used as fixed formula fixtures.
- The CSV includes trades but does not establish complete cash, dividends, transfers, corporate actions, or pre-history.

### Missing information

- Exact source FX direction in every export variant.
- Contractual market-data permission for the proposed private multi-user display/storage model.
- Whether future income needs Australian franking-credit projections or cash only.
- Complete external cash-flow and dividend history needed for TWR/XIRR.
- Whether News is a release requirement and, if so, its licensed source.
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

### Secondary

A small, administrator-invited group of independent users. They share the application deployment but must never share portfolio data. The first release is not a social, advisory, broker, or household-collaboration product.

## 5. Goals

1. Import the supplied YieldToMe CSV shape without losing source information.
2. Maintain a canonical per-user ledger for portfolios, securities, trades, fees, cash movements, dividends, and manual corrections.
3. Reproduce the core reference views: overview, holdings, quotes, details, and news navigation.
4. Calculate explainable current value, cost basis, unrealised gain, realised gain, daily movement, income, and historical value in the portfolio base currency.
5. Use provider-neutral market-data adapters with explicit provenance, timestamps, adjustment rules, and manual fallbacks.
6. Provide responsive and installable web-app foundations, especially for iPhone use.
7. Operate as a private Cloudflare-hosted application with server-enforced tenant isolation, recovery procedures, and auditability.
8. Prefer licensed approximately 20-minute-delayed quotes for active price views, with honest EOD/manual fallback.
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
- Automated corporate-action processing beyond explicit splits and cash dividends.
- Full performance attribution, benchmark comparison, TWR, or XIRR in the first calculation slice.
- OCR or free-form spreadsheet import.

## 7. Experience principles

### Trust before decoration

Every material figure has a definition, currency, as-of time, and state. Estimated or incomplete values are visibly different from observed values.

### Dense, not cramped

Desktop screens favor scanning and comparison: compact tables, restrained borders, right-aligned numbers, clear totals, and low-chrome controls. Mobile reflows the hierarchy into cards and summaries rather than shrinking a desktop grid.

### Correctable, not mutable

Users can fix mappings, transactions, prices, and import decisions. Corrections are attributable and reversible.

### Useful under imperfect data

One missing quote must not erase an entire portfolio. The application shows partial totals with coverage indicators, stale badges, and exact remediation.

### Familiar reference vocabulary

Use Overview, Holdings, Quotes, Details, News, Quantity, Average Cost, Market Value, Gain/Loss, and Yield where those terms match the reference. Add clarification where the reference was ambiguous.

## 8. Information architecture

### Global shell

- Brand mark and YieldToMe name.
- Active portfolio selector.
- Add/import action.
- User/session menu.
- Primary tab row.
- Data-freshness and partial-data status when relevant.

### Overview

- Portfolio title and base currency.
- Current portfolio value.
- Today’s movement and percentage.
- Total cost and unrealised gain/loss.
- Cash and invested value.
- Income summary when actual dividend receipts exist.
- Allocation/holdings summary.
- Historical value chart with range controls.
- Clear coverage and freshness state.

### Holdings

- One row per security position.
- Symbol/name/exchange/currency, quantity, average cost, current/previous price, market value, daily movement, total gain/loss, and income/yield where supported.
- Sort, filter, expand, and mobile card presentation.
- Cash represented separately, never disguised as a security.

### Quotes

- Portfolio watch/quote table.
- Prefer approximately 20-minute-delayed observations during market hours; otherwise use the selected EOD/manual fallback. Always show timestamp, source, currency, previous close, daily change, and delayed/stale state.
- Manual refresh subject to rate limits.
- Manual price override workflow with reason and effective time.
- Per-holding native/home-currency display toggle using the selected observation date’s FX rate; the toggle changes presentation only.

### Details

- Settings: user home currency, portfolio title, timezone, accounting method, default withholding assumption, and display preferences. Portfolio reporting currency is initialized from the user’s home currency.
- Transaction ledger and entry/edit/reversal workflows.
- Import history, mapping resolutions, warnings, and reversal.
- Security and provider mapping details.
- Data export and account-data deletion controls when implemented.

### News

A navigation placeholder only until a licensed, attributable news source and privacy behavior are chosen. News does not block the first release.

## 9. Core workflows

### Create a portfolio

An authenticated invited user creates a portfolio, chooses base currency and timezone, and confirms FIFO accounting. The system records the actor and defaults. Empty-state guidance offers CSV import or manual transaction entry.

### Import a CSV

The user uploads a file, sees parser/header results, reviews inferred portfolios and security mappings, fixes unresolved rows, previews the net changes, and explicitly commits. The committed batch produces immutable source rows and linked ledger records. A batch can later be reversed without deleting its audit trail.

### Record or correct a transaction

The user enters a trade/cash/dividend event with currency, timestamps, fees, and source. An edit creates a superseding version or reversal plus replacement. Holdings, lots, cash, snapshots, and metrics rebuild deterministically.

### View a foreign holding in home currency

The user opens the holding/price menu and switches between native and home currency. The application selects the FX observation for the displayed market date, shows the rate/date/source, and converts price/value for presentation. The security price and transaction facts remain in native currency; canonical holding cost/value projections and portfolio totals are stored/rebuilt in home currency.

### Future broker synchronization

A later connection maps a broker account to an owned portfolio, stages broker transactions/positions through the same validation/reconciliation model as imports, and commits idempotently by broker record ID/version. Broker positions reconcile the ledger but never silently overwrite it. Broker quote access may be another market-data adapter when the user’s entitlement and broker terms allow it.

### Inspect a number

The user can move from a portfolio total to the contributing holding, quote/FX observation, and ledger records. The interface exposes formula inputs and any exclusions.

### Resolve missing data

A coverage banner identifies the missing security map, quote, FX rate, or cost basis. The user can fix the map, retry the provider, or enter a versioned manual override.

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
| Background refresh        | Keep last valid value visible with as-of timestamp and a non-blocking refresh indicator                                                        |
| Empty user                | Explain that no portfolio exists and offer create/import once those actions are implemented                                                    |
| Empty portfolio           | Show base currency/settings plus manual-entry/import next steps; value metrics are unavailable, not `0` unless an explicit zero balance exists |
| Missing quote             | Retain position/basis; exclude unavailable market value from known total; show mapping/retry/manual remediation                                |
| Missing FX                | Show native values; base value and dependent gain are unavailable                                                                              |
| Partial history           | Draw/label only supported range and explain missing ledger/market/FX coverage                                                                  |
| Provider failure          | Keep last valid observation with stale/failure state; back off/retry server-side; never blank ledger facts                                     |
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

Every market-derived view displays:

- observed/as-of timestamp;
- ingestion timestamp when useful;
- source;
- delayed, end-of-day, stale, manual, or estimated state;
- quote and FX coverage counts.

Later offline private-data support would require a separate threat model, encrypted local storage decision, data-expiry rules, and conflict-safe mutation outbox.

## 15. Market-data product decision

The product priority is approximately 20-minute-delayed pricing for active Quotes/Holdings views, with EOD and manual observations as explicit fallbacks. “Live prices” is interface shorthand only; the product label must say `Delayed 20 min`, `End of day`, `Manual`, or the actual licensed state.

Yahoo Finance is not an approved provider because its commonly used quote endpoints are undocumented and do not provide a supported market-data API or clear hosted-display contract. Scraping or relying on community wrappers would create availability, provenance, and licensing risks.

EODHD is the preferred provider candidate because it advertises one API for ASX and 60+ international exchanges, FX, end-of-day history, and 15–20-minute-delayed ASX quotes. It also states that commercial plans can include end-user display and exchange redistribution rights. Production use still requires written confirmation of the exact plan, user scope, storage/cache rights, retention/deletion terms, covered exchanges, and total price.

Therefore:

- treat low-cost international delayed data as a high-priority provider-validation constraint, not a confirmed free entitlement;
- do not scrape ASX/Yahoo or depend on undocumented endpoints to manufacture a free feed;
- implement the adapter and UI for delayed observations first using fixtures;
- block production activation until `SPK-002` records a lawful provider, exact cost, display/storage rights, exchanges, and user scope;
- use EODHD as the preferred adapter candidate and retain its EOD observations plus manual values as functional fallbacks;
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

- Provider ingestion success and staleness are observable.
- No unresolved reconciliation drift between ledger and projections.
- Restore drills complete within the documented recovery objective.
- Support incidents can be traced through structured logs and audit events without exposing financial payloads.

## 17. Open decisions and validation spikes

1. Obtain written market-data rights confirmation for the exact private multi-user deployment model.
2. Confirm whether the reference’s “all time” percentage excludes income, as assumed.
3. Decide whether dividend forecasts include Australian franking-credit information or only cash.
4. Decide if News remains out of scope or requires a licensed source.
5. Validate Cloudflare Access session length, allowed identities, and account offboarding policy.
6. Verify iOS install/offline behavior on physical devices before release.
7. Obtain an EODHD commercial quote and written confirmation for the intended international multi-user display/storage model; if unsuitable, evaluate the next licensed global provider.
