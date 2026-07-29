# YieldToMe UI specification

Status: owner-directed revision 1; revised patterns await visual confirmation  
Date: 2026-07-29  
Task: `UI-PROT-001`  
Requirements: `PRD-003`, `PRD-004`, `PRD-005`, `QUAL-001`

## 1. Scope and approval boundary

This document records the first static prototype for visual review before production UI tasks begin. It is intentionally built from local mock strings and contains no authentication, D1 access, market-data request, import, or financial mutation.

The patterns below are candidates, not final product decisions. After owner review, each accepted pattern should be marked approved and each rejected pattern should be revised or removed. Production tasks `UI-001` through `UI-005E` remain pending.

| Pattern                                                                           | Review status               |
| --------------------------------------------------------------------------------- | --------------------------- |
| Dark edge-to-edge application shell                                               | Awaiting owner feedback     |
| Five-item Overview / News / Quotes / Holdings / Details tab strip                 | Revised from owner feedback |
| Four-column, three-line mobile holding row with gain/loss colour                  | Revised from owner markup   |
| Fixed four-line mobile / side-rail desktop portfolio summary                      | Revised from owner markup   |
| Compact two-line Quotes row                                                       | Awaiting owner feedback     |
| Integrated chart and list treatment without large cards                           | Awaiting owner feedback     |
| Prototype state selector for populated, empty, partial, and provider-error states | Awaiting owner feedback     |

## 2. Evidence applied

- `docs/YieldToMe_Visual_Style_Guide.md`: near-black green background, warm-white type, fresh green accent, fine dividers, restrained editorial headings, and the four-bar brand mark.
- `docs/01_SCREEN_INVENTORY_AND_NAVIGATION.md`: persistent portfolio shell, anchored selector, dense sort row, three-line holdings, two-line quotes, sticky totals, direct holding drill-down, and simple long-form analysis.
- `docs/03_CALCULATIONS_AND_INTERFACE.md`: four-column proportions, compact typography, 44 px aggregate targets, no mobile horizontal page scroll, and 70–78 px holding rows.
- `docs/04_VIDEO_UNKNOWNS_AND_REBUILD_PLAN.md`: immediate tab changes, portfolio selector, drawer, row-level navigation, explicit empty/error behavior, and read-only fixture UI before production mutations.
- Reference `01.png`: information density, line ordering, right-aligned numeric columns, active sort affordance, and fixed summary behavior.

The screenshot and CSV fixtures are independent references. Prototype values reproduce the screenshot’s density and familiar ASX examples; they are not production calculations or a reconciled portfolio.

## 3. Shell dimensions

Measured at the 390 × 844 CSS-pixel review viewport:

| Region                  | Candidate rule                                                                    |
| ----------------------- | --------------------------------------------------------------------------------- |
| App bar                 | 52 px visual height; measured 53 px including border; safe-area inset added above |
| Primary tabs            | 42 px                                                                             |
| Sort/header strip       | 31 px minimum height; measured 32 px including border                             |
| Holding row             | 76 px, three lines                                                                |
| Quote row               | 60 px, two lines                                                                  |
| Mobile summary          | measured approximately 97 px at 390 px and 93 px at 320 px, plus safe-area offset |
| Mobile page edge        | 10 px left / 5 px right inside holding rows; 12 px on overview/details            |
| Desktop content maximum | 1,440 px                                                                          |

The app bar, tab strip, and list header are sticky. The mobile portfolio summary is fixed 5 px from the viewport edges and above `safe-area-inset-bottom`. Holdings content receives bottom padding so the final row can scroll fully above the summary.

## 4. Typography

All data uses tabular lining numerals. Interface copy uses the platform sans-serif stack; compact analytical headings use the editorial serif from the brand system.

| Element                  | 390 px candidate                          | 320 px adaptation   |
| ------------------------ | ----------------------------------------- | ------------------- |
| Portfolio selector       | 16.5 px, semibold                         | unchanged           |
| Primary tab              | 10.9 px, bold, uppercase                  | 9.9 px              |
| Column heading           | 10.7 px, bold                             | 9.8 px              |
| Holding line 1           | 15.5 / 19 px                              | 12.5 / 19 px        |
| Holding line 2           | 12.2 / 17 px                              | 10.9 / 17 px        |
| Holding line 3           | 11.2 / 16 px                              | 10.1 / 16 px        |
| Quote line 1             | 15.5 / 19 px                              | 12.5 / 19 px        |
| Overview/detail headline | responsive; approximately 35 px at 390 px | approximately 30 px |
| Section heading          | approximately 19.7 px serif               | unchanged           |
| Supporting metadata      | 9.5–12 px                                 | lower end of range  |

Input text is not part of this prototype. Production forms must retain a minimum 16 px input size on iPhone to avoid browser zoom.

## 5. Holdings pattern

### 5.1 Mobile grid

```text
21% Ticker | 32% Value/Cost | 23% Daily | 24% Total
```

Line 1 shows ticker, market value, daily amount, and total unrealised amount. Line 2 shows price, open cost, daily percentage, and total unrealised percentage. Line 3 shows average open cost × quantity.

When a row line contains a single item, that item spans the available holding-row columns rather than determining the width of one column. On mobile this applies to the average open cost × quantity line; it may truncate with an ellipsis when the viewport is too narrow. Desktop may reserve a separate right-hand metadata item on the same line.

Market value and open cost retain their currency prefix. Daily and Total amounts omit the repeated `A$` prefix in the compact grid because the portfolio reporting currency is already established by context; signs remain explicit. Positive amounts and percentages are green, and negative amounts and percentages are red. This gain/loss treatment applies consistently across the prototype. No financial dimension is removed.

The initial sort is Daily percentage descending to match the strong reference inference. Tapping a different header selects that key; tapping the active header reverses direction. Active direction is expressed by text/ARIA state and a green arrow, not colour alone.

### 5.2 Row navigation

The full 76 px row is one touch target. It opens a compact holding sheet that exposes:

- security name, exchange, and native currency;
- full amounts with currency;
- quantity and average cost;
- a location for future price, FX, source, observation-time, and FIFO-lot explanation.

The row does not expose swipe or long-press actions.

### 5.3 Summary

Mobile totals align to the four holding columns. The fixed four-line state shows:

- Unrealised or Known value;
- portfolio value, daily movement, and unrealised gain;
- cost, daily percentage, and unrealised percentage;
- realised gain and percentage, left aligned;
- all-time gain including realised gains and its percentage, left aligned.

The Unrealised label is left aligned. At 390 px, the first-line portfolio value is 15.0 px and its gain figures are 14.7 px; lower summary lines remain 11.8 px. Summary monetary values are rounded to whole dollars using exact decimal-string parsing; percentages retain their supplied precision. The detail toggle and coverage footnote are removed. Desktop moves the same summary into a 318 px side rail rather than stretching it across the viewport.

## 6. Other principal screens

### Overview

- One dominant current-value figure, followed by compact Invested, Cash, and Unrealised facts.
- A low-chrome bar history treatment with text alternative.
- Portfolio rows reuse the four financial columns instead of large portfolio cards.
- An Overview row navigates to the selected portfolio’s Holdings screen.

### Quotes

- `44% / 29% / 27%` grid for ticker/name, last price/date, and change/percentage.
- Two-line 60 px rows.
- Company names ellipsize; prices and changes never wrap.
- Routine source, provider, delay, and exact timestamp are absent from the compact row. A business-relevant date is retained.

### Details

- Current value, range movement, compact chart, and period controls form one continuous section.
- Analysis uses a divider list rather than metric cards.
- Largest-position allocation uses thin bars and a percentage.
- Desktop reflows chart and analysis into two columns.

### News

The route and tab are present, but the screen explicitly says that no provider is connected. No unattributed article content is fabricated.

## 7. Responsive rules

### 320 px

- No document-level horizontal overflow.
- All four holding columns remain visible.
- Holding line 1 steps down to 12.5 px; line 2 to 10.9 px; line 3 to 10.1 px.
- Five tabs fit without horizontal scrolling.
- App actions stay icon-only with accessible names.
- The four-line summary remains four-column and measures 93 px high.

### 390 px

- Default iPhone review width.
- Holding line 1 is 15.5 px and the row remains 76 px.
- All eight fixture rows remain visible above the summary at 844 px height.
- Overview, Quotes, and Details have no horizontal overflow.

### 430 px

- Typography and row height remain unchanged.
- Additional width becomes inter-column breathing room; no extra card padding is introduced.
- All eight fixture rows and the summary can be scanned comfortably in a 900 px-tall viewport.

### 700 px and wider

- App bar becomes 60 px and adds the wordmark plus a visible `Prototype · mock data` badge.
- Holdings becomes a table plus 318 px sticky summary rail.
- Security name, exchange, and currency appear on the row’s third line at the right.
- Overview becomes history plus portfolio-list columns.
- Details becomes a large chart plus analysis column.
- Quotes center within a maximum 1,080 px table.

## 8. Information hidden or relocated on mobile

No price, quantity, market value, daily movement, cost basis, or total gain field is hidden from the mobile Holdings row.

The following secondary information is relocated:

| Information                                | Mobile treatment                                 |
| ------------------------------------------ | ------------------------------------------------ |
| Full security name                         | Holding detail sheet                             |
| Exchange and native currency               | Holding detail sheet                             |
| Desktop prototype badge                    | Drawer note                                      |
| Price/FX source and exact observation time | Future accessible row explanation                |
| Desktop wordmark                           | Navigation drawer                                |
| Desktop side summary                       | Fixed bottom summary                             |
| Action text labels                         | Accessible icon-button names and action popovers |
| Priced-holding/AUD summary footnote        | Removed from compact totals; retained in states  |

Exact timestamps remain a detail/audit concern. Compact lists show a business date only when it helps interpretation.

## 9. Empty and error states

The overflow state menu is a review aid and is not a proposed production control.

- **Empty portfolio:** no fabricated zero totals; shows next-step guidance.
- **Partial pricing:** one holding displays `Price unavailable`; its value and dependent movement/gain are unavailable; the summary changes to `Known value`, reduces the included totals, and names priced coverage.
- **Provider unavailable:** retains last-known values and displays one specific banner; it does not blank the table or replace values with zero.
- **Populated portfolio:** default fixture state.

## 10. Interaction and accessibility rules

- Icon buttons and navigation controls have at least 44 × 44 px targets.
- Rows exceed 44 px and are fully clickable.
- Keyboard focus is visible with a high-contrast green outline.
- Sort state is exposed through accessible button names and pressed state.
- Positive and negative figures retain explicit `+`, `−`, and directional language; colour is supplemental.
- The history chart has a text alternative.
- Reduced-motion preferences suppress nonessential animation.

## 11. Rendered review evidence

Principal 390 px captures:

- [Overview](ui-captures/overview-390.png)
- [Holdings](ui-captures/holdings-390.png)
- [Quotes](ui-captures/quotes-390.png)
- [Details](ui-captures/details-390.png)

Holdings breakpoint captures:

- [320 px](ui-captures/holdings-320.png)
- [430 px](ui-captures/holdings-430.png)
- [Desktop](ui-captures/holdings-desktop.png)

Browser checks confirmed document width equals viewport width at 320, 390, 430, and 1,440 px. Sorting, portfolio/drawer/add/state menus, holding drill-down, empty state, partial pricing, and provider-error state were exercised.

## 12. Feedback requested

Revision 1 applies the owner’s marked-up Holdings feedback: the header and summary are each approximately 13–14% shorter; gain/loss colours apply to both numeric lines; the summary uses whole dollars, left-aligned Unrealised/Realised/All-Time labels, and no detail toggle. Follow-up feedback restores Overview as the first tab, followed by News, Quotes, Holdings, and Details, and slightly enlarges the first-line summary figures.

Before marking the revised pattern approved, review:

1. Whether the 390 px Holdings row feels as readable and dense as the reference.
2. Whether Daily and Total should continue omitting the repeated `A$` prefix in compact rows.
3. Whether the revised four-line, approximately 97 px summary has the intended balance of density and readability.
