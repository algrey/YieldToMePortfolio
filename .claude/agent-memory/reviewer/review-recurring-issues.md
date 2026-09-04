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

**19. `String(x)` over a SQL value that only became NULL-able in THIS diff
writes the literal 4-character string `"null"` into a NOT NULL column.**
PRF-007 (2026-09-01) widened `import-commit.ts`'s `finalize` affected-portfolio
query to a `transactions UNION ALL dividend_manual_records` subquery. The
correlated `ledger_high_water` subquery (latest `posted`/`reversed`
transaction) could never be NULL before — every `affected` row came FROM a
just-committed transaction — but a dividend-only commit into a portfolio with
zero transactions now returns NULL, and `String(row.ledger_high_water)` stores
`'null'` in `calculation_runs.ledger_high_water_start`. Verified: the run then
completes and publishes `projection_publications.ledger_high_water = 'null'`
even when a real transaction exists, because `'null'` is TRUTHY so
`calculation-executor-service.ts`'s `if (!highWater)` /`resolveEmptyHighWater`
fallback never fires. The repo's designed sentinel for "queued with no ledger
transaction" is `''` (`db/repositories/market-data.ts`'s two `manual_override`
inserts). **How to apply:** for any diff that widens a query's row set, list
every column whose NULL-ability changes as a result, then grep the TS that
consumes it for bare `String(...)`/`Number(...)`; check whether a sentinel
value already exists elsewhere for that column rather than inventing one.

**20. A commit/test header that names the owner's reported symptom as the
thing it fixes.** PRF-007's `tests/prf-007.test.ts:11-13` states the queueing
gap "is the owner's 'still had the old values' report on `/income`". Traced:
`/income` reads dividends LIVE (`app/owned-dividend-history.ts` →
`createDividendManualRecordRepository(client).list(...)`), and neither
`db/repositories/projections.ts` nor
`domain/snapshots/historical-portfolio-value.ts` /
`domain/dividends/shares-held.ts` consume `dividend_manual_records` at all —
so a queued projection run cannot change what a dividend-only commit shows
there. The claim came from the Orchestrator's own TASKS.md Finding A, and the
worker repeated it verbatim. **How to apply:** for any "this is the owner's
bug" sentence, walk the actual read path of the named page and confirm the
data it renders flows through the mechanism being fixed; a fix can be
structurally correct and still not be the reported symptom's cause.

**21. "The per-call FIXED cost doesn't shrink with the bound, so a smaller
bound buys nothing" — measure at N=1 before believing it.** BUG-010
(2026-09-01) justified stopping `MAX_DERIVE_DATES_PER_READ` at 10 rather than
5 or 1 on a fixed cost that a linear 10→400 extrapolation puts at ~2.7ms.
Measured directly: N=1 costs 1.58ms, N=5 3.30ms, N=10 5.29ms — the "fixed"
cost is itself bound-dependent, because `loadFacts`' `priceWindow` narrows to
the slice's own date span (PRF-003), so fewer dates also means fewer price
rows marshalled. Going 10→1 cut the derive path 70%, not "almost nothing".
**How to apply:** any "knee of the curve" argument is a claim about the
curve's SHAPE; re-measure at the low end rather than extrapolating a slope
taken between two large points. Related: pattern 10 (numbers measured with
the fixing commit's own harness).

**22. A new CRON sweep adds its read cost EVERY tick forever, including
after it converges.** BUG-010's `sweepValueHistoryBackfill` calls the same
`resolveValueHistorySeries` the read path calls, whose `loadCandidateDates`
does a `DISTINCT market_date` seek over `price_observations` for every held
security across the whole range (~47k index entries at the owner's 18
securities x ~2,600 dates). A fully-converged portfolio still pays it: 24
hourly ticks x ~47k ≈ 1.1M `rows_read`/day added permanently, against D1's
free 5M/day — the same budget PRF-005 follow-up (b) already flagged as open.
**How to apply:** for any new scheduled sweep, ask what it costs on the tick
where there is NOTHING to do, multiply by the tick frequency, and check it
against the free-plan daily `rows_read` allowance — not just the per-tick CPU
bound the worker sized it against.

**23. "Durable partial progress via chunked writes" is inert when the bound
is smaller than the chunk size.** BUG-010's ARCHITECTURE.md entry claims a
CPU-killed invocation "leaves every committed chunk in place" because
`upsertStoredValueHistory` writes in `VALUE_HISTORY_CHUNK_SIZE` batches — but
that constant is 50 (`db/repositories/portfolio-value-history.ts`) and both
configured bounds are 10 (read) and 20 (cron), so there is exactly ONE batch
per slice and nothing is durable mid-slice. Forward progress rests entirely
on the slice fitting the budget. (The cron's cross-PORTFOLIO durability is
real — each portfolio commits before the sweep moves on.) **How to apply:**
whenever a doc credits chunking/batching for partial durability, compare the
chunk constant against the actual bound that feeds it.

**24. ONE watermark/cursor shared by TWO independent data streams narrows the
LAGGING stream by the LEADING one.** BRK-015 (2026-09-02) derived the routine
Sharesight sync's fetch window from a single `MAX(effective_date)` over a
`transactions UNION ALL dividend_manual_records` subquery, then passed that one
`from` to BOTH `listTrades` and `listPayouts`. Proved with a scratch test: with
the last committed payout at 2026-06-01 and a later committed trade at
2026-08-01, the payout call goes out as `from=2026-07-02`, so a payout
late-entered by the provider for 2026-06-20 — only 19 days past the payout
stream's own watermark, well inside the nominal 30-day overlap — is invisible to
that sync and to every later routine sync (the watermark only moves forward).
The failure is silent and permanent-until-full-resync, and it is worst when one
stream has NO committed rows at all (e.g. dividends arrived by CSV, so no
`sharesight-payout:`-prefixed row exists) — then that stream's window is
governed entirely by the other's. **How to apply:** whenever an incremental
sync/backfill computes a single cursor and fans it out to more than one
endpoint/table, ask what happens when the streams advance at different rates;
require a per-stream cursor (or, at minimum, `MIN` across streams plus an
explicit doc sentence). A per-stream test is cheap: commit stream A late,
stream B early, then assert the window sent for B. Corollary found in the same
task's fix round: once the streams are split, each stream's lookback constant
must be sized against the date field the REMOTE filter actually uses, not the
one the local watermark is derived from (see
[[project-sharesight-sync-invariants]] — the payouts filter is ex-date, the
watermark is paid date, so the constant carries a deliberate +gap margin).

**25. A new preview/read query that re-derives "what is currently true" picks
a plausible-looking status filter whose stated rationale it does not achieve.**
BUG-011 (2026-09-02) loaded "every POSTED buy/sell transaction" for a
cross-route duplicate-trade warning, with a comment explaining that
`status = 'reversed'` rows are excluded because they "no longer represent a real
economic fact currently in force". Proved false end to end: reversal leaves a
`status='posted'` compensating MIRROR carrying the identical economic identity
(see [[project-sharesight-sync-invariants]]), so a fully reversed trade still
matches — precisely on the reverse-then-re-import workflow the same task
prescribes. **How to apply:** for any new "live state" predicate, enumerate every
writer that can produce a row satisfying it (`ledger.reverse`/`supersede`,
system-generated mirrors, restores) rather than reading the status column's name;
then say plainly whether the comment's stated rationale is achieved. Cheap proof:
copy `tests/imp-004a.test.ts`, run its commit-then-reverse round trip, and print
the new query's rows before and after.

**26. `decimal()`-family helpers in `domain/imports/reconciliation.ts` THROW.**
`DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/` (identical to `domain/ledger/
event-validation.ts`'s `CANONICAL_DECIMAL`) rejects negatives, leading zeros,
`""`, `1e2`, `100.`, whitespace — and `decimal()` throws `Invalid decimal: …`
rather than returning null. Feeding DB-sourced strings into it (BUG-011's
`decimalEqual` over `transactions.quantity_decimal`) puts an uncaught throw on
the whole import-preview page. Currently unreachable because every production
writer goes through `prepareLedgerPosting`, which validates the same grammar.
**How to apply:** when a diff routes a NEW source of strings into these helpers,
check the writers of that column for the same validation, and treat "a legacy or
hand-written row breaks the entire page" as a real (if low-probability) blast
radius worth a follow-up.

**27. A fix round that NARROWS a query's scope trades a false positive for a
silent false negative, justified by an invariant that does not hold.** BUG-011's
cleanup round (2026-09-02) scoped the duplicate-trade comparison set to
`batch.targetPortfolioId`, on the stated invariant "a row can only ever
reconcile against securities/trades in ITS target portfolio". Disproved with a
two-portfolio fixture: `portfolioFor` (`domain/imports/reconciliation.ts`)
resolves in the order **portfolio mapping DECISION `targetId` → row's own
`targetPortfolioId` (defaulted to the batch's) → unique portfolio NAME match**,
so a `kind:"portfolio"` decision sends a row into a different portfolio (proved:
`resolvedTargets` = the OTHER portfolio, row still creates), and with a null
batch target a row still fully resolves by name — while the same round's code
skips the query entirely for a null target "because no row can resolve a
security at all". The cap path in the same diff got a visible
`TRADE_DUPLICATE_CHECK_UNAVAILABLE` disclosure; these two narrowings got none.
**How to apply:** when a round replaces "load everything for this user" with
"load only X", enumerate every code path that can produce a row outside X before
accepting the invariant, and require the same disclosure the diff already gives
its other degraded path. `app/components/import-review.tsx`'s portfolio-mapping
`<select>` lists EVERY owned portfolio, so "the batch target is the only
possible target" is never safe to assume here.

**29. An added `IS NULL` predicate can HIJACK the index choice away from the
ownership column.** BUG-011's F1 fix added `AND reverses_transaction_id IS NULL`
to a `WHERE user_id = ? …` read of `transactions`. Measured with
`EXPLAIN QUERY PLAN` on the schema-only DB: the plan flips from
`SEARCH transactions USING INDEX transactions_owner_portfolio_idempotency_unique
(user_id=?)` to `SEARCH transactions USING INDEX transactions_one_reversal_unique
(reverses_transaction_id=?)` — SQLite seeks the NULL group of the unique index on
`reverses_transaction_id`, which contains every non-mirror transaction of EVERY
owner, and applies `user_id` as a per-row filter. Correctness is unaffected
(ownership is still in the `WHERE`; cross-owner isolation verified on a fixture)
but the rows-scanned profile stops being owner-scoped. `+reverses_transaction_id
IS NULL` (SQLite's unary-plus no-index hint) restores the `user_id` seek —
verified. **How to apply:** re-run EXPLAIN after ANY new predicate lands on an
owner-scoped read, not just when the diff touches the SQL's shape; a
nullable column with its own unique index is the classic hijacker. Related:
[[review-verification-commands]]'s schema-only EXPLAIN recipe.

**28. A mirrored-query test proves the mirror, never the production query.**
`tests/imp-004a.test.ts`'s `pagePreview` re-implements
`app/import-actions.ts`'s private `loadReview` SQL because that module imports
`./portfolio-actions` (`next/headers`) and cannot be imported by the runner.
Tests written against it cannot fail when the production query changes — BUG-011
F3's "F1 regression" test passes with or without the app-side fix. The repo's
own remedy exists: `tests/imp-003b.test.ts:553` reads
`app/import-actions.ts` with `readFile` and `assert.match`es the exact source
line. **How to apply:** accept the mirror for behaviour, but require a source
pin for any predicate the fix actually turned on, and verify the mirror text
still equals production (normalize whitespace and diff the two strings — one
`node -e` command).

**30. A "self-invalidating" fingerprint taken over the CACHE table cannot see
changes on the SOURCE side.** PRF-010 (2026-09-02) skipped the cron backfill's
`loadCandidateDates` scan whenever a stored marker
(`portfolios.value_history_backfill_verified_at/_fingerprint`) still matched a
live `(COUNT(*), MIN(value_date), MAX(value_date))` snapshot of
`portfolio_value_history`. "Missing" is `candidates(price_observations) MINUS
stored(portfolio_value_history)`, so the fingerprint observes only the
subtrahend: a price write that makes a NEW date a candidate (the daily
`delayed` rollup — `PRICE_SCOPE` does not filter `interval`, so today becomes a
candidate the moment the first tick lands, and the accompanying invalidation
DELETE removes 0 rows because nothing is stored for it yet) leaves the
fingerprint byte-identical, and the tick returns
`missingDates: 0, backfillPending: false` without looking. Proved with real
writers in ~90 lines. The count+min+max COLLISION is also reachable without
contrivance: 2 new interior candidate dates + a real
`invalidateStoredValueHistoryForSecurity` of 2 interior dates + one
budget-2 tick restores `rowCount` and both bounds exactly while two resolvable
dates stay missing. **How to apply:** for any "derived from the table every
invalidation path already mutates, so it self-invalidates" claim, write the
predicate the marker is standing in for and check EVERY term of it — the claim
usually only covers the terms the diff's own invalidation list names. Ask
separately what re-writes the marker: if the skip path does not refresh
`verifiedAt` (PRF-010's does not), staleness is bounded by the recheck interval
and the finding is a lag, not a stall.

**31. A cheap-aggregate "after" cost measured as rows RETURNED is off by the
size of the index range it scans.** PRF-010 recorded "Measured after-cost for
the same converged tick: **2 rows**" in `docs/ARCHITECTURE.md` §9.5, the commit
message and the test's console line — from a census wrapper that counts
`get()` results (1 row each). The replacement query is
`SELECT COUNT(*), MIN(value_date), MAX(value_date) ... WHERE user_id=? AND
portfolio_id=?`, whose plan is `SEARCH portfolio_value_history USING COVERING
INDEX portfolio_value_history_user_portfolio_idx (user_id=? AND
portfolio_id=?)` — it visits every stored row of the portfolio (~2,600 at the
owner's scale), which is what D1 meters. Honest figure: ~49,400 → ~2,600
`rows_read` per converged tick (~95%), not 46,800 → 2. The same file's own
comment warned about exactly this for the `DISTINCT` scan, and the repository
module's doc comment said the aggregate "still visits every stored row" — the
doc contradicted its own code comment. **How to apply:** whenever an "after"
number comes from a rows-returned counter, EXPLAIN the new query; any
`COUNT`/`MIN`/`MAX`/`DISTINCT`/`EXISTS` returns 1 row and reads a range.

**32. A "malformed value is caught, never throws" test that feeds a value the
parser actually ACCEPTS.** BUG-013 (2026-09-02) guarded
`cashTotalsWithinTolerance` with a try/catch and "proved" it with
`cashTotalDecimal: "-2.50"` plus the inline comment `// leading '-' rejected`.
`domain/calculations/decimal.ts`'s `DECIMAL_PATTERN` is
`/^-?(0|[1-9]\d*)(?:\.(\d+))?$/` — it ACCEPTS negatives (only `-0` is
rejected); `parseDecimalResult("-2.50")` returns fine. The test passes because
-2.50 vs 2.50 is outside the 1% tolerance, and it passes identically against
the parent commit, so the catch has zero coverage. Values that DO throw:
`""`, `"1."`, `"01.5"`, `"1e2"`, and any `undefined` reaching it (a
`normalized_fields_json` key that predates the column deserializes as
`undefined`, which is `!== null` and sails past every `x === null` guard into
`parseDecimal`). Note the repo has TWO different decimal grammars in play and
they differ: `domain/imports/reconciliation.ts`'s local `DECIMAL` rejects
negatives, `domain/calculations/decimal.ts`'s does not. **How to apply:** for
any "unparseable input is handled" test, run the parser on the fixture value
yourself (one `node --experimental-strip-types` line) before accepting it as
coverage. Related: pattern 26.

**33. A guard added on the PURE side while the throwing call stays on the
CALLER side.** Same task: `safeComputeDividendCashTotal` in
`domain/imports/reconciliation.ts` carries a comment naming "an existing DB
entry's decimal columns could ... throw ... and 500 the whole import review
page" as the risk it guards — but the DB columns are parsed in
`app/import-actions.ts`'s `loadReview` (`computeDividendCashTotal` over
`shares_decimal x dividend_per_share_decimal`), with no try/catch, before the
pure function ever sees them. The pure guard only covers the staged-row side
and the verbatim `total_cash_decimal` path. **How to apply:** when a diff adds
a `safeX` wrapper, grep every call site of `X` in the diff and confirm the one
handling the data source the comment names is the one wrapped.

**34. An advisory duplicate warning with no "already dedupe-bound" suppression
fires on EVERY row of a routine re-sync.** BUG-011/BUG-013's
`TRADE_NEAR_EXISTING_ENTRY`/`DIVIDEND_MATCHES_EXISTING_ENTRY`/
`DIVIDEND_NEAR_EXISTING_ENTRY` compare economic identity only. A routine
Sharesight sync re-stages rows already committed (the 2026-09-01 batch staged
226 trades and committed 0), so every one of them matches itself. Measured on
a 126-payout owner-shaped fixture: 0 warnings before the widening, **252
after** (2 per row), all guaranteed noise — `db/repositories/import-commit.ts`
skips those rows on exact `source_reference` match, so they cannot double-post
at all. The preview already has the data to suppress them
(`input.existingDividendSourceReferences`, used a few lines later to build
`alreadyImportedRows`). **How to apply:** for any new preview-time advisory,
ask what it does on a re-import of rows the commit path will skip anyway, and
count the warnings on a realistic fixture rather than a 1-row test.

**35. Not every uncapped preview query repeats BUG-011's F2 defect — check
which DIRECTION truncation fails in.** F2's rule exists because truncating
`existingTradeRows` (a per-row comparison set) yields silent FALSE NEGATIVES
indistinguishable from a genuine non-match. A `source_reference` SUPPRESSION
set is the opposite: a missing entry means the warning still fires, so
truncation degrades to noise, never to silence. BUG-013's ruling-1 round added
an uncapped `existingTradeSourceReferences` query on that reasoning, matching
the already-shipped uncapped `existingDividendSourceReferences` twin.
**How to apply:** before calling an uncapped query a repeat of a prior ruling,
ask what a truncated result would actually cause; reserve Blocking for the
false-negative direction, and recommend a fail-OPEN bound (overflow disables
suppression) rather than the fail-closed bound the comparison-set queries use.

**36. A "did anything actually change?" CLASSIFIER that compares FEWER fields
than the digest/hash which decided something changed.** BRK-014 (2026-09-03)
added `isRowAlreadyImported` (`app/sharesight-sync-service.ts`) to tell a true
no-op re-sync from a Sharesight-side correction, comparing trade
quantity+price / payout cash total against the committed row. But the batch
digest that CREATES the new batch (`canonicalRowDigestFields`) hashes 13
value-bearing fields — type, symbol, exchange, currency, shares, price,
commission, localTradeDate, tradeAtUtc, frankingPerShare, totalCash,
totalFranking, exchangeRateDecimal. Reproduced with real writers: a
franking-credits-only correction and a trade-DATE-only correction each create a
genuinely NEW batch and then report `newRows: 0` with the message "No new
rows -- every staged row already matches an existing record" — self-
contradictory, and it hides exactly the correction the digest work exists to
surface. **How to apply:** when a diff adds a "unchanged / already imported /
no-op" predicate, list the fields of the mechanism that already decides
"changed" (digest, fingerprint, idempotency key, ETag) and diff the two field
sets; anything in the digest but not the comparator is a silent false
"unchanged". Cheap proof: commit a row, re-sync the same id with ONE
non-compared field changed, print the result counts and the formatted message.
Ask separately which semantics the surface claims — "commit will change
something" vs "the remote data differs from what we hold" — because the two
give different answers and a mixed implementation is inconsistent either way.

**36b. The FIX round for pattern 36 covers exactly the fields the
prescription named, then CLAIMS completeness.** BRK-014 round 2
(2026-09-03) added the five prescribed comparisons (payout franking +
payment date; trade fee + date + type) and wrote, in both the doc comment
and `docs/ARCHITECTURE.md`, "every digest field a payout/trade row can
independently vary on" — excusing the rest because `symbol`/`exchange`/
`currency` are "identity fields already folded into `sourceReference`" and
`exchangeRateDecimal` "has no committed counterpart on either table". Both
excuses are false (see [[project-sharesight-sync-invariants]]), and three
more correction shapes (payout FX rate, payout symbol, trade currency)
still print the identical false "No new rows" sentence on a genuinely new
batch. **How to apply:** after a widening fix, re-run the field-by-field
enumeration yourself against the identity key and the actual INSERT
builders — never accept the diff's own exclusion list — and treat any
sentence asserting completeness as a claim to verify. Check the trap
direction too: a column stored only CONDITIONALLY (the payout FX rate is
stored only when the payout is foreign to its security) turns a naive
"just compare it too" into a permanent false "new" on every re-sync, so the
obvious prescription may not be the safe one.

**36c. "A NEW batch can only exist because a value CHANGED" — a
content-addressed batch id is keyed to the whole fetched ROW SET, so a
different row COMBINATION creates one too.** BRK-014 round 3 (2026-09-03)
gave the `reused === false && newRows === 0` case its own panel sentence
asserting "Sharesight's data differs from the previous sync on a field that
is not compared (for example a symbol, exchange or market code change)".
`canonicalFetchDigestSource` hashes `{portfolioId, sharesightPortfolioId,
sorted canonical rows}`, so the digest also differs when the FETCHED SET
differs: a Full resync covering two payouts previously committed by two
separate routine syncs (the shape `tests/brk-005.test.ts:1733` itself calls
"the owner's exact 2026-09-02 production shape"), a routine window that
narrowed after a commit advanced the watermark, a row Sharesight dropped, or
the first sync on a bundle-restored ledger where no prior batch exists at
all ("differs from the previous sync" when there was none). Reproduced in
~90 lines with the suite's own fixtures: `reused:false, rowsStaged:2,
newRows:0` with nothing changed remotely, printing the false sentence plus
"review the batch before accepting" on a pure no-op — the inverse of the
task's own acceptance criterion. **How to apply:** whenever a surface
derives a CAUSE from a boolean like `reused`/`isNew`/`cacheMiss`, enumerate
every input to the key that boolean is computed from (here: the row set, not
just the 13 per-row fields) and test the sentence against each; honest copy
states what is known ("this batch is new, so either a different set of rows
came back or an uncompared field changed"), never one cause as fact.

**36d. "All N regression tests fail against the pre-fix commit" — run
them.** The same round wrote that claim into `docs/ARCHITECTURE.md` for four
tests; measured with `git archive <prev> | tar -x` + a `node_modules`
symlink + the NEW test files copied in, three failed and the fourth (a GUARD
test pinning that a stored-NULL FX rate is NOT treated as changed) passed
against the pre-fix code, because the pre-fix code did not compare that
field at all. A guard test for the direction a naive fix would break can
never fail pre-fix. **How to apply:** classify each new test as regression
(must fail pre-fix) or guard (cannot) before accepting a blanket claim; see
[[review-verification-commands]] for the pre-fix tree recipe.

**6. Coverage lands on the mechanism that was ALREADY safe, not the one the
task changed.** EXP-004 added an `idempotency_key` to the *imported* dividend
replay path (`wasImported === true`) and tested transactions-part resend plus
the manual-create dividend path, but never resent a dividends part, and its
fixture produced only `wasImported === false` records — so the newly added
dedupe branch had no coverage at all. **How to apply:** for every behaviour a
diff CHANGES, find the test that exercises that exact branch; a passing suite
that only exercises the neighbouring, unchanged branch is not coverage.

**36e. A correction round fixes the over-claim in the DOC and leaves the
identical sentence in the TEST FILE (and vice versa).** BRK-014 round 4
(2026-09-03) corrected `docs/ARCHITECTURE.md`'s "all four round-3 tests fail
against the pre-fix code" and correctly re-labelled the stored-NULL-FX test a
guard there — but `tests/brk-005.test.ts:2000-2001`'s own block header still
says "All four tests below FAIL against the pre-fix code (`8097185`…)" and then
enumerates only three. Same round: the corrected user-facing sentence still
opens "Sharesight returned a different set of rows **than the last sync**",
although the very shape the prior ruling named — the first sync on a
bundle-restored ledger, where there IS no last sync — is reachable and prints
it. Reproduced in ~40 lines: commit a sync, `DELETE FROM import_batches`
(+`import_rows`/`import_issues`, NULL out `dividend_manual_records
.import_batch_id`) to emulate a restore (`domain/exports/portfolio-bundle.ts`
carries `transactions`/`dividendManualRecords`, never `import_batches`), re-sync
→ `reused:false, newRows:0` with the whole disjunction false. **How to apply:**
when a round's finding is "sentence X is false", grep the sentence's distinctive
words across `docs/`, `app/`, `db/` AND `tests/` and check every hit; and re-test
the REPLACEMENT sentence against every shape the original finding enumerated,
including the "there was no previous run at all" one that prose habitually
drops.

**37. A queueing/INSERT loop added inside an existing ATOMIC BATCH makes that
batch's statement count grow with a data-controlled cardinality — and the
module's own declared limit is pinned only by a single-portfolio fixture.**
BUG-016 (2026-09-03) added one `calculation_runs` INSERT per affected
portfolio into `db/repositories/import-reversal.ts`'s `finalize()` atomic
unit, which was a FIXED 6 statements before. Measured with a batch-`batch()`
counting client: 7 statements at 1 dividend-bearing portfolio, **12 at 6** —
past the module's own `IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit = 10`.
The commit-side twin it mirrors DOES cap (`import-commit.ts`'s
`LIMIT maxAffectedPortfolios + 1` + fail-closed `revalidation_failed`); the
new reversal query has no `LIMIT` and no guard. `tests/imp-003b.test.ts`'s
budget test cannot see it — its fixture is one portfolio, and the limits are
only ever asserted against that shape. Multi-portfolio batches are ordinary
here: commit resolves each row's portfolio through
`built.preview.resolvedTargets[row.id]`, and the CSV has its own `portfolio`
column. **How to apply:** whenever a diff pushes statements into a
`client.batch()` from a `.map()`/loop, find what bounds that array, then
re-measure the largest atomic unit with a fixture at N > 1 (direct
`INSERT`s into the grouped query's source table are enough — no need to drive
the whole import pipeline). Also check whether the sibling module that the
diff says it "mirrors" carries a cap the mirror dropped.

**37b. The FIX for pattern 37 moves the data-controlled growth OUT of the
capped limit and into its SIBLING limit in the same constant block.**
BUG-016 round 2 (2026-09-03) took the per-portfolio `calculation_runs`
INSERTs out of `finalize()`'s atomic `client.batch()` (back to a fixed 6
statements, verified) and issued them afterwards in chunks of
`maxStatementsPerAtomicUnit`. But `IMPORT_REVERSAL_LIMITS` also declares
`maxQueriesPerInvocation: 56`, and the deferred INSERTs are still N
statements on the same invocation: measured (2 trades + N dividend-bearing
portfolios, `chunkSize = maxChunkSize`) 51 queries at N=1, **56 at N=6**
(exactly the ceiling), 57 at N=7, 60 at N=10, **75 at N=25** — the round's
own new `maxAffectedPortfolios` ceiling. Neither the pre-existing budget
test (2 trades, 0 dividend portfolios) nor the round's new B1 pin (asserts
per-`batch()` sizes only, `deepEqual(batchSizes,[6,6])`) can see it.
**How to apply:** when a round relieves one declared bound, re-measure
EVERY constant in the same `*_LIMITS` object at the diff's own newly
declared ceiling, not just the one the prior finding named. The repo's
accepted remedy is CALC-004 B2's: raise the bound with a re-measured
justification comment AND add an at-the-ceiling regression test
(`tests/imp-003a.test.ts`'s exactly-25-portfolio commit is the precedent).

**38. A "best-effort, mirrors the commit route" post-action advance that
drops the commit route's TERMINAL-STATUS gate.** BUG-016 F1 wired
`advanceCalculationRunsForCommit` into `app/import-reversal-service.ts`
gated only on `result.rebuildJobIds.length > 0`, while
`app/import-commit-actions.ts` gates on
`result.status === "committed" && …` — a deliberate gate, because
`import-commit.ts`'s finalize returns non-empty `rebuildJobIds` on NON-final
chunks too (its job query has no terminal-status filter). `MAX_CHUNK_SIZE`
for reversal is 2, so a 226-row batch is 113 invocations, each now running a
full FIFO projection rebuild + publish. Measured on 6 trades: shipped
75/72/65 statements with `completedRuns` 1→2→3; the same code with the gate
added reaches the IDENTICAL end state (1 publication, 1 completed run, 0
queued) at 46/45/65. **How to apply:** whenever a diff says it "mirrors" a
sibling call site, diff the two CONDITIONS character by character, not just
the call arguments; then prove the gate is safe to add by running the gated
variant to convergence (`advanceCalculationRunsForCommit` bulk-supersedes
stale queued rows, so skipped intermediate chunks still converge).

**38b. The FIX for pattern 38 buys its cost saving by narrowing WHICH
portfolios get advanced — and then claims "nothing is stranded", pinned by a
single-portfolio fixture.** BUG-016 round 3 (2026-09-03) gated
`app/import-reversal-service.ts` on `result.status === "reversed"`, which is
correct and mirrors the commit route. But `advanceCalculationRunsForCommit`
only advances the portfolios reachable from the ids the FINALIZING invocation
returns, and those are just that chunk's own `ledger.reverse()` ids plus the
dividend-parity ids. Measured with a 2-portfolio / 4-transaction batch at
`chunkSize` 2: the final chunk reversed only `portfolio-c`'s trades, so
`portfolio-c` ends 1 completed + 4 `superseded_by_newer_run` while
**`portfolio-a` ends with 5 rows still `queued`** — pre-gate, chunk 1 advanced
them. The shipped pin (`tests/imp-003b.test.ts`, "advances calculation runs
once") asserts `queued/running = 0` on a SINGLE-portfolio fixture, so it cannot
see it, and `docs/CSV_IMPORT_SPEC.md`'s new paragraph states "Rows queued by a
non-final chunk are not stranded" unconditionally. **How to apply:** whenever a
gate/dedupe change reduces how OFTEN a fan-out advance runs, ask what the
surviving call's INPUT SET covers — an id list resolved to distinct portfolios
covers only the portfolios in that list — and re-run the scenario at N>1 of
whatever the module's own `maxAffectedPortfolios`-style constant says is
possible. Cheap proof: stage import rows with two different
`target_portfolio_id`s, commit, drive the chunked reversal to completion,
`GROUP BY portfolio_id, status` over `calculation_runs`.

**39. `*_LIMITS.maxQueriesPerInvocation` here counts STATEMENTS, not D1
subrequests, and is documentation-only.** In `db/repositories/import-reversal.ts`
only `maxChunkSize`, `maxStatementsPerAtomicUnit` (the phase-2 chunk size) and
`maxAffectedPortfolios` (the `LIMIT`) are read at runtime; `maxQueriesPerInvocation`,
`maxStatementsPerInvocation` and `maxParametersPerStatement` appear nowhere but
their own declaration and `tests/imp-003b.test.ts`. The counting clients in
`tests/imp-003*.test.ts` add `statements.length` per `batch()` call, so the
headline number overstates real subrequests: measured at the 25-portfolio
ceiling, 75 "queries" = **32 actual D1 client calls**. So raising the bound can
never trip anything at runtime, and `docs/ARCHITECTURE.md:266`'s "Free D1
permits 50 queries per invocation" is not breached by a 90 constant.
**How to apply:** before treating a raised `maxQueriesPerInvocation` as a
free-plan risk, count `all/get/run/batch` calls (batch = 1) rather than
statements; and check `import-commit.ts`'s own comment, which already states
this bound "is a documentation-level budget target ... not a runtime-enforced
cap" — the reversal twin's comment omits that sentence.

**38c. The ACCEPTED remedy for 38b (recorded because it passed review).**
BUG-016 round 4 (`19a69f3`, 2026-09-03) fixed the stranding by making the
repository return the BATCH's affected-portfolio set
(`affectedPortfolioIdsForBatch`, `db/repositories/import-reversal.ts`) and
adding a portfolio-addressed sibling `advanceCalculationRunsForPortfolios`
that `advanceCalculationRunsForCommit` now delegates to (commit call sites
untouched). Checks that mattered and all held: the polymorphic
`commit_transaction_id` is discriminated by the SAME
`source.import_row_id = source_row.id` back-reference the reversal's own
`pendingTargets`/`remainingCount` use, so the advance set is exactly the set
the reversal could ever reverse — a NULL `import_row_id` row is invisible to
both, and restores cannot create one (`db/repositories/system-backup.ts` and
`domain/exports/*` carry no `import_batches`/`import_rows`, and the FK
`transactions(import_row_id,user_id,portfolio_id) -> import_rows` blocks a
cross-owner back-reference outright — verified, insert fails). Superseded
runs land as `status='failed', failure_category='superseded_by_newer_run'`;
that is normal, not a new defect. **How to apply:** when a later round
touches this path, these are the invariants to re-check rather than
re-derive.

**40. "Nothing ever deletes from this table" — a literal `DELETE FROM <table>`
grep returns nothing because the purge path builds the table name
DYNAMICALLY.** BUG-020 (2026-09-03) justified a `rowid` tie-break in
`db/repositories/calculation-runs.ts` with "no code path deletes a
`calculation_runs` row" in `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md` and the
doc comment. `grep -rn "DELETE FROM calculation_runs"` across the repo really
does return zero hits — but `db/repositories/account-lifecycle.ts` lists the
table in `PURGE_TABLES_IN_FK_ORDER` (:342) and `OWNED_TABLES` (:110) and issues
`DELETE FROM "${table}" WHERE rowid IN (...)` (:1844), and
`drizzle/0028_fancy_logan.sql` even carries a dedicated
`account_purge_lock_calculation_runs_delete` BEFORE DELETE trigger — which only
exists because deletes are an expected path. **How to apply:** for ANY
"never deleted / append-only / no delete path" claim, check
`PURGE_TABLES_IN_FK_ORDER` + `PURGE_CLEANUP_TABLES` + `OWNED_TABLES` in
`db/repositories/account-lifecycle.ts` and grep for `DELETE FROM "${` before
accepting it. Note the *correctness* usually survives: SQLite assigns
`max(rowid)+1` over the rows that STILL EXIST, so rowid order equals insertion
order among coexisting rows even with deletes and rowid reuse (probed: purge
owner A, insert a new B row -> rowid still above every live B row; purge
everything -> next rowid restarts at 1, still monotonic). So the finding is a
false recorded invariant, not a broken fix — say so explicitly and prescribe the
stronger, true justification instead of asking for a redesign. The other
untested half of such a guarantee here is the drizzle TABLE-REBUILD migration
(`__new_<table>` + `INSERT ... SELECT` + `DROP` + `RENAME`, used on
`calculation_runs` in `drizzle/0017` and `drizzle/0040`): it reassigns rowids
and preserves relative order only because the copy `SELECT` has no `ORDER BY`.
Resolution accepted 2026-09-03 (commit `7070ed2`): the fix that clears this
class of finding is documentation-only — restate the guarantee as `max(rowid)+1`
OVER SURVIVING ROWS, name the delete path (account purge) explicitly, scope the
comparison to one user/portfolio/pipeline, and record the table-rebuild
`ORDER BY rowid` hazard. Do NOT demand a sequence column or schema change when
the weaker-worded claim was the only defect.

**41. A "newest interesting row" status subquery whose candidate set EXCLUDES
the success status turns any terminal failure into a PERMANENT banner.**
BUG-017 (2026-09-03) folded
`(SELECT cr.status ... WHERE ... AND cr.status IN ('queued','running','failed')
AND (cr.status <> 'failed' OR cr.failure_category <> 'superseded_by_newer_run')
ORDER BY cr.created_at DESC, cr.rowid DESC LIMIT 1)` into
`app/owned-holdings.ts`/`app/owned-capital-gains.ts`'s publication read to
detect a stale projection. `completed` is not in the `IN` list, so a run that
failed terminally is still "the newest matching row" after every later run
succeeds: reproduced with real writers (run-1 completes+publishes, run-2 hand-
failed `oversell`, run-3 queued and advanced to completion) -> publication is
run-3 with the correct quantity 12, yet `projectionPending =
{pending:true,reason:"failed"}` forever, rendering "The last recalculation
failed - figures reflect the previous successful calculation" on Holdings,
Overview and Gains. Both halves of that sentence are false. The exclusion the
diff DID have (`superseded_by_newer_run`) covers only the bookkeeping category,
so a suite that tests only supersession looks complete. **How to apply:** for
any `ORDER BY ... LIMIT 1` "latest state" subquery, list the statuses NOT in the
candidate set and ask what it returns after one of them lands. Verified fix
(kept all 14 shipped tests green): the outer query already joins the
publication's own run as `r`, so add
`AND (cr.created_at > r.created_at OR (cr.created_at = r.created_at AND
cr.rowid > r.rowid))` -- "newer than what we are serving". Two related notes:
the candidate set is index-seeked per status group with a TEMP B-TREE sort, so
it reads EVERY queued/running/failed row of the portfolio (measured 0.072 ms at
500 rows, 0.788 ms at 5,000; `docs/ARCHITECTURE.md:645` records ~211 accumulated
rows on the real account, and `advanceCalculationRuns` creates one
`superseded_by_newer_run` row per committed import row) -- the `created_at`
predicate does NOT get pushed into the seek, so that growth is unbounded; and a
`failed` status is genuinely terminal (`nextClaimable` only takes `queued` or
lease-expired `running`), so skipping self-heal for it is correct.

**41b. The ACCEPTED remedy for 41 (recorded because it passed review).**
BUG-017 round 2 (`f1ac5bf`, 2026-09-03) added
`AND (cr.created_at > r.created_at OR (cr.created_at = r.created_at AND
cr.rowid > r.rowid))` to `PENDING_RUN_STATUS_SUBQUERY` in BOTH
`app/owned-holdings.ts` and `app/owned-capital-gains.ts` (`r` is the
publication's own run, already joined in each module's `PUBLICATION_SQL`).
Verified: `r.rowid` resolves through the join alias without being in the
SELECT list; the outer plan is unchanged
(`SEARCH pp ... / SEARCH r ... / SEARCH p ... / CORRELATED SCALAR SUBQUERY 1
SEARCH cr USING INDEX calculation_runs_portfolio_status_idx + TEMP B-TREE`);
census `/holdings` 17/17 and `/gains` 5/5 identical to the parent commit.
The hazard to check on any later round is a candidate run OLDER than the
published run that is now invisible: reproduced two shapes (an older
`running` row with a never-expiring foreign lease, which
`supersedeStaleQueuedRuns` deliberately never touches; and an older `queued`
row) — both are genuinely redundant because `advanceCalculationRuns` calls
`supersedeStaleQueuedRuns` BEFORE its claim loop, so any run that publishes
has a `ledger_high_water_start` at least as new as every older sibling. No
false negative. **How to apply:** re-run the four orderings (newer failure /
newer success / newer queued+self-heal / equal `created_at` with a higher
rowid) rather than re-deriving them.

**41c. `loadOwnedCapitalGains` short-circuits on `activeSellCount === 0`
and returns `projectionPending: {pending:false}` WITHOUT reading
`projection_publications` at all** (`app/owned-capital-gains.ts:~305-330`).
A gains-side fixture built from buys only therefore shows `pending:false`
while the holdings loader shows `pending:true` — a false "the two loaders
disagree" finding. Always seed at least one active `sell` transaction in
any gains projection-pending probe. (The short-circuit itself is sound: a
rebuild cannot create a disposal that no sell backs.)

**42. A new TEST file can break `tsc --noEmit` while every runtime check is
green.** BRK-016 (2026-09-03) shipped `tests/brk-003.test.ts:3112-3143`:
`let resolveSecondExchange: ((response: Response) => void) | null = null;`
assigned only inside a promise executor, then `assert.ok(resolveSecondExchange)`
+ `resolveSecondExchange!(...)`. `assert.ok` is an `asserts value` signature, so
asserting truthiness on a flow type of `null` narrows to `never` and the call is
`TS2349: Type 'never' has no call signatures`. Prettier, ESLint, the targeted
suites and the full `npm test` (which runs `vinext build`, NOT `tsc`) were all
green; `npm run typecheck` was clean at the parent commit. Verified fix: declare
it `| undefined` with no initializer (`let x: ((r: Response) => void) |
undefined;`) and drop the `!` — the sibling deferred-client helper in
`tests/brk-005.test.ts` avoids the trap only because it re-exports the captured
values instead of calling them in place. **How to apply:** run
`npm run typecheck` on EVERY review (see [[review-verification-commands]]) —
workers here habitually verify with format/lint/`npm test` only, and none of
those three type-check the tree.

**43. "These tests pass pre-fix" is unmeasurable when the test FILE cannot
import pre-fix.** BRK-016's corrected `docs/ARCHITECTURE.md` entry states both
"the two `(guard)`-labelled `brk-004.test.ts` tests pass unchanged pre-fix" AND
"`brk-004.test.ts` as a whole does not even import cleanly pre-fix" (the
`__resetSharesightIntegrationCacheForTests` seam ships with the fix). Both facts
are disclosed adjacently, so it was accepted as non-blocking — but the pre-fix
failure COUNT in such a file is an assertion-level inference, not a stash-and-run
measurement. **How to apply:** when a diff claims a pre-fix failure count, check
whether the test file imports a seam introduced by the same diff; if so, require
the count be labelled as assertion-level reasoning, or measured with the seam
stubbed. Companion to the "all tests fail pre-fix" entry above.

**44. A perf refactor that changes a typed ERROR STRING leaves the page's
error→copy mapper, the normative doc and the source pin all pointing at the
dead name.** PRF-011 (2026-09-03) replaced `app/owned-capital-gains.ts`'s
`lot_allocations` `count(*)` + `allocationRows.length !== allocationCount`
completeness check with a `LEFT JOIN` off `lot_allocations` plus the existing
per-field `requiredText`, so an unresolvable tax-lot/opening/sell/security
chain now throws `invalid_acquired_date` (etc.) instead of
`missing_allocation_dates`. The closed-failure guarantee survives, but three
consumers did not move with it: `app/portfolio/[portfolioId]/gains/page.tsx:69`
still maps only the dead name, so the case now falls through to the generic
`reason: "error"` copy ("The capital gains estimate could not be loaded")
instead of CGT-001B's specific "Some disposals ... are missing the acquisition
or disposal dates"; `app/components/capital-gains-screen.tsx:105` documents
`missing_dates` as covering exactly that case; `docs/CALCULATIONS.md:830`
still states the read service "fails typed (`missing_allocation_dates`)"; and
`tests/cgt-001b.test.ts:416`'s source pin still passes because the page's dead
branch is still there. Note the worker's own memory
(`.claude/agent-memory/worker/count-gate-removal-vs-orphan-detection.md`)
correctly flagged the string change and still missed the consumers.
**How to apply:** whenever a diff changes a thrown `Error` message that an app
layer discriminates on, grep the OLD string across `app/`, `docs/`, `tests/`
AND grep the NEW string in the mapper to confirm it has a branch; a
`reasonForError`-style mapper with a `startsWith`/equality list is the
signature to look for. Same commit must carry the doc correction (pattern 16).

**45. `LEFT JOIN`-off-the-driving-table reformulations of an owner-scoped read
are usually plan-safe here — verify, then say so.** PRF-011's rewrite keeps
every seek: `SEARCH la USING INDEX lot_allocations_owner_sell_idx (user_id=?
AND portfolio_id=?)` then unique-index seeks on `tax_lots`/`transactions` x2/
`portfolio_securities`/`securities`, `USE TEMP B-TREE FOR ORDER BY` in BOTH
old and new (schema-only EXPLAIN, zero rows). The only ordering nuance worth
stating: with `ORDER BY sell.local_trade_date` a broken chain sorts NULL FIRST,
so an orphan can never be pushed out of the `LIMIT MAX+1` window — the
fail-closed check still sees it.

**44b. The ACCEPTED remedy for 44 (recorded because it passed review).**
PRF-011 round 2 (`41def10`, 2026-09-03) restored the contract rather than
re-pointing the consumers: a `UNRESOLVED_CHAIN_FIELDS`/`unresolvedChainField`
helper in `app/owned-capital-gains.ts` checks the four LEFT-JOINed columns
(`acquired_date`, `disposed_date`, `symbol`, `name`) for `null`/`undefined`
BEFORE the `requiredText` mapping, emits ONE structured warn naming the field,
then throws the original `missing_allocation_dates`. Verified myself: all four
columns are NULL iff the chain fails (`transactions.local_trade_date` and
`portfolio_securities.source_symbol` are both `NOT NULL`, and the two COALESCEs
bottom out on `source_symbol`), so the null test is exact; a malformed-but-
PRESENT date still throws `invalid_acquired_date` (probe: set the opening
transaction's date to `2026-1-5` — do NOT use a slash format, it sorts below
every ISO date and trips `invalid_earliest_trade_date` first). The other half of
the remedy is the test shape worth reusing: `reasonForError` in
`app/portfolio/[portfolioId]/gains/page.tsx` was `export`ed (keyword only) and
the suite drives the REAL function on the REAL thrown message via
`execFileSync(process.execPath, ["--import","tsx","--input-type=module",
"--eval", script])`, because the page transitively imports `next/headers`.
Mutation-proved non-vacuous (rename the literal in the mapper -> the test fails
with `reason: 'error'`). **Caveat to state, not to block on:** such a test
"fails pre-fix" partly because the `export` seam ships with the same diff
(pattern 43) — against the true PRF-011 parent `7bbe2d9` the loader's behaviour
is already correct and the child process dies on a missing export. **How to
apply:** when a later round touches this path, re-check the four-column
null-iff-unresolved invariant against the migrations rather than re-deriving it.

**46. A `safeX` wrapper around a derivation that PASSES ONE INPUT THROUGH
VERBATIM is structurally blind to that input — the throw just moves
downstream to the COMPARISON.** BUG-014 (2026-09-03) wrapped both DIV-016C
`computeDividendCashTotal` call sites in `domain/imports/reconciliation.ts`
(:1202, :1256) with `safeComputeDividendCashTotalDiagnosed`. But
`computeDividendCashTotal`'s first line
(`domain/imports/dividend-reconciliation.ts:115`) is
`if (fields.totalCashDecimal !== null) return fields.totalCashDecimal;` — a
totals-mode amount is never PARSED there, so the wrapper's try/catch cannot
fire for it and `malformed` is always false. The value then reaches the two
still-RAW `cashTotalsWithinTolerance` calls
(`dividend-reconciliation.ts:191` inside `computeDividendReconciliation`, and
`reconciliation.ts:1339`'s `alreadyImportedRows` loop) and throws there.
Proved with scratch probes: a candidate with `totalCashDecimal:"2.50 "` or
scale-97 (writable — `isPositiveDecimalString` bounds no scale;
`parseDecimalResult` allows 96 while `parseDecimal` allows 24) still 500s
`createImportReconciliationPreview`, i.e. the task's own acceptance shape for
one of the three columns. BUG-013's own fix wrapped BOTH the compute AND the
compare (`safeCashTotalsWithinTolerance`) — the later round dropped half the
pattern. **How to apply:** for any `safe`/`try`-wrapped derivation, read the
wrapped function's EARLY RETURNS and list which inputs it forwards without
parsing; then grep the consumers of its RESULT for the raw parser. Cheap
proof: `head -131 tests/bug-014.test.ts > tests/.review-scratch.test.ts`
(that prefix is the fixture helpers) and feed the bad value through each
field in turn.

**46b. Guarding a PREVIEW makes the malformed row newly reachable at
COMMIT, where the sibling module's unguarded twin lives.** Same task:
post-fix, a staged dividend row with `undefined` `sharesOwned` gets a
`warning` (never blocks readiness), `markImportReadyWithContext` succeeds,
and then `db/repositories/import-commit.ts`'s `revalidate()` — which calls
the RAW `computeDividendCashTotal` at :526 and :545 over the same data —
throws, and `app/import-commit-actions.ts`'s blanket `catch` renders it as
503 "Import commit is temporarily unavailable" forever. Verified end to end
with the `tests/imp-004a.test.ts` prefix harness. Nothing malformed is
persisted (the insert builder passes `sharesOwned ?? ""` and
`isPositiveDecimalString` rejects it → `mapping_incomplete`), so the finding
is dishonest copy + an uncommittable ready batch, not a data-integrity
break. **How to apply:** whenever a fix converts a hard failure into an
advisory warning, follow the row one step further down the pipeline and ask
which module re-derives the same value without the new guard.

**47. The ACCEPTED remedy for a "two unbatched writes leave an orphan" fix
(recorded because it passed review).** BUG-019 (`ce93f84`, 2026-09-03) folded
`app/portfolio-bundle-service.ts`'s restore scaffold portfolio INSERT +
creation-audit + `import_batches.target_portfolio_id` UPDATE into ONE
`client.batch()`, via a `buildPortfolioCreationStatements` seam in
`db/repositories/owned-portfolios.ts` that `create()` also calls (the
`buildLedgerPostingStatements` precedent). What made it a PASS, and what to
re-check on any later round: (a) the seam is a VERBATIM move — diff the old
`create()` batch array against the builder's return, columns/params/audit
action/condition included, and confirm `create()` now calls it; (b) atomicity
must be proved against the REAL batch implementation, not a wrapper that
throws before executing (see [[review-verification-commands]]'s trigger
recipe) — measured: 0 portfolios, 0 `portfolio.create` audit rows, batch
`target_portfolio_id` NULL after a mid-batch abort, retry then creates exactly
one under the ORIGINAL code; (c) a failure on the NEXT statement after the
batch leaves the portfolio LINKED, so the retry resumes into it (no second
portfolio); (d) the pre-existing 5-attempt code-collision loop now wraps the
whole batch, so a TRANSIENT fault on the link statement commits the portfolio
under `<code>-restored` on the next attempt (reproduced) — accepted and
disclosed in `docs/ARCHITECTURE.md`, cosmetic only because nothing downstream
keys on the code. Two residual notes worth stating, not blocking: the code
never checks the link UPDATE's `changes`, so a batch whose UPDATE matched zero
rows would still commit the portfolio (unreachable — the batch row is written
by the same invocation and only account purge deletes it; and
`createSqliteSqlClient.batch` hardcodes `changes: 0`, so such a check is
untestable locally); and when `user_settings` is missing the INSERT
`... SELECT FROM user_settings` writes zero rows, so the whole safety of the
link UPDATE rests on the composite FK `(target_portfolio_id, user_id) ->
portfolios(id, user_id)` — present in the current schema (verified via
`PRAGMA foreign_key_list(import_batches)`), enforced by both `node:sqlite`
(`PRAGMA foreign_keys = ON` in the suites) and D1. Without that FK the batch
would durably link a nonexistent portfolio and permanently wedge the batch on
the "portfolio ... no longer exists" resume branch.

**48. Making an always-on GATE conditional updates the new task's decision-log
entry and leaves every OTHER normative sentence describing the gate as
unconditional.** PRF-008 (2026-09-03) added
`loadOwnedHoldings(..., priceFreshnessMode: "enforce" | "skip" = "enforce")` so
`/income`, `/income/multi-year` and `/income/assumptions` stop calling
`ensureSharesightPriceFreshness`, and wrote a thorough new
`docs/ARCHITECTURE.md` Decision-log entry — but left four now-overstated
sentences standing: `docs/ARCHITECTURE.md:566` ("`price_observations` is
bounded to the SAME <=10-minute freshness ... **whenever a portfolio is
actively viewed**"), `:567` ("called from `app/owned-holdings.ts`'s single
`loadOwnedHoldings` choke point"), `docs/MARKET_DATA_STRATEGY.md:345` (§17,
"`app/owned-holdings.ts` calls ... before reading `price_observations`" stated
unconditionally) and `docs/CALCULATIONS.md:71` ("THREE call sites reach it ...
however many of the three run within one request/window, at most one actually
triggers a fetch" — two of the three now never trigger it at all).
**How to apply:** pattern 16 says grep the touched SYMBOL in
`docs/ARCHITECTURE.md`; for a gate/always-on invariant also grep the symbol AND
the guarantee's distinctive words (`10-minute`, `freshness gate`, `choke
point`) across `docs/*.md` — the provider-facing doc (`MARKET_DATA_STRATEGY.md`
§17 here) is the one workers habitually miss, and AGENTS.md names it as the
required target for provider behaviour changes.

**48b. "Two of the five new tests do not fail pre-fix" — recount them all.**
Same task. Measured with the whole-commit pre-fix tree: of the five new
`tests/prf-002.test.ts` tests, only ONE (the source-verified caller-placement
pin) fails pre-fix; the byte-identical-output test (omitted vs explicit
`"enforce"`) and the `/income` honesty test are guards that CANNOT fail pre-fix,
because `node --experimental-strip-types` silently ignores an extra positional
argument the old signature never declared. The four new `tests/brk-012c.test.ts`
mechanism tests were labelled correctly (3 fail / 1 guard, confirmed).
**How to apply:** any new test that passes an ADDED optional parameter is
runtime-inert against the pre-fix tree, so it is a guard by construction —
classify it that way before accepting a count. Related: 36d, 43.

**49. A "fail-OPEN degrade is safe here because this set only silences an
advisory warning" cap, applied to a set that has a SECOND consumer.**
PRF-009's BUG-013 fold-in (`6980958`) bounded `app/import-actions.ts`'s two
suppression queries with `LIMIT MAX + 1` and, on overflow, drops the whole set
to EMPTY (`capSuppressionReferenceRows`, `app/import-suppression-cap.ts`).
`existingTradeSourceReferences` really does have one consumer
(`tradeAlreadyBoundForSkip`, `domain/imports/reconciliation.ts:989`). But
`existingDividendSourceReferences` PREDATES BUG-013 — DIV-016C round-1's
BLOCKING B1 fix uses it at `:1232-1242` to split
`freshRows`/`alreadyImportedRows`, "Reconciliation supersedes ONLY via rows the
CURRENT batch actually inserts". Proved with a 25-line probe
(`head -131 tests/bug-014.test.ts` prefix + `candidate({sharesDecimal:"5"})` so
the cash totals actually match — the default fixture's 5x0.50 vs 10x0.5 never
matches, so a naive probe shows NO issues at all and looks like a false alarm):
with the set, `DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE` ("it remains
double-counted ... this commit will not reconcile them"); with it emptied,
`DIVIDEND_RECONCILIATION_PROPOSED` + a populated `proposedReconciliations`
("committing will supersede the manual record") — the exact false promise B1
removed. Commit-time behaviour is safe (`db/repositories/import-commit.ts`'s
`revalidate()` re-derives from its own UNCAPPED query at :415-419), and
`previewVersion` is safe (every reconciliation issue code plus
`proposedReconciliations` is filtered out of `hashedPreview`,
`domain/imports/review.ts:245-260`), so this is dishonest DISCLOSURE, not data
loss. **How to apply:** before accepting any "this set only does X" degrade,
`grep` the set's own name across `domain/` and list EVERY read; a set added for
purpose A and later reused for purpose B will be described by the newest task's
purpose only. Then check the hash-exclusion list to rule out a fail-CLOSED 409
side effect, and check the commit-side twin for an independent re-derivation.

**49b. The two `+<column>` no-index hints a perf diff ADDS are usually the
one thing no test pins.** Same commit's own work item was BUG-016 follow-up
(b) — add an `EXPLAIN QUERY PLAN` test for the sibling hint
(`+source_row.user_id`, `tests/imp-003b.test.ts`) — yet neither of the two
hints the diff itself introduced (`+r.user_id` in `import-commit.ts`'s
`finalize`, `+reverses_transaction_id` in `app/import-actions.ts`) got one;
`tests/bug-011.test.ts`'s widened pin deliberately writes `\+?` so it tolerates
the hint's removal. Verified: deleting either character leaves the whole suite
green while the plan reverts to the user-wide index. **How to apply:** for any
diff whose measured win rests on a unary-plus/`+` hint, grep the tests for the
hint text; the repo's accepted shape is the `capturingClient` + re-`EXPLAIN`
test at `tests/imp-003b.test.ts:900-1040`, including its remove-the-hint
mutation check.

**49. "Every write path that ALREADY invalidates the cache now also clears the
new marker" — the set of paths that already invalidate is NARROWER than the set
of writes that can make the marked fact false.** BUG-012 (2026-09-03) persisted
"this date is unresolvable" in `portfolio_value_history_unresolvable` and
excluded marked dates from `missingDates`. It paired a clear with all four
existing `portfolio_value_history` invalidation shapes — but two live writers
never invalidated value history in the first place and therefore clear nothing:
`db/repositories/sharesight-price-refresh.ts`'s `upsertSharesightPriceObservations`
(called from `app/sharesight-price-refresh-service.ts` AND
`app/sharesight-price-gate-service.ts`, including MKT-015's PRIOR-DAY backfill
write — the owner's primary price feed), and every FX write
(`market-data-refresh.ts` explicitly skips `observation.kind !== "price"`, and
`fx` is its own `RefreshTargetKind`, so an fx-target job issues no invalidation
at all). Reproduced with real writers: mark a date, land the missing price via
`upsertSharesightPriceObservations` (`interval:'delayed'`, which `PRICE_SCOPE`
does not filter, so it DOES resolve the date), re-read → the date is still
absent; delete the mark by hand → `valueDecimal: "1150"`. Same for an FX-only
gap. Before the marker these gaps were self-healing (a never-stored date was
retried on every read); after it they are permanent. **How to apply:** whenever
a diff converts "retried forever" into "cached negative fact", enumerate the
writers of every INPUT the negative fact depends on (price, FX, ledger), not the
writers the existing invalidation list happens to name — the invalidation list
was sized for *stale rows*, whose failure mode is milder. Grep `INSERT INTO
<input table>` and check each writer module for the invalidation helper.

**50. A diff that DOUBLES the statements a shared builder emits breaks the
runtime-enforced, fail-closed batch budget of a module it never edits.** Same
task: `buildValueHistoryInvalidationStatementsForSecurities` went from 1 to 2
DELETEs per (owner, portfolio) row. `db/repositories/market-data-refresh.ts`
caps its chunk batch at `MARKET_DATA_REFRESH_REPOSITORY_LIMITS
.maxStatementsPerChunk = 26` (comment: "5 writes + 1 progress update + up to 20
invalidation deletes = 26") and REJECTS the whole commit
(`{ok:false, reason:"invalid-progress"}`) above it. Measured with the
`tests/mkt-003b.test.ts` prefix + N portfolios holding one security: pre-fix
N=20 completes; post-fix N=13 (1 observation) gives `jobsCompleted:0,
observationsWritten:0`, no price rows, job left `status='running'` with
`last_error_kind` NULL — deterministic on every retry, so that security's price
refresh can never complete. With a full 5-observation chunk the threshold is
N=11. **How to apply:** when a diff changes how many statements a SHARED
statement builder returns, grep its callers for `*_LIMITS` constants and check
whether the cap is runtime-enforced (`market-data-refresh.ts:542`,
`import-commit.ts`'s `isBoundedAtomicUnit`) or documentation-only; then re-run
the caller at the cap's own documented ceiling. `import-commit.ts`'s finalize
survived the same doubling only because HIST-002 left 85 vs a new 3A+2=77 worst
case — its constant's comment still says 2A+2=52.

**46c. The FIX for pattern 46 self-validates on the PREVIEW side only — the
exported `safeX` the COMMIT side uses still forwards the input verbatim, so
the commit-side comment's "excluded / nothing is written" claim is false and
the malformed value is PERSISTED.** BUG-014 round 2 (`b60776b`, 2026-09-03)
added the `safeCashTotalsWithinTolerance(v, v)` self-compare inside
`safeComputeDividendCashTotalDiagnosed` (preview only) and swapped
`db/repositories/import-commit.ts`'s two `revalidate()` sites to the plain
exported `safeComputeDividendCashTotal`. That wrapper still hits
`computeDividendCashTotal`'s totals-mode early return
(`dividend-reconciliation.ts:115`), so a malformed `totalCashDecimal` comes
back NON-null and the row IS pushed into `dividendIncomingRows` — the
comment at `import-commit.ts:545-549` says the opposite. The crash is
actually stopped by the round's "defense-in-depth" `cashTotalsWithinToleranceSafe`
in the match predicate, i.e. the half the commit message calls secondary is
the only thing carrying that half of the finding. Measured through
stage→ready→commit: `"2.50 "` → `mapping_incomplete`, nothing written; but
`"0." + "1".repeat(97)` → preview warns "amount could not be read",
`commit ok:true, committedRows:1`, and the 97-digit string lands in
`dividend_manual_records.total_cash_decimal` — `isPositiveDecimalString` /
`DECIMAL_PATTERN` (`db/repositories/dividends.ts:68-82`) bound NO scale.
Against the parent commit the same row THREW at commit (nothing written), so
the round widens the hole while its doc/comment/test-header all assert "no
`dividend_manual_records` row is ever written for it". Downstream,
`parseDecimal` (24-scale) re-parses that stored total in
`domain/dividends/history-row-derivation.ts:131` and
`domain/dividends/history.ts:511`, so the crash BUG-014 removes from
`/import` reappears on `/income`; `domain/sharesight/parse.ts:69-94`'s
`decimalString` bounds no scale either, so the input path is open, and the
preview's totals bound (96, `parseDecimalResult`) is WIDER than the read
path's (24) — a 25-to-96-digit total passes preview with no warning at all.
**How to apply:** after a pattern-46 fix, check WHICH wrapper each layer
calls; only the diagnosed/self-validating one sees a pass-through input.
Then run the value one step further — to the INSERT builder — and confirm
the "nothing is persisted" sentence by actually reading the table.

**51. A cherry-pick "resolved by keeping both notes" leaves the STALE
paragraph in the normative doc, complete with the exact sentence the round
was dispatched to correct.** BUG-014 round 2's `docs/CSV_IMPORT_SPEC.md`
landed the corrected BUG-014 paragraph at :154 while the round-1 original
stayed at :153 (`git show 6980958:docs/CSV_IMPORT_SPEC.md | grep -c` = 1,
`b60776b` = 2), with NO blank line between them — markdown renders one
run-on paragraph containing ~2.6k characters twice, and the correction note
at :156 ("the paragraph above's phrase ... OVER-CLAIMED coverage") now
points at the paragraph that no longer contains the phrase. **How to apply:**
whenever a task packet mentions a merge/cherry-pick conflict in a doc, run
`for c in <base> <parent> <commit> HEAD; do git show $c:<doc> | grep -c
"<distinctive sentence>"; done` and compare the counts, and print the
paragraph line lengths (`awk '{printf "%d[%d]\n", NR, length($0)}'`) to spot
two adjacent near-identical blocks.

**52. Removing a cap/guard from the production query leaves `tests/imp-004a.
test.ts`'s `pagePreview` MIRROR still applying it — with a comment asserting
parity.** PRF-009's correction round (2026-09-03, `619f981`) removed the
fail-open `LIMIT MAX + 1` + `capSuppressionReferenceRows` from
`app/import-actions.ts`'s dividend `source_reference` query (a DIV-016C
COMPARISON set: `domain/imports/reconciliation.ts:1298/1302` splits
`freshRows`/`alreadyImportedRows` on it, unlike the trade set which is only
read at :1026 to silence a warning). The commit touched `app/`, `docs/`,
`tests/bug-011|bug-013|prf-009` — but NOT `tests/imp-004a.test.ts`, whose
mirror still runs the capped dividend query and still routes it through
`capSuppressionReferenceRows`, under the comment "now bounded with `LIMIT MAX
+ 1`, same as `loadReview`". So the DB-level DIV-016C suite exercises exactly
the shape the round deleted. **How to apply:** any diff that CHANGES (not
just adds) SQL or a cap in `app/import-actions.ts`'s `loadReview` must be
grepped against `tests/imp-004a.test.ts`'s `pagePreview` mirror in the same
review; a removal is as much a divergence as an addition, and the mirror's
own comments are the second place the corrected claim survives (see 36e).

**53. A correction round's own ARCHITECTURE.md evidence paragraph names the
WRONG test files.** Same commit, `docs/ARCHITECTURE.md:788` credits
`tests/prf-009.test.ts` with the "dividend query has no LIMIT" pin and the
`DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE` size-independence test (both
actually in `tests/bug-013.test.ts:954/:423`; prf-009.test.ts holds only the
EXPLAIN guard), and :790 credits `tests/imp-003b.test.ts`'s EXPLAIN test with
guarding finalize's `+r.user_id` (imp-003b's guard is round 1's, for
`import-reversal.ts`'s `+source_row.user_id`) while claiming
`tests/imp-004a.test.ts` has additions in a commit that does not touch it.
**How to apply:** for every `tests/<file>` cited in a doc/commit evidence
paragraph, check it against `git show --stat <commit>` and grep the named
assertion inside it; a round that adds a NEW test file is the likeliest place
for a stale file name to survive from the draft.

**46d. The ACCEPTED remedy for 46c (recorded because it passed review), and
its two residuals.** BUG-014 round 3 (`4c583ce`, 2026-09-03) closed the
"preview-guarded value gets PERSISTED" hole by putting ONE bound at the write
boundary: `isWithinReadPathDecimalBounds` in `db/repositories/dividends.ts`
(referencing `DECIMAL_LIMITS.inputScale/inputDigits`, never re-hard-coding
24/64) applied to all five amount columns
`buildDividendManualRecordImportInsertStatements` writes, plus the preview's
TOTALS-mode check switched from round 2's `parseDecimalResult` (96) self-
compare to `parseDecimal` itself, while PER-SHARE mode keeps the wider bound
for its legitimately 48-scale COMPUTED product. Verified: a 255-value ×
5-column fuzz shows builder acceptance ≡ `parseDecimal` acceptance exactly
(no tighter, no looser); preview warns at 30-scale totals and 25-scale
per-share operands, stays silent at a 24×24 product and a 24-scale total; the
FX column's separate `MAX_FX_RATE_DECIMAL_SCALE` bound is untouched; all five
new drills fail against `b60776b` and the no-over-tightening test passes in
both trees. **Residuals to re-check on any later round:** (a) only the IMPORT
builder is bounded — `validateManualRecordAmounts`/`resolveSupersedeAmounts`
in the SAME file (owner-typed DIV-016A entry via
`saveDividendEntryWithContext`, and `portfolio-bundle-service.ts`'s
non-`wasImported` restore branch) still bound form only, and a 30-scale total
typed there persists and then throws `Invalid decimal input: supported
boundary exceeded.` out of `loadOwnedDividendHistory` (reproduced post-fix);
(b) the TOTAL-DIGITS half of the new bound has no test — deleting
`value.replace("-","").replace(".","").length <= DECIMAL_LIMITS.inputDigits`
leaves bug-014/imp-004a/brk-005/imp-006/exp-004 all green, because every
drill uses a fractional-scale violation. Also note the two franking columns
are bounded at commit but NOT warned at preview, so an over-scale franking
value yields a bare `mapping_incomplete` ("Resolve every required mapping")
with no row-level pointer.

**54. The FIX for pattern 49 (a write path that invalidated nothing) re-opens
the same hole through the shared builder's `LIMIT maxPortfolios` — and the
budget is spent CROSS-OWNER on rows that provably cannot matter.** BUG-012
correction round (`d034e79`, 2026-09-03) appended
`buildValueHistoryInvalidationStatementsForSecurities(client, targets, 20)`
into `upsertSharesightPriceObservations`'s per-chunk batch. That helper's
`SELECT DISTINCT user_id, portfolio_id, security_id FROM portfolio_securities
WHERE security_id IN (…) LIMIT ?` truncates with no ORDER BY, so beyond 20
`(owner, portfolio, security)` rows the excess is silently NOT invalidated —
and here the truncation is reachable, deterministic and PERMANENT, unlike the
`market-data-refresh.ts` precedent it cites: the Sharesight path writes each
`(security, marketDate)` once (`marketDate` comes from each instrument's own
`currentPriceUpdatedAt`, so dates differ per security), and the same 20 rows
win on every hourly re-run. Measured in `$TMPDIR/post`: 25 securities in ONE
portfolio → `maxBatchStatements: 90` (the doc comment's number is right) but 5
marks + 5 stale rows survive, identically on runs 1/2/3. Worse, the Sharesight
INSERT is `access_scope='user', scope_user_id=<writer>` while
`app/historical-portfolio-value.ts`'s `PRICE_SCOPE` admits a user-scoped row
only for its own owner — so every cross-owner invalidation row this builder
returns is a provable no-op that still consumes the cap: 25 OTHER-owner
portfolios holding the security starve the WRITING owner's single portfolio
out of the set entirely (mark not cleared, chart date still absent after
Sharesight supplied the price — exactly the F1 defect, post-fix). **How to
apply:** when a round fixes "path X never invalidated" by calling a bounded
shared builder, (1) compute the row count the builder can return at the
caller's OWN chunk size (25 securities × N portfolios here vs a 20-row cap),
(2) check whether the cited "a later write tries again" rationale actually
holds for that caller's write cadence, and (3) check the write's SCOPE — a
user-scoped write must not spend a cross-owner budget. Also grep the
enumerated invalidation-writer LISTS in `docs/CALCULATIONS.md` (Invalidation
bullet 3, "three write paths") and `docs/DATA_MODEL.md`
(`portfolio_value_history_unresolvable` → Invalidation bullets): a round that
adds a new invalidating writer must add it there, since those lists being
incomplete is what produced the original finding.

**54b. The FX half of the same round: `fxOnlyGap` only suppresses the mark
when EVERY held security's failure is FX.** A date that is FX-gapped for the
foreign holding AND price-gapped for another holding still persists
`no_priceable_security`; the FX rate's later arrival makes the date derivable
as `partial` but nothing clears the mark, so it stays permanently absent.
Reproduced with real writers (2 held securities, control = delete the mark by
hand → `valueDecimal "1470.588235294117647", completeness "partial"`). The
diff's docs say "ONLY cause", so this is an honest residual, not a false
claim — record it as follow-up.

**55. Narrowing a UNIQUE INDEX makes a NEW data shape reachable — check every
REPLAY path that has to reconstruct it, not just the writers.** BUG-018
(2026-09-03) turned `transactions_portfolio_source_reference_unique` into a
partial index (`WHERE status <> 'reversed'`) so a reverse-then-re-import lands
as a new posted row reusing the same `source_reference`. The import commit path
builds statements directly (`buildLedgerPostingStatements`) and is fine, but
`ledger.post`/`supersede` go through `persist`, whose `getBySourceReference`
(`db/repositories/ledger.ts:505`) is the SAME "does this identity occupy the
key" query and was NOT given the predicate — and `app/portfolio-bundle-service.ts`
replays a bundle with `ledger.post(..., sourceReference: tx.sourceReference)`.
Reproduced with real writers: export succeeds (3 rows), restore returns
`{ok:false, status:409, "A transaction could not be replayed (conflict)."}`,
while the reversal-only shape restores fine — so the very workflow the task
exists to enable makes the owner's portfolio bundle / system backup
unrestorable. Adding the predicate to `getBySourceReference` is NOT enough:
`domain/exports/chain-order.ts`'s Kahn ordering emits all roots first, so the
replay order is [reversed original, re-imported twin, reversal mirror] — the
twin is posted while the original is still `'posted'`, so the partial index
still rejects it. A correct fix has to keep a reversal adjacent to its target.
**How to apply:** for any index/uniqueness narrowing, (a) grep every OTHER
query asking the same occupancy question (here `getBySourceReference`, used by
`persist` and by the post-`atomic()` error classifier at `ledger.ts:1006`), and
(b) round-trip the new shape through `exportPortfolioBundle` +
`commitPortfolioBundleImport` (both importable by `node --test`; ~35 lines on
top of the task suite's own fixture prefix) before accepting a
"everywhere else ... stays in lockstep" completeness sentence — that sentence
appeared verbatim in `docs/ARCHITECTURE.md` and `docs/DATA_MODEL.md` here and
was false. Related: patterns 36b/48 (completeness claims) and 25.

**55. The ACCEPTED shape for a "narrow the shared whole-portfolio loader"
perf fix (PRF-013, `da702fe`, 2026-09-03 — recorded because it passed).**
`loadOwnedSecurityDividendDetail` loaded the whole portfolio to `.find()` one
row, then re-read five dividend tables narrowed by hand. The accepted remedy:
an OPTIONAL TRAILING `portfolioSecurityIdFilter?: string[]` on
`loadOwnedDividendHistory` (every existing caller unchanged by omission, with
a source-pin test asserting the three callers still spell
`(client, userId, portfolioId, now)`), a single-id fast path that also
narrows the four repository `.list(userId, portfolioId, oneId)` reads plus
`getSecurityAssumptions`, and a new `rawDetail` field carrying the raw
per-security records from the SAME wave (`null` for whole-portfolio callers
so they pay no grouping cost) so the second wave is deleted outright. Plus an
`{ identityConfirmed?: boolean }` option letting the page skip the loader's
own ownership SELECT because it already ran `loadOwnedHoldingIdentity`.
Checks that mattered and all held (re-check these if this path is touched
again): (a) every per-security derivation input is keyed by
`portfolioSecurityId`/`securityId` — only `dividend_receipts`,
`dividend_fy_overrides` and `dividend_portfolio_assumptions` are
portfolio-wide, and all three stayed unnarrowed; (b) the three narrowed
repository `list()` filters are `AND portfolio_security_id = ?`, identical to
what the deleted second wave passed, so `rawDetail` carries the same rows;
(c) `MAX_EVENTS_PER_PORTFOLIO` (20,000) equals the deleted
`MAX_EVENTS_PER_SECURITY`, so the cap and its `too_many_dividend_events`
message are unchanged; (d) a WRONG `identityConfirmed: true` cannot leak —
the portfolio row is still gated on `user_id` (`not_owned`) and the identity
query on `(user_id, portfolio_id)`, so a cross-owner id yields
`not_dividend_eligible` with no data; (e) EXPLAIN: adding `AND ps.id IN (?)`
moves the seek to `portfolio_securities_id_user_portfolio_unique
(id=? AND user_id=? AND portfolio_id=?)` — still owner-scoped, and it drops
the temp B-tree sort (no pattern-29 hijack). **Disclosed residual:** with
`identityConfirmed: true` an `status='unresolved'` holding (NULL
`security_id`) now raises `not_dividend_eligible` instead of `not_found`, so
the page renders "dividend history could not be loaded" rather than a 404 —
unreachable by navigation (the holdings list is `status='held'` only) and the
sibling holding tabs already render for such rows. **How to apply:** this is
the template to compare a future "narrow the shared loader" diff against; the
load-bearing evidence is the cross-commit parity harness in
[[review-verification-commands]], not the diff's own before/after test.

**54c. "Group N per-date invalidations into ONE ranged `[MIN,MAX]` DELETE per
portfolio" makes the deleted span DATA-CONTROLLED by an external provider's
timestamp.** BUG-012 round 3 (`8f7bdc1`, 2026-09-03) replaced the Sharesight
writer's per-(portfolio, security) single-day DELETEs with one
`value_date BETWEEN MIN(fromDate) AND MAX(toDate)` pair per portfolio
(`buildOwnerValueHistoryInvalidationStatementGroups`,
`db/repositories/portfolio-value-history.ts:833-845`). The dates come straight
from each instrument's own `current_price_updated_at`
(`domain/sharesight/price-accretion.ts:196`, no staleness bound), so ONE
infrequently-priced holding (suspended, delisted, unlisted/managed fund) puts
MIN months behind MAX. Measured in `$TMPDIR` pre/post trees, 2 securities and
70 stored weekdays: pre-fix 2 rows + 2 marks deleted, post-fix **70 rows + 70
marks** — and the hourly refresh recomputes the identical span every tick, so
anything the 10/read + 20/tick backfill re-derives is wiped again within the
hour (BUG-010's own outage shape, plus the marks BUG-012 exists to persist).
The read path is `priceToleranceDays: 0` for the series
(`app/historical-portfolio-value.ts:296`), so a new price on date D can only
change date D — the range is a strict over-delete, not a correctness need.
**How to apply:** whenever a diff collapses several point invalidations into a
range for statement-budget reasons, ask what bounds the two endpoints; if
either comes from provider data, measure the span with a fixture where one
target date is old, and check the caller's re-run cadence. The cheap remedy
that keeps the same 2-statements-per-portfolio budget is `value_date IN (…)`
over that portfolio's own distinct target dates (≤25 dates + 2 ids = 27 bound
params, inside D1's 100 cap). Verified-good in the same diff (do not re-litigate):
the `LIMIT maxPortfolios * securityIds.length + 1` probe genuinely cannot
truncate below the throw (each portfolio contributes ≤ S rows, so any
truncated result still spans > maxPortfolios distinct portfolios), 201
portfolios throws with ZERO price rows written for that chunk, 60 portfolios
gives batch sizes 100/70 with full coverage, and the FX "any not every"
(`fxMissingComponent`) rewrite keeps hist-002 parity because it is still gated
on `valueDecimal === null`.

**55b. Changing a shared ORDERING function breaks a COUNT-based resume that
spans two deployed builds — and invalidates the "can never skip real,
unwritten rows" claim the resume rests on.** BUG-018 round 2 (`9427f09`,
2026-09-03) made `domain/exports/chain-order.ts` depth-first. The chunked
CORE restore resumes with
`orderedTransactions.slice(committedTransactionCount)`
(`app/components/system-backup-panel.tsx:546`), where the count is a live
server `COUNT(*) ... idempotency_key LIKE 'bundle:<fp>:%'`. That is only
skip-proof while BOTH requests compute the SAME order.
`docs/BACKUP_FORMAT.md`'s "Resume evidence" section states flatly "A stale or
wrong client-side guess can therefore never skip real, unwritten rows — at
worst it would resend already-written rows"; the diff added a new "Chain
ordering" section a few hundred lines above it and never touched that claim.
Reproduced with real writers (root A with reversal mirror A', unrelated later
root B): old order `[A, B, A']`, new `[A, A', B]`; send `oldOrder.slice(0,2)`,
resume with `newOrder.slice(2)` → `ok: true` and **2 of 3** transactions
restored, A' dropped, so the owner's REVERSED trade comes back as a live
`posted` fact with no compensating mirror and no error. Finalize catches the
same shape for DIVIDENDS (`dividendLinkage` re-looks-up every record and fails
closed with "A dividend record was not found during finalize") but there is no
equivalent transaction-count check. **How to apply:** whenever a diff changes
the output ORDER of a function whose result is sliced by a persisted/live
COUNT, treat the order as a state contract across deploys: grep the resume
call site for `.slice(<count>)`, run the old-order-then-new-order resume, and
require both a doc correction of any never-skip sentence and an operational
note that an in-flight restore must be restarted rather than resumed.
Verified-good in the same diff (do not re-litigate): 2,000-case pre/post parity
on dependency-free bundles (byte-identical), 3,000-case random-forest
topological validity + immediacy + determinism, identical cycle/dangling/
duplicate-ref handling, depth-5,000 chain without recursion, full-fidelity
transaction+cash round trip through both restore paths with the part boundary
at BOTH positions, double-reversal + third import, `getBySourceReference`'s
EXPLAIN improving to a fully-specified seek on the partial unique index,
`existingResult` parity for a reversed row sharing reference AND idempotency
key (0 extra transaction/audit rows), classifier `conflict` → `atomic_failure`,
supersede unchanged, and all 5 new tests genuinely failing pre-fix.

**48. An EXTRACTION commit moves a load-bearing SQL predicate/planner hint to
a new file and leaves every prior `docs/ARCHITECTURE.md` sentence attributing
it (and the test pin that guards it) to the OLD file.** PRF-015 (2026-09-03,
`63e15fe`) moved `loadReview`'s six queries into `app/import-review-queries.ts`
and re-pointed the `tests/bug-011.test.ts`/`tests/bug-013.test.ts` source pins
there, but §9.7 still reads "`tests/bug-011.test.ts`'s widened F-a pin guards
`app/import-actions.ts`'s `+reverses_transaction_id IS NULL`" — and
`grep -c reverses_transaction_id app/import-actions.ts` is now **0**. Same
paragraph block also still says "`app/import-actions.ts`'s two suppression-set
queries" and quotes the BUG-011 SQL as living there. §9.7 is itself a dated
"corrected after review" record about WHICH FILE each guard covers, so the
round re-opens the defect an earlier round was failed for. **How to apply:**
for any move/extraction, grep `docs/` for BOTH the old file path AND the moved
predicate's distinctive tokens, and require the repo's dated in-place
"(corrected YYYY-MM-DD after review: …)" note on every hit — the new section's
own entry does not repair older ones. Related: patterns 16 and 36e.

**48b. The mirror the task names gets pinned; the OTHER hand-typed copy of the
same query in a different suite does not.** PRF-015 removed all six inline
copies from `tests/imp-004a.test.ts`'s `pagePreview`/`currentPreviewVersion`,
but `tests/bug-018.test.ts:264-305` carries two more hand-typed reproductions
of the same production queries (`suppressionSetContains`,
`economicIdentityMatches`), each with a comment saying it exists "because that
file transitively imports `next/headers`", and both already differ from
production (no `LIMIT ?`, no `+` no-index hint). **How to apply:** once a
shared query module exists, grep the whole `tests/` tree for the query's
distinctive `FROM <table>` + `WHERE` text, not just the mirror the task names;
report the leftovers as follow-up (they are usually `DatabaseSync.prepare`
call sites needing `q.sql` / `...q.params`).

**48c. Accepted extraction template (do not re-litigate).** PRF-015's shape is
the right answer to the runner's `next/headers` limit: pure `…Query(userId,
limit): SqlStatement` builders in a dependency-free `app/*.ts`, imported by
BOTH `loadReview` and the test mirror; SQL byte-identical to the parent commit
(verify by regexing the parent's `client.all<Record<string, unknown>>(`…`, […])`
blocks out of `git show <commit>^:<path>` and comparing to the rendered
builders — beware alignment: one loadReview query was deliberately NOT
extracted); pins split into a module-side SQL/`params: [userId, limit]` regex
plus an import-actions-side `…Query(\s*userId,\s*MAX… \+ 1,\s*\)` call-site
regex. Mutation-proved: `+`→``, added `LIMIT`, dropped `LIMIT ?`, dropped
`AND status <> 'reversed'`, and a call-site `MAX + 1`→`MAX` each fail exactly
one pin, so no pin can pass on the module's (still SQL-quoting) comments.

**54d. The ACCEPTED remedy for 54c (recorded because it PASSED review), and
its one residual.** BUG-012 round 4 (`2779d48`, 2026-09-03) replaced the
Sharesight writer's per-portfolio `[MIN,MAX]` span with `value_date IN (?,…)`
over that portfolio's own distinct target dates, and changed the owner-scoped
builder's input type to a single-date `OwnerValueHistoryInvalidationTarget
{securityId, marketDate}` so a range can no longer be EXPRESSED on that path
(the cross-owner builder keeps `fromDate/toDate` and is untouched). Verified
independently and all held: a 30-trial randomized fuzz (5 portfolios x 6
securities, mixed holdings, duplicate dates per security, unheld securities)
shows the deleted `(portfolio, value_date)` pairs equal EXACTLY the union of
per-security targets on BOTH tables; deterministic across 3 identical re-runs
(68/68 survivors each time); correct across a 2-chunk (30-candidate) write;
a write for a date with no stored row/mark touches nothing; 201 portfolios
still throws `owner_value_history_invalidation_overflow` with ZERO price rows
written; measured `batchSizes = [90, 20]` and max 27 bound parameters on the
worst case (25 securities x 30 portfolios). EXPLAIN: the `IN`-list DELETE
seeks `portfolio_value_history_user_portfolio_idx (user_id=? AND
portfolio_id=? AND value_date=?)` at N>1 and the `(portfolio_id, value_date)`
unique index at N=1 — a single-row seek either way, no pattern-29 hijack.
Pre-fix (`8f7bdc1`): both date-set probes plus the `[90,20]` budget pin fail.
**Residual worth raising as follow-up, not blocking:** the new
`MAX_OWNER_INVALIDATION_BOUND_PARAMETERS` guard and its
`owner_value_history_invalidation_parameter_overflow` throw have NO test at
all, and nothing pins the 27-parameter worst case — so raising
`MAX_SECURITIES_PER_CHUNK` past 98 would make every chunk throw (fail-closed
but a total refresh outage) with a green suite. Also note the ARCHITECTURE
§9.8 overflow sentence says the failed watermark records "the error kind":
`app/sharesight-price-refresh-service.ts`'s catch records the generic
`errorKind: "database"`, and the cron RUN still returns `ok: true` with
`usersFailed` incremented — only that owner's pass fails.

**56. A shared "resolved context" object whose identity read INNER JOINs
`securities` is NOT the superset its comment claims — `status='unresolved'`
rows (`security_id IS NULL`) are silently dropped, and that changes which
loader CAP fires.** PRF-012 (`966b1df`, 2026-09-03) added
`resolveOwnedPortfolioContext` (`app/owned-portfolio-context.ts`) returning
`identities` documented as "ALL `portfolio_securities` rows for this
portfolio, any `status`" and (in `docs/ARCHITECTURE.md` §9.11) "matching each
function's own pre-existing self-load predicate exactly". Two consumers
(`owned-holdings.ts`, `owned-dividend-history.ts`) do join `securities`, but
`historical-portfolio-value.ts`'s `loadFacts` reads `portfolio_securities`
with NO join and NO status filter, so the context is strictly narrower there.
Measured in pre/post `$TMPDIR` trees: 18 held + 490 unresolved rows → the
self-load throws `too_many_securities` (508 > `MAX_SECURITIES` 500) while the
context path returns a value, and the whole `/income` projection flips each FY
`valueStatus` `"unavailable"` → `"available"` with a real
`portfolioValueDecimal` (the throw is swallowed by the `yearsBack > 0`
try/catch in `owned-income-projection.ts`). The same join makes the context's
own 2,000-row sanity ceiling count only RESOLVED rows, and 18 held + 2,001
`hidden` rows makes `/income/assumptions` throw `too_many_securities` where the
pre-fix page rendered — falsifying the module header's "this context never
introduces a NEW failure mode; it can only ever fail in a scenario a caller of
that function already fails in today" (that page never calls
`loadHistoricalPortfolioValueAtDates` at all). **How to apply:** whenever a
diff introduces a shared pre-resolved fact object claiming to reproduce N
loaders' own reads, diff the CONTEXT's SQL against each consumer's original SQL
term by term — JOINs included, not just the WHERE clause — and re-run each
loader's own cap at a row count only the widest consumer could reach.
Verified-good in the same diff (do not re-litigate): ownership (all three
loaders `assertOwnedPortfolioContext` at entry; `loadFacts`/`resolveRange` are
reachable with a context only through that asserting entry point; the series
path passes none; every context query is `user_id`-scoped), cross-commit
byte-identical output for `loadOwnedHoldings`/`loadOwnedDividendHistory`/
`loadHistoricalPortfolioValueAtDates`/`loadOwnedIncomeProjection`/
`loadOwnedDividendAssumptions` on a held+hidden+watch+unresolved+foreign-currency
fixture, the removed `resolvedBaseCurrencyCode` fallback (portfolio base USD vs
home AUD with the holdings pipeline down → identical), the >500-HELD cap
(`too_many_holdings` in BOTH paths, enforced via the derived `heldCount`),
census 33/34/32 → 26/27/25 with every other page unchanged, depth 11/11/8 →
9/9/7, and EXPLAIN plans staying owner-scoped seeks.

**46e. The ACCEPTED remedy for 46d's two residuals (recorded because it
passed review — BUG-022, `1398688`, 2026-09-03).** The fix that closed
"only the IMPORT builder is bounded": one private
`allAmountsWithinReadPathBounds({...five columns})` in
`db/repositories/dividends.ts` applied at the END of every return path of
`validateManualRecordAmounts` (create) and `resolveSupersedeAmounts`
(supersede), plus a factored-out `hasDecimalDigitCountWithinLimit` reused
for `fx_rate_to_portfolio_decimal` (which had only a SCALE bound), plus a
field-specific 400 pre-check in `app/dividend-assumptions-actions.ts`.
What made it a PASS, and what to re-check on any later round: (a) the
writer table is exactly THREE `INSERT INTO dividend_manual_records` sites
(`dividends.ts:1329` import builder, `:3096` create, `:3324` supersede) —
every other statement in `app/`, `db/` touches only
`superseded_by_record_id` (`portfolio-bundle-service.ts` x4,
`import-commit.ts:1444`, `import-reversal.ts:600`); there is no Drizzle
insert helper path and `db/repositories/system-backup.ts` never writes the
table (the restore goes through `portfolio-bundle-service.ts`'s
`:744`/`:1932` builder branch and `:774`/`:1980` `create()` branch);
(b) parity fuzz over 1,260 values (intDigits 1..70 x scale
{0,1,23,24,25,40,63,64,65}) showed `isWithinReadPathDecimalBounds` ≡
`parseDecimal` acceptance exactly, and the form validators
(`isNonNegativeDecimalString` rejects EVERY leading `-`) make the writer's
accepted set a strict subset, so `-0` cannot slip through; (c) BOTH halves
of the bound are now pinned — deleting the digit clause fails 3 of 13
tests, deleting the scale clause fails 5, deleting the FX digit clause
fails 1; (d) the new preview warning
`DIVIDEND_RECONCILIATION_ROW_FRANKING_AMOUNT_UNAVAILABLE` reuses
`safeComputeDividendCashTotalDiagnosed` with the FRANKING fields fed into
its `totalCashDecimal`/`dividendPerShareDecimal` slots — its branch
condition (`totalFrankingDecimal !== null`) differs from the commit's mode
selector (`totalCashDecimal !== null`), which WOULD be a false positive for
a row carrying both, but that shape is unreachable: `strict-versioned-
parser.ts:945` always sets `totalFrankingDecimal: null` and
`domain/sharesight-sync/transform.ts:174/187` always nulls
`sharesOwned`/`frankingPerShare` for payouts. E2E through
stage→ready→commit: 25-scale `frankingPerShare` → warning only, ready
true, `commit {ok:false, reason:"mapping_incomplete"}`, 0 rows written;
24-scale → no warning, committed, stored verbatim. **Residuals to
re-check:** the owner-facing copy hard-codes "24 decimal places and 64
digits" instead of interpolating `DECIMAL_LIMITS`; `docs/BACKUP_FORMAT.md`
:222-225 still says dividend records are replayed via the import builder
"for **every** row" (contradicted by its own design decision 4 and by the
code); and a bundle carrying a legacy over-scale owner-typed record now
fails the WHOLE restore (verified: `{ok:false, status:409, "A dividend
record could not be replayed (invalid amounts)."}` + batch `failed`) with
no doc sentence disclosing it.

**48d. The ACCEPTED correction round for 48/48b (recorded because it PASSED
review).** PRF-015 round 2 (`c03a5a4`, 2026-09-03): each stale §9.7 sentence
keeps its original text and gains the repo's dated in-place marker
"(corrected 2026-09-03 after review: the query text and the `+` hint now live
in `app/import-review-queries.ts` (PRF-015); the pin reads that module, while
the call-site wiring pin still reads `app/import-actions.ts`)" — verified true
against `tests/bug-011.test.ts:598-608` and `tests/bug-013.test.ts:942-989`.
The two `tests/bug-018.test.ts` leftovers now call
`existingTradeSourceReferenceRowsQuery`/`existingTradeRowsQuery` and run
`prepare(q.sql).all(...q.params)`, so drift is impossible; the restored BUG-011
F2 ruling (portfolio-scoping is WRONG, `portfolioFor` resolves three ways)
lives on `existingTradeRowsQuery`'s doc comment citing TASKS.md. Residual, not
worth a fail: the marker on the SUPPRESSION-cap paragraph mentions "the `+`
hint", which belongs to the comparison query, not to those two queries — the
marker is shared boilerplate and still true of the module it names.
**How to apply:** accept a verbatim shared marker across sibling paragraphs as
long as each clause it asserts is checkable in the named file; verify the pin
claims by grepping the test files rather than trusting the marker.

**57. A read-time "null the corrupt value" isolation pre-pass feeds a
downstream ABSENT-MEANS-ZERO inference, so the fix converts a crash into a
silently fabricated $0.** BUG-021 (`ed86b8a`, 2026-09-03) added
`sanitizeManualRecordAmounts` at the top of
`deriveDividendHistoryForSecurity`, nulling any of the five
`dividend_manual_records` amount columns `parseDecimal` rejects. But the
imported-tier pipeline immediately after it is
`.map(applyFrankingCurrencyOverride).map(r => deriveAbsentImportedFranking(r,
resolveImportedRecordCurrency(r, ...)))`, and DIV-007's
`deriveAbsentImportedFranking` reads its `original` argument — which is now
the SANITIZED record, not the raw row — so a nulled-because-unreadable
`totalFrankingDecimal` reads as "Sharesight sent nothing" and is rewritten to
`"0"` with `frankingDerivedZero: true` ("$0.00 (none reported)",
`app/dividend-history-prefill.ts:138`). Measured post-fix on a totals-mode
imported record with a 97-fractional-digit franking total: `franking "0"`,
`gross = cash`, `receivedFrankingKnownDecimal "0"`,
`receivedFrankingUnknownCount 0`, `amountUnreadable false` — no disclosure
anywhere; the same fixture THROWS pre-fix. Same nulling also suppresses
BRK-010's unverified-nonzero-foreign guard, so a foreign record's cash is now
converted and shown where the guard would have nulled it. **How to apply:**
whenever a diff nulls a bad value to "the module's existing unknown
representation", grep every later pass for a rule keyed on that same field
being null/absent (`derive*Absent*`, `?? "0"`, `x === null ? ZERO`), and run
the corrupt value through the WHOLE pipeline, not just the first consumer —
the sanitizer must carry a "was unreadable" marker the absence-inference
checks, or run on a copy the inference cannot see. Also check which tier the
diff's own tests use: BUG-021's franking test used an OWNER-typed per-share
record, the only tier `deriveAbsentImportedFranking` never touches (pattern 6).

**58. A fix that closes an ordering/resume hazard on ONE of two SYMMETRIC
phases, then retires the operational rule for BOTH.** OPS-005 (2026-09-04)
replaced the chunked CORE restore's transactions resume
(`orderedTransactions.slice(committedTransactionCount)`) with a per-ref
existence probe — correct, owner-scoped, bounded (measured: 200 refs -> 4
statements, 52 bound params, `SEARCH transactions USING COVERING INDEX
transactions_owner_portfolio_idempotency_unique`, 0 statements at 0 refs,
once per scaffold call). But `app/components/system-backup-panel.tsx:599`
still resumes DIVIDENDS with `chainOrder(...).slice(committedDividendCount)`,
and `docs/BACKUP_FORMAT.md` then declared "resume no longer depends on any
chain order agreeing across two requests at all" and "the operational rule
above ... no longer applies to any FUTURE chain-order change"
(`docs/ARCHITECTURE.md`: "correct across ANY chain-order change, past or
future"). Reproduced end to end with real writers (3 dividend records:
root t0, unrelated root t1, supersession t2 — old BFS `[root, extra, sup]`
vs new DFS `[root, sup, extra]`): part 1 under the old order, resume under
the new one skips the supersession, finalize returns 409 "A dividend record
was not found" and the batch ends `failed`, and every retry recomputes the
same slice — a stuck restore, i.e. exactly the "start over, don't resume"
rule the doc says is retired. **How to apply:** when a diff fixes a hazard
on one phase of a two-phase (transactions/dividends, rows/links) pipeline,
grep the client for the sibling phase's copy of the same construct BEFORE
accepting any doc sentence that retires the rule globally; the honest
wording names the phase. Note the difference that makes the code scope
defensible: the dividend phase fails CLOSED at finalize (its linkage
re-lookup), the transactions phase silently dropped rows — say that, don't
claim symmetry. Corollary: OPS-005's ARCHITECTURE entry also re-introduced
"confirmed via `git stash` ... in this worktree" as its pre-fix method,
which the SAME file already corrected once (PRF-008's dated correction,
`docs/ARCHITECTURE.md:1026`: the shared checkout must never be stashed) and
which contradicts its own commit message ("via a git archive scratch tree").
Grep `git stash` in `docs/` on any diff that claims a pre-fix measurement.

**59. Finalize-time "verify every ref exists" checks that verify the
CLIENT'S list.** OPS-005's `commitPortfolioBundleFinalize` probes
`input.transactionRefs`, a wire field. Proved: committing 1 of 3
transactions and finalizing with `transactionRefs: [thatOneRef]` returns
`ok`, flips `import_batches` to `committed` and writes
`transaction_rows = 3` with 2 rows never posted. Not a regression (the
pre-existing `dividendLinkage` pass has the identical shape, and an OLD
client that OMITS the field is rejected by `parseBundleFinalizeWireInput`
with a 400), but a fail-closed check whose expected set is supplied by the
party it is protecting against is defence in depth only. **How to apply:**
ask where the EXPECTED set comes from; here the server never persists the
bundle's transaction count at scaffold time (`import_batches.transaction_rows`
is written only at finalize, from the same wire body), so nothing
server-side can contradict a short list. Recommend persisting the expected
count/ref digest at scaffold as a follow-up rather than blocking.

**60. "Fallback self-loads exactly as before" is an OUTPUT claim, not a
COST claim.** PRF-012's correction round makes `resolveOwnedPortfolioContext`
return `null` on its own sanity failures so every caller self-loads. Output
parity is real (verified byte-identical for all three loaders), but the
census on the fallback fixture is `31/32/32` pre-PRF-012 vs `33/34/35`
post — the 3 discovery reads are pure waste on the degraded path, and the
assumptions screen pays them PLUS its full self-load. **Why:** the standard
census fixture never enters the fallback, so the shipped "census unchanged"
pin (26/27/25) says nothing about it. **How to apply:** measure the
degraded path against the pre-fix tree on the SAME fixture (build a third
`$TMPDIR/pre0` tree from the pre-feature commit, copy the NEW test file and
the new module into it — the pre-fix loaders ignore the unused parameter).
Only block if a doc/commit sentence claims cost parity; "self-loads exactly
as it did before" about behaviour is not that claim.

**60b. Structured-logging convention here is genuinely MIXED.** App-layer
loaders (`app/owned-holdings.ts`, `app/owned-capital-gains.ts`,
`app/import-actions.ts`, `app/system-backup-actions.ts`, `worker/index.ts`)
use `emitStructuredLog` (which redacts metadata and stamps
level/action/result/requestId/occurredAt, defaulting to `console.log`), but
`domain/dividends/history.ts:747` (BUG-021) and `app/portfolio-actions.ts`
use raw `console.warn`/`console.error`. A raw
`console.warn(JSON.stringify({event, reason}))` with a fixed reason string
and no owner data is a consistency follow-up, not a blocker — and note the
shipped tests mock `console.warn`, so switching to `emitStructuredLog`
(which writes to `console.log`) is NOT a one-line local fix.

**57b. The ACCEPTED remedy for 57 (recorded because it PASSED review), and
the marker that is DEFINED but never consumed.** BUG-021 round 2 (`22c6d81`,
2026-09-04) gave `DividendManualRecordFact` a per-field
`unreadableFields?: ReadonlySet<"totalCash"|"totalFranking"|"shares"|
"perShare"|"frankingPerShare">` populated by `sanitizeManualRecordAmounts`
alongside the existing nulling; `deriveAbsentImportedFranking` short-circuits
on `totalFranking` BEFORE its DIV-007 zero inference (sets a new
`DerivedDividendRow.frankingUnreadable` instead), and
`resolveImportedRecordCurrency`'s B2 guard checks `totalCash` before the
convert path. Verified in three `git archive` trees (pre-round-1 `ed86b8a^`,
round-1 `ed86b8a`, round-2): the foreign/unreadable-cash record now returns
`cur:"USD", orig:null, fx:null` — byte-equal to the pre-round-1 F3-catch
outcome, where round 1 wrongly showed `cur:"AUD", orig:"USD", fx:"1.5"`; the
unreadable franking total gives `frank:null, derivedZero:false,
frankingUnreadable:true`, `receivedFrankingUnknownCount 1`, and
`frankingDisplay` "Franking unavailable — needs correction"; a genuinely
absent franking still derives `"0"`/`frankingDerivedZero:true` in all three
trees (DIV-007 unregressed). Note `grossDecimal` equals cash for such a row —
that is the module's pre-existing `grossIncludesFranking:false` convention
(`computeCashGrossOrTotals`), NOT a cash+0 fabrication. The override
(`frankingOverrideTotalDecimal`) is sanitized in the same pass under the
`"totalFranking"` marker, so a readable stored total still wins over an
unreadable override and vice versa. **Residual to re-check on any later
round:** three of the five markers (`shares`, `perShare`, `frankingPerShare`)
are never read. `shares`/`perShare` are covered indirectly (cash goes null →
`amountUnreadable`), but an unreadable `franking_credit_per_share_decimal` on
a PER-SHARE record renders plain "Unknown" — or, when a
`defaultFrankingPercentDecimal` assumption exists, is silently replaced by
the assumption (measured: `frank "6.42857142857142857142857"`,
`franking.source "default"`, display `"$0.64 (default)"`, no
`frankingUnreadable`) — so corrupt stored franking reads as "not reported,
use the default" with no "needs correction" signal. Also: routing every
`dividend_import_franking_overrides` writer through the newly bounded
repository `save()` makes `app/portfolio-bundle-service.ts:969/2585` fail the
whole restore part ("A franking override could not be replayed.") for a
legacy over-scale override — same undocumented fail-closed consequence
BUG-022 already carries as an open residual.

**57c. Re-review of `22c6d81` (2026-09-04, second pass — same PASS ruling;
do not re-litigate).** Independently re-verified: A1 (imported totals-mode,
97-fractional-digit franking) -> `cash "100"`, `frank null`,
`frankingDerivedZero false`, `frankingUnreadable true`, `frankingDisplay`
"Franking unavailable — needs correction", `receivedFrankingUnknownCount 1`,
`gross "100"` (the `grossIncludesFranking:false` convention, not cash+0);
DIV-007 absent case still `"0"`/`derivedZero:true`; both-columns-unreadable
-> `amountUnreadable` + `frankingUnreadable`; override precedence both ways
(native currency: readable stored beats unreadable override "$42.50 total";
readable override beats unreadable stored "$42.50 total (owner-entered)");
B2 foreign/unreadable-cash byte-equal to the `ed86b8a^` tree
(`cash null, cur USD, orig null, fx null`); the doc's ops SQL run over a
9-row fixture counts 25-scale / `"2.50 "` / leading-zero / `-0` / 65-digit
and excludes dot-less-30, 24-scale, 64-digit, canonical; 6 of the new
bug-021 tests + 2 brk-011 tests fail against `ed86b8a`; `npm test`
2994/0 fail, typecheck/format/lint clean (only the known mkt-011a warning).
**New measurement on the 57b residual (worth quoting in any follow-up):** a
PER-SHARE record with an unreadable `franking_credit_per_share_decimal` plus
a `defaultFrankingPercentDecimal` produces
`frank "21.4285714285714285714286"`, `franking.source "default"`,
`receivedFrankingKnownDecimal` the SAME value, `receivedFrankingUnknownCount
0`, gross inflated — byte-identical to the genuinely-absent fixture, so a
corrupt stored tax figure is silently replaced by the owner's assumption and
counted as KNOWN. Ruled follow-up, not blocking: it predates this round
(round 1 introduced it, the round-1 ruling never named it) and the copy at
least says "(default)". Also confirmed non-reachable: `frankingDisplay`'s
`frankingUnreadable` check sits AFTER the per-share branch, but
`db/repositories/dividends.ts:1223` rejects a record carrying both amount
modes, so no validated writer can produce the shape that would bypass it.

**58b. The round that CLOSES a retired protocol leaves the retired protocol
described as current in the production module's OWN header comment.**
OPS-005 round 2 (`8355386`, 2026-09-04) correctly extended the ref-membership
probe to dividends, persisted a server-derived ref digest+count at scaffold
and cross-checked it at finalize, and corrected `docs/BACKUP_FORMAT.md`,
`docs/ARCHITECTURE.md` (incl. the `git stash` provenance sentence) and
`docs/DATA_MODEL.md`. But `app/portfolio-bundle-service.ts:1124-1136`'s
"RESUME EVIDENCE (binding design constraint from the task, satisfied
directly)" paragraph still says, in the present tense, that the browser
"always re-derives 'how much is left' from this authoritative count ... then
slices the SAME chain-ordered array (`domain/exports/chain-order.ts`, shared
with the browser so both sides compute an IDENTICAL order) starting at that
count", and repeats the safety claim the whole task reproduced as FALSE ("a
stale/incorrect client-side guess can therefore never skip real, unwritten
rows"). Same class: `domain/exports/chain-order.ts:7-16` still names
`app/components/system-backup-panel.tsx` as a consumer that "must slice ...
in the SAME order the server would compute" -- while the same commit's own
wiring pin (`tests/exp-004.test.ts:2393`) asserts the panel must NOT import
that module. **How to apply:** after any diff that RETIRES a protocol, grep
the changed module's own header/section comments and the extracted domain
module's header for the retired mechanism's vocabulary (`slice`,
`committedXCount`, the shared-ordering rationale), not just `docs/`; a module
carrying two contradictory descriptions of its own resume protocol, one of
which asserts a disproven safety property, is the exact re-introduction
hazard the task exists to close.

**59b. The accepted remedy for 59, and its measured residual.** The same
round persisted `bundle_transaction_refs_digest/_count` and
`bundle_dividend_refs_digest/_count` on `import_batches` (migration `0061`,
four nullable columns, plain ADD COLUMN, `drizzle-kit generate` reports
"nothing to migrate"), written by `commitValidatedPortfolioBundleScaffold`
on EVERY scaffold call from the bundle's own sorted refs, and compared at
finalize BEFORE the existence probes (typed 409 naming expected-vs-received,
batch `failed`, recoverable because the next scaffold resets `failed` ->
`committing`). Verified myself: 200 dividend refs -> 4 SELECTs / max 52 bound
params, exactly 1 digest UPDATE per scaffold call; `chainOrder` never drops
rows (its tail loop appends anything unplaced), so the persisted count always
equals the bundle's own length. Residual, measured: NULL digests are SKIPPED,
and a batch whose four columns are NULL accepts a 1-of-2 `transactionRefs`
list and reaches `committed` with `transaction_rows = 2`. Unreachable through
the real panel (it always scaffolds before finalize in the same run, and every
scaffold writes the digests), so the fail-open legacy branch is defensible --
say so rather than treating it as an open hole.

**57d. The round that CONSUMES the last unread marker changes a documented
CALCULATION chain and ships no `docs/CALCULATIONS.md` change at all.**
BUG-023 round 1 (`6991fa2`, 2026-09-04) correctly forced the franking
resolution to `"unknown"` at all three derivation sites via
`resolveFrankingPerShareRespectingUnreadable` (verified independently: the
excluded-event resurfacing site at `domain/dividends/history.ts:~2335` — the
one with no test — yields `franking.source "unknown"`, `frankingUnreadable
true`, `receivedFrankingUnknownCount 1`, siblings byte-identical, and the
same fixture with a readable/absent value still takes the default). But
`docs/CALCULATIONS.md:644` still states the chain as "per-dividend known
value → the security's 'franking if not known' default → unknown" with no
unreadable short-circuit, and `:842` still says that chain "keeps consulting
`dividend_security_assumptions.franking_percent_decimal` **unconditionally**
as its own fallback tier, exactly as before" — false the moment this landed.
BUG-014/BUG-021 both carried their dated paragraph in the same commit
(`:569`/`:571`). **How to apply:** for any diff that changes which tier of a
documented resolution chain fires, grep `docs/CALCULATIONS.md` for the chain's
own sentence (search the function name AND the tier words), not just the task
ID; the file's convention is an appended dated paragraph, never an edit of the
original. **Also measured on this round (follow-ups, not blocking):** the
receipts tier really is unsanitized — a `DividendReceiptFact.
frankingPerShareDecimal` with 97 fractional digits still throws
`Invalid decimal input: supported boundary exceeded` for the whole security,
and `db/repositories/dividends.ts`'s receipt `create()` bounds FORM only
(`isNonNegativeDecimalString`) — but no production caller of that `create()`
exists (only `list()`), and receipts are absent from the bundle, so it is
direct-DB-only today. And nulling `frankingTotalDecimal` makes
`shouldOfferFrankingOverride` TRUE for an imported standalone PER-SHARE row,
where the saved override is then IGNORED (per-share mode never reads a
franking TOTAL): `frankingCurrencySource` flips to `"owner_manual"` while the
cell still reads "Franking unavailable — needs correction" — BRK-011's own F1
"silent no-effect override" shape, but pre-existing (reproduced on `22c6d81`
with `defaultFrankingPercentDecimal: null`), so not this round's defect.

## 61. Bundle-slimming diffs: the "dead fallback" claim is cheap to settle, but the pin usually shrinks to one file and the provenance sentence re-imports `git stash` (PRF-014 step 1, `3914f10`, 2026-09-04)

Removing a `"use client"` module's runtime fixture import (`portfolioPrototypesOverride ?? portfolioPrototypes` -> `?? []`) is verifiable in ~10 minutes and this one held up: all three `<PortfolioShell>` call sites pass a prop, and 16 render permutations (preview/owned/unavailable x 5 sections + a `holdingSymbol` detail) are BYTE-IDENTICAL pre vs post. The recipe: one `render.mjs` at the ROOT of each `git archive` tree (`node --import tsx render.mjs`), printing `### <label>` sections, then a python diff per section — no test harness needed, and the `ROUTER_STUB_IMPORT` + owned-workspace fixture can be lifted verbatim from `tests/ui-035.test.ts`. Chunk-size claims reproduce exactly from two `npm run build`s in the pre/post trees.

What review still has to catch:
- **Scope asked for a BUILD-OUTPUT pin; the diff shipped a SOURCE pin** over the one file it changed, citing `tests/bug-001.test.ts`'s "a `dist/client` bundle-grep is not a reliable guard". That citation is backwards: bug-001 warns a grep gives false NEGATIVES (Rollup tree-shakes the crash away while the dev server still loads the graph); it is not an argument against an ABSENCE grep, and `tests/security-headers.test.ts` ("client output contains no Cloudflare Access configuration") already reads `dist/client/` under `npm test`, which builds first. A one-file source pin cannot see the next `"use client"` module that re-imports the fixture — i.e. it does not cover the stated goal ("the production client bundle free of `prototype-data`").
- **`git stash` provenance, third occurrence in `docs/ARCHITECTURE.md`** (pattern 58): the same file already carries two dated corrections (PRF-008, OPS-005 round 2) saying the shared checkout must never be stashed and the procedure is `git archive`. Grep `git stash` in `docs/` on EVERY diff claiming a before/after measurement.
- **"harmless" claims about the now-empty fallback**: rendering with neither prop no longer shows demo data, it THROWS (`holdings`/`quotes`/`details` all crash on `portfolio` being `undefined`; only `overview` renders). Harmless in production (no such call site) but the code comment and the doc say otherwise, and the props type still permits it. Cheap probe: a `neither.mjs` looping the sections in the post tree.
- Small doc arithmetic: "present exactly once in the pre-fix chunk" was twice (`app/prototype-data.ts:306` and `:394` share the value).

### 61b. The accepted remedy (PRF-014 step 1 correction, `f8305c6`, 2026-09-04 — PASS)

Template worth reusing when a bundle/source pin is judged too narrow:
duplicate `tests/bug-001.test.ts`'s `"use client"` walker INTO the task suite
(never import it — importing re-registers that file's `test(...)` blocks),
walk every client entry under `app/` for a value-carrying edge (direct or
transitive) to the forbidden module, and fail closed on an entry count
(`clientEntries.length >= 10`) so an empty walk can't pass vacuously. Pair it
with a `dist/client` absence grep shaped exactly like
`tests/security-headers.test.ts:179` (same missing-`dist` behaviour, so no
finding there). Verified: guard fails on a direct value import injected into
an unrelated client module AND on a value import in a NON-client module
imported by one; the build-output grep ran against 35 real assets and failed
when a fixture string was appended to a built chunk. Note the walker only
resolves RELATIVE specifiers — harmless here because nothing in `app/`,
`db/`, `domain/`, `worker/` uses the `@/*` tsconfig alias; re-check that
`grep -rn 'from "@/'` if the repo starts using it.

Doc side: leaving the wrong sentence in place and appending a dated
`**(Corrected <date>, <task> round ...)**` note that quotes it and says
"read it as ..." is the ACCEPTED convention here (PRF-008 and OPS-005 round 2
did the same in the same file) — do not fail a round for not editing the
original sentence. Do re-measure the figures it re-asserts: two `npm run build`s
in `git archive` pre/post trees reproduced 125,556 -> 119,561 bytes exactly and
the twice-per-chunk fixture-string count.

### 62. A partial-index narrowing that frees ONE terminal status and silently drops the task's "decide the sibling terminal status" deliverable

BRK-020 (`4a107cf`, 2026-09-04) narrowed
`import_batches_user_file_parser_unique` to `WHERE status <> 'reversed'` so a
reversed batch stops occupying the file-dedupe key. Everything the diff claims
verified true (4 of 5 new tests fail pre-fix; the `ON CONFLICT` target repeats
the predicate and is the only one on those columns; `'reversing'` still
occupies the key; the two status-blind readers' `EXPLAIN` degradation to
`SEARCH import_batches USING INDEX import_batches_owner_status_updated_at_idx
(user_id=?)` is exactly as recorded; `drizzle-kit generate` reports nothing to
migrate and the 0062 snapshot diff is the single `"where"` key). What was
missing: the task said "exclude terminal batches (`reversed`, **and decide
`failed`**)" and no doc/TASKS line mentions `failed` at all.
`isValidTransition` gives `failed: []`, so a `failed` batch is terminal AND
still holds the key — measured through the real sync service:
`{reused: true, batchStatus: "failed", newRows: 1}` forever. Latent only
(`grep -rn "import_batches SET status"` shows the ONLY `'failed'` writer is
`app/portfolio-bundle-service.ts`, always
`parser_format = 'portfolio-bundle-json'`; `persistParsedResult` writes only
`'invalid'`/`'parsed'`, the two `transitionStatus` callers pass
`'ready'`/`'needs_mapping'`, and `import_batches` is excluded from BOTH the
portfolio bundle and the core system backup) — but an explicitly requested
DECISION with no recorded answer is a completion gap, not a style nit.

**How to apply:** for any constraint-narrowing task, diff the task's own
enumerated status list against the predicate that shipped, and grep the doc
additions for each name; then prove the omitted state's behaviour with the
real entry point rather than the repository. Second, a narrowed unique index
makes a NEW row shape reachable (here: reversed + live under one key) — run
the status-blind readers against that shape. `findExistingBatch`'s `LIMIT 1`
with no `ORDER BY` happens to return the LIVE row only because the new plan
walks `(user_id, status, updated_at)` and `'committed' < 'reversed'`; that is
plan luck, not contract.

**63. A "future-proofing" fail-closed guard whose trigger set is widened
beyond the task's list picks up PRESENCE tests that misfire on the
explicit-NEGATIVE encoding.** BRK-017 step 2 (2026-09-04) added
`findPaginationEvidence` to `domain/sharesight/parse.ts`'s `parseItemList`
— the shared envelope reader for all five Sharesight list endpoints
(portfolios/holdings/trades/payouts/instruments). Every other trigger is a
comparison (`total_pages > 1`, `total_count > arrayLength`,
`arrayLength >= per_page`), but `next_page` is
`!== undefined && !== null`, so `{next_page: false}`, `{next_page: 0}` and
`{next_page: ""}` — the ordinary "there is no next page" encodings for a
Rails/Kaminari-shaped API, which Sharesight is — all fail the WHOLE list
closed. Reproduced in ~10 lines against the real parser. The second half of
the same finding: the trigger set included a BARE top-level `total >
arrayLength`, and `total` is the one name that reads equally as a money
aggregate on a trades/holdings envelope; inside a `meta`/`pagination`
sub-object it is unambiguously a count, at envelope top level it is not.
**How to apply:** for any defensive guard added for a shape that has never
been observed, (a) list each trigger and ask what the provider's "no, there
isn't more" encoding of that key looks like — a presence test is wrong for
any key whose negative form is falsy rather than absent; (b) separate the
trigger names into count-shaped-only (`total_pages`, `total_count`,
`page_count`) versus generic domain words (`total`, `value`, `count`) and
push the generic ones down into the nested metadata container where they
cannot be read as domain data. Blast radius matters: this guard sits under
the sync AND the daily price-capture/price-gate paths, so a false positive
is a hard visible stop for all of them. Cheap evidence that the guard does
NOT false-positive today: ask the Orchestrator to re-run the live read
spike AFTER the guard lands — it exercises the envelopes the probe never
sampled (here portfolios + holdings).

**63b. A spike script's "no id is ever printed" header claim versus what
its own metadata-value printer emits.** The same task's probe
(`scripts/sharesight-pagination-probe.mjs`) prints the VALUE of any sibling
key matching `PAGINATION_META_PATTERN` (`/link|page|total|count|next|prev|
per_page|offset|cursor|meta/i`), which on every real response is
`links.self` — a URL containing the owner's real Sharesight portfolio id —
while the header states "No amount, id, ticker, holding, or portfolio name
is ever printed". The suite's own guard only asserts the FAKE run's output
is clean, and the ARCHITECTURE evidence table correctly used a dummy id, so
nothing catches it. **How to apply:** whenever a spike prints values under
a name-pattern exception, construct the real value the pattern will match
(here a `self` URL) and check it against the file's own stated no-values
rule; the leak is in the CATEGORY the exception opened, not in the fields
the rule enumerates.

**64. An `EXPLAIN QUERY PLAN` pin built on a hand-`CREATE TABLE`d fixture
records the OPPOSITE of the production plan.** BRK-020's correction round
(2026-09-04) added `tests/brk-020.test.ts`'s "F1 (pin)" test, which
`CREATE TABLE import_batches (...)` with **no indexes at all** and then
asserts `/SCAN.*import_batches/i` + `/USE TEMP B-TREE FOR ORDER BY/i`,
with a comment claiming "no index covers (user_id, file_sha256,
parser_format, parser_version) without a status predicate, so this is a
full scan ... (bounded by that user's batch count, not the whole table
across owners)" — self-contradictory, and false: against the real migrated
schema the plan is `SEARCH import_batches USING INDEX
import_batches_owner_status_updated_at_idx (user_id=?)` +
`USE TEMP B-TREE FOR ORDER BY` (pre-fix: the same SEARCH, no temp B-tree).
`SEARCH` does not match `/SCAN/`, so the pin would FAIL if pointed at the
real schema. The commit's ARCHITECTURE/DATA_MODEL prose happened to be
right ("per-owner scan plus a temp B-tree"), so only re-running EXPLAIN
catches it. **How to apply:** whenever a test asserts a plan, check what
built its schema — a bare `CREATE TABLE` in the test body means the plan
is index-free by construction and the pin is inert. The suite almost always
already has a `migratedDatabase()` helper; require the pin to use it. Also
re-derive any in-code comment about "which row the planner visits first":
here `findExistingBatch`'s new comment says the pre-fix order "has been a
full-table-scan (rowid/insertion order) accident" while the measured order
was status-then-`updated_at` within the owner — the code comment and the
docs of the SAME commit disagreed. Related: [[review-verification-commands]]'s
schema-only EXPLAIN recipe, patterns 9/9b/31.

**65. A "source-scan guard so a future writer forces this decision to be
revisited" whose regex only sees INLINE SQL, while the doc names a
BOUND-PARAMETER route as the trigger.** BRK-020 B1 recorded that
`import_batches.status = 'failed'` is written only in
`app/portfolio-bundle-service.ts`, and pinned it with
`/UPDATE\s+import_batches\s+SET\s+status\s*=\s*'failed'/gi` over `app/` and
`db/`. Mutation-tested: (a) flipping `app/import-ready-service.ts`'s
`transitionStatus(..., { nextStatus: "ready" })` to `"failed"` — the exact
mechanism `docs/DATA_MODEL.md` names one sentence earlier ("i.e. actually
reaches it via `transitionStatus`"), which writes `SET status = ?` in
`db/repositories/import-staging.ts` — PASSES the guard; (b) a raw
`UPDATE import_batches SET updated_at = ?, status = 'failed'` (any
non-first SET position) PASSES; (c) `domain/` and `worker/` are not
scanned at all. Only the literal shape the three known writers already use
is caught. **How to apply:** for any "a new writer must fail this test"
pin, write the new writer THREE ways — inline SQL, the repository's own
typed mutator with the value as an argument, and a reordered/multiline
variant — and run the guard against each; a guard that only recognizes the
current writers' spelling is a tautology. Same family as pattern 12
(greping SQL text for a value that is always bound). Also check the pin's
own assertion message for stale line numbers: the immediately preceding
commit (`3ad6d03`) existed solely to correct 470/531/1086 -> 484/545/1100
in DATA_MODEL.md and left the test's copy of the old numbers untouched
(pattern 36e).

### 61c. The accepted VERBATIM-EXTRACTION template (PRF-014 step 2a, `a5a9577`, 2026-09-04 — PASS)

Moving a pure, JSX-free/hook-free block out of a `"use client"` `.tsx` into a
plain sibling `.ts` is the right shape and this one held up end to end. The
five checks that settle it in ~15 minutes, all in `git archive` trees:

1. *Verbatim?* python `difflib.unified_diff` of the parent commit's line range
   against the new module's body, after stripping a leading
   `export (?=(function|const|type|interface|enum))` from each line. PRF-014
   step 2a's only diff was prettier re-wrapping ONE signature that the added
   `export ` pushed past 80 columns — accept that, not a logic edit.
2. *Still pure?* grep the new module for `use client` / `useState|useEffect|
   useMemo|useRef` / `from "react"` / `</` / `/>` and read every `import`
   line; then `head -1` each imported module to prove none is itself a client
   entry. Two `"use client"` hits in PRF-014's module were inside MOVED
   comments — one of which ("this workspace crosses the RSC boundary as a prop
   into this `"use client"` module") is now false in its new home. Report the
   stale moved comment as a follow-up, never a blocker: correcting it would
   break the verbatim claim the task asked for.
3. *Pins not weakened?* Re-pointed source pins must be mutation-tested IN THEIR
   NEW HOME. Restore-and-mutate one file in a loop (`cp model.orig` back each
   iteration) and run the three suites: 5/5 mutations each failed exactly one
   test. Also check the CONVERSE — a pin that now only reads the extracted
   module proves the definition, never that the shell still calls it; look for
   a surviving usage-site pin on the `.tsx` (`FY_MONTH_NAMES\.map`,
   `isAbortError\(error\) \? DIALOG_TIMEOUT_MESSAGE`), and note ESLint
   `no-unused-vars` on the import is only a WARNING here, so it is a weak
   backstop.
4. *Render parity, yourself.* One `render.mjs` at each tree's root
   (`node --import tsx render.mjs`) emitting `### <label>` + `renderToStaticMarkup`
   for owned holdings/overview/details plus all five preview sections; `diff`
   the two files. 9 sections, byte-identical, same SHA-256. Fixture lifts
   verbatim from `tests/ui-035.test.ts` (`ROUTER_STUB_IMPORT`, `ONE_HELD_ROW`)
   and `tests/fy-001c.test.ts` (the `overview` object). Know the blind spot:
   the settings drawer is client-state gated, so `FY_MONTH_NAMES` /
   `financialYearWindowHelperText` never appear in SSR output — check them via
   the verbatim diff, not the render.
5. *Bundle.* `npm run build` in BOTH trees and `ls -l dist/client/assets/ |
   grep <chunk>`: 119,561 -> 119,559 reproduced exactly.

**Scratchpad collision (2026-09-04, this session).** The session scratchpad
`/private/tmp/claude-501/<slug>/<session-id>/scratchpad` is shared with SIBLING
subagents of the same session, so generic names like `pre/` and `post/` get
written into by another agent MID-REVIEW — a BRK-020 reviewer dropped
`matrix.mjs` and appended `REVIEW PROBE` tests to `tests/brk-020.test.ts`
inside my freshly-extracted `post` tree, and `npm run format:check` there
reported two "failures" that do not exist at the commit. **How to apply:**
name every scratch tree `<task>-<role>` (e.g. `prf014r-post`), and if
`format:check`/`lint` flags a file the diff never touched, re-extract into a
uniquely named directory before reporting it. Extends
[[review-verification-commands]]'s `$TMPDIR` note to the session scratchpad.
