# YieldToMe executable backlog

Status: dependency-explicit implementation tasks grouped by workstream
Date: 2026-07-29

Rules:

- Work only on a task whose dependencies are complete and external decisions are satisfied.
- Section order groups related work; dependency fields and the implementation plan, not physical file position, define execution order.
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

Status values: `DONE` foundation only, `IN PROGRESS`, `READY`, `BLOCKED`, `PENDING`, `DEFERRED` (not in the active release scope).

## Next milestone: authenticated owned-workspace slice

Status: PLANNED; next active vertical slice after the approved preview.

Objective: make the product privately testable with a verified Access identity and an owner-scoped portfolio workspace before enabling financial writes or live market data. This slice is intentionally read-only and should end with an authenticated user able to select an owned portfolio and see honest empty/loading/error states at the existing dense mobile widths.

Executable order:

1. `UI-001` — authenticated shell, portfolio selection, and stable Overview/Holdings/Quotes/Details/News routes.
2. `OPS-001` — audit and redacted observability foundation for the authenticated request context.

Demo checkpoint A after `UI-001` and `OPS-001`:

- sign in with the local/preview Access fixture;
- verify a user can see only their own portfolio selector and direct routes;
- verify an empty owned portfolio and unavailable/failed states are explicit;
- verify audit events and logs contain no tokens, emails, CSV rows, or amounts;
- verify the dense 320/390px layout remains usable and no production fixture route is exposed.

Following domain layer (READY, but not part of checkpoint A): `LED-002A` pure FIFO allocation, `DB-004` snapshot/run schema, and `MKT-002` Yahoo-compatible adapter. These should feed the next financial read slice after checkpoint A; ledger posting, import mapping/commit, calculations, and live quote UI remain PENDING until their dependencies complete.

## Milestone: demonstrable CSV portfolio preview

Status: COMPLETE on 2026-07-29; owner approved continuation into the production dependency spine.

Objective: deliver a reviewable, fixture-backed product slice before continuing the production dependency spine. It is deliberately a read-only preview: it parses the supplied CSV into an in-memory sample portfolio, uses deterministic local price/FX fixtures, and never creates D1 ledger facts or calls a market-data provider.

Scope rules:

- Reuse the completed parser (`IMP-001`) and dense mobile prototype (`UI-PROT-001`); do not reconcile the independent screenshot and CSV fixture contents.
- The preview calculation contract is a narrow, explicit substitute for the broader ledger/FIFO, persisted pricing, and historical-performance tasks. It must use decimal strings and show unavailable values rather than fabricate zeroes.
- Production authentication, D1 import staging/commit, live market-data ingestion, refresh/background jobs, advanced history/performance, deletion, and operational hardening remain after this milestone. They may now advance only when their own dependencies and decisions are satisfied.
- A fixture label is required in the preview shell and on the holding detail. Routine source/delay/timestamp labels remain absent; this is an intentional, visible exception because no live provider is involved.
- “Cloudflare preview” means a non-production deployment using the repository’s preview configuration. The preview-only sample route must be unavailable in the production environment.

### VSL-001 — Build a parsed sample-portfolio projection input

Status: DONE on 2026-07-29.

- Objective: turn the supplied `docs/Example_Portfolio.csv` into a repeatable, non-persistent sample-portfolio input using the completed strict parser.
- Dependencies: `IMP-001`, `UI-PROT-001`.
- Requirements: `IMP-001`, `IMP-004`, `PRD-003`, `PRD-004`.
- Files: preview-only CSV loader/adapter, fixture assertions, and focused parser-to-preview tests.
- Deliver: a typed in-memory sample portfolio containing displayable securities, transactions, cash rows, currencies, and explicit exclusions/issues; no client-side raw CSV parsing and no D1 mutation.
- Acceptance: the supplied CSV is parsed through the production parser rather than duplicated data; the known parser counts remain asserted; each included preview holding is traceable to parsed rows; unsupported/incomplete rows are explicit and do not become holdings or zero values.
- Tests: supplied-file parse-to-projection fixture, deterministic ordering, malformed/unavailable projection state, and no-D1/no-network boundary test.
- Risks: treating a CSV definition row as a trade or implying complete cash/history; retain the parser classification and preview limitations.
- Parallel safe: no; this defines the shared preview data contract.
- Completion note: Added a server-only preview fixture adapter that parses `docs/Example_Portfolio.csv` through the production parser, groups displayable holdings/closed/reference securities with row-level traceability, and records explicit blank-row exclusions plus malformed/unavailable projection states.

### VSL-002 — Deterministic preview valuation contract

Status: DONE on 2026-07-29.

- Objective: calculate the sample portfolio’s quantity, cost, current value, daily movement, and gain from decimal CSV facts plus deterministic price and FX fixtures.
- Dependencies: `VSL-001`.
- Requirements: `CALC-001`, `CALC-002`, `CALC-003`, `CALC-005`, `CALC-007`, `MKT-004`.
- Files: preview calculation module, price/previous-close/FX fixtures, independently expected-result fixtures, and unit tests.
- Deliver: a narrow chronological holding projection with explicit quantity/cost basis rules, selected current and previous fixture observations, and fixture FX conversion for every non-home-currency valuation; typed unavailable/partial outcomes.
- Acceptance: expected holdings reconcile independently for quantity, cost, value, daily movement, and gain; price/FX direction is explicit; all financial inputs and outputs are decimal strings; a missing fixture price or FX renders the affected metric unavailable rather than zero; no historical chart, provider adapter, database, or background refresh is introduced.
- Tests: same-currency and FX-valued holdings, direct/inverse/identity FX, buy/sell projection, gain/daily formula, rounding, missing price/FX, and fixture determinism.
- Risks: silently substituting a simplified projection for the production FIFO ledger; name its rules in the preview explanation and keep `LED-002A`, `CALC-001A`, and `CALC-001B` pending.
- Parallel safe: no; its result is the UI contract.
- Completion note: Added a deterministic preview valuation engine with exact decimal arithmetic, fixture price/FX conversion, same-currency and FX scenarios, buy/sell projection coverage, and shared expected-result fixtures for the sample portfolio and edge cases.

### Demo checkpoint A — parsed and valued sample

Gate: `VSL-001` and `VSL-002` are DONE.

- Evidence: a developer can run the local preview data test and inspect a stable, human-readable sample result showing parsed-row counts plus at least one quantity/cost/value/daily/gain calculation and one fixture-FX case.
- Review question: do the sample composition and calculated figures provide a credible basis for the product screens before UI integration?

### VSL-003 — Preview-only route and fixture-data boundary

Status: DONE on 2026-07-29.

- Objective: make the sample portfolio safely available to local development and Cloudflare preview routes without enabling a production data path.
- Dependencies: `VSL-002`, `FND-002A`.
- Requirements: `PRD-003`, `PRD-004`, `MKT-003`, `QUAL-002`.
- Files: preview route/data boundary, environment guard, route tests, and configuration documentation.
- Deliver: stable Overview, Holdings, and holding-detail route inputs sourced only from the sample projection; a concise `Fixture market data` indicator; local and preview configuration; production rejection/absence for the sample route.
- Acceptance: no authenticated/session/D1/provider dependency is added; preview routes render from the same deterministic fixture result locally and in a Cloudflare preview; production does not expose the fixture portfolio; routine provenance labels are not added beyond the required fixture indicator.
- Tests: local/preview allowed, production denied/absent, fixture indicator present, direct route rendering, and no provider-network request.
- Risks: an accidentally public production demo or fixture data leaking into a future real-data route.
- Parallel safe: no; establishes the review surface boundary.
- Completion note: Added a preview-route boundary for `/portfolio/preview/*` with a visible `Fixture market data` indicator, preserved local/preview rendering, and returned 404 from production before the sample portfolio can leak into the public path.

### VSL-004 — Connect the dense Overview and Holdings screens

Status: DONE.

- Objective: replace the relevant prototype mock values with the parsed sample and deterministic valuation while preserving the approved dense mobile layout.
- Dependencies: `VSL-003`.
- Requirements: `PRD-003`, `PRD-004`, `CALC-002`, `CALC-003`, `CALC-005`, `CALC-007`, `QUAL-001`.
- Files: Overview/Holdings preview components, visual/route tests, and approved capture evidence.
- Deliver: Overview summary and Holdings list showing quantity, cost, current value, daily movement, and gain from `VSL-002`; native/home-currency presentation where fixture FX applies; compact four-column mobile rows and fixed summary consistent with `docs/UI_SPEC.md`.
- Acceptance: Overview and Holdings are navigable at 320, 390, and 430 CSS pixels without document overflow; every shown total is derived from the shared projection; unavailable data reads `Price unavailable`; all populated preview screens visibly identify fixture market data without adding timestamp/source clutter.
- Tests: calculated-value render assertions, Overview/Holdings navigation, unavailable-price state, 320/390/430 responsive screenshots, keyboard/touch navigation, format/lint/build.
- Risks: fitting real calculated values into a layout designed around static examples; preserve the approved hierarchy rather than adding cards or horizontal scrolling.
- Parallel safe: no; shared routes and layout.
- Completion note: Connected the preview Overview and Holdings screens to the deterministic valuation fixture, kept the dense mobile layout intact at 320/390/430 px, and verified fixture labels, price-unavailable handling, and build/test gates.

### Demo checkpoint B — interactive overview and holdings

Gate: `VSL-003` and `VSL-004` are DONE.

- Evidence: local iPhone-width walkthrough of Overview and Holdings using the supplied CSV, with the fixture-data indicator visible and calculated values matching the deterministic result.
- Review question: does the dense mobile product now read as a credible portfolio app, and are the fixture labels clear without consuming meaningful screen space?

### VSL-005 — Holding-detail drill-down

Status: DONE.

- Objective: complete the review flow by linking a holding row to a compact detail view of its calculated facts and fixture-data explanation.
- Dependencies: `VSL-004`.
- Requirements: `PRD-003`, `PRD-004`, `PRD-005`, `CALC-002`, `CALC-003`, `CALC-005`.
- Files: holding-detail route/component, navigation and render tests, screenshot evidence.
- Deliver: direct holding route; row-level navigation from Holdings; security/currency/quantity/cost/current value/daily movement/gain facts; native/home display explanation where FX is used; concise fixture-data label.
- Acceptance: direct navigation and back navigation work at iPhone widths; the detail facts exactly match Overview/Holdings values; there is no fabricated live status, chart, transaction editor, or production provenance UI.
- Tests: direct/deep route render, row navigation, native/home fixture conversion, unavailable metric, 320/390 width captures, keyboard semantics.
- Risks: detail expansion turning into the deferred ledger, provider, or advanced-performance surface.
- Parallel safe: no; follows the final Overview/Holdings contract.
- Completion note: Added preview holding deep routes and row links, promoted the shared valuation facts into a compact accessible detail sheet with back navigation, and verified fixture/currency and unavailable-price explanations without adding live or mutation behavior.

### VSL-006 — Preview deployment and review evidence

Status: DONE on 2026-07-29.

- Objective: publish the completed vertical slice to a Cloudflare preview and package the evidence required for owner review.
- Dependencies: `VSL-005`.
- Requirements: `PRD-003`, `PRD-004`, `QUAL-001`, `QUAL-002`.
- Files: preview deployment configuration/evidence, capture manifest, and only fixes required by final verification.
- Deliver: successful local run instructions; a non-production Cloudflare preview URL; 320/390/430 iPhone-width screenshots for Overview, Holdings, and holding detail; calculation/fixture evidence; deployed-route smoke evidence.
- Acceptance: the deployed preview uses the supplied CSV and deterministic fixture values; Overview, Holdings, and holding detail work by direct URL; the fixture-data indicator is visible; screenshots show no horizontal overflow; `format:check`, lint, test, and production build pass; no production auth/live provider/background-job/deletion capability is enabled as part of deployment.
- Tests: full repository quality gate, deployed preview smoke check, manual iPhone-width route walkthrough, and screenshot/capture manifest review.
- Risks: preview credentials/configuration being mistaken for production configuration; retain explicit environment separation and do not commit secrets or preview data exports.
- Parallel safe: no; serial release evidence task.
- Completion note: Published the validated fixture harness through a temporary Cloudflare Quick Tunnel, verified all required direct routes and security markers, captured 320/390/430 evidence with no horizontal overflow, and recorded the review URL and fixture assertions in the evidence manifest; production remains unchanged.

### Demo checkpoint C — deployed vertical-slice review

Gate: `VSL-005` and `VSL-006` are DONE.

- Evidence: Cloudflare preview URL plus the required Overview, Holdings, and holding-detail iPhone-width screenshots and calculation fixture manifest.
- Review question: approve the product direction before resuming production authentication, persistence, live market data, and operational work.

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

### FND-002A — Worker configuration, binding types, and runtime profile

Status: DONE on 2026-07-29.

- Objective: make the generated Worker configuration explicit, type-safe, and free of unapproved runtime bindings before domain work starts.
- Dependencies: FND-001.
- Requirements: PLAT-001, QUAL-002.
- Files: `.env.example`, Worker/Vite/Wrangler config, generated Cloudflare type file, config tests.
- Deliver: typed environment validation; local/preview/production separation; explicit Workers plan/profile; `.env.example` defaults `MARKET_DATA_PROVIDER=disabled`; remove owner/use-scope/provider-policy flags, premature second-provider credentials, and the unapproved `IMAGES` binding/code path; generate current Cloudflare runtime types with `wrangler types`.
- Acceptance: missing production config fails closed; the production profile requires Workers Paid for CSV import; Free profile rejects import unless a separately approved measured limit exists; provider enablement has no source-specific user-count, owner-binding, deployment-mode, monetization, redistribution, or external-use gate; Alpha Vantage or another second provider is absent until a capability task approves it; generated Worker code references no undeclared binding; Cloudflare runtime types are generated rather than hand-maintained.
- Tests: env/config unit tests, `wrangler types --check`, `tsc --noEmit`, `vinext check`, generated-Worker binding/config inspection, build.
- Risks: Vinext/Vite local configuration diverging from generated Wrangler output; inspect both.
- Parallel safe: yes with SPK tasks; coordinate shared config.
- Completion note: Added explicit `wrangler.json` environment profiles, fail-closed runtime config validation, generated Worker typing, removed the undeclared `IMAGES` path plus premature provider-policy/second-provider config, and added config tests that inspect both source and generated Worker output.

### FND-002B — Security headers and CI-equivalent quality gate

Status: DONE on 2026-07-29.

- Objective: establish one reproducible security/quality gate that later implementation tasks can invoke without relying on transpile-only success.
- Dependencies: FND-002A.
- Requirements: AUTH-004, QUAL-002.
- Files: middleware/response utilities, package scripts, route/header tests, CI workflow if repository policy permits.
- Deliver: CSP/referrer/frame/MIME/permissions headers; private no-store helper; `typecheck` script; deterministic aggregate `check` command covering formatting, lint, typecheck, Vinext compatibility, build, and tests.
- Acceptance: a protected-route fixture proves no-store/security headers; no secret is client-exposed; `typecheck` catches an intentional fixture error; any failed constituent command makes the aggregate command non-zero.
- Tests: header route tests, package-script failure propagation, format/lint/typecheck/`vinext check`/build/test.
- Risks: headers behaving differently in generated Worker output or a nominal check omitting strict type analysis.
- Parallel safe: no; merge this shared baseline before implementation branches.
- Completion note: Added Worker-wide CSP, frame, referrer, MIME, permissions, and private no-store response policy plus tested `typecheck`, `vinext:check`, and fail-fast aggregate `check` scripts. Follow-up review replaced `script-src 'unsafe-inline'` with a request-scoped nonce, authorizes all seven Vinext bootstrap scripts, and proves an arbitrary inline script is excluded.

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

### SPK-002 — Free Yahoo-source technical decision

Status: DONE by owner decision on 2026-07-28.

- Objective: establish the zero-cost v1 Yahoo Finance/yfinance-compatible source and its technical operating boundary.
- Dependencies: none.
- Requirements: MKT-007.
- Files: architecture decision record, provider configuration metadata, operational retention plan.
- Deliver: record the no-cost decision, server-only Worker implementation boundary, best-effort behavior, manual fallback, and the rule that a second provider requires measured technical need.
- Acceptance: provider enablement is ordinary server configuration with no source-specific user-count, owner-binding, deployment-mode, monetization, redistribution, or external-use restriction; all values carry source/time/quality internally and have a manual fallback; external provider-use decisions remain outside product code and tasks.
- Tests: enabled/disabled configuration, malformed response, missing symbol, throttle, and fallback states.
- Risks: Yahoo endpoint changes, throttling, incomplete coverage, and undefined delay.
- Parallel safe: yes; unlocks MKT-002 after its normal dependencies.

### SPK-003 — Future broker-sync contract

Status: DEFERRED; not in the v1 release scope.

- Objective: validate the documented broker/OAuth adapter boundary before any broker-specific dependency or credential storage is introduced.
- Dependencies: AUTH-002, LED-001B, MKT-001.
- Requirements: BRK-001.
- Files: architecture decision, broker adapter contracts/fixtures, data-model extension, security threat model, future task split.
- Deliver: choose an initial broker candidate/use case; define connection/account/transaction/position/cash/quote capabilities, encrypted token lifecycle, cursor/idempotency, portfolio mapping, reconciliation, correction, and disconnection behavior.
- Acceptance: a sanitized fixture demonstrates repeat sync without duplicate ledger effects; positions only reconcile; optional quotes use the market-data abstraction and user entitlement; no broker password/screen scraping.
- Tests: adapter contract, repeated cursor page, corrected/deleted broker record, cross-user account mapping denial, token redaction/revocation, reconciliation drift.
- Risks: broker APIs/entitlements vary; OAuth token storage, rate limits, incomplete histories, and broker corrections require provider-specific validation.
- Parallel safe: future planning can run independently after its dependency contracts stabilize; implementation must not overlap ledger/auth schema changes.

## Identity and core persistence

### AUTH-001 — Verify Cloudflare Access JWT

Status: DONE on 2026-07-29.

- Objective: establish a cryptographically verified Cloudflare Access principal at the Worker boundary.
- Dependencies: FND-002B.
- Requirements: AUTH-001, AUTH-004.
- Files: `domain/auth/**`, protected route boundary, auth fixtures/tests.
- Deliver: extract `Cf-Access-Jwt-Assertion`; remote JWKS verification; issuer/audience/time/token-type checks; bounded key cache; fail-closed local/preview/production behavior.
- Acceptance: only valid configured application tokens produce a verified principal; errors disclose no claims/data.
- Tests: valid, missing, malformed, bad signature, wrong issuer/audience, expired, not-yet-valid, key rotation, service token.
- Risks: trusting forwarded headers or a stale hard-coded key.
- Parallel safe: yes with DB-001A after FND-002B.
- Completion note: Added a Worker-bound Access JWT verifier with remote JWKS fetching, bounded key caching, issuer/audience/time/type checks, and fail-closed generic denials; updated route and security-header tests to exercise authenticated rendering and rejection cases under signed fixtures.

### DB-001A — Identity and portfolio schema migration

Status: DONE on 2026-07-29.

- Objective: establish the smallest reviewed D1 schema for identity, settings, currencies, and owned portfolios.
- Dependencies: FND-002B.
- Requirements: PRD-001, PRD-002, PRD-005, AUTH-003, PLAT-001.
- Files: `db/schema.ts`, generated migration, environment-specific D1 binding/type configuration, D1 migration tests.
- Deliver: currencies, users, user settings with required home currency, identities, portfolios initialized with effective reporting currency, portfolio settings, composite ownership constraints/indexes; configure the `DB` binding per environment and regenerate its types.
- Acceptance: generated migration applies to a clean local D1 with foreign keys enabled; preview/production generated Worker configuration contains the intended non-placeholder `DB` binding before any protected data route is enabled; constraints reject duplicate identities, invalid enums, and cross-owner composite references; no repository/API is added in this task.
- Tests: migration apply, schema/foreign-key/index assertions, invalid constraint fixtures.
- Risks: migration incompatibility or a schema that cannot support owner-scoped queries.
- Parallel safe: yes with AUTH-001 and IMP-001 after FND-002B.
- Completion note: Added the reviewed D1 schema for currencies, users, user settings, user identities, portfolios, and portfolio settings; generated and validated the first migration; configured `DB` in Wrangler/hosting metadata and regenerated Worker types for the protected-boundary foundation.

### DB-001B — Owned portfolio repositories and services

Status: DONE on 2026-07-29.

- Objective: provide the only supported owner-scoped access path for user settings and portfolio lifecycle.
- Dependencies: DB-001A.
- Requirements: PRD-001, PRD-002, PRD-005, AUTH-003.
- Files: owned repository/services and D1 integration tests.
- Deliver: typed repositories that require user context; create/list/read/rename/archive/restore; home-currency rebase request contract without implementing calculations.
- Acceptance: every operation predicates owner and resource in one SQL statement; new portfolios inherit home currency; a home-currency change records an invalidation request rather than rewriting native facts.
- Tests: same-user CRUD, cross-user read/write/ID-enumeration denials, archive/restore, optimistic version conflict, query-shape assertions.
- Risks: check-then-use ownership race or a generic repository that permits unscoped access.
- Parallel safe: yes with AUTH-001; merge before AUTH-002.
- Completion note: Added owner-scoped portfolio and user-settings repositories on top of the reviewed D1 schema, including create/list/read/rename/archive/restore, inherited home-currency selection for new portfolios, and a home-currency rebase request contract that leaves native facts unchanged.

### AUTH-002 — Internal identity lifecycle and portfolio session

Status: DONE on 2026-07-29.

- Objective: turn a verified Access principal into a lifecycle-aware internal user and active owned-portfolio context.
- Dependencies: AUTH-001, DB-001B.
- Requirements: PRD-001, PRD-002, AUTH-002, AUTH-003, AUTH-005.
- Files: auth service, user/portfolio actions/routes, session/request context, tests.
- Deliver: `(issuer, subject)` mapping; controlled JIT provisioning; active/disabled/deletion checks; active portfolio resolution; admin-invited copy.
- Acceptance: email change does not alter ownership; disabled identity denied; client `user_id` ignored/rejected.
- Tests: first login, repeat login, email change, subject change, disabled user, service identity, cross-user portfolio.
- Risks: subject lifecycle when Access identity is removed/re-added; require explicit relink process.
- Parallel safe: no; central request context.
- Completion note: Added issuer/subject identity mapping with controlled active/pending/disabled JIT policy, preserved link-time email metadata, disabled/revoked/deletion checks, and an owner-scoped authenticated request context that resolves an active portfolio without accepting client user IDs; added lifecycle and cross-user tests.

### OPS-001 — Audit and redacted observability foundation

Status: DONE on 2026-08-02.

- Objective: make material mutations attributable and operational failures diagnosable without leaking financial data.
- Dependencies: DB-001A, AUTH-002.
- Requirements: OPS-001, OPS-002.
- Files: audit schema/repository, log utilities, request correlation, tests.
- Deliver: append-only audit events; structured redacted logs; action/result codes; request IDs; initial auth/portfolio event instrumentation.
- Acceptance: material mutations have actor/target/result; logs omit tokens, emails, CSV rows, and amounts.
- Tests: audit insertion, append-only policy, redaction snapshots, correlation propagation.
- Risks: audit failures and primary mutation atomicity; define fail behavior per action.
- Parallel safe: yes with later domain design after request-context contracts stabilize.
- Completion note: Added the append-only `audit_events` schema/repository with owner-scoped listing, SQLite update/delete guards, structured redacted logs, safe request-ID propagation, and initial auth, portfolio, and home-currency mutation instrumentation. Tests cover actor/target/result/correlation fields, token/email/CSV/amount redaction, append-only enforcement, and Worker response correlation; generated trigger SQL is retained because Drizzle does not model triggers.
- Review finding: portfolio and home-currency mutations currently commit their primary write before appending the audit event. Implement a D1-batched atomic write (or an explicitly documented durable failure policy) and fault-injection tests so an audit failure cannot produce an ambiguous mutation outcome.
- Completion: Wrapped portfolio lifecycle, home-currency rebase, and identity touch/provision mutations with atomic primary-write-plus-audit transactions. Audit append failures now roll back the mutation; fault-injection tests cover portfolio rename and home-currency change while existing redaction, append-only, ownership, and request-correlation coverage remains green.
- Review finding: the atomic helpers use SQLite `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` through the generic statement client, but production D1 requires `D1Database.batch()` for atomic units. Replace the transaction abstraction with a D1 batch-capable client (and SQLite test equivalent), then add production-shaped batch rollback/failure tests before marking this task complete.
- Review completion: Added an optional typed `SqlClient.batch()` contract backed by `D1Database.batch()` in Workers and transaction-wrapped batches in SQLite tests. Portfolio lifecycle, home-currency, display-view, and identity provision/login audit units now use the batch path; a D1-shaped injected audit failure proves the primary portfolio write rolls back atomically.

## Ledger and import

### LED-001A — Transaction and cash ledger schema

Status: DONE on 2026-07-29.

- Objective: establish enforceable owner/portfolio relationships and typed event rules before any financial posting service.
- Dependencies: DB-001A, DB-002.
- Requirements: LED-001, LED-002, LED-003, LED-005.
- Files: ledger/cash schema, generated migration, pure event validators, migration tests.
- Deliver: immutable transaction, cash-account, and cash-entry tables; reversal/supersession fields; composite owner/portfolio/membership/import/self references; exact-decimal/event-type validators.
- Acceptance: D1 rejects cross-owner and cross-portfolio child links; the exact legacy `=CASH` normalization target exists as explicit cash events; no mutation route/service is added.
- Tests: migration/foreign keys, invalid event shapes, cross-portfolio references, reversal uniqueness, decimal syntax.
- Risks: a direct opaque-ID foreign key that bypasses owner/portfolio agreement.
- Parallel safe: yes with AUTH-002 after DB-002 schema coordination.
- Completion note: Added generated transactions, cash accounts, and cash ledger entry migrations with composite owner/portfolio/membership/import/self-reference constraints, typed status/source checks, exact-decimal event validators, and migration/foreign-key fixtures; no posting service or mutation route was added.

### LED-001B — Owned ledger posting, reversal, and cash service

Status: DONE on 2026-08-03.

- Objective: implement the single owner-scoped financial write path over the approved ledger schema.
- Dependencies: LED-001A, DB-001B, AUTH-002, OPS-001.
- Requirements: LED-001, LED-002, LED-003, LED-005.
- Files: ledger/cash domain services, repositories, integration tests.
- Deliver: buy/sell/deposit/withdrawal/fee/tax and explicit split posting; transaction FX provenance; reversal/supersession; cash effects; D1 atomic batch with audit and invalidation record. Transfers and dividends remain unavailable.
- Acceptance: financial events and cash effects reconcile; unknown FX remains incomplete; repeated idempotency key returns the original result; no cross-user or cross-portfolio write succeeds.
- Tests: event types, fees/taxes, split ratio/idempotency, imported/manual FX, reversal, retry/idempotency, ownership, cash reconciliation, atomic-batch rollback.
- Risks: source edit semantics, partial batch writes, and incomplete opening cash.
- Parallel safe: no; central financial write path.
- Completion note: Added owner-scoped exact-decimal ledger posting for trades, cash events, fees, taxes, and splits with native FX provenance, signed cash effects, idempotent retries, reversal/supersession, calculation invalidation, audit, atomic rollback, and cross-owner/portfolio denial coverage.
- Review completion: Added calendar-date validation and made idempotent retries return the original result after portfolio archival; focused and repository checks pass.
- Review finding: `LedgerPostingInput` accepts both `idempotencyKey` and optional `sourceReference`, but `transactions` persists only `source_reference` and retries look up the substituted source reference. Reusing an idempotency key with a different source reference can create a duplicate transaction. Add an owner/portfolio-scoped persisted idempotency key (or explicitly make source reference the immutable idempotency key), enforce conflict semantics, and add a regression test before marking this task complete.
- Review completion: Persisted `idempotency_key` independently of `source_reference` with an owner/portfolio unique index, preserved exact retries after archival, rejected key reuse with changed source or financial intent, rejected source-reference reuse under a different key, and added owner-scope plus migration regression coverage. The additive migration backfills only unambiguous legacy source references because overwritten historical keys cannot be reconstructed safely.

### IMP-001 — Strict versioned 17-column parser

Status: DONE on 2026-07-29.

- Objective: parse the supplied export deterministically into non-mutating normalized rows and actionable issues.
- Dependencies: FND-002B.
- Requirements: IMP-001, IMP-004, IMP-006.
- Files: `domain/imports/**`, supplied/synthetic fixtures, parser unit tests.
- Deliver: bounded UTF-8 CSV parser for the exact supplied names `Id, Symbol, Name, Display Symbol, Exchange, Portfolio, Currency, Shares Owned, Cost Per Share, Commission, Transaction Date, Transaction Time, Purchase Exchange Rate, Type, Accounting, Accounting Execution Ids, Notes`; row grammar/classification; typed normalization/issues; file/row fingerprints.
- Acceptance: the supplied file yields 65 definition rows, 115 physical transaction rows, and 64 blank rows after normalized header matching; its four `AUD=CASH` transactions normalize to explicit cash events and no security/lot; no D1 mutation; unknown headers fail safely.
- Tests: BOM, LF/CRLF, quoted commas/newlines, padded header, blank rows, dates, decimals, zero FX, exact/malformed `=CASH`, duplicates, malicious/formula text, 10 MiB/100,000-row/field bounds under Worker memory limits, and Free-profile rejection before body parsing.
- Risks: parser library/runtime compatibility; date semantics.
- Parallel safe: yes with LED-001A; no shared financial writes.
- Completion note: Added a strict versioned CSV parser for the supplied 17-column export, including header normalization, row classification, cash-row normalization, duplicate fingerprints, and upload gating for Free-plan rejection before body parsing.

### IMP-002A — Owned import staging state machine

Status: DONE on 2026-07-29.

- Objective: persist bounded parser output and issues without creating portfolios, securities, or ledger facts.
- Dependencies: DB-001A, IMP-001.
- Requirements: IMP-002, IMP-004.
- Files: import batch/row/issue schema, migration, staging service/tests.
- Deliver: owner-scoped upload/parsed/invalid/needs-mapping/ready transitions; normalized rows/issues; file/row fingerprints; optimistic versioning.
- Acceptance: only legal transitions succeed; staged data is owner-scoped; duplicate upload returns the existing batch outcome; no portfolio/security/ledger table changes.
- Tests: migration/foreign keys, transitions, duplicate hash, row bounds, cross-user access, concurrent transition conflict.
- Risks: staging rows becoming visible as financial truth.
- Parallel safe: yes with LED-001A work.
- Completion note: Added owner-scoped import batch, row, and issue persistence with optimistic status transitions, duplicate-file reuse, and parser-output staging backed by a reviewed SQLite migration and repository tests.

### IMP-002B — Import mapping, reconciliation, and preview contract

Status: DONE (2026-07-30).

- Objective: let an owner resolve every portfolio/security/FX ambiguity and inspect exact effects before commit.
- Dependencies: IMP-002A, DB-001B, DB-002, LED-002A.
- Requirements: IMP-002, IMP-003.
- Files: mapping/reconciliation services, preview response contract, tests.
- Deliver: owned portfolio mapping; private unresolved security candidates; exchange/currency/FX decisions; duplicate/oversell/completeness reconciliation; issue report.
- Acceptance: ambiguous security and FX direction block; preview counts and projected quantities are deterministic; no shared security is mutated by a user decision; no ledger changes occur.
- Tests: ownership, conflicts, mapping scopes, cash sentinel, duplicate/oversell, multi-currency and incomplete-history previews.
- Risks: accidental shared-master mutation or preview logic diverging from commit.
- Parallel safe: yes after contracts freeze; no UI in this task.
- Completion: Added owner-scoped, reusable import mapping decisions and a pure deterministic reconciliation/preview contract. Ambiguous portfolio/security/FX mappings, duplicate rows, oversells, and incomplete history are surfaced as explicit issues; cash sentinels remain cash-only, unresolved candidates remain private, projected quantities are exact-decimal, and no ledger or shared security master rows are mutated.

### IMP-003A — Idempotent import commit and resume

Status: READY.

- Objective: turn an approved staged batch into bounded, resumable ledger effects with no duplicate visibility.
- Dependencies: LED-001B, LED-002B, IMP-002B, OPS-001.
- Requirements: AUTH-004, LED-001, IMP-004, OPS-001.
- Files: commit/chunk service, job/invalidation records, action/route, integration tests.
- Deliver: server revalidation; explicit confirmation; batch/chunk idempotency; D1 atomic batches; durable high-water mark; projection rebuild request; audit.
- Acceptance: repeated request/file creates no duplicate effect; injected failure at any chunk resumes from the committed high-water mark; batch becomes committed only after every intended row and rebuild job are durable.
- Tests: retry at each chunk boundary, duplicate rows/files, free-plan 50-query/100-parameter chunk bounds, partial failure/resume, cross-user, CSRF/idempotency denial, atomic rollback.
- Risks: D1 limits or exposing partially committed rows before final status.
- Parallel safe: no; integrates ledger/import/audit.

### IMP-003B — Import reversal and corrected re-import

Status: PENDING.

- Objective: reverse a committed batch and stage a corrected successor without deleting provenance.
- Dependencies: IMP-003A.
- Requirements: IMP-005, OPS-001.
- Files: reversal/supersession services, action/route, integration tests.
- Deliver: dependency impact check; idempotent reversal; compensating ledger/cash effects; corrected `supersedes_batch_id`; rebuild/audit.
- Acceptance: reversal restores ledger-derived cash/lots/holdings for an isolated batch; later dependent facts are blocked with exact impact; rows/mappings/audit remain readable to the owner.
- Tests: clean reversal, repeated reversal, dependent later sale, corrected re-import, partial-failure resume, cross-user denial.
- Risks: later-lot dependencies and irreversible operator misunderstanding.
- Parallel safe: no.

### LED-002A — Pure FIFO allocation engine

Status: DONE on 2026-07-30.

- Objective: freeze deterministic exact-decimal FIFO behavior independently of D1 and UI.
- Dependencies: LED-001A.
- Requirements: LED-003, LED-004, CALC-003, CALC-004.
- Files: pure FIFO module, independent fixtures/tests.
- Deliver: ordered lots, partial/multi-lot matching, acquisition/sale fee allocation, incomplete-FX/basis states, oversell result, exact residual rule.
- Acceptance: supplied and synthetic fixtures yield inspectable allocations; equal-time ordering is stable; no database/network dependency.
- Tests: partial/multi-lot sales, fees, FX, equal timestamps, split, reversal, residual rounding, incomplete basis.
- Risks: mutation ordering, split semantics, and rounding residuals.
- Parallel safe: yes with owned service work after event types freeze.
- Completion note: Added a pure exact-decimal FIFO engine with stable acquisition ordering, acquisition-cost/fee/tax basis construction, partial and multi-lot allocations, sale proceeds/fee/tax residual reconciliation, explicit incomplete-basis/FX states, oversell results, split quantity updates, and reversal-aware deterministic rebuilds. Added independent fixtures with no database, Worker, or network dependency.

### LED-002B — Owned lot and holding projection rebuild

Status: DONE on 2026-08-03.

- Objective: persist and deterministically rebuild owner-scoped lots, allocations, and current holding projections.
- Dependencies: LED-002A, LED-001B.
- Requirements: LED-004, CALC-003, CALC-004.
- Files: lot/projection schema migration, repositories, rebuild/invalidation service, integration tests.
- Deliver: composite owner/portfolio/membership constraints; rebuild from ledger high-water mark; disposable lots/allocations/holdings; reconciliation status.
- Acceptance: holding quantity equals open lots; allocations equal sell quantity; stale runs cannot publish over newer ledger facts; reversal/rebuild is identical.
- Tests: cross-portfolio link rejection, rebuild/idempotency, concurrent invalidation, supplied FIFO results, incomplete basis.
- Risks: publishing projections from stale ledger state.
- Parallel safe: no; central projection path.
- Completion note: Added owner-scoped tax-lot, allocation, and holding-projection schema with composite membership constraints; exact-decimal, security-grouped FIFO projection assembly; and a lease/high-water-guarded atomic rebuild repository. Added integration coverage for FIFO reconciliation, idempotency, stale publication rejection, incomplete basis, reversal replay, and cross-portfolio links. Updated the generated migrations and schema contract checks.
- Review finding: The rebuild currently loads the entire owner ledger into memory and emits one unbounded D1 batch containing every delete and projection insert. This conflicts with the architecture’s bounded-chunk, D1-parameter, and Worker-memory limits and cannot resume from a committed projection high-water mark after a partial failure. Add bounded/resumable rebuild chunks, enforce the batch/query limits, and add high-volume and injected-failure resume tests before marking this task DONE.
- Review resolution: Replaced whole-ledger replacement with run-versioned projection rows, bounded per-security ledger reads, bounded output batches, and an atomic security/output checkpoint. A completed run becomes current only through the owner-scoped publication pointer, so partial and stale runs remain invisible. Added a 150-security volume test that instruments row, statement, and parameter bounds plus an injected-failure test proving the failed chunk leaves no rows/checkpoint advance and resumes to identical output.

## Market data and calculations

### DB-002 — Security master and provider mapping schema

Status: DONE on 2026-07-29.

- Objective: represent durable securities and validity-dated exchange/provider identifiers without treating ticker as identity.
- Dependencies: DB-001A.
- Requirements: MKT-001.
- Files: `db/schema.ts`, migrations, repositories/tests.
- Deliver: exchanges, verified shared securities, validity-dated identifiers, provider registry/mappings, and owner-scoped portfolio-security links that can remain privately unresolved.
- Acceptance: canonical identity is independent of ticker/provider; an unresolved import never creates or mutates shared master data; provider configuration contains no provider-use grant model; mapping validity/provenance and ownership constraints hold.
- Tests: migration/foreign keys, private unresolved candidate, mapping overlap/conflict service rules, ticker change/delisting, provider configuration, owned portfolio-security access.
- Risks: schema too provider-shaped or global master data being mutated by one user.
- Parallel safe: yes with LED-001A after schema coordination.
- Completion note: Added the shared exchange/security/provider schema, validity-dated identifier and provider mappings, and owner-constrained portfolio-security candidates. Unresolved imports remain private with no shared-master write path; generated migration and deterministic mapping-conflict tests cover ownership, ticker history, delisting, and ordinary provider configuration.

### DB-003 — Price, FX, and override schema

Status: DONE on 2026-07-30.

- Objective: persist normalized price/FX observations and auditable user corrections with unambiguous provenance.
- Dependencies: DB-002.
- Requirements: MKT-003, MKT-004, MKT-006, MKT-008.
- Files: `db/schema.ts`, migrations, repositories/tests.
- Deliver: normalized price/FX observations with optional user scope for genuinely user-entitled sources, owner-scoped manual overrides, provenance/revision/quality fields, and selection indexes. Provider corporate-action tables remain deferred to DB-005.
- Acceptance: the Yahoo-compatible source may use deployment-scoped normalized observations; an explicitly user-entitled future source remains user-scoped; provider interval and manual override models do not overlap; duplicate observations are idempotent; override intervals are constrained.
- Tests: migrations/foreign keys, deployment/user observation scope, duplicate/corrected observation, adjustment state, rate direction, override conflict/ownership.
- Risks: ambiguous revision/upsert semantics or an index that cannot serve latest-by-date selection.
- Parallel safe: yes with pure calculation fixtures after normalized types freeze.
- Completion note: Added normalized price and directional FX observation tables with deployment/user scope checks, provider mapping provenance, revision/quality fields, idempotency and latest-selection indexes. Added owner-scoped versioned manual overrides with effective-interval and supersession constraints, generated migrations, and deterministic foreign-key/scope/duplicate/conflict tests.

### DB-004 — Snapshot and calculation-run schema

Status: DONE on 2026-07-30.

- Objective: persist versioned disposable historical projections without mixing calculation versions.
- Dependencies: DB-001A, DB-003.
- Requirements: CALC-006.
- Files: `db/schema.ts`, migrations, repositories/tests.
- Deliver: portfolio/holding daily snapshots, calculation runs, completeness/high-water/version fields.
- Acceptance: snapshot calculation versions do not mix; all rows are owner/portfolio-scoped; a stale run cannot claim a newer ledger high-water mark.
- Tests: migration/foreign keys, snapshot uniqueness/version, run lease/idempotency, cross-portfolio link rejection.
- Risks: schema coupling projections to one calculation version or over-retaining per-holding history.
- Parallel safe: yes with MKT-001.
- Completion note: Added owner-scoped portfolio and holding daily snapshots tied to an exact calculation version, completeness and ledger high-water metadata, generated migration constraints/indexes, and an idempotent leased calculation-run repository that rejects stale ledger completion. Added migration, version-isolation, ownership, lease, and stale-run fixtures.

### DB-005 — Corporate-action event and dividend-receipt schema

Status: DEFERRED; not required by the core ledger/valuation release.

- Objective: add dividend facts only when the actual-receipt workflow and provider capability are scheduled.
- Dependencies: LED-001A, DB-002, DB-003.
- Requirements: DIV-001, DIV-002.
- Files: schema/migration/repositories/tests.
- Deliver: corrected/superseded split/dividend events, owner-scoped actual receipts/cash links, and separate estimate inputs; no estimated receipt row.
- Acceptance: an event cannot masquerade as an actual receipt; receipt transaction/membership/cash links are owner/portfolio constrained.
- Tests: event revisions, receipt ownership/cash linkage, estimated-vs-actual constraints.
- Risks: premature schema for provider data the release cannot reliably source.
- Parallel safe: only after the feature is promoted into release scope.

### MKT-001 — Best-effort provider-neutral contracts and configuration

Status: DONE on 2026-07-30.

- Objective: freeze provider-independent capabilities, normalized types, errors, fixtures, and ordinary server-side activation rules.
- Dependencies: DB-002; production activation additionally depends on SPK-002.
- Requirements: MKT-001, MKT-002, MKT-007.
- Files: `domain/market-data/**`, provider fixtures, config gate/tests.
- Deliver: capability interfaces that distinguish known-delay/EOD/best-effort provider observations from owner-scoped manual overrides; normalized types/errors; deployment/user observation scope; server-only enabled/disabled configuration; deterministic fixtures.
- Acceptance: UI/domain code has no Yahoo-specific types; unavailable capability is typed; disabled or malformed provider configuration fails closed; no source-specific user-count, owner-binding, deployment-mode, monetization, redistribution, or external-use authorization gate exists.
- Tests: adapter contract suite, enabled/disabled configuration, deployment/user observation scope, malformed/outlier normalization.
- Risks: leaky provider symbol/payload assumptions.
- Parallel safe: yes with CALC-001A fixture design.
- Completion note: Added provider-neutral market-data contracts, typed errors/results, explicit deployment/user observation scope, owner-scoped manual override types, and unknown-input normalizers for price and FX observations. Wired runtime provider configuration through the fail-closed ordinary `disabled`/`yahoo-best-effort` parser and added deterministic malformed, outlier, scope, direction, and unavailable-capability fixtures without adding a network adapter.

### MKT-002 — Yahoo-compatible quote and daily-price adapter

Status: DONE on 2026-07-30.

- Objective: connect only latest/previous-close and daily price capabilities without leaking Yahoo response assumptions.
- Dependencies: MKT-001, DB-003, SPK-002.
- Requirements: MKT-002, MKT-003, MKT-008.
- Files: server-only adapter, HTTP client, provider fixtures/contracts, tests.
- Deliver: latest/previous-close quote, symbol lookup, and daily raw price history; strict runtime response validation; bounded retry/circuit break; provenance; no second-provider hooks.
- Acceptance: representative Australian, US, and European-or-UK fixtures normalize safely; every value has observation scope, mapping, currency, observation/ingestion/source, delay-known-or-unknown, and quality; raw payloads never reach client/logs; normal authenticated application access applies without a source-specific user gate.
- Tests: sanitized fixtures, rate/throttle response, timeout, malformed decimal/date, missing symbol, schema change, stale fallback, Australian/US/European-or-UK examples.
- Risks: endpoint changes, throttling, unknown delay, and incomplete coverage.
- Parallel safe: yes with CALC-001A after normalized contract freezes.
- Completion note: Added a server-only Yahoo-compatible adapter for symbol search, latest/previous-close observations, and raw daily history with strict response/date/decimal validation, normalized provenance and deployment/user scope, bounded retry/timeout/circuit behavior, stale latest fallback, and typed unsupported capabilities. Sanitized Australian, US, and UK fixtures prove provider payloads do not escape the adapter.

### MKT-003A — Observation selection, coverage, and manual overrides

Status: DONE (2026-08-03).

- Objective: select fixture/provider observations deterministically and compose reversible owner overrides without network/job concerns.
- Dependencies: MKT-001, DB-003, OPS-001.
- Requirements: MKT-005, MKT-006, MKT-008, OPS-001, OPS-002.
- Files: observation selector, coverage result, override service/actions, tests.
- Deliver: deterministic manual override → validated best-effort/delayed → EOD → bounded prior-session → unavailable selection; aligned covered-basis totals; versioned override/invalidation.
- Acceptance: gaps never become zero; incomplete totals are typed/labelled as partial; timestamps are generally suppressed in compact response fields but retained in explanation data; override removal restores the provider result.
- Tests: date/session fallback, staleness, partial totals, override intervals/supersession/removal, deployment/user observation scope.
- Risks: silently presenting stale/partial values as current/complete.
- Parallel safe: yes with adapter work.
- Completion note: Added deterministic price/FX selection with manual, delayed/best-effort, EOD, bounded prior-session, stale, and unavailable states; decimal-only aligned coverage totals; owner-scoped versioned override supersession/removal with audit and calculation invalidation; and deployment/user scope, fallback, conflict, ownership, and rollback tests.
- Review completion: User-owned manual overrides are now ignored unless the authenticated user scope is explicitly supplied; regression coverage confirms an owner cannot receive another user’s override or an unscoped override.

### MKT-003B — Bounded ingestion and refresh jobs

Status: DONE on 2026-08-03.

- Objective: ingest current/daily price and FX observations reliably within Cloudflare/D1 limits.
- Dependencies: MKT-003A, MKT-002, MKT-004, OPS-001.
- Requirements: MKT-003, MKT-005, MKT-008, OPS-002.
- Files: ingestion/job services, Worker scheduled handler/config, tests.
- Deliver: idempotent upsert; coalesced refresh/backfill; rate budget; durable job/lease/high-water; bounded Cron chunks; circuit breaker.
- Acceptance: duplicate/corrected data behaves predictably; job resumes safely; free-plan 50-D1-query, 100-bound-parameter, Worker memory/subrequest bounds are respected by configured chunks; `waitUntil` is not the durability mechanism.
- Tests: concurrent refresh, retry/lease/reclaim, 429/timeout, correction, chunk boundary, scheduled-handler smoke.
- Risks: Worker subrequest/execution limits; add Queue only after measurement.
- Parallel safe: no; shared ingestion path.
- Completion note: Added the durable D1 refresh-job schema/migration, idempotent price/FX upserts, overlap coalescing, lease claim/reclaim, bounded high-water chunk processing, typed retry/failure handling, and a Cron scheduled handler configured for five jobs/provider requests per invocation without `waitUntil` durability.
- Review finding: Chunk observation writes and the high-water checkpoint are separate D1 operations, leaving a failure window that can replay provider work and upserts before the checkpoint advances; the read-then-insert overlap check is also race-prone under concurrent refresh requests, and the declared D1/query and chunk budgets are not enforced when configuration changes. Finish with an atomic bounded chunk/checkpoint commit, race-safe overlap coalescing, explicit budget enforcement, and failure/concurrency regression tests before marking this task done.
- Review resolution: Observation upserts and the guarded lease/high-water/counter checkpoint now commit in one bounded D1 batch; an injected failure between observation statements and the checkpoint rolls the entire chunk back and resumes cleanly. A partial unique active-target index plus atomic insert/range extension removes the request race, including safe migration of legacy duplicate active rows. Service construction and repository commits fail closed above the configured job/query, provider-request, date, observation, statement, or parameter budgets. Added concurrent-request, atomic-failure/resume, migration, and invalid-configuration coverage. This scheduled backend task has no mobile surface.

### MKT-004 — Yahoo-compatible FX adapter

Status: DONE on 2026-08-03.

- Objective: add only the directional daily FX capability required by owned foreign-currency holdings.
- Dependencies: MKT-001, DB-003, MKT-002.
- Requirements: MKT-002, MKT-004.
- Files: FX adapter/normalizer and fixtures/tests.
- Deliver: required owned currency pairs only; explicit provider base/quote mapping; access scope; decimal inversion evidence; typed unavailable result.
- Acceptance: AUD/USD and USD/AUD fixture directions reconcile independently; zero/malformed/future observations reject; no broad FX universe backfill or second provider.
- Tests: direct/inverse/identity, weekend fallback inputs, malformed/zero, owner scope, throttle/schema change.
- Risks: reversed rate direction or inconsistent pair timestamps.
- Parallel safe: yes after shared HTTP client from MKT-002 stabilizes.
- Completion note: Added the scoped Yahoo `AUDUSD=X` daily adapter for AUD/USD and USD/AUD, with exact decimal inversion evidence, identity/no-network handling, typed unsupported-pair results, strict malformed/zero/future rejection, and direct/inverse/owner-scope/throttle/schema/weekend-fallback coverage.

### MKT-005 — Corporate-action and dividend provider capability

Status: DEFERRED; not required by the core ledger/valuation release.

- Objective: add adjusted history, splits, and dividend-event ingestion only after source coverage/semantics are independently validated.
- Dependencies: MKT-002, DB-005.
- Requirements: MKT-002, DIV-001, DIV-002.
- Files: capability-specific adapters/fixtures/tests.
- Deliver: adjustment definitions, split revisions, and dividend events as actually supported; no inferred actual receipts.
- Acceptance: raw/adjusted series cannot double-apply a split; missing/irregular dividend data yields unavailable, not an annualized guess.
- Tests: split correction, raw/adjusted continuity, missing/special/irregular dividend events, schema change.
- Risks: unreliable best-effort corporate-action semantics.
- Parallel safe: only after the feature is promoted into release scope.

### CALC-001A — Decimal primitives, basis, gain, and current value

Status: READY.

- Objective: implement the exact-decimal calculation foundation and single-date holding results.
- Dependencies: LED-002B, MKT-001 fixture contract.
- Requirements: LED-002, CALC-001, CALC-002, CALC-003, CALC-004, CALC-007.
- Files: `domain/calculations/**`, independent fixtures/tests.
- Deliver: reviewed decimal dependency; parse/round/allocation primitives; native market value; open basis; realised/unrealised gains; named unavailable results.
- Acceptance: formula fixtures match `CALCULATIONS.md`; every unavailable result has a stable reason; no financial path accepts/returns JS binary-float values.
- Tests: same-currency/FIFO fixture families, property/invariant tests, zero/missing denominators, allocation/display rounding.
- Risks: denominator semantics and rate inversion.
- Parallel safe: yes with market adapters using fixture contracts.

### CALC-001B — FX conversion, daily movement, and partial totals

Status: PENDING.

- Objective: add date-attributable home-currency presentation and coverage-aligned portfolio totals.
- Dependencies: CALC-001A, MKT-003A, MKT-004.
- Requirements: PRD-005, LED-002, CALC-002, CALC-005, MKT-004, MKT-005.
- Files: calculation modules/fixtures/tests.
- Deliver: transaction/valuation FX selection inputs; native/home display result; daily movement/decomposition; cash conversion; known/partial totals whose invested value and basis use the same covered set.
- Acceptance: toggle shares native facts; transaction explicit FX takes precedence; missing FX keeps native result; incomplete totals cannot serialize as complete; timestamp/source remain in explanation data and are generally suppressed in compact fields.
- Tests: foreign buy/sell/current FX, direct/inverse/identity, flat-price/FX movement, missing components, aligned coverage sets, rounding.
- Risks: rate inversion or subtracting uncovered basis from covered value.
- Parallel safe: yes after MKT-003A contract freezes.

### CALC-002 — Historical snapshots and rebuild

Status: PENDING.

- Objective: produce reproducible historical value series from dated ledger, price, FX, and cash facts.
- Dependencies: CALC-001B, MKT-003B, LED-002B, DB-004.
- Requirements: LED-005, MKT-005, CALC-005, CALC-006.
- Files: snapshot services/jobs/repositories, chart response contract, tests.
- Deliver: daily quantities/cash, price/FX join, coverage/completeness, versioned snapshot invalidation and bounded rebuild.
- Acceptance: no back-cast current quantity; unsupported ranges/gaps are marked without routinely printing observation timestamps; rebuild is deterministic and resumable.
- Tests: trades across boundaries, weekend/holiday, FX gaps, corrections/invalidation, calculation-version change, partial history.
- Risks: exchange/portfolio timezone cutoff; D1 growth.
- Parallel safe: no with snapshot UI contract; can precede UI.

### DIV-001 — Dividend events, receipts, and forecasts

Status: DEFERRED; actual income and forecasting do not block the core ledger/valuation release.

- Objective: keep provider events, actual cash receipts, and honest future-income estimates distinct and explainable.
- Dependencies: LED-001B, DB-005, MKT-005, CALC-001B.
- Requirements: DIV-001, DIV-002.
- Files: dividend domain/service/repositories, tests.
- Deliver: declared/paid/corrected event ingestion; actual receipts/cash; declared-then-TTM forecast; withholding assumption; gross/net/yield labels.
- Acceptance: estimates never post cash or enter actual returns; actual payment-date FX; irregular history does not over-annualize; provenance/method visible.
- Tests: declared vs paid, eligibility, special/irregular dividend, withholding, franking info, missing FX/history, corrections.
- Risks: eligibility/corporate-action completeness; tax implications—keep informational.
- Parallel safe: yes with CALC-002 after shared contracts.

## Product surfaces

### UI-PROT-001 — Static responsive product prototype

Status: DONE for owner review on 2026-07-29; production UI tasks remain unchanged.

- Objective: validate the reference information density, hierarchy, responsive rules, and principal navigation before production UI implementation begins.
- Dependencies: FND-001.
- Requirements: PRD-003, PRD-004, PRD-005, QUAL-001.
- Files: `app/**`, `tests/rendered-html.test.mjs`, `docs/UI_SPEC.md`, `docs/ui-captures/**`.
- Deliver: local-mock-only Overview, Holdings, Quotes, Details, and News prototype routes; portfolio/drawer/action/state menus; deterministic sorting; populated, empty, partial-price, and provider-error presentations; 320/390/430/desktop responsive behavior; principal 390 px captures.
- Acceptance: no authentication, D1, provider, import, or financial mutation implementation; Holdings preserves all four reference columns and three-line rows at 320 px without horizontal scrolling; every menu and state control is keyboard/touch operable; mobile omissions and exact typography/spacing rules are documented as review candidates.
- Tests: rendered-route smoke tests, keyboard/browser interaction checks, screenshots at 320/390/430/desktop widths, format, lint, production build.
- Risks: prototype mock values being mistaken for financial truth or provisional visual choices being treated as approved; label both explicitly and keep production UI tasks pending.
- Parallel safe: no; this intentionally revises the shared scaffold before production surface work.
- Evidence: `docs/UI_SPEC.md`; 390 px Overview/Holdings/Quotes/Details captures plus 320/430/desktop Holdings captures in `docs/ui-captures/`; exact-width browser checks showed no document overflow; sort, menus, holding drill-down, populated/empty/partial/provider-error states exercised; owner revision 1 reduced the sort strip and summary by approximately 13–14%, applied positive/negative colours to both gain lines, introduced the fixed four-line whole-dollar summary, then restored Overview as the first tab and enlarged the first-line summary figures; format check, lint, task-scoped strict TypeScript, production build, and four rendered smoke tests passed.
- Foundation note: repository-wide `tsc --noEmit` still awaits the Cloudflare-generated types owned by ready task `FND-002A` (`cloudflare:workers`, `Fetcher`, and `D1Database`). This prototype did not bypass or implement that production foundation task.

### UI-001 — Authenticated shell, portfolio selection, and routes

Status: DONE on 2026-07-30.

- Objective: replace the visual-only scaffold with the verified private session shell and real owned portfolio navigation.
- Dependencies: AUTH-002, FND-001.
- Requirements: PRD-002, PRD-003, PRD-004, PRD-005, QUAL-001.
- Files: protected layouts/components/routes, portfolio actions, tests.
- Deliver: brand shell; home-currency setting; portfolio selector/create/archive; Overview/Holdings/Quotes/Details/News routes; session menu; mobile tab behavior.
- Acceptance: active state/URLs/empty/error states; News honest placeholder; 44 px targets/safe areas/keyboard focus.
- Tests: route render/action ownership, semantic/keyboard checks, 320 px and desktop visual QA.
- Risks: selector leaking portfolio names in cached HTML; use no-store.
- Parallel safe: base shell first, then downstream screens can parallelize.
- Completion: Added Worker-verified principal transport, D1-backed owned workspace loading, no-store authenticated shell routes, portfolio-safe navigation, session menu, home-currency display, honest empty/unavailable/news states, and route/projection regression coverage. Preview fixture routes remain isolated under `/portfolio/preview/*`.
- Review finding: the declared PRD-002 scope is not complete. Implement the authenticated create, rename, archive, and restore portfolio actions plus the home-currency setting/display toggle, with owner-scoped route/action tests and the required 320 px/desktop semantic and keyboard coverage. Keep mutation workflows server-authoritative and separate from downstream financial-entry tasks.
- Review completion: Added server-authoritative, owner/version-scoped create, rename, archive, restore, home-currency, and native/home display-view actions; archived portfolio restore controls; accessible form/menu controls; and semantic responsive regression coverage. Financial-entry mutations remain deferred to downstream tasks.
- Review completion: Corrected the authenticated mobile drawer to use the owner-scoped portfolio selector, preventing prototype portfolio names and IDs from appearing in private navigation. Added a regression assertion for this isolation boundary.

### UI-002 — Overview and historical value

Status: PENDING.

- Objective: present the portfolio’s known value, movement, history, and data coverage without overstating completeness.
- Dependencies: UI-001, CALC-002.
- Requirements: CALC-002, CALC-006, CALC-007, MKT-005, PRD-004, QUAL-001.
- Files: Overview route/components/contracts/tests.
- Deliver: value/cash/cost/gain/daily summaries; history chart/ranges; allocation summary; coverage/formula drill-down; income remains absent/unavailable until DIV-001.
- Acceptance: partial/missing states are unambiguous; routine observation timestamps are suppressed; chart has a text alternative; mobile hierarchy works.
- Tests: complete/partial/empty/stale histories, coverage, accessibility, responsive snapshots.
- Risks: calling partial totals full totals or forecast actual.
- Parallel safe: yes with UI-003/004/005 after shell/contracts.

### UI-003 — Holdings table and mobile cards

Status: PENDING.

- Objective: reproduce the reference’s dense holdings utility with a distinct, usable mobile hierarchy.
- Dependencies: UI-001, CALC-001B.
- Requirements: CALC-002, MKT-005, PRD-004, PRD-005, QUAL-001.
- Files: Holdings route/components/tests.
- Deliver: dense sortable desktop table; mobile cards; native/home price-value menu for foreign holdings; quantity/basis/price/value/daily/gain columns; cash separation; row/FX explanation.
- Acceptance: sort missing values predictably; no horizontal dependency on mobile; compact views show `Price unavailable` when needed and generally suppress timestamps/source/fallback labels.
- Tests: mixed currencies, long names, missing data, zero quantity, keyboard sorting, responsive QA.
- Risks: too many mobile facts; prioritize market value and gain.
- Parallel safe: yes.

### UI-004 — Compact quotes, refresh, and overrides

Status: IN PROGRESS (review 2026-08-03).

- Objective: expose compact quote views and controlled refresh/correction workflows without calling EOD data live.
- Dependencies: UI-001, MKT-003B.
- Requirements: MKT-003, MKT-005, MKT-006, MKT-008, QUAL-001.
- Files: Quotes route/components/actions/tests.
- Deliver: preferred observation, EOD/manual fallback, previous close/change, refresh state, manual price/FX override with reason/history; `Price unavailable` only when no usable price exists.
- Acceptance: active quotes prefer the approved source; compact quote/holding views generally suppress timestamps, source, delay, and fallback labels; state remains accessible in an explanation and inline status is reserved for action-required conditions; refresh is coalesced/rate-limited; overrides are reversible.
- Tests: fresh/stale/missing/partial, override ownership/validation, refresh retries, accessibility.
- Risks: refresh abuse/provider cost; optimistic UI lying about data time.
- Parallel safe: yes.
- Completion: Added compact quote state explanations, honest missing/stale/partial handling, owner-scoped no-store refresh and correction endpoints, durable coalesced refresh requests, reversible price/FX correction UI, and accessibility/regression coverage.
- Review findings: The authenticated portfolio route always renders Quotes with a null portfolio and `empty` state, so owner quote data never appears. The compact explanation only contains a generic business date and does not expose the selected source, timestamp, delay, scope, quality, or fallback reason; partial pricing is inferred from the last rendered row and changes when sorting. Refresh requests default idempotency to a per-request ID, accept arbitrarily large historical ranges, and have no post-completion rate limit, so repeated/concurrent requests can recreate provider work. The new mutation routes also do not enforce the documented Origin/Sec-Fetch same-origin checks. Add an owner-scoped quote read path, provenance-backed state, bounded/rate-limited refresh requests, mutation CSRF checks, and endpoint/concurrency/responsive regression coverage before marking this task done.

### UI-005A — Portfolio settings and ledger inspection

Status: READY.

- Objective: expose owned portfolio settings and read-only ledger/lot/cash provenance without combining them with financial write workflows.
- Dependencies: UI-001, LED-002B.
- Requirements: PRD-002, LED-001, LED-004, LED-005, QUAL-001.
- Files: Details/settings/ledger routes/components/actions/tests.
- Deliver: settings; transaction/lot/cash lists and explanations; links to the separate manual-entry/correction workflow.
- Acceptance: owner-scoped direct routes; exact decimals are formatted only at the edge; lists show useful business dates but generally suppress exact timestamps, which remain in detail/audit explanations; no mutable share/cost field bypasses ledger facts.
- Tests: empty/populated/incomplete states, cross-user routes/actions, keyboard/mobile.
- Risks: turning projections into editable truth or exposing an unscoped direct detail route.
- Parallel safe: yes with import UI after shared shell.

### UI-005B — Import upload, mapping, and preview

Status: DONE (2026-08-02).

- Objective: make the complete non-mutating import review workflow operable before exposing a financial commit action.
- Dependencies: UI-001, IMP-002B.
- Requirements: IMP-002, IMP-003, QUAL-001.
- Files: import routes/components/actions/tests.
- Deliver: upload/parse status; row/field issues; portfolio/security/FX mapping; duplicate/oversell/completeness preview; ready/not-ready result.
- Acceptance: this UI has no commit side effect; issue controls are labelled; the displayed preview is the server-issued version that a later commit must reference.
- Tests: supplied-file workflow through ready preview, mapping conflicts, stale preview, cross-user, keyboard/mobile, error recovery.
- Risks: a large issue table on mobile or UI preview diverging from server contract.
- Parallel safe: yes after shared actions/contracts.
- Completion note: Added the authenticated upload/parse, mapping, reconciliation, and ready/not-ready preview workflow with no commit action; mapping writes enforce the server-issued preview version and all responses are private/no-store.
- Review completion: Added private no-store coverage for the authenticated `/import` document and a structured unavailable response for mapping-save failures; all automated checks pass.

### UI-005C — Import commit, progress, and history

Status: PENDING.

- Objective: expose explicit, idempotent commit over an immutable reviewed preview and make its outcome inspectable.
- Dependencies: UI-005B, IMP-003A.
- Requirements: IMP-002, IMP-004, QUAL-001.
- Files: import commit/progress/history routes/components/actions/tests.
- Deliver: exact preview-version confirmation; commit action; resumable progress; original outcome on retry; batch/row/mapping history.
- Acceptance: a changed or stale preview cannot commit; repeated submission returns the original batch outcome; partial work is shown as resumable, never complete; history generally suppresses exact timestamps while retaining them in batch detail/audit evidence; no other owner’s batch is readable.
- Tests: supplied-file commit, stale preview, double submit, resume after bounded chunk failure, cross-user, keyboard/mobile.
- Risks: optimistic UI claiming completion before the durable commit marker.
- Parallel safe: no; this is a financial mutation workflow.

### UI-005D — Import reversal and corrected successor

Status: PENDING.

- Objective: make committed batch provenance and safe correction/reversal understandable.
- Dependencies: UI-005C, IMP-003B.
- Requirements: IMP-005, QUAL-001.
- Files: import history/detail/reversal routes/components/actions/tests.
- Deliver: batch/row/mapping history; exact impact confirmation; dependency-blocked state; reversal progress; corrected successor link.
- Acceptance: reversal cannot target another owner or hide dependent-fact conflicts; source evidence remains visible after reversal.
- Tests: clean/dependency-blocked/repeated reversal, corrected successor, cross-user, keyboard/mobile.
- Risks: destructive action ambiguity.
- Parallel safe: no; correction UI follows stable service behavior.

### UI-005E — Manual ledger entry and correction

Status: PENDING.

- Objective: expose the core manual trade/cash/split write path without mixing it into import or read-only projection screens.
- Dependencies: UI-005A, LED-001B, LED-002B.
- Requirements: LED-001, LED-002, LED-003, LED-005, QUAL-001.
- Files: manual transaction/reversal routes, components, actions, and tests.
- Deliver: labelled forms for buy, sell, cash deposit/withdrawal, fee/tax, and explicit split; immutable submit result; impact preview; reversal/superseding replacement; missing-FX state. Transfers and dividends remain unavailable.
- Acceptance: every action uses the authenticated portfolio context and a server-issued idempotency key; exact decimals are revalidated server-side; split ratio is positive; business dates remain visible while exact timestamps are generally confined to detail/audit evidence; a correction never updates the original fact; unsupported transfer/dividend types reject.
- Tests: each supported type, invalid decimal/ratio/date, missing FX, double submit, reversal/replacement, oversell, cross-user and cross-portfolio denial, keyboard/mobile.
- Risks: a convenient form bypassing the single ledger service or implying incomplete FX is zero.
- Parallel safe: no; financial mutation UI follows the stable ledger service.

### PWA-001 — Offline-safe shell and connectivity states

Status: DONE on 2026-08-02.

- Objective: make installation and offline failure graceful without persisting private financial responses on the device.
- Dependencies: FND-001, UI-001.
- Requirements: PLAT-002.
- Files: manifest, icon assets, service worker/registration, offline page, cache/header tests.
- Deliver: versioned public allowlist, navigation offline fallback, connectivity UI, disabled mutations, update lifecycle, 180/192/512 raster install icons.
- Acceptance: Cache Storage contains no protected HTML/API/import/portfolio data; offline reload explains limits; SVG-only scaffold metadata is replaced by validated standalone/iPhone assets.
- Tests: cache allow/deny list, offline navigation, service-worker update, Safari/iPhone physical-device UAT.
- Risks: cached private response or stale worker; fail safe to network/offline page.
- Parallel safe: yes after shell asset paths settle.
- Completion note: Added a versioned public-only service-worker allowlist with network-first offline navigation fallback, update activation, connectivity status, offline-disabled mutations, standalone 180/192/512 raster install assets, and manifest/header regression coverage. Physical Safari/iPhone UAT was user-confirmed on 2026-08-02 for Add to Home Screen, standalone launch, app name/icon, safe-area rendering, loaded-session offline state with disabled mutations, safe offline reload, reconnection, and service-worker update activation; exact device and iOS version were not recorded.
- Review finding: automated implementation and regression checks pass, but the required physical Safari/iPhone UAT has not been completed. Verify installation, offline reload fallback, update activation, safe-area rendering, and disabled mutations on a physical device before marking this task complete.
- Review resolution: user-confirmed physical Safari/iPhone UAT completed on 2026-08-02; the finding is closed with device and iOS version explicitly unspecified.

## Operations and release

### OPS-002 — Backup, export, migration, and restore drill

Status: DONE on 2026-08-03.

- Objective: prove that schema/data can be recovered beyond ordinary application rollback and within the stated RPO/RTO.
- Dependencies: DB-001A, DB-002, DB-003, DB-004, OPS-001.
- Requirements: OPS-003.
- Files: operator runbook, scoped scripts/workflow config, drill evidence.
- Deliver: Time Travel bookmark procedure; operator-run encrypted long-term D1 export outside the primary failure domain; migration checklist; restore verification; RPO/RTO record. Automation/R2/Workflows are not authorized by this task.
- Acceptance: non-production restore/drill verifies schema, ownership counts, representative data/calculations; secrets/exports access-controlled.
- Tests: scripted checksum/count verification and application smoke suite against restored DB.
- Risks: restore-in-place destructive operation; never drill against production.
- Parallel safe: yes late in Phase 3/4.
- Completion note: Added the operator-led backup/export/restore runbook and a read-only restore verifier that compares checked-in migrations, validates integrity and foreign keys, records redacted checksum/count/ownership evidence, and runs portfolio, transaction, snapshot, and calculation ownership smoke checks. Tests cover SQL-export restore, SQLite restore parity, tamper rejection, representative data, and payload-free evidence; no automated export destination or destructive production restore was added.
- Review finding: Implementation and local restore-parity tests pass, but no completed non-production D1 drill evidence or measured RPO/RTO/bookmark record is present. Run the documented encrypted export, isolated restore, and application smoke drill with least-privileged operator access; retain the access-controlled evidence and completed record before marking this task DONE.
- Review resolution: Completed an isolated Oceania D1 drill using synthetic owner-scoped portfolio, ledger, snapshot, calculation, and audit data. Pre/post Time Travel bookmarks, encrypted-export transfer hashes, access-controlled evidence, cleanup, and measured 1m59s RPO/5m35s RTO are recorded in `docs/OPS-002_DRILL_RECORD_2026-08-03.md`; all 26 tables, ownership counts, row hashes, schema, foreign keys, application smoke checks, build, and 116 tests passed. The drill also exposed D1 export row-ordering that breaks direct foreign-key import, so the runbook/verifier now generate a dependency-ordered data import after checked-in migrations, with regression coverage. The existing OAuth session had broader scopes than a dedicated D1 token, though only D1 operations and synthetic resources were used; use a dedicated scoped token for the next drill.

### OPS-003A — Offboarding and owned-data export

Status: PENDING.

- Objective: stop access immediately and produce a complete, owner-scoped export/deletion manifest without deleting data.
- Dependencies: AUTH-002, OPS-001, IMP-003B, MKT-003B, CALC-002.
- Requirements: AUTH-005, OPS-004.
- Files: lifecycle/export services, policy/runbook, UI/actions, integration tests.
- Deliver: disable/session revocation; immutable deletion request; owned ledger/import/market/projection export; exact row/object manifest and retention classifications.
- Acceptance: a disabled user cannot authenticate; export and manifest cover every owned table/access-scoped observation without including another user; no purge occurs in this task.
- Tests: disable/session, export completeness/counts, repeated request, cross-user exclusion, redaction.
- Risks: an incomplete manifest would make later deletion unverifiable.
- Parallel safe: no; it defines the purge input.

### OPS-003B — Retention and verified deletion

Status: PENDING.

- Objective: apply approved retention rules and execute an idempotent, auditable purge from the exact OPS-003A manifest.
- Dependencies: OPS-003A, OPS-002.
- Requirements: OPS-004.
- Files: purge jobs/services, policy/runbook, confirmation UI/actions, integration tests.
- Deliver: cooling-off/confirmation; deletion-pending state; bounded purge in foreign-key order; user-scoped market-data purge; permitted audit tombstone; completion proof.
- Acceptance: every manifest target is gone, retained audit data matches the documented minimum, a repeated or resumed purge is safe, restore policy is explicit, and other owners are byte-for-byte unaffected in fixtures.
- Tests: target resolution, partial-failure resume, FK order, provider purge, repeat, cross-user preservation, restore-policy interaction.
- Risks: irreversible deletion; require exact target resolution and recoverability disclosure.
- Parallel safe: no; destructive cross-domain path.

### QA-001A — Security and tenant-isolation hardening

Status: PENDING.

- Objective: systematically attempt tenant escape, authentication bypass, unsafe mutation, and private-cache leakage before release.
- Dependencies: AUTH-002, UI-001, UI-002, UI-003, UI-004, UI-005A, UI-005B, UI-005C, UI-005D, UI-005E, PWA-001.
- Requirements: PRD-001, AUTH-003, AUTH-004.
- Files: security test suites, threat review, remediation files.
- Deliver: route/repository cross-tenant matrix; Access-token failure matrix; CSRF/header/CSP review; dependency audit; private-cache and redacted-error audit.
- Acceptance: no high-severity open finding; every owned read/write and destructive action has a denial test; no protected response enters Cache Storage.
- Tests: automated security/isolation suite plus focused manual threat checklist.
- Risks: an endpoint or background path omitted from the ownership matrix.
- Parallel safe: review can start per completed slice; final gate is serial.

### QA-001B — Accessibility and responsive hardening

Status: PENDING.

- Objective: verify the completed core flows at keyboard, screen-reader, reduced-motion, high-zoom, iPhone, and narrow desktop boundaries.
- Dependencies: UI-001, UI-002, UI-003, UI-004, UI-005A, UI-005B, UI-005C, UI-005D, UI-005E, PWA-001.
- Requirements: PRD-004, QUAL-001.
- Files: accessibility/responsive test suites, audit checklist, remediation files.
- Deliver: semantic/name/role/state audit; focus order and visible focus; chart/table alternatives; contrast/reduced-motion; 320 px/iPhone layout audit.
- Acceptance: automated scans have no serious/critical issue; every core flow completes keyboard-only; documented VoiceOver checks and 200% zoom/narrow-width checks pass.
- Tests: automated accessibility checks plus named manual assistive-tech/device cases.
- Risks: false confidence from automated scans; manual evidence is required.
- Parallel safe: review can start per completed surface; final gate is serial.

### QA-002 — Preview UAT and release readiness

Status: PENDING.

- Objective: provide evidence that the complete preview release meets product, security, data, device, and operational gates.
- Dependencies: UI-002, UI-003, UI-004, UI-005D, UI-005E, PWA-001, OPS-002, OPS-003B, QA-001A, QA-001B.
- Requirements: OPS-002, OPS-003, QUAL-002.
- Files: release checklist/evidence, fixture expectations, runbooks; only fixes needed by evidence.
- Deliver: clean preview environment; Access invite/offboard test; supplied CSV end-to-end; calculation reconciliation; iPhone/desktop/PWA tests; backup/deletion drill evidence; go/no-go record.
- Acceptance: every non-deferred task required by those dependencies is DONE; all product success measures and phase gates pass; owner/source scope is active; no critical/high issue; known limitations are documented.
- Tests: full lint/build/unit/integration/render/E2E suite plus manual UAT.
- Risks: production data or credentials entering preview; maintain strict environment separation.
- Parallel safe: test workstreams may run concurrently; go/no-go decision is serial.
