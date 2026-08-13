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

Status: DONE (2026-08-12); promoted from DEFERRED by owner instruction 2026-08-12.

- Objective: validate the documented broker/OAuth adapter boundary before any broker-specific dependency or credential storage is introduced.
- Dependencies: AUTH-002, LED-001B, MKT-001.
- Requirements: BRK-001.
- Files: architecture decision, broker adapter contracts/fixtures, data-model extension, security threat model, future task split.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `BRK-001 — Broker adapter compatibility`
- `docs/CONSOLIDATED_PRODUCT_SPEC.md` — `Future broker synchronization` workflow
- `docs/ARCHITECTURE.md` — `Future broker synchronization boundary`
- `docs/DATA_MODEL.md` — `Future broker-sync extension`
- `docs/IMPLEMENTATION_PLAN.md` — `Deferred backlog triggers` (broker synchronization promotion gate)

**Likely code:**

- `domain/market-data/contracts.ts`
- `domain/ledger/event-validation.ts`
- `domain/imports/reconciliation.ts`
- `db/schema.ts`
- No broker-specific module exists yet; choose its location only after this deferred task is promoted and its provider/security scope is approved.

**Verification:**

- Extend the existing provider, ledger, import-reconciliation, identity, and schema suites rather than creating a parallel financial path: `tests/mkt-001.test.ts`, `tests/led-001b.test.ts`, `tests/imp-002b.test.ts`, `tests/auth-002.test.ts`, and `tests/db-schema.test.ts`.
- Run task-scoped broker contract fixtures for cursor replay, corrections, ownership denial, and token redaction; run `npm run typecheck` and `npm run build` if Worker/runtime contracts or configuration are touched.

- Deliver: choose an initial broker candidate/use case; define connection/account/transaction/position/cash/quote capabilities, encrypted token lifecycle, cursor/idempotency, portfolio mapping, reconciliation, correction, and disconnection behavior.
- Acceptance: a sanitized fixture demonstrates repeat sync without duplicate ledger effects; positions only reconcile; optional quotes use the market-data abstraction and user entitlement; no broker password/screen scraping.
- Tests: adapter contract, repeated cursor page, corrected/deleted broker record, cross-user account mapping denial, token redaction/revocation, reconciliation drift.
- Risks: broker APIs/entitlements vary; OAuth token storage, rate limits, incomplete histories, and broker corrections require provider-specific validation.
- Parallel safe: future planning can run independently after its dependency contracts stabilize; implementation must not overlap ledger/auth schema changes.
- Completion note (2026-08-12): delivered a pure `domain/broker-sync/` contract (`contracts.ts`, `reconciliation-plan.ts`, `redaction.ts`, `fixtures.ts` — fixtures deliberately excluded from the barrel export) with `tests/spk-003.test.ts` (26 cases: adapter shape; cursor-replay idempotency order-independent of persisted-row order; numeric `external_version` ordering as the sole staging determinant — corrected records plan reversal-and-replace, stale re-served pages plan `skip_stale_version`, with a mutation-verified pin test for numeric-vs-lexicographic comparison ("9" vs "10" both directions); deletion semantics per the stated persistence invariant (`reverse_only` leaves no active mapping row) — unseen deletions plan `skip_deleted_unseen`, all-reversed history plans `skip_reversed_history` so a re-served pre-deletion page can never resurrect a cancelled trade; cross-user record/mapping denial; token-payload redaction plus connection-revocation denial (`connection_not_active`); position-drift reconciliation via `parseDecimal`/`compareDecimal` with explicit `unresolved_security` and never-throwing `unparseable_quantity` entry statuses). No dependency, network call, credential store, schema migration, or runtime import of `domain/broker-sync` was added. Broker candidate is an explicit assumption (AU CHESS-sponsored OAuth-capable archetype; no routed evidence names a real broker) — see `docs/ARCHITECTURE.md` §8.1. Data-model extension documented (not migrated) in `docs/DATA_MODEL.md` §8.1; 12-threat model in `docs/SPK-003_THREAT_MODEL.md`. Three review rounds: round 1 FAIL (6 blocking planner-semantics defects: unseen-deletion create, order-dependent replay duplication, no version monotonicity, string-equality quantity compare, silent unresolved-security skip, contradictory idempotency-key docs); round 2 FAIL (ghost resurrection from all-reversed history, crash on unparseable adapter-boundary quantity); round 3 all technical findings verified fixed by reviewer-rerun repros. `node --experimental-strip-types --test tests/spk-003.test.ts` 26 pass / 0 fail; `npm run check` exit 0 (337 pass, 10 env-gated skips). Reviewer follow-up recorded for BRK-005: harden the superseded-only-group asymmetry in `selectActiveMapping`'s create path when the real commit path lands. Implementation split below accepted as recorded (BRK-002 PENDING owner decision; BRK-003…BRK-007 BLOCKED per their stated dependencies).

### SPK-003 proposed split

The following follow-up tasks implement what the spike deliberately left
undone (see `docs/SPK-003_THREAT_MODEL.md` "Deferred to the implementation
split"). Orchestrator review 2026-08-12: accepted as recorded — IDs verified
collision-free, dependency order stands (BRK-002 owner decision first, then
BRK-003…BRK-007 per their stated dependencies). None become `READY` before
the BRK-002 decision; BRK-005 must also close the superseded-only-group
asymmetry noted in the SPK-003 completion note.

#### BRK-002 — Broker vendor and OAuth scope selection (decision)

Status: PENDING; blocked on an owner/product decision, not on other tasks.

- Objective: replace SPK-003's assumed AU CHESS-sponsored archetype with an actual approved broker/API, its OAuth scopes, rate limits, and redistribution terms for entitled quotes.
- Dependencies: SPK-003.
- Requirements: BRK-001.
- Deliver: a decision record naming the real broker/API, its documented OAuth flow, rate/entitlement limits, and any legal/ToS constraint on data retention or quote redistribution.
- Acceptance: the decision is evidence-based (vendor documentation cited), not another assumption; it either confirms or replaces the AU CHESS-sponsored archetype.
- Risks: vendor API stability, sandbox/test-account availability, cost.

#### BRK-003 — Broker connection/account schema and encrypted token storage

Status: BLOCKED on BRK-002.

- Objective: migrate `broker_connections`, `broker_accounts`, `broker_sync_runs`, and `external_record_mappings` (`docs/DATA_MODEL.md` §8) as reviewed Drizzle migrations, and implement the real encrypted-token-envelope storage `TokenEnvelopeRef` (`domain/broker-sync/contracts.ts`) only references.
- Dependencies: BRK-002, DB-001A.
- Requirements: BRK-001.
- Deliver: migrations; a Worker-secret/KMS-style encryption implementation for token envelopes; owner-scoped repository functions with cross-user denial tests.
- Acceptance: no plaintext credential ever reaches D1, logs, client bundles, or CSV exports; cross-user access to another owner's connection/account is denied and tested.
- Risks: key-rotation strategy, migration review overhead.

#### BRK-004 — OAuth authorize/refresh/revoke flow

Status: BLOCKED on BRK-002, BRK-003, AUTH-001.

- Objective: implement the real `authorize`/token-refresh/`revoke` lifecycle against the selected broker's OAuth flow, conforming to the `BrokerAdapter` contract in `domain/broker-sync/contracts.ts`.
- Dependencies: BRK-002, BRK-003.
- Requirements: BRK-001.
- Deliver: redirect/callback handling, token refresh scheduling, and a revoke path that stops sync and invalidates credentials without deleting committed ledger facts (per `docs/DATA_MODEL.md` §8).
- Acceptance: revocation is verified to actually invalidate provider-side access, not only local state; token material never appears in logs/errors (extend `tests/spk-003.test.ts` redaction coverage against the real adapter).
- Risks: provider-specific OAuth quirks, refresh-token rotation edge cases.

#### BRK-005 — Broker transaction/cash sync commit path

Status: BLOCKED on BRK-003, BRK-004, LED-001B.

- Objective: wire `planBrokerLedgerSync` (`domain/broker-sync/reconciliation-plan.ts`) into a real staging/commit path that posts `create`/`reverse_and_replace`/`reverse_only` effects through the existing ledger posting/reversal code (`domain/ledger/posting.ts`), matching the CSV import commit pattern rather than duplicating it.
- Dependencies: BRK-004.
- Requirements: BRK-001.
- Deliver: a bounded, resumable sync-run commit path with lease/attempt/status tracking (`broker_sync_runs`), reusing `domain/broker-sync/reconciliation-plan.ts` unmodified where possible.
- Acceptance: repeat sync of an already-committed cursor page produces zero duplicate ledger effects against the real D1 schema; corrected/deleted broker records produce a real reversal/supersession, not a rewrite.
- Risks: partial-page failure recovery, provider pagination/rate-limit behavior.

#### BRK-006 — Broker position reconciliation surfacing

Status: BLOCKED on BRK-005.

- Objective: surface `planPositionReconciliation` drift reports in the product UI/API as reconciliation evidence, never as a silent holdings overwrite.
- Dependencies: BRK-005.
- Requirements: BRK-001.
- Deliver: a route/view exposing per-security drift status (`match`/`drift`/`broker_only`/`ledger_only`) for a connected account's portfolio.
- Acceptance: no code path lets a broker position snapshot mutate `portfolio_securities` or ledger tables directly.
- Risks: UX for explaining drift without implying an automatic fix.

#### BRK-007 — Entitled broker quotes wiring

Status: BLOCKED on BRK-004, MKT-001.

- Objective: implement `BrokerAdapter.getEntitledQuotes` against the selected broker (if it offers quotes) and enforce connection-scoped entitlement at the route/repository layer through the existing `MarketDataProvider`/`ObservationScope` abstraction.
- Dependencies: BRK-004.
- Requirements: BRK-001.
- Deliver: entitlement-checked quote retrieval that reuses `PriceObservation` (`domain/market-data/contracts.ts`) with no parallel quote type.
- Acceptance: a quote never reaches a user/session outside its connection's entitlement scope; provenance (source, observation time, ingestion time) is recorded per `AGENTS.md`.
- Risks: redistribution restrictions in the selected broker's terms (see BRK-002).

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

Status: DONE (2026-08-03).

- Objective: turn an approved staged batch into bounded, resumable ledger effects with no duplicate visibility.
- Dependencies: LED-001B, LED-002B, IMP-002B, OPS-001.
- Requirements: AUTH-004, LED-001, IMP-004, OPS-001.
- Files: commit/chunk service, job/invalidation records, action/route, integration tests.
- Deliver: server revalidation; explicit confirmation; batch/chunk idempotency; D1 atomic batches; durable high-water mark; projection rebuild request; audit.
- Acceptance: repeated request/file creates no duplicate effect; injected failure at any chunk resumes from the committed high-water mark; batch becomes committed only after every intended row and rebuild job are durable.
- Tests: retry at each chunk boundary, duplicate rows/files, free-plan 50-query/100-parameter chunk bounds, partial failure/resume, cross-user, CSRF/idempotency denial, atomic rollback.
- Risks: D1 limits or exposing partially committed rows before final status.
- Parallel safe: no; integrates ledger/import/audit.
- Completion note: Added owner-scoped explicit commit with an exact server-revalidated preview digest, a guarded review-state freeze, validated row mapping consumption, one bounded D1 chunk per invocation, durable high-water/chunk markers, idempotent duplicate handling, atomic ledger effects, and per-portfolio rebuild finalization at real ledger high-water values.
- Review finding: Commit does not re-run the server-issued reconciliation or verify current blocking issues, parser/mapping state, and exact preview version before moving a batch to `committing`; it also never consumes portfolio/security mapping decisions from IMP-002B, so an approved mapped batch cannot reliably resolve its staged targets. Add an owner-scoped server revalidation step and persist/apply only its validated mapping result before commit.
- Review finding: Finalization creates a rebuild request with `ledger_high_water_start = import:<batch>:<row>` rather than the portfolio's actual ledger high-water identifier, and assumes one non-null batch portfolio. Derive durable rebuild requests from the affected owned portfolio(s) and their real committed ledger high-water values, with tests for per-row portfolio mappings and rebuild claim/completion.
- Review finding: Tests cover one injected failure boundary and a manually prepared staged fixture, but do not cover every chunk boundary, duplicate-file commit through the staging path, D1 query/parameter budgets, blocked issue-state commits, stale exact preview versions, mapping consumption, or rebuild high-water correctness.
- Review resolution: Commit now reconstructs the current owner-scoped reconciliation and requires its exact digest before a conditional transition that guards row, issue, and mapping versions. Mapping writes freeze at `committing`; each chunk persists only its validated durable targets with the ledger effects and advances one bounded unit per invocation. Finalization groups committed effects by affected owned portfolio and atomically queues each rebuild at the portfolio's actual latest ledger transaction. Integration tests cover every injected chunk boundary, concurrent/stale/blocked/parser states, row-scoped mapping consumption, duplicate rows and staging-path duplicate files, 50-query/50-statement/100-parameter budgets, atomic rollback, ownership/CSRF/idempotency denial, and rebuild claim/completion. No mobile surface applies to this backend commit job.

### IMP-003B — Import reversal and corrected re-import

Status: DONE (2026-08-03).

- Objective: reverse a committed batch and stage a corrected successor without deleting provenance.
- Dependencies: IMP-003A.
- Requirements: IMP-005, OPS-001.
- Files: reversal/supersession services, action/route, integration tests.
- Deliver: dependency impact check; idempotent reversal; compensating ledger/cash effects; corrected `supersedes_batch_id`; rebuild/audit.
- Acceptance: reversal restores ledger-derived cash/lots/holdings for an isolated batch; later dependent facts are blocked with exact impact; rows/mappings/audit remain readable to the owner.
- Tests: clean reversal, repeated reversal, dependent later sale, corrected re-import, partial-failure resume, cross-user denial.
- Risks: later-lot dependencies and irreversible operator misunderstanding.
- Parallel safe: no.
- Completion note: Added owner-scoped, bounded, idempotent batch reversal with compensating ledger/cash effects, queued rebuild evidence, exact later-sale impact blocking, immutable reversed source rows, audit events, and corrected uploads linked through `supersedes_batch_id`. Integration coverage includes clean/repeated reversal, dependency blocking, corrected re-import, partial resume, and cross-user denial; the full repository suite passes.
- Review resolution: Corrected uploads now forward the optional superseded batch ID through the authenticated upload action, and equal-timestamp dependent sales follow the stable transaction-ID ordering when blocking reversal. The reversal HTTP boundary enforces same-origin checks before its authenticated action and keeps private no-store responses; the action core is independently testable without bypassing owner context. Integration coverage now includes direct cross-owner denial, malformed, stale and unconfirmed actions, cross-site route rejection before action execution, authenticated route completion, and instrumented query, statement, atomic-unit, parameter, and chunk-size bounds.

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

### DIV-004 — Imported-dividend tier separation and entry proximity warnings

Status: DONE (2026-08-13); required BEFORE UI-006B/UI-006C ship their manual dividend-entry forms (2026-08-13, from IMP-006 review).

- Problem: IMP-006 lands imported CSV dividends as `dividend_manual_records`, so they sit in DIV-001's MANUAL precedence tier. Consequences measured by the IMP-006 reviewer: an imported row outranks an owner-typed receipt for the same event (receipt retained as dominatedReceipt), and an imported row duplicating an owner-typed manual record produces two rows (double count). Currently unreachable — only the importer creates manual records — but UI-006B/C's forms make both cases live.
- Deliver: (a) distinguish import-created records (import_batch_id already present) as an `imported` source tier ranking BELOW owner-typed facts in `domain/dividends/history.ts` precedence (override > manual > receipt > imported > auto) with proximity dedupe across tiers; (b) a preview-time proximity warning in the import review when an incoming dividend row falls within the matching window of an existing owner-entered manual record or receipt; (c) docs updated (CSV_IMPORT_SPEC precedence sentence restored to the full ordering, CALCULATIONS §11 tier list).
- Acceptance: owner-typed receipt beats an imported row for the same event; imported row duplicating an owner manual record collapses to one row (owner wins); preview warns before committing a probable duplicate; no regression to provider-event dedupe.
- Tests: tier matrix (imported × receipt/manual/override/auto), preview warning fixtures, IMP-006 round-trip regression.
- Completion note (2026-08-13): Five distinct tiers in `domain/dividends/history.ts` — override > manual (owner-typed, import_batch_id NULL) > receipt > imported (batch-attributed) > auto — with cross-tier proximity collapse (winner exposes dominatedReceipt/dominatedImported), standalone imported-vs-owner collapse, excluded-event resurfacing extended, and the `imported` source label for UI-006C. Preview warning `DIVIDEND_NEAR_EXISTING_ENTRY` (warning severity, PROXIMITY_WINDOW_DAYS single-sourced and interpolated) raised at reconciliation when an incoming dividend row falls within the window of an existing owner-typed record/receipt, loaded owner-scoped in `app/import-actions.ts`. Review round 1 FAIL: the warning entered the hashed previewVersion on only the page path, making affected imports permanently uncommittable (409 on ready AND commit, no recovery) → Orchestrator ruling: advisory evidence excluded from the canonical hash by construction (`hashedPreview` filters exactly that code; error-severity issues still drive the version — sensitivity-verified both by worker revert-test and reviewer probes); DB-level round-trip regression added; round 2 PASS with reviewer-re-executed end-to-end repro (warning shown, ready and commit succeed with the page version, all four computation paths agree). Recorded consequence: the warning is best-effort at render time — a manual record typed in another tab after a preview renders won't invalidate that preview (identical to pre-DIV-004 behaviour). `npm run check` exit 0 (562 pass, 10 gated skips). Known limitation split out as DIV-005.

### DIV-005 — Transitive proximity chaining in dividend dedupe

Status: DEFERRED (2026-08-13); narrow band, recorded from DIV-004 review — the code comment at `domain/dividends/history.ts` (standalone-collapse site) references this entry.

- Problem: proximity collapse links facts pairwise to events, not transitively. An owner fact anchored to event E (within E's ±7-day window) does not collapse with an imported row that is within the owner fact's window but OUTSIDE E's (reviewer repro: event pay 03-20, owner manual 03-27, imported 03-31 → two rows, 240 counted vs 120 real). Pre-existing DIV-001 band behaviour (same shape existed manual-vs-manual); reachable only in the 1–7-day skew band between an event date and its owner fact's payment date.
- Fix direction: cluster facts transitively (union-find over the proximity graph per security) before precedence resolution, or widen matching to compare against the anchored fact's own payment date, with determinism preserved.
- Dependencies: DIV-004. No urgency signal; promote if real imports surface double counts in this band.

### UI-006C — Per-security dividend history tab

Status: READY (all dependencies incl. DIV-004 done 2026-08-13). Owner decisions recorded 2026-08-13 (wireframe-approved).

- Objective: a "Dividends" tab on each security's detail view showing the full auto-populated dividend history, declared-but-unpaid events, per-row editing, and lifetime totals.
- Dependencies: DIV-001 (derived-history model), MKT-005 (events), DB-005 (override/manual tables), UI-003/UI-005A (security detail surfaces), AUTH-004, QA-001B.
- Requirements: DIV-003 requirement family; QA-001A matrix rows for any new routes; QA-001B accessibility.
- Deliver: dividends tab listing one row per dividend (payment date, shares at ex-date, per-share amount, franking per share with source, cash, gross, source label auto/edited/manual); unpaid declared rows in a distinct colour PLUS the compact text status "not paid" (owner decision 2026-08-13 — never colour alone, never longer phrasing); every row clickable, opening the per-share form (UI-006B's 4a) pre-filled for edit/override with the exclude action; lifetime summary at the bottom — cash received, franking credits (flagging how many dividends have unknown franking), gross, and a separate "declared, not yet paid" line; a visible "franking if not known" default for the holding (edits the same value as the assumptions grid); "+ Record dividend" entry point; a "Refresh historical" button that re-pulls this security's provider dividend history behind a confirmation warning dialog, preserving all owner overrides/exclusions (they are sparse event-keyed rows).
- Acceptance: auto rows derive from provider events × shares held at ex-date and update when new events arrive regardless of existing overrides; edited rows are labelled and win over later provider corrections while the detail shows both values; unknown franking is excluded from franking totals and flagged, never zero; unpaid dividends are excluded from lifetime received and shown separately; all statuses are conveyed in text as well as colour; table scrolls horizontally inside its container on mobile; SOLD SHARES: dividends received while the shares were held remain listed and in lifetime totals permanently, no new rows accrue after a full exit (shares at ex-date resolves to zero), and a fully-sold security remains reachable in the UI (closed-positions access path) — nothing about a sale hides or deletes dividend history; Refresh historical requires explicit confirmation and never discards overrides.
- Tests: derivation against holdings-at-date fixtures, override precedence and provider-correction display, exclude behaviour, franking-chain resolution (override/default/unknown), declared-vs-paid totals split, rendered accessibility (status text, labels), ownership denial on any new route.
- Risks: shares-at-ex-date wrong when ledger history is incomplete — the editable shares field and exclude flag are the escape hatches; misreading declared rows as received — text status is load-bearing.
- Parallel safe: yes with UI-006A/B after DIV-001.

### CGT-001 — Capital gains reporting (placeholder)

Status: DEFERRED; owner-flagged 2026-08-13 as likely future work — recorded now so retention guarantees have a named consumer.

- Objective: realized (and possibly unrealized) capital-gains reporting per FY, including AU CGT discount eligibility, built on existing ledger data.
- Foundation already in place (verified 2026-08-13): `lot_allocations` stores per-sale matched quantity, allocated base basis, net proceeds, fees, tax, and `baseRealisedGainDecimal`; tax lots persist as `closed` with acquisition dates and original quantities; transactions are immutable. Realized gains are therefore derivable without new ledger machinery.
- Standing constraint on ALL other tasks: never delete or irreversibly hide closed lots, allocations, sold-security links, or their history — CGT-001 and the dividend history (DIV-001/UI-006C) both depend on full retention of sold-share data.
- Dependencies: FY-001A (FY windows); scope/design decisions when promoted.

### IMP-006 — Dividend-receipt rows in CSV import

Status: DONE (2026-08-13); owner-requested 2026-08-13 (dividend modelling feature).

- Objective: extend the staged CSV import pipeline with a dividend-receipt row type so broker exports containing dividend transactions land as actual receipts through the existing preview/commit/reverse workflow.
- Dependencies: DB-005 (receipt schema), DIV-001 (receipt validation/posting rules), IMP-004A (review workflow), IMP-003B (reversal).
- Requirements: extend the CSV import requirement set and `docs/CSV_IMPORT_SPEC.md` (row type, column mapping, validation, idempotency key) in the same change set.
- Deliver: dividend-receipt row parsing/mapping (security, payment date, cash amount, franking credits, withholding — decimal strings; missing franking is `unknown`, never zero); staged/previewed/validated like transactions, batch-attributable and reversible; idempotency keyed consistently with existing duplicate detection; receipts post through DIV-001's path on commit, never directly.
- Acceptance: a CSV containing both trade and dividend rows stages, previews with per-type counts, commits atomically, and reverses cleanly; duplicate dividend rows across re-imports are detected; a dividend row for an unresolved security blocks readiness exactly like trades (SECURITY_UNRESOLVED); franking absent ≠ franking zero; imported dividends participate in DIV-001's one-row-per-event precedence (manual/override > imported > auto-derived) so an imported dividend matching a provider event never double-counts.
- Tests: parse/mapping/enum edge cases, duplicate detection across batches, unresolved-security blocking, commit/reverse round trip including receipts, mixed-type batch atomicity.
- Risks: broker CSV dividend formats vary (net vs gross, franking present or absent) — mapping must be explicit, never inferred silently.
- Parallel safe: yes with DIV-003 after its dependencies.
- Completion note (2026-08-13): Dividend rows flow through the existing staged pipeline via a new exact-signature header version `strict-18-column-dividends-v1` (17 columns + Franking Credit Per Share) alongside the untouched strict-17 contract; Type=Dividend reuses trade columns (payment date/shares/DPS), issue codes DIVIDEND_PER_SHARE_INVALID / FRANKING_INVALID / FRANKING_ON_NON_DIVIDEND (warning). Architecture decision (worker-resolved, reviewer-validated): committed dividend rows create `dividend_manual_records` — NOT `dividend_receipts`, whose NOT NULL dividend_event_id FK would force fabricating shared provider events; records carry new `import_batch_id`/`source_reference` columns (migration 0032, ALTER-ADD only, purge-lock triggers intact) with a (portfolio_id, source_reference) unique index for cross-batch dedupe; commit statements fold into the existing guard-conditional atomic batch; reversal hard-deletes batch-created records with `reversedDividendRecordCount` audit metadata; SECURITY_UNRESOLVED blocks dividend rows like trades; franking absent = NULL never zero. Review round 1 FAIL (fingerprint serialization change broke cross-version idempotency — pre-upgrade imports double-posted on re-import; docs overclaimed a nonexistent imported tier) → fixed (franking contributes to row identity only for dividend rows with a value; legacy fingerprints byte-identical, pinned by sensitivity-verified constant; docs state the real two-tier model and the gap tracked as DIV-004) → round 2 PASS with reviewer-re-executed cross-version repro (re-import dedupes, quantity stays 5). `tests/imp-006.test.ts` 20 tests incl. end-to-end derived-history and real-fingerprint cross-batch coverage. `npm run check` exit 0 (545 pass, 10 gated skips). Non-blocking: CSV_IMPORT_SPEC §10/line-118 wording could state the narrower fingerprint rule; pre-existing parseAccountingMethod dead code noted.

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

Status: DONE (2026-08-13); promoted 2026-08-13 by owner decision — dividend modelling feature (see DIV-003 for the recorded owner decisions). Scope extended: in addition to the original deliverables, add (a) a portfolio-scoped dividend-assumptions table — per-security override rows (dividend yield %, franking %, dividend growth %, all nullable decimal strings; null = fall back to provider-derived values) plus portfolio-level rows (portfolio value growth %, portfolio dividend growth %) — owner-scoped, versioned, never affecting ledger facts; and (b) a portfolio-scoped FY dividend actual-override table (financial year key, grossed amount, franking amount as decimal strings) for owner-typed historical corrections, distinct from receipts. Extended again 2026-08-13 (owner dividend-history decisions): add (c) a per-dividend override table keyed (owner, portfolio, security, dividend event) with sparse decimal-string columns — shares, dividend per share, franking credit per share — plus an exclude flag; and (d) a manual dividend record table (owner, portfolio, security, payment date, shares, dividend per share, franking credit per share) for dividends with no provider event. The per-security franking % in the assumptions table doubles as the holding's "franking if not known" default for auto-populated dividend history.

- Objective: add dividend facts only when the actual-receipt workflow and provider capability are scheduled.
- Dependencies: LED-001A, DB-002, DB-003.
- Requirements: DIV-001, DIV-002.
- Files: schema/migration/repositories/tests.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `DIV-001 — Dividend events and receipts` and `DIV-002 — Dividend forecasts`
- `docs/DATA_MODEL.md` — `split_events`, `dividend_events`, `dividend_receipts`, and `Transaction boundaries and invariants`
- `docs/CALCULATIONS.md` — `Dividends (deferred)` → `Actual receipt`
- `docs/ARCHITECTURE.md` — `Domain module boundaries` (dividend-module promotion rule)

**Likely code:**

- `db/schema.ts`
- `db/repositories/index.ts`
- `domain/market-data/contracts.ts`
- `domain/ledger/event-validation.ts`
- `tests/db-schema.test.ts`
- `drizzle/` (generated migration only after this task is promoted)

**Verification:**

- Extend `tests/db-schema.test.ts` with migration, revision, ownership, cash-link, and estimated-versus-actual constraints.
- Run `node --experimental-strip-types --test tests/db-schema.test.ts tests/led-001a.test.ts tests/mkt-001.test.ts` and inspect the generated migration before the inherited repository gates.

- Deliver: corrected/superseded split/dividend events, owner-scoped actual receipts/cash links, and separate estimate inputs; no estimated receipt row.
- Acceptance: an event cannot masquerade as an actual receipt; receipt transaction/membership/cash links are owner/portfolio constrained.
- Tests: event revisions, receipt ownership/cash linkage, estimated-vs-actual constraints.
- Risks: premature schema for provider data the release cannot reliably source.
- Parallel safe: only after the feature is promoted into release scope.
- Completion note (2026-08-13): 8 new tables in `db/schema.ts` via CREATE-only migration `drizzle/0030_ambitious_wiccan.sql` (no rebuilds — FY-001A trigger hazard checked) with 18 hand-appended purge-lock triggers: shared `dividend_events`/`split_events` (provider facts, insert-new + supersede corrections, provenance NOT NULL, born-superseded inserts rejected, excluded from export/purge like `securities` — carry no owner data); owner-scoped `dividend_receipts` (per-share, CHECK status='actual' — estimates structurally unstorable), `dividend_security_assumptions`/`dividend_portfolio_assumptions` (versioned, null = provider fallback), `dividend_fy_overrides`, `dividend_event_overrides` (sparse + exclude flag), `dividend_manual_records`. All six owner tables in export classification, FK-ordered purge deletion, and purge-lock triggers (reviewer re-probed all 18). Repositories in `db/repositories/dividends.ts` with DB-006-style pre-state audit construction and tri-state update contracts (omitted = unchanged, explicit null = clear — franking can no longer be silently wiped). Review round 1 FAIL (portfolio-assumptions duplicate-create lost update + false audit; franking wiped on partial update; ops-003b cutoff bump tautology; undocumented migration consequence) → round 2 PASS with reviewer-verified fixes incl. the RETURNING-discriminated create and a new explicit manifest-corrupt fail-closed test (export at 0029 → migrate 0030 → purge fails closed, source rows untouched; operational consequence documented in the OPS-003B runbook: schema-adding migrations invalidate completed exports pending deletion, owner must re-export). Fixtures extracted to `tests/fixtures/ops-003.ts` (removed double-registration). `tests/db-005.test.ts` + export-content assertions. `npm run check` exit 0 (415 pass, 10 gated skips).

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

Status: DONE (2026-08-13); promoted 2026-08-13 by owner decision (dividend modelling feature). Scope notes: additionally derive per-security trailing-12-month per-share dividends and trailing yield from ingested events (feeding the DIV-003 assumptions grid's provider-prepopulated columns). Franking percentage is explicitly NOT auto-sourced in this task — Yahoo-compatible endpoints do not carry franking data; the contract must leave a typed seam (franking fields present, provider population absent, explicit `unavailable` state) so a future franking source can slot in without schema change. Manual franking entry is DIV-003/UI-006B scope. Ingestion/storage decisions (owner review 2026-08-13): provider dividend events are PERSISTED in D1 (`dividend_events`, DB-005) — D1 is the store per the D1-first architecture rule (owner's "CSV or separate file" suggestion resolved to D1; CSV remains an import/export format only, and no R2/file persistence is introduced). Ingestion triggers: (a) full dividend history pulled when a security is first added/verified into a portfolio; (b) new declarations picked up on the normal market-data refresh path; (c) an owner-initiated per-security historical re-pull endpoint (consumed by UI-006C's "Refresh historical" button) that replaces provider event rows for that security while never touching owner override/manual/exclusion rows. Sold shares: ingestion and event retention are independent of current position size — events are per security, quantities resolve at read time, so a full exit stops new derived rows without any event deletion.

- Objective: add adjusted history, splits, and dividend-event ingestion only after source coverage/semantics are independently validated.
- Dependencies: MKT-002, DB-005.
- Requirements: MKT-002, DIV-001, DIV-002.
- Files: capability-specific adapters/fixtures/tests.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `MKT-002 — Provider abstraction`, `DIV-001 — Dividend events and receipts`, and `DIV-002 — Dividend forecasts`
- `docs/MARKET_DATA_STRATEGY.md` — `Provider abstraction`, `Historical strategy`, and `Data gaps and manual fallback`
- `docs/CALCULATIONS.md` — `Dividends (deferred)` and `Deterministic test fixtures`
- `docs/DATA_MODEL.md` — `split_events` and `dividend_events`

**Likely code:**

- `domain/market-data/contracts.ts`
- `domain/market-data/yahoo-compatible.ts`
- `domain/market-data/normalize.ts`
- `domain/market-data/index.ts`
- `db/repositories/market-data.ts`
- `tests/mkt-001.test.ts` and `tests/mkt-002.test.ts`

**Verification:**

- Extend the provider contract/adapter fixtures for split corrections, raw-versus-adjusted continuity, and missing/irregular dividend events.
- Run `node --experimental-strip-types --test tests/mkt-001.test.ts tests/mkt-002.test.ts tests/mkt-003b.test.ts` and `npm run build` to verify the server-only adapter remains Worker-compatible.

- Deliver: adjustment definitions, split revisions, and dividend events as actually supported; no inferred actual receipts.
- Acceptance: raw/adjusted series cannot double-apply a split; missing/irregular dividend data yields unavailable, not an annualized guess.
- Tests: split correction, raw/adjusted continuity, missing/special/irregular dividend events, schema change.
- Risks: unreliable best-effort corporate-action semantics.
- Parallel safe: only after the feature is promoted into release scope.
- Completion note (2026-08-13): Yahoo-compatible `getDividendEvents`/`getSplitEvents` (chart endpoint, events=div,splits) with boundary validators, decimal-string conversion, provenance, franking never populated (typed unavailable seam); pure TTM derivation (`domain/market-data/dividend-yield.ts`: trailing-365-day exact sum, never annualized, insufficient_history/currency_mismatch/price_unavailable states; CALCULATIONS §11 subsection); `domain/market-data/corporate-action-ingestion.ts` full-pull-and-reconcile (natural key; unchanged no-op; fact changes supersede preserving priors; pure declared→paid transitions update status in place per Orchestrator ruling — lifecycle column, not a correction; droppedDuplicates surfaced). Ingestion triggers: bounded provider instance (1 attempt/3s) fire-and-forget after IMP-004B verify; cron sweep ranked by new shared `corporate_action_refresh_state` attempt-watermark table (migration 0031, CREATE-only, excluded from export/purge; upserted on success/failure/no-op — reviewer-verified fair rotation incl. non-payers and total provider failure); per-security re-pull function for UI-006C. Partial unique indexes on active dividend/split events close the concurrent double-ingestion race (benign-race recovery via post-condition re-read, real failures still surface as write_failed). Review round 1 FAIL (sweep starvation, unbounded verify latency, override-survival doc/test mismatch, clock-inferred status churn, missing split tests, missing CALCULATIONS) → round 2 PASS with independent repros. `npm run check` exit 0 (437 pass, 10 gated skips). Follow-ups for later: narrow `updateStatus` to lifecycle values; `corporate_action_refresh_state` single-provider key (composite when a second provider lands); the unique indexes assume no pre-existing duplicate active rows (deployment note); first-observation provenance overwritten by lifecycle updates (documented).

### CALC-001A — Decimal primitives, basis, gain, and current value

Status: DONE (review fixes completed 2026-08-03).

- Objective: implement the exact-decimal calculation foundation and single-date holding results.
- Dependencies: LED-002B, MKT-001 fixture contract.
- Requirements: LED-002, CALC-001, CALC-002, CALC-003, CALC-004, CALC-007.
- Files: `domain/calculations/**`, independent fixtures/tests.
- Deliver: reviewed decimal dependency; parse/round/allocation primitives; native market value; open basis; realised/unrealised gains; named unavailable results.
- Acceptance: formula fixtures match `CALCULATIONS.md`; every unavailable result has a stable reason; no financial path accepts/returns JS binary-float values.
- Tests: same-currency/FIFO fixture families, property/invariant tests, zero/missing denominators, allocation/display rounding.
- Risks: denominator semantics and rate inversion.
- Parallel safe: yes with market adapters using fixture contracts.
- Completion note: Added the exact-decimal calculation foundation, proportional allocation with reconciled final residuals, native holding value/basis/gain results, stable unavailable reasons, and deterministic FIFO calculation fixtures. Existing preview decimal callers now use the shared domain implementation.
- Review findings: The implementation is a bespoke bigint fraction rather than the documented reviewed arbitrary-precision decimal dependency, accepts unbounded decimal length/scale (including potentially unbounded `pow10` work), and rounds most available holding/basis/gain outputs to 18 places despite the calculation rules requiring source precision to be retained. The “FIFO” fixture supplies precomputed basis/realised gain instead of exercising the ledger FIFO result, and the required invariant/property coverage is absent for malformed inputs, denominator/scale boundaries, negative/zero cases, and allocation reconciliation. An explicit `null` previous price was also reported as `missing_price`; this review corrects it to the stable `missing_previous_price` reason. Complete bounded, source-precision-safe decimal semantics and ledger-integrated invariant coverage before marking this task done. This domain task has no mobile surface.
- Review resolution: Replaced the bespoke fraction with exact-pinned `decimal.js` `10.6.0` behind canonical string-only input and bounded input/result/allocation limits; exact finite holding, basis, and gain outputs now retain their calculated source scale while division and display/allocation rounding remain explicit. The CALC fixture derives remaining quantity/basis and realised gain from the production FIFO allocator, and deterministic invariant coverage now exercises malformed and boundary inputs, algebraic identities, zero/negative states, named unavailable reasons, and final-residual reconciliation. The Worker production build verifies the dependency’s runtime compatibility; no mobile validation applies to this pure domain task.
- Follow-up review finding: The holding primitives used the shared decimal wrapper, but the production FIFO allocator and ledger projection builder still contained independent, unbounded `bigint`/power-of-ten implementations. Consequently, the purported production FIFO fixture could still accept oversized scale/digit inputs and bypass the reviewed calculation boundary.
- Follow-up review resolution: Production FIFO matching, fee/proceeds/basis allocation, split adjustment, and ledger projection arithmetic now use the same bounded `decimal.js` wrapper. Default FIFO allocation retains the documented 24-place source boundary, exact final residuals still reconcile, malformed or oversized lot/sale/split inputs fail closed, and regression fixtures exercise high-scale production allocations plus digit/scale limits. All focused and repository checks pass; no mobile surface applies to this domain task.

### CALC-001B — FX conversion, daily movement, and partial totals

Status: DONE (follow-up review resolution completed 2026-08-04).

- Objective: add date-attributable home-currency presentation and coverage-aligned portfolio totals.
- Dependencies: CALC-001A, MKT-003A, MKT-004.
- Requirements: PRD-005, LED-002, CALC-002, CALC-005, MKT-004, MKT-005.
- Files: calculation modules/fixtures/tests.
- Deliver: transaction/valuation FX selection inputs; native/home display result; daily movement/decomposition; cash conversion; known/partial totals whose invested value and basis use the same covered set.
- Acceptance: toggle shares native facts; transaction explicit FX takes precedence; missing FX keeps native result; incomplete totals cannot serialize as complete; timestamp/source remain in explanation data and are generally suppressed in compact fields.
- Tests: foreign buy/sell/current FX, direct/inverse/identity, flat-price/FX movement, missing components, aligned coverage sets, rounding.
- Risks: rate inversion or subtracting uncovered basis from covered value.
- Parallel safe: yes after MKT-003A contract freezes.
- Completion note: Added bounded exact-decimal transaction/valuation FX resolution with explicit transaction precedence, native/home holding presentation and provenance explanations, reconciled price/FX daily movement, signed cash conversion, and discriminated complete/partial portfolio totals whose invested value and basis share one aligned coverage set. Deterministic fixtures cover foreign buy/sell/current rates, direct/inverse/identity conversion, missing components, compact provenance suppression, cash, decomposition, coverage, and rounding; the aggregate repository gate passes.
- Review finding: The calculation result drops the market selector's current/stale/fallback/quality state, so a last-known stale or fallback FX value can be represented indistinguishably from a normal current observation. The portfolio-total inputs also omit holding quantity and cash balance (or an explicit inclusion flag), so zero positions/accounts with missing price or FX are counted as excluded even though the normative coverage rule applies to non-zero components; an explicit zero foreign-currency balance can consequently make an otherwise known total partial or unavailable. Extend the calculation contracts to carry selector state into explanation/actionability and to compute coverage over non-zero components, then add stale/fallback and zero-position/zero-cash regression fixtures before returning this task to `DONE`. This review also made inversion-scale handling fail closed instead of returning a rate that downstream bounded decimal parsing rejects. The task remains a pure domain slice, so mobile and owner-isolation behavior are not applicable here.
- Review resolution: FX evidence now requires selector state, quality, fallback flag/reason, and derives stable explanation/actionability so stale and fallback rates remain distinguishable from current observations without entering compact fields. Portfolio totals now require exact holding quantity and native cash balance, report total/non-zero/zero coverage, exclude exact zero components from gaps, fail conservatively on malformed materiality inputs, distinguish explicit all-zero totals from an empty portfolio, and retain aligned value/basis semantics for every non-zero holding. Focused fixtures cover fallback/stale provenance plus zero positions and foreign cash with missing FX; the 184-test aggregate gate passes.
- Follow-up review resolution: FX resolution now rejects contradictory selector-state/fallback and source/quality evidence, while usable stale rates remain explanation-only unless a separate unavailable condition requires action. Portfolio coverage now counts malformed or negative holding quantities and malformed cash balances as explicit invalid gaps, so apparently available monetary fields cannot turn invalid materiality into a complete total. Regression coverage exercises both boundaries; the task remains a pure domain slice with no mobile or owner-isolation surface.
- Follow-up review finding: CALC-001B reparses available calculated values with the source-input parser, whose 64-digit/24-scale limits are intentionally narrower than the shared wrapper's 256-digit/96-scale exact-result limits. A holding produced from valid 40-digit quantity and price inputs therefore calculates an 80-digit native value successfully in CALC-001A but throws during home conversion; `composePortfolioTotals` likewise throws when given a valid calculated result beyond the source-input boundary. Add a bounded internal calculated-result parsing/transport path that preserves the shared result limits, make every CALC-001B API return a typed deterministic unavailable result instead of throwing for supported or oversized calculated values, and add high-digit/high-scale holding-conversion and aggregate-total regression fixtures before returning this task to `DONE`.
- Follow-up review resolution: Added a dedicated 256-digit/96-scale calculated-result parser and routed CALC-001B calculated-value transport through it while retaining the 64-digit/24-scale source parser for external facts. Holding conversion, daily movement, cash conversion, and portfolio aggregation now catch malformed or over-bound result transport and return deterministic typed unavailable values. High-digit/high-scale holding conversion, aggregate totals, parser bounds, and oversized-result no-throw fixtures pass the focused and repository gates.
- Final review resolution: FX evidence consistency now also rejects cross-currency identity claims, transaction facts reused as valuation evidence, and stale/fallback explicit transaction facts. Exact former-failure, maximum source-bound daily/cash, and aggregate-overflow probes confirm calculated-result transport remains bounded and non-throwing. No further CALC-001B acceptance gap was found; the task remains pure domain code with no direct mobile or owner-isolation surface.

### CALC-002 — Historical snapshots and rebuild

Status: DONE (independent calendar/repository review resolved 2026-08-09).

- Objective: produce reproducible historical value series from dated ledger, price, FX, and cash facts.
- Dependencies: CALC-001B, MKT-003B, LED-002B, DB-004.
- Requirements: LED-005, MKT-005, CALC-005, CALC-006.
- Files: snapshot services/jobs/repositories, chart response contract, tests.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `CALC-005 — Daily movement` and `CALC-006 — Portfolio history`
- `docs/CALCULATIONS.md` — `Historical values and snapshots`, especially `Daily holding value` and `Chart gaps`
- `docs/ARCHITECTURE.md` — `Historical-data strategy`
- `docs/DATA_MODEL.md` — `exchanges`, `portfolio_daily_snapshots`, `holding_daily_snapshots`, `snapshot_publications`, and `calculation_runs`
- Current task review finding below — bounded validity-dated exchange-session evidence, portfolio-cutoff mapping, and persisted selected-session identity

**Likely code:**

- `domain/snapshots/history.ts`
- `domain/snapshots/index.ts`
- `db/repositories/snapshots.ts`
- `db/repositories/calculation-runs.ts`
- `db/schema.ts`
- `tests/calc-002.test.ts`, `tests/calc-002-repository.test.ts`, `tests/db-004.test.ts`, and `tests/db-schema.test.ts`

**Verification:**

- Run `node --experimental-strip-types --test tests/calc-002.test.ts tests/calc-002-repository.test.ts tests/db-004.test.ts tests/db-schema.test.ts`.
- Add focused normal-day/DST/weekend/holiday, evidence-size boundary, lease-retry determinism, ownership, and migration fixtures; inspect any generated migration before the inherited repository gates.

- Deliver: daily quantities/cash, price/FX join, coverage/completeness, versioned snapshot invalidation and bounded rebuild.
- Acceptance: no back-cast current quantity; unsupported ranges/gaps are marked without routinely printing observation timestamps; rebuild is deterministic and resumable.
- Tests: trades across boundaries, weekend/holiday, FX gaps, corrections/invalidation, calculation-version change, partial history.
- Risks: exchange/portfolio timezone cutoff; D1 growth.
- Parallel safe: no with snapshot UI contract; can precede UI.
- Completion: added deterministic ledger-replayed historical snapshots, bounded resumable calculation-run rebuilds, owner-scoped invalidation and completed-version chart reads, explicit stale/missing market-data coverage, and zero-component handling. Verified with CALC-002 domain/repository fixtures plus repository-wide checks.
- Review fixes: owner-specific market observations are now filtered to the authenticated owner, compensating cash reversals replay to zero instead of double-subtracting, and malformed ledger/cash facts remain explicit gaps rather than zero components.
- Review fixes: snapshot rows now carry run identity and publish through an atomic completed-run pointer; rebuilds count facts before bounded, single-date reads and pin observations to `calculation_runs.market_data_cutoff`; inverse FX direction is selected and resolved by the existing calculation contract; calendar-aware fixtures retain holiday versus missing-session state; same-version isolation, lease loss, fixed-cutoff correction, inverse FX, holiday/session, and fact-budget regressions are covered.
- Follow-up review fixes: expired leases can no longer advance a checkpoint after guarded writes are skipped; invalid/overlong ranges fail without publication; fact budgets include cash accounts and overrides; raw prices are enforced so split-replayed quantities are not double-adjusted; unrelated FX pairs are excluded; missing expected sessions become explicit performance-excluding gaps; and the preceding-day replay retains the selector's full fallback window. Calculation-version isolation and these boundaries now have focused regressions.
- Follow-up review finding: the task is not complete. Snapshot selection still equates a portfolio-local date with every exchange market date of the same text and does not compute the portfolio’s local end-of-day cutoff instant from `portfolios.timezone` against each observation’s exchange timezone/close. A cross-timezone portfolio can therefore consume a foreign-market close that occurred after that portfolio day ended, creating look-ahead history. Add an explicit, validity-dated exchange calendar/session input, select only observations available by the portfolio cutoff, persist the selected market date/session evidence, and cover Australian-portfolio/US-market, DST transition, holiday, and missing-session fixtures. The current `expectedTradingDatesBySecurity` option is also process-local rather than pinned to the calculation run; persist/version the calendar evidence (or bind it to an immutable calculation-version contract) so lease retries cannot change holiday/session classification before returning this task to `DONE`.
- Review resolution: historical price and FX selection now rejects observations whose instants fall after the portfolio-local end-of-day cutoff, with IANA/DST-aware conversion. Calendar evidence is canonicalized onto `calculation_runs` at request time and loaded from the run on every retry, so changed worker/process options cannot alter holiday versus missing-session classification. Sydney/US cutoff, FX cutoff, and calendar-pinning regressions pass.
- Calendar-model review fixes: malformed/version-mismatched persisted calendar evidence now fails the rebuild instead of silently becoming an unknown calendar, and snapshot requests can no longer bypass canonical serialization with caller-supplied raw JSON.
- Calendar-model review finding: the task is not complete. The pinned payload remains an unbounded `portfolio_security_id -> market-date[]` map, not validity-dated exchange/MIC sessions with close instants. Although the observation-instant filter prevents the direct look-ahead case, holiday/missing-session classification and fallback still compare the portfolio-local date to exchange date text; for cross-timezone holdings the latest session completed by the portfolio cutoff may be the preceding exchange date. Replace the per-holding date duplication with bounded, provenance/versioned exchange-session evidence (or immutable references/digests), map each portfolio cutoff to the latest completed session, and persist the selected session identity. Add Australian-portfolio/US-session fixtures across normal days and DST, Friday/weekend/Monday and exchange holidays, plus size/boundary and retry-determinism tests before returning this task to `DONE`.
- Calendar-model review resolution: replaced the per-holding date map with a bounded canonical version-2 exchange/MIC session envelope carrying non-overlapping validity intervals, IANA timezone, provenance/revision, and session open/close instants. Historical rebuilds evaluate each validity candidate in its own timezone, map each portfolio-local cutoff to the applicable interval, carry the latest completed session across interval boundaries, classify holidays versus completed-session quote gaps, and persist selected session identity/date/close plus evidence version on holding snapshots. Repository price loading uses a bounded pinned-session market-date upper window while domain filtering enforces the exact portfolio cutoff. Sydney/New York DST transitions, timezone-change interval fallback, Friday/weekend/Monday fallback, weekday holiday/missing-session, validity-boundary, following-market-date, evidence-size, and lease-retry pinning fixtures pass; migration `0023_brave_mockingbird.sql` adds the holding evidence columns.

### DIV-001 — Dividend events, receipts, and forecasts

Status: DONE (2026-08-13); promoted 2026-08-13 by owner decision (dividend modelling feature). Owner dividend-history model (decided 2026-08-13, supersedes the original type-a-total receipt concept): dividend history is DERIVED AT READ TIME — for each ingested provider dividend event, the auto row = shares held at the ex-date (from existing ledger projections) × dividend per share. Owner overrides are sparse rows keyed to a specific event (shares, dividend per share, franking per share, or exclude), so overriding an old dividend can never block new events flowing through; if the provider later corrects an overridden event the override still wins and the detail view shows both values. Manual dividend records (per-share form, shares auto-filled from holdings at the payment date) cover securities/events the provider misses, with a proximity warning when a manual entry falls within days of a known event (double-count guard: for one security+event window exactly one row wins — manual/override > imported > auto-derived). Franking resolution chain per dividend: per-dividend override → the holding's "franking if not known" default (the assumptions-grid franking %) → unknown, excluded from franking totals and flagged, never silently zero. Declared-but-not-yet-paid events appear in history with an explicit status, count toward the next-12-months forecast, and are excluded from lifetime-received totals (reported as their own pending line). FY attribution uses the payment date. Dividend history rows are income-reporting facts, not ledger transactions — nothing here posts cash to the ledger in v1 (and no DRP). BINDING additions from MKT-005 review (2026-08-13): (1) owner overrides stay keyed to the event version they were created against; when the provider supersedes that event, resolution MUST walk the `supersedes_event_id` lineage (helper `collectEventLineageIds` exists) so the override still wins over the corrected provider value — a naive active-events lookup silently loses the override; (2) `dividend_events.status = 'paid'` is derived from ex-date passage (this provider supplies no payment evidence; payment_date is NULL) — it must never be treated as receipt evidence; actual receipt facts come only from `dividend_receipts`/manual records. Sold-shares semantics (owner decision 2026-08-13): dividends from shares sold later remain in history and lifetime totals permanently — the shares-held-at-ex-date derivation includes them while held and yields zero rows after a full exit, with no cutoff logic and no deletion; this relies on the project's existing retention guarantees (immutable transactions; tax lots persist as `closed` with original quantities; `lot_allocations` retains per-sale matched quantity, basis, proceeds, and `baseRealisedGainDecimal`; `portfolio_securities` links survive full exits) — verified against `db/schema.ts` and `domain/ledger/projections.ts` on 2026-08-13. Any change that would delete or hide closed-position data breaks both this feature and the planned capital-gains work (CGT-001).

- Objective: keep provider events, actual cash receipts, and honest future-income estimates distinct and explainable.
- Dependencies: LED-001B, DB-005, MKT-005, CALC-001B.
- Requirements: DIV-001, DIV-002.
- Files: dividend domain/service/repositories, tests.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `DIV-001 — Dividend events and receipts` and `DIV-002 — Dividend forecasts`
- `docs/CALCULATIONS.md` — `Dividends (deferred)`, `Missing-data and error behavior`, and dividend fixture family in `Deterministic test fixtures`
- `docs/DATA_MODEL.md` — `dividend_events`, `dividend_receipts`, and `Transaction boundaries and invariants`
- `docs/MARKET_DATA_STRATEGY.md` — `Data gaps and manual fallback` (dividend gap behavior)

**Likely code:**

- `domain/market-data/contracts.ts`
- `domain/ledger/posting.ts`
- `domain/calculations/`
- `db/schema.ts`
- `db/repositories/ledger.ts`, `db/repositories/market-data.ts`, and `db/repositories/audit.ts`
- No dividend domain/repository module exists yet; add one only when `DB-005` and `MKT-005` are promoted and complete.

**Verification:**

- Add deterministic dividend domain/repository tests covering declared versus paid, eligibility, payment-date FX, withholding, irregular history, corrections, ownership, audit, and atomic cash posting.
- Re-run the shared boundaries with `node --experimental-strip-types --test tests/calc-001b.test.ts tests/led-001b.test.ts tests/mkt-001.test.ts tests/mkt-003a.test.ts tests/db-schema.test.ts`.

- Deliver: declared/paid/corrected event ingestion; actual receipts/cash; declared-then-TTM forecast; withholding assumption; gross/net/yield labels.
- Acceptance: estimates never post cash or enter actual returns; actual payment-date FX; irregular history does not over-annualize; provenance/method visible.
- Tests: declared vs paid, eligibility, special/irregular dividend, withholding, franking info, missing FX/history, corrections.
- Risks: eligibility/corporate-action completeness; tax implications—keep informational.
- Parallel safe: yes with CALC-002 after shared contracts.
- Completion note (2026-08-13): `domain/dividends/` pure derivation layer + `app/owned-dividend-history.ts` read service (8 batched owner-scoped queries per portfolio). Shares-at-date from signed posted transactions ordered by trade_at with split ratios applied at ledger order; derived rows with precedence override > manual > receipt > auto (dominated receipt surfaced), global nearest-wins ±7-day proximity matching, exclusion collapsing all owner facts for an excluded event into one resurfaced row; franking chain override → assumptions-default → unknown-flagged, default credit = DPS × proportion/100 × 0.30/0.70 (AU_COMPANY_TAX_RATE documented constant, single half-even division at 24dp — Orchestrator franked-proportion ruling reconciling the approved wireframes); lifetime totals with pending declared-unpaid separated; per-FY totals aggregating all rows (actual / partially_estimated / provider_estimate by composition; owner FY override replaces the year, normalised to cash = grossed − franking); 12-month baseline forecast = declared near-certain + prorated displaced TTM tail (exactly 365-day window, tail = prorate(max(0, ttmAnnual − declaredCash)), irregular clamp to declared-only); binding lineage-override and status-never-receipt rules implemented; per-security mixed-currency degradation; amountUnknown rows never fabricate zeros. Three review rounds: 7 blockers round 1 (forecast +47% over-annualization, FY 75% under-report, exclusion destroying manual records, non-nearest proximity, precedence inversion, FY-override gross/cash conflation, splits ignored), 1 new blocker round 2 (excluded-event receipt+manual double-count), round 3 PASS with reviewer-re-executed repros incl. exclusion variants, irregular payers, same-day split ordering, cross-owner probes. `tests/div-001.test.ts` 49 tests; CALCULATIONS §11 rewritten to current. `npm run check` exit 0 (486 pass, 10 gated skips).

### DIV-003 — Retirement-income projection engine

Status: DONE (2026-08-13). Owner decisions recorded 2026-08-13: the feature is a retirement-income modeller, not a dividend calendar. All dividend calculations are per 12-month period; multi-year views are per financial year (FY-001A windows/labels). Projection formula: portfolio value compounds by the portfolio value-growth assumption; effective yield compounds by the dividend-growth assumption; each projected year's dividend = that year's projected value × that year's yield, where yield throughout means TOTAL yield including franking credits (owner decision 2026-08-13 — the grossed yield is the forecasting basis; cash/franking split derives from the franking % assumption). Assumption precedence per security: owner override (yield %, franking %, dividend growth %) wins when present; blank falls back to provider-derived TTM values extrapolated forward. Past-FY income precedence: owner FY override > sum of actual receipts for that FY > provider-derived estimate, with the winning source labelled on every row. Franking: grossed-up (cash + franking credits) is the headline figure, always labelled "includes franking credits", with the cash/credit split accessible; franking credits are included in predictions via the per-security franking % assumption. Projections run up to 10 years forward; history up to 10 years back. What-if growth adjustments are applied ephemerally and never persisted.

- Objective: pure domain projection engine turning holdings, assumptions, receipts, FY overrides, and provider TTM data into labelled per-FY income projections and single-12-month breakdowns.
- Dependencies: DB-005 (assumptions/override tables), MKT-005 (TTM yield derivation), DIV-001 (receipts, declared-then-TTM baseline), FY-001A (FY windows/labels), CALC-001A (decimal primitives).
- Requirements: new — add a `DIV-003` requirement with acceptance criteria to `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md`; document the projection formula, precedence, and franking treatment in `docs/CALCULATIONS.md` in the same change set.
- Deliver: `domain/dividends/` projection module (pure functions, decimal strings throughout): per-FY projection rows (year label, projected portfolio value, gross dividend, cash/franking split, effective yield %, method/source label per figure); single-12-month breakdown (total gross income, franking amount, cash amount, average per month, average per week, income % of portfolio value); assumption-resolution function implementing the precedence rules; what-if parameter overlay (growth/dividend-growth substitution without persistence); explicit typed states for insufficient history/missing prices — never a silent zero or an over-annualized guess.
- Acceptance: projection matches the recorded formula exactly on deterministic fixtures; every projected or estimated figure carries its method and assumption provenance; blank owner assumptions fall back to provider TTM and say so; a security with no dividend history and no override contributes `insufficient history`, not zero, and the total discloses partial coverage; past-FY rows resolve precedence correctly and label the winning source; what-if results never write to storage; all arithmetic is exact-decimal.
- Tests: formula fixtures across multi-year compounding, precedence matrices (override/receipts/provider × present/absent), franking gross-up and split, insufficient-history and partial-coverage states, FY boundary alignment with FY-001A, what-if overlay purity (no persistence side effects).
- Risks: compounding false precision — mitigated by mandatory method labels; conflating modelled income with ledger facts — the engine must be read-only over ledger data.
- Parallel safe: yes with IMP-006 once dependencies land; UI-006A/B consume it.
- Completion note (2026-08-13): `domain/dividends/projection.ts` (pure, no repository imports — test-asserted) + `app/owned-income-projection.ts` owner-scoped read service. Assumption resolution with source labels (owner override treated as already-grossed total yield; provider TTM cash yield grossed via the AU 3/7 formula; growth: security override → portfolio default → explicit no-growth label); value-weighted portfolio effective yield over covered securities with value-unavailable holdings NAMED in exclusions (never silently dropped, never weighted as zero — genuine $0 positions still weight as zero); multi-year compounding value×(1+g)^N, yield×(1+dg)^N, dividend = value×yield, exact repeated multiplication with one 24dp half-even rounding per step (reviewer-verified byte-exact against an independent Python Decimal reference through year 10); partial portfolio-value status propagates into every projection row's method incl. standalone what-if results (single propagation path via assumptions spread); typed degradation (portfolio_value_unavailable / no_yield_coverage / invalid_years; null baseline input makes zeroed what-ifs unrepresentable); past-FY rows consume DIV-001 totals with sources + no_evidence for absent years + snapshot-matched FY-end values (daily-continuous history, so weekends resolve); current-FY fy_to_date row; 12-month breakdown (gross/12, gross/52, income % with partial mirror); base-currency-only aggregation disclosed. Three review rounds (round 1: unpriced-holding erasure, partial-as-available, invalid_decimal misprovenance + zeroed what-if baseline; round 2: partial status not reaching what-if rows; round 3 PASS). `tests/div-003.test.ts` 39 tests; CALCULATIONS projection section; DIV-003 requirement added. `npm run check` exit 0 (525 pass, 10 gated skips).

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

Status: DONE (2026-08-09 browser QA follow-up).

- Objective: present the portfolio’s known value, movement, history, and data coverage without overstating completeness.
- Dependencies: UI-001, CALC-002.
- Requirements: CALC-002, CALC-006, CALC-007, MKT-005, PRD-004, QUAL-001.
- Files: Overview route/components/contracts/tests.

**Context:**

- `docs/CONSOLIDATED_PRODUCT_SPEC.md` — `Overview`, `Inspect a number`, responsive behavior, and `Product state contract`
- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `CALC-002 — Current market value`, `CALC-006 — Portfolio history`, `CALC-007 — Return metrics`, and `QUAL-001 — Accessibility`
- `docs/CALCULATIONS.md` — `Historical values and snapshots`, `Realised, unrealised, and headline returns`, and `Missing-data and error behavior`
- `docs/UI_SPEC.md` — `Overview`, responsive rules, empty/error states, and interaction/accessibility rules

**Likely code:**

- `app/portfolio/[portfolioId]/[section]/page.tsx`
- `app/authenticated-workspace.ts`
- `app/components/portfolio-shell.tsx`
- `app/globals.css`
- `db/repositories/snapshots.ts`
- `tests/rendered-html.test.mjs`, `tests/calc-002.test.ts`, and `tests/calc-002-repository.test.ts`

**Verification:**

- Add task-scoped Overview render/read-model tests for complete, partial, empty, stale, unavailable, and cross-owner states; keep chart text alternatives in semantic assertions.
- Run `node --experimental-strip-types --test tests/calc-002.test.ts tests/calc-002-repository.test.ts tests/rendered-html.test.mjs`, `npm run build`, and keyboard/320/390/430/desktop visual QA.

- Deliver: value/cash/cost/gain/daily summaries; history chart/ranges; allocation summary; coverage/formula drill-down; income remains absent/unavailable until DIV-001.
- Acceptance: partial/missing states are unambiguous; routine observation timestamps are suppressed; chart has a text alternative; mobile hierarchy works.
- Tests: complete/partial/empty/stale histories, coverage, accessibility, responsive snapshots.
- Risks: calling partial totals full totals or forecast actual.
- Parallel safe: yes with UI-003/004/005 after shell/contracts.
- Implementation evidence: Added an owner-scoped published-run Overview read model with strict run/range/fact/coverage validation, exact-decimal current/history/allocation presentation, explicit complete/partial/stale/incomplete/empty/unavailable states, formula and exclusion drill-down, bounded gap/extrema-preserving chart sampling with a semantic table alternative, calendar-correct range controls, and Overview-only loading that leaves other authenticated routes independent. Portfolio daily percentage remains explicitly unavailable until a calculation-layer comparable-denominator and cash-flow contract exists. Focused UI/CALC/render tests (46), the 228-test repository gate, lint, typecheck, production build, task-owned formatting, diff checks, and independent code review passed.
- Browser QA follow-up: raised the shared section-tab target and links to 44px, and changed the 320px Overview KPI grid to wrap without ellipsis so all five headline values remain readable. Added responsive source assertions covering both fixes. In-app browser retesting on 2026-08-09 confirmed 44px section tabs, unclipped Overview KPI values, and no document-level horizontal overflow at 320, 390, 430, and 1,440px; the production build passed after the retest.

### UI-003 — Holdings table and mobile cards

Status: DONE (2026-08-09 browser QA complete).

- Objective: reproduce the reference’s dense holdings utility with a distinct, usable mobile hierarchy.
- Dependencies: UI-001, CALC-001B.
- Requirements: CALC-002, MKT-005, PRD-004, PRD-005, QUAL-001.
- Files: Holdings route/components/tests.

**Context:**

- `docs/CONSOLIDATED_PRODUCT_SPEC.md` — `Holdings`, `View a foreign holding in home currency`, responsive behavior, and `Product state contract`
- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `PRD-005 — Native/home-currency display`, `CALC-002 — Current market value`, `MKT-005 — Market-data freshness and partial coverage`, and `QUAL-001 — Accessibility`
- `docs/CALCULATIONS.md` — `Native/home display toggle`, `Holding values`, and `Missing-data and error behavior`
- `docs/UI_SPEC.md` — `Holdings pattern`, responsive rules, mobile relocation rules, empty/error states, and interaction/accessibility rules

**Likely code:**

- `app/portfolio/[portfolioId]/[section]/page.tsx`
- `app/authenticated-workspace.ts`
- `app/owned-workspace.ts`
- `app/components/portfolio-shell.tsx`
- `app/globals.css`
- `db/repositories/projections.ts`
- `domain/calculations/holding.ts` and `domain/calculations/multi-currency.ts`
- `tests/ui-001.test.ts`, `tests/calc-001b.test.ts`, and `tests/rendered-html.test.mjs`

**Verification:**

- Add owner-scoped holdings read-model/render tests for mixed currencies, long names, missing price/FX/basis, exact zero quantity, deterministic missing-value sorting, and native/home display without mutating facts.
- Run `node --experimental-strip-types --test tests/ui-001.test.ts tests/calc-001b.test.ts tests/rendered-html.test.mjs`, `npm run build`, and keyboard sorting plus 320/390/430/desktop overflow QA.

- Deliver: dense sortable desktop table; mobile cards; native/home price-value menu for foreign holdings; quantity/basis/price/value/daily/gain columns; cash separation; row/FX explanation.
- Acceptance: sort missing values predictably; no horizontal dependency on mobile; compact views show `Price unavailable` when needed and generally suppress timestamps/source/fallback labels.
- Tests: mixed currencies, long names, missing data, zero quantity, keyboard sorting, responsive QA.
- Risks: too many mobile facts; prioritize market value and gain.
- Parallel safe: yes.
- Implementation evidence: Added an owner-scoped published-projection Holdings read model and authenticated route integration; exact-decimal native/home values, basis, daily movement, gain, cash separation, stable missing/stale/incomparable states, provenance explanations, deterministic sorting, desktop rows, mobile cards, and an accessible holding dialog. Independent code review passed after runtime regressions for ownership, missing data, weekend and trade-time comparability, price/FX evidence classes, durable security currency, fixed D1 bind/query budgets, and the 2,001-fact aggregate override ceiling. Task formatting, lint, typecheck, production build, and the 252-test repository suite pass.
- Browser QA evidence: authenticated owned Holdings fixture exercised at 320x800, 390x844, 430x932, and 1440x900. Document width equaled the viewport at every width; mobile cards and the desktop table retained readable value/gain hierarchy, and long security/portfolio names stayed bounded. Sort controls exposed the active direction and reordered rows; the holding dialog moved focus inside and restored focus to its opener on close. Native/home selection changed displayed USD/AUD values without mutating row facts. `Price unavailable`, `FX unavailable`, `stale market data`, and `comparison unavailable` were visible as non-color text. The Browser input layer focused controls but failed to synthesize Enter/Escape events, so direct key activation was not independently observable; semantic handlers and automated coverage remain in place.

### UI-004 — Compact quotes, refresh, and overrides

Status: DONE (2026-08-03).

- Objective: expose compact quote views and controlled refresh/correction workflows without calling EOD data live.
- Dependencies: UI-001, MKT-003B.
- Requirements: AUTH-004, MKT-003, MKT-005, MKT-006, MKT-008, QUAL-001.
- Files: Quotes route/components/actions/tests.
- Deliver: preferred observation, EOD/manual fallback, previous close/change, refresh state, manual price/FX override with reason/history; `Price unavailable` only when no usable price exists.
- Acceptance: active quotes prefer the approved source; compact quote/holding views generally suppress timestamps, source, delay, and fallback labels; state remains accessible in an explanation and inline status is reserved for action-required conditions; refresh is coalesced/rate-limited; overrides are reversible.
- Tests: fresh/stale/missing/partial, override ownership/validation, refresh retries, accessibility.
- Risks: refresh abuse/provider cost; optimistic UI lying about data time.
- Parallel safe: yes.
- Completion: Added compact quote state explanations, honest missing/stale/partial handling, owner-scoped no-store refresh and correction endpoints, durable coalesced refresh requests, reversible price/FX correction UI, and accessibility/regression coverage.
- Review findings: The authenticated portfolio route always renders Quotes with a null portfolio and `empty` state, so owner quote data never appears. The compact explanation only contains a generic business date and does not expose the selected source, timestamp, delay, scope, quality, or fallback reason; partial pricing is inferred from the last rendered row and changes when sorting. The correction dialog sends a display symbol even though the domain override selector uses a durable target key, so corrections may never apply to the intended quote, and server validation does not verify currencies/targets against canonical records. Refresh requests default idempotency to a per-request ID, accept arbitrarily large historical ranges, and have no post-completion rate limit, so repeated/concurrent requests can recreate provider work. The new mutation routes also do not enforce the documented Origin/Sec-Fetch same-origin checks. Add an owner-scoped quote read path, provenance-backed state and durable target mapping, canonical override validation, bounded/rate-limited refresh requests, mutation CSRF checks, and endpoint/concurrency/responsive regression coverage before marking this task done.
- Review resolution: Added the owner-scoped quote read model and provenance-backed per-security state; corrections now submit and validate canonical security/FX targets and currencies; browser mutations enforce same-origin metadata; UI refreshes are bounded to five days, deterministic under concurrency, and subject to a 15-minute post-completion cooldown. Behavioral integration tests cover quote loading, stable partial state, endpoint rejection, canonical corrections, concurrent refresh coalescing, and cooldown. Responsive quote actions/table/dialog were verified at 320, 390, 430, and 1,440 px with no horizontal overflow.

### UI-005A — Portfolio settings and ledger inspection

Status: DONE (2026-08-03).

- Objective: expose owned portfolio settings and read-only ledger/lot/cash provenance without combining them with financial write workflows.
- Dependencies: UI-001, LED-002B.
- Requirements: PRD-002, LED-001, LED-004, LED-005, QUAL-001.
- Files: Details/settings/ledger routes/components/actions/tests.
- Deliver: settings; transaction/lot/cash lists and explanations; links to the separate manual-entry/correction workflow.
- Acceptance: owner-scoped direct routes; exact decimals are formatted only at the edge; lists show useful business dates but generally suppress exact timestamps, which remain in detail/audit explanations; no mutable share/cost field bypasses ledger facts.
- Tests: empty/populated/incomplete states, cross-user routes/actions, keyboard/mobile.
- Risks: turning projections into editable truth or exposing an unscoped direct detail route.
- Parallel safe: yes with import UI after shared shell.
- Completion note: Added an owner-scoped read-only portfolio inspection model and authenticated Details view for settings, transactions, FIFO lots/matches, cash accounts/entries, exact-decimal edge formatting, business-date lists, expandable timestamp/provenance evidence, and a separate manual-entry/correction link.
- Review resolution: Cash balances now sum only posted entries, expose a stable unavailable reason when the exact bounded window is incomplete or invalid, and distinguish exactly-full from truncated windows with one-row lookahead. Database read failures render the safe unavailable state; transaction, lot, match, and cash reads remain owner-scoped and bounded; evidence summaries meet the 44px control target; bounded lists are labelled. Behavioral tests cover populated, empty, cross-owner, reversed-entry, exact-boundary, injected-read-failure, rendered read-only states, native disclosure semantics, and narrow-layout constraints. The separate manual-entry URL now authenticates and verifies portfolio ownership, then renders an explicit non-mutating unavailable state until UI-005E supplies the financial workflow, instead of returning a 404. The in-app browser rejected the generated local responsive fixture under its URL policy, so no browser screenshot claim is recorded; production CSS/layout and rendered semantic regression checks remain passing.

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

Status: DONE (2026-08-03).

- Objective: expose explicit, idempotent commit over an immutable reviewed preview and make its outcome inspectable.
- Dependencies: UI-005B, IMP-003A.
- Requirements: IMP-002, IMP-004, QUAL-001.
- Files: import commit/progress/history routes/components/actions/tests.
- Deliver: exact preview-version confirmation; commit action; resumable progress; original outcome on retry; batch/row/mapping history.
- Acceptance: a changed or stale preview cannot commit; repeated submission returns the original batch outcome; partial work is shown as resumable, never complete; history generally suppresses exact timestamps while retaining them in batch detail/audit evidence; no other owner’s batch is readable.
- Tests: supplied-file commit, stale preview, double submit, resume after bounded chunk failure, cross-user, keyboard/mobile.
- Risks: optimistic UI claiming completion before the durable commit marker.
- Parallel safe: no; this is a financial mutation workflow.
- Completion note: Added explicit reviewed-preview commit confirmation with stable idempotency and exact preview/version payloads, durable resumable-versus-committed progress states, and owner-scoped batch/row/mapping/audit history. History lists show business dates while detail evidence retains exact timestamps; private no-store routes and keyboard/mobile regressions are covered.
- Review resolution: Batch detail includes the exact reversal timestamp and now reads source rows, issues, mappings, and audit events through fixed 50-record owner-scoped pages with an explicit load-more contract. Reloaded `committing` batches show persisted physical-row high-water plus committed/skipped/remaining counts and resume with the stored idempotency key. Migrated-D1 service/endpoint tests cover bounded high-volume pages, cross-owner denial, invalid pages, and unavailable recovery; server-rendered component coverage verifies incomplete/resumable messaging and mobile-operable controls.

### UI-005D — Import reversal and corrected successor

Status: DONE (2026-08-04).

- Objective: make committed batch provenance and safe correction/reversal understandable.
- Dependencies: UI-005C, IMP-003B.
- Requirements: IMP-005, QUAL-001.
- Files: import history/detail/reversal routes/components/actions/tests.
- Deliver: batch/row/mapping history; exact impact confirmation; dependency-blocked state; reversal progress; corrected successor link.
- Acceptance: reversal cannot target another owner or hide dependent-fact conflicts; source evidence remains visible after reversal.
- Tests: clean/dependency-blocked/repeated reversal, corrected successor, cross-user, keyboard/mobile.
- Risks: destructive action ambiguity.
- Parallel safe: no; correction UI follows stable service behavior.
- Completion note: Added explicit owner-scoped reversal confirmation with resumable/idempotent progress, dependency-impact evidence, retained post-reversal source history, corrected-successor CSV staging, and existing-successor navigation. Focused UI rendering/history coverage and existing IMP-003B ownership, CSRF, dependency-block, repeat, and resume tests pass.

### UI-005E — Manual ledger entry and correction

Status: DONE (2026-08-03).

- Objective: expose the core manual trade/cash/split write path without mixing it into import or read-only projection screens.
- Dependencies: UI-005A, LED-001B, LED-002B.
- Requirements: LED-001, LED-002, LED-003, LED-004, LED-005, QUAL-001.
- Files: manual transaction/reversal routes, components, actions, and tests.
- Deliver: labelled forms for buy, sell, cash deposit/withdrawal, fee/tax, and explicit split; immutable submit result; impact preview; reversal/superseding replacement; missing-FX state. Transfers and dividends remain unavailable.
- Acceptance: every action uses the authenticated portfolio context and a server-issued idempotency key; exact decimals are revalidated server-side; split ratio is positive; business dates remain visible while exact timestamps are generally confined to detail/audit evidence; a correction never updates the original fact; unsupported transfer/dividend types reject.
- Tests: each supported type, invalid decimal/ratio/date, missing FX, double submit, reversal/replacement, oversell, cross-user and cross-portfolio denial, keyboard/mobile.
- Risks: a convenient form bypassing the single ledger service or implying incomplete FX is zero.
- Parallel safe: no; financial mutation UI follows the stable ledger service.
- Completion note: Added authenticated, owner-scoped manual ledger forms and same-origin post/reverse/supersede routes for buy, sell, cash, fee, tax, and split facts. Server-side parsing, exact impact preview, explicit missing-FX state, and immutable correction evidence are implemented.
- Review resolution: Removed the 200-lot projection precheck. The shared ledger repository now streams up to 6,000 chronological security events in fixed 500-row pages within the D1 invocation query budget, evaluates exact buy/sell/split quantity, and places an owner/portfolio/security count-and-version assertion in the same D1 batch as every security post, reversal, or supersession. Concurrent mutations retry from fresh evidence and oversells leave no partial write. Manual create/reverse/supersede routes now require persisted server-issued keys bound to owner, portfolio, purpose, and exact target; the client retains each operation key across network failures, and forged/missing/cross-target keys reject. Migrated-D1 integration tests cover more than 200 lots, simultaneous sells, authenticated route results, ownership hiding, CSRF, identical retry, durable reversal/replacement evidence, key rejection, and rendered keyboard/mobile semantics.

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

### FY-001A — Financial-year domain model and settings schema

Status: DONE (2026-08-13); owner-requested feature (2026-08-13). Owner decisions recorded: configurable start month only (1–12, day always the 1st), default July (Australian FY); per-user setting in `user_settings` (no per-portfolio override); the user's `user_settings.timezone` decides where the FY boundary falls everywhere, including aggregate views; "FY" means FY-to-date (mirrors YTD), "Last FY" is a closed historical window; an FY is named by its ending year per Australian convention (Jul 2025–Jun 2026 = "FY26").

- Objective: introduce a validated `financial_year_start_month` user setting and pure domain functions that turn (today, start month, timezone) into FY windows and labels, as the single source of FY truth for every consumer.
- Dependencies: DB-001A (user_settings), UI-002 (overview history exists as first consumer).
- Requirements: new — add an `FY-001` requirement with acceptance criteria to `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` in this change set; update `docs/DATA_MODEL.md` (user_settings) and `docs/CALCULATIONS.md` (FY window/label rules).
- Deliver: `user_settings.financial_year_start_month` integer column (CHECK 1–12, default 7) via a generated Drizzle migration; pure domain module (e.g. `domain/calculations/financial-year.ts`): `currentFyWindow`, `lastFyWindow`, `fyLabel` — all boundary math in the user's IANA timezone with date-string outputs (no binary-float, no Date-arithmetic-across-DST bugs); repository read path exposing the setting alongside the existing settings fields.
- Acceptance: with default July and timezone Australia/Sydney on 2026-08-13, current FY = 2026-07-01 → today ("FY27"), last FY = 2025-07-01 → 2026-06-30 ("FY26"); a January start month yields calendar years; boundary instants respect the timezone (Jun 30 23:59 Sydney is last FY, Jul 1 00:00 is current); invalid months are rejected at the boundary; existing users default to 7 with no data rewrite.
- Tests: month boundaries in ±UTC offsets and across DST, January start, label ending-year convention, migration apply + CHECK rejection, settings read path.
- Risks: naive UTC date math shifting the boundary by a day; migration touching a table every request path reads.
- Parallel safe: yes; FY-001B and FY-001C both depend only on this.
- Completion note (2026-08-13): Delivered `user_settings.financial_year_start_month` (CHECK 1–12, DEFAULT 7) via `drizzle/0029_bouncy_virginia_dare.sql` — hand-edited twice with documented reasons: the generated copy-INSERT selected the not-yet-existing column, and the drizzle table rebuild silently DROPPED the three `account_purge_lock_user_settings_*` triggers from 0028 (caught by Orchestrator verification after the worker misclassified the resulting ops-003b failure as pre-existing; triggers re-appended verbatim and behaviourally re-verified). `domain/calculations/financial-year.ts` (`currentFyWindow`/`lastFyWindow`/`fyLabel`/`isValidFinancialYearStartMonth`) uses Intl-based local-date derivation (pattern from `domain/snapshots/history.ts`); labels by ending year ("FY27" current on 2026-08-13, Sydney). Read path exposes the field in all three settings SQL statements in `db/repositories/owned-portfolios.ts`. Docs: FY-001 requirement added, DATA_MODEL user_settings updated, CALCULATIONS §9 added (§§10–13 renumbered, no cross-references existed). `tests/fy-001a.test.ts` 12 tests. Review PASS with independent incremental-migration, trigger-behaviour, and timezone-edge verification (Lord Howe 30-min offset, Kiritimati UTC+14, leap-year end, DST transitions). `npm run check` exit 0 (349 pass, 10 gated skips). Follow-ups noted for FY-001B/C: tighten `localDateAt`'s lenient `Date.parse` before user-influenced values reach it; `fyLabel` yields "FYaN" on malformed hand-built windows; add a sqlite_master purge-lock trigger-inventory assertion to guard future drizzle table rebuilds.

### FY-001B — Financial-year settings control

Status: DONE (2026-08-13).

- Objective: let the owner change the FY start month from the settings surface.
- Dependencies: FY-001A, UI-005A (settings surface), AUTH-004 (CSRF conventions).
- Requirements: FY-001 (added in FY-001A); QA-001B accessibility standards; QA-001A matrix row for the new route.
- Deliver: version-guarded `POST /api/settings/financial-year` mutation following the existing `/api/settings/home-currency` pattern (CSRF-first, owner-scoped, `expectedVersion`); a labelled month select in the settings UI defaulting to July, with helper text naming the resulting window (e.g. "July: FY runs 1 Jul – 30 Jun"); offline-disabled like other settings mutations.
- Acceptance: changing the month persists, bumps the settings version, and immediately changes FY windows app-wide; stale-version and cross-site mutations are rejected; the control is keyboard-operable and labelled; no client-supplied user ID.
- Tests: happy path, stale version, CSRF denial, cross-user denial, invalid month, settings-UI render.
- Risks: none beyond the shared settings-version race already handled by the existing pattern.
- Parallel safe: yes with FY-001C after FY-001A.
- Completion note (2026-08-13): Delivered `POST /api/settings/financial-year` (CSRF literally first, owner-scoped, expectedVersion) → `changeFinancialYearStartMonthAction` → `setFinancialYearStartMonth` (version-guarded UPDATE + audit in one batch, mirroring `setHoldingCurrencyView`); labelled month select in the settings popover with helper text, aria-describedby, offline/pending-disabled, 44px target; QA-001A matrix row (28 handlers, reviewer-recounted). Folded-in FY-001A follow-up: `localDateAt` tightened to a strict ISO contract (rejects rollover dates, non-ISO formats, offset-less datetimes). No coercion on input validation (numeric strings rejected). `tests/fy-001b.test.ts` + 4 new fy-001a tests; review PASS with independent D1-equivalent probes (concurrent-bump conflict, forced CHECK, audit atomicity). `npm run check` exit 0 (360 pass, 10 gated skips). Follow-ups: audit-row-on-rejected-mutation pattern defect recorded as DB-006 (pre-existing, replicated across all three settings mutations); helper-span-inside-label double announcement folded into FY-001C's touch of the shell.

### DB-006 — Settings audit rows written on rejected mutations

Status: DONE (2026-08-13); pre-existing pattern defect found by FY-001B review (2026-08-13), affected all three `user_settings` mutations in `db/repositories/owned-portfolios.ts`.

- Problem: each settings mutation batches its audit INSERT guarded by `EXISTS (... version = expectedVersion + 1)`. After a concurrent bump, a stale retry's UPDATE changes nothing (`version_conflict`) but the guard is satisfied by the concurrent writer's row, so a spurious audit event is recorded (reproduced: two audit rows for one applied change). Affects home-currency, holding-currency-view, and financial-year mutations.
- Fix direction: tie the audit insert to the actual row change (e.g. guard on the UPDATE's own effect via `changes()`-equivalent D1-compatible predicate, or insert the audit row conditioned on the pre-state `version = expectedVersion` like the QA-003 guard pattern) — audit rows must record only mutations that occurred.
- Acceptance: stale-version retry produces zero new audit rows; applied change produces exactly one; behavior covered for all three settings mutations; D1-compatible (no BEGIN/COMMIT).
- Tests: extend `tests/fy-001b.test.ts`/existing settings tests with concurrent-bump audit-count assertions for all three mutations.
- Completion note (2026-08-13): All three settings mutations restructured to the sound pre-state pattern — audit INSERT first guarded by `EXISTS (... user_id=? AND version = expectedVersion)`, version-bumping UPDATE ... RETURNING last in the same batch, result read from the last row. Reviewer independently reproduced the old spurious-audit bug against the new assertions (sensitivity check: reconstructing the old composition fails the new tests) and verified version_conflict/not_found discrimination is preserved. 4 new tests in `tests/fy-001b.test.ts`. `npm run check` exit 0 (390 pass, 10 gated skips). Review PASS; the same unsound guard was found in portfolio rename/archive/restore → split out as DB-007.

### DB-007 — Portfolio lifecycle audit rows written on rejected mutations

Status: DONE (2026-08-13); same pattern defect as DB-006, found by DB-006 review (2026-08-13) in `createOwnedPortfolioRepository`.

- Problem: `portfolio.rename` (`db/repositories/owned-portfolios.ts:361`), `portfolio.archive` (`:402`), `portfolio.restore` (`:443`) order the audit INSERT after the UPDATE with post-state guards `conditionParams: [portfolioId, userId, expectedVersion + 1]` — a concurrent writer's bump satisfies the guard, so a stale retry that no-ops with `version_conflict` still records an audit event for a lifecycle change that never happened (e.g. a `portfolio.archive` audit row with no archive).
- Fix: apply DB-006's construction identically — audit INSERT first with pre-state guard (`version = expectedVersion`), version-bumping UPDATE ... RETURNING last, result from the last row; preserve the version_conflict/not_found contract; portfolios table analogue of the settings fix.
- Acceptance: stale retry after a concurrent bump → zero new audit rows for all three lifecycle mutations; applied change → exactly one; contracts unchanged.
- Tests: concurrent-bump audit-count assertions for rename/archive/restore (extend `tests/db-001b.test.ts` or wherever lifecycle mutations are tested).
- Completion note (2026-08-13): rename/archive/restore restructured to DB-006's pre-state construction (audit INSERT first guarded on `version = expectedVersion`, UPDATE ... RETURNING last); archive confirmed to have no status precondition today (re-archive at current version still succeeds, tested). `create` verified race-free and untouched. Reviewer independently reproduced the HEAD defect (stale retry audit rows for all three) and ran the new tests against HEAD via an import shim (all 4 fail there — genuinely pinning). 4 new tests in `tests/db-001b.test.ts`. `npm run check` exit 0 (394 pass, 10 gated skips). Review PASS.

### FY-001C — FY and Last FY chart periods

Status: DONE (2026-08-13).

- Objective: add "FY" (FY-to-date) and "Last FY" (closed window) to the chart period selectors, wired to real data where real data exists.
- Dependencies: FY-001A; FY-001B is NOT required (default July works without the control).
- Requirements: FY-001; QA-001B (44px targets, flex-wrap at 320px, non-color status); `docs/CALCULATIONS.md` FY rules.
- Deliver (also fold in from FY-001B review: move the `fy-start-month-helper` span outside its wrapping label in `portfolio-shell.tsx` to stop the double screen-reader announcement); Overview history chart range set becomes `1M / 3M / 12M / FY / Last FY / All` filtering the real history series by the FY windows from FY-001A; Details prototype period tabs gain `FY` and `Last FY` (after YTD) with the same semantics documented — noting the Details chart remains a static prototype until real details history lands, so the new tabs there change labels/copy only and must not fabricate data; period eyebrow/tooltip shows the resolved window and label ("FY27 · 1 Jul 2026 – today", "FY26 · 1 Jul 2025 – 30 Jun 2026").
- Acceptance: "FY" filters from the FY start date to the latest point; "Last FY" is bounded on both ends and its gain/loss delta reads as change across that window, not change-to-today; an FY window with no history points shows the explicit empty/missing-data state, never zero; tab labels stay "FY"/"Last FY" with full window in the eyebrow; selectors stay within QA-001B touch-target and 320px-wrap standards; a changed start month re-derives windows without reload artifacts.
- Tests: window filtering at boundary dates, Last FY closed-window delta, empty-window state, tab accessibility (aria-pressed, labels), 320px wrap regression in `tests/qa-001b.test.ts` if tab count affects it.
- Risks: implying the prototype Details chart is live; delta semantics for a closed window diverging between charts.
- Parallel safe: yes with FY-001B.
- Completion note (2026-08-13): Overview chart ranges now `1M/3M/12M/FY/Last FY/All` via new pure helpers in `app/overview-fy-range.ts`; FY windows anchored on a per-request server-resolved `nowInstant` threaded through `loadAuthenticatedWorkspace` → props (never the latest history point, never a client clock — empty instant fails closed to the empty-range state); FY/Last FY eyebrows show resolved labels/windows; Last FY delta = change across the closed window with decimal-string arithmetic, single-point windows show "Change unavailable" (never 0.00), zero renders neutral; Details prototype tabs gained FY/Last FY labels only; fy-start-month-helper double-announcement fixed (htmlFor/id). Review round 1 FAIL (B1 stale-history mislabelled the FY and made real Last FY unreachable; B2 bare-date anchor broke negative-offset timezones; B3 single-point windows fabricated AUD 0.00) — all fixed and reviewer-reproduced in round 2 PASS, including America/New_York boundary instants both sides of the FY flip. `tests/fy-001c.test.ts` 26 tests incl. stale-history end-to-end and B2 regression; CALCULATIONS §9 "What resolves 'today'" paragraph. `npm run check` exit 0 (386 pass, 10 gated skips). Non-blocking follow-ups noted: reword the `filterToFyToDateWindow` doc comment that still echoes the B1 rationale; timezone-skew note if per-portfolio FY consumers are added; pin the empty-instant path with a behavioural test.

### UI-006A — Income screen: next-12-months landing and multi-year view

Status: DONE (2026-08-13). Owner decisions recorded 2026-08-13 (see DIV-003 for calculation decisions).

- Objective: a dedicated Income tab for the current portfolio, landing on the next-12-months projection with retirement-planning statistics, with navigation to the multi-year FY view.
- Dependencies: DIV-003, FY-001A, UI-001 (shell/tabs), QA-001B standards.
- Requirements: DIV-003 requirement; QA-001A matrix rows for any new route; QA-001B accessibility.
- Deliver: new top-level Income route/tab (owner-scoped, no-store, server-rendered data via DIV-003); landing view = next 12 months: grossed-up total ("includes franking credits" label), franking amount, cash amount, average per month, average per week, income % of portfolio value, coverage/provenance disclosure; multi-year view = one row per FY showing year label, portfolio value (projected years use the value-growth assumption and say so), gross dividend amount, effective %, source/method label; range configurable up to 10 FYs back and 10 forward, default 2 back / 4 forward; past rows use the DIV-003 precedence (override > receipts > provider) with source shown; what-if controls at the bottom of the multi-year view for portfolio growth % and dividend growth % that recompute the table immediately, are clearly marked as unsaved exploration, and never persist; entry point to the assumptions editor (UI-006B).
- Acceptance: landing is the next-12-months view for the selected portfolio; every projected figure is visually distinguished from actuals and labelled with its assumptions; empty/insufficient states are explicit (a portfolio with no dividend data explains what to add, never shows $0 income as fact); what-if changes survive no navigation and write nothing; keyboard-operable controls, 44px targets, non-color status distinctions, 320px layout without horizontal scroll.
- Tests: route ownership/CSRF-irrelevance (read-only), rendered landing and multi-year states (populated/partial/empty), what-if non-persistence, range configuration bounds, accessibility assertions in the QA-001B suite pattern.
- Risks: projected figures being read as promises — labels and visual distinction are load-bearing; table density at 320px (10+ rows × 4 columns needs the established wrap/scroll-container patterns).
- Parallel safe: yes with UI-006B after DIV-003.
- Completion note (2026-08-13): New standalone owned-mode routes `/portfolio/:id/income` (landing, minimal-range load) and `/portfolio/:id/income/multi-year` (searchParams range, clamped via `app/income-year-range.ts`), Income tab in the shell (owned-mode only), client components `income-landing`/`income-multi-year` in the app's visual language (no rounded corners, no sliders). Landing: grossed headline with permanent estimate/franking label, cash·franking subtitle, Explain pop-up, dense metric rows, coverage link to the assumptions path. Multi-year: FY table with actual/estimate/projected/fy-to-date sources, tappable row details, ONE assumption line derived from the ACTIVE projection (what-if aware with per-figure "(what-if)" suffixes), "· partial" value markers plus a partial-base summary sentence, degraded typed states rendered as banners, what-if number inputs (client-side via the pure projection module — structurally unpersistable; applied marker cleared on edit), range selects at the bottom. Review rounds: 1 FAIL (stale assumption line after Apply; partial value invisible on the table surface) → 2 FAIL (route-count methodology mislabelled in the QA-001A matrix; plus the reviewer flagged a `.claude/settings.json` diff that turned out to be the owner's own permission edit — never staged) → doc fix per reviewer-settled numbers (25 API route paths exposing 28 exported handlers + 7 pages; vinext check's "30" documented as a filename over-count; prior addendum retraction reversed). `tests/ui-006a.test.ts` 20+ tests incl. behavioural clamp and real what-if recompute. `npm run check` exit 0 (586 pass, 10 gated skips). Follow-ups noted: no back-navigation from income screens in populated states (PWA standalone dead end — pattern shared with app/import); row detail opens from the year-label button (a11y-preferable deviation).
- Wireframe decisions (owner review 2026-08-13, wireframes iterated to approval): app visual language throughout — dark tokens, thin dividers, underline tabs, uppercase micro-labels, tabular numerals, no rounded corners, no sliders. Landing: grossed headline with cash/franking as the subtitle line ("Cash A$x · Franking credits A$y"), NO method/explanation sentence; a compact "Explain this estimate" link opening a pop-up; stats as dense metric-list rows (per month, per week, % of value, coverage); the coverage row ("21 of 23") is a link into the assumptions editor with no threshold/warning state. Multi-year: compact lower-case source labels — actual / estimate / projected; tapping any row opens its detail (receipts list, typed override, or projection inputs) and past rows additionally offer "Override this FY"; one assumption summary line under the table where yield means TOTAL yield including franking; what-if is two plain number inputs (portfolio growth %, dividend growth %) with Apply/Reset and only a compact "applied, not saved" marker (no warning sentence); the range controls (years back / years forward selects) sit at the BOTTOM under the growth inputs. Mobile: metric list stacks; multi-year table horizontal-scrolls inside its container.

### UI-006B — Dividend assumptions editor and manual receipt entry

Status: READY (all dependencies incl. DIV-004 done 2026-08-13). Owner decisions recorded 2026-08-13.

- Objective: the editing surfaces for the income modeller: the portfolio-scoped assumptions grid and the manual actual-receipt/FY-override forms.
- Dependencies: DIV-003 (resolution semantics), DIV-001 (receipt service), DB-005 (tables), AUTH-004 (CSRF), UI-006A (screen to host the entry point).
- Requirements: DIV-003 requirement; QA-001A matrix rows for each new mutation route; QA-001B accessibility.
- Deliver: assumptions editor reached from the Income screen (portfolio-scoped, not per-security navigation): a list/grid with one row per held security showing provider-derived dividend yield % and franking % (or explicit `unavailable`) read-only, alongside editable owner columns — dividend yield %, franking %, dividend growth % (blank = use provider value); a portfolio-level row for value growth % and portfolio dividend growth %; version-guarded, CSRF-first save of the whole grid; manual actual-receipt entry form (security, payment date, cash amount, franking credits, withholding — decimal strings, validated) posting through DIV-001's service; past-FY income override entry (FY, grossed amount, franking amount) with clear precedence explanation ("overrides receipts and provider history for this FY's display"); all mutations owner-scoped with `expectedVersion`.
- Acceptance: provider values are never silently overwritten — owner entries live in separate columns and blanking an owner cell restores the provider fallback; saving the grid changes projections immediately; receipts post real ledger-side records (DIV-001 rules) and are visible in past-FY rows per precedence; invalid percentages/amounts are rejected at the boundary with specific messages; the grid is keyboard-navigable with labelled cells and works at 320px via the established responsive table patterns.
- Tests: grid save happy path/stale version/CSRF/cross-user denial, blank-cell fallback resolution, receipt entry validation and posting, FY override precedence effect, rendered accessibility assertions.
- Risks: a wide editable grid on mobile — needs the card-per-security fallback pattern rather than a squeezed table; percentage-entry ambiguity (4 vs 0.04) — pin the unit in labels and validation.
- Parallel safe: yes with UI-006A after DIV-003.
- Wireframe decisions (owner review 2026-08-13): provider-franking column STAYS as an honest always-"unavail." seam for a future source. Whole-portfolio inputs (value growth %, dividend growth %) sit BELOW the grid, separated by a divider and gap, not as a grid row. Entry-point rules: the "+ Record dividend received" and "+ Override a past FY" buttons live only in the assumptions editor, NOT on the main income screens; the FY override is additionally reachable by tapping a past FY row in the multi-year view; "Record dividend received" is additionally reachable from security views elsewhere in the app (per-holding context). Receipt form is cash-only — NO DRP support in v1. FY override fields stay gross + franking (cash derived). Mobile assumptions list simply scrolls — no filter box, no payer-first reordering.
- Dividend-form revision (owner review 2026-08-13, second round): the record/override form is PER-SHARE — fields are security, payment date, shares held at that date (auto-populated from holdings as of that date, editable), dividend per share, franking credit per share; computed cash/franking totals shown live; the same form records a manual dividend and overrides an auto-populated one (pre-filled when opened from a history row), with an "Exclude this dividend" action and the double-count proximity warning from DIV-001's model.

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

Status: DONE (2026-08-10).

- Objective: stop access immediately and produce a complete, owner-scoped export/deletion manifest without deleting data.
- Dependencies: AUTH-002, OPS-001, IMP-003B, MKT-003B, CALC-002.
- Requirements: AUTH-005, OPS-004.
- Files: lifecycle/export services, policy/runbook, UI/actions, integration tests.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `AUTH-005 — Account lifecycle`, `AUTH-003 — Per-user authorization`, and `OPS-004 — Data retention and deletion`
- `docs/ARCHITECTURE.md` — `Identity rules`, `Tenant isolation pattern`, and `Operational design` → `Retention`
- `docs/DATA_MODEL.md` — `Identity and ownership`, owner-scoped observation fields in `Prices, FX, corporate actions, and fundamentals`, and `Deletion behavior`
- `docs/CONSOLIDATED_PRODUCT_SPEC.md` — disabled/deleting-account state in `Product state contract`

**Likely code:**

- `domain/auth/identity-lifecycle.ts` and `domain/auth/request-context.ts`
- `db/schema.ts`
- `db/repositories/identity.ts`, `db/repositories/audit.ts`, and the owner-scoped repositories under `db/repositories/`
- `app/authenticated-workspace.ts`, `app/portfolio-actions.ts`, and `app/components/portfolio-shell.tsx`
- `tests/auth-002.test.ts`, `tests/ops-001.test.ts`, and `tests/db-schema.test.ts`

**Verification:**

- Add a schema-derived export-manifest completeness test so every owned table and user-scoped observation is either exported or explicitly classified; include disabled-session, repeat-request, redaction, and cross-owner fixtures.
- Run `node --experimental-strip-types --test tests/auth-002.test.ts tests/ops-001.test.ts tests/db-schema.test.ts`, `npm run build`, and an export drill against synthetic non-production owner data only.

- Deliver: disable/session revocation; immutable deletion request; owned ledger/import/market/projection export; exact row/object manifest and retention classifications.
- Acceptance: a disabled user cannot authenticate; export and manifest cover every owned table/access-scoped observation without including another user; no purge occurs in this task.
- Tests: disable/session, export completeness/counts, repeated request, cross-user exclusion, redaction.
- Risks: an incomplete manifest would make later deletion unverifiable.
- Parallel safe: no; it defines the purge input.
- Escalation handoff (2026-08-09): Four normal-worker implementation/revision passes and independent review resolved whole-export assembly, owner-path coverage, revoked retries, lifecycle-state distinction, checkpoint atomicity, SHA-256 integrity, oversized-row fragmentation, cursor pagination, and migration-trigger justification. Remaining blockers are bounded/resumable final manifest hashing; a stable operational audit high-water; consistent exact-key recovery authorization; complete empty/disabled-account processing and multipart delivery UI; ambiguous-network idempotency; unexpected-failure job/audit semantics; representative financial/API/UI/security fixtures; and a synthetic D1 export drill. The configured `escalation-worker` accepted this handoff after its runtime configuration was restored.
- Completion note (2026-08-10): Implemented immediate disable/session revocation, immutable and idempotent lifecycle requests, exact-key revoked-principal recovery, and owner-scoped export jobs with bounded capture, oversized-row fragmentation, guarded resumable checkpoints, SHA-256 manifests, 35-day expiry, access auditing, and server-cursor multipart delivery. The active, empty, disabled, and deletion-pending UI paths automatically advance bounded work and traverse every download part. Representative ledger, import, market, calculation, projection, redaction, mutation-race, failure, authorization, and cross-owner fixtures pass; no purge, new dependency, binding, or Cloudflare product was added. A loopback-enabled Miniflare drill applied the migration chain to synthetic D1 data and completed/traversed the export without mutating source rows. Final independent review accepted the escalated result with no blockers or follow-up work.

### OPS-003B — Retention and verified deletion

Status: DONE (2026-08-10).

- Objective: apply approved retention rules and execute an idempotent, auditable purge from the exact OPS-003A manifest.
- Dependencies: OPS-003A, OPS-002.
- Requirements: OPS-004.
- Files: purge jobs/services, policy/runbook, confirmation UI/actions, integration tests.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `OPS-004 — Data retention and deletion`, `AUTH-004 — Mutation protection`, and `AUTH-005 — Account lifecycle`
- `docs/ARCHITECTURE.md` — `CSRF and browser security`, `Operational design` → `Recovery` and `Retention`, plus `Threat summary`
- `docs/DATA_MODEL.md` — `Deletion behavior`, `Transaction boundaries and invariants`, and owner relationships in `Relationship map`
- `docs/OPS-002_BACKUP_RESTORE_RUNBOOK.md` — recovery evidence and non-production restore discipline relevant to the purge disclosure

**Likely code:**

- `db/schema.ts`
- `db/repositories/sql-client.ts`, `db/repositories/identity.ts`, `db/repositories/audit.ts`, and the owner-scoped repositories under `db/repositories/`
- `domain/auth/identity-lifecycle.ts` and `domain/auth/request-context.ts`
- `app/mutation-request.ts`, `app/portfolio-actions.ts`, and `app/components/portfolio-shell.tsx`
- `worker/scheduled-refresh.ts` (bounded durable-job pattern only)
- `tests/auth-002.test.ts`, `tests/ops-001.test.ts`, `tests/ops-002.test.ts`, and `tests/db-schema.test.ts`

**Verification:**

- Add task-scoped purge tests for exact manifest resolution, foreign-key ordering, bounded failure/resume, idempotent repeat, audit tombstone, provider/user-scoped observation removal, CSRF/confirmation, and byte-for-byte preservation of another owner’s fixture rows.
- Run `node --experimental-strip-types --test tests/auth-002.test.ts tests/ops-001.test.ts tests/ops-002.test.ts tests/db-schema.test.ts`, `npm run build`, and a recoverability/deletion drill only against an isolated synthetic non-production database.

- Deliver: cooling-off/confirmation; deletion-pending state; bounded purge in foreign-key order; user-scoped market-data purge; permitted audit tombstone; completion proof.
- Acceptance: every manifest target is gone, retained audit data matches the documented minimum, a repeated or resumed purge is safe, restore policy is explicit, and other owners are byte-for-byte unaffected in fixtures.
- Tests: target resolution, partial-failure resume, FK order, provider purge, repeat, cross-user preservation, restore-policy interaction.
- Risks: irreversible deletion; require exact target resolution and recoverability disclosure.
- Parallel safe: no; destructive cross-domain path.
- Completion note (2026-08-10): Implemented exact deletion-request/export binding, a 24-hour cooling-off period with typed confirmation, and a durable D1 purge state machine with guarded bounded validation, FK-ordered deletion, verification, artifact cleanup, and completion proof. Database-enforced source locks prevent owner reassignment or mutation after validation starts; retained data is limited to the exact deletion intent, redacted identity/user tombstones, purge proof, and one payload-free audit while shared mappings and every other owner's rows remain unchanged. The isolated Miniflare/D1 drill passed 14/14, the full automated suite passed, and fresh independent review accepted the escalated result with no blockers or follow-up work.

### QA-001A — Security and tenant-isolation hardening

Status: DONE (2026-08-10).

- Objective: systematically attempt tenant escape, authentication bypass, unsafe mutation, and private-cache leakage before release.
- Dependencies: AUTH-002, UI-001, UI-002, UI-003, UI-004, UI-005A, UI-005B, UI-005C, UI-005D, UI-005E, PWA-001.
- Requirements: PRD-001, AUTH-003, AUTH-004.
- Files: security test suites, threat review, remediation files.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `AUTH-001 — Cloudflare Access boundary`, `AUTH-003 — Per-user authorization`, `AUTH-004 — Mutation protection`, and `PLAT-002 — PWA foundation`
- `docs/ARCHITECTURE.md` — `Request and authorization flow`, `CSRF and browser security`, `Tenant isolation pattern`, `PWA and offline architecture`, and `Threat summary`
- `docs/IMPLEMENTATION_PLAN.md` — `Security implementation checklist` and `Testing strategy` → integration and route/render coverage
- `docs/CONSOLIDATED_PRODUCT_SPEC.md` — authorization/offline states in `Product state contract`

**Likely code:**

- `worker/index.ts` and `worker/response-security.ts`
- `domain/auth/` and `domain/observability/`
- `db/repositories/`
- `app/api/`, `app/mutation-request.ts`, and authenticated actions under `app/`
- `public/sw.js`
- `tests/access-jwt.test.ts`, `tests/auth-002.test.ts`, `tests/security-headers.test.ts`, `tests/ops-001.test.ts`, and the `tests/ui-*.test.ts` route/action suites

**Verification:**

- Build an explicit route/repository/destructive-action matrix and link every owned operation to unauthenticated, cross-owner, CSRF/replay where applicable, private-cache, and redacted-error evidence.
- Run `npm run check`; separately inspect service-worker cache allow/deny behavior, built client assets for secrets/private fixture leakage, and dependency audit findings. No high-severity finding may remain open.

- Deliver: route/repository cross-tenant matrix; Access-token failure matrix; CSRF/header/CSP review; dependency audit; private-cache and redacted-error audit.
- Acceptance: no high-severity open finding; every owned read/write and destructive action has a denial test; no protected response enters Cache Storage.
- Tests: automated security/isolation suite plus focused manual threat checklist.
- Risks: an endpoint or background path omitted from the ownership matrix.
- Parallel safe: review can start per completed slice; final gate is serial.
- Completion note (2026-08-10): Delivered `docs/QA-001A_SECURITY_MATRIX.md` covering all 24 API route handlers, 5 pages, the repository layer, and the scheduled-refresh background path, with denial-test evidence, Access-token failure matrix, CSRF/header/CSP review, dependency audit, private-cache and redacted-error audits, and the manual threat checklist. Findings: F1 (High, fixed) — 7 mutation routes lacked the AUTH-004 CSRF gate, now gated with functional/order tests in `tests/qa-001a.test.ts`; F2 (informational) — export-job authorization breadth verified non-exploitable via owner-scoped queries; F3 (High, accepted) — 16 `npm audit` high advisories confined to the dev/build toolchain, absent from the Workers bundle, dispositioned via follow-up DEP-001; F4 (High, fixed) — root `/` page served private data with no `cache-control` header, `isPrivateRequest` now covers `/` with a header test. Added a cross-owner restore denial test in `tests/db-001b.test.ts` and `.prettierignore` entries for agent-tooling config. Three review rounds; final independent review PASS; `npm run check` exit 0 (280 tests pass, 2 env-gated skips).

### DEP-001 — Dev/build toolchain dependency upgrades

Status: DONE (2026-08-10).

- Objective: resolve the high-severity `npm audit` advisories accepted during QA-001A by upgrading the dev/build toolchain (`next`, `vite`, `wrangler`/`miniflare`/`undici`/`ws`) with Cloudflare-runtime verification.
- Dependencies: QA-001A.
- Requirements: QUAL-002.
- Files: `package.json`, `package-lock.json`, affected build/worker configuration only if required by the upgrades.

**Context:**

- `docs/QA-001A_SECURITY_MATRIX.md` — §4 dependency audit and finding QA-001A-F3 (risk acceptance and advisory inventory)
- `AGENTS.md` — dependency rules (documented need, exact version, lockfile update, Cloudflare-runtime verification)

**Verification:**

- `npm audit` after upgrade shows no high-severity advisory, or each remaining advisory is documented with justification.
- `npm run check` passes; `npm run build` and the preview harness confirm Cloudflare-runtime behavior is unchanged.

- Deliver: upgraded lockfile/toolchain; refreshed audit result; updated risk-acceptance note in `docs/QA-001A_SECURITY_MATRIX.md`.
- Acceptance: no undispositioned high-severity advisory remains; full quality gate passes on the upgraded toolchain.
- Risks: build-toolchain majors changing Worker output; verify runtime behavior, not just compile success.
- Parallel safe: no; touches shared build configuration.
- Completion note (2026-08-10): Upgraded next 16.2.6→16.3.0, react/react-dom/react-server-dom-webpack 19.2.6→19.2.8, vite 8.0.13→8.2.1, @cloudflare/vite-plugin 1.37.1→1.51.1, wrangler 4.92.0→4.120.0 (all direct bumps non-major; wrangler transitively moved miniflare to 5.20260801.1-alpha and workerd to 1.20260801.1, validated by 27/27 Miniflare-backed D1 drill tests). `npm audit` dropped from 21 (16 high) to 6 (4 moderate, 2 high); the sole remaining high root cause is `image-size@2.0.2` (no fixed upstream release, two GHSAs, build-time-only reachability, absent from the deployed bundle) with explicit risk acceptance in `docs/QA-001A_SECURITY_MATRIX.md` §4; the 4 moderates are the pre-existing esbuild/drizzle-kit chain, documented out of scope. Added an exact `miniflare` devDependency pin (drill tests import it directly), accommodated the generated `migrations_dir` field in `tests/runtime-config.test.ts` (inert; migrations apply via `wrangler d1 execute`), and refreshed matrix §4/§8. Two review rounds; final independent review PASS; `npm run check` exit 0 (290 pass, 2 env-gated skips).

### QA-001B — Accessibility and responsive hardening

Status: DONE (2026-08-10).

- Objective: verify the completed core flows at keyboard, screen-reader, reduced-motion, high-zoom, iPhone, and narrow desktop boundaries.
- Dependencies: UI-001, UI-002, UI-003, UI-004, UI-005A, UI-005B, UI-005C, UI-005D, UI-005E, PWA-001.
- Requirements: PRD-004, QUAL-001.
- Files: accessibility/responsive test suites, audit checklist, remediation files.

**Context:**

- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `PRD-004 — Responsive application shell` and `QUAL-001 — Accessibility`
- `docs/CONSOLIDATED_PRODUCT_SPEC.md` — `Responsive behavior` and `Product state contract`
- `docs/UI_SPEC.md` — responsive rules, mobile relocation rules, empty/error states, and interaction/accessibility rules
- `docs/IMPLEMENTATION_PLAN.md` — `Testing strategy` → route/render and end-to-end/UAT

**Likely code:**

- `app/components/portfolio-shell.tsx`, `app/components/portfolio-details.tsx`, `app/components/import-review.tsx`, `app/components/import-history-detail.tsx`, and `app/components/manual-ledger-entry.tsx`
- `app/globals.css`
- `app/portfolio/` and `app/import/`
- `tests/ui-*.test.ts` and `tests/rendered-html.test.mjs`
- `docs/ui-captures/` (existing responsive evidence pattern)

**Verification:**

- Run `npm run check` plus automated semantic/name/role/state/contrast checks added by this task.
- Complete and record keyboard-only core flows, VoiceOver, reduced-motion, 200% zoom, and 320/390/430/desktop checks; verify no document overflow, visible focus, 44 px targets, chart text alternatives, and non-color status meaning.

- Deliver: semantic/name/role/state audit; focus order and visible focus; chart/table alternatives; contrast/reduced-motion; 320 px/iPhone layout audit.
- Acceptance: automated scans have no serious/critical issue; every core flow completes keyboard-only; documented VoiceOver checks and 200% zoom/narrow-width checks pass.
- Tests: automated accessibility checks plus named manual assistive-tech/device cases.
- Risks: false confidence from automated scans; manual evidence is required.
- Parallel safe: review can start per completed surface; final gate is serial.
- Completion note (2026-08-10): Delivered `docs/QA-001B_ACCESSIBILITY_AUDIT.md` with programmatic semantic/name/role/state, focus, contrast, reduced-motion, touch-target, non-color-signal, and 320/390/430/desktop layout evidence, plus a named REQUIRES OWNER RUN manual checklist (7 keyboard-only flow traces, 8 VoiceOver cases, 7 physical-device/zoom cases) with no fabricated manual results. Fixed four blocking defects: color-only gain/loss signals on owned holdings rows and the holding dialog (signed prefixes per existing convention), missing drawer keyboard focus management (initial focus, restore, Escape, Tab containment), `--muted-dark` contrast below 4.5:1 (now #828e89, 4.56–5.64:1), and four sub-44px touch targets. Review caught a 320px period-tab overflow introduced by the 44px fix; remediated by wrapping `.period-tabs` with the audit doc corrected honestly. Automated coverage in `tests/qa-001b.test.ts` (10 tests). Owner manual runs (VoiceOver, physical iPhone, 200% zoom) remain outstanding and are folded into QA-002 UAT; capture regeneration for visually changed controls is a follow-up. Two review rounds; final independent review PASS; `npm run check` exit 0 (290 pass, 2 env-gated skips).

### QA-002 — Preview UAT and release readiness

Status: DONE (2026-08-10); owner-run UAT items remain open preconditions for promotion beyond preview.

- Objective: provide evidence that the complete preview release meets product, security, data, device, and operational gates.
- Dependencies: UI-002, UI-003, UI-004, UI-005D, UI-005E, PWA-001, OPS-002, OPS-003B, QA-001A, QA-001B.
- Requirements: OPS-002, OPS-003, QUAL-002.
- Files: release checklist/evidence, fixture expectations, runbooks; only fixes needed by evidence.

**Context:**

- `docs/CONSOLIDATED_PRODUCT_SPEC.md` — `Success measures` → release readiness and the full `Product state contract`
- `docs/IMPLEMENTATION_PLAN.md` — `Phase gates`, `First release slices`, and `Testing strategy` → end-to-end/UAT
- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md` — `OPS-002 — Observability`, `OPS-003 — Backup and recovery`, and `QUAL-002 — Automated quality gate`
- `docs/ARCHITECTURE.md` — `Operational design` → environments and recovery
- `docs/CSV_IMPORT_SPEC.md` — `Staged workflow`, `Idempotency and duplicate detection`, and `Batch reversal and corrected re-import`

**Likely code:**

- `docs/PREVIEW_DEPLOYMENT.md`, `docs/PREVIEW_EVIDENCE.json`, `docs/OPS-002_BACKUP_RESTORE_RUNBOOK.md`, and `docs/OPS-002_DRILL_RECORD_2026-08-03.md`
- `scripts/preview-harness.mjs`, `scripts/capture-fixture-html.mjs`, and `scripts/ops-002-restore-drill.ts`
- `tests/` (full release gate and fixture evidence)
- Application files only when a release-gate failure demonstrates an in-scope defect.

**Verification:**

- Run `npm run check` and `npm run preview:harness`, then smoke every required direct route in the clean preview environment.
- Record supplied-CSV stage/map/commit/retry/reverse evidence, calculation reconciliation, Access invite/offboard and cross-owner checks, desktop/iPhone/PWA/keyboard UAT, restore and verified-deletion drills, redacted observability evidence, known limitations, and the serial go/no-go decision.

- Deliver: clean preview environment; Access invite/offboard test; supplied CSV end-to-end; calculation reconciliation; iPhone/desktop/PWA tests; backup/deletion drill evidence; go/no-go record.
- Acceptance: every non-deferred task required by those dependencies is DONE; all product success measures and phase gates pass; owner/source scope is active; no critical/high issue; known limitations are documented.
- Tests: full lint/build/unit/integration/render/E2E suite plus manual UAT.
- Risks: production data or credentials entering preview; maintain strict environment separation.
- Parallel safe: test workstreams may run concurrently; go/no-go decision is serial.
- Completion note (2026-08-10): Delivered `docs/QA-002_RELEASE_READINESS.md` with a conditional GO: every automated gate passed with recorded evidence (full quality gate 292 tests/290 pass/2 env-gated skips; all 9 direct routes smoke 200 through the preview harness; live CSRF 403 and full security-header checks; supplied-CSV 244-row stage/map/commit/reverse and FIFO/valuation reconciliation via cited tests; OPS-003A/B Miniflare drills 27/27; redacted observability; npm audit unchanged with documented acceptance), plus §12 traceability mapping all 12 product success measures and all 7 implementation-plan phase-gate sets to evidence with honest PARTIAL dispositions. Owner-run preconditions before promotion beyond preview are named step-by-step in §9: Access invite/offboard (A1–A5, preview Worker deployed but Access secrets intentionally unset), physical iPhone/desktop/PWA (D1–D4), zoom/motion (Z1–Z7), keyboard (K1–K7), VoiceOver (V1–V8). One in-scope defect found and fixed: `scripts/preview-harness.mjs` dropped request method/body, so mutation routes could never be smoked; it now forwards method/body/headers while stripping client-supplied `cf-access-jwt-assertion`. Four review rounds; final independent review PASS.

### MKT-006 — Deployment-scoped market-data retention expiry

Status: DEFERRED; not required for the preview release (QA-002 records the gap as a PARTIAL phase-gate disposition).

- Objective: add time-based retention-duration expiry and a provider-removal purge routine for deployment-scoped (`scope_user_id IS NULL`) price/FX observations, completing the `docs/MARKET_DATA_STRATEGY.md` §10 retention obligations.
- Dependencies: OPS-003B.
- Requirements: OPS-004 and `docs/IMPLEMENTATION_PLAN.md` Phase 5 "provider retention obligations are operational".
- Context: `docs/QA-002_RELEASE_READINESS.md` §12.2 Phase 5 row documents current coverage (user-scoped observations purged via OPS-003B's `PURGE_TABLES_IN_FK_ORDER`) and the residual gap (no `DELETE` against `price_observations`/`fx_rate_observations` outside `db/repositories/account-lifecycle.ts`; no time-based expiry job).

### QA-003 — D1-incompatible SQL transactions in write paths (and remove local dev shim)

Status: DONE (2026-08-11).

- Objective: replace SQL-level `BEGIN IMMEDIATE TRANSACTION`/`COMMIT`/`ROLLBACK` in the repository `withTransaction` helpers with a D1-compatible atomic mechanism (D1's `batch()` API), so multi-statement write paths work on Cloudflare D1; then remove the temporary local-dev transaction shim.
- Evidence: against real Miniflare/workerd D1, CSV import preview fails with `D1_ERROR: To execute a transaction, please use the ... transaction() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements` thrown from `db/repositories/import-staging.ts:426` (`client.run("BEGIN IMMEDIATE TRANSACTION")`). D1 rejects SQL transaction-control statements; `SqlClient.batch()` is the supported atomic primitive and is already used correctly elsewhere (e.g. `db/repositories/owned-portfolios.ts` `create`). Portfolio create and JIT provisioning work because they use `batch()`; import staging/commit and other paths do not.
- Why tests miss it: the repository suites run against the `node:sqlite` client (`createSqliteSqlClient`), which permits SQL `BEGIN`/`COMMIT`, so no test exercises these paths against D1's real constraint. 21 tests use the sqlite client; only 2 touch the D1 client, and neither drives a `BEGIN/COMMIT` path.
- Scope: `withTransaction` helpers using `BEGIN IMMEDIATE TRANSACTION` appear in `db/repositories/import-staging.ts`, `db/repositories/import-commit.ts`, `db/repositories/import-reversal.ts`, `db/repositories/ledger.ts`, `db/repositories/market-data.ts`, `db/repositories/market-data-refresh.ts`, `db/repositories/projections.ts`, `db/repositories/account-lifecycle.ts`, `db/repositories/owned-portfolios.ts`, and `domain/auth/identity-lifecycle.ts`. Note `identity-lifecycle` already prefers a `batch()` path when `client.batch` exists. Convert each read-then-write operation to gather reads first and apply all writes as a single `client.batch([...])`; where interleaved read-after-write inside the transaction is required, restructure so the atomic unit is expressible as one `batch()`.
- Remove the shim: delete `wrapWithLocalDevTransactionShim` and its gated call in `db/d1-sql-client.ts`, and the `YIELDTOME_DEV_D1_TX_SHIM` var in `.dev.vars` / `docs/LOCAL_DEVELOPMENT.md`. The shim (added 2026-08-10) neutralizes `BEGIN/COMMIT` in the `local` runtime only, behind explicit opt-in, to make the app testable meanwhile; it is not a fix (writes autocommit individually, so atomicity/rollback is lost).
- Requirements: QUAL-002; the non-negotiable data-integrity rules in `AGENTS.md` (atomic, reversible ledger/import writes) and `docs/ARCHITECTURE.md` transaction/guard invariants for import commit.
- Tests: add coverage that exercises the affected write paths against the D1 client (`createD1SqlClient` over a Miniflare/workerd D1), not only `node:sqlite`, so the `BEGIN` incompatibility cannot regress; keep existing atomic-rollback assertions meaningful under `batch()`.
- Verification: `npm run check`; then, against a real local D1, run the supplied `docs/Example_Portfolio.csv` through stage → map → commit → reverse and confirm rows persist and counters/digests reconcile with the shim removed.
- Risks: import-commit and ledger posting rely on documented atomic guards and version/count assertions; a naive conversion can silently drop atomicity. Treat as correctness-critical and route through the normal Worker/Reviewer flow.
- Completion note (2026-08-11): Made `SqlClient.batch()` required and removed every SQL `BEGIN/COMMIT/ROLLBACK` fallback across the nine repositories and `domain/auth/identity-lifecycle.ts` (plus dead non-batch fallbacks in `db/repositories/identity.ts` that silently dropped audit events); deleted `wrapWithLocalDevTransactionShim` and all `YIELDTOME_DEV_D1_TX_SHIM` references. `persistParsedResult` in import staging was rebuilt as one atomic `batch()` with guard-conditional statements: child INSERTs first, each guarded `WHERE EXISTS (... version = expectedVersion AND status = 'uploaded')` on the pre-state, version-bumping UPDATE last with the identical predicate — review reproduced and killed two unsound designs on the way (chunked compensation that exceeded D1's 100-bound-parameter limit; a post-bump guard satisfied by concurrent writers). `atomic_failure` now maps to the 503 retryable message. New `tests/qa-003.test.ts` (gated `QA003_D1_DRILL=1`) drives owned-portfolios, identity, ledger, market-data, refresh, and the full stage→commit→reverse pipeline with the real 244-row `docs/Example_Portfolio.csv` against Miniflare/workerd D1, plus concurrent-bump and mid-batch-failure zero-persistence tests (sqlite + D1). Combined drills 40/40; `npm run check` exit 0 (295 pass, 7 env-gated skips). Docs updated: `docs/DATA_MODEL.md` §11 (guard-conditional batch technique, rejected alternatives, batch-ceiling assumption marked), `docs/CSV_IMPORT_SPEC.md` §7 (atomic-unit budget exemption, fail-closed large-import note), `docs/LOCAL_DEVELOPMENT.md` (shim removal). Three review rounds plus a reviewer-pre-approved status-predicate hardening; final review PASS. Residual (fails closed, deferred as IMP-005): the 100,000-row parser cap exceeds the single-batch statement ceiling; near-cap uploads fail with `atomic_failure` and nothing persisted.

### IMP-005 — Large-import staging persistence beyond one atomic batch

Status: DEFERRED; not required while realistic imports (hundreds of rows) fit one atomic batch — the oversized path fails closed with nothing persisted.

- Objective: allow staging persistence of imports approaching the 100,000-row parser cap (`domain/imports/strict-versioned-parser.ts` `DEFAULT_IMPORT_LIMITS.maxRows`) by either tightening the effective row cap to the verified single-batch ceiling or designing a resumable multi-invocation parse-persistence job consistent with the import commit's high-water-cursor pattern.
- Dependencies: QA-003.
- Context: `docs/DATA_MODEL.md` §11 (guard-conditional single batch and the marked batch-ceiling assumption), `docs/CSV_IMPORT_SPEC.md` §7 fail-closed note. Also verify the actual workerd per-batch statement ceiling with a drill instead of the current documented assumption.

### IMP-004A — Wire import review to commit (mapping resolution, readiness, commit UI/actions)

Status: DONE (2026-08-11); brand-new-symbol self-service resolution is out of scope per the normative spec and awaits the owner decision recorded in IMP-004B.

- Objective: connect the already-built import backend (staging, mapping decisions, reconciliation, commit) to the app so an owner can resolve the unresolved securities/FX in a reviewed batch, move it to `ready`, and commit it into ledger effects — entirely through the UI.
- Evidence of the gap: after a real upload+parse (e.g. `docs/Example_Portfolio.csv` → 244 rows staged: 115 transactions, 65 security definitions, 57 unresolved security candidates), commit returns `409 not_ready`. No code anywhere calls `createOwnedImportStagingRepository(...).transitionStatus(...)` with `nextStatus: "ready"` — grep of `app/` and `db/` finds the method defined (`db/repositories/import-staging.ts`) but never invoked. `saveImportMappingAction` persists a decision but never transitions state, and the `/import` review UI (`app/import/`) is read-only (the workspace `+` menu labels it "Import CSV — Review only").
- Already done (do not rebuild): IMP-002B mapping/reconciliation/preview contract; IMP-003A idempotent commit + resume (repository `commit`, `commitImportAction`, `POST /api/import/commit/[batchId]`); IMP-003B reversal. This task is the missing orchestration/UI layer, not new backend.
- Deliver: UI + server actions to (1) list and resolve unresolved security/FX candidates via `saveImportMappingAction` (map-to-existing or create owner-private candidate), (2) recompute the preview and, when there are no blocking issues and no unresolved required mappings, transition `parsed`/`needs_mapping` → `ready`, and (3) present an explicit confirmation that calls the existing commit action with the current `expectedVersion`/`expectedPreviewVersion`/idempotency key. Surface post-commit state (committed batch, resulting holdings) and keep the reverse path (IMP-003B) reachable.
- Dependencies: IMP-002B, IMP-003A, IMP-003B; UI-003 (import review surface). Blocked in practice by QA-003 on real D1 (commit uses the same `BEGIN/COMMIT` transaction paths D1 rejects; the local shim masks this for testing only).
- Requirements: IMP-002, IMP-003, IMP-004, AUTH-004; `docs/CSV_IMPORT_SPEC.md` staged workflow (stage → map → preview → commit → reverse).
- Files: `app/import/`, `app/import-actions.ts`, `app/import-commit-actions.ts`, import review components, `tests/imp-*.test.ts`, plus `docs/CSV_IMPORT_SPEC.md`/acceptance updates.
- Verification: `npm run check`; then against a real local D1 drive the supplied CSV through resolve → ready → commit in the browser and confirm holdings/transactions and overview/holdings views populate, then reverse and confirm restoration.
- Acceptance: an owner can take `docs/Example_Portfolio.csv` from upload to committed holdings using only the UI; ambiguous securities/FX block commit until resolved; commit is explicit, idempotent, and owner-scoped; reversal remains available; no shared security master is mutated by a user decision.
- Risks: exposing partially committed rows; preview/commit version races; must not weaken the server-side revalidation and guards added in IMP-003A.
- Completion note (2026-08-11): Delivered the missing orchestration/UI layer: `app/import-ready-service.ts` (`markImportReadyWithContext` reloads the batch and rebuilds the owner-scoped review from the database, requires zero error-severity reconciliation issues and zero unresolved persisted issues, then calls the version-guarded `transitionStatus`), a CSRF-first `POST /api/import/preview/:batchId/ready` route, mapping-resolution UI listing every pending portfolio/security/FX issue (with a new FX-direction form), an explicit "Mark import ready" step, and a commit panel gated on persisted batch status; reversal stays reachable and no IMP-003A commit guard changed. When no resolved candidate exists the security card renders an explanatory note instead of a dead-end form. `tests/imp-004a.test.ts` covers readiness blocking/resolution, denial paths (malformed/stale/wrong-status/cross-owner/CSRF), and a full stage→ready→commit→posted-transaction→queued-rebuild→reverse round trip; the QA-001A matrix gained the new route row (25 handlers). `npm run check` exit 0 (301 pass, 7 env-gated skips); independent review PASS. Scope ruling: per `docs/DATA_MODEL.md` (securities master operator-write-only) and `docs/CSV_IMPORT_SPEC.md` (`SECURITY_UNRESOLVED` blocks commit), user decisions cannot create canonical securities, so a first-ever import with brand-new symbols still cannot reach `ready` through the UI alone — see IMP-004B.

### IMP-004B — Owner-facing security verification flow for brand-new symbols

Status: DONE (2026-08-12); owner decision recorded 2026-08-11 — option (a): an owner-facing "verify security" flow backed by a server-side verification path.

- Objective: let an owner resolve a brand-new unresolved import candidate by requesting server-side verification: the server validates the candidate's symbol/exchange/currency against the configured provider (quote/identity lookup with recorded provenance) and, on success, publishes the canonical `securities` row plus `security_identifiers` and validity-dated provider mapping, then links the owner's candidate (`security_id`) — making the batch resolvable through the UI end to end.
- Decision constraints (Orchestrator-recorded):
  - The server verification path is the ONLY writer of canonical rows; user input alone never publishes. Verification must be evidence-based: a successful provider lookup (with currency/exchange agreement) recorded with source, observation time, ingestion time per the market-data non-negotiables.
  - Creation-only against the shared master: if a canonical security matching the verified identity already exists, link to it (dedupe) — never mutate or overwrite an existing canonical row, identifier, or another user's mapping.
  - Provider unavailable/ambiguous/mismatched → explicit failure state with the reason; no unverified publish, no silent retry loops; the candidate stays private and unresolved.
  - AUTH-004 CSRF gating, owner scoping, and the QA-001A matrix conventions apply to any new route/action; QA-001B accessibility standards apply to new UI.
- Also fold in (IMP-004A review follow-ups): a resolve card for `PORTFOLIO_MAPPING_INVALID` (the only mapping-class error with no form), and a "Refresh preview" affordance for stale-preview 409s.
- Dependencies: IMP-004A, MKT-002 (provider adapter), DB-002 (security master schema).
- Requirements: IMP-002, IMP-004; `docs/DATA_MODEL.md` securities/master invariants; `docs/MARKET_DATA_STRATEGY.md` provider-mapping and provenance rules.
- Docs: update `docs/DATA_MODEL.md` (securities master write path) and `docs/CSV_IMPORT_SPEC.md` (resolution workflow) in the same change set; `docs/ARCHITECTURE.md` if the verification path is a durable architectural element.
- Verification: `npm run check`; sqlite + D1-gated tests for verify-success (canonical row + identifiers + mapping + candidate link), dedupe-link, provider-failure/ambiguity, cross-owner/CSRF denial; then the acceptance drill — `docs/Example_Portfolio.csv` on an empty account reaches committed holdings through the UI flow alone (with the provider fixture supplying verification evidence).
- Acceptance: an owner can verify brand-new symbols and take a first-ever import from upload to committed holdings UI-only; canonical writes happen only through the evidence-based server path; existing canonical data is never mutated; failures are explicit and safe.
- Completion note (2026-08-12): Delivered the evidence-based verification path: `domain/securities/verify-identity.ts` (`evaluateSecurityIdentityCandidates` — exact symbol, agreeing currency normalized to canonical upper case, agreeing exchange when supplied; explicit `not_found`/`mismatched`/`ambiguous` outcomes), `db/repositories/security-verification.ts` (`createOwnedSecurityVerificationRepository` — creation-only publish of `securities` + `security_identifiers` + validity-dated `security_provider_mappings` plus the owner's candidate link as ONE guard-conditional `batch()`, the link resolving `security_id` via a live subquery so a lost race dedupe-links to the concurrent winner; identity keys from provider-verified symbol/exchange, never raw user input; dedupe path fails explicitly on `currency_mismatch`), `app/security-verification-service.ts` (re-derives the verify request from the server's own preview), CSRF-first `POST /api/import/preview/:batchId/securities/verify` and read-only owner-scoped `GET /api/import/preview/:batchId`, verify/resolve UI incl. the `PORTFOLIO_MAPPING_INVALID` resolve card and "Refresh preview" affordance. Provenance (source, observation time, ingestion time, verified_by/at) recorded; `exchange_id = NULL` on verified rows (provider exchange survives only on the mapping — recorded in `docs/DATA_MODEL.md`). `tests/imp-004b.test.ts`: 9 sqlite tests incl. the acceptance drill (`docs/Example_Portfolio.csv` from zero securities through verify→ready→commit) plus 3 `IMP004B_D1_DRILL=1`-gated Miniflare tests (verify-success publish, dedupe-link, whole-batch rollback on duplicate-mapping collision with zero orphans across all four tables; gated run 12 pass / 0 fail). QA-001A matrix +2 route rows (27 handlers, citations grep-verified). `npm run check` exit 0 (311 pass, 10 env-gated skips). Independent review: FAIL round 1 (doc/code atomicity mismatch — two batches vs documented one; missing D1-gated coverage) → corrections folded the link into the single batch and added the drill → PASS round 2. Non-blocking review follow-ups noted: blanket `catch {}` in the repository funnels distinct failures into one 409 message (fails closed); `mismatched`/`ambiguous`/`currency_mismatch` return HTTP 502 though they are business outcomes; `isStalePreviewMessage` matches the substring "stale" rather than a structured reason; no direct behavioural test for the preview GET route or end-to-end `PORTFOLIO_MAPPING_INVALID` resolution. Material follow-up split out as IMP-004C.

### IMP-004C — Re-verification after provider-mapping supersession

Status: DEFERRED (2026-08-12); latent until mapping supersession is implemented — nothing sets `security_provider_mappings.valid_to` today.

- Problem (IMP-004B review finding): `db/repositories/security-verification.ts` dedupe lookup filters `valid_to IS NULL` while the publish guards check for ANY mapping row regardless of validity. Once a mapping is retired with `valid_to`, every publish statement no-ops, the re-read finds no active winner, and the owner receives a permanent 409 — brand-new verification of that identity becomes impossible.
- Fix direction: align the publish guards with the active-mapping predicate (or publish a new validity-dated mapping row when only expired ones exist), with D1-gated coverage for verify-after-supersession.
- Dependencies: IMP-004B; whichever future task introduces mapping supersession (`valid_to` writes) must un-defer this alongside it.
