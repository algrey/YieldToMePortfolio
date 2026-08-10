# QA-002 — Preview UAT and release readiness

Status: evidence for the QA-002 task (`TASKS.md`). Requirements: OPS-002,
OPS-003, QUAL-002. Normative sections routed for this task: `Success
measures` and the full `Product state contract` in
`docs/CONSOLIDATED_PRODUCT_SPEC.md`; `Phase gates`, `First release slices`,
and `Testing strategy` in `docs/IMPLEMENTATION_PLAN.md`; `OPS-002`,
`OPS-003`, `QUAL-002` in `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md`;
`Operational design` in `docs/ARCHITECTURE.md`; the staged-workflow,
idempotency, and reversal sections of `docs/CSV_IMPORT_SPEC.md`.

This document is the release-readiness record for the whole v1 slate. It does
not re-derive evidence that QA-001A (security/tenant-isolation) and QA-001B
(accessibility/responsive) already produced — it cites and re-verifies those,
then adds the release-wide gates that are QA-002's own scope: dependency
completeness, the automated quality gate, preview-environment route/mutation
smoke, supplied-CSV end-to-end evidence, calculation reconciliation, backup
and verified-deletion drills, redacted observability evidence, and the named
owner-run items (Access invite/offboard, physical iPhone/PWA, VoiceOver, 200%
zoom) with a final go/no-go record. Every result below is either a command
this task actually ran (with its real output) or a row explicitly marked
**REQUIRES OWNER RUN** — nothing here is a fabricated manual result.

## 1. Dependency completeness

`TASKS.md` status for every task this task depends on, checked directly
against the file (2026-08-10):

| Task     | Status                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| UI-002   | DONE (2026-08-09 browser QA follow-up)                                                                               |
| UI-003   | DONE (2026-08-09 browser QA complete)                                                                                |
| UI-004   | DONE (2026-08-03)                                                                                                    |
| UI-005D  | DONE (2026-08-04)                                                                                                    |
| UI-005E  | DONE (2026-08-03)                                                                                                    |
| PWA-001  | DONE (2026-08-02)                                                                                                    |
| OPS-002  | DONE (2026-08-03)                                                                                                    |
| OPS-003A | DONE (2026-08-10) — not a listed QA-002 dependency, but OPS-003B depends on it and both are exercised together below |
| OPS-003B | DONE (2026-08-10)                                                                                                    |
| QA-001A  | DONE (2026-08-10)                                                                                                    |
| QA-001B  | DONE (2026-08-10)                                                                                                    |

Every other `TASKS.md` task is `DONE` except four explicitly `DEFERRED,` not
required by the v1 release (`SPK-003` future broker sync, `DB-005`
corporate-action/dividend schema, `MKT-005` corporate-action/dividend
provider capability, `DIV-001` dividend events/receipts/forecasts) and
`QA-002` itself (this task, the last item in the backlog). No task is
`PENDING`, `IN PROGRESS`, or `BLOCKED` other than this one.

## 2. Automated quality gate (QUAL-002)

Command: `npm run check` (Prettier check, ESLint, `tsc --noEmit`, `vinext
check`, `vinext build`, full `node --test` suite).

Result: **PASS** — 292 tests, 290 passed, 0 failed, 2 skipped (the two
env-gated Miniflare D1 drills below, which are skipped by default because
they need a loopback listener; run explicitly in §6). `vinext check`: 100%
compatible, 0 issues, reporting 5 page(s) and 24 route handler(s) from its
static project-structure scan. `vinext build` succeeds and prints its own
route table classified by build output: 21 `λ` (API) routes, 4 `ƒ` (dynamic)
pages, and 1 `?` (unclassified — the root `/`); its classification method
differs from `vinext check`'s static scan, so the two counts are not
expected to match term-for-term.

This matches QUAL-002's acceptance exactly: formatting, lint, strict
TypeScript typecheck, production build, and the full unit/integration/render
suite pass together as one deterministic, documented command; a failed
required check blocks completion (none did).

## 3. Preview environment: build, harness, and route/mutation smoke

### 3.1 Harness defect found and fixed

`scripts/preview-harness.mjs` forwards every incoming HTTP request to the
built Worker as a bare `new Request(url, { headers: {...} })` — it never
carried the request's method or body. Every request the harness forwarded,
including `POST`/`PATCH`/`DELETE`, silently became a `GET` inside the Worker.
This is a real defect in the review tool itself: `TASKS.md`'s QA-002
verification requires "smoke every required direct route," which includes
the mutation routes (portfolio create, CSV import stage/commit/reverse,
ledger entry, account lifecycle) — none of those could be exercised through
this harness at all before this fix, silently and without any error, because
the harness never told the caller its request had been downgraded to a GET.

Fix (minimal, confined to this local-only review tool, not application code):
forward the real HTTP method, buffer and forward the request body for
non-GET/HEAD methods, and forward the incoming headers (except `host`, which
would point at the harness rather than the Worker's own origin, and
`cf-access-jwt-assertion`, which the harness always sets itself to the fixed
signed test principal — never a client-supplied value). Verified with
`npm run check` (still 292 tests, 290 passed, 0 failed, 2 skipped) and
`./node_modules/.bin/prettier --check` /
`eslint` on the changed file (both pass).

### 3.2 Route smoke (`npm run build` then `npm run preview:harness`)

```
npm run build
npm run preview:harness
```

Build succeeded (`vinext build`'s own route table: 21 `λ` API routes, 4 `ƒ`
dynamic pages, 1 `?` unclassified — see §2 for why this differs from `vinext
check`'s "5 page(s)" / "24 route handler(s)" static-scan counts). Harness
started (`Preview harness listening on http://127.0.0.1:8788`). Every
required direct route returned 200:

| Route                                | Status |
| ------------------------------------ | ------ |
| `/`                                  | 200    |
| `/portfolio/preview/overview`        | 200    |
| `/portfolio/preview/holdings`        | 200    |
| `/portfolio/preview/holdings/PLS.AX` | 200    |
| `/import`                            | 200    |
| `/manifest.webmanifest`              | 200    |
| `/offline.html`                      | 200    |
| `/sw.js`                             | 200    |
| `/favicon.svg`                       | 200    |

The `/portfolio/preview/*` fixture routes render real fixture content
(`Fixture market data`, `PLS.AX`, `A$2.09`), matching VSL-006's existing
evidence in `docs/PREVIEW_EVIDENCE.json`.

### 3.3 Mutation-route and D1-availability finding (not a defect — verified safe)

The harness's `env` object passed to `worker.fetch()` has never included a
`DB` binding (this predates QA-002; VSL-006 only ever needed the
unauthenticated static-fixture routes, which do not touch D1). Investigating
why `POST /api/portfolios` returned `503 {"message":"Portfolio data is
temporarily unavailable."}` after the harness fix above led to this finding:
**every** D1-backed route in this local harness — including the real
authenticated `/` root page, not just `/api/*` — renders the same safe
`"Portfolio data unavailable"` fallback, because `getSqlClient()` throws when
`env.DB` is absent and every caller (`app/authenticated-workspace.ts`,
`app/portfolio-actions.ts`, `app/api/account/lifecycle/status/route.ts`, and
the rest) catches that and returns an explicit unavailable state rather than
a crash, a 500, or fabricated data. This is correct behavior per the Product
State Contract's "Provider failure" row (keep last valid observation or show
an explicit unavailable state) and confirms there is no data leak or crash
path when D1 is unreachable, live-tested rather than merely read from source:

```
curl -X POST http://127.0.0.1:8788/api/portfolios \
  -H "content-type: application/json" -d '{"code":"X","name":"X","timezone":"UTC"}'
# {"ok":false,"status":503,"message":"Portfolio data is temporarily unavailable."}  (HTTP 503)

curl -X POST http://127.0.0.1:8788/api/portfolios \
  -H "content-type: application/json" -H "Origin: https://evil.example" -d '{...}'
# {"ok":false,"message":"Cross-site mutation requests are not allowed."}  (HTTP 403)

curl -X POST http://127.0.0.1:8788/api/portfolios \
  -H "content-type: application/json" -H "Sec-Fetch-Site: cross-site" -d '{...}'
# {"ok":false,"message":"Cross-site mutation requests are not allowed."}  (HTTP 403)
```

Every response, including the 503, still carried the full security header
set (`cache-control: private, no-store`, CSP with a per-request nonce,
`x-frame-options: DENY`, `x-content-type-options: nosniff`,
`permissions-policy`, `referrer-policy: no-referrer`) — confirmed by
`curl -I`, matching `worker/response-security.ts` and QA-001A §3/§5.

**Consequence for this task's scope:** wiring a real local D1 binding
(Miniflare-backed) into `preview-harness.mjs` so it can serve genuinely owned
data over HTTP is a materially larger change than a minimal tool fix — it
would duplicate what `tests/ops-003a.test.ts`/`tests/ops-003b.test.ts` already
do with a real Miniflare D1 instance (§6 below), and is out of this task's
"smallest necessary" mandate. It is recorded as a known limitation in §9 and
would be a reasonable, non-blocking follow-up if HTTP-level (rather than
in-process) owned-route UAT becomes a recurring need. The CSV
import/calculation/idempotency/reversal/cross-owner evidence QA-002 actually
requires comes from the real, already-passing integration suite (§4) and the
real Miniflare-backed D1 drills (§6) below, neither of which depends on the
harness's HTTP layer.

## 4. Supplied CSV end-to-end and calculation reconciliation

All of the following are real automated runs against the actual supplied
`docs/Example_Portfolio.csv`, part of `npm run check` (§2) and re-confirmed
individually:

```
node --experimental-strip-types --test tests/imports.test.ts tests/preview-valuation.test.ts \
  tests/imp-002b.test.ts tests/imp-003a.test.ts tests/imp-003b.test.ts
```

Result: all pass. What each covers:

- **Parse (100% row disposition):** `tests/imports.test.ts` "parses the
  supplied export into the documented row counts" parses the real fixture
  file and asserts `totalRows: 244`, `blankRows: 64`, `definitionRows: 65`,
  `transactionRows: 115`, **`unsupportedRows: 0`**, `duplicateRows: 0`,
  4 cash rows classified exactly, and 33 explicit zero-FX warnings — every
  committed row is accepted or explicitly classified, none silently dropped,
  satisfying the release-readiness success measure "100% of committed rows
  ... are accepted or explicitly rejected with a reason." Also verified:
  BOM/CRLF/padded-header tolerance, quoted-comma/embedded-newline handling
  without formula evaluation, NUL-byte rejection, unsupported-header
  rejection, and free-plan row/field bound enforcement (all in the same
  file).
- **Calculation reconciliation:** `tests/preview-valuation.test.ts` "builds
  the deterministic preview valuation fixture from the supplied CSV" runs
  the real CSV through parsing, FIFO lot construction, and valuation, then
  deep-equals the result against an independently written expected fixture
  (`tests/fixtures/preview-valuation-expected.ts`) — portfolio summaries,
  per-holding values, FIFO buy/sell ledgers, and rounding are all checked
  bit-for-bit against pre-computed values, not just "did it run." Also
  covers direct/inverse/identity/missing-FX and rounding scenarios
  independent of the CSV fixture.
- **Stage → map → commit (idempotent):** `tests/imp-002b.test.ts` (mapping
  reconciliation, ambiguous-security/FX-direction/oversell/incomplete-history
  blocking, cash-sentinel handling, owner-scoped reusable mapping decisions)
  and `tests/imp-003a.test.ts` ("atomic rollback, duplicate-file reuse,
  idempotency, ownership, and confirmation fail closed"; "validated row
  mappings drive per-portfolio postings and real rebuild high-water values";
  "commit route rejects cross-site mutation before authentication or
  parsing").
- **Reverse (compensating, not destructive):** `tests/imp-003b.test.ts`
  "clean reversal is compensating, auditable, and idempotent"; "later
  dependent sales block reversal with exact impact evidence"; "direct
  reversal denies another owner without changing the batch"; "reversal
  resumes after a bounded failure and corrected upload supersedes only
  reversed batches" — matches the release-readiness success measure "A
  committed import can be reversed and recalculated without deleting audit
  evidence."
- **Re-import produces no duplicate effects:** covered by the duplicate-file
  reuse/idempotency assertions above and by `tests/led-001b.test.ts`
  "retries only identical posting intent for an owner and portfolio."

## 5. Cross-user/tenant isolation

QA-001A (`docs/QA-001A_SECURITY_MATRIX.md`) already produced the full
route/repository ownership matrix, the Access-token failure matrix, and the
manual threat checklist, with two findings fixed (missing CSRF gate on 7
mutation routes; missing `cache-control: private, no-store` on `/`) and one
dependency-audit finding resolved by DEP-001. Re-run today as part of `npm
run check` (§2): all cross-owner denial tests QA-001A cites still pass,
including `tests/db-001b.test.ts` "owned portfolio repositories deny
cross-user reads, writes, and optimistic conflicts", the CSRF suite in
`tests/qa-001a.test.ts`, and the security-header suite in
`tests/security-headers.test.ts`. QA-002 does not re-derive this matrix; it
re-confirms the matrix's tests still pass on the current commit and folds it
into the release-readiness gate. No new cross-owner finding surfaced.

## 6. Backup, restore, and verified-deletion drills (OPS-002, OPS-003)

### 6.1 Historical real-Cloudflare-account restore drill (OPS-002)

`docs/OPS-002_DRILL_RECORD_2026-08-03.md`: **PASS**. Real, isolated,
synthetic-data Oceania D1 databases (not the configured application
databases). Measured RPO 1m59s (target 24h), RTO 5m35s (target 4h). All 26
tables, schema hash, row hashes, ownership counts, SQLite integrity, foreign
keys, and application smoke passed. This evidence is dated and predates
today; QA-002 cites it rather than re-running a real-account drill (a real
Cloudflare-account restore drill is an owner-run operational exercise, not
something a task-scoped Worker should trigger against real account
resources — see §9 for why a fresh real-account drill is not re-run here).

### 6.2 Miniflare-backed synthetic D1 drills (OPS-003A/OPS-003B), re-run today

These are the repeatable, local, non-account-touching drills the
OPS-003A/OPS-003B runbooks themselves specify ("Synthetic drill" sections)
and that QA-001A's dependency audit already used to validate the current
`wrangler`/`miniflare` toolchain. They need to bind a loopback (127.0.0.1)
listener, which this task's sandbox denies by default (`EPERM`); rerun with
the sandbox disabled, per this task's instructions:

```
OPS003A_D1_DRILL=1 OPS003B_D1_DRILL=1 node --experimental-strip-types \
  --test tests/ops-003a.test.ts tests/ops-003b.test.ts
```

Result: **27 passed, 0 failed** (13.8s). Key results:

- "synthetic non-production D1 drill completes, traverses, and preserves
  source rows" (OPS-003A/OPS-002-style restore-equivalent drill against a
  real Miniflare-backed D1 instance: applies the full migration chain,
  posts synthetic ledger/snapshot/calculation/audit data, exports and
  verifies an owner-scoped manifest, and confirms the source rows are
  untouched) — **PASS**.
- "isolated loopback D1 deletion drill completes and preserves the other
  owner" (OPS-003B verified-deletion drill: two synthetic owners in an
  isolated Miniflare D1 database, one exported and purged through the full
  cooling-off/typed-confirmation/bounded-checkpoint flow, the other owner
  and a shared provider mapping checked byte-for-byte unchanged
  before/after) — **PASS**.
- Every other OPS-003A/OPS-003B test (export atomicity, manifest/source
  mismatch fail-closed, CSRF-before-auth on the lifecycle route, concurrent
  CAS-guarded retries, source locks, migration fail-closed checkpoints, and
  the deletion UI's cooling-off/typed-confirmation content) also passed.

This satisfies OPS-002's "Restore drill verifies schema, row counts,
ownership checks, and representative calculations" and OPS-003's deletion
acceptance criteria against the current commit, using a real D1 engine
(Miniflare), not a mock.

## 7. Redacted observability evidence (OPS-002)

Structured request/auth logs emitted during the harness route smoke (§3) and
the full test run (§2/§6) contain only a fixed event/action/result shape,
a UUID `requestId`, and an ISO timestamp — no email, token, financial amount,
quantity, or CSV content, e.g.:

```
{"level":"info","event":"request.auth","action":"auth.verify","result":"success","requestId":"f2d0f494-c5ce-45b4-9fff-659ea5439992","occurredAt":"2026-08-10T07:03:53.445Z","metadata":{}}
```

This matches OPS-002's acceptance ("Logs correlate a request without logging
financial payloads") and is additionally covered by
`tests/ops-001.test.ts` "structured log snapshots redact user and financial
payloads" and "audit events record actor, target, result, correlation, and
redacted metadata" (both passing in §2).

## 8. Accessibility (QUAL-001, folded from QA-001B)

`docs/QA-001B_ACCESSIBILITY_AUDIT.md` recorded four blocking defects found
and fixed (color-only gain/loss signal, drawer keyboard focus management,
`--muted-dark` contrast, four sub-44px touch targets), full automated
coverage in `tests/qa-001b.test.ts` (10 tests, passing in §2), and an
explicitly named manual checklist that QA-001B's own completion note folds
into QA-002 UAT. That checklist is reproduced as owner-run items in §9 rather
than duplicated here; nothing in it is claimed as passed by either QA-001B or
this task.

## 9. Manual / owner-run checklist — REQUIRES OWNER RUN

None of the rows below have been executed by this task. Each requires either
a real Cloudflare account/dashboard action, a physical device, or a human
running assistive technology. Nothing here is claimed as passed.

### 9.1 Cloudflare Access invite/offboard (real preview deployment)

| Case                                                                                         | Steps                                                                                                                                                                                                                                                                                                                                                                                                                                      | Expected result                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 — Set the preview Access secrets                                                          | The preview Worker is already deployed at `yieldtome-portfolio-preview.argreen.workers.dev` (separate D1, `MARKET_DATA_PROVIDER=disabled`, per `docs/PREVIEW_DEPLOYMENT.md`); its Access issuer/audience secrets are intentionally unset. Set them (`wrangler secret put CLOUDFLARE_ACCESS_ISSUER --env preview`, same for `CLOUDFLARE_ACCESS_AUDIENCE`), then redeploy (`npx wrangler deploy --env preview`) so the Worker picks them up. | The preview Worker starts enforcing its own Cloudflare Access application instead of failing closed on missing Access configuration, making A2–A5 below possible.                                                                                                                                                            |
| A2 — Invite a test identity                                                                  | In the Cloudflare Zero Trust dashboard, add a test email to the preview Access application's allow policy.                                                                                                                                                                                                                                                                                                                                 | The invited identity can complete the Access login challenge and reach the preview URL; an uninvited identity is denied by Access itself before the Worker is reached.                                                                                                                                                       |
| A3 — First-login JIT provisioning                                                            | Sign in as the invited identity and load `/`.                                                                                                                                                                                                                                                                                                                                                                                              | An internal user/identity row is created; the workspace shows the correct "no portfolios yet" empty state (not an error), matching `docs/CONSOLIDATED_PRODUCT_SPEC.md`'s "Empty user" row.                                                                                                                                   |
| A4 — Offboard (remove from Access policy)                                                    | Remove the test identity from the Access application's allow policy in the dashboard.                                                                                                                                                                                                                                                                                                                                                      | Immediately after removal, the identity's next request is denied by Access before reaching the Worker (non-data-bearing 401/403, no rendered content) — Access-level offboarding, distinct from the application-level disable/delete lifecycle already covered by `tests/ops-003a.test.ts`/`tests/ops-003b.test.ts` in §6.2. |
| A5 — Application-level lifecycle (disable/export/delete) against the real preview deployment | As the invited identity, exercise disable, then the 24-hour-cooling-off deletion request with export, then final typed confirmation, against the real preview D1 (not the Miniflare drill).                                                                                                                                                                                                                                                | Matches the behavior already proven synthetically in §6.2 and `docs/OPS-003B_VERIFIED_DELETION_RUNBOOK.md`, now confirmed against the real Access/D1 preview stack end to end.                                                                                                                                               |

### 9.2 Physical device / desktop / PWA

| Case                   | Steps                                                                                                                                                            | Expected result                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 — Desktop UAT       | Open the real preview deployment (post A1) in a current desktop browser; walk Overview → Holdings → Details → import a CSV → manual ledger entry.                | Every core flow completes; matches the 1440 px measurements already recorded in `docs/UI_SPEC.md` §11.                                                                                                                                                                                                                       |
| D2 — iPhone Safari UAT | Open the real preview deployment on a physical iPhone in Safari; repeat the Overview/Holdings/Details/import/ledger flows at the device's real width.            | Matches the 390/430 px measurements in `docs/UI_SPEC.md` §11 and `docs/ui-captures/`; confirms real Safari rendering, not just CSS assertions.                                                                                                                                                                               |
| D3 — PWA install       | On the physical iPhone, add the preview deployment to the home screen via Safari's "Add to Home Screen."                                                         | Installs with the standalone display mode and raster icons declared in the manifest (`tests/rendered-html.test.mjs` "PWA metadata uses standalone raster install icons" already confirms the manifest's shape, but not a real install).                                                                                      |
| D4 — Offline reload    | With the installed PWA open and network disabled, force a reload.                                                                                                | Shows the static offline page only; no authenticated HTML/API/portfolio/CSV data is visible (service worker only caches the public allowlist per `tests/rendered-html.test.mjs` "service worker only caches the public offline allowlist," already passing — D4 confirms this against real iOS Safari/PWA caching behavior). |
| Z1–Z7                  | 200% desktop zoom, iOS Dynamic Type, physical pinch-zoom, 320/390/430 px physical/simulated widths, narrow-desktop (700–900 px) layout, OS-level reduced motion. | See `docs/QA-001B_ACCESSIBILITY_AUDIT.md` §4.3 for the exact steps/expected results (reproduced there, not duplicated here since QA-001B already wrote them out in full and its completion note folds them into QA-002).                                                                                                     |

### 9.3 VoiceOver and keyboard-only

See `docs/QA-001B_ACCESSIBILITY_AUDIT.md` §4.1 (7 keyboard-only core-flow
traces, K1–K7) and §4.2 (8 VoiceOver cases, V1–V8). QA-001B's completion note
explicitly folds these into QA-002 UAT; they are not reproduced verbatim
here to avoid two documents drifting out of sync — this document's go/no-go
in §11 treats them as outstanding preconditions exactly like the Access and
physical-device rows above.

## 10. Known limitations

- The local preview harness (`scripts/preview-harness.mjs`) has no D1
  binding wired into it, so every authenticated D1-backed route renders the
  safe "unavailable" fallback rather than genuine owned data when driven
  through that harness (§3.3). This does not block release — it is a local
  review-tool limitation, not a production behavior, and the actual
  CSV/calculation/ownership/deletion evidence QA-002 needs comes from the
  real-engine test suite and Miniflare drills instead. A follow-up task could
  wire a Miniflare-backed D1 binding into the harness for full HTTP-level
  owned-route UAT if that becomes a recurring need; not filed as a blocking
  item.
- `npm audit`: 6 vulnerabilities (4 moderate, 2 high), unchanged from
  QA-001A/DEP-001's disposition, re-confirmed today (`npm audit`, same
  output). The 2 high (`image-size`/`vinext`) and 4 moderate
  (`esbuild`/`@esbuild-kit`/`drizzle-kit` chain) are dev/build-toolchain-only,
  not present in the deployed Workers bundle, and carry documented risk
  acceptance in `docs/QA-001A_SECURITY_MATRIX.md` §4. No new advisory since
  QA-001A.
- QA-001B follow-ups (deferred, non-blocking): desktop dense-table sort
  header at 31px (below the project's internal 44px convention but above the
  actual WCAG 24×24px minimum); popovers with no Escape-to-close; the
  prototype-only `HoldingSheet` dialog's missing focus trap (production
  `/portfolio/preview/*` routes 404 in production, so this is review-surface
  only); `docs/ui-captures/` screenshots not regenerated after the 44px
  target-size fix (visual, not functional).
- Deferred v1 scope (not release blockers, explicitly out of scope per
  `TASKS.md`): future broker-sync contract (`SPK-003`), corporate-action/
  dividend schema and provider capability (`DB-005`, `MKT-005`), dividend
  events/receipts/forecasts (`DIV-001`). Portfolio-wide TWR/XIRR remain
  unavailable until complete history and external-flow classification exist,
  per `docs/CONSOLIDATED_PRODUCT_SPEC.md` §13 — this is a documented product
  limitation, not a defect.
- The dedicated preview Worker is already deployed at
  `yieldtome-portfolio-preview.argreen.workers.dev` (per
  `docs/PREVIEW_DEPLOYMENT.md`), but its Cloudflare Access issuer/audience
  secrets are intentionally left unset until the operator has the
  tenant-specific values, so it is not yet usable for Access-gated UAT.
  §9.1/§9.2 depend on the owner setting those two secrets (row A1 in §9.1
  above) before the rest of §9's owner-run rows can proceed.

## 11. Go/No-Go record

**Automated release gates: GO.** Every gate this task could run
programmatically passed against the current commit, with real commands and
real output, no fabricated results:

| Gate                                                          | Result                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency completeness (§1)                                  | GO — every non-deferred dependency `DONE`                                                                                               |
| Automated quality gate, QUAL-002 (§2)                         | GO — 292 tests, 290 passed, 0 failed, 2 skipped (env-gated D1 drills, run separately 27/27 in §6.2)                                     |
| Preview build + route smoke (§3.1–3.2)                        | GO — build succeeds; every required direct route returns 200; harness method/body-forwarding defect found and fixed                     |
| Mutation-route safety under D1 unavailability (§3.3)          | GO — CSRF gate enforced live (403 on cross-site); no crash, no data leak, correct security headers on every response including failures |
| Supplied CSV parse (100% row disposition) (§4)                | GO — 244 rows, 0 unsupported, 0 duplicates, all classified                                                                              |
| Calculation reconciliation (§4)                               | GO — deterministic fixture matches independently computed expected values                                                               |
| Stage/map/commit/idempotency/reverse (§4)                     | GO — atomic, idempotent, ownership-checked, compensating reversal, all tested                                                           |
| Cross-user/tenant isolation (§5)                              | GO — QA-001A matrix re-verified, no open finding                                                                                        |
| Backup/restore drill, OPS-002 (§6.1)                          | GO — historical real-account drill PASS (2026-08-03); RPO/RTO within target                                                             |
| Restore-equivalent + verified-deletion drills, OPS-003 (§6.2) | GO — 27/27 Miniflare-backed drill tests pass today against the current commit                                                           |
| Redacted observability, OPS-002 (§7)                          | GO — no financial/PII payload in structured logs                                                                                        |
| Accessibility, QUAL-001 (§8)                                  | GO — QA-001B's automated coverage re-verified, 0 open blocking defect                                                                   |
| Dependency audit                                              | GO — unchanged, documented risk acceptance, no new high/critical                                                                        |

**Owner-run preconditions: OUTSTANDING — this is not an unconditional GO.**
The following are named, precise, REQUIRES-OWNER-RUN items (§9) that this
task cannot execute (real Cloudflare Access dashboard, physical iPhone,
VoiceOver, a real deployed preview URL) and that remain open:

- A1–A5: preview deployment, Access invite, JIT provisioning, Access
  offboard, and application-level lifecycle against the real preview stack.
- D1–D4: desktop UAT on the real deployment, physical iPhone Safari UAT, PWA
  install, offline reload on a real device.
- Z1–Z7: 200% zoom, iOS Dynamic Type, physical pinch-zoom, 320/390/430 px
  physical widths, narrow-desktop layout, OS-level reduced motion (steps in
  `docs/QA-001B_ACCESSIBILITY_AUDIT.md` §4.3).
- K1–K7, V1–V8: keyboard-only core-flow traces and VoiceOver cases (steps in
  `docs/QA-001B_ACCESSIBILITY_AUDIT.md` §4.1–4.2).

**Overall: conditional GO.** Every automated product, security, data, and
operational gate this task could run passed with no critical or high
open finding and every known limitation documented (§10). Release to the
real preview environment for owner UAT is clear to proceed; final
unconditional release readiness additionally requires the owner to complete
and record the outstanding items in §9 (Access invite/offboard, physical
iPhone/PWA install, VoiceOver, and keyboard-only/zoom manual passes) before
promoting beyond preview. No blocking application defect was found; the one
defect found (§3.1, the harness's dropped method/body) was in a local review
tool, not the product, and is fixed.

## 12. Success-measure and phase-gate traceability

This section makes the acceptance criterion "all product success measures
and phase gates pass" checkable row by row, rather than asserted only by the
narrative in §§1–11. Disposition values: **PASS** (automated evidence exists
and is cited), **PARTIAL** (automated evidence covers most but not all of
the measure; gap stated explicitly, not fabricated), **REQUIRES OWNER RUN**
(no automated evidence is possible; §9 already lists the exact row).

### 12.1 Success measures (`docs/CONSOLIDATED_PRODUCT_SPEC.md` §16)

#### Release readiness

| #   | Success measure                                                                                             | Disposition | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 100% of committed rows in the supplied example CSV are accepted or explicitly rejected with a reason.       | PASS        | §4: `tests/imports.test.ts` "parses the supplied export into the documented row counts" asserts `totalRows: 244`, `unsupportedRows: 0`, `duplicateRows: 0`, every row classified (blank/definition/transaction/cash), on the real `docs/Example_Portfolio.csv`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2   | Re-importing the same file creates no duplicate ledger effects.                                             | PASS        | §4: `tests/imp-003a.test.ts` "atomic rollback, duplicate-file reuse, idempotency, ownership, and confirmation fail closed"; `tests/led-001b.test.ts` "retries only identical posting intent for an owner and portfolio" (line 303).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | Every portfolio query has a tested cross-user denial path.                                                  | PASS        | §5 + `docs/QA-001A_SECURITY_MATRIX.md` §1 — a full route/repository ownership matrix where every row cites its own cross-user denial test, e.g. `tests/db-001b.test.ts` "owned portfolio repositories deny cross-user reads, writes, and optimistic conflicts" (line 197), `tests/import-staging.test.ts` "denies cross-user access and enforces row bounds with foreign keys enabled", `tests/ops-003a.test.ts` "lifecycle repository rejects a cross-owner actor" (line 659), `tests/rendered-html.test.mjs` "server denies unauthenticated requests before rendering private content". Not a single test — a per-route matrix, re-verified passing in §2/§5. |
| 4   | Calculation fixtures reproduce independently computed expected values to the documented rounding tolerance. | PASS        | §4: `tests/preview-valuation.test.ts` "builds the deterministic preview valuation fixture from the supplied CSV" deep-equals against the independently written `tests/fixtures/preview-valuation-expected.ts`; `tests/calc-001a.test.ts` "reviewed decimal primitives preserve bounded source precision and half-even rounding" (line 32) covers the documented rounding tolerance itself.                                                                                                                                                                                                                                                                      |
| 5   | Current totals report quote and FX coverage rather than silently treating gaps as zero.                     | PASS        | `tests/ui-003.test.ts` "UI-003 marks a missing price as partial without turning it into zero" (line 663) and "UI-003 preserves exact zero without requiring price or FX and keeps missing basis explicit" (line 645); `tests/mkt-003a.test.ts` "coverage totals stay aligned and never turn gaps into zero" (line 279); `tests/calc-001b.test.ts` "CALC-001B partial totals align invested value and basis to the same holdings" (line 497). All pass in §2.                                                                                                                                                                                                    |
| 6   | A committed import can be reversed and recalculated without deleting audit evidence.                        | PASS        | §4: `tests/imp-003b.test.ts` "clean reversal is compensating, auditable, and idempotent"; "later dependent sales block reversal with exact impact evidence".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | Overview and holding navigation work at 320 px and desktop widths.                                          | PARTIAL     | Automated: `tests/qa-001b.test.ts` "the viewport never disables pinch/keyboard zoom, and the shell has a 320px overflow floor" (line 430) and "QA-001B: .period-tabs wraps instead of overflowing at 320px..." (line 386) assert the 320px overflow floor and layout math directly; `docs/UI_SPEC.md` §11 records prior browser-measured evidence at 320/390/430/1440px with captures in `docs/ui-captures/`. Not automated: confirming these render correctly on a **physical** device/browser rather than jsdom/CSS assertions remains **REQUIRES OWNER RUN** — see §9.2 rows D1 (desktop), D2/Z5 (physical iPhone 390/430px), Z4 (320px).                    |
| 8   | The application builds for Cloudflare Workers and passes lint and automated tests.                          | PASS        | §2: `npm run check` — Prettier, ESLint, `tsc --noEmit`, `vinext check` (100% compatible), `vinext build` (succeeds), full `node --test` suite (292 tests, 290 passed, 0 failed, 2 skipped) all pass as one command.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

#### Post-release health

| #   | Success measure                                                                                               | Disposition | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Provider ingestion success, staleness, and owner-scope denials are observable.                                | PARTIAL     | §7: structured logs use a fixed, redacted event/action/result/requestId shape (`tests/ops-001.test.ts` "structured log snapshots redact user and financial payloads"). `worker/index.ts`'s `scheduled` handler emits a `market.refresh` event with `result: success\|failure` and `{skipped, jobs, providerRequests}` metadata on every ingestion run (lines 125–140), whose return shape is asserted by `tests/mkt-003b.test.ts` "scheduled handler is durable and does not use waitUntil for refresh work". `request.auth` events (lines 91–112) log every authentication-level denial. Gap, stated rather than hidden: authentication-level denials are logged as a distinct event, but there is no separate structured-log event specifically tagged for a repository-level owner-scope denial (as opposed to the denial itself failing closed, which item 3 above exhaustively tests) — an owner-scope denial on a mutation is traceable via its audit record (`tests/ops-001.test.ts` "audit events record actor, target, result, correlation, and redacted metadata") and its HTTP response, not a dedicated log line. Non-blocking; recorded here rather than silently claimed as fully solved.                                                                                                                                                                                   |
| 10  | No unresolved reconciliation drift between ledger and projections.                                            | PARTIAL     | Architecture-level guarantee, not a runtime drift monitor: `docs/ARCHITECTURE.md` line 303 — "Position snapshots are reconciliation evidence... they do not silently replace ledger-derived holdings" — is drawn from ARCHITECTURE.md §8 "Future broker synchronization boundary," a deferred v1-scope section describing broker-sync position snapshots, not the current CALC-002 daily-snapshot path; quoted here only as an architectural design principle, not current-scope evidence. Concrete evidence for the actual v1 path: `tests/calc-002.test.ts` "CALC-002 derives each date from ledger facts instead of back-casting current quantity" (line 124) and `tests/calc-002-repository.test.ts` "CALC-002 rebuild is owner-scoped, bounded, resumable, and only completed runs publish chart points" (line 72) confirm every snapshot/projection is deterministically rebuilt from ledger facts rather than maintained as independent state, which prevents drift from persisting rather than merely detecting it after the fact. Gap, stated rather than hidden: there is no runtime drift monitor/reconciliation check that would catch an actual divergence if the rebuild path itself had a defect — deterministic-rebuild-from-source is a strong structural guarantee, not the same as an active drift detector; the same gap shape as item 9's PARTIAL disposition above. |
| 11  | Restore drills complete within the documented recovery objective.                                             | PASS        | §6.1: `docs/OPS-002_DRILL_RECORD_2026-08-03.md` — RPO 1m59s against a 24h target, RTO 5m35s against a 4h target, both real-Cloudflare-account measurements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 12  | Support incidents can be traced through structured logs and audit events without exposing financial payloads. | PASS        | §7: `tests/ops-001.test.ts` "structured log snapshots redact user and financial payloads" and "audit events record actor, target, result, correlation, and redacted metadata" — both passing in §2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 12.2 Phase gates (`docs/IMPLEMENTATION_PLAN.md` §2)

Every task named in each gate is `DONE` in `TASKS.md` except QA-002 itself
(this task, in flight) (statuses re-checked directly against the file for
this table, matching §1's dependency check):

| Phase gate (line)                                                  | Tasks                                                                                                    | Disposition                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediate milestone — Demonstrable CSV portfolio preview (line 19) | VSL-001–VSL-006                                                                                          | pass-with-evidence                                                             | All `DONE`; `VSL-006`'s completion note (`TASKS.md`) records the Cloudflare Quick Tunnel preview, verified direct routes and security markers, and 320/390/430 captures with no horizontal overflow. Superseded operationally by the later production build/deploy path, but the gate's own criteria were met when evaluated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Phase 0 — Foundation and decisions (line 33)                       | FND-001, FND-002A, FND-002B, SPK-001, SPK-002                                                            | pass-with-evidence                                                             | All `DONE` (`TASKS.md`, dated 2026-07-28/29). `tests/runtime-config.test.ts` "wrangler source and generated worker config stay aligned with the task profile" (run in §2's `npm run check` output) re-confirms the fail-closed config/binding-agreement criterion still holds on the current commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phase 1 — Identity and owned persistence (line 48)                 | DB-001A, DB-001B, AUTH-001, AUTH-002, OPS-001                                                            | pass-with-evidence                                                             | All `DONE` (2026-07-29 to 2026-08-02). `tests/db-001b.test.ts` "owned portfolio repositories deny cross-user reads, writes, and optimistic conflicts" and `tests/ops-001.test.ts` "audit events record actor, target, result, correlation, and redacted metadata" (both passing in §2) directly satisfy this gate's "cross-user denial integration tests pass" and "material mutations generate redacted audit records" criteria.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Phase 2 — Ledger and import truth (line 61)                        | DB-002, MKT-001, LED-001A, LED-001B, IMP-001, IMP-002A, IMP-002B, LED-002A, LED-002B, IMP-003A, IMP-003B | pass-with-evidence                                                             | All `DONE` (2026-07-29 to 2026-08-03). This gate's own criteria (parses expected classifications, non-mutating preview, idempotent/reversible commit, cash/holdings/FIFO reconciliation, explicit incomplete history) are the same claims re-verified in §4 above with the same test citations (`tests/imports.test.ts`, `tests/imp-002b.test.ts`, `tests/imp-003a.test.ts`, `tests/imp-003b.test.ts`, `tests/led-002a.test.ts`/`tests/led-002b.test.ts` FIFO/reconciliation coverage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Phase 3 — Market data and financial calculations (line 75)         | DB-003, DB-004, MKT-002, MKT-003A, MKT-003B, MKT-004, CALC-001A, CALC-001B, CALC-002                     | pass-with-evidence                                                             | All `DONE` (2026-07-30 to 2026-08-09). `tests/mkt-003a.test.ts` "coverage totals stay aligned and never turn gaps into zero" (line 279) and "manual price and FX overrides take priority and identity FX is exact" (line 214) satisfy "manual fallback works" / "price/FX gaps produce partial coverage, not zero"; `tests/calc-002-repository.test.ts` "CALC-002 keeps calculation versions independently published" (line 590) satisfies "snapshots rebuild deterministically by calculation version".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Phase 4 — Product surfaces (line 90)                               | UI-001, UI-002, UI-003, UI-004, UI-005A, UI-005B, UI-005C, UI-005D, UI-005E, PWA-001                     | pass-with-evidence                                                             | All `DONE` (2026-07-30 to 2026-08-09, UI-002/UI-003 latest at 2026-08-09 browser QA). §8 above already re-confirms this gate's "missing/stale/partial states are clear" and "service worker stores no private data" criteria via `tests/qa-001b.test.ts` and the service-worker allowlist test cited in §9.2's D4 row (`tests/rendered-html.test.mjs` "service worker only caches the public offline allowlist").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Phase 5 — Operations and release (line 104)                        | OPS-002, OPS-003A, OPS-003B, QA-001A, QA-001B, QA-002                                                    | PARTIAL — pass-with-evidence for the automated portion, owner-run for the rest | OPS-002/OPS-003A/OPS-003B/QA-001A/QA-001B all `DONE`; this gate's "restore/deletion drills pass" is §6 (historical real-account drill + 27/27 Miniflare drills today); "provider retention obligations are operational" is PARTIAL — `docs/MARKET_DATA_STRATEGY.md` §10 "Cache and retention rules" (line 199) requires provider raw bodies be parsed transiently with only normalized fields + payload hash stored, transient provider payloads purged on provider removal, and normalized observations retained; the hash-only-storage half is implemented and validated — `domain/market-data/normalize.ts` rejects a malformed `payloadSha256` field (lines 165, 233) and never persists a raw provider response body, exercised by `tests/mkt-001.test.ts` "FX fixtures retain explicit base-to-quote direction and provenance" (asserts `direct.value.payloadSha256`, line 178) — so there is no raw payload for a provider-removal purge to act on. User-scoped normalized price/FX observations do have a dedicated, tested purge routine: `db/repositories/account-lifecycle.ts`'s `PURGE_TABLES_IN_FK_ORDER` (line 270) includes `price_observations`, `fx_rate_observations`, `market_data_refresh_jobs`, and `security_provider_mappings`, the last guarded by a dependent-row check (line 1783) so a mapping is only purged once no remaining price observation or refresh job references it; `tests/ops-003b.test.ts` exercises this owner-scoped, with the other owner's rows (including `price_observations` and `security_provider_mappings`) verified byte-for-byte unchanged (lines 480, 539, 569), matching §6.2's "27 passed, 0 failed" drill run and the runbook's "user-scoped market data" purge (`docs/OPS-003B_VERIFIED_DELETION_RUNBOOK.md` line 13). The residual gap is narrower: no time-based retention-duration expiry, and no provider-removal purge job, exists for deployment-scoped observations (`access_scope='deployment'`, `scope_user_id IS NULL`) — no `DELETE` against `price_observations` or `fx_rate_observations` exists anywhere under `db/`, `worker/`, `domain/`, or `app/` outside `account-lifecycle.ts`'s user-scoped purge; §10's own checklist item "Application retention and provider-removal behavior are implemented" (line 294) is backed only by the storage-shape guarantee and the user-scoped purge above, not a deployment-wide retention/expiry job or test — gap stated rather than claimed as fully operational. "accessibility/security checks pass" is §5/§8; "all required automated checks pass" is §2. "Preview UAT covers supplied CSV and iPhone/desktop" is only partially satisfiable by this task: the supplied-CSV half is covered by real integration tests (§4), but the iPhone/desktop UAT half is explicitly the owner-run checklist in §9 (A1–A5, D1–D4, Z1–Z7, K1–K7, V1–V8) and is **REQUIRES OWNER RUN**, matching §11's "conditional GO" — this phase gate is not claimed as an unconditional pass. |

## 13. Files changed in this task

- `scripts/preview-harness.mjs` — forwards the real HTTP method, body, and
  headers instead of silently downgrading every request to a bare GET (§3.1).
- `docs/QA-002_RELEASE_READINESS.md` — this document.
- `docs/00_INDEX.md` — added index entries for this document and the
  previously unindexed `QA-001A_SECURITY_MATRIX.md`/
  `QA-001B_ACCESSIBILITY_AUDIT.md`.
