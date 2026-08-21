# Calculations

Status: normative v1 rules  
Date: 2026-07-28

This document defines financial behavior. Interface labels and implementations must not invent alternative meanings.

## 1. Numerical conventions

### Decimal arithmetic

- Parse quantity, money, price, rate, percentage, and allocation values through the `decimal.js` `10.6.0` domain wrapper. Callers may supply canonical decimal strings or internal decimal values only; JavaScript `number` is excluded from the contract.
- Never use JavaScript `number` for a financial calculation or equality decision.
- Preserve source precision in normalized observations and transactions.
- Use canonical decimal strings for persistence and API transport.
- Reject NaN, infinity, exponent notation, locale separators after parsing, and zero/negative rates where prohibited.
- A source decimal is bounded to 64 digits and 24 fractional places before construction. Exact operation chains are bounded to 256 significant digits and 96 fractional places with 320 working digits; work outside those limits fails closed instead of allocating an unbounded power or silently rounding. A calculated decimal transported between domain stages uses a dedicated parser at the wider 256-digit/96-scale result boundary; it must not be reparsed as a source fact.
- Addition, subtraction, and multiplication retain their exact finite result scale. Division is marked as requiring an explicit rounding scale and cannot be serialized as an exact stored result without that boundary.
- FIFO matching, lot allocation, split adjustment, and ledger projection calculations use this same wrapper; they must not introduce a parallel `bigint`, `number`, or power-of-ten arithmetic implementation that bypasses these limits.

### Currency direction

For the user’s home/reporting currency `B` (also called portfolio base currency in stored projections) and a holding’s native/trading currency `N`:

`FX(N→B, t)` means units of `B` received for one unit of `N`.

`base amount = native amount × FX(N→B, t)`

When `N = B`, FX is exactly `1` with source `identity`, not a provider observation.

Native price/transaction observations remain stored in `N`. Holding projections, cost basis, snapshots, and portfolio totals retain their canonical reporting amounts in `B` with FX provenance.

### Rounding

- Keep at least the full source scale through multiplication and allocation.
- Round only persisted allocation residuals and displayed values.
- Currency display normally uses the ISO minor units; allow additional precision in drill-down for prices/rates.
- Display quantity up to the security/source scale, trimming insignificant trailing zeroes.
- Display percentage to two decimal places by default.
- Use decimal half-even for report/display rounding.
- Allocation uses proportional unrounded values, rounds each except the final allocation, and assigns the exact remainder to the final item so totals reconcile. FIFO defaults to the bounded 24-place allocation scale so accepted source precision is not silently reduced.
- Allocation scale is explicitly bounded to 24 places; negative totals, non-positive denominators, invalid parts, and allocated amounts outside zero-to-total fail with stable reasons.

### Signs

Normalized transaction quantities are positive; transaction type supplies buy/sell direction.

- Gain: positive favorable, negative unfavorable.
- Cash ledger entry: inflow positive, outflow negative.
- Fees and taxes stored as positive costs and subtracted/added according to transaction rule.
- Percent denominator uses an absolute positive basis/value when the named formula requires it.

## 2. Observation selection

### Current/EOD price

For security `s` and valuation instant/date `t`, select:

1. active manual price override covering `t`;
2. **(MKT-009B) narrow candidates to the owner's `user_settings.price_source_preference`**, when one is configured and at least one candidate matches it — see the dedicated note directly below for the exact ranking rule and its trade-off;
3. approved validated best-effort/delayed observation within its applicable staleness window and matching the required adjustment state;
4. approved EOD observation matching the required adjustment state;
5. previous valid trading-day observation within the configured EOD staleness window;
6. unavailable.

For v1 current value, use raw/unadjusted close or latest EOD observation because ledger quantities already reflect explicit split effects. Adjusted series is used for chart continuity/return research only and must never multiply against already split-adjusted quantities without reconciliation.

**MKT-009B: price-source preference deliberately outranks freshness within the existing fallback window (Orchestrator ruling on review round-1 finding F1).** `user_settings.price_source_preference` (`yahoo_authenticated` / `yahoo_anonymous` / `sharesight_delayed`) is a PREFERENCE over which provider's observation to select, not a second staleness/quality filter and not a second activation gate (`MARKET_DATA_PROVIDER` remains the only deployment-level Yahoo kill switch). Mechanically (`domain/market-data/selection.ts`'s `selectPriceObservation`, `preferredProviderIds` parameter): candidates are first narrowed, within the SAME staleness/currency/scope-filtered window rank 2-5 above already applies, to the preferred provider(s); ranking (freshness, then interval/quality, then observation time) then proceeds as usual WITHIN that narrowed set. The ruling: when the preferred provider has ANY observation inside the fallback window, it wins OUTRIGHT over a fresher observation from a non-preferred provider — that is what "prefer this source" means, and a preference that only won ties would not meet the owner's stated intent ("make it configurable: logged in, not logged in, or sharesight"). This does NOT change the narrowing semantics of ranks 3-5 themselves (staleness/EOD-vs-delayed/prior-session rules are identical to before this task), and status labelling (`current`/`fallback`/`stale`) stays exactly as honest as it was before the preference existed — a stale preferred observation is still reported `stale`, never silently promoted to `current`. A preferred provider with ZERO usable candidates in the window falls back, honestly, to the best candidate from ANY provider — never `Price unavailable` merely because the preferred source is silent while another source has a valid observation. See `docs/ARCHITECTURE.md`'s decision note for the default-value reasoning and `docs/MARKET_DATA_STRATEGY.md` §20 for the full feature description.

**BRK-012C: rank 2 ("approved validated best-effort/delayed observation") now has a real, populated input.** This ranking was already specified above before any delayed source existed; BRK-012B stored Sharesight's `listUserInstruments` prices as `interval = 'delayed'` `price_observations` rows but deliberately EXCLUDED them from every selection read (`provider_id <> 'sharesight'` predicates in `app/owned-holdings.ts`/`db/repositories/snapshots.ts`) as a pure-storage slice. BRK-012C lifts that exclusion for CURRENT-holding selection ONLY (`app/owned-holdings.ts`) — `domain/market-data/selection.ts`'s `providerRank` function already ranked `interval = 'delayed'` ahead of `'eod'` for an equal market-date age, so NO selection-logic change was required, only removing the predicate that had been keeping real delayed data from ever reaching it. There is ONE selection implementation (`loadOwnedHoldings`); THREE call sites reach it (`app/owned-holdings.ts` itself, `app/owned-income-projection.ts`, `app/owned-dividend-assumptions.ts`, each independently invoking it) — no double-counting risk, but NOT because there is only one call site (there are three): the read gate behind it (`app/sharesight-price-gate-service.ts`) is IDEMPOTENT via a per-owner watermark, so however many of the three call sites run within one request/window, at most one of them actually triggers a Sharesight fetch. Historical/snapshot valuation (`db/repositories/snapshots.ts`, the Overview daily-history chart) KEEPS its Sharesight exclusion — that surface never reads Sharesight's delayed intraday quotes, a deliberate, separately-ruled decision, not an oversight. **MKT-008 update (2026-08-21):** the exclusion predicate was always `provider_id <> 'sharesight'`, never an allow-list of exactly `yahoo-compatible` — so it was already honest to describe as "excludes only Sharesight," not "Yahoo-compatible only." MKT-008 adds a THIRD, non-Sharesight EOD price source (`provider_id = 'owner-import'`, the owner's uploaded/backup-restored price history, `docs/MARKET_DATA_STRATEGY.md` §18), which therefore participates in historical/snapshot valuation with NO code change to this predicate — an owner-imported daily close is the same shape of fact as a Yahoo-compatible EOD observation (a genuine end-of-day close, `interval = 'eod'`, `adjustment_state = 'raw'`), unlike Sharesight's delayed intraday quote, so this is consistent with the original ruling's intent, not a reversal of it. Historical/snapshot valuation today therefore reads: the deployment-wide Yahoo-compatible EOD feed, PLUS each owner's own uploaded/restored price history — never Sharesight. Freshness for the delayed path is bounded by `app/sharesight-price-gate-service.ts`'s 10-minute read gate (see `docs/MARKET_DATA_STRATEGY.md` §17) — a Sharesight-sourced current price is always labelled `Delayed (Sharesight) as of <quote timestamp>` in the holding's explanation text, never "live".

**BRK-012C review round (2026-08-20, B3): daily-movement transition behavior when a holding's current price switches basis (e.g. today's selected observation is Sharesight-delayed, yesterday's was Yahoo-compatible EOD).** `priceClassComparable` (source/providerId/interval/quality/adjustmentState/mappingId, all compared across the two days) stays STRICT — a cross-basis delta is genuinely not a comparable movement and is never computed, even though both days' individual prices are perfectly well known. This is NOT the same failure as a genuinely missing previous price/FX: the daily movement/percent fields render `unavailable` with reason `price_basis_changed` (rendered "Movement unavailable (price basis changed)", `app/components/portfolio-shell.tsx`) rather than the pre-existing `missing_previous_fx`/`zero_previous_value` reasons, which stay reserved for an ACTUALLY missing previous observation. This is a ONE-DAY transition state, not a durable degradation: once Sharesight has accreted a second daily observation (today vs. yesterday both `interval = 'delayed'`/`provider_id = 'sharesight'`), `priceClassComparable` is true again and the real movement computes normally — the holding "self-heals" without any code path change, purely because both days now share the same selected basis.

### Previous price

Use the immediately preceding valid market session’s comparable observation from the same selection class and adjustment state. Do not use the previous calendar day blindly.

### FX date fallback

For a required market/accounting date:

1. active manual FX override covering the requested instant/date;
2. same-date approved observation at or before the valuation cutoff;
3. prior available business-day observation within five calendar days;
4. unavailable.

The actual selected observation date remains in calculation evidence but is generally suppressed in compact views. Do not look forward for transaction cost basis because that would use information unavailable at the transaction time. A deliberate manual correction can resolve the gap.

For an imported/manual transaction, a validated explicit transaction FX fact takes precedence over market observations. A missing or legacy-zero transaction FX remains unknown; the calculation engine does not silently substitute a later provider rate without a separate attributed correction.

The calculation boundary accepts separate transaction and valuation FX inputs. A transaction input checks its explicit attributed rate first and does not fall through to a provider rate when that explicit fact is malformed or directionally inconsistent. A valuation input uses the date-attributable selected observation supplied by the market-data selector. Both inputs normalize only the direct native-to-home pair, its explicit inverse, or identity; inversion uses decimal half-even rounding at 18 places, matching the normalized v1 FX adapter boundary.

### Staleness defaults

- EOD: current through the end of the next expected trading session; stale after two missed expected sessions.
- FX daily: stale after two relevant business days.
- Delayed/intraday future capability: stale after delay plus a configured tolerance.
- Manual: does not become fresh merely because it is manual; retain its effective/as-of time in the explanation.

Exchange calendars and holidays determine expected sessions.

### Native/home display toggle

For a holding price observed on market date `d`:

`P_home,d = P_native,d × FX(N→B,d)`

`HoldingValue_home,d = Q_d × P_home,d`

The holding menu can display `P_native,d`/native value or `P_home,d`/home value. Both views use the same quantity and price observation. The selected FX rate, date, and source remain available in the adjacent explanation and are generally suppressed in the compact view.

Changing the toggle is presentation-only. It does not update transactions, lots, security currency, price observations, or holdings. If date-appropriate FX is unavailable, native price/value remains visible and the home view is unavailable—not zero. A change to the user’s home currency is different: it is an explicit settings/recalculation operation that rebuilds derived home-currency projections and snapshots without rewriting native facts.

The calculation result therefore contains one immutable native-fact set plus optional home price/value fields. Compact presentation fields contain only status, currency, and decimal value/reason. The adjacent explanation retains FX source, source identifier, supplied direction/rate, market date, exact observation time, whether inversion occurred, selector state (`current`, `fallback`, or `stale`), quality, fallback reason, and actionability. A stale or fallback rate may remain usable under the selector policy but cannot become indistinguishable from a normal current observation. Requesting the home view while FX is unavailable falls back to the native facts with an explicit fallback flag rather than fabricating a converted value.

## 3. Ledger normalization

Let:

- `q` = positive quantity;
- `p` = native unit price;
- `f` = native fee;
- `tax` = native transaction tax;
- `fx` = native-to-portfolio-base FX at the transaction;
- `gross = q × p`.

### Buy

- Native cash impact: `-(gross + f + tax)`.
- Native opening basis: `gross + f + tax`.
- Base opening basis: `(gross + f + tax) × fx`.
- Open lot quantity: `q`.

### Sell

- Native cash impact: `gross - f - tax`.
- Base net proceeds: `(gross - f - tax) × fx`.
- FIFO lots supply matched base basis.
- Base realised gain: `base net proceeds - matched base basis`.

### Cash deposit/withdrawal

- Deposit cash impact: `+amount`.
- Withdrawal cash impact: `-amount`.
- External-flow classification must be retained for later performance metrics.
- Currency conversion between cash accounts is two linked cash entries plus an explicit FX/conversion record; it is not a gain/loss trade in v1.

### Split

For ratio `a:b`, each open quantity is multiplied by `a / b` and per-unit basis is divided by that ratio; total basis is unchanged. Fractional cash-in-lieu requires an explicit sale/cash event. Split processing is idempotent by event and portfolio/security.

### Transfer (deferred)

Transfers preserve original acquisition dates/basis only when the source provides them. Otherwise mark basis incomplete. Transfer-in is not treated as investment performance; transfer-out removes quantity/lots according to documented lot selection without recognizing a sale gain unless a taxable disposal record says so.

## 4. FIFO lots and average cost display

### FIFO matching

For a posted sell:

1. Order open lots by acquisition timestamp, then opening transaction ID.
2. Consume the oldest lot until the sale quantity is matched.
3. Allocate that lot’s remaining basis pro rata to the matched quantity.
4. Allocate sale fees/taxes pro rata across matches using the reconciliation rounding rule.
5. Record each match.
6. Reject an unmatched remainder as an oversell in v1.

Manual posting, reversal, and supersession evaluate the same chronological buy/sell/split quantity invariant before mutation. Reads use fixed pages up to the declared ledger-event ceiling, and the D1 posting batch asserts that the security ledger count/version snapshot has not changed. A failed concurrency assertion is retried from fresh rows; if another sell consumed the quantity, the retry returns `oversell` and writes no transaction, cash entry, rebuild request, or audit success.

### Remaining cost basis

`remaining basis = Σ open lot remaining base basis`

### Display average cost

For positive holding quantity `Q`:

`average base cost per unit = remaining base basis / Q`

This is a display summary; FIFO lot identity remains authoritative.

For native average cost, show a single native value only when lots share a meaningful common transaction/security currency. Otherwise show base-currency average and explain the mixed-currency history.

### Example

Base currency AUD:

- Buy 10 units at AUD 20, fee AUD 10 → lot basis AUD 210.
- Buy 5 units at AUD 24, fee AUD 5 → lot basis AUD 125.
- Sell 12 units at AUD 30, fee AUD 6.

FIFO basis matched:

- first lot: AUD 210 for 10;
- second lot: `2/5 × 125 = AUD 50`;
- total matched basis: AUD 260.

Net proceeds: `12 × 30 − 6 = AUD 354`.

Realised gain: `354 − 260 = AUD 94`.

Remaining: 3 units with AUD 75 basis; average cost AUD 25.

## 5. Holding values

At valuation time `t`:

- `Q_t` = posted position quantity effective at cutoff;
- `P_t` = selected native unit price;
- `FX_t` = selected native-to-base FX.

### Native market value

`MV_native,t = Q_t × P_t`

### Base market value

`MV_base,t = Q_t × P_t × FX_t`

`MV_base` is the persisted/rebuilt home-currency reporting value. The native/home display toggle only selects which already attributable representation is shown.

If price or FX is unavailable, base market value is unavailable. The portfolio may show a partial known total with coverage; it never inserts zero.

### Open basis

`Basis_base,t = Σ remaining base basis of open lots`

### Unrealised gain

`UG_base,t = MV_base,t − Basis_base,t`

`UG% = UG_base,t / Basis_base,t × 100`

Percentage is unavailable if basis is missing or zero.

### Weight

`holding weight = known holding base market value / known invested market value`

If coverage is incomplete, label weights “of priced holdings”; do not imply full-portfolio allocation.

## 6. Daily movement

For a holding retained across the comparison boundary:

`Daily_base = Q_t × (P_t × FX_t − P_prev × FX_prev)`

Decomposition:

- local price contribution: `Q_t × (P_t − P_prev) × FX_prev`
- pure FX contribution: `Q_t × P_prev × (FX_t − FX_prev)`
- cross term: `Q_t × (P_t − P_prev) × (FX_t − FX_prev)`

The headline full movement uses the exact combined formula. If a decomposition is shown, add the cross term to the pure FX contribution by convention. The displayed FX contribution is therefore `Q_t × P_t × (FX_t − FX_prev)`, and local price contribution plus that displayed FX contribution reconciles exactly to the headline.

Quantity timing:

- use quantity held at the current valuation cutoff;
- trades effective between comparison closes are not called market movement; their cash/value effects are classified as flows and snapshot reconciliation;
- if trade timestamps cannot establish a correct boundary, daily movement for that holding is incomplete.

Holding daily percentage:

`Daily% = Daily_base / abs(Q_t × P_prev × FX_prev) × 100`

Unavailable when previous comparable value is zero/missing.

Portfolio daily movement is the sum of comparable security movements plus currency movement on cash accounts, excluding external deposits/withdrawals and trade flows. V1 may initially show only the security sum and a coverage label until cash-FX classification is complete.

Portfolio daily percentage is intentionally unavailable in v1. The holding-level
percentage above has a comparable holding denominator, but a portfolio-wide
denominator is not defined while trades, deposits, withdrawals, and cash-flow
classification can change the portfolio between comparison closes. The UI must
show the daily amount and `Percentage unavailable`; a portfolio percentage may
only be added when a calculation-layer comparable denominator and cash-flow
contract are promoted and tested.

## 7. Cash and portfolio totals

For each cash currency `c`:

`CashBalance_c,t = Σ posted cash entries effective by t`

`CashValue_base,c,t = CashBalance_c,t × FX(c→base,t)`

Portfolio totals:

- `InvestedValue = Σ available security MV_base`
- `CashValue = Σ available cash base values`
- `PortfolioValue = InvestedValue + CashValue`
- `CoveredOpenBasis = Σ open basis for exactly the same priced-and-converted positions included in InvestedValue`
- `UnrealisedGain = InvestedValue − CoveredOpenBasis`
- `RealisedGain = Σ posted realised lot allocation gains`
- once the deferred dividend workflow exists, `ActualIncome = Σ actual gross/net dividend receipt measure named by the UI`

Coverage accompanies each total:

- priced holdings / total non-zero holdings;
- converted holdings / priced holdings;
- converted cash accounts / total cash accounts;
- known and excluded values where knowable.

If any non-zero holding or cash account is excluded, the UI calls the result `Known value` or another explicit partial-total label. It never presents the sum as the complete portfolio value, and it never invents a dollar value for an excluded component whose price/FX is unknown.

The current-total contract is a discriminated result: `complete`/`portfolio_value`, `partial`/`known_value`, or `unavailable`/`value_unavailable`. Each holding input carries its exact quantity and each cash input carries its exact native balance. Coverage denominators and exclusions include only components whose quantity/balance is non-zero. Consequently, a zero position with no quote and a zero foreign-currency cash account with no FX do not make the total partial. Malformed quantity/balance inputs remain material and fail conservatively rather than hiding a gap. A portfolio with explicit components that are all exactly zero has a complete zero total; a portfolio with no components remains unavailable under the empty-portfolio contract.

A non-zero security contributes to both `InvestedValue` and `CoveredOpenBasis` only when its home market value and home basis are both available; value-only and basis-only positions are excluded from both aligned amounts and listed in coverage. Converted non-zero cash is tracked separately. Coverage reports total, non-zero, zero, and invalid component counts. Invalid or negative holding quantities and invalid cash balances remain excluded material gaps even if a caller supplies apparently available monetary fields. Because the status and label are produced from the same coverage computation, an incomplete result cannot serialize with the complete discriminator.

## 8. Historical values and snapshots

### Quantity series

Build end-of-local-day quantities by replaying posted ledger events in effective order, including explicit splits. Do not use today’s quantity for prior dates. Add transfer replay only when the deferred transfer contract is promoted.

### Daily holding value

`HoldingValue_s,d = Q_s,d × P_s,d × FX_s,d`

Use the security’s validity-dated exchange/MIC session evidence and the portfolio’s local snapshot cutoff. For each local date, map the cutoff instant to the latest exchange session whose recorded close instant is complete by that cutoff; an observation is eligible only when its recorded observation instant, converted through the portfolio’s IANA timezone (including DST), is on or before that local date’s end. This prevents a later foreign-market close from becoming look-ahead history. The selected price date, FX date, selected session identity/close, and calendar/session classification are recorded.

### Portfolio daily value

`PortfolioValue_d = Σ HoldingValue_s,d + Σ CashValue_c,d`

Only claim complete history where:

- ledger history is complete from/on `d`;
- all material quantities have basis where a basis metric is shown;
- market and FX coverage meet the declared threshold.

Otherwise store partial status and exclusions.

Historical points are published only from a completed calculation run. The run
replays a bounded local-date range and checkpoints the date and holding offset;
retrying a lease produces the same values and coverage for the same ledger
high-water, calculation version, and persisted market-data ingestion cutoff. A
chart request selects one completed version and never mixes dates from another
version or an unfinished rebuild. Same-version replacements stage under their
own run identity and switch the publication pointer only after completion.
The published run must reject a nominal `complete` point when required totals
are null, coverage has a gap or exclusion, or the ledger history boundary is
incomplete; partial points retain usable known values and identify exclusions.
Coverage distinguishes zero holdings/cash (which require no quote or FX) from
non-zero components excluded for missing or stale price/FX, incomplete basis,
or an incomplete ledger boundary. Stale selections remain explicit gaps even
when a fallback value is retained in the source facts. Compact chart points
carry date, values, completeness, exclusions, and coverage only; observation
timestamps and provider provenance remain detail/audit evidence rather than
routine chart labels.

### Snapshot invalidation

- Transaction change: invalidate from its local effective date.
- Split/corporate-action correction: invalidate from effective date.
- Security mapping historical correction: invalidate affected mapping interval.
- Price/FX correction: invalidate observations’ affected dates.
- Calculation-version change: create/rebuild a new version; do not mix versions in one chart.

### Chart gaps

Carry a prior market close only across known exchange holidays within the FX fallback window. If the calendar says a date was an expected trading session but no session quote exists, mark a missing-session gap rather than labelling it a holiday. If no exchange calendar is available, retain an unknown-calendar explanation. Do not interpolate missing prices. Break or mark the series when a required value exceeds staleness policy.

Trading-calendar evidence is captured as a bounded, versioned, canonical input
on the calculation run. It contains provenance, validity dates, exchange/MIC
identity, IANA timezone, and completed session IDs with open/close instants;
it is not a per-holding date list. Lease retries and replacement workers must
use that persisted evidence rather than process-local calendar state, so
holiday/session classification cannot change during a rebuild. A session that
is expected and complete by the cutoff but has no matching quote is a
`missing_session` gap; a date outside the evidence’s validity interval remains
`unknown`.

## 9. Financial-year windows and labels

Requirement FY-001. Single source of truth: `domain/calculations/financial-year.ts` (`currentFyWindow`, `lastFyWindow`, `fyLabel`). Every consumer (history chart periods, per-FY dividend views, and any future FY-scoped report) must derive its window from these functions rather than reimplementing FY date math.

### Configuration

- `user_settings.financial_year_start_month` (integer 1–12, day always the 1st) is the only configurable input. Default is 7 (July), the Australian financial year. It is per-user; there is no per-portfolio override.
- The same row's `user_settings.timezone` decides where the FY boundary falls everywhere the FY is used, including aggregate/portfolio-level views — not the portfolio's own timezone.

### Windows

- **FY** (current financial year) is FY-to-date, mirroring YTD: `startDate` is the 1st of the start month in the FY that contains today's local date, and `endDate` is today's local date. It is an open, growing window.
- **Last FY** is the prior FY, fully closed: `startDate` is the 1st of the start month one year before the current FY's start, and `endDate` is the local calendar date immediately before the current FY's `startDate`.
- Both `startDate` and `endDate` are local calendar-date strings (`YYYY-MM-DD`), never instants.

### Timezone rule

"Today" is resolved by converting the current instant to a local calendar date in the user's IANA timezone via the timezone database (e.g. `Intl.DateTimeFormat` with `timeZone`), the same technique `domain/snapshots/history.ts` uses for portfolio-local cutoffs. This is mandatory: naive UTC-date arithmetic or binary-float time math can shift the FY boundary by a day, especially near a DST transition or for a timezone on the opposite side of UTC from the server. A financial-year boundary instant belongs to whichever FY contains its local calendar date in the user's timezone, not the server's UTC date.

### Naming convention

An FY is named by its ending calendar year, per Australian convention: `FY` + the last two digits of the ending year. For a start month other than January, the ending year is the start year plus one (1 Jul 2025 – 30 Jun 2026 = "FY26"). A January start month produces plain calendar-year windows, so the ending year equals the start year itself (Jan–Dec 2026 = "FY26", not "FY25").

The label is derived from the window's `startDate` alone (its year and month fully determine the FY). It must not be derived from a FY-to-date window's `endDate`, which is today, not the FY's eventual close.

### Validation

An out-of-range start month (outside 1–12) or an unresolvable IANA timezone is rejected at the domain-function boundary with an explicit typed reason (`invalid_start_month`, `invalid_timezone`, `invalid_instant`) rather than silently coerced or defaulted.

### Chart consumption (FY-001C)

The overview history chart filters its published points against an already-resolved `FyWindow` rather than reimplementing the boundary comparison: **FY** keeps every point whose date is `>= startDate` (an open window, since `endDate` is "today" and is not itself necessarily a published point); **Last FY** keeps points with `startDate <= date <= endDate` (a closed window, bounded on both ends).

Because Last FY is closed, its displayed gain/loss delta must read as the change **across that window** — the filtered window's first point's value subtracted from its last point's value — never a change-to-today figure. A window with no points in range shows the chart's existing empty-range state; it must never render a fabricated `0.00`. A window with exactly one point is likewise "no change knowable," not a flat `0.00`: `windowChangeAmount` requires at least two points before it will compare anything. A genuinely flat window of two or more points, by contrast, is a known fact and does render `0.00` — styled neutrally, not as a positive/green movement.

**What resolves "today".** FY is an absolute named period (its label is a specific fiscal year, e.g. "FY27"), unlike the relative 1M/3M/12M cutoffs, which stay correct however they're anchored. So FY window resolution must anchor on the real current instant, not on the chart's own data: `loadAuthenticatedWorkspace` (`app/authenticated-workspace.ts`) resolves `new Date().toISOString()` exactly once per request, server-side, as `OwnedWorkspace.nowInstant`, and that is threaded down as a prop to the chart component. Two failure modes this rules out: anchoring on the latest published history point instead would silently mislabel the window whenever data is stale (a portfolio last published in FY26 would have its "current FY" tab wrongly read "FY26" even after the real calendar has moved into FY27, and "Last FY" would become unreachable); and anchoring on a bare local calendar date (`YYYY-MM-DD`, as a history point's `date` field is) rather than a real ISO instant is ambiguous under `localDateAt`'s UTC-midnight interpretation, shifting the resolved local date by a day for negative-offset timezones. The chart component itself must never call `new Date()`/`Date.now()` — doing so there would be non-deterministic across the server and client render (hydration risk) and would defeat the point of resolving "now" once, server-side, per request.

## 10. Realised, unrealised, and headline returns

The reference material does not conclusively define all-time return. The conservative v1 split is:

- Unrealised gain: current covered market value minus remaining open basis.
- Realised gain: net sale proceeds minus matched FIFO basis.
- Once supported, actual income: posted dividend/other income receipts, separately. The core release omits this result.
- Total investment gain (when shown): realised gain + unrealised gain, excluding actual income unless the label explicitly says “including income”.
- Estimated dividends never enter realised gain, cash, portfolio value, or headline return.

Headline percentage when complete:

`InvestmentGain% = (RealisedGain + UnrealisedGain) / relevant invested basis × 100`

Because a single denominator across disposed and open holdings is easy to misread, v1 should prefer separate realised/unrealised percentages and show the formula drill-down. A portfolio-wide return percentage remains staged until cash-flow classification is complete.

### TWR

Time-weighted return requires subperiod returns split at external flows:

`TWR = Π(1 + r_i) − 1`

Do not implement until complete daily valuations and external-flow classification exist.

### Money-weighted return / XIRR

XIRR solves:

`Σ CF_i / (1 + r)^((d_i − d_0)/365) = 0`

Do not implement until transfer/deposit/withdrawal semantics are explicit and a robust solver/date convention is tested. It must be labelled money-weighted, not “gain %”.

## 11. Dividends

`DB-005` (2026-08-13) added the underlying schema (`split_events`, `dividend_events`, `dividend_receipts`, and the DIV-001 owner dividend-history tables: `dividend_security_assumptions`, `dividend_portfolio_assumptions`, `dividend_fy_overrides`, `dividend_event_overrides`, `dividend_manual_records`). `MKT-005` (2026-08-13) implemented provider event ingestion and the TTM derivation below. `DIV-001` (2026-08-13) implemented the read-time-derived dividend history, aggregates, and 12-month forecast baseline documented in the "Derived dividend history" subsection below, which SUPERSEDES the "Actual receipt"/"Forecast hierarchy" subsections' original ledger-posting model for v1 (kept here for the historical record and because `dividend_receipts` remains the schema for a future actual-cash-posting capability). Nothing in this section posts cash to the ledger in v1.

### Actual receipt (deferred — superseded for v1 by "Derived dividend history" below)

At payment/posting:

- eligible quantity comes from the user/import fact or from ex-date holdings when explicitly inferred;
- `gross native = eligible quantity × event gross per share`;
- `net native = gross native − withholding − other taxes`;
- base amounts use payment-date FX selected under the transaction rule;
- actual net posts to cash;
- franking credits, if recorded, are informational tax attributes and not cash.

The system must not infer an actual receipt solely because a provider event exists.

### Forecast hierarchy (deferred — superseded for v1 by "12-month baseline forecast" below)

For future income:

1. Sum known, non-cancelled declared future events using current eligible quantity as an explicit no-future-trades estimate unless the ex-date has already passed and ledger quantity is known.
2. For uncovered periods, use a trailing-twelve-month gross-per-share rate only when at least two regular comparable payments exist.
3. Infer frequency only when payment spacing supports a stable cadence (annual, semiannual, quarterly, monthly) within tolerance.
4. If history is irregular or insufficient, show TTM income without extrapolating, or unavailable.

Forecast:

`EstimatedGross_native = expected quantity × estimated per-share amount`

`EstimatedGross_base = EstimatedGross_native × latest selected FX`

Latest FX use is acceptable only for forecast display and retains its as-of date in the explanation. Actual accounting uses payment-date FX.

Default withholding is a user assumption, not tax truth:

`EstimatedNet = EstimatedGross × (1 − assumed withholding rate)`

Show gross by default where country/account rules are unknown. Never imply tax advice.

### Yield labels

- Trailing cash yield: actual gross dividends over trailing 12 months divided by current covered market value.
- Forward estimated yield: forward estimated gross annual dividends divided by current covered market value.
- Yield on cost: actual/estimated annual amount divided by remaining basis, only when explicitly labelled.

No generic “yield” without a method label.

### Trailing twelve-month (TTM) derivation (MKT-005)

Implemented ahead of the rest of section 11 to feed `DIV-003`'s assumptions-grid "provider yield" column (`domain/market-data/dividend-yield.ts`; pure functions, decoupled from the repository layer — callers fetch a security's ingested `dividend_events` and a current price and pass them in):

- **Window:** trailing 365 calendar days ending at the caller-supplied `asOfDate`, inclusive of both ends.
- **Eligible events:** `kind = 'cash'` and `status IN ('declared', 'paid')` only. `'estimated'` rows are forecasts, not a trailing actual; `'cancelled'`/`'superseded'` rows are not current facts. (Caveat: the Yahoo-compatible provider classifies every dividend it reports as `kind = 'cash'` — it has no type distinction — so this filter does not currently exclude anything from that provider; see `docs/MARKET_DATA_STRATEGY.md`'s dividend/split capability section.)
- **Sum, never annualize:** the TTM per-share figure is the EXACT decimal sum of eligible events' `gross_per_share_decimal` within the window (`formatDecimalExact`, source precision retained, no display rounding). It is never multiplied up from a smaller sample to approximate a full year.
- **`insufficient_history`:** zero eligible events in the window is the stable typed reason returned instead of zero or a guess — this is the concrete implementation of this section's "if history is irregular or insufficient, show TTM income without extrapolating, or unavailable" rule for the automated provider-yield column specifically.
- **`mixed_currency`:** eligible events with more than one distinct `currencyCode` in the window is a separate stable typed reason (rather than silently summing across currencies).
- **Trailing yield:** TTM per-share ÷ a caller-supplied current price (native currency, same holding), expressed as a percentage. This module never fetches a price itself — a missing price is the caller's `price_unavailable` typed reason, and a price whose currency disagrees with the TTM sum's currency is `currency_mismatch`, never a silently wrong ratio.

### Derived dividend history (DIV-001)

`domain/dividends/**` (pure domain functions) composed by `app/owned-dividend-history.ts` (the owner-scoped read service). Dividend history is DERIVED AT READ TIME from provider events, owner facts, and ledger holdings — nothing here writes to `dividend_events`/`split_events` (MKT-005's job) and nothing posts cash (no `dividend` ledger transaction type exists). The service batches every input table ONCE per portfolio (events/overrides/manual records/receipts/assumptions/transactions, each a single bounded query grouped in memory) rather than once per security (follow-up fix, review round 2: five sequential per-security queries is pathological at the 500-security cap) — mirrors `app/owned-holdings.ts`'s batching pattern; the per-security derivation loop itself performs no I/O.

**Shares held at a date.** `deriveSharesHeldAtDate` sums signed `buy` (+)/`sell` (-) ledger transaction quantities with `local_trade_date <= asOfDate`, correctly excluding a reversed transaction and its reversal record (both contribute zero, enforced by two independent signals — `status <> 'posted'` exclusion AND the reversed-id set — for robustness against a hypothetical mismatch between them). A `split` transaction (Orchestrator ruling, review round 2, reversing this module's original "splits ignored" scope decision) multiplies the running total by `numerator / denominator` at the split's trade date — the identical semantics `domain/ledger/projections.ts`'s `updateNativeLots` and `db/repositories/ledger.ts`'s split-quantity validation use (`quantity_decimal` = numerator, `unit_price_decimal` = denominator). Transactions are processed in `trade_at` order (the precise instant, then `id` as a final tiebreak — follow-up fix, review round 3: ordering was originally keyed on `local_trade_date` alone, a calendar day, so a same-day buy-then-split and a same-day split-then-buy were indistinguishable and could apply in the wrong order via an arbitrary id fallback; `trade_at` is the same ordering key `domain/ledger/projections.ts`'s `activeSecurityEvents` uses), so a split before an ex-date correctly multiplies the shares already summed by that point, including same-day precision; a split after an ex-date has no effect on that ex-date's total. `asOfDate` filtering itself still uses the business-date `local_trade_date`, unchanged. A full exit (sell down to zero) correctly yields `"0"` for every later date, with no separate "no history" state; this is a known fact, not missing data.

**Per-event precedence (one row per provider event, exactly one source wins) — DIV-004, 2026-08-13, extending review round 2's ruling with the imported tier IMP-006 introduced:** override > manual (owner-typed) > receipt > imported > auto-derived.

1. **Owner override**, resolved via the `supersedes_event_id` lineage (`resolveEventOverrideForLineage`, consuming MKT-005's `collectEventLineageIds`) — BINDING per the MKT-005 review: an override stays keyed to whichever event version was active when the owner created it, so if the provider later corrects that event (new id, prior row moves to `superseded`), a naive "current active event only" lookup would silently lose the override. Walking the lineage backward from the current active event and checking every id it corrects for an override is the only correct resolution; a matching override wins the row (`source: "edited"`) even when the provider's corrected value differs. `exclude` removes the row from every total but the row is still returned (retrievable), never dropped from the list.
2. **Owner-typed manual record** (`dividend_manual_records` with `import_batch_id IS NULL` — entered directly through the manual-entry UI, never by the CSV importer), proximity-matched to the event GLOBALLY: every candidate `(event, manual record)` pair within `PROXIMITY_WINDOW_DAYS` (7) days is collected, then assigned nearest-distance-first across the WHOLE candidate set — not a per-event greedy pass in event-date order (review round 2 blocking finding B4: a per-event-greedy pass can mis-assign a manual record to a nearby-but-not-actually-closest event when two events compete for it, e.g. an interim and a special dividend a few days apart). Ties break deterministically: distance, then the event's own reference date, then event id, then manual-record id. Matching runs against EVERY active event, INCLUDING excluded ones (see the excluded-event note below), so a manual record duplicating an edited-but-not-excluded event is still correctly suppressed from becoming a spurious standalone row. If a receipt and/or an imported row ALSO exist for the event, both are consumed (no duplicate rows) but their values remain visible via the row's `dominatedReceipt`/`dominatedImported` fields — never silently dropped.
3. **Receipt**, resolved via the identical lineage walk (a receipt's required `dividend_event_id` FK has the same superseded-id survival problem as an override; resolved the same way for consistency, though not itself the MKT-005 review's literal binding clause). Multiple receipts attached to one lineage: the latest by payment date wins; the rest are not silently discarded — `additionalReceiptsCount` discloses how many were not individually shown. An imported row matched to the same event is consumed and shown via `dominatedImported`.
4. **Imported row** (`dividend_manual_records` with `import_batch_id` present — created by IMP-006's CSV import, never directly by the owner), proximity-matched to the event GLOBALLY using the identical mechanism as tier 2, run against the imported-only subset, and only winning the row when neither an owner-typed manual record nor a receipt claimed the same event. DIV-004 separated this from the owner-typed tier precisely so an imported row — evidence the owner never personally typed — can never outrank a receipt (actual payment evidence) or an owner-typed manual record for the same real dividend (the gap IMP-006's reviewer flagged: an imported row previously occupied the SAME tier as an owner-typed manual record).
5. **Auto-derived**: shares held at the event's ex-date × the event's `gross_per_share_decimal`. A null `gross_per_share_decimal` (only reachable via malformed/defensive input — the DB CHECK constraint requires it for a real `declared`/`paid` event) never fabricates a `"0"` amount (follow-up fix): the row's `dividendPerShareDecimal`/`cashDecimal`/`grossDecimal` are `null` and `amountUnknown` is `true` instead.

**Totals-based derivation for a BRK-005 imported fact (2026-08-15).** A CSV-imported row (IMP-006) always carries a real per-share amount, but a Sharesight-payout-imported row (BRK-005) never does — Sharesight payouts report only a TOTAL cash amount and total franking credits, never a share count. `dividend_manual_records` therefore has two mutually-exclusive shapes (`db/schema.ts`'s `dividend_manual_records_amount_mode_check`; see `docs/DATA_MODEL.md`): PER-SHARE (`shares_decimal`/`dividend_per_share_decimal` set) or TOTALS (`total_cash_decimal`/`total_franking_decimal` set, the other three columns `NULL`). Wherever the four-tier precedence above would otherwise multiply `shares × per-share` to get a row's cash/franking (tiers 1, 2, 4, and 5 — a totals-mode fact can only ever WIN as tier 4, since tiers 1/2/5 are structurally per-share-only), `computeCashGrossOrTotals` (`domain/dividends/history.ts`) instead branches: when the winning fact's `dividendPerShareDecimal` is non-null, behavior is BYTE-IDENTICAL to the pre-BRK-005 `computeCashGross` (verified by the unchanged DIV-001/004/005 test suites); when it is `null` and a `totalCashDecimal` is present, `cashDecimal = totalCashDecimal` and, when a `totalFrankingDecimal` is also present, `frankingTotalDecimal = totalFrankingDecimal` and `grossDecimal = cashDecimal + frankingTotalDecimal` directly — the total IS the fact, never derived by multiplying an unknown per-share figure by a stand-in share count (which would violate AGENTS.md's "never fabricated" rule). The row's `sharesDecimal`/`dividendPerShareDecimal` stay honestly `null` (rendered "Unknown" in the dividends tab) even though `cashDecimal` is known. `amountUnknown` is therefore redefined as `cashDecimal === null` rather than `dividendPerShareDecimal === null` (an exactly equivalent condition for every pre-BRK-005 row, since cash was always null whenever per-share was) — a totals-only row's known cash total still counts toward lifetime/per-FY sums, it is only the per-share/share-count figures that read as unknown.

**Open question, explicitly NOT resolved (review follow-up): is Sharesight's payout `amount` gross or net of withholding tax?** `totalCashDecimal` is populated directly from Sharesight's `amount` field (`domain/sharesight-sync/transform.ts`). Sharesight payouts also separately report `resident_withholding_tax`/`non_resident_withholding_tax` fields (live-confirmed present, shape-validated — see `docs/ARCHITECTURE.md` §8.2's BRK-008 payout evidence), but no live evidence or third-party documentation this repo has seen states whether `amount` is BEFORE or AFTER that withholding deduction. Applying withholding arithmetic in either direction on an unconfirmed assumption would risk silently misstating a real cash figure, so this derivation deliberately does NOT attempt it: `amount` is staged and derived from verbatim, the withholding fields are not currently surfaced to the staged row at all, and this ambiguity is a standing input to any future `DIV`-feed decision that consumes Sharesight payouts more deeply (e.g. a task that wants to reconcile net cash actually received against gross declared income would need to resolve this first, with real evidence, not a guess).

**Foreign-currency payout conversion (BRK-010, 2026-08-19; review round 2026-08-19 correction, findings B1/B4/F2/F3).** A security can legitimately trade in one currency and pay a dividend in another (the owner-reported RMD case: ASX-listed, AUD trades, USD dividends).

**B1, rate direction, LIVE-CONFIRMED.** Sharesight's raw payout `exchange_rate` is NOT the multiply-payout-to-portfolio-base factor its column name might suggest -- a narrow, read-only live spike (`scripts/sharesight-fx-rate-spike.mjs`) against the owner's real AUD-base portfolio observed USD-payout `exchange_rate` values of 0.649526387-0.7220216606 across ten items (2024-03-14 through 2026-06-18) -- squarely in the empirically-expected AUD/USD 0.60-0.72 band, not the reciprocal ~1.4-1.7 band the naive reading would require. `domain/sharesight-sync/transform.ts`'s `invertToPortfolioConversionRate` corrects this ONCE, at the transform boundary (exact decimal reciprocal, half-even rounded to 24 places) -- `NormalizedImportRow.exchangeRateDecimal` and `dividend_manual_records.fx_rate_to_portfolio_decimal` are ALWAYS already in the multiply-to-portfolio-base convention by the time any other layer reads them. See `domain/sharesight/contracts.ts`'s `SharesightPayout.exchangeRateDecimal` doc comment for the full evidence.

**B4, conversion target, BINDING CORRECTION.** The stored rate converts record-currency -> PORTFOLIO BASE only. `domain/dividends/history.ts`'s `resolveImportedRecordCurrency` therefore applies it ONLY when the security's own currency equals the portfolio's base currency (`securityCurrencyCode === portfolioBaseCurrencyCode`, both threaded into `DeriveDividendHistoryInput`) -- three cases, keyed on the record's own currency (P), the security's currency (S), and the portfolio base (B):

- **P == S** (native): no conversion, never blocks, regardless of B -- a USD-denominated security paying a USD dividend inside an AUD-base portfolio commits and reads exactly like any other native dividend.
- **P != S and S == B** (achievable): converted via `totalCashDecimal`/`totalFrankingDecimal` multiplied by the fact's own stored `fxRateToPortfolioDecimal`, rounded half-even to 24 decimal places (the same `franking.ts` `DEFAULT_TIER_SCALE` intermediate-scale convention above) then trimmed exact; a rate is REQUIRED here (fails closed without one, both at staging and at commit).
- **P != S and S != B** (not achievable): Sharesight's rate only ever converts P into B, which is not S -- there is no rate this codebase could ever be given that makes this conversion valid, so a missing rate is NEVER a block reason in this case. The record's totals/currency stay COMPLETELY UNCONVERTED and the row's own `currencyCode` displays the record's TRUE currency (never silently defaulted to the security's) -- DIV-001's pre-existing `mixed_currency` aggregation degradation (see the Mixed-currency disclosure note below) then applies honestly instead of a silent mislabel.

This keeps this module's existing per-security single-currency invariant intact for the achievable case, and degrades honestly for the non-achievable one, without any downstream matching/aggregation code needing special-casing beyond the one conversion call site. **F2**: provenance (`DerivedDividendRow.originalCurrencyCode`/`fxRateToPortfolioDecimal`/`fxRateSource`, and the equivalent `DominatedImported` fields) is populated ONLY when a conversion actually occurred (case "achievable" above) -- a degraded fact instead surfaces via the row's own overridden `currencyCode`, never both at once. **UI-014 (2026-08-19):** this provenance is now rendered -- the per-security Dividends tab (`app/components/security-dividends-tab.tsx`) shows a compact "converted from `<originalCurrencyCode>` @ `<rate, display-trimmed>` (`<fxRateSource>`)" line beneath a converted row's Cash figure, text not colour; the ORIGINAL (pre-conversion) amount itself is not threaded onto `DerivedDividendRow` (only the converted total survives -- `resolveImportedRecordCurrency` overwrites `totalCashDecimal` in place), so this renders currency/rate/source only, never a back-derived amount. The rate display trims the stored 24dp value to 6dp (half-even, trailing zeros dropped, `app/dividend-history-prefill.ts`'s `formatFxRate`) for READABILITY ONLY -- the stored, full-precision value is what every calculation above still uses. **F3**: a stored FX rate over 24 decimal places is rejected at write time (`db/repositories/dividends.ts`); the read-time multiply/round arithmetic is wrapped in try/catch so one malformed/over-precision rate degrades only that record's totals, never aborts the whole security's dividend history load. At import-commit time (`db/repositories/import-commit.ts`), a payout foreign to its own security with no rate, where conversion IS achievable (case "achievable" above), never reaches `dividend_manual_records` -- it stages with a blocking, IMP-008-excludable `SHARESIGHT_PAYOUT_FX_RATE_MISSING` issue instead (`domain/sharesight-sync/transform.ts`, using a best-effort same-fetch-trade-evidence proxy for the security's currency pre-resolution, gated on the SAME achievability condition -- never blocking case C); commit re-checks the identical condition with the REAL, DB-resolved security currency. See `docs/DATA_MODEL.md`'s `dividend_manual_records` entry for the schema.

**Franking on a foreign-currency payout -- BRK-011 resolution cascade (owner ruling, 2026-08-19; evidence step and implementation, 2026-08-21).** Franking credits are an Australian tax construct. Whether Sharesight denominates a FOREIGN payout's franking fields (`franking_credits`, etc.) in AUD or in the payout's own currency was genuinely UNVERIFIED at BRK-010 time (this codebase will not resolve it by inspecting the owner's real tax amounts -- AGENTS.md's secrets/tax-data discipline forbids printing them to find out). The owner's BINDING cascade, in priority order, plus what a live-evidence spike (`scripts/sharesight-franking-fx-spike.mjs`, see `docs/ARCHITECTURE.md` §8.2's 2026-08-21 entry for the full evidence transcript) established about each tier:

1. **Sharesight-supplied AUD franking.** UNCONFIRMED (review-corrected 2026-08-21 -- an earlier draft of this section overclaimed this as "conclusively unavailable"; the honest state is bounded, not proven). The owner's data contains no franked FOREIGN payout, so whether Sharesight would ever populate a tier-1-shaped field on one is genuinely untested. What WAS checked live on 2026-08-21, through the sealed client (`scripts/sharesight-franking-fx-spike.mjs`): the documented `payouts.tax_credit` field (third-party `markcatley/sharesight.rs` docs, "always returned in the portfolio currency") was absent from all 10 of the owner's foreign (USD) payouts -- but those are all UNFRANKED, so an absent field there proves nothing about a franked one. The spike therefore ALSO checked `tax_credit` directly against all 61 of the owner's franked NATIVE (AUD) payouts (DIV-007's established franked/unfranked split) and found it present on ZERO of them either. This is real evidence the field does not populate on this account's wire at all, regardless of currency or franking status -- but the specific foreign-AND-franked combination remains untested, so this stops short of proof and no code path is added for this tier (would be speculative on unconfirmed evidence).
2. **Automatic payment-date FX conversion**, reusing BRK-010's stored `exchange_rate` (the architectural collapse this task's own instructions anticipated, IF evidence showed franking shares the payout's own currency denomination). Genuinely INCONCLUSIVE: the owner's real data contains zero franked foreign payouts to test the denomination question against. Per the owner's own instruction ("the evidence step may be INCONCLUSIVE — record that honestly and fall through"), this tier is NOT implemented -- an automatic conversion without confirmed denomination would itself be exactly the kind of unverified-currency assumption BRK-010's guard exists to prevent.
3. **Owner-entered manual conversion -- IMPLEMENTED.** `dividend_import_franking_overrides` (see `docs/DATA_MODEL.md`) is a sparse, one-row-per-imported-record overlay, never a mutation of the immutable `dividend_manual_records` fact it targets. `domain/dividends/history.ts`'s `applyFrankingCurrencyOverride` runs FIRST in the imported-tier pipeline -- before the unverified-nonzero-foreign guard below and DIV-007's absent-value inference -- so an owner's deliberate figure always wins and is never re-nulled/re-derived. Provenance surfaces via `DerivedDividendRow.frankingCurrencySource: "owner_manual" | null` (and the equivalent `DominatedImported` field), rendered distinctly from a Sharesight-reported figure ("… total (owner-entered)"). The owner enters the figure already converted into whatever currency the row itself displays (`DerivedDividendRow.currencyCode` -- the security's own currency when BRK-010 achieved conversion, or the payout's TRUE original currency in the degraded/unconverted case C above), using the exchange rate AT the payment date (instruction copy on the entry form names both that currency and that date explicitly) -- this codebase never computes, looks up, or fabricates that rate itself.

The pre-existing unverified-nonzero-foreign GUARD (still active for every row with no override): (a) a foreign-to-its-security payout whose franking total is an EXPLICIT ZERO is completely unaffected, no special handling, no warning -- a trusted reported figure like any other; (a2) an ABSENT franking field on a foreign-to-its-security payout is handled by DIV-007 below, not by this rule; (b) a foreign-to-its-security payout whose franking total is NONZERO and has no owner override is NEVER converted and NEVER trusted as-stored -- `domain/dividends/history.ts`'s `resolveImportedRecordCurrency` marks that record's `totalFrankingDecimal` UNKNOWN (`null`, using this module's existing unknown-franking handling -- never a fabricated or silently-converted figure) independently of whether the CASH figure itself is achievable (case B) or degrades (case C); `domain/sharesight-sync/transform.ts` separately stages a visible, non-blocking WARNING (`SHARESIGHT_PAYOUT_FRANKING_CURRENCY_UNVERIFIED`) naming the unverified-currency reason, so the owner can see why that row's franking reads "Unknown" (and can resolve it via tier 3's entry point) without the batch ever being blocked from readiness over it. The CASH amount itself is completely unaffected by this rule either way. DIV-007's absent-field inference below runs BEFORE this guard would ever null a value (it only ever nulls a genuinely NONZERO, present figure), so the two never conflict: an absent field is never "nonzero", and this guard's null result is never mistaken for DIV-007's derived $0 (`frankingDerivedZero` distinguishes them at the row level). A row that stays unresolved by every tier (no override, guard-nulled or cash-conversion-failed) renders "Unknown", never zero.

**DIV-007 -- absent Sharesight franking derives to a known $0 (owner ruling, 2026-08-20, "zero if zero"), INFERENCE per AGENTS.md.** Investigation of the owner's real local-DB data found Sharesight sends an EXPLICIT `franking_credits: 0` for unfranked AUD (native-currency) payouts (48 confirmed) and positive values for franked ones (60), but OMITS the franking field entirely -- stored `total_franking_decimal: NULL` -- on every one of the owner's 10 USD (foreign-currency) payouts; before this task those 10 rows rendered "Unavailable" in the all-dividends list and "Unknown" in the per-security tab even though cash converted and displayed correctly. The stored fact is NEVER rewritten (`dividend_manual_records.total_franking_decimal` stays exactly what Sharesight sent -- "null = Sharesight said nothing", AGENTS.md's ledger-immutability rule applied to imported facts); only the DERIVED row changes: `domain/dividends/history.ts`'s `deriveAbsentImportedFranking` treats a genuinely ABSENT `totalFrankingDecimal` on an imported (`import_batch_id`-attributed) TOTALS-MODE fact (BRK-005; the only tier that can ever carry a totals-mode fact) as $0 franking REPORTED, INFERRED from Sharesight's own demonstrated explicit-zero behaviour on native payouts above -- this is an inference from observed provider behaviour, not an observed tax fact or Sharesight documentation, and is marked as such via `DerivedDividendRow.frankingDerivedZero`/`DominatedImported.frankingDerivedZero` (`true` only for this derived case, `false` for a genuine Sharesight-supplied explicit zero or any non-imported source) so the UI can render "none reported" rather than implying Sharesight itself confirmed an unfranked payout. Scope: applies REGARDLESS of the row's currency (both achievable-conversion and degraded-unconverted foreign rows qualify, as long as the CASH figure itself is known -- a record whose currency conversion failed closed stays fully unknown, no lone derived franking figure beside an unavailable cash amount); owner-typed manual records (`import_batch_id IS NULL`) are structurally excluded (this function only ever runs over the imported-tier subset) and keep the pre-existing "unknown" semantics for a null franking value -- the owner may simply not have entered it, a different fact than "Sharesight sent nothing". Once derived, the $0 is a KNOWN value throughout: `computeLifetimeDividendTotals`/`computeFyDividendTotals` (both keyed on `frankingTotalDecimal !== null`) count it in the known-franking sum and exclude it from `receivedFrankingUnknownCount`/`frankingUnknownCount`, and `grossDecimal = cashDecimal + 0` with `grossIncludesFranking: true`, matching a real reported zero exactly.

An owner-typed manual record or receipt left unmatched after every event is processed becomes its own standalone row (no `dividend_event_id`) — the "covers securities/events the provider misses" case. DIV-004 cross-tier rule: an imported row similarly left unmatched by any event does NOT automatically become its own standalone row — it is first proximity-matched (same window, same global nearest-wins assignment) directly against every standalone owner-typed manual record and standalone/orphan receipt for the security (there is no common event to anchor the comparison to in this case), collapsing into whichever one it is nearest to within the window (owner wins, the imported row's values kept via `dominatedImported`). Only an imported row matching neither an event nor a standalone owner fact becomes its own standalone `source: "imported"` row. A receipt that no ACTIVE event's lineage claims at all (its event is cancelled, missing an ex-date, or otherwise never reached the usable event set) resurfaces the same way, as its own standalone row built from the receipt's own dates (follow-up fix: a receipt attached to a cancelled/null-ex-date event must not silently vanish — the reviewer's cancelled-reissue note: no current provider ever writes `status = 'cancelled'`, so this path is exercised today only by defensive input or a future provider capability, documented as intentional ahead of time). A receipt dominated by a non-excluded override remains intentionally not shown (the owner's edit supersedes it).

**Excluded events (review round 3, fixing a blocking double-count review round 2's B3 fix introduced; DIV-004 extended it to the imported tier).** An excluded event (`exclude: true`) is removed from EVERY total, but an owner-typed manual record, a receipt, and/or an imported row attached to that SAME excluded event must not each produce their own row — round 2's independent "manual falls through to the fully-standalone loop" and "receipt resurfaces directly" paths did not dedupe against each other, so an excluded event with both a receipt and a manual record for the same real dividend produced TWO rows (reviewer repro: excluded event, receipt $500, manual $500 → reported $1000 received instead of $500). The fix runs the identical four-tier precedence (tiers 2–4 above) ONCE per excluded event as a separate resurfacing pass, collapsing any combination of an attached manual record, receipt, and/or imported row into exactly one non-excluded row (owner-typed manual wins when present, then receipt, then imported; whichever lower tiers are also attached surface via `dominatedReceipt`/`dominatedImported`) — never zero, and never more than one, regardless of how many facts point at that excluded event.

**Transitive proximity chaining (DIV-005, 2026-08-14, promoted ahead of Sharesight payout ingestion).** The proximity matching above only ever compared a fact against an EVENT's own reference date. Tiers 2–4 could therefore miss a genuinely-the-same dividend split across three records: an event, an owner-typed manual record within the EVENT's window (so it attaches as that event's winning tier), and an imported row within the MANUAL RECORD's own window but outside the event's (reviewer repro: event pay 2024-03-20, owner manual 2024-03-27 — 7 days from the event, attaches — imported 2024-03-31 — 11 days from the event, outside; 4 days from the manual, inside — produced TWO rows, $240 counted instead of the real $120). Fixed in two rounds, both reusing the established `PROXIMITY_WINDOW_DAYS` (7) window and the identical global nearest-wins, one-to-one matching algorithm tiers 2/4 already use (so the fix inherits the same determinism and cannot itself introduce a new ambiguous assignment):

- **Round A (event-anchored, single hop).** Every event whose row is won by a manual or receipt fact (tier 2 or 3, including an excluded event's resurfaced row) becomes a "chain anchor" dated at the WINNING fact's own payment date instead of the event's — UNLESS that event already has its own DIRECT imported match (tier 4, `importedEventMatches`, whether it won the row or was itself dominated by the manual/receipt winner): a direct match already occupies the row's single `dominatedImported` slot, so the event is excluded from the anchor pool entirely rather than silently discarding a second, more distant imported row that has nowhere left to attach (review round 1 BLOCKING fix B1 — the original version let a second imported row get "matched" by Round A's algorithm and then dropped by the already-taken-slot guard, deleting real money with zero disclosure; excluding such events restores the pre-DIV-005 behaviour for that leftover row — it falls through to Round B/standalone exactly as it always did). Leftover imported rows not already matched directly to any event compete for the remaining anchors via the same nearest-wins, 1-1 algorithm. Because assignment stays 1-1 and anchors never compete with or connect to each other, an imported row can win at most one anchor and two events can never be pulled into one row this way (CRITICAL nuance, verified by fixture: an imported row equidistant-ish between two distinct events' own anchors — an interim and a special dividend days apart, each with its own manual record — attaches only to the nearer anchor; the two events' rows stay separate). An event fully suppressed by a winning NON-excluded override is never a chain anchor either — its consumed manual/imported facts stay hidden, exactly as before DIV-005.
- **Round B (eventless, fully transitive).** Owner-typed manual records, orphan receipts, and imported rows left over after Round A (never attached to any event nor any chain anchor) are clustered by union-find over proximity edges — manual↔imported and receipt↔imported, each tested against the OTHER fact's own payment date. `imported`↔`imported` edges are deliberately excluded (cross-batch import dedupe is IMP-004B's job at CSV-preview time, not this module's derivation-time job) and so are `manual`↔`receipt` edges (no pairing ever compared those two directly; they still collapse together when bridged by a shared imported record, exactly like the base repro). Since chain anchors are never members of this pool, an eventless cluster can never contain more than one event's evidence by construction — nothing here to over-merge. A cluster with AT MOST ONE manual and AT MOST ONE receipt (any number of imported records) collapses to exactly ONE row using the tier precedence (manual > receipt > imported) with the extra imported records folded in via `additionalImportedCount`, exactly like the base repro — a chain spanning MORE than one window end-to-end (fact → fact → fact, each adjacent pair within window but the two ends farther apart) still collapses fully rather than capping at two hops, the honest reading of "the same dividend recorded multiple ways". A cluster with TWO OR MORE facts of the SAME owner-typed tier (two-plus manuals, or two-plus orphan receipts — reachable only because each is independently within window of a shared imported bridge, never because they are within window of EACH OTHER) does NOT collapse those facts together (review round 1 BLOCKING fix B2 — collapsing them silently erased one owner's assertion with zero disclosure): it instead falls back to the DIV-004 1-1 nearest-wins assignment SCOPED TO THAT CLUSTER — every owner fact keeps its own row, and only the cluster's imported records are distributed among them by proximity (an imported row left unmatched even within this local assignment becomes its own standalone row). `additionalReceiptsCount`/`additionalImportedCount` on a collapsed row disclose only genuinely-the-same-dividend extras within the SAME tier as the row's own imported/receipt evidence (multiple receipts on one lineage, multiple imported hops in one chain) — never a different owner-typed fact folded away.

Determinism (both rounds): cluster/anchor membership depends only on the pairwise distance test between every candidate pair, never on input array order.

Every overridden row also surfaces the provider's own, unedited `providerGrossPerShareDecimal` (follow-up fix, feeds UI-006C's "detail shows both values" requirement) regardless of which value won the row.

A `dividend_events.status = 'paid'` row is NEVER treated as receipt evidence (MKT-005 review, binding): this provider supplies no payment evidence and `paid` is a pure ex-date-passage lifecycle column that can lag the real calendar date between ingestion sweeps. Every derived row instead carries its own `status: "ex_date_passed" | "declared_pending"`, computed independently from the event's `ex_date` vs "today" (every row reaching this computation is guaranteed a non-null `ex_date` by the active-event filter, so there is no provider-status fallback branch to keep unambiguous — review round 2 follow-up, removing dead code that obscured this). Actual receipt evidence is a separate `source` value (`"receipt"`/`"manual"`/`"imported"`), never conflated with lifecycle status. `"ex_date_passed"` rows count toward lifetime-received totals; `"declared_pending"` rows are reported as a separate pending line and are excluded from lifetime-received (owner decision, 2026-08-13).

**Franking resolution chain** (`resolveFrankingPerShare`): per-dividend known value (override/receipt/manual's own `franking_credit_per_share_decimal`, a dollar per-share credit figure — used as-is, no conversion) → the security's assumptions-grid "franking if not known" default (`franking_percent_decimal`) → unknown (excluded from franking totals, flagged via an unknown-count, never a silent zero).

**Default-tier formula (Orchestrator ruling, 2026-08-13, correcting this section's original draft).** The assumptions-grid "franking %" is the Australian FRANKED PROPORTION of the dividend (0 = unfranked, 100 = fully franked) — not a literal dollar-scaling factor. Grossing a franked proportion up into the actual dollar franking credit uses the standard ATO formula:

`creditPerShare = dividendPerShare × (frankingPercent ÷ 100) × (companyTaxRate ÷ (1 − companyTaxRate))`

with `companyTaxRate` a named, documented constant, `AU_COMPANY_TAX_RATE = "0.30"` (`domain/dividends/franking.ts`) — the standard Australian corporate tax rate. A fully franked (100%) dividend therefore yields a credit of `dividend × 0.30 ÷ 0.70 = dividend × 3/7 ≈ 42.857%` of the cash dividend, matching the owner-approved dividend-tab wireframe's "franking if not known: 42.86%" figure for a fully-franked default. This is arithmetic from a stated, named assumption (the constant is documented and exported, not hidden), not tax advice. **Base-rate entities (25% company tax rate) are not modelled in v1** — every security uses the same 30% constant regardless of its actual size/turnover; `AU_COMPANY_TAX_RATE` is a candidate for a future per-security or per-portfolio setting if that distinction becomes material. `computeDefaultFrankingCredit` is the shared, linear implementation (usable against either a per-share amount or a total cash amount) so the forecast's uncovered-tail estimate (below) uses the identical formula rather than a divergent one.

**Rounding rule:** the formula's combined ratio has no fixed terminating decimal scale, so `computeDefaultFrankingCredit` performs every multiplication exactly (dividend amount × frankingPercent × taxRate for the numerator; 100 × (1 − taxRate) for the denominator) and divides ONCE, at the end, rounding that single result to 24 decimal places using this codebase's only rounding mode (half-even, `roundDecimal`) — the same `DECIMAL_LIMITS.allocationScale`-matching intermediate scale `domain/ledger/projections.ts` uses elsewhere for financial math with no natural terminating scale. Doing the division once, last, avoids compounding rounding error across multiple intermediate roundings.

Gross = cash + franking only when franking is known; an unknown-franking row's gross equals its cash with `grossIncludesFranking: false` disclosing the omission.

**Lifetime totals** (`computeLifetimeDividendTotals`): cash and gross received (ex-date-passed, non-excluded, known-amount rows only), franking known-sum plus an unknown-count flag, and a separate declared-pending (pending) cash/gross/count bucket. Excluded rows are counted (`excludedCount`) but contribute to no sum; unknown-amount rows the same way via `unknownAmountCount` (follow-up fix).

**Per-FY totals** (`computeFyDividendTotals`, FY-001A windows/labels via a new `fyWindowForDate` helper — the FY window containing an arbitrary historical date, since `financial-year.ts` only exposes the current/last FY relative to "now"). Attribution uses each row's best-available date — `paymentDate` when known, else `exDate` (this provider never supplies a payment date on the raw event, see `domain/market-data/yahoo-compatible.ts`).

**B2 fix (review round 2, blocking):** the original per-year resolution picked ONE tier for the whole year — if any row in a year had a known payment date, every OTHER row in that same year (auto-derived, ex-date-only) was silently dropped from the total (reviewer repro: 4 events in one FY, one receipt → reported total 500 instead of the true 2000). The corrected algorithm AGGREGATES EVERY non-excluded, known-amount row attributed to a year, regardless of whether its date came from a real payment date or the ex-date fallback — no row is ever excluded from the sum on account of some other row in the same year having better date evidence. The year's `source` label instead reflects the ROW COMPOSITION of what got summed:

- `"actual"` — every contributing row has a real payment date.
- `"provider_estimate"` — none do (pure ex-date fallback).
- `"partially_estimated"` — a mix of both.
- `"fy_override"` — an owner `dividend_fy_overrides` correction REPLACES the whole year's total outright, still the highest precedence tier, unchanged by the B2 fix.

A year with no override and no dated/estimable rows at all is simply not returned — no fabricated zero for a year with no evidence.

**B6 fix (review round 2, blocking):** the FY-override tier previously emitted the raw `grossed_amount_decimal` directly as `cashDecimal`, but "grossed" means cash+franking combined — a consumer computing `cash + franking` to get gross would double-count the franking portion for that one tier while every other tier's `cashDecimal` is already net of franking. `cashDecimal` for the override tier is now normalized to `grossed − franking` (falling back to the raw grossed figure only when franking is itself unknown, since there is nothing to subtract), so `cashDecimal`/`frankingKnownDecimal` mean the same thing in every tier uniformly.

**Mixed-currency disclosure (follow-up fix):** both `computeLifetimeDividendTotals` and `computeFyDividendTotals` verify every non-excluded row shares one currency before summing anything. A mismatch (e.g. a provider correction that disagrees on currency, or an owner-typed manual/receipt record in the wrong currency) returns an explicit `status: "mixed_currency"` (lifetime) or `{ ok: false, reason: "mixed_currency" }` (per-FY) instead of silently blending amounts under one currency label. At the service layer, `app/owned-dividend-history.ts` DEGRADES PER SECURITY rather than failing the whole portfolio load (follow-up fix, review round 3: an earlier version re-threw any `computeFyDividendTotals` failure, so one security's currency-mismatched data took down every other security's totals too) — the affected security's `fyTotals` becomes an empty list with `fyTotalsStatus` set to the failure reason, while every other security in the portfolio still loads normally.

**Scope boundary:** every total (lifetime and per-FY) is computed **per security, in that security's own native currency** — there is no FX-converted, blended portfolio-level total in this task. `dividend_fy_overrides` is a portfolio-scoped, portfolio-BASE-CURRENCY correction; honestly reconciling it against a specific security's native-currency total would require FX-converting every security's dividend cash first (payment-date FX for dated rows, latest FX for estimates, mirroring `app/owned-holdings.ts`'s existing FX-selection pattern for holding values). `app/owned-dividend-history.ts` therefore computes each security's `fyTotals` with no override applied and separately returns the portfolio's raw, unconverted `dividend_fy_overrides` list; reconciling the two into one FX-aware portfolio total is left to a consuming task (UI-006A, which already needs multi-security, FX-aware aggregation for its landing screen).

### Manual entry and overrides (UI-006B)

The assumptions-editor's per-share record/override form (`app/dividend-assumptions-actions.ts`'s `saveDividendEntryAction`) decides its persistence target purely on whether the save carries a `dividendEventId`: **no linked provider event** (the owner is recording a dividend the provider never surfaced) writes to `dividend_manual_records` — the owner-typed tier (`import_batch_id IS NULL`) already documented in "Per-event precedence" above; **a linked provider event** (the owner is overriding an auto-derived or previously-edited row) writes the sparse, tri-state `dividend_event_overrides` fields instead, including the "Exclude this dividend" flag. Editing an _existing_ owner-typed manual record reuses the same `dividend_manual_records` row (an update, keyed by its id); "Exclude this dividend" for that non-event-linked tier has no separate flag to set — since the record's own existence is what created the row, exclusion is a delete. Shares held at the entered payment date are auto-populated server-side via DIV-001's `deriveSharesHeldAtDate` (`app/dividend-assumptions-actions.ts`'s `sharesAtDateAction`, scoped through the owned holding) and remain editable, matching the second-round wireframe revision. A save also runs DIV-004's `PROXIMITY_WINDOW_DAYS` (7-day) near-duplicate check against the security's existing owner-typed manual records and receipts — a disclosed, non-blocking warning, never a rejection, mirroring the identical check IMP-006's CSV preview already performs at `DIVIDEND_NEAR_EXISTING_ENTRY`.

**Imported-row immutability (B1, review fix):** an IMPORTED `dividend_manual_records` row (`import_batch_id IS NOT NULL`, created by IMP-006's CSV commit) is never editable or deletable through this owner-facing form. Its facts change only by reversing the import batch that created it — editing or deleting it directly here would both break IMP-006's reversal accounting (the batch's own row-count/effects bookkeeping would no longer match what is actually in the table) and blend an owner-typed correction into a row still labelled and displayed as the imported tier, misattributing its provenance. Enforced twice: `saveDividendEntryAction`'s manual-record-update branch and `deleteDividendManualRecordAction` both fetch the target row first and reject with an explicit 409 ("Imported rows can only be changed by reversing the import batch that created them") before calling the repository; `dividend_manual_records.update()`/`.remove()` additionally guard their `UPDATE`/`DELETE ... WHERE` (and the paired audit-insert's guard predicate) with `AND import_batch_id IS NULL`, so even a caller that skips the action-layer check can never mutate an imported row's stored facts.

**Percentage-boundary validation (`app/dividend-form-validation.ts`):** franking is the Australian franked _proportion_ (0-100, "100 = fully franked" pinned directly in the field label/placeholder per QA-001B's unit-ambiguity requirement) and is rejected outside `[0, 100]`; dividend yield % must be non-negative but is only sanity-capped (`[0, 1000]`) rather than tightly bounded, since a real yield has no fixed ceiling; dividend growth % (both per-security and portfolio-level) may be negative (a shrinking payout or an expected decline) and is bounded to `[-100, 1000]`. This mirrors `db/repositories/dividends.ts`'s own repository-layer split (non-negative for yield/franking, signed for growth) with tighter, user-facing range checks at the request boundary.

**Whole-grid save is NOT atomic (B5, review fix).** `saveDividendAssumptionsGridWithContext` saves each security row and then the portfolio-level row as a SEQUENCE of independent, version-guarded repository calls — DB-005 has no cross-entity atomic batch spanning `dividend_security_assumptions` rows for different securities plus `dividend_portfolio_assumptions` in one transaction, so a save is not all-or-nothing the way a single ledger posting is. A failure partway through (a stale version, a since-removed holding, an invalid value on one row) stops the sequence immediately: every row already committed before the failure stays committed, and every row from the failure point onward — including the whole-portfolio row, which always saves last — is never attempted. The response discloses this exactly rather than collapsing it into one opaque error: `appliedSecurities` lists every row that already committed (with its fresh version, so the client can resync those specific rows without re-submitting them as stale) and `failedPortfolioSecurityId` names the row that failed. The assumptions-editor UI states this plainly (which securities saved, which one conflicted, and that the portfolio row did not save) rather than a generic "save failed" message.

### Per-security dividend history tab (UI-006C)

Introduces no new DERIVATION rule -- `app/owned-security-dividends.ts` composes DIV-001's already-derived per-security rows (`loadOwnedDividendHistory`, unchanged) for exactly one holding, plus the raw persisted override/manual-record facts (with their `version`s) the per-row click-to-edit dialog needs to pre-fill an UPDATE rather than mistakenly attempting a CREATE. It DOES apply one presentation-layer filter to the LIFETIME TOTALS, documented below. Composition points worth recording:

- **Two-key override resolution (review round 2, blocking B1).** The tab's `overridesByEventId` map is keyed by each row's CURRENT active `dividend_event_id`, resolved via `resolveEventOverrideForLineage` walking the `supersedes_event_id` chain backward -- required because a corporate-action refresh that corrects an amount mints a NEW active event id, and a naive lookup by that new id against an override still stored under the OLD (now-superseded) id would miss it. Critically, a SAVE must NOT reuse that map key as the request's `dividendEventId`: `domain/dividends/event-override-resolution.ts`'s BINDING note is that an override "stays keyed to whichever event id was active when the owner created it" and is never rewritten/re-keyed by a later supersession, and the repository's `UPDATE ... WHERE dividend_event_id = ?` matches only that ORIGINAL stored id. The tab therefore carries both keys separately -- `overridesByEventId`'s entry additionally exposes the override's own `storedDividendEventId`, and `buildDialogPrefill` (`app/dividend-history-prefill.ts`) sends THAT as `initialDividendEventId` whenever an override already exists (an UPDATE, correctly keyed), falling back to the row's current active id only when creating a brand-new override (correctly keyed to whatever is active now). Sending the row's current active id for an existing override's save 404s ("not found") even though `expectedVersion` was resolved correctly -- the two keys are not interchangeable at any point in this flow.
- **"Refresh historical"** (`app/dividend-history-refresh-actions.ts`) re-pulls one security's provider dividend/split history by calling MKT-005's `ingestSecurityCorporateActionHistory` UNCHANGED -- the identical function `app/security-verification-service.ts` already calls after IMP-004B verification and the periodic sweep. It only ever writes `dividend_events`/`split_events`/`corporate_action_refresh_state`; it never touches `dividend_event_overrides`/`dividend_manual_records`. Every owner override/exclusion therefore survives a refresh automatically, not through any special-cased preservation logic -- resolved fresh at read time on every load via the two-key mechanism above, exactly as it already does for an ordinary provider correction.
- **"Franking if not known" default** edits `dividend_security_assumptions.franking_percent_decimal` -- the SAME field the UI-006B assumptions grid edits -- through the identical whole-row `saveDividendAssumptionsGridWithContext` endpoint, sending the security's current yield/growth inputs and the portfolio's current growth inputs unchanged alongside the new franking value (that endpoint always replaces a full row, never patches a single field) so a franking-only edit here can never silently null out the other assumption fields. A partial commit (this security's row saved, the portfolio row separately conflicted -- that endpoint is not atomic across them, see UI-006B's B5 note above) is surfaced honestly via the response's `appliedSecurities`, not reported as a bare failure.
- **Sold-out securities remain reachable and their PRE-EXIT history remains total.** `portfolio_securities.status` has no "closed"/"sold" state (`db/schema.ts`: `'held' | 'watch' | 'hidden' | 'unresolved'`), so a fully-exited holding stays `status = 'held'` at zero current quantity forever and is never excluded from `loadOwnedDividendHistory`'s `WHERE status = 'held'` filter. DIV-001's derivation is quantity-agnostic (`deriveSharesHeldAtDate` naturally resolves to `"0"` once every share is sold), so no dedicated "closed position" code path is required for full retention of dividends the owner actually received while holding shares -- confirmed by inspection of the owned holdings list (`app/components/portfolio-shell.tsx`'s `OwnedHoldingsScreen`), which already renders every `status = 'held'` row including zero-quantity ones, unfiltered.
- **Post-exit zero-share rows are filtered from the tab, and lifetime totals are recomputed from the filtered set (Orchestrator ruling, follow-up).** A provider event dated AFTER a full exit derives an AUTO row (`source: "auto"`) whose `sharesDecimal` is mechanically `"0"` (the owner held nothing on that ex-date) -- this is a "no new dividend" ARTIFACT, not a real dividend fact about the owner's holding, so `app/owned-security-dividends.ts` removes exactly these rows (`source === "auto" && sharesDecimal === "0"`) from the tab's rendered list and re-runs `computeLifetimeDividendTotals` (unmodified, DIV-001's own pure function) over the filtered rows rather than the full set. Concretely: `rowCount`, `unknownAmountCount`, `receivedFrankingUnknownCount`, and `pendingCount` CAN change (a filtered row that happened to have an unknown amount or unknown franking no longer inflates those counts with a row that was never a real entitlement); every DOLLAR figure (`receivedCashDecimal`/`receivedGrossDecimal`/`pendingCashDecimal`/etc.) is UNCHANGED BY CONSTRUCTION, because a zero-share row's cash/gross contribution is always exactly `"0"` (`shares × per-share = 0`) whether it is summed in or filtered out. **This is deliberately the OPPOSITE disposition from DIV-003's `computeIncomeBreakdown` "honest 0" rule above** (a currently-zero-share security's FORWARD forecast is kept and shown as a real `"0"`, never excluded) -- the two do not contradict because they answer different questions. DIV-003's zero is a forward-looking statement of FUTURE entitlement for a security the owner still nominally tracks (an honest fact worth stating: "you will receive $0 from this going forward"). UI-006C's filtered rows are PAST provider events for ex-dates after the owner had ALREADY fully exited -- the owner was never entitled to them in the first place, so there is no real dividend fact to honestly disclose as zero; suppressing them is removing noise, not hiding a fact. An "edited" row can never be zero-share this way and so can never be filtered -- `isPositiveDecimalString` rejects a zero shares value on an owner override server-side -- so this filter can only ever remove an auto-derived artifact, never an owner's explicit correction.

### 12-month baseline forecast (DIV-001)

"Declared-then-TTM", implementing this section's Forecast hierarchy steps 1-2 concretely (`computeSecurityDividendForecast`): a rolling 365-day window from "today".

1. **Declared near-certain**: derived-history rows with `status: "declared_pending"`, non-excluded, whose `exDate` falls in the window and whose amount is known, summed as-is. Their `sharesDecimal` is mechanically "shares held today" (a future ex-date has no transactions past it to sum), matching the Forecast hierarchy's "current eligible quantity" rule exactly without recomputation. A declared row with an unknown amount still counts toward `declaredEventCount`/the coverage-end-date math (it IS a known future event) but not the cash sum, disclosed via `declaredUnknownAmountCount` rather than fabricating a `"0"`.
2. **Uncovered tail — B1 fix (review round 2, blocking):** the remaining days of the window AFTER the latest declared event's ex-date (or the whole window, if there are no declared events) are estimated by prorating **`max(0, ttmAnnual − declaredCash)`** — not the raw TTM annual figure — by `uncoveredDays / 365`. The original formula stacked the FULL TTM annual figure on top of the already-counted declared cash: a reviewer repro (a stable semiannual payer whose trailing year totalled 1000, with one 500 declared event due soon) returned ~1472 — MORE than the trailing year's entire income — because the declared event's own contribution was never subtracted out of what the tail assumed was still outstanding for the year. Subtracting the declared cash first bounds the total at `declaredCash + (ttmAnnual − declaredCash) × fraction ≤ ttmAnnual` whenever `ttmAnnual ≥ declaredCash` (the common case for a stable payer): the forecast can never exceed roughly one year of trailing income, and the formula reduces to the plain prorated TTM when there is no declared coverage at all (`declaredCash = 0`). Never re-adds the full TTM figure on top of already-counted declared events (double counting), and never silently substitutes 0 when TTM is `insufficient_history`/`mixed_currency`: the tail is reported as explicitly unknown (`uncoveredCashDecimal: null`, `uncoveredReason` set) and the total is only ever the safely-known declared portion, disclosed as partial (`totalFrankingIncomplete`/a `null` total when even the declared portion is empty). **Window-boundary follow-up fix (review round 3):** the window end date is `today + (FORECAST_WINDOW_DAYS − 1)` (364 days out), not `today + 365` — an inclusive day count treats both endpoints as counted, so `today` through `today + 365` is 366 days, not 365; with zero declared coverage this made `uncoveredDays = 366` divided by the `/ 365` proration denominator, over-counting a stable payer's forecast to `ttmAnnual × 366/365` (e.g. 1002.74 for a 1000 TTM) instead of exactly `ttmAnnual`. `today` through `today + 364` is exactly 365 inclusive days, so a fully-uncovered window now divides out to precisely 1.0.
3. Gross = cash + franking, applying `computeDefaultFrankingCredit` (the same ATO gross-up formula as the franking chain above, which is linear so it applies equally to a total cash estimate) to the uncovered tail's prorated cash figure — there is no single per-share figure to chain from for a prorated estimate.
4. Zero current shares forecasts an explicit, honest `"0"` (`status: "no_current_holding"`) — a real fact, not missing data.

Cadence inference (Forecast hierarchy step 3, "infer frequency only when payment spacing supports a stable cadence") is NOT implemented — this baseline relies entirely on MKT-005's existing TTM sum/insufficient-history behavior rather than reimplementing regular-payment detection, a deliberate scope-limiting decision left to a future task (DIV-003) if a more granular monthly/quarterly cadence view is needed.

### History-derived TTM fallback (DIV-006)

The TTM leg above (step 2's `ttmAnnual`) originally came ONLY from provider `dividend_events` (MKT-005's `deriveTrailingTwelveMonthDividend`), so a security with no provider coverage at all was excluded as `insufficient_history` even when the owner's IMPORTED history (DIV-001's derived rows — Sharesight CSV imports, receipts, manual entries) carried years of actual payments. Owner investigation (2026-08-20/21) of real local data found 118 derived-history records across 14 held securities, 13 of which had essentially no usable provider TTM coverage.

Owner ruling (binding, 2026-08-21): when the provider TTM leg is unusable for a security (no qualifying provider events, or a currency mismatch), `computeSecurityDividendForecast` falls back to a TTM derived from the security's OWN history rows (`deriveHistoryTrailingTwelveMonthDividend`, `domain/dividends/forecast.ts`) — but normalised to the identical **per-share rate × CURRENT share count** shape the provider leg already uses, never a raw trailing cash total (a raw total would silently bake in whatever position size happened to be held historically, mis-scaling the forward estimate whenever shares were bought/sold during the trailing year).

- **Provider precedence unchanged:** a usable provider TTM always wins — provider events carry declared/ex-date semantics history rows cannot reconstruct. The history fallback is only ever attempted when the provider leg itself fails.
- **Per-share derivation (DPS), per row:**
  - A per-share-mode history row (the great majority — owner-typed manual entries, receipts, per-share CSV imports, provider auto-derived rows) already carries its own `dividendPerShareDecimal`, used directly; the row's OWN `sharesDecimal` is irrelevant to this figure and is never consulted.
  - A BRK-005 totals-mode row (a Sharesight payout reporting only a total cash amount, no share count) has its DPS derived by dividing that total by the shares HELD ON THE ROW'S OWN PAYMENT DATE (`deriveSharesHeldAtDate`) — never by today's current share count. This division is trusted only when the portfolio's declared `history_complete_from` boundary covers the payment date (mirrors CGT-002's `evaluateHistoryCompleteness` history-honesty gate exactly: an unproven-complete ledger before that date could understate the true historical holding and corrupt the rate). `null`/malformed `history_complete_from`, a later boundary, a missing payment date, an unknown cash amount, or (defensively) a zero historical share count all fail closed — the row's rate is `null` (indeterminate), never guessed.
  - A converted foreign-currency totals-mode row (BRK-010's achievable-conversion case) uses its ALREADY-CONVERTED total (in the security's own currency, exact decimal arithmetic) exactly like any other totals-mode row above — no separate handling needed, since the conversion already happened at derivation time in `domain/dividends/history.ts`.
- **Window:** the same backward-looking, inclusive 365-day window MKT-005's provider TTM uses (`asOfDate − 365` through `asOfDate`); a row dated exactly on the 365-days-back boundary qualifies. A qualifying row is any non-excluded `ex_date_passed` row (actual received cash, never a future `declared_pending` estimate), dated by the `paymentDate ?? exDate` attribution convention the FY aggregations already use.
- **Zero qualifying rows** is `insufficient_history`, identical to the provider leg's own empty-window contract — never extrapolated from a partial year.
- **A currency mismatch** among qualifying rows (e.g. an un-converted foreign-currency row — BRK-010's un-achievable-conversion case) is `mixed_currency`, matching `computeLifetimeDividendTotals`'s established convention rather than blending currencies.
- **Incompleteness, never zero, never silently dropped:** a qualifying row whose DPS cannot be determined (unknown cash amount, or an untrusted totals-mode shares-at-payment-date) is excluded from the DPS sum but counted, never fabricated as `"0"` and never dropped without disclosure. When AT LEAST ONE row's rate is known, the forecast reports the sum of the known rows' rates, flagged `ttmIncomplete: true` (a real but potentially understated figure). When NOT ONE qualifying row's rate is known, the forecast reports `uncoveredReason: "unknown_amount"` — deliberately distinct from `"insufficient_history"`, since there IS trailing-window evidence, just no determinable rate.
- **Sold-out securities stay distinct:** a zero current-share holding short-circuits to `status: "no_current_holding"` (an honest `"0"`) before either TTM leg is ever evaluated — never conflated with `insufficient_history`.
- **Provenance:** `SecurityDividendForecast.ttmSource` discloses which leg actually fed the figure — `"provider_ttm"` or `"history_ttm"` — so a consumer can label the number "provider trailing 12 months" vs "your own recorded dividend history"; `null` when no TTM was used at all (fully covered by declared events, no current holding, or genuinely unusable data from both sources).
- **Portfolio-level disclosure (review follow-up):** `computeIncomeBreakdown` (below) INCLUDES a `ttmIncomplete: true` security in its totals (its `totalGrossDecimal` is real, just possibly understated — never re-excluded on top of the row-level disclosure above) but names it in `partialTtmSecurities` and flips `status` to `"partial"` — even when `excludedSecurities` is empty and every security technically "has a forecast". The `method` string and the Income landing's "Explain this estimate" dialog both surface this list, so a portfolio whose total is understated by DIV-006 partial history is never presented as a clean, fully-known `"ok"` figure.

### Retirement-income projection (DIV-003)

`domain/dividends/projection.ts` (pure functions) composed by `app/owned-income-projection.ts` (the owner-scoped read service, mirroring `app/owned-dividend-history.ts`'s I/O-vs-derivation split). Owner decisions binding this section (recorded 2026-08-13): the feature is a retirement-income modeller, not a dividend calendar — all dividend math is per 12-month period; multi-year views are per financial year (FY-001A windows/labels); "yield" throughout means the TOTAL yield INCLUDING franking credits, and projections run up to 10 years forward, 10 years back.

**Assumption resolution.** Three independent per-security chains, each carrying an explicit `source` and a human `method` label on every resolved value — never a bare number:

- **Franking %:** owner security assumption (`dividend_security_assumptions.franking_percent_decimal`) → else an explicit "treated as unfranked (0%)" default (`source: "none"`). There is no portfolio-level or provider-derived franking-percent fallback in this codebase — a provider event's own per-event franking field is a fact about one past dividend, not a forward assumption.
- **Dividend growth %:** owner security override → portfolio dividend-growth assumption (`dividend_portfolio_assumptions.portfolio_dividend_growth_percent_decimal`) → an explicit "no growth assumed" 0%.
- **Yield %:** owner override (already the TOTAL yield by definition — no further gross-up) → else the provider's trailing-twelve-month CASH yield (MKT-005, `deriveTrailingDividendYield`) grossed up by the resolved franking %, using `franking.ts`'s existing `computeDefaultFrankingCredit` — `grossedYield = cashYield + creditOnCashYield`, i.e. `cashYield × (1 + frankingPct/100 × 30/70)`, reusing the exact ATO ratio (linear in its "dividend amount" argument, so a yield percentage substitutes for a dollar amount without a separate formula) → else `source: "none"`, carrying the provider module's own typed reason (`insufficient_history`/`price_unavailable`/`currency_mismatch`/`mixed_currency`/`invalid_input`) forward rather than a guess.
- Portfolio-level value-growth % and dividend-growth % (the multi-year projection's own two scalar inputs, distinct from the per-security dividend-growth chain above, which only feeds the assumption-grid display) resolve from `dividend_portfolio_assumptions` directly, or an explicit "no growth assumed" 0% when unset.

**Franking gross-up/decomposition.** `decomposeGrossedAmount(gross, frankingPercent)` splits an already-grossed dollar figure back into cash + franking credit: it calls `computeDefaultFrankingCredit("1", frankingPercent)` to get the credit-per-dollar-of-cash ratio `r` (valid because the formula is linear), then `cash = gross / (1 + r)`. **Precision note (softened; an earlier draft overclaimed exactness here):** `r` is exact only when the underlying ATO fraction terminates in decimal (e.g. 70% franking gives `r = 0.3` exactly); for a franking % that does not (e.g. 100% franking's repeating `3/7`), `computeDefaultFrankingCredit`'s own single documented rounding applies, bounding `r`'s error to roughly `1e-24` relative — and `cash`'s own division against `r` carries that same bounded (not literally zero) drift in that case. `franking = gross − cash` is still computed by SUBTRACTION from the SAME `gross` value (never an independent multiplication), so **the SUM `cash + franking` always equals `gross` exactly, regardless** — the bounded drift, when the ratio doesn't terminate, only ever shows up in exactly how that exact sum is split between the two components, never as a missing or invented cent.

**Value-weighted yield aggregation (`aggregateSecurityYields`).** The multi-year table is portfolio-level, so per-security resolved (grossed) yields are combined into one portfolio effective yield: `effectiveYield = Σ(value_i × yield_i) / Σ(value_i)`, weighted by each security's CURRENT HOME-CURRENCY market value — percentages are dimensionless, so unlike a dollar total this has no cross-currency problem once every security's value is already expressed in one common home currency by the caller. Two independent, separately-named reasons keep a security out of the weighting: (1) **`value_unavailable`** — the caller-supplied value is `null` (checked FIRST, before the yield check and before the real-zero skip below), the fix for a blocking review finding (B1): an earlier version had the SERVICE collapse an unpriced holding's unknown value to the literal `"0"` before calling this function, which fell straight into the zero-value skip below with NO disclosure — a large unpriced holding with a real yield assumption vanished from both the numerator and the denominator while the method text still claimed full coverage (reviewer repro: a $900k unpriced holding at a 6% override plus a $100k priced holding at 3% reported a confident "3%, no exclusions"). The service now passes a distinguishable `null` for any holding without an `available` home value, and this function names every one in `excluded` before it can silently disappear. (2) A resolved yield of `source: "none"` — excluded and named with the yield chain's own typed reason, never silently treated as 0% yield, which would understate the covered securities' true effective yield. A REAL, priced zero/negative value is distinct from both and is silently skipped (not disclosed) — it is a real fact, not a coverage gap. The franking mix used later to split the projected dividend is the identical value-weighted average of each included security's resolved franking %.

**Multi-year projection (`projectMultiYearIncome`).** Year N (N = 1..`yearsForward`, ≤10):

```
value_N   = value_{N-1}  × (1 + valueGrowth%/100)
yield_N   = yield_{N-1}  × (1 + dividendGrowth%/100)
dividend_N = value_N × yield_N/100        (grossed, includes franking credits)
(cash_N, franking_N) = decomposeGrossedAmount(dividend_N, aggregateFrankingMix%)
```

Compounding is by REPEATED multiplication year over year (not `(1+g)^N` computed once), with a SINGLE documented rounding per step at a fixed 24-decimal-place intermediate scale (`PROJECTION_SCALE`, matching `franking.ts`'s `DEFAULT_TIER_SCALE`/`DECIMAL_LIMITS.allocationScale` convention) — every division THIS compounding step performs (percentage-to-fraction conversion) rounds exactly once at this scale. Without resetting to a fixed scale at each step, ten sequential tracked-decimal multiplications would otherwise grow the tracked exact-result scale past the 96-scale result boundary; rounding once per step keeps it bounded while remaining lossless for the VALUE/YIELD compounding specifically, for realistic percentage inputs (a percentage divided by 100 always terminates in decimal) — this "lossless" claim is scoped to the compounding steps only and does NOT extend to the separate franking-ratio decomposition step, whose own bounded (non-zero) per-component drift is documented above. Every row carries its resolved assumptions and their sources in a `method` label (e.g. "portfolio value compounds at 8%/yr (portfolio_assumption); effective yield compounds at 3%/yr (portfolio_assumption); dividend includes franking credits") and an FY label (`FY{yy}`) when a starting FY ending year is supplied, else a plain "Year N" label. `yearsForward` outside 1-10 inclusive — including `0` — is REJECTED with a typed `invalid_years` reason at both the domain function and the service boundary; a caller explicitly requesting zero forward years must never be silently forced up to a one-year projection it never asked for (follow-up 3).

**Partial-base disclosure travels with every row (review finding B4, round 2).** `MultiYearProjectionAssumptions` carries its own `currentPortfolioValueStatus: "available" | "partial"` field (the service sets it from `portfolioValueStatus`; a fully `"unavailable"` value never reaches this type at all — it short-circuits to the `portfolio_value_unavailable` typed failure below instead). When it is `"partial"`, EVERY row's `method` string appends `"; based on a partial (understated) current portfolio value -- some holdings are unpriced"`. This is deliberately baked into the row data itself rather than left as a separate top-level flag on `OwnedIncomeProjection`: `projectMultiYearIncomeWhatIf`'s output is exactly what UI-006A can render STANDALONE (a what-if table without the originating `OwnedIncomeProjection.portfolioValueStatus` anywhere nearby), and since `projectMultiYearIncomeWhatIf` only ever substitutes the two growth fields — `currentPortfolioValueStatus` passes through unchanged from the baseline assumptions it copies — the disclosure is present in a what-if result exactly when it was present in the baseline, with no separate propagation code to keep in sync.

**Degraded multi-year inputs (review finding B3).** `MultiYearProjectionResult`'s `ok: false` union carries four typed reasons: the domain function's own `invalid_years`/`invalid_decimal`, plus `portfolio_value_unavailable`/`no_yield_coverage`, which the SERVICE layer (`app/owned-income-projection.ts`) returns directly (without ever calling the domain projection function) when the current portfolio value or the aggregate yield is unavailable — replacing an earlier, misleading blanket `invalid_decimal` that did not distinguish these cases. Critically, the service's `multiYearBaselineInput` is `null` in every degraded case, never built with `"0"` substitutions for a missing value or yield: an earlier version always constructed a full (fabricated-zero) baseline input regardless of availability, which `projectMultiYearIncomeWhatIf` could then silently turn into a confident, `ok: true`, all-`"0"` projection. A `null` baseline makes that structurally unreachable — there is nothing a caller can hand `projectMultiYearIncomeWhatIf` when the portfolio is degraded.

**What-if overlay (`projectMultiYearIncomeWhatIf`).** Substitutes ONLY `valueGrowthPercentDecimal`/`dividendGrowthPercentDecimal` into a copy of the baseline assumptions (source relabelled `"what_if"`) and re-runs the same projection — a pure function of `(baseline input, overrides)` that never mutates the baseline object and never touches storage. Non-persistence is enforced structurally, not just by convention: `domain/dividends/projection.ts` has no repository/`SqlClient` import anywhere in the file, so nothing in it can reach storage regardless of how it is called.

**Past financial-year rows (`computePastFinancialYearRows`).** Portfolio-level rows for up to 10 closed prior FYs, precedence: owner FY override (`dividend_fy_overrides`, already a portfolio-scoped, portfolio-base-currency figure — used directly, cash normalized to `grossed − franking` exactly like `computeFyDividendTotals`'s B6 fix) → else the sum of DIV-001's already-precedence-resolved per-security FY totals, labelled by row composition (`"actual"` when every contributing security-year is `"actual"`, `"provider_estimate"` when every one is, `"partially_estimated"` for a mix). **Scope decision, mirroring DIV-001's own flagged follow-up:** summing per-security dollar totals into one portfolio figure requires every contributing security to share one currency (dollar amounts, unlike percentages, cannot blend across currencies without an FX conversion this task does not implement); this function aggregates only securities denominated in the portfolio's own base currency and EXCLUDES + NAMES every foreign-currency security rather than mis-converting or silently omitting it. **`no_evidence` (follow-up 1, correcting an earlier overclaim):** a year where NO eligible security has ANY `fyTotals` entry at all — e.g. the year predates the security's own dividend history, or simply predates the ingested data — is now reported as `dividendSource: "no_evidence"` with a `null` figure, never an asserted `"actual"` `"0"`. DIV-001's per-security totals cannot distinguish "confirmed paid nothing" from "no data for that year", so this layer must not assert the former as a confirmed fact. A genuine per-security data problem (a `mixed_currency`-status security, or a year whose amount is unknown) remains a separate, named exclusion. Each row attaches the portfolio's value AT that FY's end date when a historical snapshot exists for that exact date (`db/repositories/snapshots.ts`'s published-overview history, matched by calendar date) — absent or `null` means `valueStatus: "unavailable"`, never a fabricated 0 — and an effective yield (`dividend / value × 100`) only when both the dividend and the value are known for that year.

**Current (in-progress) financial-year row (`computeCurrentFinancialYearRow`, follow-up 2).** The multi-year view otherwise had a gap between the last CLOSED past FY and the first FORWARD-projected FY, with nowhere to show what has actually happened so far this FY. This function reports the current FY's **FY-to-date** actuals — the honest, simpler option the review explicitly asked for, deliberately NOT a forecast of the remainder of the year (which would risk conflating a modelled estimate with what has actually been received so far). It shares `computePastFinancialYearRows`' owner-FY-override-then-derived-sum precedence and base-currency-only aggregation scope, but labels the derived tier `"fy_to_date"` — never `"actual"`/`"provider_estimate"`/`"partially_estimated"`, which this module reserves for CLOSED years — since the year has not finished. Its value/`valueStatus` come from the CURRENT holdings value (not a historical snapshot), including a `"partial"` state a closed year's row does not have (see below).

**Single-12-month breakdown (`computeIncomeBreakdown`).** Aggregates DIV-001's per-security 12-month baseline forecasts into one portfolio figure using the identical base-currency-only aggregation scope decision as the past-FY rows above (a foreign-currency security is excluded and named). A security whose forecast is `insufficient_history` (`totalGrossDecimal: null`) is likewise excluded and named — the concrete form of the "insufficient history, not zero, with partial coverage disclosed" acceptance rule. A security with a zero forecast because it currently holds no shares (`status: "no_current_holding"`) is a real fact and contributes an honest 0, not an exclusion. **DIV-006 review follow-up:** a security whose forecast has `ttmIncomplete: true` (a real but only partially-determinable history-derived TTM — see the DIV-006 block above) is neither excluded nor silently summed as complete: it stays INCLUDED in every total (its `totalGrossDecimal` is real, not fabricated), but is separately named in `partialTtmSecurities` and forces `status: "partial"` — so `status: "partial"` no longer implies `excludedSecurities` is non-empty; it can also mean "everything is included, but at least one included figure may understate true income." Both lists are disclosed together in `method` and in the Income landing's "Explain this estimate" dialog. Divisor convention: average per month = gross ÷ 12; average per week = gross ÷ 52 (the standard 52-week approximation of a year, NOT 365/7 ≈ 52.14 — a deliberate, documented simplification matching common personal-finance convention). Income % of current portfolio value = gross ÷ current portfolio value × 100, only when the current portfolio value is known; the result's `incomePercentOfValueStatus` mirrors the caller-supplied value status (review finding B2) — `"partial"` discloses that the denominator is a real but UNDERSTATED known total, so the percent may read higher than the true figure even though it is not fabricated. A contradictory input (a positive value supplied alongside `currentPortfolioValueStatus: "unavailable"`, which a well-behaved caller should never produce) resolves CONSERVATIVELY to `incomePercentOfValueStatus: "unavailable"` (round-2 review correction — this previously defaulted to the confident `"available"` label on a contradiction it could not actually verify).

**Current portfolio value (review finding B2, correcting a misstatement of the CALC-002 contract).** Sourced from `app/owned-holdings.ts`'s `cash.knownTotal` (securities + cash, already home-currency). CALC-002's actual contract is: the total is the sum of the PRICED-AND-CONVERTED holding set — a real but POTENTIALLY PARTIAL known total, with coverage counts disclosing what was excluded — and it never inserts a fabricated zero for what is missing; it is not, as an earlier draft of this section stated, simply "unavailable rather than partial". This module's `portfolioValueStatus` now has three states — `"available"` (complete), `"partial"` (a real, disclosed, understated total — `holdings.status === "partial"`), and `"unavailable"` (no total at all) — mirroring that contract instead of collapsing "partial" into "available" the way an earlier version did. `portfolioValueCoverage` (from `app/owned-holdings.ts`'s own coverage counts) travels alongside the value so a consumer can disclose exactly how partial a `"partial"` status is. A `"partial"` value is still usable for the multi-year projection and the income-percent-of-value figure: the multi-year projection carries the disclosure IN its assumptions and every row's `method` (review finding B4, see above — not merely "usable", the disclosure is structurally propagated, including into a standalone what-if result), and the breakdown's `incomePercentOfValueStatus` mirrors it directly (previous paragraph) — this task does not reimplement holdings valuation, only relays its honesty contract faithfully. When the holdings pipeline itself is unavailable (e.g. no published calculation yet), the current value, the multi-year projection (`portfolio_value_unavailable`), and income-percent-of-value all honestly degrade to unavailable; per-security assumption resolution still runs (a missing current price surfaces as the yield chain's own `price_unavailable` reason).

## 12. Missing-data and error behavior

| Missing input           | Result                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| Current price           | Current value/gain unavailable for holding; partial portfolio total |
| Current FX              | Native value visible, base value unavailable                        |
| Transaction FX          | Native ledger retained; base basis/realised metrics incomplete      |
| Previous price/FX       | Current value available; daily movement unavailable                 |
| Cost basis              | Market value available; gain/percentage unavailable                 |
| Dividend history        | Forecast unavailable, not zero                                      |
| Provider mapping        | Ledger position retained; market data unavailable                   |
| Cash history incomplete | Balance labelled unreconciled/incomplete                            |

Errors carry stable reason codes and remediation; the UI avoids `0.00` for unknown.

## 13. Deterministic test fixtures

Minimum fixture families:

1. Single-currency buys, fees, partial FIFO sell.
2. Foreign buy/sell with different transaction FX and current FX.
3. Daily price move with flat FX, flat price with FX move, and both moving.
4. Weekend/holiday previous-session and FX fallback.
5. Split between buys and sell.
6. Missing price, FX, basis, and partial coverage.
7. Manual override activation, supersession, expiry, and removal.
8. Dividend declared/paid/estimated, withholding, and irregular history.
9. Rounding residual allocation across multiple lots.
10. Import reversal followed by deterministic rebuild.

Expected values are calculated independently and stored as decimal strings.

## 14. Realised capital gains (CGT-001A)

**Informational estimate only — this is NOT tax advice.** Consult a registered tax agent for an actual return. `domain/gains/**` is a read-only, pure-function layer over the ledger's already-computed `tax_lots`/`lot_allocations` (LED-002B) — it introduces no new ledger machinery and never affects totals or the ledger itself.

**Source of truth.** Every per-disposal figure (matched quantity, allocated cost basis, net proceeds, fees, tax, and realised gain) comes straight from `lot_allocations`' `base*` columns, joined to `tax_lots` for the disposed lot's acquisition and to the sell transaction for the disposal date — read via the SAME current-published-run discipline `app/owned-holdings.ts` uses for `holding_projections` (`projection_publications`' single pointer row; a stale or unpublished run is structurally invisible, never filtered out after the fact). Because `lot_allocations`' `base*` columns are already FX-converted to the portfolio's base currency at ledger-projection time, capital gains totals aggregate across every security in one portfolio without the native-currency mixing concern `domain/dividends` has to guard against.

**Acquisition vs. disposal date — which column, and why.** `tax_lots.acquired_at` stores the opening transaction's full trade INSTANT (`transactions.trade_at`), not a local calendar date. Comparing that directly against a disposal's local calendar date would silently mix an instant with a business date. Instead, both dates used for eligibility and FY attribution are `transactions.local_trade_date` — the tax lot's OPENING transaction's local date (joined via `tax_lots.opening_transaction_id`) for acquisition, and the sell transaction's own local date for disposal. If either join is unresolvable (should not happen for well-formed ledger data), the read service fails typed (`missing_allocation_dates`) rather than silently dropping the allocation or defaulting a date.

**Discount eligibility (`domain/gains/eligibility.ts`).** The ATO individual discount requires an asset be held STRICTLY MORE than 12 months: 12 months plus at least one more day. A disposal on the exact same day-of-month one year later is NOT eligible. Implemented with calendar-month arithmetic (acquisition date + 12 months = threshold date; eligible iff disposal date is strictly after the threshold), not day-counting. The one edge case a whole-year shift can produce — a 29 February acquisition, when the destination year is not a leap year — is resolved by CLAMPING DOWN to the last valid day of the destination month: `29 Feb 2024 + 12 months = 28 Feb 2025` (never rolling forward to 1 Mar, which is what JavaScript's `Date` object does by default). Eligibility is a pure function of the two dates alone — it stays computable even when the allocation's gain amount itself is unknown (`basisStatus` incomplete).

**Per-FY aggregation ordering (`domain/gains/fy-aggregation.ts`, binding per TASKS.md CGT-001A).** For each financial year (FY-001A windows/labels, disposal `local_trade_date` attributed via the same `fyWindowForDate` primitive `domain/dividends/aggregations.ts` already uses for an arbitrary past date):

1. Split that FY's COMPLETE-basis disposal rows into discountable gains (positive, held > 12 months), non-discountable gains (positive, held ≤ 12 months), and losses (negative, summed as a positive magnitude).
2. Offset losses against gains BEFORE any discount — non-discountable gains FIRST (the standard optimal-for-the-taxpayer default: consuming the never-discountable gain with the loss preserves as much discountable gain as possible), then any remaining loss against discountable gains.
3. Apply the 50% individual discount (`CGT_INDIVIDUAL_DISCOUNT_RATE = "0.50"`, documented and exported the same way `AU_COMPANY_TAX_RATE` is — see section 11 above) to whatever discountable amount remains AFTER step 2, never to the gross discountable total.
4. Net capital gain estimate = remaining non-discountable (after loss) + the discounted remaining discountable amount.

There is no such thing as a negative taxable capital gain: if losses exceed total gains for the year, both "remaining after loss" buckets fully absorb to 0, the net capital gain estimate is 0, and the excess is disclosed separately as an unabsorbed-loss figure. This module still computes every FY STANDALONE, with no prior/future-year application of its own — as of CGT-002 (see the new subsection below), `domain/gains/carry-forward.ts` consumes this FY-by-FY output to chain `unabsorbedLossDecimal` forward across financial years into the TRUE, carried per-FY and whole-period figures. The two are both honest, for different purposes: this module's `netCapitalGainEstimateDecimal`/`unabsorbedLossDecimal` are what a FY looked like entirely on its own; the carry module's figures are what it looks like once prior-year losses are actually applied. Each total also echoes a per-figure method label (`CGT_METHOD_LABELS`) so a consumer never has to infer the ordering rule from the numbers alone.

**Incomplete-basis disclosure.** An allocation whose `basisStatus` is not `'complete'` has a genuinely UNKNOWN gain (the FX rate or native cost basis needed to compute it was missing somewhere in the lot's history) — it is never folded into any FY total as a fabricated zero. It is excluded from every sum, counted (`excludedIncompleteCount`), and its security named (`excludedIncompleteSecurityNames`) so the FY total visibly discloses partial coverage. A multi-lot disposal (one sell matched across several tax lots) is scored per allocation — one lot in the sale can be discount-eligible while another, from a more recent purchase, is not; each allocation's own acquisition date drives its own eligibility and its own contribution to the discountable/non-discountable/loss buckets.

**Read service (`app/owned-capital-gains.ts`).** Owner-scoped, batched (one bounded query per table across the whole portfolio, no per-security round trips). A portfolio with no active (non-reversed) `sell` transaction reports the ordinary empty "no disposals yet" state without requiring a publication at all — mirroring `loadOwnedHoldings`'s zero-held-securities short-circuit. This is deliberately an active-LEDGER check, not a read of `lot_allocations` itself: an older, not-yet-recalculated publication can still physically carry `lot_allocations` rows for a sell that has SINCE been reversed (the recalculation that would clear them just hasn't published yet). The empty answer stays honest regardless — the disposal itself has been undone, so reporting it would mean surfacing a stale run's leftover rows as if they were current, which is worse than reporting no disposals until the rebuild catches up. Once an active sell exists, a valid current publication is REQUIRED exactly like holdings; its absence is a typed failure, never a silent empty result (a real disposal must never read as "no disposals yet").

**Capital gains screen (CGT-001B, `/portfolio/:id/gains`, `app/components/capital-gains-screen.tsx`).** The Income area's third tab, alongside "Next 12 months"/"Multi-year". `disposalCount` is always labelled "lot matches" on this screen, never bare "disposals" — it counts `lot_allocations` rows, and one sale spanning several tax lots produces more than one allocation (CGT-001A's completion note). Three distinct degraded states are rendered honestly, never as a fabricated $0: an unpublished calculation run (`unpublished`), unresolvable allocation dates (`missing_dates`), and every other typed read-service failure (`error`); a portfolio with zero disposals gets its own explicit "no disposals yet" empty state instead of an empty table. Each FY row opens a detail dialog listing every allocation attributed to that year (security, acquired/disposed dates, quantity, proceeds, basis, fees, gain/loss, eligibility label) — purely presentational over already-loaded props, so no fetch happens when a row opens and UI-008's in-flight-fetch timeout does not apply. As of CGT-002, the same dialog also lists the FY's carried breakdown (see below) alongside its standalone figures.

**Lifetime rollup (`domain/gains/lifetime-totals.ts`, `computeLifetimeCapitalGainsTotal`).** A pure, purely-additive sum of each FY's own already-final STANDALONE totals (discountable/non-discountable/losses/unabsorbed-loss/net-estimate), computed with the same exact-decimal primitives as every other calculation in this document. This is a disclosure, not a recomputation: it does not itself apply loss carry-forward across years, so an unabsorbed loss in one FY is never netted against a gain in another when rolled up this way; it is simply the sum of the sequence of standalone per-FY figures. The discountable/non-discountable/losses lines from this rollup remain the ones the Capital gains screen shows (carry-in only ever redistributes GAINS a loss offsets, never the underlying gross gain/loss figures themselves — see CGT-002 below for why the net-estimate line is different). The `netCapitalGainEstimateDecimal` this function produces is the STANDALONE lifetime figure; CGT-002's carry chain (below) supersedes it for what the screen actually labels "Lifetime net capital gain estimate".

**Display-rounding decision (CGT-001B).** Every money figure on the Capital gains screen — including a 50% discount landing on an exact half-cent (e.g. `50.505` → `50.50`) — is formatted the same way every other Income-area money figure already is: `formatIncomeMoney` → `formatDecimalFixed` at 2dp with `Decimal.ROUND_HALF_EVEN` (`domain/calculations/decimal.ts`). The underlying figures returned by `domain/gains` stay exact/unrounded end to end; only the final render step rounds, and it rounds every figure independently. No footnote-style "these may not sum to the total" disclosure is added, because the visible per-FY columns are not a decomposition of the net estimate in the first place — gross discountable + gross non-discountable − losses does not equal the net capital gain estimate even at full precision, by design (the discount and loss-offset ordering mean it never would), so there is no rounded-parts-vs-rounded-whole hazard specific to this screen for a footnote to guard against.

**Capital loss carry-forward across financial years (CGT-002, `domain/gains/carry-forward.ts`, `computeCapitalGainsCarryChain`).** A pure function chaining `computeFyCapitalGainsTotals`' per-FY output (above) from the EARLIEST disposal FY forward. It never re-derives a FY's own current-year gain/loss buckets — it only layers a SECOND loss-offset pass on top of each FY's already-final `remainingNonDiscountableAfterLossDecimal`/`remainingDiscountableAfterLossDecimal` (what is left of that FY's own gains after that FY's OWN current-year losses are already applied). This structurally enforces the binding order: a carried-in loss can only ever be applied AFTER current-year losses, never before, because the pre-current-year-loss gross figures are simply not visible to this module.

- _Chain rules._ Each FY's unabsorbed net capital loss — its own current-year excess, plus any prior-FY loss it could not itself fully absorb — carries into the NEXT FY as "loss brought forward". Within a FY, the brought-forward loss is applied using the SAME two-tier priority as current-year losses (non-discountable gains first, then discountable), always against the PRE-discount discountable amount, i.e. BEFORE the 50% discount is (re-)computed on whatever discountable amount remains after both current-year losses and the carried-in loss. Applying the carried-in loss against an already-discounted figure (e.g. naively subtracting it from `netCapitalGainEstimateDecimal`) is the natural implementation mistake this ordering rule forecloses, and gives a materially different, wrong answer — pinned by a discriminating fixture in `tests/cgt-002.test.ts`. (The relative order of "this FY's own loss" vs. "loss brought forward" cannot, on its own, change a FY's final remaining-gain figures — sequential floor-at-zero subtraction against the same two-tier priority is associative — so it is specifically the ordering RELATIVE TO THE DISCOUNT that this rule pins, not an ordering between the two loss pools that would otherwise be ambiguous.)
- _History-honesty predicate._ `portfolios.history_complete_from` is the earliest local calendar date the ledger is known to be a complete record (IMP-004A/reconciliation's declared opening-history boundary). The chain is complete iff `history_complete_from` is set AND on or before the earliest disposal FY's start date; `null`, later than that date, or an unreadable value are all incomplete. When incomplete, every carried figure from the very first FY onward — and the whole-period net — is flagged with a disclosure naming the gap: "prior losses before `<date>` are unknown" when a later boundary date is declared, or an explicit "no declared history-completeness date...prior losses are unknown" wording when it is `null`.
- _Partial-basis propagation._ A FY whose own totals already exclude incomplete-basis allocations (`FyCapitalGainsTotal.partialCoverage`) has an unknowable true gain/loss for that year — its `remainingAfterLoss`/`unabsorbedLossDecimal` figures are real, but only over the allocations that WERE resolvable. Once a FY's own coverage is partial, every carried figure from that FY onward is tainted (`carriedFiguresPartial`) and STAYS tainted for the rest of the chain — this module never attempts to "heal" a corrupted prefix — combined with the history-honesty taint above.
- _Whole-period net._ The TRUE whole-period net capital gain is the sum of every FY's own carried (chain-adjusted) `netCapitalGainEstimateDecimal` — each dollar of gain/loss is accounted exactly once (offset in the year incurred, offset via carry-in in a later year, or left as a still-unabsorbed loss), so this sum never double-counts. The most recent FY's own `carryOutLossDecimal` (a loss still available to offset a FUTURE, not-yet-reported FY) is disclosed SEPARATELY as "still carrying forward", exactly like a single FY's own `unabsorbedLossDecimal` is disclosed rather than netted in — it belongs to a period this chain has not seen yet.
- _Screen._ The FY table gains three carried columns (brought forward / applied this FY / carried out); its "Net estimate" column is now the carried (true) figure, not the standalone one. The lifetime summary's headline line is relabelled "Lifetime net capital gain estimate (true, carried)", replacing the old "(sum of each year, standalone)" wording — it is the TRUE whole-period net described above, not a plain per-FY sum. The old STANDALONE per-year figures are not lost: they remain the FY table's Discountable/Non-discountable/Losses columns (carry-in never touches the underlying gross gain/loss figures, only how a loss is offset) and are shown again, explicitly labelled "standalone", in the per-FY detail dialog alongside the new carried breakdown for that year. A tainted carried figure (per the partial-basis/history-honesty rules above) is marked with `*` wherever it is shown, next to a standing disclosure explaining why. The standing carry-forward disclosure (`CGT_CARRY_FORWARD_NOTE`, `domain/gains/carry-forward.ts`) replaces CGT-001A's old `CGT_CARRY_FORWARD_OUT_OF_SCOPE_NOTE` — renamed, not merely reworded, since carry-forward is no longer out of scope.
