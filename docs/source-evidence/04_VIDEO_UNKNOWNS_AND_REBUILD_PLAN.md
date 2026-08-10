# 4. Video observations, unresolved questions and rebuild plan

## 4.1 Evidence labels used in this file

- **Observed** - visible in `Video.mp4` or one of `01.png` through `12.png`.
- **User requirement** - explicitly requested in the supplied brief.
- **Confirmed from CSV** - reproducible from `portfolio.csv`.
- **Inferred** - strongly suggested by the evidence but not directly demonstrated.
- **Proposed** - recommended behaviour for the rebuild; not a claim about the Android app.
- **Unknown** - cannot be established confidently from the supplied material.

Video times below are approximate. They are intended as navigation aids, not frame-accurate edit points.

---

# 4.2 Video observations

## 4.2.1 Recording-level observations

| Observation | Evidence status | Product implication |
|---|---|---|
| The recording is approximately 1 minute 45 seconds long, portrait orientation and silent. | Observed | There is no audio narration to disambiguate intent. Behaviour has to be inferred from visible taps and resulting states. |
| Grey circles briefly appear at tap locations. | Observed | These are Android developer/show-taps indicators, not part of the app and must not be reproduced. |
| Android notification banners and the notification shade appear near the end. | Observed | These are operating-system overlays, not application screens. Exclude them from the product inventory. |
| The app responds rapidly to most navigation taps, with no obvious full-screen loading state. | Observed | The rebuild should preserve immediate local navigation and retain existing data while network refreshes occur. |
| The recording does not demonstrate a network failure, invalid form, import error or destructive confirmation. | Observed | Error and validation behaviour remains a design requirement rather than source behaviour that can be copied. |

## 4.2.2 Timestamped interaction log

### 00:00-00:04 - Main portfolio tabs

**Observed**

1. The recording opens on a selected portfolio's **Holdings** tab.
2. The user taps **Quotes** and the content changes to the compact two-line quote list.
3. The user returns to **Holdings**.
4. Tab switching changes the active underline and content without a page transition.
5. The app bar, portfolio selection and tab strip remain structurally stable across these changes.

**Implications for the rebuild**

- Use route-aware tabs but render them as one persistent portfolio shell.
- Switching tabs should not discard the selected portfolio, sort state or scroll state unnecessarily.
- A network request may occur, but already available data should paint immediately.

### 00:04-00:10 - Portfolio Details/analysis

**Observed**

1. The user taps **Details**.
2. The top section shows the portfolio-history chart, range controls and allocation chart.
3. The user scrolls vertically through the page.
4. Additional sections appear below the screenshot crop, including:
   - allocation/donut chart;
   - **View Activity**;
   - YTD figures;
   - all-time return figures, including XIRR-labelled values;
   - realised and unrealised sections;
   - calculation switches/options.
5. The page uses one continuous vertical document rather than nested cards or separate drill-down screens.

**Not demonstrated**

- No time-range option is tapped.
- **Calculate history**, **Compare**, the chart selector, the inner-ring selector and the gear are not exercised.
- No chart loading indicator or calculation progress state is shown.

### 00:10-00:28 - Holding drill-down and holding tabs

**Observed**

1. The user selects a holding row, opening a holding-level screen.
2. The first visible holding tab is **Transactions**, consistent with the user's stated default.
3. The app bar changes from the portfolio shell to a child-screen shell with a back arrow and the security identity.
4. The user taps **Summary**.
5. The Summary page displays a price chart followed by dense market/fundamental fields.
6. The user scrolls down to additional **Notes** and **News** sections that are not visible in `05.png`.
7. The user returns to **Transactions**.
8. The user opens the source **Details** tab and scrolls a holding-value history/performance page.
9. The user presses back and returns to the parent portfolio rather than to a new root screen.

**Observed contextual actions**

- On the Transactions tab, the upper-right contextual action is a plain plus, likely **add transaction**.
- On the Summary tab, the action changes to a bell-plus icon, likely **add price alert**.

**Inferred, not proven**

- The holding row itself is the entire touch target, not only the ticker text.
- A child screen probably retains its previously selected tab during a short back-and-forth session, but the recording does not establish persistence after a reload.

### 00:29-00:33 - Portfolio selector

**Observed**

1. Tapping the portfolio name/dropdown opens a compact anchored selection panel.
2. The panel lists named portfolios.
3. The panel also exposes **+ Add** and **Overview** destinations.
4. Selecting a different portfolio changes the active portfolio while preserving the current top-level portfolio tab.
5. The selector closes immediately after selection.

**Product implication**

- The portfolio selector is both a switcher and a fast navigation menu.
- The target should reproduce this efficient path rather than force users through a separate management screen for every switch.

### 00:33-00:44 - A second holding and chart interaction context

**Observed**

1. After switching portfolios, the user opens another holding.
2. The selected holding opens to Summary during this segment.
3. The user scrolls through the chart and fundamental data.
4. Multiple time ranges are visible, but none is clearly selected during the recorded interaction beyond the initial state.
5. Back returns to the selected portfolio.

**Implication**

- Holding navigation must be portfolio-specific even where the same symbol could exist in more than one portfolio.
- The route should identify both `portfolio_id` and `security_id` or a portfolio-security association, rather than using ticker alone.

### 00:46-00:53 - Repeated main-tab navigation and drawer opening

**Observed**

1. The user moves through Quotes, Holdings and Details again.
2. The user opens the hamburger menu.
3. The drawer slides in from the left over a darkened scrim.
4. The underlying page remains visible and appears unchanged.

**Product implication**

- The target can use a left sheet/drawer on mobile.
- The drawer should be dismissible by tapping the scrim, using the close/back action and likely by swiping, although a swipe dismissal was not demonstrated.

### 00:55-01:00 - Market News and Add Portfolio

**Observed: Market News**

1. The user opens **Market News** from the drawer.
2. The page has a compact app bar with menu, filtering/settings actions and a vertically scrolling feed.
3. Feed items expose a headline, publisher/time context and an excerpt or media area.
4. Sponsored/advertising content appears in the source app.

**Target decision**

- Do not reproduce source advertising.
- Reuse useful feed conventions for the requested **News** tab.

**Observed: Add Portfolio form**

1. The user opens **Add Portfolio** from the drawer.
2. The Name field is focused automatically and the keyboard opens.
3. Visible fields include:
   - portfolio name;
   - default accounting method, shown as FIFO;
   - a switch to add commission for new non-dividend/non-interest transactions;
   - a Display section below the initial viewport.
4. A checkmark in the app bar appears to be the save action.
5. The user leaves the empty form without saving.

**Not demonstrated**

- Empty-name validation.
- Duplicate-name validation.
- Whether unsaved changes cause a confirmation prompt.
- Whether the accounting method can be changed after transactions exist.

### 01:00-01:08 - Drawer and Settings entry

**Observed**

1. The user returns to the drawer.
2. The portfolio list is integrated into the drawer rather than hidden behind a second screen.
3. The user selects **Settings**.
4. Settings opens as a simple list of categories, not as large dashboard cards.

**Product implication**

- Preserve fast direct access to frequently used settings and import/export.
- Remove source-only entries such as Premium and Server Sync from the rebuild.

### 01:09-01:13 - Import/Export and export preview

**Observed**

1. The user opens the Import/Export settings page.
2. The source distinguishes portfolio data, price alerts and custom prices.
3. The user selects portfolio **Export as CSV**.
4. A dedicated export screen appears with a raw CSV preview.
5. Visible actions include:
   - **Export to File**;
   - **Export to Email**;
   - **Copy to Clipboard**.
6. The user backs out without completing a share-sheet action.

**Implications for the web rebuild**

- Generate the file server-side or deterministically in the Worker, then offer:
   - Download CSV;
   - Share, when the Web Share API supports files;
   - Copy text as a secondary action.
- A preview is useful for diagnostic parity but is not required for the first implementation if the import/export format is well documented.

**Not demonstrated**

- CSV import file selection.
- Preview/mapping before import.
- Duplicate handling.
- Error reporting by row.
- Export encoding, line endings or quoting edge cases.

### 01:15-01:34 - General and Display settings

**Observed: General**

The user opens General and scrolls through settings including:

- auto-refresh interval;
- display currency;
- starting screen;
- starting portfolio tab;
- starting quote-details tab;
- keep screen alive;
- confirm when exiting;
- portfolio sort order;
- opening news in an external browser.

**Observed: Display**

The user opens Display and scrolls through a long, compact preference list including:

- theme;
- font size;
- language;
- whether percentages appear on top;
- daylight font colour;
- news thumbnails;
- quote-line content and precision;
- holding-line content and precision;
- inline shares/average price;
- inline all-time, realised and YTD returns;
- notes visibility.

**Product implication**

- The source app derives much of its density from configurable line content.
- The rebuild does not need every switch in v1, but its row component should be architected so secondary and tertiary lines can be toggled without rewriting each screen.

### 01:37-01:42 - News, Overview and row navigation

**Observed**

1. The user returns to Market News.
2. The drawer opens again.
3. The user opens **Portfolio Overview**.
4. The overview shows the compact multi-portfolio table.
5. Tapping a portfolio row opens that portfolio's Holdings tab.
6. The Android notification shade is pulled down after this point; this is outside the app.

**Product implication**

- An overview row is navigational.
- Use the entire row as the primary touch target while keeping any inline actions secondary.

---

# 4.3 Behaviour matrix from the video

| Behaviour category | Directly observed | Not observed / unresolved | Target recommendation |
|---|---|---|---|
| Taps | Tabs, holding rows, portfolio rows, selector, drawer destinations, back, settings items | Long press, double tap | Use single-tap primary interactions; do not require long press for essential actions. |
| Gestures | Vertical inertial scrolling; notification shade outside app | Horizontal row scroll, tab swipe, drawer swipe-dismiss, chart pinch/drag | Avoid required horizontal gestures. Allow chart inspection gestures only as enhancement. |
| Screen transitions | Instant tab content swap; child push/back; left drawer slide; anchored selector | Modal animation, destructive confirmation | Use short native-feeling transitions; respect reduced-motion preference. |
| Menus | Hamburger drawer; portfolio selector popup | Overflow-menu content | Omit unexplained overflow menu; place actions explicitly. |
| Forms | Add Portfolio focus and keyboard; settings switches | Add/edit holding, transaction form, validation | Build conventional labelled forms with inline errors and explicit Save/Cancel. |
| Loading | No visible loading in demonstrated paths | Price refresh, history calculation, import/export progress | Keep old data visible; show small in-context progress and last-updated state. |
| Refresh | Refresh icon exists; news refresh icon exists | Refresh tap and scope | Specify refresh scope explicitly and expose partial failures. |
| Sorting | Sort chevrons are visible in table headers | Sort taps, direction cycle, null handling, persistence | Implement deterministic sort with active column and direction; test against source. |
| Scrolling | Long vertical pages; fixed-looking bottom summaries in list views | Horizontal scrolling | Avoid horizontal scrolling in primary tables at iPhone portrait width. |
| Animations | Drawer and standard Android navigation motion | Chart animation details | Keep motion brief and subordinate to data readability. |
| Confirmation | None demonstrated | Delete, unsaved edits, invalid imports | Add confirmation only for irreversible actions; support undo where practical. |
| Background state | App remains responsive during recording | Return from background, stale sessions | Refresh stale data on resume without replacing visible content prematurely. |

---

# 4.4 Unknowns and specific follow-up tests

The following tests are ordered roughly by implementation risk. P0 questions affect accounting correctness or core workflow. P1 questions affect important parity. P2 questions are useful refinements.

## 4.4.1 P0 - Accounting and data integrity

| Unknown | Why it matters | Specific Android-app test | Record |
|---|---|---|---|
| Exact FIFO treatment of partial sales | Realised gain and remaining cost base depend on it. | In a clean test portfolio, buy 100 shares at 10, buy 100 at 20, then sell 150 at 30. Expected conventional FIFO result: remaining 50 shares with cost 1,000; realised proceeds 4,500 before fees; realised cost 2,000; realised gain 2,500. Capture transaction and summary screens plus CSV export. | Screenshots, CSV and displayed realised/unrealised figures. |
| Commission allocation | Buy fees may be added to basis and sell fees deducted from proceeds. | Buy 100 at 10 with commission 10; sell 40 at 20 with commission 5. Compare displayed open cost, average price, realised cost and realised gain. | Every displayed total and exported commission fields. |
| Whether sell `Cost Per Share` in CSV is sale price | This was inferred and validated on the supplied data, but format documentation should be explicit. | Create one new sale at a distinctive value such as 12.3456 and export immediately. | Raw definition and transaction rows. |
| Overselling validation | The ledger must not silently allow negative holdings unless short positions are supported. | Attempt to sell more shares than held. Also attempt a sale in a watch-only security. | Validation text and whether save is blocked. |
| Same-day transaction ordering | FIFO and history can change when several transactions share a date. | Add two buys and one sell on the same day with deliberately different times; export and reopen the holding. | Sort order, stored time and calculation outcome. |
| Transaction editing invalidation | Editing an old transaction must recalculate all later lots and history. | Create a buy, later sell and later buy; edit the first buy price and quantity. Observe holding, realised gain, portfolio totals and graph. | Before/after captures and any recalculation prompt. |
| Transaction deletion consequences | Deleting a matched buy may make a later sale invalid. | Create buy then sale; attempt to delete the buy. | Whether blocked, cascaded, recalculated or warned. |
| Realised percentage denominator | The source screenshot suggests realised gain divided by realised cost basis, but this should be proven across losses. | Buy at 100 and sell at 80. Observe realised amount and percent. | Displayed percentage and CSV. |
| All-Time return composition | It may include realised plus unrealised and optionally dividends/interest/fees. | Create a test portfolio with one buy, partial sale, dividend, interest and commissions. Toggle the calculation options seen in the Details screen. | Each all-time figure before and after every toggle. |
| Transaction count definition | Overview count may include buys/sells only, or also dividends, interest and definition rows. | Add one of each transaction type and observe the count after every addition. | Count sequence. |

## 4.4.2 P0 - Currency and price semantics

| Unknown | Why it matters | Specific Android-app test | Record |
|---|---|---|---|
| Meaning of blank versus zero Purchase Exchange Rate | The supplied CSV contains blank and `0`; zero is likely an auto/unspecified sentinel. | Add a foreign-currency buy using automatic FX, then another using a manually entered FX rate. Export both. | Exact CSV fields and displayed cost. |
| FX conversion direction | A reversed rate produces large but plausible errors. | In an AUD portfolio, buy USD 100 of a test security while forcing a distinctive rate such as 1 USD = 1.5 AUD. Compare native and AUD costs. | Labels, stored rate and converted cost. |
| Historical versus current FX for cost | Cost should generally use transaction-date FX while market value uses current FX. | Buy a USD security, note cost, then alter/customise the current FX quote without editing the transaction. | Which values and gains change. |
| Daily gain for foreign holdings | It can include security movement, FX movement, or both. | Use a foreign security with a custom unchanged price, then change only the FX rate. | Holding and portfolio daily amount/percent. |
| Price used outside market hours | Last trade, regular close and extended-hours prices may differ. | Observe a US holding before open, during market, after close and after an extended-hours move. | Price label, timestamp and daily change. |
| Stale-price handling | A failed quote must not be mistaken for zero. | Disable network access, force refresh and reopen the app. | Error indicators, retained value and timestamp. |
| Manual/custom price precedence | Source app has custom-price import/export. | Set a manual price, refresh market data, restart and export. | Whether manual price survives and how it is labelled. |

## 4.4.3 P0 - CSV import and export

| Unknown | Why it matters | Specific Android-app test | Record |
|---|---|---|---|
| Duplicate import strategy | A repeated import could duplicate every transaction. | Export a small portfolio and import the same file twice. | Prompts, counts and whether IDs make import idempotent. |
| Merge versus replace | Users need a safe mental model. | Import a file into a portfolio that already contains one matching and one unrelated security. | Whether data merges, replaces or asks. |
| Duplicate transaction identity | Source IDs may or may not be trusted. | Duplicate one transaction row but give it a new ID; then duplicate it with the same ID. | Imported rows and warnings. |
| Blank lines and trailing columns | The supplied CSV has many blank rows and a padded Notes header. | Import the supplied file unchanged, then a cleaned version. | Row counts and any warnings. |
| Unknown extra columns | Source exports differ: the video preview has more columns than the supplied file. | Add an arbitrary column to an exported CSV and import it. | Whether ignored, preserved or rejected. |
| Missing required fields | Import must identify actionable row-level errors. | Remove Symbol, Portfolio, Type, date, quantity and price from separate copies of one transaction row. | Error wording and row numbers. |
| Decimal and locale parsing | iPhone locale and exported CSV decimal conventions can conflict. | Try `1234.56`, `1,234.56` and `1234,56` in controlled files. | Accepted values and errors. |
| Quoting and line breaks in Notes | CSV round-trip must preserve user text. | Enter commas, quotes and a line break in a note; export and reimport. | Raw CSV quoting and restored text. |
| Character encoding | Company names and notes may contain non-ASCII characters. | Use accented, Japanese and emoji text in names/notes, then round-trip. | Encoding and displayed result. |
| Export scope | It is unclear whether export is all portfolios or selectable. | Start export from different selected portfolios and compare files. | Included portfolios and UI choices. |
| Date/time zone normalisation | Source stores dates with GMT offsets and separate time fields. | Create transactions just before and after midnight and across daylight-saving change. | UI date, exported date/time and order after reimport. |
| Watch-only entry grammar | Definition rows with no transactions must survive. | Add a watch-only quote, export, delete and reimport it. | Rows generated and restored state. |

## 4.4.4 P1 - Main-list behaviour

| Unknown | Why it matters | Specific Android-app test | Record |
|---|---|---|---|
| Header sort key for Daily and Total | It could sort by amount or percentage. | Construct two holdings where the larger dollar gain has the smaller percentage gain; sort Daily and Total. | Result order for each tap. |
| Sort direction cycle | May be ascending/descending only or include default. | Tap the same header three times and reopen the app. | Chevron and row order after each action. |
| Sort persistence | Determines whether users can establish a preferred view. | Select a non-default sort, switch tabs/portfolios, close and reopen. | Which scope retains it. |
| Null/watch-only ordering | Watch-list quotes may lack cost or gain. | Mix held and watch-only securities, then sort every column. | Null placement. |
| Row tap destination on Quotes | It may open Summary, Profile or last-used holding tab. | Tap a held quote and a watch-only quote. | Destination and active tab. |
| Holding row secondary actions | Editing may use long press, overflow or transaction screen. | Long press, swipe and tap likely action areas on a test row. | Any menus/actions. |
| Bottom summary behaviour | It appears fixed, but overlap and collapse states need checking. | Scroll a long and a short list; rotate if supported; show/hide details. | Whether fixed, collapsible and safe-area aware. |
| Hide Details persistence | The summary panel has a Hide Details action. | Toggle it, switch portfolio and restart. | Per-user or per-portfolio persistence. |
| Empty portfolio state | A dense table needs a useful zero-data state. | Create an empty portfolio and open every tab. | Text and available primary action. |
| Extremely long symbols/names | Dense columns may collide. | Add/import long symbols, portfolio names and company names. | Truncation, wrapping and tooltip/detail behaviour. |

## 4.4.5 P1 - Refresh, history and charts

| Unknown | Why it matters | Specific Android-app test | Record |
|---|---|---|---|
| Refresh icon scope | It may refresh current portfolio, all portfolios, quotes only or history too. | Note timestamps in several portfolios, tap refresh from one and compare all. | Changed timestamps and any progress UI. |
| Refresh concurrency | Repeated taps could issue duplicate requests. | Tap refresh several times quickly. | Disabled state, queued work or duplicate requests. |
| Partial provider failure | One invalid symbol should not block all prices. | Add one invalid symbol and refresh with several valid symbols. | Per-row error and overall status. |
| Auto-refresh timing | General setting shows 30 seconds, but foreground/background rules are unknown. | Keep app visible for several intervals, background it, then return. | Request/timestamp cadence. |
| `Calculate history` trigger | History may be cached and manually regenerated. | Add/edit/backdate a transaction and observe chart before and after pressing Calculate history. | Staleness, progress and resulting points. |
| History valuation frequency | Could be daily close, intraday or transaction dates only. | Inspect a short 1W range and count/inspect points. | Date/time granularity. |
| Weekend/holiday interpolation | Charts may carry forward prior close or omit dates. | Inspect a period containing weekends and a market holiday. | Presence and value of non-trading-day points. |
| Deposits/withdrawals in return chart | Portfolio value and investment return should not be conflated. | Add a cash contribution without a market gain and switch value/percent modes. | Chart jump and percent-return behaviour. |
| Split/dividend adjustment | Provider adjusted history can double-count corporate actions. | Test a security with a known split or large distribution around the event. | Price, quantity, value and return continuity. |
| Compare function | Could add benchmarks or securities. | Tap Compare on portfolio and holding charts; add/remove a comparison. | Picker, normalisation and legend. |
| Inner selector on donut | Likely nested allocation grouping. | Open selector and cycle all options. | Available dimensions and chart labels. |
| Chart gear options | Likely line/tick/adjustment settings. | Open gear on portfolio and holding charts. | Every option and default. |

## 4.4.6 P1 - Dividends and predicted income

| Unknown | Why it matters | Specific Android-app test | Record |
|---|---|---|---|
| Dividend transaction fields | Required for historical income and forecast validation. | Add a dividend and capture the entire form. | Gross/net amount, date, quantity, withholding, franking, currency, notes and portfolio association. |
| Dividend removal/editing | Income totals and history must recalculate. | Add, edit and delete a dividend. | Affected summaries, graph and confirmation behaviour. |
| Dividend yield definition | Could be trailing, forward or provider-specific. | Compare app value to a security with known trailing and forward yield. | Label and value at same timestamp. |
| Franking percentage source | User explicitly requires it but it is not visible in the evidence. | Find an ASX security with a known partially franked dividend; inspect all source tabs/forms. | Any franking field and source. |
| Reinvestment handling | DRP can be a dividend plus buy, or a special transaction. | Enter a dividend reinvestment if supported and export. | Transaction grammar, cost basis and cash treatment. |
| Forecast frequency and confidence | Predicted dividends require a method. | For a security with irregular distributions, compare any source-app expected-income feature if available. | Forecast inputs, dates and labels. |

## 4.4.7 P1 - Forms and destructive actions

| Unknown | Why it matters | Specific Android-app test | Record |
|---|---|---|---|
| Add-holding form fields | Core CRUD cannot be specified from current evidence. | Tap the plus from Holdings and capture every step, dropdown and default. | Full screen recording and resulting CSV row. |
| Add-transaction form fields | Needed for buys, sells, dividends and interest. | Tap plus from holding Transactions and capture each transaction type. | Labels, defaults, conditional fields and validation. |
| Edit path | It may be row tap, long press or menu. | Open an existing transaction and try tap/long press/overflow. | Exact route and editable fields. |
| Delete confirmation | Financial records should not disappear accidentally. | Delete a disposable transaction and portfolio. | Prompt, wording and undo option. |
| Unsaved-change handling | iPhone back gestures can discard form edits. | Change a field, then use back arrow, browser back and swipe-back where available. | Prompt and retained draft. |
| Portfolio deletion with data | Must avoid orphaned records. | Attempt to delete a non-empty portfolio. | Block, cascade/export warning or reassignment options. |
| Accounting-method mutability | Changing FIFO after sales may rewrite realised gains. | Change method on a portfolio with matched sales. | Allowed choices, warning and recalculation. |

## 4.4.8 P2 - Secondary source features

| Unknown | Test |
|---|---|
| Alert conditions, frequency and delivery | Create alerts above and below current price; trigger them; inspect edit/delete and export. |
| Notes scope and length | Add holding notes and transaction notes with long text; inspect list display and CSV. |
| News filtering and symbol association | Open News from a portfolio and a holding; inspect filter choices and whether symbols are preselected. |
| Global overview Details tab | Open the missing tab and record it from top to bottom. |
| Holding Profile tab | Open and record the entire source tab, then decide whether any content belongs in the target Summary. |
| Generate Portfolio Report | Generate one report and retain it only as a possible deferred requirement. |
| Top Daily Movers | Record the filters and source; likely defer. |
| Accessibility/system font scaling | Increase Android font/display scaling and observe whether dense tables reflow or clip. |
| Landscape/tablet behaviour | Rotate the source app and record whether it supports landscape; this is not essential to the iPhone portrait target. |

## 4.4.9 Evidence synchronisation test

The screenshots and supplied CSV were not captured from exactly the same ledger state. For example:

- `01.png` shows RMD with 3,500 open shares and cost base A$98,180;
- `portfolio.csv` produces 3,000 open RMD shares and cost base A$83,680;
- the difference is consistent with a missing 500-share buy at A$29;
- `07.png` shows 63 Aus Stocks transactions while the CSV contains 58;
- current PLS prices also differ slightly between screenshots, as expected for live data.

**Recommended test:** create a disposable but representative portfolio, then in one short session:

1. force a price refresh;
2. capture every relevant screen;
3. export the CSV immediately;
4. note the exact local time and app version;
5. avoid editing until all files are saved.

This will produce a synchronised golden fixture for automated rebuild tests.

---

# 4.5 Recommended target architecture

## 4.5.1 Architecture summary

**Proposed**

```text
iPhone installed PWA
        |
        | HTTPS, same origin
        v
Cloudflare Access policy
        |
        | validated Access identity
        v
Cloudflare Worker
  - static application assets / SPA routing
  - JSON and CSV API
  - authorisation and validation
  - calculation orchestration
  - market-data adapter and cache policy
        |
        +--------------------+
        |                    |
        v                    v
Cloudflare D1          External data providers
private ledger         prices, FX, fundamentals,
and user settings      dividends and news
```

A single full-stack Worker deployment with static assets is the preferred starting point. It keeps the PWA and API on one origin, reduces CORS and cookie complexity, and provides one deployment unit. A separate front-end Pages project remains viable, but does not provide a material benefit for this private application.

Cloudflare's current platform documentation supports serving static assets and Worker logic together, binding D1 to Workers, and protecting HTTP applications with Access. The implementation should still pin tested package versions and verify current Cloudflare deployment configuration when coding begins.

## 4.5.2 Authentication and user mapping

### Access is the gate, not the complete application authorisation model

**Proposed rules**

1. Put the entire application origin, including `/api/*`, behind Cloudflare Access.
2. In the Worker, validate the Access JWT rather than trusting a user-supplied email header or query parameter.
3. Extract a stable Access/identity-provider subject identifier and map it to an internal `users.id`.
4. Use email as display/contact metadata, not as the only immutable database key.
5. Create the internal user row just in time after the first valid login, or provision it administratively.
6. Never accept `user_id` from the client as authority.
7. Every private query must scope through the authenticated internal user.
8. Return 404 rather than revealing that another user's object exists where practical.
9. Maintain an optional application-level `disabled_at` flag so access can be revoked in the app even before an Access policy is changed.

### Required object-ownership pattern

Do not write:

```sql
SELECT * FROM portfolios WHERE id = ?;
```

Write the equivalent of:

```sql
SELECT *
FROM portfolios
WHERE id = ?
  AND user_id = ?
  AND deleted_at IS NULL;
```

The same rule applies to holdings, transactions, imports, exports, alerts and settings. Nested objects should be authorised through their parent portfolio, not merely by guessing an object ID.

### Installed-PWA session behaviour

**Proposed**

- An expired Access session can cause an API fetch to receive a redirect or an HTML login response instead of JSON.
- The API wrapper must detect this condition and present a clear **Sign in again** state rather than reporting malformed data.
- Do not allow a service worker to cache an Access login page as an API response.
- Provide an explicit sign-out action that clears local private caches before navigating through the Access logout path.

## 4.5.3 Cloudflare Worker responsibilities

The Worker should own:

- Access-token validation and internal user resolution;
- all private object authorisation;
- request validation and normalisation;
- D1 reads/writes through prepared statements;
- transaction ordering and ledger recalculation;
- CSV preview, validation, commit and export;
- market-data provider calls using secrets held only in Worker configuration;
- provider response normalisation;
- cache/freshness policy;
- history snapshot generation or job dispatch;
- response schemas and error codes;
- security headers and no-store policy for private API responses;
- structured operational logging that excludes private transaction payloads.

The browser should own:

- presentation and local interaction state;
- current route, selected tab and sort state;
- optimistic UI only where rollback is safe;
- number/date display formatting from exact API values;
- temporary import file parsing for preview only if desired, while the Worker remains authoritative for commit validation;
- PWA installation and offline shell behaviour.

## 4.5.4 D1 design and data isolation

### One database, row-level tenant ownership

For the expected private/small-user deployment, use one D1 database and explicit `user_id` ownership columns rather than one database per user.

Benefits:

- one migration path;
- straightforward backups and operations;
- cross-user market-data records can be shared safely where they contain no private ledger data;
- lower administrative overhead.

The safety condition is strict ownership filtering at every private query boundary, backed by integration tests.

### Monetary storage

**Proposed**

- Do not rely on binary floating point for ledger values.
- Store transaction-entered decimal values as canonical decimal strings or scaled integers with a declared scale.
- Use higher precision for quantities, prices and FX than for rendered currency.
- A practical model is:
   - `quantity_decimal TEXT`;
   - `unit_price_decimal TEXT`;
   - `commission_decimal TEXT`;
   - `fx_rate_decimal TEXT`;
   - calculated monetary values returned as decimal strings.
- If scaled integers are used, choose scale and overflow limits deliberately; do not assume two decimal places for shares or prices.

### Write consistency

**Proposed**

- Use prepared statements for all user input.
- Group related import or ledger writes in the strongest atomic/batched mechanism supported by the current D1 API.
- Give each mutation an idempotency key where retries could duplicate financial records.
- Version rows or use `updated_at`/ETag-style checks to prevent one device silently overwriting another device's edit.
- Retry only transient database errors and only where the operation is demonstrably idempotent.

### Private versus shareable data

**Private**

- portfolios and portfolio membership;
- transactions, notes and cash flows;
- holdings projections and performance history tied to a user;
- import files and validation reports;
- alerts and personal settings.

**Potentially shared**

- canonical security master;
- exchange metadata;
- public prices and FX observations;
- public fundamentals;
- public dividend announcements;
- public news references.

Even shared public records should not expose which users hold or watch a security.

## 4.5.5 Market-data boundary

Create a provider-neutral interface from the first version:

```ts
interface MarketDataProvider {
  getQuotes(requests: QuoteRequest[]): Promise<QuoteResult[]>;
  getHistory(request: HistoryRequest): Promise<PriceBar[]>;
  searchSecurities(query: string): Promise<SecuritySearchResult[]>;
  getFundamentals?(security: SecurityKey): Promise<FundamentalsResult>;
  getDividends?(security: SecurityKey): Promise<DividendEvent[]>;
  getNews?(request: NewsRequest): Promise<NewsItem[]>;
}
```

**Proposed rules**

- The private ledger must never depend on one provider's raw symbol format.
- Store canonical security identity plus provider-specific mappings.
- Store provider timestamps and retrieval timestamps separately.
- Distinguish `last`, `previous_close`, regular-market and extended-hours values.
- Never replace a last known good price with zero because a provider returns null/error.
- Return per-symbol errors so one bad symbol does not fail a portfolio refresh.
- Cache public data according to licensing and freshness requirements, not indefinitely by default.
- Keep provider keys and licences server-side.
- Make manual price overrides explicit and visibly labelled.

Market-data licensing, redistribution rights, quote delay and rate limits must be settled before selecting the production provider. The UI and calculation engine should not be coupled to an unofficial endpoint.

## 4.5.6 History and scheduled work

**Proposed**

Use two complementary mechanisms:

1. **On-demand refresh**
   - user taps refresh;
   - Worker obtains current quotes/FX;
   - saves observations;
   - recalculates affected projections;
   - returns partial success and timestamps.

2. **Scheduled maintenance**
   - scheduled Worker trigger refreshes required public market data within provider limits;
   - generates or repairs daily portfolio snapshots;
   - updates dividend forecasts/news indexes where enabled;
   - records per-job diagnostics without logging private values.

Do not make the page wait for a full multi-year history rebuild. Use a job/status model once history processing exceeds an interactive request budget:

```text
queued -> running -> complete
                 -> failed (retryable or terminal)
```

The existing chart and last known figures should remain visible while a rebuild runs.

## 4.5.7 PWA and private caching policy

### Cacheable

- versioned JavaScript, CSS, fonts owned by the project and icons;
- the application shell;
- non-sensitive static help content.

### Not cacheable by default

- portfolio JSON;
- transactions and notes;
- generated CSV exports;
- imported file contents;
- Access login responses;
- user-specific HTML rendered with financial data.

Use `Cache-Control: no-store` for private API responses and exports unless a deliberate encrypted/offline design is introduced later.

The first PWA version may provide an offline shell that says the data connection is unavailable. It does not need to store the user's portfolio offline. This is safer and much simpler than a full offline financial ledger.

## 4.5.8 Suggested API surface

The exact framework is an implementation choice. The behavioural contract should resemble the following.

### Identity and settings

```text
GET    /api/me
GET    /api/settings
PATCH  /api/settings
```

### Portfolios

```text
GET    /api/portfolios
POST   /api/portfolios
GET    /api/portfolios/:portfolioId
PATCH  /api/portfolios/:portfolioId
DELETE /api/portfolios/:portfolioId
GET    /api/portfolios/:portfolioId/summary
GET    /api/portfolios/:portfolioId/holdings
GET    /api/portfolios/:portfolioId/quotes
GET    /api/portfolios/:portfolioId/history
POST   /api/portfolios/:portfolioId/refresh
```

### Portfolio-security membership and transactions

```text
POST   /api/portfolios/:portfolioId/securities
PATCH  /api/portfolio-securities/:portfolioSecurityId
DELETE /api/portfolio-securities/:portfolioSecurityId
GET    /api/portfolio-securities/:portfolioSecurityId
GET    /api/portfolio-securities/:portfolioSecurityId/transactions
GET    /api/portfolio-securities/:portfolioSecurityId/summary
GET    /api/portfolio-securities/:portfolioSecurityId/history
POST   /api/transactions
PATCH  /api/transactions/:transactionId
DELETE /api/transactions/:transactionId
```

### Securities and market data

```text
GET    /api/securities/search?q=
GET    /api/securities/:securityId/quote
GET    /api/securities/:securityId/history
GET    /api/securities/:securityId/fundamentals
GET    /api/securities/:securityId/news
```

### Import and export

```text
POST   /api/imports/portfolio-csv/preview
POST   /api/imports/:importId/commit
GET    /api/imports/:importId
GET    /api/exports/portfolio.csv
```

The preview response should include counts, warnings, row-level errors and the intended merge/replace operation. Commit must use the already validated import snapshot or revalidate the exact uploaded hash.

### Dividends and forecasts

```text
GET    /api/portfolios/:portfolioId/dividends
GET    /api/portfolios/:portfolioId/dividend-forecast
POST   /api/cashflows/dividend
PATCH  /api/cashflows/:cashflowId
DELETE /api/cashflows/:cashflowId
```

### Alerts and news - later

```text
GET    /api/alerts
POST   /api/alerts
PATCH  /api/alerts/:alertId
DELETE /api/alerts/:alertId
GET    /api/portfolios/:portfolioId/news
```

## 4.5.9 API response principles

**Proposed**

1. Return exact decimals as strings plus separate display metadata where useful.
2. Include source timestamp, retrieved timestamp and stale/error status for prices.
3. Keep calculations server-authoritative; do not independently implement FIFO in several UI components.
4. Return stable IDs, never use mutable ticker as the only key.
5. Use explicit nulls for unavailable values; never use `0` as an unknown placeholder in JSON.
6. Use structured errors:

```json
{
  "error": {
    "code": "IMPORT_ROW_INVALID",
    "message": "Three rows require correction before import.",
    "fields": [],
    "rows": []
  }
}
```

7. Include a calculation/schema version in derived responses so cached projections can be invalidated after formula changes.
8. Make mutation responses return the recalculated affected summaries, reducing visible drift after an edit.

---

# 4.6 Rebuild stages

## 4.6.1 Essential first version

The first version should prove four things: the ledger is correct, users are isolated, the dense interface works on iPhone, and the existing data can move safely.

### A. Foundation and security

- Cloudflare Access-protected application origin.
- Worker-side Access JWT validation and internal user mapping.
- D1 schema and migration tooling.
- Mandatory `user_id` ownership on every private root entity.
- Authorisation integration tests covering cross-user ID substitution.
- Structured logging with private-field redaction.
- Separate local, staging and production environments.

### B. Import and ledger

- Import the supplied portfolio CSV grammar, including:
   - definition rows;
   - watch-only entries;
   - buy and sell rows;
   - blank physical rows;
   - trailing whitespace in headers;
   - notes;
   - FIFO accounting metadata;
   - cash pseudo-securities where present.
- Import preview with counts, warnings and blocking errors.
- Deliberate duplicate policy; recommended initial default is **create a new import batch and block exact duplicate transaction IDs within the same user unless the user explicitly chooses replacement**.
- Exact-decimal transaction storage.
- FIFO lot engine with unit tests from the supplied file.
- Buy, sell and basic cash-flow CRUD.
- Recalculation after any ledger mutation.
- Audit metadata and soft-delete/undo window for transaction deletion.

### C. Essential screens

1. **Portfolio Holdings**
   - compact three-line rows;
   - Ticker, Value/Cost, Daily and Total columns;
   - deterministic sorting;
   - sticky four-line summary;
   - add holding/transaction path.

2. **Portfolio Quotes**
   - compact two-line rows;
   - held and watch-only securities;
   - timestamps and stale/error state.

3. **Portfolio Details - first slice**
   - portfolio value or return chart;
   - basic time ranges;
   - allocation view can be included if data is ready;
   - lower advanced/XIRR sections may wait.

4. **Holding Transactions**
   - parcel/transaction list;
   - add, edit and delete;
   - source-like summary panel;
   - sold positions retained in history.

5. **Holding Summary**
   - current quote and change;
   - price chart;
   - minimum required public fields that the provider can supply reliably;
   - notes.

6. **Portfolio Overview**
   - all portfolios in the compact four-line format;
   - aggregate bottom summary;
   - row tap opens the portfolio.

7. **Portfolio selector and simplified drawer**
   - portfolio switching;
   - Overview;
   - Add Portfolio;
   - Import/Export;
   - Settings.

8. **Settings - minimal**
   - default/last portfolio;
   - starting tab;
   - display currency;
   - theme;
   - key dense-row visibility controls;
   - number precision where needed.

9. **News tab scaffold**
   - tab exists to stabilise navigation and route design;
   - it may show a clear Stage 2 placeholder until a provider is selected.

### D. Price and FX support

- Provider adapter, not direct provider calls from components.
- Current prices for required ASX/US securities and supported quote pairs.
- FX conversion with explicit direction and timestamps.
- Manual refresh with visible progress and partial failure handling.
- Last known good value retained on errors.
- Manual/custom fallback for unsupported symbols.

### E. CSV export

- Deterministic export of all user portfolios or an explicit selected scope.
- Preserve enough source-compatible fields for practical round-trip.
- Include a documented format version for target-native exports.
- Browser download and optional Share action.
- Round-trip automated tests.

### F. PWA and iPhone completion criteria

- Installable manifest and icons.
- Correct standalone viewport and iPhone safe areas.
- No horizontal scroll in primary views at 320, 375, 390 and 430 CSS-pixel widths.
- Dense rows remain readable at default iOS text settings.
- Access reauthentication is handled cleanly from installed mode.
- Private API/data is not stored by the service worker.

## 4.6.2 Useful second-stage features

### Portfolio analysis

- Full portfolio and all-portfolios history.
- Allocation donut and grouping controls.
- YTD, realised, unrealised and all-time sections.
- Carefully defined money-weighted return/XIRR.
- Activity view.
- Calculation preferences for cash, dividends and interest.

### Predicted dividends

- Dividend-event ingestion from a reputable provider.
- Manual override for amount, frequency, ex-date/payment date and franking.
- Forecast model that labels:
   - announced/confirmed distributions;
   - modelled/estimated distributions;
   - confidence/source date.
- Portfolio annual income, forward yield and monthly forecast.
- Franked/unfranked split and estimated franking credits as separate values.
- Historical forecast-versus-actual reconciliation.

The v1 data model should include dividend entities and franking fields even if the forecast UI ships in Stage 2. This avoids a schema redesign.

### News

- Requested portfolio News tab.
- Symbol-aware feed with deduplication.
- Holding-level News section.
- Source/time labels and open-original action.
- Filters by portfolio/security and freshness.
- No sponsored source-app content.

### Fundamentals

- Complete required fields:
   - day high/low/open/previous close;
   - P/E and forward P/E;
   - regular and forward EPS;
   - 52-week high/low;
   - dividend yield;
   - franking percentage;
   - market cap, volume and selected additional fields.
- Per-field freshness and unavailable-state handling.

### Workflow refinements

- Auto-refresh while foregrounded with sensible throttling.
- Alerts and browser/push notification evaluation, subject to iOS PWA support and user permission.
- Import merge/replace options and richer row repair.
- Notes in lists.
- Saved filters/sorts.
- More display-density controls.
- Background/scheduled snapshot repair.

## 4.6.3 Features that can be deferred

- Source holding **Details** tab, explicitly not required.
- Source holding **Profile** tab unless a concrete use is identified.
- Global Market News destination separate from the portfolio News tab.
- Top Daily Movers.
- Generate Portfolio Report.
- Premium/upsell concepts.
- Source Server Sync, since the target is already cloud-backed.
- Widget support.
- Import/export of source price-alert and custom-price files.
- Compare overlays and advanced chart settings.
- Inner-ring allocation modes beyond one useful default.
- Full offline ledger editing and conflict resolution.
- Tax return generation or tax advice.
- Complex corporate actions beyond a controlled manual workflow.
- Brokerage integrations and automatic trade ingestion.
- Multi-user shared portfolios, roles and invitations.
- Native App Store wrapper.

---

# 4.7 Recommended implementation sequence

## Step 0 - Lock the golden fixtures

- Save the supplied CSV unchanged as a test fixture.
- Create a synchronised source-app fixture using the test in 4.4.9.
- Encode the known PLS, Aus Stocks and Aus Sold calculation results as tests.
- Record all unresolved source behaviours that block v1 decisions.

## Step 1 - Repository, deployment and authentication

- Establish Worker/static-assets project and CI deployment.
- Configure local/staging/production D1 bindings.
- Add Access to staging first.
- Implement and test JWT validation, internal user creation and session-expiry handling.
- Add a two-user cross-tenant test harness before financial screens exist.

## Step 2 - Schema and import preview

- Apply the logical model in `02_DATA_MODEL_AND_CSV.md`.
- Build source CSV parser and normaliser.
- Show an import preview with portfolio/security/transaction counts.
- Store an import hash and source row references.
- Commit a complete import without exposing partial data.

## Step 3 - Calculation engine

- Implement pure, deterministic lot matching and aggregation modules.
- Keep calculation code independent of UI and provider clients.
- Run tests using exact supplied examples.
- Add invariant tests, including:
   - no unexplained negative open quantity;
   - sum of lot quantities equals holding quantity;
   - open lot cost equals holding open cost;
   - portfolio values equal the sum of included holdings/cash under the active rules.

## Step 4 - Read-only dense UI

- Build the persistent mobile shell and tab routing.
- Implement Holdings, Quotes, Holding Transactions, Holding Summary and Overview using imported fixture data.
- Tune column geometry against `01.png`, `02.png`, `04.png` and `07.png`.
- Test on real iPhone Safari and installed PWA mode, not only desktop responsive emulation.

## Step 5 - Mutation workflows

- Add portfolio, security membership and transaction forms.
- Add edit/delete with recalculation and safe confirmation/undo.
- Add notes and settings.
- Introduce optimistic UI only after server-authoritative responses are reliable.

## Step 6 - Market data and refresh

- Integrate provider adapter and symbol mapping.
- Add quotes, FX, timestamps, stale state and manual refresh.
- Verify foreign-currency calculations with controlled fixtures.
- Add history endpoints and first chart slice.

## Step 7 - Export and PWA hardening

- Add deterministic CSV export and round-trip tests.
- Complete service-worker cache rules and Access-expiry recovery.
- Add safe-area, keyboard, scroll-restoration and browser-back testing.
- Add operational backup/recovery runbook and migration rollback process.

## Step 8 - Stage 2 analysis, dividends and news

- Build snapshots/XIRR only after cash-flow semantics are settled.
- Add dividend forecast with explicit confidence labels.
- Add News after provider/licensing selection.
- Add alerts only after refresh and notification delivery semantics are proven.

---

# 4.8 Acceptance criteria

## 4.8.1 Import and data model

- Importing the supplied `portfolio.csv` identifies:
   - 5 portfolios;
   - 65 portfolio-security definition rows;
   - 115 transaction rows;
   - 101 buys;
   - 14 sells;
   - 64 blank physical rows ignored safely.
- The watch-only EPR entry is retained despite having no transactions.
- Padded/variant headers are normalised without silently confusing distinct fields.
- Import preview reports source discrepancies and invalid rows before commit.
- Reimport cannot duplicate transactions without an explicit user decision.

## 4.8.2 Calculation fixtures

Using the supplied data and FIFO:

- PLS open quantity is 20,000.
- PLS open cost is A$39,300.
- PLS average open cost is A$1.965 per share.
- Aus Stocks realised cost basis is A$37,580.
- Aus Stocks realised proceeds are A$52,580.
- Aus Stocks realised gain is A$15,000 and displays as 39.91% using realised cost as denominator.
- Aus Sold realised cost basis is A$265,913.11.
- Aus Sold realised proceeds are A$424,386.60.
- Aus Sold realised gain is A$158,473.49 and displays as 59.60%.
- Calculations use exact input precision and only round at render/export boundaries.

## 4.8.3 Data isolation and security

- User A cannot list, fetch, mutate, export or infer User B's portfolio by replacing any ID.
- Client-supplied user identity is ignored.
- Invalid/expired Access sessions do not return private JSON or cache a login page as data.
- Private API responses and exports use no-store caching policy.
- Logs do not contain full CSV files, notes, transaction payloads or portfolio values by default.
- Market-provider secrets never appear in browser bundles or responses.

## 4.8.4 Dense iPhone interface

- At 390 CSS pixels wide, Holdings shows all four logical columns without horizontal scrolling.
- A standard iPhone viewport shows at least 6-8 useful holding rows plus the fixed summary, depending on safe area and browser chrome.
- Numeric columns align by decimal/right edge and do not jitter as values refresh.
- Negative, positive and neutral states remain distinguishable without relying only on colour.
- Rows remain usable with an approximately 44-point aggregate touch target even though individual text lines are compact.
- Summary panels do not cover the last list item; scroll padding accounts for the panel and home indicator.
- Browser back, app back and direct deep links produce predictable routes.

## 4.8.5 Refresh and failure behaviour

- Refresh shows progress without blanking existing values.
- One symbol failure does not block successful symbols.
- Last known data remains visible and is labelled stale where appropriate.
- Repeat refresh taps do not duplicate mutations or uncontrolled provider calls.
- Prices, FX and fundamentals expose their own freshness timestamps.
- Resuming the installed PWA after a long pause performs a controlled stale check.

## 4.8.6 CRUD and history invalidation

- Adding/editing/deleting a transaction recalculates holding and portfolio summaries in one coherent response.
- Editing a historical transaction invalidates affected cached lots and history from the earliest affected date.
- Deleting a buy that supports later sales is blocked or handled by an explicit, auditable recalculation workflow.
- Sold securities remain available in transaction history and realised totals.
- Empty/watch-only securities do not create phantom cost or gains.

## 4.8.7 Export and recovery

- Export followed by import into a clean account preserves portfolios, membership, transactions, notes, currencies and accounting order within documented limitations.
- Exports use stable UTF-8, deterministic headers and documented date/time conventions.
- A failed import commit leaves no partial visible portfolio state.
- Database migration and backup recovery are tested before production financial data is entrusted to the app.

---

# 4.9 Principal risks and controls

| Risk | Consequence | Control |
|---|---|---|
| Unlicensed or unstable market-data source | Broken quotes, legal/redistribution risk, sudden API failure | Select a contracted provider; isolate it behind an adapter; keep manual fallback. |
| Ambiguous FX semantics | Incorrect cost and gains across currencies | Store direction and timestamps explicitly; add controlled FX fixtures; never treat zero as an actual rate. |
| Floating-point accounting | Small errors accumulate and displayed totals disagree | Exact decimal arithmetic and full-precision storage. |
| Tenant-filter omission | Cross-user financial-data exposure | Central repository methods, mandatory user context and adversarial integration tests. |
| Access expiry in installed PWA | Confusing HTML/login response in API flow | Detect auth redirects/content type; clear sensitive local state; explicit reauthenticate screen. |
| Service-worker over-caching | Private data persists on device or stale login/data is served | Cache shell assets only; no-store private API; versioned cache purge. |
| Import duplication | Materially incorrect holdings and gains | Preview, source IDs, hashes, idempotency keys and explicit merge/replace policy. |
| Screenshot/CSV state mismatch | False parity failures | Use a synchronised golden fixture and distinguish live data from ledger data. |
| History formula ambiguity | Misleading performance numbers | Separate value from return; document cash-flow treatment; defer XIRR until tested. |
| Dividend/franking data quality | Misstated expected income | Show source/date/confidence; allow manual override; separate announced from estimated. |
| Dense layout taken too literally | Tiny inaccessible controls or clipped figures | Dense text with row-level touch targets, dynamic-width tests and alternate non-colour indicators. |
| D1 write/retry edge cases | Partial or duplicate financial writes | Atomic/batched writes where supported, idempotency keys and post-write invariants. |

---

# 4.10 Final product boundary for the first release

The first release is successful when it is a reliable private ledger and high-density portfolio viewer, not when it has reproduced every source menu item.

It must:

1. authenticate through Cloudflare Access;
2. isolate each user's data at the Worker and D1 query layers;
3. import the supplied CSV safely;
4. calculate holdings and FIFO realised gains reproducibly;
5. show multiple portfolios in the dense iPhone layouts specified in the other files;
6. support practical portfolio and transaction CRUD;
7. refresh prices without corrupting or hiding last known data;
8. export a recoverable CSV;
9. install and behave correctly as an iPhone PWA.

Predicted dividends, richer analysis, news, alerts and advanced charting should build on that ledger. They should not delay proving the accounting, privacy and core mobile interaction model.
