# 3. Calculations and interface specification

# 3.1 Calculation notation and principles

For a holding `h` at time `t`:

- `Q_h` — total open quantity after lot matching.
- `P_t` — latest native-currency price.
- `P_prev` — previous market close in native currency.
- `FX_t` — native quote currency to portfolio/display currency conversion rate at `t`.
- `B_open` — remaining open cost basis in portfolio currency.
- `B_sold` — matched cost basis of quantities sold.
- `S_net` — net sale proceeds after sell commissions/costs.
- `R` — realised gain.
- `D` — dividend income included under the selected return definition.
- `I` — interest income included under the selected return definition.
- `F` — fees/commissions not already included in basis/proceeds.
- `MV` — current market value.

## General rules

1. **Transactions are authoritative.** Shares, cost and realised gain are recalculated from the ledger.
2. **Use exact decimal arithmetic.** JavaScript `Number` alone is unsuitable for lot accounting and repeated currency conversions.
3. **Calculate at full precision; round only for display.** Never feed a rounded displayed average price back into cost-base calculations.
4. **Display source freshness.** A price, FX rate and fundamental may have different timestamps.
5. **Make currency direction explicit.** This specification uses `FX(native -> portfolio)`.
6. **Separate value change from investment return.** Deposits and withdrawals can move portfolio value without producing a gain.

---

# 3.2 Transaction and lot calculations

## Open quantity

**Likely formula, high confidence:**

```text
Q_h = sum(buy quantities)
      - sum(sell quantities)
      + quantity effects of splits/transfers/corporate actions
```

The supplied file contains Buy/Sell only, so the observed implementation can be reproduced initially as buys minus sells.

**Scope:** holding; summed for display in H-TXN and P-HOLD.  
**Inputs:** transaction type and exact quantity.  
**Formatting:** source shows two minimum decimal places, e.g. `20,000.00`, even for whole shares.  
**Uncertainty:** fractional shares, shorts, transfers and splits were not demonstrated.

## FIFO allocation

**Observed/inferred with very high confidence:** FIFO is the default and produces the source realised results exactly.

For each sell in ascending effective order:

1. consume quantity from the oldest remaining buy lot;
2. continue through later lots until the sell quantity is fully allocated;
3. allocate buy commission into lot cost and sell commission against proceeds;
4. record matched quantity and basis.

The Add Portfolio form explicitly displays FIFO. Thirteen CSV sell rows specify FIFO.

## Remaining parcel quantity

For buy lot `i`:

```text
q_open_i = q_bought_i - sum(quantity from lot i allocated to sells)
```

Only lots with `q_open_i > 0` appear as open parcels in H-TXN. The source presentation of fully consumed lots/sells is unknown.

## Parcel cost base

**Likely formula:**

```text
B_i = q_open_i * acquisition_price_i
      + remaining allocated buy commission/costs
```

For a foreign transaction:

```text
B_i_base = (q_open_i * acquisition_price_i + allocated native costs)
           * acquisition_FX_i
```

Whether the source multiplies or divides by `Purchase Exchange Rate` is unknown because all demonstrated holdings are AUD and legacy FX values are blank/zero.

## Holding open cost base

```text
B_open_h = sum(B_i for all open lots i)
```

**Observed:** the Value/Cost second line is the sum of open parcel bases.

## Average cost per share

```text
AverageCost_h = B_open_h / Q_h
```

If `Q_h = 0`, display no average rather than divide by zero.

**Observed examples:**

- PLS.AX: `39,300 / 20,000 = 1.965`.
- MIN.AX: `101,481 / 2,100 = 48.3242857…`, displayed `48.324`.
- RIO.AX: `75,004.40 / 800 = 93.7555`, displayed `93.756`.
- CLW.AX: `138,833.216 / 33,000 = 4.207067…`, displayed `4.2071`.

This confirms auto-increasing precision rather than a hard two-decimal price format.

## Sale proceeds

```text
S_net_sell = sell_quantity * sell_unit_price - sell_commission - other sale costs
```

The CSV `Cost Per Share` field is semantically an execution unit price for both Buy and Sell rows; it is not the matched cost base on a sell.

## Realised gain

For each sale:

```text
R_sell = S_net_sell - matched_cost_basis_sell
```

For holding/portfolio:

```text
R = sum(R_sell)
B_sold = sum(matched_cost_basis_sell)
```

## Realised percentage

```text
RealisedPct = R / B_sold * 100
```

If there is no sold basis, source commonly displays `0.00%` or a dash; target should use `—` when not applicable and `0.00%` where a real zero result exists.

### Exact source validation

Using FIFO on `portfolio.csv`:

| Portfolio | Matched sold basis | Net proceeds | Realised gain | Realised % | Source display |
|---|---:|---:|---:|---:|---|
| Aus Stocks | A$37,580.00 | A$52,580.00 | A$15,000.00 | 39.9148% | `+ A$15,000.00 (+39.91%)` in `01.png`/`07.png` |
| Aus Sold | A$265,913.11 | A$424,386.60 | A$158,473.49 | 59.5960% | `+ A$158,473.49 (+59.60%)` in `07.png` |
| Aus Super cash sale | A$47,991.00 | A$47,991.00 | A$0.00 | 0% | Consistent with no realised cash gain |

This is the strongest evidence for the realised-gain formula and FIFO matching.

---

# 3.3 Current quote and holding calculations

## Current market value — parcel

For same-currency holdings:

```text
MV_i = q_open_i * P_t
```

For cross-currency holdings:

```text
MV_i_base = q_open_i * P_t_native * FX_t
```

**Observed PLS parcels at A$4.26:**

- 10,000 × 4.26 = A$42,600.
- 5,000 × 4.26 = A$21,300.
- 5,000 × 4.26 = A$21,300.

## Current market value — holding

```text
MV_h = sum(MV_i) = Q_h * P_t [* FX_t]
```

**Observed:** PLS in `01.png`: `20,000 × 4.265 = A$85,300`.

## Absolute daily quote change

```text
PriceChange = P_t - P_prev
```

This value is externally available but can also be calculated from two external fields.

## Daily quote percentage

```text
PriceChangePct = (P_t - P_prev) / P_prev * 100
```

**Observed PLS in `01.png`:** daily amount implies `P_prev = 4.14`; `(4.265 - 4.14) / 4.14 = 3.0193%`, displayed `+3.02%`.

## Holding daily gain — same currency

```text
DailyGain_h = Q_h * (P_t - P_prev)
```

**Observed PLS:** `20,000 × 0.125 = A$2,500`.

## Holding daily percentage

Equivalent same-currency formulations:

```text
DailyPct_h = (P_t - P_prev) / P_prev * 100
```

or

```text
DailyPct_h = DailyGain_h / (MV_h - DailyGain_h) * 100
```

All open parcels of the same security show the same daily percentage.

## Cross-currency daily gain — unresolved choice

Two plausible definitions must not be conflated:

**Full base-currency movement:**

```text
DailyGain_base = Q * (P_t * FX_t - P_prev * FX_prev)
```

This includes overnight/intraday currency movement.

**Security-only movement translated at current FX:**

```text
DailyGain_base = Q * (P_t - P_prev) * FX_t
```

The source behaviour cannot be determined from the AUD examples. The target should choose and label one; full base-currency movement is generally more faithful to the user's actual daily wealth change.

## Unrealised gain

```text
UnrealisedGain_h = MV_h - B_open_h
```

**Observed PLS in `01.png`:** `85,300 - 39,300 = A$46,000`.

## Unrealised percentage

```text
UnrealisedPct_h = UnrealisedGain_h / B_open_h * 100
```

**Observed PLS:** `46,000 / 39,300 = 117.0483%`, displayed `+117.05%`.

For zero cost base, percentage is mathematically undefined/infinite. Display `—` or `n.m.`; never silently divide by a tiny substitute.

## All-time gain

The displayed Aus Stocks value proves at least:

```text
AllTimeGain = UnrealisedGain + RealisedGain
```

because `A$262,423.38 + A$15,000.00 = A$277,423.38` in `01.png`.

The portfolio Details page separately lists dividends, interests and commissions and contains a setting “Dividends reflected in totals”. Therefore the more general formula may be:

```text
AllTimeGain = UnrealisedGain + RealisedGain + IncludedDividends + IncludedInterest - IncludedFees
```

**Uncertainty:** the screenshot example does not prove whether income is included because the relevant income appears to be zero or not represented. The target must make the inclusion rule explicit.

## All-time percentage

The source numbers are consistent with:

```text
AllTimePct = AllTimeGain / (B_open + B_sold) * 100
```

For Aus Stocks, the realised basis from CSV is A$37,580; combining it with the displayed open basis produces the observed percentage within rounding/snapshot differences.

If income is included in the numerator, this remains a simple gain-on-contributed-basis measure; XIRR is needed for a cash-flow/time-aware return.

## Portfolio weight

```text
Weight_h = MV_h / sum(MV for included portfolio positions) * 100
```

The donut includes a small cash slice in the video, indicating cash can be included. Source settings also permit cash omission. The denominator must follow a documented cash-inclusion setting.

---

# 3.4 Portfolio and overview calculations

## Portfolio current value

```text
PortfolioMV = sum(MV_h for included open positions and cash)
```

## Portfolio open cost base

```text
PortfolioOpenBasis = sum(B_open_h)
```

## Portfolio daily gain

```text
PortfolioDailyGain = sum(DailyGain_h)
```

## Portfolio previous-day value

```text
PortfolioPrevValue = sum(Q_h * P_prev_h * FX_prev_h)
```

Positions/cash flows that changed during the day need an explicit cut-off rule.

## Portfolio daily percentage

Most likely:

```text
PortfolioDailyPct = PortfolioDailyGain / PortfolioPrevValue * 100
```

The `01.png` values round to 0.34% under this definition. Dividing by current value also rounds to 0.34%, so the screenshot alone cannot distinguish them. Previous-day value is the financially correct denominator.

## Portfolio unrealised gain and percentage

```text
PortfolioUnrealisedGain = PortfolioMV - PortfolioOpenBasis
PortfolioUnrealisedPct  = PortfolioUnrealisedGain / PortfolioOpenBasis * 100
```

`01.png` validates the percentage: `262,423.38 / 1,004,240.12 = 26.1315%`, displayed `26.13%`.

## Portfolio realised gain and percentage

```text
PortfolioRealisedGain = sum(R_h)
PortfolioRealisedPct  = PortfolioRealisedGain / sum(B_sold_h) * 100
```

Confirmed exactly by CSV and screenshots.

## Portfolio all-time gain and percentage

```text
PortfolioAllTimeGain = PortfolioUnrealisedGain + PortfolioRealisedGain
                        [+ included income - included fees]

PortfolioAllTimePct = PortfolioAllTimeGain
                      / (PortfolioOpenBasis + PortfolioSoldBasis)
                      * 100
```

## Overview totals

For portfolios already in the overview display currency:

```text
OverviewMV = sum(PortfolioMV_p)
OverviewOpenBasis = sum(PortfolioOpenBasis_p)
OverviewDailyGain = sum(PortfolioDailyGain_p)
OverviewUnrealisedGain = sum(PortfolioUnrealisedGain_p)
OverviewRealisedGain = sum(PortfolioRealisedGain_p)
OverviewAllTimeGain = sum(PortfolioAllTimeGain_p)
```

For mixed base currencies, convert each component at a rate appropriate to its measurement:

- current values/gains: current FX;
- historical cost and realised basis: transaction-date FX or stored base-currency amounts;
- historical chart points: FX on each chart date.

Do not convert an entire historical series using today's FX rate.

## Transaction count

Unknown. Candidate definitions:

- count of Buy/Sell rows;
- count of all financial events including dividends/interest;
- count of source ledger rows;
- snapshot mismatch only.

Do not implement until tested.

---

# 3.5 Historical chart calculations

## Holding public price chart — H-SUM

This is externally sourced price history:

- use adjusted or unadjusted prices consistently;
- volume bars share the date axis;
- selected period determines sampling and tick interval;
- range result is likely:

```text
PriceRangeChange = last_visible_price - first_visible_price
PriceRangePct = PriceRangeChange / first_visible_price * 100
```

Whether the source uses adjusted close is unknown.

## Portfolio value chart — P-DETAIL

A plausible reconstruction for each date `d`:

```text
Q_h(d) = quantity owned after all transactions effective on or before d
MV_h(d) = Q_h(d) * historical_price_h(d) * historical_FX_h(d)
PortfolioValue(d) = sum(MV_h(d)) + included_cash(d)
```

This is a value series, not automatically a performance series.

### Range change

```text
RangeAmount = PortfolioValue(end) - PortfolioValue(start)
RangePct = RangeAmount / PortfolioValue(start) * 100
```

**Important uncertainty:** this naïve percentage treats deposits/withdrawals as returns. The source may do this because it labels the selector Portfolio Value, but the target should distinguish:

- **Value** — absolute wealth series including cash flows;
- **Return** — cash-flow-adjusted performance;
- **Cost basis** — optional comparison.

## “Calculate history”

Likely process:

1. fetch missing daily prices/FX;
2. reconstruct quantities and cash by date;
3. recalculate cached daily values;
4. show a completion/error timestamp.

The source shows no captured loading state. Target should display progress and avoid blocking the rest of the app.

## Aggregate all-portfolios chart

```text
OverviewValue(d) = sum(PortfolioValue_p(d) converted to overview currency at FX_d)
```

Portfolios may have different start dates. Missing values before inception should be zero/not-existent, not backfilled with current holdings.

---

# 3.6 Cash-flow-aware returns

## XIRR

The video directly shows Annualized XIRR and Unannualized XIRR fields. Standard XIRR solves for `r` in:

```text
sum(CF_i / (1 + r)^((date_i - date_0)/365)) = 0
```

A portfolio implementation requires a precise cash-flow convention:

- buys and external deposits are not interchangeable;
- sells within the portfolio are internal asset-to-cash movements if cash is tracked;
- dividends may be internal cash flows unless withdrawn;
- ending market value is included as a terminal positive flow;
- withdrawals are negative invested capital / positive return cash flow depending on sign convention.

The source convention is unknown. XIRR should be stage 2 only after deposits, withdrawals and cash are modelled explicitly.

## Unannualized period return

The source lists Unannualized 2Y/5Y/10Y. Possible interpretation is cumulative return over that interval, not an annual rate. Formula depends on cash-flow-adjusted methodology and is not safe to invent.

---

# 3.7 Dividend calculations

## Security dividend yield

The label must state whether it is trailing or forward.

```text
TrailingYield = trailing_12_month_dividends_per_share / current_price * 100
ForwardYield  = expected_next_12_month_dividends_per_share / current_price * 100
```

External providers may already supply a yield; if so, store the provider definition/freshness rather than recomputing from incompatible periods.

## Expected dividend for an event

```text
EligibleShares = shares held according to the chosen ex-date/record-date rule
ExpectedCashNative = EligibleShares * DividendPerShare
ExpectedCashBase = ExpectedCashNative * FX(payment currency -> portfolio currency)
```

The eligibility rule should normally use holdings before the ex-date cut-off, but market settlement and special distributions can complicate this. Mark manual overrides clearly.

## Predicted annual income

```text
PredictedAnnualIncome = sum(ExpectedCashBase for events in next 12 months)
```

## Portfolio forward yield

```text
ForwardYieldOnValue = PredictedAnnualIncome / CurrentPortfolioValue * 100
ForwardYieldOnCost  = PredictedAnnualIncome / OpenCostBasis * 100
```

Display these as distinct metrics; “yield” alone is ambiguous.

## Franking

Store/display:

- cash dividend;
- franking percentage;
- franked cash portion, if useful:

```text
FrankedCashPortion = ExpectedCash * FrankingPct
```

A tax franking-credit calculation depends on company tax rate and user tax context and should not be silently presented as cash income. It can be a separate future tax feature.

## Actual dividend income

For YTD/all-time totals:

```text
DividendIncome = sum(actual dividend receipt amounts in the reporting currency)
```

Do not replace actual receipts with forecasts.

---

# 3.8 Public market statistics

These are primarily external fields, not portfolio calculations:

- day high/low/open/previous close;
- bid/ask and sizes;
- 52-week high/low;
- P/E and forward P/E;
- EPS and forward EPS;
- market cap;
- beta;
- volume/average volume;
- book value, price/book, price/sales;
- shares outstanding;
- one-year target;
- dividend yield.

Where the app calculates a ratio itself, use values from the same provider/date and mark it. Missing values display `—`, not zero.

---

# 3.9 Rounding and number formatting

## Internal precision

Recommended storage/calculation scales:

- quantity: at least 6 decimal places;
- price: at least 8 decimal places;
- FX rate: at least 8 decimal places;
- money/cost basis: at least 4 decimal places internally;
- percentages: calculate from unrounded inputs.

A fixed-scale integer representation in D1 plus a decimal library in the Worker is preferred. Preserve original imported decimal text for audit/round-trip.

## Display rules observed

| Value | Default display |
|---|---|
| Portfolio/holding monetary totals | currency symbol + thousands separators + 2 decimals |
| Security price | minimum 2 decimals, auto-increase for low-priced/instrument precision |
| Average cost | minimum 2 decimals, auto-increase; observed 3–5 decimals |
| Share quantity | thousands separators, minimum 2 decimals |
| Percentages | sign + 2 decimals + `%` |
| Market cap/shares/volume | abbreviated M/B where source does so |
| Positive | explicit `+`, green |
| Negative | `-`/true minus, red or accessible alternative |
| Zero | no positive/negative colour; `0.00` or `—` by semantic meaning |
| Time | local 12-hour in source; target may use locale setting |
| Transaction date | compact `Apr 3, 2025` |

## Auto-increasing price precision

A practical rule:

1. start at configured minimum decimals;
2. increase until the displayed value is non-zero and a meaningful price increment is visible;
3. cap at a safe maximum, e.g. 8;
4. do not remove significant imported precision from average cost.

Examples from screenshots:

- `A$54.60`
- `A$4.265`
- `A$0.085`
- `A$0.79798`
- `0.69989` for FX.

## Sign and colour

Use both sign and colour. This protects comprehension for colour-vision deficiency and in bright outdoor use. A Display setting can switch negative red to amber/yellow, mirroring the source daylight option.

---

# 3.10 Calculation validation examples

## PLS holding — `01.png` and CSV

Transactions:

```text
5,000 @ A$2.50 = A$12,500
5,000 @ A$2.50 = A$12,500
10,000 @ A$1.43 = A$14,300
```

Derived:

```text
Open shares = 20,000
Open cost basis = A$39,300
Average cost = A$1.965
Last price = A$4.265
Market value = A$85,300
Unrealised gain = A$46,000
Unrealised % = 117.05%
Daily change per share = A$0.125
Daily gain = A$2,500
Daily % = 3.02%
```

Every displayed value reconciles.

## PLS parcels — `04.png`

At A$4.26:

| Parcel | Value | Cost | Total gain | Total % |
|---|---:|---:|---:|---:|
| 10,000 @ 1.43 | 42,600 | 14,300 | 28,300 | 197.90% |
| 5,000 @ 2.50 | 21,300 | 12,500 | 8,800 | 70.40% |
| 5,000 @ 2.50 | 21,300 | 12,500 | 8,800 | 70.40% |

The source displays daily parcel gains of A$1,200/A$600/A$600, proving proportional allocation by open quantity.

## CLW holding — `01.png` and CSV

```text
Market value = A$122,760.00
Cost basis = A$138,833.216 -> displayed A$138,833.22
Unrealised gain = -A$16,073.216 -> displayed -A$16,073.22
Unrealised % = -11.58%
```

This confirms that the app rounds components only at display time.

## Realised FIFO — Aus Sold

FIFO on the supplied buys/sells yields exactly:

```text
Realised basis = A$265,913.11
Sale proceeds = A$424,386.60
Realised gain = A$158,473.49
Realised % = 59.60%
```

This matches `07.png` and should become a permanent automated regression test.

---

# 3.11 Interface design principles

## Primary principle

The interface must remain **information-dense**. Do not redesign the lists into one large card per security, increase typography to dashboard scale, or hide cost/daily/total figures behind disclosure taps.

The product's value is that a user can scan many holdings and four financial dimensions at once on an iPhone.

## Target viewport

Design first for approximately 390 × 844 CSS pixels in installed iPhone portrait mode, while remaining usable from roughly 360 px width upward.

Use safe-area insets:

```css
padding-top: env(safe-area-inset-top);
padding-bottom: env(safe-area-inset-bottom);
```

The app shell should occupy `100dvh`, not legacy `100vh`, to handle changing browser chrome.

## App shell vertical stack

Recommended compact dimensions, subject to device testing:

| Region | Visual height |
|---|---:|
| App bar | 48–52 px plus top safe area |
| Main tab strip | 38–42 px |
| Sort/header row | 34–38 px |
| Three-line holding row | 70–78 px |
| Two-line quote row | 58–66 px |
| Expanded bottom summary | 116–136 px plus bottom safe area |
| Collapsed bottom summary | 42–48 px plus bottom safe area |

At 390 × 844, this permits roughly seven to eight holding rows behind an expanded summary, comparable to the source density.

## Sticky/fixed regions

- App bar: sticky at top.
- Tab strip: sticky directly below app bar.
- Column header: sticky below tabs on list screens.
- Bottom summary: fixed/sticky to viewport bottom.
- Main scroll container: only the row/content region.
- Add bottom padding equal to summary height so content is not obscured.

Holding Summary can keep the compact current-price header sticky under its tabs, matching the recording.

---

# 3.12 Typography

Use the platform system stack for speed and iPhone familiarity:

```css
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, Roboto, sans-serif;
font-variant-numeric: tabular-nums lining-nums;
```

Recommended compact sizes:

| Element | Size / line height |
|---|---|
| App-bar title | 18–20 px / 1.1 |
| Main tabs | 12–13 px semibold |
| Column headings | 13–14 px |
| Row line 1 | 16–18 px / ~20 px |
| Row line 2 | 13–15 px / ~18 px |
| Row line 3 | 12–13 px / ~16 px |
| Summary line 1 | 16–18 px |
| Summary secondary lines | 13–15 px |
| Settings/form label | 15–17 px |
| Settings description | 12–14 px |

Input text should be at least 16 px on iPhone to prevent automatic Safari zoom, even if surrounding display text is smaller.

Use weight, colour and alignment rather than oversized type to establish hierarchy.

---

# 3.13 Colour and surface tokens

The exact brand palette can be restyled, but semantic behaviour must remain consistent.

Suggested dark tokens:

```text
app background       #202220 to #252525
row background       same as app; no individual cards
raised/header panel  #343636 to #3B3B3B
primary text         near-white
secondary text       medium-light grey
positive             vivid green
negative             vivid red/coral
negative-accessible  amber/yellow option
accent/navigation    brand accent
separator            low-contrast grey
```

Rules:

- Positive and negative colour applies to both amount and percentage.
- Do not colour current value or cost merely because the holding is profitable; those remain neutral.
- Active tab text and underline use the navigation accent.
- Avoid gradients and large decorative surfaces.
- Use subtle separators or vertical rhythm, not thick card borders.

---

# 3.14 Core grid layouts

## Holdings row

Recommended four-column proportions:

```css
grid-template-columns:
  minmax(76px, 23%)
  minmax(112px, 31%)
  minmax(78px, 22%)
  minmax(82px, 24%);
```

At very narrow widths, tune proportions rather than introducing horizontal scrolling.

Row structure:

```text
line 1: [ticker]       [market value] [daily amount] [total amount]
line 2: [last price]   [cost basis]   [daily %]      [total %]
line 3: [average × shares -------------------------]  (span columns 1–2 or 1–3)
```

- Ticker/description left aligned.
- All numeric cells right aligned.
- No wrapping in numeric cells.
- Third line is secondary and may be hidden by a Display setting.
- Full row is one tap target.

## Quotes row

Suggested proportions:

```css
grid-template-columns: 46% 27% 27%;
```

```text
line 1: [symbol] [last price] [absolute change]
line 2: [name]   [update time] [percentage change]
```

Name uses ellipsis.

## Transaction row

```css
grid-template-columns: 25% 31% 22% 22%;
```

```text
line 1: [shares]       [current value] [daily amount] [total amount]
line 2: [@ buy price]  [parcel cost]   [daily %]      [total %]
line 3: [date - type --------------------------------]
```

Date/type is smaller with only 2–4 px top gap.

## Portfolio overview row

Use the same four-column grid for lines 1–2. Lines 3–4 span the width:

```text
line 3: All-Time: + A$... (+...%)
line 4: Realized: + A$... (+...%)
```

This common grid reduces implementation inconsistency.

## Summary panel

Mirror the active list's numeric columns so totals align visually with row values. Labels occupy the left/ticker column; amounts right align under their columns.

---

# 3.15 Headers, sorting and filtering

## Column header

- One compact raised strip.
- Entire column cell is tappable, not only the arrow.
- Active sort arrow uses accent colour; inactive arrows remain subdued.
- Accessible label includes key and direction, e.g. `Sorted by daily percentage, descending`.
- Tap active column reverses direction.
- A long press should not be required.

## Filtering

No source filter is visible on holdings. When added:

- use one compact app-bar/filter button;
- show active-filter count;
- filter sheet rather than an always-visible large search field;
- preserve the four-column header and row density.

Core list screens should not horizontally scroll. A secondary fundamentals table may scroll only if a responsive two-column arrangement cannot accommodate a future field set.

---

# 3.16 Touch targets and accessibility

Dense visual design and adequate touch targets are compatible:

- icon glyph: 20–24 px inside a 44 × 44 px button;
- tab visual height ~40 px with hit area extended to at least 44 px;
- holding rows already exceed 44 px;
- column headers should have at least 36 px visual height and 44 px effective hit region where possible;
- summary Show/Hide link should have padded hit area;
- transaction edit/delete actions must be explicit and not rely only on swipe.

Use visible focus states for keyboard/assistive technology. Announce refreshed values without reading the entire list. Do not rely on red/green alone; signs and optional icons remain.

## Dynamic type

The default must stay compact. Provide a bounded app-level font scale/density setting rather than allowing a layout-breaking unlimited scale without adaptation. At larger accessibility sizes, allow a two-column or detail-on-tap fallback while preserving all data access.

---

# 3.17 Charts

## Visual treatment

- dark integrated background, not a large separate card;
- 1–2 px line;
- restrained gridlines;
- concise axis labels;
- no unnecessary legend for a single series;
- active period accent-coloured;
- touch/drag crosshair can show exact date/value in stage 2;
- chart is vertically compact enough that controls and some analysis remain visible in one screen.

## Loading/error

- show last cached series immediately;
- subtle inline progress for recalculation;
- retain old chart on fetch failure with stale indicator;
- never replace chart with a blank white area.

---

# 3.18 Forms and dialogs

## Full-page forms

Use full-page routes for Add Portfolio, Add Transaction and Edit Transaction. They are easier to use with the iPhone keyboard than small modals.

- compact section headings;
- 16 px input text;
- numeric input modes;
- date picker uses native control where reliable;
- persistent save action in app bar or bottom action region;
- inline validation near field;
- unsaved-change confirmation only when dirty.

## Destructive actions

Delete transaction/portfolio confirmation must identify:

- object being deleted;
- number of affected transactions where relevant;
- recalculation consequence;
- whether watchlist membership remains.

## Import preview

Use a full screen or tall sheet with:

- filename/schema;
- counts;
- warnings/errors;
- portfolio mapping;
- duplicate strategy;
- explicit commit button.

Do not dump raw CSV as the only preview; the source does so for export, but import requires structured review.

---

# 3.19 Loading, refresh and stale states

The video shows no obvious spinner, but the web rebuild needs explicit states:

- initial shell loading;
- authenticated but first data load;
- manual quote refresh in progress;
- quote partially failed;
- stale price;
- missing price;
- historical calculation queued/running/failed;
- import parse/commit progress.

Price row status should be compact, e.g. update time text and a small stale icon, not a full-width alert for every row.

When refreshing, calculate each row from a coherent quote snapshot. Avoid showing a new price with old daily change or old FX.

---

# 3.20 iPhone/PWA-specific layout requirements

- Respect notch/Dynamic Island and home indicator safe areas.
- Use `100dvh` and test with installed standalone mode and Safari mode.
- Keep fixed bottom summary above `safe-area-inset-bottom`.
- Prevent body overscroll from moving the entire shell; scroll the designated content container.
- Preserve state across PWA suspension/resume.
- On Access session expiry, show a clear re-authentication state rather than an embedded login redirect inside a data panel.
- Do not cache private API JSON in a generally readable service-worker cache by default.
- Test the portfolio selector, drawer and keyboard at 320–430 px widths and with browser zoom/accessibility settings.

