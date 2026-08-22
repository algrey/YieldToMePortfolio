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
- News embeds the owner's news site (per-holding: UI-023B, owner directive
  2026-08-22; primary tab: UI-025, owner ruling 2026-08-22 — "A new user
  should see the news in the news tab. There are plenty of avenues for a
  new user to create a portfolio."), in both cases with
  `referrerpolicy="no-referrer"` and no portfolio/security identifiers in
  the embed URL. Visible source attribution differs by tab (UI-028, owner
  ruling 2026-08-22, product choice): the per-holding embed keeps its
  attribution line beneath the frame, unchanged; the PRIMARY tab's embed is
  intentionally chrome-less (no attribution paragraph, full-viewport frame)
  — attribution remains reachable via the per-holding tab or the
  greeninvestments.au site itself. Supersedes the original "News clearly
  indicates unavailable status until implemented" criterion, kept here as
  the record of that earlier decision.

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
- Disable and deletion-request mutations revoke internal identities immediately; repeated requests are idempotent.
- The export manifest covers every owned ledger, import, projection, and user-scoped market observation row, with shared and operational data explicitly classified and no other owner included.
- Export capture is D1-first and resumable: bounded chunks are reconciled before a bounded, cursor-checkpointed SHA-256 chain finalization; download pages support cursor and deterministic numbered traversal, and artifacts expire under the explicit `operational-35-days` retention class. Operational counts carry an explicit stable cutoff so later access audits remain attributable without changing finalized evidence.
- Revoked users may recover only the exact existing lifecycle request/status/export path matched to their verified issuer, subject, request type, and idempotency key; they cannot regain workspace access. OPS-003A does not purge source financial data.
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
- Compact price views show `unavailable` when no usable value exists. They generally suppress timestamps, provider, delay, and fallback labels; anomalous manual/stale/indicative/fallback state remains accessible, with inline status reserved for an action-required condition.
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
- Non-zero components excluded by missing/stale price or FX are identified in coverage; explicit zero positions and zero cash balances do not create a gap.
- A chart reads one completed calculation version. Rebuilds are bounded, resumable, deterministic for a fixed ledger high-water, and do not expose unfinished dates; routine chart points do not print observation timestamps.
- Same-version rebuilds stage under a run identity and atomically switch the published run only after completion. Price/FX selection is pinned to the run’s persisted ingestion cutoff, and inverse directional FX observations are normalized through the calculation contract.
- Historical selection also applies the portfolio timezone’s local end-of-day cutoff to each observation instant, including DST transitions, so a later foreign-market close cannot create look-ahead history. Calendar-aware fallback distinguishes a known exchange holiday from a missing quote on an expected trading session; an unknown calendar remains explicitly unknown. Calendar evidence is canonicalized and pinned to the calculation run so retries cannot change that classification.
- The pinned calendar evidence is bounded and validity-dated by exchange/MIC, includes provenance/version and session open/close instants, maps each portfolio-local cutoff to the latest completed session, and persists the selected session identity on holding snapshot detail; it is not duplicated as an unbounded per-holding date map.
- Portfolio daily percentage is not a v1 acceptance claim for any figure that mixes cash and trade/deposit/withdrawal flows: outside the Holdings summary row below, the UI shows the exact daily amount and `Percentage unavailable` until a calculation-layer comparable portfolio denominator and explicit cash-flow classification contract exist. UI-031 (owner directive, 2026-08-23) defines and ships exactly that comparable denominator, but scoped narrowly to SECURITY HOLDINGS ONLY (never cash, never deposit/withdrawal/trade flows) — the Holdings screen's four-line summary row now shows a real portfolio daily percentage: `Σ daily movement ÷ Σ previous-day home value` over holdings with both a known market value and a known comparable daily movement, never an average of per-row percentages (`domain/calculations/multi-currency.ts`'s `composePortfolioDailyMovementTotal`, `docs/CALCULATIONS.md` §15). Supersedes the original "Portfolio daily percentage is not a v1 acceptance claim" criterion for that one surface, kept here as the record of that earlier decision; every OTHER portfolio-wide daily percentage (e.g. a future cash-inclusive Overview figure) remains exactly as unavailable as this bullet originally described until its own comparable denominator and cash-flow contract are separately promoted and tested.

### CALC-007 — Return metrics

Headline v1 “total gain” shall be price/realised gain based and shall not silently include estimated income.

Acceptance:

- Actual income is shown separately.
- Until the deferred dividend workflow exists, income is omitted or explicitly unavailable rather than inferred.
- TWR/XIRR remain unavailable until explicit external cash-flow classification and complete history exist.
- Any future return metric declares cash-flow and fee treatment.
- A portfolio-wide daily percentage remains unavailable until its comparable denominator and cash-flow treatment are defined in the calculation layer; the UI must not derive one from a snapshot row or formatted display value.

### FY-001 — Financial-year windows and labels

The application shall derive "FY" (financial-year-to-date) and "Last FY" (closed prior financial year) windows from a single per-user, configurable start month, resolved in the user's timezone, as the single source of FY truth for every consumer.

Acceptance:

- The FY start month is a per-user setting (`user_settings.financial_year_start_month`, integer 1–12, day always the 1st); there is no per-portfolio override. Default is 7 (July), the Australian financial year.
- The user's `user_settings.timezone` decides where the FY boundary falls everywhere, including aggregate/portfolio-level views.
- "FY" is FY-to-date: it runs from the FY start date through today (inclusive), mirroring YTD semantics. "Last FY" is a fully closed historical window: the prior FY's start date through the day before the current FY started.
- An FY is named by its ending calendar year per Australian convention (1 Jul 2025 – 30 Jun 2026 = "FY26"). A January start month produces plain calendar-year windows, named by that same year (Jan–Dec 2026 = "FY26").
- Boundary math resolves "now" to a local calendar date via the IANA timezone database, not naive UTC date arithmetic or binary-float time math; the boundary lands correctly across DST/offset transitions and for both positive and negative UTC-offset timezones.
- An invalid start month (outside 1–12) or invalid timezone is rejected at the domain-function boundary with an explicit typed reason, never silently coerced.
- Existing users default to start month 7 with no data rewrite when the setting is introduced.

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

### DIV-003 — Retirement-income projection engine

A pure projection engine shall turn holdings value, owner assumptions, receipts/FY overrides, and provider TTM yield into labelled multi-year and single-12-month income projections, with growth what-if adjustments applied ephemerally.

Acceptance:

- All dividend calculations are per 12-month period; multi-year views are per financial year (FY-001A windows/labels), up to 10 years forward and 10 years back.
- "Yield" means the TOTAL yield including franking credits; the grossed-up figure is the forecasting basis, and cash/franking splits are derived from it, never the reverse.
- Per-security assumption precedence (yield, franking, dividend growth) is owner override first, then the next documented fallback tier, then an explicit "none"/0% with a method label — never a fabricated number; every resolved value discloses its source.
- The provider trailing (cash) yield is grossed up into the total forecasting yield using the same ATO franking-credit formula the dividend-history franking chain already uses.
- The multi-year table's portfolio effective yield is the value-weighted average of covered securities' resolved yields; a security with no resolved yield, OR no known current value, is excluded from the weighting and named — never treated as 0% yield and never silently collapsed into a real zero value.
- Multi-year compounding applies the portfolio value-growth and dividend-growth assumptions by repeated year-over-year multiplication with one documented rounding per step, and matches the recorded formula exactly on deterministic decimal fixtures. Years forward outside 1-10 (including an explicit 0) is a typed rejection, never silently forced to a minimum of 1.
- A degraded current portfolio value or degraded yield coverage surfaces a typed multi-year failure reason (distinct from ordinary input-validation failures) and a `null` baseline input — never a fabricated all-zero input a what-if override could turn into a confident zero-dollar projection.
- Past-FY rows resolve owner-FY-override-vs-derived-total precedence correctly, label the winning source, and show portfolio value as unavailable (never a fabricated zero) for a year with no historical snapshot. A year with no dividend evidence at all for any eligible security is labelled as such (not asserted as a confirmed zero), and the current, still-open FY has its own FY-to-date row distinct from a closed year's total.
- The single-12-month breakdown discloses insufficient-history and foreign-currency securities by name as excluded/partial coverage, never silently zeroed or folded in; its income-percent-of-value figure discloses when its portfolio-value denominator is itself only a partial (understated) known total.
- The current portfolio value distinguishes a complete known total, a partial (real but understated) known total with coverage, and fully unavailable — mirroring the holdings valuation contract rather than collapsing partial into complete.
- A what-if growth substitution never writes to storage — it is a pure function of the baseline projection and the override, structurally incapable of persistence.
- All arithmetic uses the shared exact-decimal primitives; no calculation path uses binary floating point.

### CGT-001 — Realised capital gains discount and per-FY aggregation

An informational-only (not tax advice) read layer shall derive per-disposal capital gain rows and per-financial-year discount/loss-offset totals from the ledger's already-computed matched-lot allocations, without introducing new ledger machinery.

Acceptance:

- Every per-disposal figure (matched quantity, allocated basis, net proceeds, fees, tax, realised gain) is read from the current PUBLISHED calculation run only; a stale or unpublished run's allocations are invisible, never blended in.
- An allocation's acquisition date is its tax lot's opening transaction's local trade date; its disposal date is the sell transaction's own local trade date — never the tax lot's raw acquisition instant compared against a local date.
- Discount eligibility requires the disposal date be STRICTLY more than 12 months after the acquisition date (12 months plus at least one day); a disposal on the exact same day-of-month one year later is not eligible. Eligibility uses calendar-month arithmetic, with a documented date-rolling convention for a 29 February acquisition landing on a non-leap destination year.
- Per financial year, losses offset non-discountable gains before discountable gains, before the 50% individual discount rate (a documented, exported constant) is applied to the remaining discountable amount; the net capital gain estimate is never negative — an excess of losses over gains is disclosed as an unabsorbed loss, not as a negative gain.
- Each FY total is computed standalone first (this task's own scope); CGT-002 (below) chains these standalone totals across financial years into the carried, whole-period figures the screen actually shows.
- An allocation with incomplete cost basis never contributes a fabricated zero gain to a total; it is excluded, counted, and its security named so the FY total discloses partial coverage.
- A multi-lot disposal (one sale matched across several tax lots) scores eligibility per allocation, not per sale — lots with different acquisition dates can land in different discount buckets from the same disposal.
- Every portfolio-scoped query is owner-scoped; cross-user data never appears in another owner's totals.
- A rendered screen (CGT-001B, extended by CGT-002) discloses per-FY totals, a per-disposal detail view labelled by allocation (never "disposals" unqualified, since one sale can span several tax lots), and a lifetime summary; every degraded read-service state (unpublished calculation, unresolvable allocation dates, no disposals yet) is disclosed with distinct copy, never a fabricated zero; a standing "informational only — not tax advice" note is always visible.

### CGT-002 — Capital loss carry-forward across financial years

An informational-only (not tax advice) pure function shall chain CGT-001's standalone per-FY capital-gains totals from the earliest disposal FY forward, so an unapplied capital loss in one financial year offsets a gain in a LATER year, with the ledger's own declared history-completeness boundary determining how far that chain can honestly be trusted.

Acceptance:

- Chaining proceeds from the EARLIEST disposal FY forward; each FY's unabsorbed net capital loss (its own current-year excess, plus any prior-FY loss it could not itself absorb) carries into the next FY as a loss brought forward.
- Within a FY, the brought-forward loss is applied AFTER that FY's own current-year losses, using the identical ordering preference (non-discountable gains first, then discountable), and always against the discountable amount BEFORE the 50% discount is applied — never against an already-discounted figure.
- A portfolio's declared `history_complete_from` date determines whether the chain can be trusted back to the earliest disposal FY: complete iff it is set and on or before the earliest disposal FY's start date; a `null` value or a later date both make the chain incomplete. When incomplete, every carried figure — and the whole-period net — is disclosed as possibly incomplete, naming the boundary date (or, for a `null` boundary, stating plainly that no such date is declared) rather than presenting a possibly-truncated chain as complete.
- A financial year whose own totals already exclude an incomplete-cost-basis allocation propagates that uncertainty forward: every carried figure from that year onward is flagged as possibly incomplete too, and stays flagged for the remainder of the chain.
- The whole-period net capital gain is the sum of each FY's own carried (chain-adjusted) net estimate — never the sum of the pre-carry standalone figures, and never double-counting a loss that was actually applied in a later year. Any loss still unabsorbed after the most recent reported FY is disclosed separately as still carrying forward, never netted into the whole-period figure.
- The rendered screen adds carried columns (brought forward / applied this FY / carried out) to the existing per-FY table, whose headline "Net estimate" becomes this true, carried figure; the lifetime summary's net line is relabelled to reflect the true whole-period net rather than a plain per-year sum. The pre-carry standalone per-FY figures are not lost — they remain visible in the FY table's other columns and in each FY's detail view, clearly distinguished from the carried figures.
- All arithmetic uses the shared exact-decimal primitives; no calculation path uses binary floating point.

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

### IMP-007 — Dividend-receipt rows (owner dividend modelling feature; requirement ID distinct from the TASKS.md `IMP-006` task, which already holds `IMP-006 — Alternative CSV variants` above -- see AGENTS.md's "preserve stable requirement IDs, never reuse")

The staged CSV import pipeline shall additionally support a dividend-receipt row `Type`, through a separately versioned parser contract per IMP-006's own resolution above, without weakening the original 17-column trade contract.

Acceptance:

- A second header version (`strict-18-column-dividends-v1`, the original 17 columns plus one trailing `Franking Credit Per Share` column) is selected by exact header signature, alongside -- never replacing -- the original `strict-17-column-v1` contract; existing trade-only uploads keep parsing unchanged.
- A `Dividend` row reuses the trade columns' security/date/quantity/price semantics (payment date, shares, dividend per share) and stages/previews/validates through the same `transaction`-class pipeline as a trade row, including the same unresolved-security blocking behaviour; no new reviewer resolution-card type is introduced.
- Franking credit per share is optional; absent is unknown and never treated as zero, while a malformed or negative value blocks the row.
- A committed dividend row creates an owner-scoped, batch-attributable, reversible dividend fact (`dividend_manual_records`) rather than a direct ledger posting, atomically with any trade rows committed in the same batch.
- A committed dividend row is a plain `dividend_manual_records` row and occupies DIV-001's manual tier (there is no separate "imported" tier): it wins over a matched provider event's receipt via DIV-001's existing manual-vs-receipt precedence (an outranked receipt stays visible as `dominatedReceipt`, never double-counted), but is not deduplicated or ranked against an owner-entered manual record for the same security/date -- both would appear as independent rows. Separating owner-typed from imported manual facts into distinct tiers is tracked as follow-up work (DIV-004), scheduled before the manual-entry UI ships (today nothing but this importer creates manual records, so the gap is unreachable in practice).
- Duplicate dividend rows across re-imports are detected using the same versioned row-fingerprint scheme trades use.
- Reversing a batch removes the dividend facts it created and leaves trade reversal semantics (IMP-005) unchanged.

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
- Lifecycle request records are immutable; OPS-003A records the exact owner-scoped export manifest before any later purge task.
- Final purge requires the exact deletion request key, that request's completed
  unexpired export, a 24-hour cooling-off period, and a separate typed
  confirmation. It validates source and manifest digests before bounded
  foreign-key-ordered deletion, then verifies absence before completion.
- Database source locks prevent owner rows changing between validation and
  deletion checkpoints. Export/lifecycle cleanup is likewise bounded, audit
  ownership follows `target_owner_user_id`, and a purge guard is authorized
  only by its exact live job/version/status/phase.
- Source-lock UPDATE checks both old and new ownership. Purge-control schema is
  not retroactively required in an already-completed OPS-003A manifest.
- Retention after purge is limited to immutable deletion intent, a redacted
  revoked identity link, an anonymized user tombstone, one redacted completion
  audit, and the durable purge proof. Shared rows used by another scope remain
  byte-for-byte unchanged.

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
