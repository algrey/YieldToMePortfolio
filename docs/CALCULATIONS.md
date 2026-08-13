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
2. approved validated best-effort/delayed observation within its applicable staleness window and matching the required adjustment state;
3. approved EOD observation matching the required adjustment state;
4. previous valid trading-day observation within the configured EOD staleness window;
5. unavailable.

For v1 current value, use raw/unadjusted close or latest EOD observation because ledger quantities already reflect explicit split effects. Adjusted series is used for chart continuity/return research only and must never multiply against already split-adjusted quantities without reconciliation.

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

An owner-typed manual record or receipt left unmatched after every event is processed becomes its own standalone row (no `dividend_event_id`) — the "covers securities/events the provider misses" case. DIV-004 cross-tier rule: an imported row similarly left unmatched by any event does NOT automatically become its own standalone row — it is first proximity-matched (same window, same global nearest-wins assignment) directly against every standalone owner-typed manual record and standalone/orphan receipt for the security (there is no common event to anchor the comparison to in this case), collapsing into whichever one it is nearest to within the window (owner wins, the imported row's values kept via `dominatedImported`). Only an imported row matching neither an event nor a standalone owner fact becomes its own standalone `source: "imported"` row. A receipt that no ACTIVE event's lineage claims at all (its event is cancelled, missing an ex-date, or otherwise never reached the usable event set) resurfaces the same way, as its own standalone row built from the receipt's own dates (follow-up fix: a receipt attached to a cancelled/null-ex-date event must not silently vanish — the reviewer's cancelled-reissue note: no current provider ever writes `status = 'cancelled'`, so this path is exercised today only by defensive input or a future provider capability, documented as intentional ahead of time). A receipt dominated by a non-excluded override remains intentionally not shown (the owner's edit supersedes it).

**Excluded events (review round 3, fixing a blocking double-count review round 2's B3 fix introduced; DIV-004 extended it to the imported tier).** An excluded event (`exclude: true`) is removed from EVERY total, but an owner-typed manual record, a receipt, and/or an imported row attached to that SAME excluded event must not each produce their own row — round 2's independent "manual falls through to the fully-standalone loop" and "receipt resurfaces directly" paths did not dedupe against each other, so an excluded event with both a receipt and a manual record for the same real dividend produced TWO rows (reviewer repro: excluded event, receipt $500, manual $500 → reported $1000 received instead of $500). The fix runs the identical four-tier precedence (tiers 2–4 above) ONCE per excluded event as a separate resurfacing pass, collapsing any combination of an attached manual record, receipt, and/or imported row into exactly one non-excluded row (owner-typed manual wins when present, then receipt, then imported; whichever lower tiers are also attached surface via `dominatedReceipt`/`dominatedImported`) — never zero, and never more than one, regardless of how many facts point at that excluded event.

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

**Single-12-month breakdown (`computeIncomeBreakdown`).** Aggregates DIV-001's per-security 12-month baseline forecasts into one portfolio figure using the identical base-currency-only aggregation scope decision as the past-FY rows above (a foreign-currency security is excluded and named). A security whose forecast is `insufficient_history` (`totalGrossDecimal: null`) is likewise excluded and named — the concrete form of the "insufficient history, not zero, with partial coverage disclosed" acceptance rule. A security with a zero forecast because it currently holds no shares (`status: "no_current_holding"`) is a real fact and contributes an honest 0, not an exclusion. Divisor convention: average per month = gross ÷ 12; average per week = gross ÷ 52 (the standard 52-week approximation of a year, NOT 365/7 ≈ 52.14 — a deliberate, documented simplification matching common personal-finance convention). Income % of current portfolio value = gross ÷ current portfolio value × 100, only when the current portfolio value is known; the result's `incomePercentOfValueStatus` mirrors the caller-supplied value status (review finding B2) — `"partial"` discloses that the denominator is a real but UNDERSTATED known total, so the percent may read higher than the true figure even though it is not fabricated. A contradictory input (a positive value supplied alongside `currentPortfolioValueStatus: "unavailable"`, which a well-behaved caller should never produce) resolves CONSERVATIVELY to `incomePercentOfValueStatus: "unavailable"` (round-2 review correction — this previously defaulted to the confident `"available"` label on a contradiction it could not actually verify).

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
