# QA-001A — Security and tenant-isolation matrix

Status: evidence for the QA-001A task (`TASKS.md`). Requirements: PRD-001,
AUTH-003, AUTH-004. Normative sections routed for this task: `AUTH-001`,
`AUTH-003`, `AUTH-004`, `PLAT-002` in
`docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md`.

This document records the route/repository/destructive-action ownership
matrix, the Access-token failure matrix, the CSRF/header/CSP review, the
dependency-audit result, the private-cache and redacted-error audits, and the
manual threat checklist performed for release hardening. It is evidence, not
a durable architecture record — update `docs/ARCHITECTURE.md` directly if a
security control's design changes.

## Method

- Read every file under `app/api/**/route.ts`, the server actions/pages under
  `app/` that reach D1, `worker/index.ts`, `worker/response-security.ts`,
  `domain/auth/*`, `db/repositories/*`, and `public/sw.js`.
- Cross-checked every mutation route against `AUTH-004`'s requirement that
  same-origin/CSRF checks run before authentication or database work.
- Cross-checked every read/write repository call against `AUTH-003`'s
  requirement that the actor is derived from the validated identity and that
  child resources are checked through their owned portfolio in the same
  query.
- Ran `npm audit`, inspected `dist/client` for secret/config leakage, and
  inspected `public/sw.js` and its test coverage for Cache Storage behavior.
- Ran the full automated suite (`node --experimental-strip-types --test
tests/*.test.ts tests/*.test.mjs`) and `./node_modules/.bin/vinext build`.

## 1. Route / server-action / repository ownership matrix

All routes sit behind the Worker's unconditional Cloudflare Access JWT
verification (`worker/index.ts`) — every request, including static assets,
requires a valid, signature-checked `Cf-Access-Jwt-Assertion` before any
handler runs. The columns below cover the additional per-operation controls.

Legend: **CSRF** = `rejectCrossSiteMutation` gate present and evaluated
before body parsing/auth. **Owner scope** = the userId used in the query is
the authenticated principal's internal id, never a client-supplied value.

| Route / action                                                                                                    | Method        | Owner scope                                                                                                                                                                                                                                                                                                                              | CSRF                                                     | Denial-test evidence                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/portfolios` (`app/api/portfolios/route.ts` → `createPortfolioAction`)                                       | POST          | `getAuthenticatedSqlContext()` → `context.userId`                                                                                                                                                                                                                                                                                        | Yes (fixed in this task)                                 | `tests/qa-001a.test.ts` (CSRF); `tests/db-001b.test.ts` "owned portfolio repositories deny cross-user reads, writes, and optimistic conflicts"; `tests/ops-001.test.ts` "portfolio mutation rolls back when its audit append fails"                                                                        |
| `/api/portfolios/:portfolioId` (`app/api/portfolios/[portfolioId]/route.ts` → `renamePortfolioAction`)            | PATCH         | `getAuthenticatedSqlContext(portfolioId)` scopes the row via `WHERE ... user_id = ?`                                                                                                                                                                                                                                                     | Yes (fixed)                                              | `tests/qa-001a.test.ts`; `tests/db-001b.test.ts` cross-user denial                                                                                                                                                                                                                                         |
| `/api/portfolios/:portfolioId` (`archivePortfolioAction`)                                                         | DELETE        | same                                                                                                                                                                                                                                                                                                                                     | Yes (fixed)                                              | `tests/qa-001a.test.ts`; `tests/db-001b.test.ts` cross-user denial                                                                                                                                                                                                                                         |
| `/api/portfolios/:portfolioId/restore` (`restorePortfolioAction`)                                                 | POST          | same                                                                                                                                                                                                                                                                                                                                     | Yes (fixed)                                              | `tests/qa-001a.test.ts`; `tests/db-001b.test.ts` cross-user denial                                                                                                                                                                                                                                         |
| `/api/portfolios/:portfolioId/ledger` (`createManualLedgerAction`)                                                | POST          | `authenticatedContext(portfolioId)` → `context.userId`; `createManualLedgerMutationKeyRepository.authorize` re-binds the server-issued key to `userId+portfolioId`                                                                                                                                                                       | Yes (pre-existing, `manual-ledger-route.ts`)             | `tests/ui-005e.test.ts` "route boundary enforces CSRF, private responses, ownership, and double submit"; `tests/led-001b.test.ts` cross-owner idempotency isolation                                                                                                                                        |
| `/api/portfolios/:portfolioId/ledger/:transactionId/reverse`                                                      | POST          | same, target transaction resolved through `userId+portfolioId`                                                                                                                                                                                                                                                                           | Yes (pre-existing)                                       | `tests/led-001b.test.ts`; `tests/ui-005e.test.ts`                                                                                                                                                                                                                                                          |
| `/api/portfolios/:portfolioId/ledger/:transactionId/supersede`                                                    | POST          | same                                                                                                                                                                                                                                                                                                                                     | Yes (pre-existing)                                       | `tests/led-001b.test.ts` "reversal and supersession preserve source facts and rebuild markers"                                                                                                                                                                                                             |
| `/api/portfolios/:portfolioId/ledger/key` (`issueManualLedgerKeyAction`)                                          | POST          | same                                                                                                                                                                                                                                                                                                                                     | Yes (pre-existing)                                       | `tests/ui-005e.test.ts` "server-issued keys bind create, reverse, and replacement retries to one owner and target"                                                                                                                                                                                         |
| `/api/settings/holding-currency-view` (`changeHoldingCurrencyViewAction`)                                         | PATCH         | `getAuthenticatedSqlContext()` → `context.userId`                                                                                                                                                                                                                                                                                        | Yes (fixed)                                              | `tests/qa-001a.test.ts`                                                                                                                                                                                                                                                                                    |
| `/api/settings/home-currency` (`changeHomeCurrencyAction`)                                                        | PATCH         | same                                                                                                                                                                                                                                                                                                                                     | Yes (fixed)                                              | `tests/qa-001a.test.ts`; `tests/ops-001.test.ts` "home-currency mutation rolls back when its audit append fails"                                                                                                                                                                                           |
| `/api/import/preview` (`createImportPreviewAction`)                                                               | POST          | `getAuthenticatedSqlContext()`; target portfolio re-checked via `createOwnedPortfolioRepository(...).get(userId, targetPortfolioId)`                                                                                                                                                                                                     | Yes (fixed)                                              | `tests/qa-001a.test.ts`; `tests/imp-003a.test.ts` (upload/commit ownership)                                                                                                                                                                                                                                |
| `/api/import/preview/:batchId/mappings` (`saveImportMappingAction`)                                               | PATCH         | `staging.get(userId, batchId)` scopes the batch                                                                                                                                                                                                                                                                                          | Yes (fixed)                                              | `tests/qa-001a.test.ts`; `tests/imp-002b.test.ts` "mapping decisions are owner-scoped and reusable by batch"                                                                                                                                                                                               |
| `/api/import/commit/:batchId` (`commitImportAction`)                                                              | POST          | owner-scoped batch resolution                                                                                                                                                                                                                                                                                                            | Yes (pre-existing)                                       | `tests/imp-003a.test.ts` "commit route rejects cross-site mutation before authentication or parsing"; "atomic rollback, duplicate-file reuse, idempotency, ownership, and confirmation fail closed"                                                                                                        |
| `/api/import/commit/:batchId/reverse` (`reverseImportAction`)                                                     | POST          | same                                                                                                                                                                                                                                                                                                                                     | Yes (pre-existing)                                       | `tests/imp-003b.test.ts` "reversal route enforces CSRF before its authenticated action and returns private progress"; "direct reversal denies another owner without changing the batch"                                                                                                                    |
| `/api/import/history` (`loadImportHistoryAction`)                                                                 | GET           | `getAuthenticatedSqlContext()` → `listBatches(userId)`                                                                                                                                                                                                                                                                                   | N/A (read)                                               | `tests/imp-002b.test.ts`; `tests/import-staging.test.ts` "denies cross-user access and enforces row bounds with foreign keys enabled"                                                                                                                                                                      |
| `/api/import/history/:batchId` (`loadImportBatchHistoryAction`)                                                   | GET           | same, batch resolved by `userId`                                                                                                                                                                                                                                                                                                         | N/A (read)                                               | `tests/ui-005c.test.ts` "history detail is owner-scoped, bounded, and exposes durable resume progress"                                                                                                                                                                                                     |
| `/api/market-data/overrides` (`listManualOverrideAction`)                                                         | GET           | `authenticatedSqlContext(portfolioId)`                                                                                                                                                                                                                                                                                                   | N/A (read)                                               | `tests/mkt-003a.test.ts` "manual overrides are owner-scoped, interval-conflict checked, supersedable, and removable"                                                                                                                                                                                       |
| `/api/market-data/overrides` (`saveManualOverrideAction` / `removeManualOverrideAction`)                          | POST / DELETE | same; override target re-verified against `portfolio_securities`/portfolio ownership before writing                                                                                                                                                                                                                                      | Yes (pre-existing)                                       | `tests/ui-004.test.ts` "market-data mutation endpoints reject cross-site browser requests"; `tests/mkt-003a.test.ts` ownership/atomic-failure cases                                                                                                                                                        |
| `/api/market-data/refresh` (`requestMarketDataRefreshAction`)                                                     | POST          | `authenticatedSqlContext(portfolioId)`; target rows filtered by `ps.user_id = ?`                                                                                                                                                                                                                                                         | Yes (pre-existing)                                       | `tests/ui-004.test.ts` "market-data mutation endpoints reject cross-site browser requests"; "refresh ranges are bounded, concurrent requests coalesce, and completion cools down"                                                                                                                          |
| `/api/account/lifecycle` (`requestAccountLifecycleAction`)                                                        | POST          | `getAuthenticatedSqlContext()`/`getVerifiedPrincipalSqlContext()` → repository calls scoped by `userId`                                                                                                                                                                                                                                  | Yes (pre-existing)                                       | `tests/ops-003b.test.ts` "lifecycle route applies CSRF before auth, bounded body, and no-store"; `tests/ops-003a.test.ts` "lifecycle repository rejects a cross-owner actor"                                                                                                                               |
| `/api/account/lifecycle/status`                                                                                   | GET           | principal-derived issuer/subject only; row resolved through `user_identities`/`account_lifecycle_requests`                                                                                                                                                                                                                               | N/A (read)                                               | `tests/ops-003a.test.ts` "revoked principal recovery requires the exact request type and key"                                                                                                                                                                                                              |
| `/api/account/export/:jobId` (download)                                                                           | GET           | `identity.userId` from `findAccessIdentity(issuer, subject)`; `downloadPage(userId, jobId, ...)` is `WHERE id=? AND user_id=?`, so a guessed/foreign `jobId` returns `export_not_ready`/404 even though `authorizeExportJobRequest` short-circuits true for any active identity (see finding QA-001A-F2 below, verified non-exploitable) | N/A (read)                                               | `tests/ops-003a.test.ts` "export is owner-scoped, includes an exact manifest, and does not purge"; "export route authorization requires exact credentials only for revoked identities"                                                                                                                     |
| `/api/account/export/:jobId/process`                                                                              | POST          | same scoping as download; `processExportJob(userId, jobId, ...)`                                                                                                                                                                                                                                                                         | Yes (pre-existing)                                       | `tests/ops-003a.test.ts` "export route authorization requires exact credentials only for revoked identities" (contains the route's CSRF 403 assertion); export atomicity: "unexpected export errors atomically persist one stable failed outcome"                                                          |
| Portfolio pages `/`, `/portfolio/:id/:section`, `/portfolio/:id/:section/:holdingId`, `/portfolio/:id/ledger/new` | GET (render)  | `loadAuthenticatedWorkspace(portfolioId)` → `resolveAuthenticatedRequestContext`                                                                                                                                                                                                                                                         | N/A (render)                                             | `tests/rendered-html.test.mjs` "server denies unauthenticated requests before rendering private content"; `tests/ui-003.test.ts` "UI-003 loads a published owner projection with inverse-safe FX and denies cross-owner access"; `tests/ui-002.test.ts` "UI-002 published snapshot lookup is owner-scoped" |
| `/import` page                                                                                                    | GET (render)  | same pattern via `getAuthenticatedSqlContext`                                                                                                                                                                                                                                                                                            | N/A (render)                                             | `tests/import-staging.test.ts`; `tests/imp-003a.test.ts`                                                                                                                                                                                                                                                   |
| Scheduled market-data refresh (`worker/scheduled-refresh.ts`, Cron trigger, no HTTP surface)                      | n/a           | Not user-scoped by design: jobs operate on deployment-scope provider mappings only (`scope: { kind: "deployment", userId: null }`), never per-user portfolio rows                                                                                                                                                                        | N/A — not reachable via HTTP, no Access boundary applies | `tests/mkt-003b.test.ts` "limits Cron work to bounded job and provider request budgets"; "scheduled handler is durable and does not use waitUntil for refresh work"                                                                                                                                        |

### Repositories (data-access layer)

Every `createOwned*Repository` factory in `db/repositories/` (ledger,
owned-portfolios, import-staging, import-commit, import-reversal,
import-mapping-decisions, manual-ledger-keys, market-data manual overrides,
account-lifecycle, snapshots, calculation-runs, projections) takes the
authenticated `userId` as an explicit first argument on every read/write
method and binds it in the SQL predicate (`WHERE ... user_id = ?` or a join
through a `user_id`-scoped parent). Table names interpolated in
`account-lifecycle.ts` (export/purge table sweeps) come only from
`tableNames()` (reads `sqlite_master`) or the hardcoded
`PURGE_TABLES_IN_FK_ORDER`/`PURGE_CLEANUP_TABLES` arrays — never from request
input — so there is no SQL-injection surface through those interpolations.
Cross-owner repository denial is covered directly by: `tests/db-001b.test.ts`,
`tests/db-004.test.ts`, `tests/led-001a.test.ts`, `tests/led-001b.test.ts`,
`tests/led-002b.test.ts` (schema-level FK/trigger boundaries),
`tests/imp-002b.test.ts`, `tests/imp-003a.test.ts`, `tests/imp-003b.test.ts`,
`tests/import-staging.test.ts`, `tests/mkt-003a.test.ts`,
`tests/ops-003a.test.ts`, `tests/ops-003b.test.ts`, `tests/ui-002.test.ts`,
`tests/ui-003.test.ts`, `tests/ui-004.test.ts`, `tests/calc-002-repository.test.ts`.

Background/scheduled path: only `worker/scheduled-refresh.ts` runs outside a
request (Cron trigger). It operates on deployment-scoped market-data provider
mappings, never on a specific user's portfolio, ledger, or import rows, so it
carries no tenant-isolation surface — verified by reading the file (no
`userId` parameter reaches its D1 queries) and by `tests/mkt-003b.test.ts`.

### Intentionally excluded from the matrix

- `app/preview-*` fixture loaders and the `/portfolio/preview/*` route: serve
  a static, non-authenticated, repository-controlled CSV fixture
  (`docs/Example_Portfolio.csv`), contain no user data, and are hard-blocked
  in production by `worker/index.ts` (`pathname.startsWith("/portfolio/preview/")`
  → 404 when `environment === "production"`). Covered by
  `tests/rendered-html.test.mjs` "production hides the preview sample route".
- `app/manifest.ts`, `public/favicon.svg`, `public/icons/*`,
  `public/offline.html`: static, non-financial PWA assets with no ownership
  dimension.

## 2. Access-token failure matrix

Verified in `domain/auth/access-jwt.ts` (`createAccessJwtVerifier`), exercised
by `tests/access-jwt.test.ts` and `tests/security-headers.test.ts`:

| Condition                                                     | Result                                                                                                                         | Test                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| No `Cf-Access-Jwt-Assertion` header                           | 401 `missing-access-jwt`                                                                                                       | `tests/access-jwt.test.ts` "rejects missing configuration, missing token, malformed tokens, and bad claims"           |
| Malformed token (not 3 dot-separated parts / bad base64/JSON) | 401 `malformed-token`                                                                                                          | same                                                                                                                  |
| Missing/invalid Access issuer or audience configuration       | 503 `missing-access-configuration` (fail closed)                                                                               | same; also `tests/runtime-config.test.ts` "preview and production fail closed when Access config is missing"          |
| Wrong `iss`                                                   | 403 `invalid-access-issuer`                                                                                                    | same                                                                                                                  |
| Wrong `aud`                                                   | 403 `invalid-access-audience`                                                                                                  | same                                                                                                                  |
| `exp` in the past (beyond clock skew)                         | 403 `expired-access-token`                                                                                                     | `tests/access-jwt.test.ts` "rejects expired, not-yet-valid, service-token, and signature-mismatched JWTs"             |
| `nbf` in the future (beyond clock skew)                       | 403 `not-yet-valid-access-token`                                                                                               | same                                                                                                                  |
| Non-`app` token type / empty `sub` (service token)            | 403 `invalid-access-token-type` / `invalid-access-claims`                                                                      | same                                                                                                                  |
| Signature does not verify against the current/rotated JWKS    | 403 `invalid-access-signature`                                                                                                 | same                                                                                                                  |
| `alg` not `RS256`                                             | 403 `invalid-access-algorithm`                                                                                                 | code path in `access-jwt.ts:378`; exercised implicitly by the signature-mismatch/claims tests using the same verifier |
| Rotated key still cached / unknown `kid`                      | Verified via live JWKS fetch with a bounded, evictable cache (max 4 keys, 7-day TTL); unknown `kid` → 403 `unknown-access-key` | `tests/access-jwt.test.ts` "caches current and rotated Access signing keys without trusting arbitrary issuers"        |
| All failures                                                  | Non-data-bearing plain-text body, `cache-control: private, no-store`                                                           | `worker/index.ts` `createAccessDeniedResponse`; `tests/security-headers.test.ts`                                      |

This matches `AUTH-001` acceptance exactly: current-JWKS signature check,
`iss`/`aud`/`exp`/`nbf`/token-type validation, fail-closed missing
configuration, and non-data-bearing 401/403 responses.

## 3. CSRF / header / CSP review

- **CSRF gate** (`app/mutation-request.ts` `rejectCrossSiteMutation`):
  rejects any mutation where `Sec-Fetch-Site` is present and not
  `same-origin`/`none`, or where `Origin` is present and differs from the
  request's own origin — matching `AUTH-004`'s "reject disallowed
  Origin/Sec-Fetch-Site values." **Finding QA-001A-F1** (fixed in this task):
  seven mutation routes were missing this gate — see §6.
- **Security headers** (`worker/response-security.ts`): every response gets
  `content-security-policy` (`default-src 'self'`, per-request nonce on
  `script-src`, `frame-ancestors 'none'`, `object-src 'none'`),
  `permissions-policy` (camera/geolocation/microphone/payment/usb denied),
  `referrer-policy: no-referrer`, `x-content-type-options: nosniff`,
  `x-frame-options: DENY`. Verified by `tests/security-headers.test.ts`
  against both the unit-level header function and a full rendered response
  from the built worker. Inline `<script>` tags are nonce-rewritten and the
  CSP contains no `'unsafe-inline'` on `script-src`, confirmed by scanning
  every inline script in the rendered HTML.
- **CSP `style-src 'unsafe-inline'`**: present and intentional — the app uses
  inline `style` attributes for computed layout values, not
  attacker-influenced markup, and there is no corresponding `script-src`
  relaxation. Not a finding; documented here for completeness of the CSP
  review.
- **Idempotency/replay**: import commit and destructive reversals require an
  explicit idempotency key plus (for reversal/purge) typed confirmation,
  checked server-side and re-validated against the stored batch/transaction
  version before mutating (`tests/imp-003a.test.ts` "atomic rollback,
  duplicate-file reuse, idempotency, ownership, and confirmation fail
  closed"; `tests/ops-003b.test.ts` "requires exact deletion key,
  cooling-off, final typed confirmation, completed unexpired exact export").
  Manual ledger mutations require a server-issued, single-use key bound to
  `userId+portfolioId+purpose+target` (`tests/ui-005e.test.ts` "server-issued
  keys bind create, reverse, and replacement retries to one owner and
  target").

## 4. Dependency audit

`npm audit` (2026-08-10, full workspace including devDependencies):
**21 vulnerabilities (1 low, 4 moderate, 16 high)**.

All high-severity findings are in transitive dependencies of build/dev
tooling — `next` (production dependency, but used only for type-compatible
imports like `next/headers`/`next/navigation`/`next/link` under vinext's
Next-compatible App Router; the actual runtime is vinext/Vite/Workers, not
Next's own server), `vite`, `wrangler`/`miniflare`/`undici`/`ws` (local dev
server and Cloudflare Workers emulation), and their nested `postcss`/`sharp`
copies. None of these packages, at the versions currently pinned, ship in the
Cloudflare Workers production bundle produced by `vinext build` (confirmed:
`dist/client` contains no `next`, `vite`, `wrangler`, `undici`, or `ws` source
and no Access configuration — see §5).

**Finding QA-001A-F3 (residual risk, Orchestrator-accepted):**
`npm audit fix --force` would upgrade `next` (16.2.6 → 16.3.0), `vite` (8.0.13
→ 8.2.1), and `@cloudflare/vite-plugin` (1.37.1 → 1.51.1, pulling a newer
`wrangler`/`miniflare`) outside the ranges currently pinned in
`package.json`. Per `AGENTS.md`, dependency version changes need documented
need, exact version, lockfile update, and Cloudflare-runtime verification —
this is exactly the kind of change a Worker should not make unilaterally
inside a security-audit task. **Not fixed in this task.**

All 16 high-severity advisories are confirmed confined to the dev/build
toolchain (`next`, `vite`, `wrangler`/`miniflare`/`undici`/`ws`) and are not
part of the production Workers bundle (see confirmation above and §5). The
Orchestrator has reviewed this residual risk and accepted it for the scope of
QA-001A, and has scheduled a dedicated toolchain-upgrade follow-up task
(**DEP-001**) to evaluate and apply the upgrades with a full `vinext
build`/Cloudflare-runtime verification smoke test, tracked separately from
QA-001A. Per this documented risk acceptance, QA-001A's "no high-severity
open finding" completion criterion is satisfied-with-documented-acceptance,
not blocked.

## 5. Private-cache and built-asset audit

- `worker/response-security.ts` sets `cache-control: private, no-store` on
  every response whose path is `/`, `/api*`, `/import*`, or `/portfolio*`
  (`isPrivateRequest`), which covers 100% of the authenticated routes in
  §1's matrix. **Finding QA-001A-F4** (fixed in this task): the root route
  `/` renders `loadAuthenticatedWorkspace(undefined, { includeOverview: true })`
  into `PortfolioShell` (`app/page.tsx`) — authenticated private portfolio
  data — but `isPrivateRequest` originally only matched `/api*`, `/import*`,
  and `/portfolio*`, so `/` responses shipped with no `cache-control` header
  at all, contradicting this section's "100% coverage" claim. Fixed by
  adding an exact `pathname === "/"` match to `isPrivateRequest`, which does
  not affect `/api*`, `/import*`, `/portfolio*` classification and does not
  mark any static-asset path (`/assets/*`, `/sw.js`, `/manifest.webmanifest`,
  `/icon-*.png`, etc.) as private. Verified by `tests/security-headers.test.ts`
  (unit-level and full rendered-response checks) and by inspection of every
  `route.ts` file in §1, all of which also set
  `"cache-control": "private, no-store"` directly on their JSON responses as
  defense in depth.
- `public/sw.js`: the `fetch` handler only intercepts same-origin `GET`
  requests; it caches (via `caches.open`/`cache.addAll`) exactly the five
  entries in `PUBLIC_ASSETS` (favicon, offline page, PWA icons) at install
  time, and for any other GET request it either does a network-only
  passthrough for `navigate` requests (falls back to the cached
  `/offline.html` only on network failure — the live navigation response is
  never cached) or a cache-then-network read scoped to the
  `PUBLIC_ASSETS` allowlist. No `/api/*`, `/portfolio/*`, or `/import/*`
  response is ever written to Cache Storage. Verified by
  `tests/rendered-html.test.mjs` "service worker only caches the public
  offline allowlist" and by direct reading of `public/sw.js`.
- Built client bundle (`dist/client/`, 31 files after `vinext build`):
  `grep`-scanned for `CLOUDFLARE_ACCESS_ISSUER`, `CLOUDFLARE_ACCESS_AUDIENCE`,
  PEM private-key markers, and generic API-key patterns — no matches.
  Confirmed independently by `tests/security-headers.test.ts` "client output
  contains no Cloudflare Access configuration".

## 6. Redacted-error audit

- Every server action/route in `app/*actions.ts` and `app/api/**/route.ts`
  returns a fixed, enumerated `message` string per failure branch — no route
  interpolates a caught `Error#message` or stack trace into a client
  response. The few `error.message`/`String(error)` reads in
  `db/repositories/account-lifecycle.ts` and `app/api/account/*` compare the
  message against a known, narrow pattern (e.g. `/^export_[a-z_]{1,64}$/`,
  `"body_too_large"`, `"export_expired"`) to select which fixed, pre-written
  message to return — the raw error text itself never reaches the client.
  `app/preview-portfolio-fixture.ts` does surface a raw `error.message` for a
  local, non-authenticated, repository-controlled fixture-CSV read failure;
  that path only serves the `/portfolio/preview/*` route, which is
  hard-blocked in production (see §1 exclusions) — not a finding.
- Structured logs (`domain/observability/logger.ts`,
  `domain/observability/redaction.ts`) redact any metadata key matching
  token/API-key/authorization/cookie/secret/password/email/amount/price/
  quantity/balance/cost/value/user-or-portfolio-or-security-id/CSV-content
  patterns, and any string value matching a bearer-JWT, email, or PEM-block
  shape, before emission. Verified by `tests/ops-001.test.ts` "structured log
  snapshots redact user and financial payloads" and "audit events record
  actor, target, result, correlation, and redacted metadata".
- Client-provided `x-request-id` is only echoed back after being validated
  against `^[A-Za-z0-9._:-]{1,128}$` (`domain/observability/request-correlation.ts`),
  preventing header-injection/log-injection via that value. Verified by
  `tests/ops-001.test.ts` "request IDs accept safe correlation and reject
  untrusted header values".

## 7. Manual threat checklist

| #   | Threat                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unauthenticated request to any protected route/page/API returns non-data-bearing 401/403, never rendered content   | Pass — Worker-level Access check runs before routing (`worker/index.ts`); `tests/rendered-html.test.mjs` "server denies unauthenticated requests before rendering private content"                                                                                                                                                                                                                 |
| 2   | Cross-user read/write/delete on portfolios, ledger, imports, overrides, exports, lifecycle                         | Pass — see §1 matrix; every operation scoped by authenticated `userId`, denial tests listed per row                                                                                                                                                                                                                                                                                                |
| 3   | Cross-site (CSRF) mutation via forged form/fetch riding an Access session                                          | Fail found and fixed (QA-001A-F1) — 7 routes were missing the gate; all mutation routes now covered, verified by `tests/qa-001a.test.ts` plus the pre-existing CSRF tests listed in §1/§3                                                                                                                                                                                                          |
| 4   | Replay of a captured mutation request                                                                              | Pass — idempotency keys + version/optimistic-concurrency checks on every mutating repository call (§3)                                                                                                                                                                                                                                                                                             |
| 5   | Client-supplied `user_id`/owner override                                                                           | Pass — no route/action reads a client-supplied owner id; identity is derived solely from the Worker-attached, server-signed `VERIFIED_PRINCIPAL_HEADER` (base64url-encoded verified JWT claims, set only by `worker/index.ts` after signature verification, and explicitly deleted from the inbound request before being re-set, so a client cannot forge it)                                      |
| 6   | Service-token / non-interactive Access identity becoming an interactive user                                       | Pass — `tests/access-jwt.test.ts` "service-token" case (empty `sub`) and `tests/auth-002.test.ts` "JIT policy supports admin-invited identities and does not admit service principals"                                                                                                                                                                                                             |
| 7   | Disabled/deletion-pending/purged account retaining data access                                                     | Pass — `resolveAuthenticatedRequestContext` returns a `lifecycle` failure that short-circuits to an unavailable workspace; `tests/auth-002.test.ts` "revoked identities and disabled users cannot create an authenticated context"; `tests/ops-003a.test.ts`/`tests/ops-003b.test.ts` disable/deletion/purge suites                                                                                |
| 8   | Authenticated HTML/API/import/financial data cached by the browser or service worker (Cache Storage or disk cache) | Fail found and fixed (QA-001A-F4) — the `/` route was missing `cache-control: private, no-store`; now covered — see §5                                                                                                                                                                                                                                                                             |
| 9   | Secrets/config/PII in the built client bundle or logs                                                              | Pass — see §4 (dependency scan didn't need this), §5 (bundle scan), §6 (log redaction)                                                                                                                                                                                                                                                                                                             |
| 10  | SQL injection via interpolated identifiers (table/column names built from request input)                           | Pass — the only interpolated identifiers (`account-lifecycle.ts` export/purge sweeps) come from `sqlite_master` or hardcoded arrays, never request input; every value is bound via `?` placeholders (`db/d1-sql-client.ts`)                                                                                                                                                                        |
| 11  | Reflected/stored XSS via untrusted HTML                                                                            | Pass — no `dangerouslySetInnerHTML`/raw-HTML rendering found in `app/components/`; CSP has no `script-src 'unsafe-inline'` and nonces are rewritten server-side only                                                                                                                                                                                                                               |
| 12  | Clickjacking                                                                                                       | Pass — `x-frame-options: DENY` and `frame-ancestors 'none'` on every response                                                                                                                                                                                                                                                                                                                      |
| 13  | Open redirect via lifecycle/export recovery query parameters                                                       | Pass — `parseExportRecoveryCredentials`/lifecycle status routes validate `requestType`/`idempotencyKey` against strict allowlists/regexes and never redirect based on request input                                                                                                                                                                                                                |
| 14  | Account export/purge job ID guessing across users                                                                  | Verified non-exploitable, documented as §1 note: `authorizeExportJobRequest` returns `true` for any active identity independent of job ownership, but the subsequent `downloadPage`/`processExportJob` calls are always scoped `WHERE id=? AND user_id=?` against the caller's own verified `userId`, so a guessed foreign `jobId` yields `export_not_ready`/404, never another user's export rows |

## 8. Findings summary

| ID         | Severity          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Disposition                                                                                                                                                                                                                               |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-001A-F1 | High              | 7 mutation routes (`POST /api/portfolios`, `PATCH`/`DELETE /api/portfolios/:portfolioId`, `POST /api/portfolios/:portfolioId/restore`, `PATCH /api/settings/holding-currency-view`, `PATCH /api/settings/home-currency`, `POST /api/import/preview`, `PATCH /api/import/preview/:batchId/mappings`) were missing the `rejectCrossSiteMutation` CSRF gate that every sibling mutation route applies, violating `AUTH-004`.                                                 | **Fixed** in this task — gate added ahead of all other work in each route; regression coverage added in `tests/qa-001a.test.ts`                                                                                                           |
| QA-001A-F2 | Informational     | `authorizeExportJobRequest` grants "owns job" for any active identity regardless of the requested `jobId`; the actual data read is independently owner-scoped, so this is not exploitable.                                                                                                                                                                                                                                                                                | No code change — documented in §1/§7 as verified-safe; consider tightening `authorizeExportJobRequest` in a future readability pass (not security-blocking)                                                                               |
| QA-001A-F3 | High (dependency) | `npm audit` reports 16 high-severity advisories, all in dev/build tooling (`next`, `vite`, `wrangler`/`miniflare`/`undici`/`ws`) not present in the Workers production bundle; fixing requires version bumps outside the pinned ranges.                                                                                                                                                                                                                                   | **Residual risk accepted by the Orchestrator** for this task's scope; not an application-level vulnerability in the deployed bundle; follow-up toolchain-upgrade task **DEP-001** scheduled with required Cloudflare-runtime verification |
| QA-001A-F4 | High              | The root route `/` (`app/page.tsx`) renders authenticated private portfolio data via `loadAuthenticatedWorkspace(undefined, { includeOverview: true })` into `PortfolioShell`, but `isPrivateRequest` (`worker/response-security.ts`) only matched `/api*`, `/import*`, `/portfolio*` — so `/` responses carried no `cache-control` header at all, making an authenticated private page cacheable, and contradicting this document's earlier "100% coverage" claim in §5. | **Fixed** in this task — added an exact `pathname === "/"` match to `isPrivateRequest`; regression coverage added in `tests/security-headers.test.ts`; §5 and §7 updated to describe the fix accurately                                   |

No findings remain open at Blocking/High severity within this task's scope
(QA-001A-F1 and QA-001A-F4 are fixed; QA-001A-F3 is a dependency-upgrade
decision outside a Worker's authority, not an active application-level
vulnerability in the deployed bundle, and is satisfied-with-documented-
acceptance per the Orchestrator's risk-acceptance decision above).

## 9. Verification run

- `./node_modules/.bin/prettier --check <changed files>` — pass
- `./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next --ignore-pattern worker-configuration.d.ts` — pass, no findings
- `./node_modules/.bin/tsc --noEmit` — pass
- `./node_modules/.bin/vinext check` — 100% compatible, 0 issues
- `./node_modules/.bin/vinext build` — succeeds, 24 API route handlers + 5 pages built (matches §1's route count)
- `node --experimental-strip-types --test tests/*.test.ts tests/*.test.mjs` — 280 passed, 0 failed, 2 skipped (pre-existing, opt-in loopback-Miniflare D1 drills gated behind `OPS003A_D1_DRILL`/`OPS003B_D1_DRILL` env vars, unrelated to this task)
- `npm audit` — see §4
- `dist/client` secret/config scan — see §5

`npm run check` (repository-wide Prettier + ESLint + `tsc` + `vinext
check`/`build` + full test run) passes end-to-end. `.claude/` and `.gemini/`
were added to `.prettierignore` (Orchestrator-approved) so Prettier no longer
reformats pre-existing, out-of-scope agent-tooling config/docs that predate
this task and are not part of QA-001A; no content under those directories was
changed.
