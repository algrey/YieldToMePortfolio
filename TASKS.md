# YieldToMe executable backlog

Status: ordered implementation tasks  
Date: 2026-07-28

Rules:

- Work only on a task whose dependencies are complete and external decisions are satisfied.
- Keep each task to one focused implementation session. Split it if acceptance cannot be met safely.
- Update status, evidence, and any decision change in the same change set.
- “Parallel safe” means separate agents/branches can work concurrently after dependencies, not that integration needs no review.

Verification commands inherited by every task (and therefore part of each task):

```sh
npm run format:check
npm run lint
npm test
```

Run `npm run build` separately when `npm test` is narrowed during iteration, and run the task-specific test files/commands named in the task’s `Tests` field. A documentation-only spike may use link/traceability checks instead of a second build, but it must still run formatting and lint.

Status values: `DONE` foundation only, `READY`, `BLOCKED`, `PENDING`.

## Foundation

### FND-001 — Minimal responsive Cloudflare scaffold

Status: DONE in this foundation pass.

- Objective: establish a buildable, intentionally feature-free UI/runtime base that embodies the approved platform and visual direction.
- Dependencies: none.
- Requirements: PRD-003, PRD-004, PLAT-001, PLAT-002.
- Files: `app/**`, `public/**`, `worker/**`, `vite.config.ts`, `next.config.ts`, `package*.json`, `.openai/hosting.json`.
- Deliver: Vinext/React TypeScript shell; brand tokens; Overview and portfolio tab routes; manifest/icon; safe starter service worker; rendered HTML smoke test.
- Acceptance: no feature implementation or fake financial totals; 320 px and desktop layout foundations; direct routes build; production build succeeds.
- Tests: lint, production build, rendered-route smoke test.
- Risks: starter artifacts or unnecessary dependencies; service-worker caching too much.
- Parallel safe: no; this is the shared base.

### FND-002 — Environment, headers, and CI-equivalent quality gate

Status: READY after FND-001.

- Objective: make configuration, browser security policy, formatting, and repeatable quality checks explicit before protected features.
- Dependencies: FND-001.
- Requirements: AUTH-004, PLAT-001, QUAL-002.
- Files: `.env.example`, Worker/config files, middleware/response utilities, package scripts, CI workflow if repository policy permits.
- Deliver: typed environment validation; local/preview/production separation; CSP/referrer/frame/MIME/permissions headers; private no-store helper; deterministic `check` command.
- Acceptance: missing production config fails closed; no secret is client-exposed; private route test proves no-store/security headers.
- Tests: env schema unit tests, header route tests, lint/build/test.
- Risks: Vinext parity for Next middleware/headers; validate in Worker output.
- Parallel safe: yes with SPK tasks; coordinate shared config.

### SPK-001 — Lock the supplied 17-column CSV contract

Status: DONE by owner decision on 2026-07-28.

- Objective: establish the exact supplied header as the complete supported import contract without inferring fields from visual references.
- Dependencies: none.
- Requirements: IMP-006.
- Files: `docs/CSV_IMPORT_SPEC.md`, future parser fixtures.
- Deliver: record the exact 17 names/order, normalized header signature, safe unknown-header behavior, and compatibility policy.
- Acceptance: the supplied 17-column header remains exactly documented; no other schema is inferred; unknown headers fail safely without positional guessing.
- Tests: parser-version/header fixture tests.
- Risks: future exports may differ; add them only through an authoritative, separately versioned schema.
- Parallel safe: yes.

### SPK-002 — EODHD commercial rights, coverage, and cost approval

Status: BLOCKED pending provider response/owner approval.

- Objective: obtain and assess EODHD terms for delayed Australian and international prices in this hosted deployment, then approve the provider/cost or explicit EOD fallback.
- Dependencies: none.
- Requirements: MKT-007.
- Files: architecture decision record, provider configuration metadata, operational retention plan.
- Deliver: obtain written confirmation for private authorized-user display, server storage/cache, number/type of users, required Australian/international exchanges, FX, derived values, historical retention, backups, and termination purge; record the plan and total monthly/exchange cost.
- Acceptance: approved EODHD scope/plan/revalidation date is documented; representative Australian, US, European/UK, and FX symbols are verified; if unsuitable, the owner explicitly selects the next licensed provider or labelled EOD/manual fallback.
- Tests: configuration gate rejects an unapproved production provider.
- Risks: commercial/exchange fees may exceed public personal pricing; coverage/delay may vary by exchange; some observations may be indicative.
- Parallel safe: yes; blocks MKT-002 production work.

### SPK-003 — Future broker-sync contract

Status: PENDING; not in the v1 release scope.

- Objective: validate the documented broker/OAuth adapter boundary before any broker-specific dependency or credential storage is introduced.
- Dependencies: AUTH-002, LED-001, MKT-001.
- Requirements: BRK-001.
- Files: architecture decision, broker adapter contracts/fixtures, data-model extension, security threat model, future task split.
- Deliver: choose an initial broker candidate/use case; define connection/account/transaction/position/cash/quote capabilities, encrypted token lifecycle, cursor/idempotency, portfolio mapping, reconciliation, correction, and disconnection behavior.
- Acceptance: a sanitized fixture demonstrates repeat sync without duplicate ledger effects; positions only reconcile; optional quotes use the market-data abstraction and user entitlement; no broker password/screen scraping.
- Tests: adapter contract, repeated cursor page, corrected/deleted broker record, cross-user account mapping denial, token redaction/revocation, reconciliation drift.
- Risks: broker APIs/entitlements vary; OAuth token storage, rate limits, incomplete histories, and broker corrections require provider-specific validation.
- Parallel safe: future planning can run independently after its dependency contracts stabilize; implementation must not overlap ledger/auth schema changes.

## Identity and core persistence

### AUTH-001 — Verify Cloudflare Access JWT

Status: PENDING.

- Objective: establish a cryptographically verified Cloudflare Access principal at the Worker boundary.
- Dependencies: FND-002.
- Requirements: AUTH-001, AUTH-004.
- Files: `domain/auth/**`, protected route boundary, auth fixtures/tests.
- Deliver: extract `Cf-Access-Jwt-Assertion`; remote JWKS verification; issuer/audience/time/token-type checks; bounded key cache; fail-closed local/preview/production behavior.
- Acceptance: only valid configured application tokens produce a verified principal; errors disclose no claims/data.
- Tests: valid, missing, malformed, bad signature, wrong issuer/audience, expired, not-yet-valid, key rotation, service token.
- Risks: trusting forwarded headers or a stale hard-coded key.
- Parallel safe: yes with DB-001 after FND-002.

### DB-001 — Identity, portfolios, owned D1 repository

Status: PENDING.

- Objective: create the first owner-scoped relational boundary for identities, settings, and portfolio management.
- Dependencies: FND-002.
- Requirements: PRD-001, PRD-002, PRD-005, AUTH-003, PLAT-001.
- Files: `db/schema.ts`, migrations, owned repository/services, D1 integration tests.
- Deliver: users, user settings with required home currency, identities, portfolios initialized with the effective home/reporting currency, portfolio settings, currencies; composite ownership constraints/indexes; typed repository requiring user context.
- Acceptance: create/list/read/rename/archive is owner-scoped; new portfolios inherit home currency; changing home currency creates a recalculation/invalidation request rather than rewriting native facts; migrations apply locally; foreign keys on.
- Tests: constraints, same-user CRUD, cross-user read/write/ID enumeration denials, archive behavior.
- Risks: check-then-use ownership race; email-as-identity; migration compatibility.
- Parallel safe: yes with AUTH-001; merge before AUTH-002.

### AUTH-002 — Internal identity lifecycle and portfolio session

Status: PENDING.

- Objective: turn a verified Access principal into a lifecycle-aware internal user and active owned-portfolio context.
- Dependencies: AUTH-001, DB-001.
- Requirements: PRD-001, PRD-002, AUTH-002, AUTH-003, AUTH-005.
- Files: auth service, user/portfolio actions/routes, session/request context, tests.
- Deliver: `(issuer, subject)` mapping; controlled JIT provisioning; active/disabled/deletion checks; active portfolio resolution; admin-invited copy.
- Acceptance: email change does not alter ownership; disabled identity denied; client `user_id` ignored/rejected.
- Tests: first login, repeat login, email change, subject change, disabled user, service identity, cross-user portfolio.
- Risks: subject lifecycle when Access identity is removed/re-added; require explicit relink process.
- Parallel safe: no; central request context.

### OPS-001 — Audit and redacted observability foundation

Status: PENDING.

- Objective: make material mutations attributable and operational failures diagnosable without leaking financial data.
- Dependencies: DB-001, AUTH-002.
- Requirements: OPS-001, OPS-002.
- Files: audit schema/repository, log utilities, request correlation, tests.
- Deliver: append-only audit events; structured redacted logs; action/result codes; request IDs; initial auth/portfolio event instrumentation.
- Acceptance: material mutations have actor/target/result; logs omit tokens, emails, CSV rows, and amounts.
- Tests: audit insertion, append-only policy, redaction snapshots, correlation propagation.
- Risks: audit failures and primary mutation atomicity; define fail behavior per action.
- Parallel safe: yes with later domain design after request-context contracts stabilize.

## Ledger and import

### LED-001 — Transaction and cash ledger

Status: PENDING.

- Objective: implement the immutable currency-aware source of truth for transactions and cash.
- Dependencies: DB-001, AUTH-002, OPS-001.
- Requirements: LED-001, LED-002, LED-003, LED-005, DIV-001.
- Files: ledger/cash schema, domain services, repositories, migrations, tests.
- Deliver: immutable transactions, reversal/supersession, currency-aware cash accounts/entries, atomic audit/invalidation hooks.
- Acceptance: buy/sell/deposit/withdrawal/fee effects reconcile; unknown FX remains incomplete; cross-user access denied.
- Tests: all transaction types, fees/taxes, missing FX, reversal, idempotency, ownership, cash reconciliation.
- Risks: source transaction edit semantics and incomplete opening cash.
- Parallel safe: no; central financial write path.

### IMP-001 — Strict versioned 17-column parser

Status: PENDING.

- Objective: parse the supplied export deterministically into non-mutating normalized rows and actionable issues.
- Dependencies: FND-002.
- Requirements: IMP-001, IMP-004, IMP-006.
- Files: `domain/imports/**`, supplied/synthetic fixtures, parser unit tests.
- Deliver: bounded UTF-8 CSV parser for the exact supplied names `Id, Symbol, Name, Display Symbol, Exchange, Portfolio, Currency, Shares Owned, Cost Per Share, Commission, Transaction Date, Transaction Time, Purchase Exchange Rate, Type, Accounting, Accounting Execution Ids, Notes`; row grammar/classification; typed normalization/issues; file/row fingerprints.
- Acceptance: the supplied file yields 65 portfolio-security definition rows, 115 transaction rows, and 64 blank rows after normalized header matching; no D1 mutation; unknown headers fail safely.
- Tests: BOM, LF/CRLF, quoted commas/newlines, padded header, blank rows, dates, decimals, zero FX, duplicates, malicious/formula text, limits.
- Risks: parser library/runtime compatibility; date semantics.
- Parallel safe: yes with LED-001; no shared financial writes.

### IMP-002 — Import staging, mapping, and preview

Status: PENDING.

- Objective: let an owner resolve every portfolio/security ambiguity and understand the exact import impact before mutation.
- Dependencies: DB-001, DB-002, IMP-001, MKT-001.
- Requirements: IMP-002, IMP-003.
- Files: import batch/row/issue/mapping schema, services, preview route/UI contract, tests.
- Deliver: state machine from upload to ready; owned portfolio/security/exchange/currency mapping; reconciliation preview and issue report.
- Acceptance: no ledger changes before commit; ambiguous security blocks; preview exposes changes, duplicates, oversells, and completeness impacts.
- Tests: state transitions, ownership, conflict/mapping cases, multi-currency preview, issue resolution.
- Risks: accidentally mutating shared securities from user choices.
- Parallel safe: yes with LED-002 after contracts are fixed.

### IMP-003 — Idempotent import commit, reversal, and correction

Status: PENDING.

- Objective: turn an approved staged batch into resumable ledger effects that can be safely reversed or superseded.
- Dependencies: LED-001, IMP-002, OPS-001.
- Requirements: AUTH-004, LED-001, IMP-004, IMP-005, OPS-001.
- Files: import commit/reversal services, job/invalidation records, actions/routes, integration tests.
- Deliver: server revalidation, commit/chunk idempotency, atomic posting, resume, batch reversal, superseding corrected batch, audit.
- Acceptance: repeated request/file creates no duplicate financial effect; reversal restores projections/cash while retaining evidence; later dependent facts are safely blocked/explained.
- Tests: retry at every chunk boundary, duplicate rows/files, partial failure/resume, reversal, corrected re-import, cross-user and CSRF/idempotency denial.
- Risks: D1 transaction/query limits; later-lot dependencies.
- Parallel safe: no; integrates ledger/import/audit.

### LED-002 — FIFO lots, holdings, and realised gain projection

Status: PENDING.

- Objective: derive inspectable FIFO tax lots, sale matches, and current holdings from the ledger.
- Dependencies: LED-001.
- Requirements: LED-003, LED-004, CALC-003, CALC-004.
- Files: lot/projection schema, pure FIFO module, rebuild service, tests.
- Deliver: open tax lots, deterministic FIFO allocations, current holding projections, rebuild/invalidation.
- Acceptance: lot/holding/cash invariants reconcile; oversell rejected; reversal/rebuild produces identical results.
- Tests: partial/multi-lot sales, fees, FX, equal timestamps, split, reversal, residual rounding, incomplete basis.
- Risks: mutation ordering and rounding residuals.
- Parallel safe: yes with IMP-001/002; coordinate transaction contracts.

## Market data and calculations

### DB-002 — Security master and provider mapping schema

Status: PENDING.

- Objective: represent durable securities and validity-dated exchange/provider identifiers without treating ticker as identity.
- Dependencies: DB-001.
- Requirements: MKT-001.
- Files: `db/schema.ts`, migrations, repositories/tests.
- Deliver: exchanges, securities, validity-dated identifiers, provider registry/mappings, and owner-scoped portfolio-security links.
- Acceptance: canonical security identity is independent of ticker/provider; mapping validity/provenance and ownership constraints hold; ticker changes retain history.
- Tests: migration/foreign keys, mapping overlap/conflict service rules, ticker change/delisting, owned portfolio-security access.
- Risks: schema too provider-shaped or global master data being mutated by one user.
- Parallel safe: yes with LED-001 after schema coordination.

### DB-003 — Price, FX, split, and override schema

Status: PENDING.

- Objective: persist normalized price/FX/corporate-action observations and auditable user corrections with unambiguous provenance.
- Dependencies: DB-002.
- Requirements: MKT-003, MKT-004, MKT-006, MKT-008.
- Files: `db/schema.ts`, migrations, repositories/tests.
- Deliver: normalized price/FX observations, split events, manual overrides, provenance/revision/quality fields, and selection indexes.
- Acceptance: raw/adjusted/manual states cannot collide; duplicate observations are idempotent; owned override intervals are constrained.
- Tests: migrations/foreign keys, duplicate/corrected observation, adjustment state, rate direction, override conflict/ownership.
- Risks: ambiguous revision/upsert semantics or an index that cannot serve latest-by-date selection.
- Parallel safe: yes with pure calculation fixtures after normalized types freeze.

### DB-004 — Dividend, snapshot, and calculation-run schema

Status: PENDING.

- Objective: persist dividend facts and versioned disposable historical projections without mixing estimates or calculation versions.
- Dependencies: DB-002, DB-003.
- Requirements: CALC-006, DIV-001, DIV-002.
- Files: `db/schema.ts`, migrations, repositories/tests.
- Deliver: dividend events/receipts, portfolio/holding daily snapshots, calculation runs, completeness/high-water/version fields.
- Acceptance: estimated events cannot masquerade as receipts; snapshot calculation versions do not mix; all portfolio rows are owner-scoped.
- Tests: migration/foreign keys, event correction/supersession, receipt ownership, snapshot uniqueness/version, run lease/idempotency.
- Risks: schema coupling projections to one calculation version or over-retaining per-holding history.
- Parallel safe: yes with MKT-001; coordinate normalized event contracts.

### MKT-001 — Delayed-first provider-neutral contracts and rights gate

Status: PENDING.

- Objective: freeze provider-independent capabilities, normalized types, errors, fixtures, and production licensing activation rules.
- Dependencies: DB-002; production activation additionally depends on SPK-002.
- Requirements: MKT-001, MKT-002, MKT-007.
- Files: `domain/market-data/**`, provider fixtures, config gate/tests.
- Deliver: capability interfaces that distinguish delayed/EOD/manual observations and entitlement scope; normalized types/errors; server-only configuration; contractual-use activation check; deterministic delayed/EOD fixture adapter.
- Acceptance: UI/domain code has no EODHD types; unavailable capability is typed; unapproved production provider fails closed.
- Tests: adapter contract suite, rights/config states, malformed/outlier normalization.
- Risks: leaky provider symbol/payload assumptions.
- Parallel safe: yes with CALC-001 fixture design.

### MKT-002 — Rights-approved delayed quote adapter

Status: BLOCKED by SPK-002.

- Objective: connect the approved EODHD capabilities without leaking provider or contractual assumptions into the product domain.
- Dependencies: MKT-001, DB-003, SPK-002.
- Requirements: MKT-002, MKT-003, MKT-004, MKT-008.
- Files: server-only adapter, HTTP client, provider fixtures/contracts, tests.
- Deliver: the provider selected by SPK-002 with delayed/latest quote, symbol lookup, daily raw/adjusted history, FX, dividends, and splits only as contracted; pagination/rate-limit/retry; provenance.
- Acceptance: preferred delayed observations are available for representative approved Australian and international symbols or the task remains blocked; every value has mapping/currency/observation/ingestion/source/actual-delay/entitlement/quality; secrets/payloads never reach client/logs; only approved retention is stored.
- Tests: recorded sanitized fixtures, pagination, corrections, 429/retry, timeout, malformed decimal/date, Australian/US/European-or-UK/FX examples.
- Risks: commercial/display fees; exchange-specific delay and coverage; changing provider API; indicative data; contract scope.
- Parallel safe: yes with CALC-001 after normalized contract freezes.

### MKT-003 — Ingestion jobs, selection, staleness, and manual overrides

Status: PENDING.

- Objective: ingest and select observations reliably while exposing freshness, coverage, and reversible manual fallbacks.
- Dependencies: MKT-001, DB-003, OPS-001; live ingestion needs MKT-002.
- Requirements: MKT-005, MKT-006, MKT-008, OPS-001, OPS-002.
- Files: ingestion/job services, Cron handler, observation selector, override actions, tests.
- Deliver: idempotent upsert; delay-aware bounded refresh/backfill; canonical-security/rate-limit coalescing; deterministic delayed→EOD→manual selection; coverage/staleness; versioned override and invalidation.
- Acceptance: duplicate/corrected data behaves predictably; gaps never become zero; override removal restores provider result; job resumes safely.
- Tests: date/session fallback, stale thresholds, concurrent refresh, retry/lease, override intervals/supersession, ownership.
- Risks: Worker subrequest/execution limits; add Queue only after measurement.
- Parallel safe: yes with DIV-001 after observation contracts stabilize.

### CALC-001 — Decimal calculation domain

Status: PENDING.

- Objective: implement the normative financial formulas as deterministic decimal-domain results with explicit unavailability reasons.
- Dependencies: LED-002, MKT-001 fixture contract.
- Requirements: PRD-005, LED-002, CALC-001, CALC-002, CALC-003, CALC-004, CALC-005, CALC-007, MKT-004.
- Files: `domain/calculations/**`, independent fixtures/tests.
- Deliver: decimal primitives, date-appropriate native→home conversions and display result, market value, basis/gains, daily movement/decomposition, cash totals, named coverage results.
- Acceptance: formulas match `CALCULATIONS.md`; native/home toggle results share the same native facts and expose FX date/source; every unavailable result has reason; no binary-float path.
- Tests: all fixture families in financial rules, property/invariant tests, zero/missing denominators, rounding.
- Risks: denominator semantics and rate inversion.
- Parallel safe: yes with MKT-002 using fixture adapter.

### CALC-002 — Historical snapshots and rebuild

Status: PENDING.

- Objective: produce reproducible historical value series from dated ledger, price, FX, and cash facts.
- Dependencies: CALC-001, MKT-003, LED-002, DB-004.
- Requirements: LED-005, MKT-005, CALC-005, CALC-006.
- Files: snapshot services/jobs/repositories, chart response contract, tests.
- Deliver: daily quantities/cash, price/FX join, coverage/completeness, versioned snapshot invalidation and bounded rebuild.
- Acceptance: no back-cast current quantity; gaps/stale dates labelled; rebuild is deterministic and resumable.
- Tests: trades across boundaries, weekend/holiday, FX gaps, corrections/invalidation, calculation-version change, partial history.
- Risks: exchange/portfolio timezone cutoff; D1 growth.
- Parallel safe: no with snapshot UI contract; can precede UI.

### DIV-001 — Dividend events, receipts, and forecasts

Status: PENDING.

- Objective: keep provider events, actual cash receipts, and honest future-income estimates distinct and explainable.
- Dependencies: LED-001, DB-004, MKT-001, CALC-001.
- Requirements: DIV-001, DIV-002.
- Files: dividend domain/service/repositories, tests.
- Deliver: declared/paid/corrected event ingestion; actual receipts/cash; declared-then-TTM forecast; withholding assumption; gross/net/yield labels.
- Acceptance: estimates never post cash or enter actual returns; actual payment-date FX; irregular history does not over-annualize; provenance/method visible.
- Tests: declared vs paid, eligibility, special/irregular dividend, withholding, franking info, missing FX/history, corrections.
- Risks: eligibility/corporate-action completeness; tax implications—keep informational.
- Parallel safe: yes with CALC-002 after shared contracts.

## Product surfaces

### UI-001 — Authenticated shell, portfolio selection, and routes

Status: PENDING.

- Objective: replace the visual-only scaffold with the verified private session shell and real owned portfolio navigation.
- Dependencies: AUTH-002, FND-001.
- Requirements: PRD-002, PRD-003, PRD-004, PRD-005, QUAL-001.
- Files: protected layouts/components/routes, portfolio actions, tests.
- Deliver: brand shell; home-currency setting; portfolio selector/create/archive; Overview/Holdings/Quotes/Details/News routes; session menu; mobile tab behavior.
- Acceptance: active state/URLs/empty/error states; News honest placeholder; 44 px targets/safe areas/keyboard focus.
- Tests: route render/action ownership, semantic/keyboard checks, 320 px and desktop visual QA.
- Risks: selector leaking portfolio names in cached HTML; use no-store.
- Parallel safe: base shell first, then downstream screens can parallelize.

### UI-002 — Overview and historical value

Status: PENDING.

- Objective: present the portfolio’s known value, movement, history, income, and data coverage without overstating completeness.
- Dependencies: UI-001, CALC-002, DIV-001.
- Requirements: CALC-002, CALC-006, CALC-007, DIV-002, MKT-005, PRD-004, QUAL-001.
- Files: Overview route/components/contracts/tests.
- Deliver: value/cash/cost/gain/daily/income summaries; history chart/ranges; allocation summary; coverage/freshness/formula drill-down.
- Acceptance: partial/missing/estimated states unambiguous; chart text alternative; mobile hierarchy works.
- Tests: complete/partial/empty/stale histories, coverage, accessibility, responsive snapshots.
- Risks: calling partial totals full totals or forecast actual.
- Parallel safe: yes with UI-003/004/005 after shell/contracts.

### UI-003 — Holdings table and mobile cards

Status: PENDING.

- Objective: reproduce the reference’s dense holdings utility with a distinct, usable mobile hierarchy.
- Dependencies: UI-001, CALC-001, DIV-001.
- Requirements: CALC-002, DIV-002, MKT-005, PRD-004, PRD-005, QUAL-001.
- Files: Holdings route/components/tests.
- Deliver: dense sortable desktop table; mobile cards; native/home price-value menu for foreign holdings; quantity/basis/price/value/daily/gain/income columns; cash separation; row/FX explanation.
- Acceptance: sort missing values predictably; no horizontal dependency on mobile; source/as-of and unavailable reasons accessible.
- Tests: mixed currencies, long names, missing data, zero quantity, keyboard sorting, responsive QA.
- Risks: too many mobile facts; prioritize market value and gain.
- Parallel safe: yes.

### UI-004 — Quotes, freshness, refresh, and overrides

Status: PENDING.

- Objective: expose quote provenance/freshness and controlled refresh/correction workflows without calling EOD data live.
- Dependencies: UI-001, MKT-003.
- Requirements: MKT-003, MKT-005, MKT-006, MKT-008, QUAL-001.
- Files: Quotes route/components/actions/tests.
- Deliver: preferred delayed observation, source/time/actual delay/staleness/entitlement, EOD/manual fallback, previous close/change, refresh state, manual price/FX override with reason/history.
- Acceptance: active quotes prefer the approved delayed source; the UI says `Delayed 20 min` (or actual delay), not “live”; refresh is delay-aware/coalesced/rate-limited; fallback and overrides are visible and reversible.
- Tests: fresh/stale/missing/partial, override ownership/validation, refresh retries, accessibility.
- Risks: refresh abuse/provider cost; optimistic UI lying about data time.
- Parallel safe: yes.

### UI-005 — Details, ledger, and import workflow

Status: PENDING.

- Objective: make settings, ledger provenance, import review, mapping, and reversible corrections operable in one coherent area.
- Dependencies: UI-001, IMP-003, LED-002, MKT-003.
- Requirements: MKT-006, IMP-002, IMP-003, IMP-005, QUAL-001.
- Files: Details/import/ledger routes/components/actions/tests.
- Deliver: portfolio settings; transaction/lot/cash details; staged upload/map/preview/commit; batch history/reversal; mapping/override history.
- Acceptance: destructive operations confirm exact impact; issue rows/fields accessible; no state change before import commit; provenance drill-down.
- Tests: full supplied-file workflow, mapping corrections, retries/reversal, cross-user, keyboard/mobile, error recovery.
- Risks: largest screen/workflow; split UI subtasks if one session cannot preserve clarity.
- Parallel safe: sections may parallelize only after shared actions/contracts.

### PWA-001 — Offline-safe shell and connectivity states

Status: PENDING.

- Objective: make installation and offline failure graceful without persisting private financial responses on the device.
- Dependencies: FND-001, UI-001.
- Requirements: PLAT-002.
- Files: manifest, icon assets, service worker/registration, offline page, cache/header tests.
- Deliver: versioned public allowlist, navigation offline fallback, connectivity UI, disabled mutations, update lifecycle.
- Acceptance: Cache Storage contains no protected HTML/API/import/portfolio data; offline reload explains limits; standalone/iPhone metadata valid.
- Tests: cache allow/deny list, offline navigation, service-worker update, Safari/iPhone physical-device UAT.
- Risks: cached private response or stale worker; fail safe to network/offline page.
- Parallel safe: yes after shell asset paths settle.

## Operations and release

### OPS-002 — Backup, export, migration, and restore drill

Status: PENDING.

- Objective: prove that schema/data can be recovered beyond ordinary application rollback and within the stated RPO/RTO.
- Dependencies: DB-001, DB-002, DB-003, DB-004, OPS-001.
- Requirements: OPS-003.
- Files: operator runbook, scoped scripts/workflow config, drill evidence.
- Deliver: Time Travel bookmark procedure; encrypted long-term D1 export; migration checklist; restore verification; RPO/RTO record.
- Acceptance: non-production restore/drill verifies schema, ownership counts, representative data/calculations; secrets/exports access-controlled.
- Tests: scripted checksum/count verification and application smoke suite against restored DB.
- Risks: restore-in-place destructive operation; never drill against production.
- Parallel safe: yes late in Phase 3/4.

### OPS-003 — Retention, offboarding, export, and deletion

Status: PENDING.

- Objective: implement safe user offboarding and verified data lifecycle obligations across application and provider-derived data.
- Dependencies: AUTH-002, OPS-001, OPS-002, SPK-002.
- Requirements: AUTH-005, MKT-007, OPS-004.
- Files: lifecycle services/jobs, policy/runbook, UI/actions, integration tests.
- Deliver: disable immediately; owned data export; deletion-pending/idempotent purge; provider-cache termination purge; export/log retention.
- Acceptance: deleted user cannot authenticate; all owned rows/objects derived from deletion manifest are gone; minimal permitted tombstone/audit remains; cross-user data unaffected.
- Tests: disable/session, export completeness, repeated purge, partial-failure resume, FK order, provider purge, restore-policy interaction.
- Risks: irreversible deletion; require exact target resolution, cooling-off/confirmation, and recoverability disclosure.
- Parallel safe: no; cross-domain destructive path.

### QA-001 — Security, tenant, and accessibility hardening

Status: PENDING.

- Objective: systematically attempt tenant escape and accessibility/security failure before release.
- Dependencies: AUTH-002, UI-001 through UI-005, PWA-001.
- Requirements: PRD-001, AUTH-003, AUTH-004, QUAL-001.
- Files: security/a11y test suites, threat review, remediation files.
- Deliver: route/repository cross-tenant matrix; CSRF/header/CSP review; dependency audit; keyboard/screen-reader/contrast/reduced-motion review; private-cache audit.
- Acceptance: no high-severity open finding; every owned operation has denial test; core flows meet WCAG 2.2 AA intent.
- Tests: automated plus manual assistive-tech/device checklist.
- Risks: false confidence from automated accessibility/security tools; manual review required.
- Parallel safe: review can start per completed slice; final gate is serial.

### QA-002 — Preview UAT and release readiness

Status: PENDING.

- Objective: provide evidence that the complete preview release meets product, security, data, device, and operational gates.
- Dependencies: all release-scope tasks, OPS-002, OPS-003, QA-001.
- Requirements: OPS-002, OPS-003, QUAL-002.
- Files: release checklist/evidence, fixture expectations, runbooks; only fixes needed by evidence.
- Deliver: clean preview environment; Access invite/offboard test; supplied CSV end-to-end; calculation reconciliation; iPhone/desktop/PWA tests; backup/deletion drill evidence; go/no-go record.
- Acceptance: all product success measures and phase gates pass; provider rights active; no critical/high issue; known limitations displayed and documented.
- Tests: full lint/build/unit/integration/render/E2E suite plus manual UAT.
- Risks: production data or credentials entering preview; maintain strict environment separation.
- Parallel safe: test workstreams may run concurrently; go/no-go decision is serial.
