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

## 11. Dividends (deferred)

This section preserves the future calculation contract. None of it is part of the core ledger/valuation release, and no estimate or receipt table should be added before `DB-005`, `MKT-005`, and `DIV-001` are promoted from deferred status.

### Actual receipt

At payment/posting:

- eligible quantity comes from the user/import fact or from ex-date holdings when explicitly inferred;
- `gross native = eligible quantity × event gross per share`;
- `net native = gross native − withholding − other taxes`;
- base amounts use payment-date FX selected under the transaction rule;
- actual net posts to cash;
- franking credits, if recorded, are informational tax attributes and not cash.

The system must not infer an actual receipt solely because a provider event exists.

### Forecast hierarchy

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
