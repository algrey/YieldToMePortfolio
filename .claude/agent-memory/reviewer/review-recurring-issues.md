---
name: review-recurring-issues
description: Recurring defect patterns found while reviewing YieldToMe worker submissions — API response-envelope mismatches, source-regex tests, ID reuse, extracted-module wiring gaps, untested wire protocols, alias-blind EXPLAIN guards, and mislabelled before/after census numbers
metadata:
  type: project
---

Defect patterns that have already slipped through worker submissions in this
repo; check each explicitly on every review.

**1. API response-envelope mismatch between route and client caller.**
Route handlers here are inconsistent by design: some return the action's
`{ ok: true, ... }` envelope via `Response.json(result)`, others unwrap it and
return the bare payload (e.g. the file-download branch of
`app/api/system-backup/export/route.ts` returns `JSON.stringify(result.backup)`
with a `content-disposition` header). Client helpers such as
`fetchJson`/`postJson` in `app/components/*.tsx` discriminate on a truthy `ok`
field, so a client that fetches a bare-payload route silently gets
`{ ok: false, message: undefined }` and renders nothing at all.

**Why:** EXP-003 (2026-08-28) shipped a browser-driven export that called
`GET /api/system-backup/export?mode=core` — a branch returning the bare
`SystemBackupV1` — through `fetchJson`. The export button did nothing, with no
error text, and `tsc`, ESLint and all 2607 tests passed.

**How to apply:** whenever a diff adds a new fetch from a client component to an
existing route, read the exact success-path `return` in that route and confirm
the body shape matches what the client destructures. Falsy-`ok` failures are
invisible because `{error ? ... : null}` renders nothing for `undefined`.
Note `fetchJson`'s `value` is the WHOLE envelope, so a caller reading
`outcome.value.result` needs the action to return `{ok:true, ..., result}`.

**2. Tests that regex-match component source text instead of behaviour.**
Several suites assert things like
`assert.match(source, /const PRICE_RESTORE_CHUNK_ROWS = 200/)` after reading the
`.tsx` file. These prove a constant is spelled a certain way and prove nothing
about runtime behaviour.

**How to apply:** treat a source-regex test as *no* coverage for the acceptance
criterion it is cited against. Ask for a behavioural test (render test, or a
direct call against the route/service with a fixture DB) for any new
browser↔server protocol. Related: [[review-verification-commands]].

**4. New task IDs get reused for unrelated work.** AGENTS.md requires stable
requirement IDs (deprecate, never reuse), but some in-tree code comments carry
IDs that have no `TASKS.md` entry (they arrived via broad catch-all commits like
`2f1a2af`), so an Orchestrator picking "the next free ID" from `TASKS.md` alone
can collide. Seen on UI-049 (2026-08-30): assigned to the `/import`
zero-portfolio fix while `app/authenticated-fx-rate.ts`,
`app/components/portfolio-shell.tsx`, `app/globals.css` already used UI-049 for
the app-bar USD/AUD pill. **How to apply:** on every review, grep the whole
task ID across `app/`, `tests/`, `docs/`, `TASKS.md` — not just `TASKS.md` —
and report a collision as a follow-up for the Orchestrator (the worker did not
choose the ID).

**3. "Extract a pure sibling module so it can be tested" fixes leave the wiring
uncovered.** The established repo answer to the runner's limits (no `.tsx`
imports, no `next/headers` importers) is to move decision logic into a plain
`.ts` sibling and unit-test that (`price-upload-request-body.ts`,
`price-history-coverage-format.ts`, `system-backup-restore-progress.ts`,
`api/system-backup/export/response-shape.ts`, `domain/exports/chain-order.ts`,
`domain/exports/chunk-rows.ts`). This is a good pattern and should be
accepted — but the extracted unit test passes even if the route/component stops
CALLING the helper, which is exactly the shape of the original bug. **How to
apply:** when a fix is delivered this way, check the suite also pins the caller
(an `assert.match` on the route/component source for the import/field/call). If
that pin is missing, raise it as a follow-up, not a blocker, as long as real
behavioural coverage of the extracted logic exists.

**5. A NEW browser↔server wire protocol ships with the request parser
untested.** EXP-004 (2026-08-30) added `systemBackupCorePartFromBody` /
`parseBundleFinalizeWireInput` — plain, importable `.ts` boundary parsers that
narrow `unknown` for four HTTP phases — with zero direct tests, while the
service layer beneath them was well covered. Same shape as pattern 3: the
tested layer is not the layer the browser actually hits. **How to apply:** for
any new multi-phase/multi-field request body, check for direct parser tests
(malformed phase, missing identity, malformed sub-array). If absent, raise it —
and consider probing it yourself with a scratch `node --experimental-strip-types
--test` script (see [[review-verification-commands]]) so you can report whether
the gap is a real defect or only missing coverage.

**7. A "nothing changed" freeze proof that is a tautology.** When a worker
extracts/refactors a value-producing function and claims the value is
byte-identical to before, check WHAT the test compares. EXP-004's escalation
(2026-08-30) added `fingerprintBundleWithByteLength` and "pinned" it with
`assert.equal(fingerprintBundleWithByteLength(b).fingerprint, await
fingerprintBundle(b))` — but `fingerprintBundle` had been rewritten to delegate
to the new helper, so that assertion cannot fail. The load-bearing property was
elsewhere: the old system-restore path fingerprinted `v(v(x))`
(`validatePortfolioBundle` ran twice) and the new one fingerprints `v(x)`, so
production's frozen `bundle:<fp>:<ref>` keys survive ONLY because
`validatePortfolioBundle` is idempotent w.r.t. `canonicalBundleJson`. **How to
apply:** identify the two expressions that must stay equal ACROSS the refactor
(old call graph vs new call graph), not the two that are equal by construction
after it; then verify the real one yourself with a scratch test (see
[[review-verification-commands]]) before accepting the claim.

**8. The local test driver is MORE PERMISSIVE than production D1, so a green
suite is no evidence about engine limits.** Tests run on `node:sqlite`;
production runs on Cloudflare D1, which enforces SQLite's *default* compile-time
limits. Confirmed case (EXP-004, 2026-08-31): `SQLITE_LIMIT_LIKE_PATTERN_LENGTH`
is 50 bytes on D1 but 50,000 on `node:sqlite`, so
`idempotency_key LIKE 'bundle:<64-hex-fp>:%'` (73 bytes) passed 2600+ local
tests while every production scaffold request 500'd with
`D1_ERROR: LIKE or GLOB pattern too complex`. **How to apply:** when a diff adds
SQL, check for constructs whose *limits* differ between drivers — LIKE/GLOB
pattern length, `SQLITE_LIMIT_VARIABLE_NUMBER` (bound-parameter count in
generated `IN (?,?,…)` lists), compound-SELECT count, expression depth, and
statement length. A behavioural test can never guard these; accept a structural
source-scanning test instead, but probe its regex for false negatives yourself
(see [[review-verification-commands]]) — line-based scans typically miss
lower-case keywords, multi-line SQL, template-interpolated patterns, and
Drizzle helper calls like `like()`.

**9. A "regression guard" regex that cannot match the actual pre-fix output.**
PRF-001 (2026-08-31) guarded its `EXPLAIN QUERY PLAN` fix with
`assert.doesNotMatch(planText, /SCAN po(?!.*USING)/)` over plan rows joined with
`" | "`. Both real pre-fix plans contain a later `USING` (`SCAN po | SEARCH ps
EXISTS USING INDEX …`), so the negative lookahead never matches and the
assertion is vacuous — the regression was actually caught only by the NEXT
assertion (`assert.match(/SEARCH po USING INDEX <name>/)`). **How to apply:**
whenever a test asserts the ABSENCE of a bad string, reconstruct the exact
pre-fix string yourself (scratch `.mjs`, see
[[review-verification-commands]]) and run the regex against it; joining
multi-row diagnostic output into one line breaks `.` /lookahead-based
guards. Prefer per-row assertions (`plan.some(r => /^SCAN po\b/.test(r.detail))`).

**9b. `EXPLAIN QUERY PLAN` guards are ALIAS-BLIND.** SQLite prints the
ALIAS, not the table name, in plan rows: a full scan of `price_observations po`
reads `SCAN po`. So the common guard shape
`/^SCAN\s+(\S+)/` + `FLAGGED_TABLES.includes(match[1])` (PRF-002's
`assertNoLargeTableScans`, `tests/prf-002.test.ts`) never fires for ANY aliased
query — which is nearly every query in `app/historical-portfolio-value.ts`,
`app/owned-holdings.ts`, etc. Verified 2026-08-31 with a scratch `.mjs`.
**How to apply:** when a diff adds a plan-based scan guard, check whether the
queries it inspects use aliases; require the guard to resolve alias→table (or
match `/^SCAN (po|t|fx|ps|<table>)\b/`). Report as follow-up when the specific
new query has its own correctly-aliased assertion (PRF-002's test 3 did).

**10. Census/performance tables in TASKS.md are measured on the POST-fix code
and then labelled "BEFORE".** PRF-002's table listed the root page as
"107 / 183 (BEFORE fix 2)"; re-running the census harness against
`git show <commit>^:app/<file>` gave 108/184 as the real before, 107/183 after.
**How to apply:** any before/after number produced by a test that only exists
in the fixing commit is an AFTER number unless the worker actually re-ran the
old code. Reconstruct the "before" with `git show <commit>^:<path>` into a
scratch module, import it from a copy of the suite, and re-measure.

**11. D1 caps bound parameters at 100 per statement.** Generated
`IN (?,?,…)` lists sized off a caller/data-controlled count (e.g. one
placeholder per held security, `MAX_SECURITIES = 500` in
`app/historical-portfolio-value.ts`) pass locally at any size but break in
production past ~100 params. Same class as pattern 8. **How to apply:** for any
new generated placeholder list, check the cap on the count feeding it, not just
that a cap exists.

**12. A guard that greps captured SQL TEXT for a value that is always BOUND
as a parameter.** Census/counting clients here (`stageCensusClient` in
`tests/prf-002.test.ts`) record `{sql, params}` per call. A guard shaped
`stats.calls_.filter(c => c.sql.includes("'snapshot'"))` can never fire,
because every pipeline/status discriminator in `db/repositories/
calculation-runs.ts` is bound (`WHERE pipeline = ?`), never inlined.
Confirmed 2026-08-31 (CALC-005): reconstructing the pre-fix Overview
self-heal produced 84 calls / 160 statements and **zero** matches for that
guard; the load-bearing assertion was the neighbouring
`assert.deepEqual(after, before)` on the run row (`queued`→`running`,
attempt 0→1, lease_owner set). Also note `stageCensusClient` records
`all`/`get`/`run` but NOT `batch`, so batched writes are invisible to any
`calls_`-based guard. **How to apply:** for any "no statement mentions X"
assertion, check whether X is a bound parameter or inside a `batch()`; if
so the guard is vacuous — require it to inspect `params` too, and confirm a
real state-diff assertion carries the regression.

**13. A "sequential depth" census that merges OVERLAPPING intervals reports
connected components, not critical path — it undercounts ~2x.** PRF-003
(2026-08-31) added `depthCensusClient` to `tests/prf-002.test.ts`: it timestamps
every `all`/`get`/`run`/`batch` (plus an 8 ms probe delay), then merges any two
overlapping `[start,end)` intervals into one "wave" and calls the wave count
`depth`. When a 2-deep chain (e.g. `owned-holdings.ts`'s count-then-fetch price
read) runs inside a `Promise.all` alongside a slower sibling, the chain's second
call starts *before* the sibling's first call ends, so both links get absorbed
into the SAME wave. Measured: root overview and Holdings report `depth=4` /
`modeledWallMs=160`, real critical path is **8** (verified with a DP over the
same intervals: `best[i] = 1 + max(best[j] | end_j <= start_i)`), so the
"every page ≤ 6 waves" target recorded in `docs/ARCHITECTURE.md` is not
actually met. **How to apply:** any wall-time model built on a wave count is
understated by the same factor; re-measure with the longest-non-overlapping-chain
DP before accepting a depth number, and cross-check it by hand-walking the
loader (each `await` boundary that consumes the previous read is one hop).
Related: [[review-verification-commands]] and pattern 10 above (before/after
numbers measured with the fixing commit's own harness).

**14. A latency fix that fires a read from a CALLBACK leaves an orphan
promise — unhandled rejection when the outer await also fails.** PRF-004
(2026-08-31) added `onIdentityKnown` to `domain/auth/identity-lifecycle.ts` so
`request-context.ts` starts the portfolio lookup inside the hook, concurrently
with `touchWithAudit`'s write. The hook's promise is stored in a `let` and
joined only on the success path, so when `resolve()` itself rejects (D1 error on
the audit batch) the still-pending portfolio promise is never awaited: if it
rejects too, Node reports `unhandledRejection` (proved with a scratch test that
makes `batch()` and every `FROM portfolios` read throw). One correlated D1
failure hits both. **How to apply:** for any "start it early in a callback /
kick it off and join later" refactor, ask what happens when the outer await
throws BEFORE the join; require a `.catch(() => {})` marker on the eager promise
(the later `await` still rejects normally) or a `Promise.allSettled` join. Same
question for any promise stored in a variable that only some code paths read.
Related: [[review-verification-commands]].

**15. An OR'd multi-range predicate silently DROPS the range column from the
index seek — "narrow windows" then cut rows RETURNED, not rows SCANNED.**
PRF-005 (2026-08-31) replaced `loadFacts`'s single
`po.market_date BETWEEN ? AND ?` with N OR'd windows
(`(d BETWEEN ? AND ? OR d BETWEEN ? AND ? ...)`) inside an
`AND security_id IN (...)`. Verified with `EXPLAIN QUERY PLAN` against the
real captured SQL: at **N = 1** the plan is
`SEARCH po USING INDEX price_observations_security_date_idx
(security_id=? AND adjustment_state=? AND market_date>? AND market_date<?)`;
at **N >= 2** it degrades to `(security_id=? AND adjustment_state=?)` — the
engine walks every index entry for each held security across the whole
history and filters the OR in the VM. Rows returned dropped 60,012 -> 720
(a real Worker-CPU/marshalling win, which is what fixes an `Error 1102`),
but D1's `rows_read` billing counts scanned rows, so a "83x fewer rows read"
claim is wrong in the dimension that matters for the free-plan 5M rows/day
budget. `UNION ALL` per window DOES keep the full seek in every branch
(measured equal engine time, 0.99 ms vs 0.83 ms on 60,012 rows) but repeats
the `security_id IN (...)` list per branch, so 10 windows x 18 securities =
180 bound parameters — past D1's 100 cap (pattern 11). **How to apply:**
whenever a diff swaps one range predicate for OR'd/multiple ranges, run
`EXPLAIN QUERY PLAN` on the captured SQL at N=1 AND N=the real caller's N
(the degradation only appears at N>=2), and insist the commit/test wording
say "rows returned/marshalled", not "rows read". Note the existing
`assertNoLargeTableScans` guard cannot catch this at all: the plan says
`SEARCH`, not `SCAN`, and it is alias-blind anyway (pattern 9b).

**16. Performance commits here MUST carry their own `docs/ARCHITECTURE.md`
entry; only `TASKS.md` lands separately.** PRF-002/PRF-003/PRF-004 each
included the ARCHITECTURE.md rule/correction in the SAME commit as the code
(`5e0aa2b`, `0026008`, `cfa3ed9`, `9738cad`), while the `TASKS.md` entry
arrived in a follow-up Orchestrator commit (`418a9bc`). PRF-005 shipped with
zero doc changes and left PRF-003's recorded sentence
("`loadHistoricalPortfolioValueAtDates` (Multi-Year, tolerance-7) is
deliberately NOT narrowed this way") standing as a now-false claim. The
file's convention is never-rewrite-history: append a dated **Correction**
paragraph, do not edit the original. **How to apply:** for any PRF-/perf-class
diff, grep `docs/ARCHITECTURE.md` for the prior task's entry about the exact
function being changed and require a correction; missing `TASKS.md` is NOT a
worker finding. Repeated by PRF-006 (2026-08-31, `f8b4af9`): removing
`loadAuthenticatedWorkspace`'s `loadPublishedOverview` read left
`docs/ARCHITECTURE.md:621` (CALC-005 entry) asserting "the Overview loader now
only calls `snapshotRepo.loadPublishedOverview`" — false the moment the call
went. Grep the touched symbol name in `docs/ARCHITECTURE.md`, not just the task
ID.

**17. "This dead read always returned null, so I inlined the null result" —
check the ERROR path, not the success path.** The success value is usually
genuinely identical, but the deleted `.catch` was reachable (any D1 failure on
a plain SELECT) and its fallback was often a DIFFERENT read model. PRF-006
removed `loadPublishedOverview().then(createOverviewData).catch(() =>
createUnavailableOverviewData(base))` in favour of `createOverviewData(null)`:
status flips `"unavailable"` -> `"empty"` on D1 error, and
`app/components/portfolio-shell.tsx`'s `data.status === "unavailable"` branch
returns an early "Overview unavailable" page that SUPPRESSES the hero, while
the `"empty"` branch renders chart + hero normally. Here the change is an
improvement (a transient error on a permanently-empty table no longer nukes the
page), but the worker's comment claimed the catch "was never the code path" /
"never actually threw in production" — inference written as observation, which
AGENTS.md forbids. **How to apply:** diff the two fallback values, then grep the
consuming component for `status === "<old fallback status>"` to see what the
user actually saw; require the comment/doc to state the error-path change rather
than deny it. Also verify the "no writer can ever exist" half structurally:
grep every `INSERT INTO <table>` and walk its callers' pipeline arguments
(PRF-006's held: `advanceCalculationRuns` is only ever called with
`pipeline: "projection"`, and `sweepCalculationRuns` calls the unbounded
`terminatePipeline("snapshot")` before `listClaimablePortfolios`), and confirm
the table is absent from the backup/restore table lists in
`domain/exports/system-backup.ts` so a restore cannot reintroduce rows.

**18. A "landing page" redirect added to a ROUTE silently repoints every
in-app link that already pointed at that route.** UI-051 (2026-08-31) made
authenticated `/` redirect to `/portfolio/<first>/holdings` whenever a
portfolio exists. The task/spec only spoke about "first load", but `/` is also
the href of four live owned-mode chrome links in
`app/components/portfolio-shell.tsx` — the topbar brand
(`aria-label="YieldToMe overview"`), the portfolio popover's "All portfolios →",
the drawer brand, and the drawer's "Overview" item (all four are enumerated by
`tests/prf-006.test.ts`'s prefetch guard, which is the fastest way to find
them). Two carry visible labels that then lie about their destination. Also
check `app/manifest.ts`'s `start_url`, `HistoryBackControl`/`AreaExitBackControl`
`fallbackHref="/"` (`app/import/page.tsx`, `app/components/import-review.tsx`),
and `app/last-primary-tab.ts`'s `isPrimaryTabPath`, which accepts `"/"` as a
remembered tab (harmless: one extra hop, no loop). **How to apply:** for ANY new
route-level `redirect()`, grep the whole repo for links to that exact path
(`href="<path>"`, `redirect("<path>")`, manifest/start_url, back-control
fallbacks, sessionStorage-remembered paths) before judging the blast radius; a
labelled control whose destination silently changes is a blocking defect even
when the redirect itself matches the delegated spec. Related: superseded rulings
(here UI-024's `/?section=X` → `/portfolio/:id/:section` redirect) leave a now
unreachable branch plus a unit test whose TITLE still asserts route-level
behaviour — flag the stale title, not just the dead code.

**6. Coverage lands on the mechanism that was ALREADY safe, not the one the
task changed.** EXP-004 added an `idempotency_key` to the *imported* dividend
replay path (`wasImported === true`) and tested transactions-part resend plus
the manual-create dividend path, but never resent a dividends part, and its
fixture produced only `wasImported === false` records — so the newly added
dedupe branch had no coverage at all. **How to apply:** for every behaviour a
diff CHANGES, find the test that exercises that exact branch; a passing suite
that only exercises the neighbouring, unchanged branch is not coverage.
