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
- A source decimal is bounded to 64 digits and 24 fractional places before construction. Exact operation chains are bounded to 256 significant digits and 96 fractional places with 320 working digits; work outside those limits fails closed instead of allocating an unbounded power or silently rounding.
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
- FX contribution: `Q_t × P_t × (FX_t − FX_prev)`
- cross term: `Q_t × (P_t − P_prev) × (FX_t − FX_prev)`

The headline full movement uses the exact combined formula. If a decomposition is shown, add the cross term to FX contribution by convention so components reconcile.

Quantity timing:

- use quantity held at the current valuation cutoff;
- trades effective between comparison closes are not called market movement; their cash/value effects are classified as flows and snapshot reconciliation;
- if trade timestamps cannot establish a correct boundary, daily movement for that holding is incomplete.

Holding daily percentage:

`Daily% = Daily_base / abs(Q_t × P_prev × FX_prev) × 100`

Unavailable when previous comparable value is zero/missing.

Portfolio daily movement is the sum of comparable security movements plus currency movement on cash accounts, excluding external deposits/withdrawals and trade flows. V1 may initially show only the security sum and a coverage label until cash-FX classification is complete.

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

## 8. Historical values and snapshots

### Quantity series

Build end-of-local-day quantities by replaying posted ledger events in effective order, including explicit splits. Do not use today’s quantity for prior dates. Add transfer replay only when the deferred transfer contract is promoted.

### Daily holding value

`HoldingValue_s,d = Q_s,d × P_s,d × FX_s,d`

Use the security’s exchange market date and the portfolio’s local snapshot cutoff. The selected price date and FX date are recorded.

### Portfolio daily value

`PortfolioValue_d = Σ HoldingValue_s,d + Σ CashValue_c,d`

Only claim complete history where:

- ledger history is complete from/on `d`;
- all material quantities have basis where a basis metric is shown;
- market and FX coverage meet the declared threshold.

Otherwise store partial status and exclusions.

### Snapshot invalidation

- Transaction change: invalidate from its local effective date.
- Split/corporate-action correction: invalidate from effective date.
- Security mapping historical correction: invalidate affected mapping interval.
- Price/FX correction: invalidate observations’ affected dates.
- Calculation-version change: create/rebuild a new version; do not mix versions in one chart.

### Chart gaps

Carry a prior market close only across non-trading dates within the FX fallback window and retain the selected observation date in the point explanation. Do not interpolate missing prices. Break or mark the series when a required value exceeds staleness policy.

## 9. Realised, unrealised, and headline returns

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

## 10. Dividends (deferred)

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

## 11. Missing-data and error behavior

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

## 12. Deterministic test fixtures

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
