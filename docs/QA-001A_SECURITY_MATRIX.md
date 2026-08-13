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

| Route / action                                                                                                                                   | Method        | Owner scope                                                                                                                                                                                                                                                                                                                              | CSRF                                                                      | Denial-test evidence                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/portfolios` (`app/api/portfolios/route.ts` → `createPortfolioAction`)                                                                      | POST          | `getAuthenticatedSqlContext()` → `context.userId`                                                                                                                                                                                                                                                                                        | Yes (fixed in this task)                                                  | `tests/qa-001a.test.ts` (CSRF); `tests/db-001b.test.ts` "owned portfolio repositories deny cross-user reads, writes, and optimistic conflicts"; `tests/ops-001.test.ts` "portfolio mutation rolls back when its audit append fails"                                                                                                                                                                                 |
| `/api/portfolios/:portfolioId` (`app/api/portfolios/[portfolioId]/route.ts` → `renamePortfolioAction`)                                           | PATCH         | `getAuthenticatedSqlContext(portfolioId)` scopes the row via `WHERE ... user_id = ?`                                                                                                                                                                                                                                                     | Yes (fixed)                                                               | `tests/qa-001a.test.ts`; `tests/db-001b.test.ts` cross-user denial                                                                                                                                                                                                                                                                                                                                                  |
| `/api/portfolios/:portfolioId` (`archivePortfolioAction`)                                                                                        | DELETE        | same                                                                                                                                                                                                                                                                                                                                     | Yes (fixed)                                                               | `tests/qa-001a.test.ts`; `tests/db-001b.test.ts` cross-user denial                                                                                                                                                                                                                                                                                                                                                  |
| `/api/portfolios/:portfolioId/restore` (`restorePortfolioAction`)                                                                                | POST          | same                                                                                                                                                                                                                                                                                                                                     | Yes (fixed)                                                               | `tests/qa-001a.test.ts`; `tests/db-001b.test.ts` cross-user denial                                                                                                                                                                                                                                                                                                                                                  |
| `/api/portfolios/:portfolioId/ledger` (`createManualLedgerAction`)                                                                               | POST          | `authenticatedContext(portfolioId)` → `context.userId`; `createManualLedgerMutationKeyRepository.authorize` re-binds the server-issued key to `userId+portfolioId`                                                                                                                                                                       | Yes (pre-existing, `manual-ledger-route.ts`)                              | `tests/ui-005e.test.ts` "route boundary enforces CSRF, private responses, ownership, and double submit"; `tests/led-001b.test.ts` cross-owner idempotency isolation                                                                                                                                                                                                                                                 |
| `/api/portfolios/:portfolioId/ledger/:transactionId/reverse`                                                                                     | POST          | same, target transaction resolved through `userId+portfolioId`                                                                                                                                                                                                                                                                           | Yes (pre-existing)                                                        | `tests/led-001b.test.ts`; `tests/ui-005e.test.ts`                                                                                                                                                                                                                                                                                                                                                                   |
| `/api/portfolios/:portfolioId/ledger/:transactionId/supersede`                                                                                   | POST          | same                                                                                                                                                                                                                                                                                                                                     | Yes (pre-existing)                                                        | `tests/led-001b.test.ts` "reversal and supersession preserve source facts and rebuild markers"                                                                                                                                                                                                                                                                                                                      |
| `/api/portfolios/:portfolioId/ledger/key` (`issueManualLedgerKeyAction`)                                                                         | POST          | same                                                                                                                                                                                                                                                                                                                                     | Yes (pre-existing)                                                        | `tests/ui-005e.test.ts` "server-issued keys bind create, reverse, and replacement retries to one owner and target"                                                                                                                                                                                                                                                                                                  |
| `/api/settings/holding-currency-view` (`changeHoldingCurrencyViewAction`)                                                                        | PATCH         | `getAuthenticatedSqlContext()` → `context.userId`                                                                                                                                                                                                                                                                                        | Yes (fixed)                                                               | `tests/qa-001a.test.ts`                                                                                                                                                                                                                                                                                                                                                                                             |
| `/api/settings/home-currency` (`changeHomeCurrencyAction`)                                                                                       | PATCH         | same                                                                                                                                                                                                                                                                                                                                     | Yes (fixed)                                                               | `tests/qa-001a.test.ts`; `tests/ops-001.test.ts` "home-currency mutation rolls back when its audit append fails"                                                                                                                                                                                                                                                                                                    |
| `/api/settings/financial-year` (`changeFinancialYearStartMonthAction`)                                                                           | POST          | `getAuthenticatedSqlContext()` → `context.userId`; `setFinancialYearStartMonth` scopes its `UPDATE ... WHERE user_id = ? AND version = ?`                                                                                                                                                                                                | Yes (new in this task, `app/api/settings/financial-year/route.ts`)        | `tests/fy-001b.test.ts` "the route imports and calls rejectCrossSiteMutation before reading the request body"; "setFinancialYearStartMonth persists, bumps the version, and the change is visible on the read path"; "a stale expectedVersion is rejected as version_conflict and does not change the stored value"; "another owner's version cannot be used to change this owner's setting (cross-user isolation)" |
| `/api/import/preview` (`createImportPreviewAction`)                                                                                              | POST          | `getAuthenticatedSqlContext()`; target portfolio re-checked via `createOwnedPortfolioRepository(...).get(userId, targetPortfolioId)`                                                                                                                                                                                                     | Yes (fixed)                                                               | `tests/qa-001a.test.ts`; `tests/imp-003a.test.ts` (upload/commit ownership)                                                                                                                                                                                                                                                                                                                                         |
| `/api/import/preview/:batchId/mappings` (`saveImportMappingAction`)                                                                              | PATCH         | `staging.get(userId, batchId)` scopes the batch                                                                                                                                                                                                                                                                                          | Yes (fixed)                                                               | `tests/qa-001a.test.ts`; `tests/imp-002b.test.ts` "mapping decisions are owner-scoped and reusable by batch"                                                                                                                                                                                                                                                                                                        |
| `/api/import/preview/:batchId/ready` (`createImportReadyPost` → `markImportReadyWithContext`)                                                    | POST          | `staging.get(userId, batchId)` scopes the batch; server-side reconciliation/issue recomputation is scoped to the same `userId`                                                                                                                                                                                                           | Yes (new in this task, `app/import-ready-route.ts`)                       | `tests/imp-004a.test.ts` "ready route enforces CSRF before its authenticated action"; "readiness action rejects malformed input, a stale version, wrong status, and another owner's batch"                                                                                                                                                                                                                          |
| `/api/import/preview/:batchId` (`loadImportPreviewAction`)                                                                                       | GET           | `getAuthenticatedSqlContext()`; `staging.get(userId, batchId)` scopes the batch                                                                                                                                                                                                                                                          | N/A (read, new in this task, `app/api/import/preview/[batchId]/route.ts`) | `tests/imp-004b.test.ts` "verify action rejects malformed input, a stale version, and another owner's batch" exercises the same owner-scoped `loadReview`; `tests/ui-005b.test.ts` "import review offers server-side security verification, a PORTFOLIO_MAPPING_INVALID card, and a refresh-preview affordance"                                                                                                     |
| `/api/import/preview/:batchId/securities/verify` (`createSecurityVerifyPost` → `verifySecurityCandidateWithContext`)                             | POST          | `staging.get(userId, batchId)` scopes the batch; the candidate's portfolio is re-checked via `createOwnedPortfolioRepository(...).get(userId, portfolioId)`; the requested symbol/exchange/currency must match a currently unresolved candidate in the server's own recomputed preview, never trusted from the request body              | Yes (new in this task, `app/security-verification-route.ts`)              | `tests/imp-004b.test.ts` "verify route enforces CSRF before its authenticated action"; "verify action rejects malformed input, a stale version, and another owner's batch"                                                                                                                                                                                                                                          |
| `/api/import/commit/:batchId` (`commitImportAction`)                                                                                             | POST          | owner-scoped batch resolution                                                                                                                                                                                                                                                                                                            | Yes (pre-existing)                                                        | `tests/imp-003a.test.ts` "commit route rejects cross-site mutation before authentication or parsing"; "atomic rollback, duplicate-file reuse, idempotency, ownership, and confirmation fail closed"                                                                                                                                                                                                                 |
| `/api/import/commit/:batchId/reverse` (`reverseImportAction`)                                                                                    | POST          | same                                                                                                                                                                                                                                                                                                                                     | Yes (pre-existing)                                                        | `tests/imp-003b.test.ts` "reversal route enforces CSRF before its authenticated action and returns private progress"; "direct reversal denies another owner without changing the batch"                                                                                                                                                                                                                             |
| `/api/import/history` (`loadImportHistoryAction`)                                                                                                | GET           | `getAuthenticatedSqlContext()` → `listBatches(userId)`                                                                                                                                                                                                                                                                                   | N/A (read)                                                                | `tests/imp-002b.test.ts`; `tests/import-staging.test.ts` "denies cross-user access and enforces row bounds with foreign keys enabled"                                                                                                                                                                                                                                                                               |
| `/api/import/history/:batchId` (`loadImportBatchHistoryAction`)                                                                                  | GET           | same, batch resolved by `userId`                                                                                                                                                                                                                                                                                                         | N/A (read)                                                                | `tests/ui-005c.test.ts` "history detail is owner-scoped, bounded, and exposes durable resume progress"                                                                                                                                                                                                                                                                                                              |
| `/api/market-data/overrides` (`listManualOverrideAction`)                                                                                        | GET           | `authenticatedSqlContext(portfolioId)`                                                                                                                                                                                                                                                                                                   | N/A (read)                                                                | `tests/mkt-003a.test.ts` "manual overrides are owner-scoped, interval-conflict checked, supersedable, and removable"                                                                                                                                                                                                                                                                                                |
| `/api/market-data/overrides` (`saveManualOverrideAction` / `removeManualOverrideAction`)                                                         | POST / DELETE | same; override target re-verified against `portfolio_securities`/portfolio ownership before writing                                                                                                                                                                                                                                      | Yes (pre-existing)                                                        | `tests/ui-004.test.ts` "market-data mutation endpoints reject cross-site browser requests"; `tests/mkt-003a.test.ts` ownership/atomic-failure cases                                                                                                                                                                                                                                                                 |
| `/api/market-data/refresh` (`requestMarketDataRefreshAction`)                                                                                    | POST          | `authenticatedSqlContext(portfolioId)`; target rows filtered by `ps.user_id = ?`                                                                                                                                                                                                                                                         | Yes (pre-existing)                                                        | `tests/ui-004.test.ts` "market-data mutation endpoints reject cross-site browser requests"; "refresh ranges are bounded, concurrent requests coalesce, and completion cools down"                                                                                                                                                                                                                                   |
| `/api/account/lifecycle` (`requestAccountLifecycleAction`)                                                                                       | POST          | `getAuthenticatedSqlContext()`/`getVerifiedPrincipalSqlContext()` → repository calls scoped by `userId`                                                                                                                                                                                                                                  | Yes (pre-existing)                                                        | `tests/ops-003b.test.ts` "lifecycle route applies CSRF before auth, bounded body, and no-store"; `tests/ops-003a.test.ts` "lifecycle repository rejects a cross-owner actor"                                                                                                                                                                                                                                        |
| `/api/account/lifecycle/status`                                                                                                                  | GET           | principal-derived issuer/subject only; row resolved through `user_identities`/`account_lifecycle_requests`                                                                                                                                                                                                                               | N/A (read)                                                                | `tests/ops-003a.test.ts` "revoked principal recovery requires the exact request type and key"                                                                                                                                                                                                                                                                                                                       |
| `/api/account/export/:jobId` (download)                                                                                                          | GET           | `identity.userId` from `findAccessIdentity(issuer, subject)`; `downloadPage(userId, jobId, ...)` is `WHERE id=? AND user_id=?`, so a guessed/foreign `jobId` returns `export_not_ready`/404 even though `authorizeExportJobRequest` short-circuits true for any active identity (see finding QA-001A-F2 below, verified non-exploitable) | N/A (read)                                                                | `tests/ops-003a.test.ts` "export is owner-scoped, includes an exact manifest, and does not purge"; "export route authorization requires exact credentials only for revoked identities"                                                                                                                                                                                                                              |
| `/api/account/export/:jobId/process`                                                                                                             | POST          | same scoping as download; `processExportJob(userId, jobId, ...)`                                                                                                                                                                                                                                                                         | Yes (pre-existing)                                                        | `tests/ops-003a.test.ts` "export route authorization requires exact credentials only for revoked identities" (contains the route's CSRF 403 assertion); export atomicity: "unexpected export errors atomically persist one stable failed outcome"                                                                                                                                                                   |
| Portfolio pages `/`, `/portfolio/:id/:section`, `/portfolio/:id/:section/:holdingId`, `/portfolio/:id/ledger/new`                                | GET (render)  | `loadAuthenticatedWorkspace(portfolioId)` → `resolveAuthenticatedRequestContext`                                                                                                                                                                                                                                                         | N/A (render)                                                              | `tests/rendered-html.test.mjs` "server denies unauthenticated requests before rendering private content"; `tests/ui-003.test.ts` "UI-003 loads a published owner projection with inverse-safe FX and denies cross-owner access"; `tests/ui-002.test.ts` "UI-002 published snapshot lookup is owner-scoped"                                                                                                          |
| `/portfolio/:id/income`, `/portfolio/:id/income/multi-year` (UI-006A, `app/portfolio/[portfolioId]/income/page.tsx` / `.../multi-year/page.tsx`) | GET (render)  | same pattern via `loadAuthenticatedWorkspace(portfolioId)` then `getAuthenticatedSqlContext(portfolioId)` → `loadOwnedIncomeProjection(client, userId, portfolioId, ...)`, which itself re-checks `portfolios WHERE id = ? AND user_id = ?` before returning any projection data                                                         | N/A (render)                                                              | `tests/ui-006a.test.ts` "Income routes are owner-scoped, no-store, and never render a fabricated projection"                                                                                                                                                                                                                                                                                                        |
| `/import` page                                                                                                                                   | GET (render)  | same pattern via `getAuthenticatedSqlContext`                                                                                                                                                                                                                                                                                            | N/A (render)                                                              | `tests/import-staging.test.ts`; `tests/imp-003a.test.ts`                                                                                                                                                                                                                                                                                                                                                            |
| Scheduled market-data refresh (`worker/scheduled-refresh.ts`, Cron trigger, no HTTP surface)                                                     | n/a           | Not user-scoped by design: jobs operate on deployment-scope provider mappings only (`scope: { kind: "deployment", userId: null }`), never per-user portfolio rows                                                                                                                                                                        | N/A — not reachable via HTTP, no Access boundary applies                  | `tests/mkt-003b.test.ts` "limits Cron work to bounded job and provider request budgets"; "scheduled handler is durable and does not use waitUntil for refresh work"                                                                                                                                                                                                                                                 |

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

`npm audit` (2026-08-10, full workspace including devDependencies), as
refreshed by **DEP-001** (dev/build toolchain upgrade, superseding the
original QA-001A snapshot below):
**6 vulnerabilities (0 low, 4 moderate, 2 high)**, down from the original
**21 vulnerabilities (1 low, 4 moderate, 16 high)** recorded when QA-001A was
first evidenced.

**Finding QA-001A-F3 (resolved by DEP-001, 1 high advisory intentionally
retained with documented justification):** DEP-001 upgraded the dev/build
toolchain within `AGENTS.md`'s dependency rules (documented need, exact
version, lockfile update, Cloudflare-runtime verification):

| Package                    | Before       | After              | Major?                       |
| -------------------------- | ------------ | ------------------ | ---------------------------- |
| `next`                     | 16.2.6       | 16.3.0             | No                           |
| `eslint-config-next`       | 16.2.6       | 16.3.0             | No                           |
| `react`                    | 19.2.6       | 19.2.8             | No                           |
| `react-dom`                | 19.2.6       | 19.2.8             | No                           |
| `react-server-dom-webpack` | 19.2.6       | 19.2.8             | No                           |
| `vite`                     | 8.0.13       | 8.2.1              | No                           |
| `@cloudflare/vite-plugin`  | 1.37.1       | 1.51.1             | No                           |
| `wrangler`                 | 4.92.0       | 4.120.0            | No                           |
| `miniflare` (transitive)   | 4.20260515.0 | 5.20260801.1-alpha | **Yes** (major + prerelease) |
| `workerd` (transitive)     | 1.20260515.1 | 1.20260801.1       | No                           |

The eight rows above are the direct package-level bumps DEP-001 made, each
non-major. However, bumping `wrangler` transitively carries `miniflare`
across a **major version, into a prerelease/alpha** (`4.20260515.0` →
`5.20260801.1-alpha`), and `workerd` along with it. This is not "all upgrades
stayed within their existing major version" — the transitive `miniflare`
jump is a real major/prerelease change and is called out explicitly rather
than glossed over. It was not accepted on trust: both env-gated
Miniflare-backed D1 drill suites (`tests/ops-003a.test.ts`,
`tests/ops-003b.test.ts`) were run directly against the upgraded toolchain
(27 passed, 0 failed — see the Cloudflare-runtime verification below),
confirming the Worker executes correctly against the new `miniflare` major,
not merely that it type-checks or builds.

**Explicit `miniflare` devDependency pin added by DEP-001:**
`tests/ops-003a.test.ts` and `tests/ops-003b.test.ts` `import` `miniflare`
directly for their loopback D1 drills, but prior to this correction
`miniflare` was not a declared `package.json` dependency at all — it only
resolved transitively through `wrangler`'s (and `@cloudflare/vite-plugin`'s)
dependency tree. That is fragile: a future `wrangler`/`@cloudflare/vite-plugin`
bump could change or drop the transitive `miniflare` version out from under
the drill harness with no `package.json` signal. `miniflare` is now pinned
as an exact devDependency at `5.20260801.1-alpha` — the version already
resolved transitively at the time of this fix (confirmed via `npm ls
miniflare`) — so the pin changes nothing about what gets installed today; it
only makes the drill harness's dependency explicit and gives it its own
lockfile entry to bump deliberately in future. `npm ls miniflare` after the
pin still shows a single deduped `5.20260801.1-alpha` install (both
`@cloudflare/vite-plugin` and `wrangler`'s copies resolve to the same
hoisted node_modules entry as the new direct devDependency) — no duplicate
`miniflare` copy was introduced.

This resolved every high-severity advisory across 14 of the 16 originally
affected packages — `@cloudflare/vite-plugin`, `brace-expansion`,
`fast-uri`, `js-yaml`, `miniflare`, `nanoid`, `next`, `postcss`,
`react-server-dom-webpack`, `sharp`, `undici`, `vite`, `wrangler`, and `ws`
— via the direct upgrades in the table above plus `npm audit fix` for the
transitive ESLint-tool-chain advisories (`brace-expansion`, `fast-uri`,
`js-yaml`; no direct pin changes required for those three). The remaining 2
of the original 16 (`image-size` and `vinext`, counted high solely because
it depends on `image-size`) are not fixed and are documented immediately
below.

**One high-severity issue remains, carried by a single unfixable package,
with no upstream fix and no code change possible:** `image-size@2.0.2` (a
transitive dependency of `vinext`, used only at build/dev time inside
`vinext`'s metadata-route/static-image-size inference — confirmed by
inspecting `node_modules/vinext/dist/index.js` and
`node_modules/vinext/dist/server/metadata-route-build-data.js`, the only two
files that import it) carries two unpatched DoS GHSAs —
[GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
[GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
(infinite loops parsing malformed ICNS/JXL/HEIF image data). `npm audit`
reports this as **2 high-severity package entries** — `image-size` itself,
plus `vinext` counted high solely because it depends on `image-size` — not
two independently vulnerable packages requiring separate remediation.
`image-size`'s latest published release is `2.0.2` itself — there is no
fixed version to upgrade to. `npm audit fix --force`'s only suggested "fix"
is downgrading `vinext` to `0.0.45`, the last release before `image-size`
became a dependency at all; that is a feature removal, not a security fix,
and downgrading a direct production dependency to chase a phantom fix is out
of DEP-001's "smallest upgrade that clears the advisory" mandate. Risk is
low and accepted: `image-size` here only ever processes this repository's
own known, developer-controlled image assets under `public/`/`app/` at
build time (`vinext build`) — never a request body, an uploaded file, or any
other attacker-controlled input at runtime — so the DoS is not reachable
from the deployed Workers bundle or from CSV/import/portfolio request
handling. **Residual risk accepted; tracked here, no further follow-up task
required unless `image-size` ships a fix or `vinext` drops the dependency,**
at which point a routine dependency bump (not a new task) is sufficient.

The pre-existing moderate `esbuild`/`@esbuild-kit/*`/`drizzle-kit` advisory
chain (4 moderate) is unchanged by DEP-001 and was already out of scope: the
only fix path is downgrading `drizzle-kit` to `0.18.1` (`isSemVerMajor:
true`), a disruptive major regression of the schema-migration tool for a
moderate-severity, dev-only advisory. Not addressed here; DEP-001's
acceptance criterion is "no undispositioned **high**-severity advisory,"
which is now met.

All packages implicated in the original 16 high advisories — `next`, `vite`,
`wrangler`/`miniflare`/`undici`/`ws`, and their nested `postcss`/`sharp`
copies — are confirmed confined to the dev/build toolchain and are not part
of the production Workers bundle produced by `vinext build` (confirmed:
`dist/client` contains no `next`, `vite`, `wrangler`, `undici`, or `ws`
source and no Access configuration — see §5). Per this documented
disposition, QA-001A's "no high-severity open finding" completion criterion
remains satisfied: the one retained high-severity issue (`image-size`,
counted twice by `npm audit` as `image-size` plus its dependent `vinext`)
has an explicit written risk acceptance above, and every other high
advisory is fixed.

**Cloudflare-runtime verification performed for DEP-001:** `vinext check`
(100% compatible, 0 issues), `vinext build` (succeeds, 24 API route handlers

- 5 pages, matching §1's route count at the time of this DEP-001
  verification — see the route-count reconciliation immediately below for the
  current, re-verified total), the full automated suite (290 passed, 0
  failed, 2 skipped — see below), and both env-gated loopback-Miniflare D1
  drills run explicitly against the upgraded `wrangler`/`miniflare`
  (`OPS003A_D1_DRILL=1 OPS003B_D1_DRILL=1 node --experimental-strip-types
--test tests/ops-003a.test.ts tests/ops-003b.test.ts`): 27 passed, 0 failed —
  "synthetic non-production D1 drill completes, traverses, and preserves
  source rows" and "isolated loopback D1 deletion drill completes and
  preserves the other owner" both pass against a real Miniflare-backed D1
  instance under the new toolchain, confirming the Worker executes correctly
  under `wrangler` 4.120.0/`@cloudflare/vite-plugin` 1.51.1, not just that it
  compiles. One test assertion (`tests/runtime-config.test.ts` "wrangler
  source and generated worker config stay aligned with the task profile") was
  updated to expect a `migrations_dir` field that the upgraded
  `wrangler`/`@cloudflare/vite-plugin` now adds by default to every generated
  `d1_databases` entry; this repository applies D1 migrations via explicit
  `drizzle/*.sql` files and `wrangler d1 execute`
  (`docs/OPS-002_BACKUP_RESTORE_RUNBOOK.md`), never `wrangler d1 migrations
apply`, so the field is inert generated metadata, not a behavior change.

**Route-count reconciliation (verified 2026-08-13, corrected 2026-08-13
after a first pass mislabeled the methodology):** this document tracks two
distinct, reproducible counts, not one:

- **API route PATHS** — one per `app/api/**/route.ts` file:
  `find app/api -name route.ts | wc -l` → **25**, matching `vinext build`'s
  printed route tree (25 `λ` rows).
- **Exported HTTP-method handlers** — `export async function
GET/POST/PATCH/PUT/DELETE` per route file. Most files export one, but
  `/api/market-data/overrides` exports 3 (`GET`/`POST`/`DELETE`) and
  `/api/portfolios/:portfolioId` exports 2 (`PATCH`/`DELETE`), so the
  current 25 paths expose **28** handlers in total.

The DEP-001-time snapshot above ("24 API route handlers + 5 pages") and
the later addendum claiming §1 had "grown to 28 API route handlers" (24
plus four named per-task additions: IMP-004A's
`POST /api/import/preview/:batchId/ready`, IMP-004B's
`GET /api/import/preview/:batchId` and
`POST /api/import/preview/:batchId/securities/verify`, and FY-001B's
`POST /api/settings/financial-year`) were both stated under this same
handler-counting methodology and are **both correct** — verified against
commit `7f9a47c` (24 handlers/5 pages) plus the four named additions = 28.
A prior version of this reconciliation wrongly accused that addendum's
arithmetic of never matching a rebuild; that accusation is retracted.

Pages are unambiguous — one count only: `find app -name page.tsx | wc -l`
→ **7**. No `_sites-preview` exclusion is needed; that directory contains
no `page.tsx`.

UI-006A added 2 new pages (`/portfolio/:id/income` and
`/portfolio/:id/income/multi-year`) and 0 new API paths or handlers, so the
current, single source of truth is **25 API route paths exposing 28
exported HTTP-method handlers, plus 7 pages**.

Separately, `vinext check`'s own summary line ("30 route handler(s)") is
**not** a route or handler count and must never be cited as one: it is a
filename-suffix match over every `*route.ts` file anywhere under `app/`,
which also catches 5 non-route service modules at the app root
(`app/import-history-route.ts`, `app/import-ready-route.ts`,
`app/import-reversal-route.ts`, `app/manual-ledger-route.ts`,
`app/security-verification-route.ts` — factory functions consumed BY the
real `app/api/**/route.ts` handlers, not routes themselves). 25 real route
files + 5 non-route modules = the 30 `vinext check` reports.

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

| ID         | Severity          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-001A-F1 | High              | 7 mutation routes (`POST /api/portfolios`, `PATCH`/`DELETE /api/portfolios/:portfolioId`, `POST /api/portfolios/:portfolioId/restore`, `PATCH /api/settings/holding-currency-view`, `PATCH /api/settings/home-currency`, `POST /api/import/preview`, `PATCH /api/import/preview/:batchId/mappings`) were missing the `rejectCrossSiteMutation` CSRF gate that every sibling mutation route applies, violating `AUTH-004`.                                                 | **Fixed** in this task — gate added ahead of all other work in each route; regression coverage added in `tests/qa-001a.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| QA-001A-F2 | Informational     | `authorizeExportJobRequest` grants "owns job" for any active identity regardless of the requested `jobId`; the actual data read is independently owner-scoped, so this is not exploitable.                                                                                                                                                                                                                                                                                | No code change — documented in §1/§7 as verified-safe; consider tightening `authorizeExportJobRequest` in a future readability pass (not security-blocking)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| QA-001A-F3 | High (dependency) | `npm audit` originally reported 16 high-severity advisories, all in dev/build tooling (`next`, `vite`, `wrangler`/`miniflare`/`undici`/`ws`) not present in the Workers production bundle.                                                                                                                                                                                                                                                                                | **Resolved by DEP-001** — non-major direct upgrades to `next`, `react`/`react-dom`/`react-server-dom-webpack`, `vite`, `@cloudflare/vite-plugin`, and `wrangler` (see §4 table), which transitively moved `miniflare` across a major version (`4.x` → `5.x-alpha`), together cleared 14 of the original 16 high-severity packages. The remaining 2 (`image-size` and `vinext`, counted high solely as its dependent) share one unfixable root cause with no upstream fix and are documented as an accepted, build-time-only, non-reachable risk in §4. Full quality gate and Miniflare-backed D1 drills (validating the transitive `miniflare` major bump) re-verified on the upgraded toolchain. |
| QA-001A-F4 | High              | The root route `/` (`app/page.tsx`) renders authenticated private portfolio data via `loadAuthenticatedWorkspace(undefined, { includeOverview: true })` into `PortfolioShell`, but `isPrivateRequest` (`worker/response-security.ts`) only matched `/api*`, `/import*`, `/portfolio*` — so `/` responses carried no `cache-control` header at all, making an authenticated private page cacheable, and contradicting this document's earlier "100% coverage" claim in §5. | **Fixed** in this task — added an exact `pathname === "/"` match to `isPrivateRequest`; regression coverage added in `tests/security-headers.test.ts`; §5 and §7 updated to describe the fix accurately                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

No findings remain open at Blocking/High severity within this task's scope
(QA-001A-F1 and QA-001A-F4 are fixed; QA-001A-F3 is resolved by DEP-001,
with its one remaining high-severity issue — `image-size`, counted twice by
`npm audit` as `image-size` plus its dependent `vinext` — carrying an
explicit, justified risk acceptance in §4 because no upstream fix exists).

## 9. Verification run

- `./node_modules/.bin/prettier --check <changed files>` — pass
- `./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next --ignore-pattern worker-configuration.d.ts` — pass, no findings
- `./node_modules/.bin/tsc --noEmit` — pass
- `./node_modules/.bin/vinext check` — 100% compatible, 0 issues
- `./node_modules/.bin/vinext build` — succeeds, 24 API route handlers + 5 pages built (matched §1's route count as of this QA-001A verification; see the route-count reconciliation in §4 for the current, re-verified total of 25 API route paths exposing 28 exported HTTP-method handlers, plus 7 pages, as of UI-006A)
- `node --experimental-strip-types --test tests/*.test.ts tests/*.test.mjs` — 280 passed, 0 failed, 2 skipped (pre-existing, opt-in loopback-Miniflare D1 drills gated behind `OPS003A_D1_DRILL`/`OPS003B_D1_DRILL` env vars, unrelated to this task)
- `npm audit` — see §4
- `dist/client` secret/config scan — see §5

`npm run check` (repository-wide Prettier + ESLint + `tsc` + `vinext
check`/`build` + full test run) passes end-to-end. `.claude/` and `.gemini/`
were added to `.prettierignore` (Orchestrator-approved) so Prettier no longer
reformats pre-existing, out-of-scope agent-tooling config/docs that predate
this task and are not part of QA-001A; no content under those directories was
changed.

### DEP-001 re-verification (2026-08-10, post dev/build toolchain upgrade)

- `npm audit` — 6 vulnerabilities (0 low, 4 moderate, 2 high), down from 21
  (1 low, 4 moderate, 16 high); disposition in §4.
- `npm run check` — passes end-to-end on the upgraded toolchain (Prettier,
  ESLint, `tsc`, `vinext check` at 100% compatible, `vinext build`, full
  test suite: 290 passed, 0 failed, 2 skipped).
- `OPS003A_D1_DRILL=1 OPS003B_D1_DRILL=1 node --experimental-strip-types
--test tests/ops-003a.test.ts tests/ops-003b.test.ts` — 27 passed, 0
  failed; both loopback-Miniflare D1 drills executed against the upgraded
  `wrangler`/`@cloudflare/vite-plugin`, confirming Worker/D1 execution
  correctness under the new toolchain (not just successful compilation).
- `tests/runtime-config.test.ts` updated to expect the `migrations_dir`
  field the upgraded toolchain now adds by default to generated
  `d1_databases` entries; see §4 for why this is inert generated metadata
  rather than a behavior change.

### IMP-004B addition (2026-08-11)

Two new fixed routes: `POST /api/import/preview/:batchId/securities/verify`
(`createSecurityVerifyPost`, CSRF gated first, owner-scoped, request fields
re-validated against the server's own recomputed preview) and
`GET /api/import/preview/:batchId` (`loadImportPreviewAction`, read-only, no
CSRF gate — matches every other GET route in §1). `npm run check` passes
end-to-end (prettier, eslint, `tsc --noEmit`, `vinext check` at 100%
compatible, `vinext build`, full test suite: 311 passed, 0 failed, 7 skipped
— the pre-existing env-gated D1 drills, unrelated to this task). New tests:
`tests/imp-004b.test.ts` (verify-success with recorded provenance,
dedupe-link to an existing published identity, sequential/concurrent-style
verify requests for the same identity produce no duplicate canonical rows,
provider mismatch/ambiguity/not-found/rate-limit as explicit failures with
the candidate left unresolved, provider-disabled explicit failure, CSRF, and
malformed/stale/cross-owner denial; plus an acceptance drill that stages the
real `docs/Example_Portfolio.csv` — 244 rows, 115 transactions — on an
account with zero pre-existing securities and drives every brand-new symbol
through verify with a fixture provider until the batch commits, asserting
one published `securities` row per held candidate) and additions to
`tests/qa-001b.test.ts`/`tests/ui-005b.test.ts` covering the new UI's 44px
touch targets, labels, and CSRF/route wiring markers.
