---
name: review-verification-commands
description: The verification commands that actually work in this repo (format/lint/tsc/node --test/npm test), their runtimes, and the known pre-existing lint warning
metadata:
  type: project
---

Verification commands that work from the repo root, with observed behaviour as of 2026-08-30:

- `npm run format:check` — prettier, fast.
- `npm run lint` — ESLint. **One pre-existing warning is expected and is not a
  finding:** `tests/mkt-011a.test.ts:168 '_request' is defined but never used`.
  Zero errors is the bar.
- `npm run typecheck` (= `tsc --noEmit`) — the script DOES exist (package.json)
  and is also inside `npm run check`. It was clean at BRK-016's parent commit,
  so ANY error is a regression of the diff under review. Workers here routinely
  verify with `format:check` + `lint` + `npm test` and skip it — BRK-016 shipped
  a TS2349 in a new test file that way. Always run it; it costs ~20 s.
- Targeted: `node --experimental-strip-types --test tests/<id>.test.ts ...`
  (~1-3 s per suite; no build needed). This is the fast loop for diff review.
- `npm test` — runs `vinext build` first, then the whole suite: 2651 tests /
  2641 pass / 10 env-gated skips as of 2026-08-30 (EXP-004 escalation), ~40 s of
  test time after the build (~2-3 min wall clock total). Safe to run in the
  background while reading the diff.

**Cheapest way to get independent evidence about service-layer behaviour.**
`cp tests/<id>.test.ts tests/.review-scratch.test.ts`, append your own `test(...)`
blocks (all the file's fixture helpers — `migratedDatabase`, `buildBundle`,
`seedFreshAccount`, `countingClient` — are already in scope, and relative
imports still resolve from `tests/`), run
`node --experimental-strip-types --test tests/.review-scratch.test.ts`, then
`rm` it before running `npm run format:check`. This is how the EXP-004
escalation review proved `validatePortfolioBundle` idempotency and metered real
per-part D1 costs instead of trusting the worker's table.

**Proving SQL claims (collation, index use, predicate equivalence) yourself.**
Write a scratch `.mjs` at the repo root that opens `new DatabaseSync(":memory:")`,
`exec`s every `drizzle/*.sql` in sorted order (same as the suites' own
`migratedDatabase` helper), then asks SQLite directly: read
`sqlite_master.sql` to confirm a column has/lacks a `COLLATE`, run
`EXPLAIN QUERY PLAN` to see whether a predicate actually hits an index, and
insert probe rows to diff old-vs-new predicates row-for-row. This is how the
EXP-004 LIKE→byte-range review confirmed BINARY collation, that the range
upgraded a partial index probe to a full `SEARCH … USING COVERING INDEX
(user_id=? AND portfolio_id=? AND idempotency_key>? AND <?)`, and that the only
keys LIKE matched but the range does not are upper-case-hex fingerprints
`sha256Hex` cannot emit. Delete the scratch file before `npm run format:check`.

**Independently rendering a client component (reviewer's own evidence).** To
check real markup rather than trusting a worker's assertions, copy the
`renderComponent` shape from `tests/brk-005b.test.ts`/`tests/ui-049.test.ts`
into a scratch `.mjs`, then run it with `node --import tsx <script>`. The
script **must live inside the repo root** (module resolution for `react`/`next`
fails from `$TMPDIR`); write it to a dot-prefixed scratch file at the root, run
it, and delete it immediately — never leave it in the worktree. This is how the
UI-049 review found a dead `href="/api/portfolio-bundle//export"` link that no
test covered.

**Proving an old-vs-new "output is identical" refactor claim.** Dump the
pre-commit module beside its replacement so BOTH can be imported in one test:
`git show <commit>^:app/<mod>.ts > app/.review-old-<mod>.ts` (keep it in the
SAME directory so its relative imports still resolve), then
`cp tests/<covering-suite>.test.ts tests/.review-scratch.test.ts`, import the old
export under an alias, build the fixture TWICE (these loaders WRITE — e.g.
`upsertStoredValueHistory` — so old and new each need their own `DatabaseSync`),
and `assert.deepEqual` both the returned value and the persisted rows. Used
2026-08-31 to prove PRF-003's `priceWindow` narrowing is byte-identical on cold,
warm+middle-day-invalidated, warm+oldest-day-invalidated and multi-day-gap
fixtures. `rm` both scratch files before `npm run format:check`.

**Proving an index-use claim for a NEW predicate shape (fastest, no fixture).**
A repo-root scratch `.mjs` that `exec`s every `drizzle/*.sql` into
`new DatabaseSync(":memory:")` (wrap each in try/catch and split on
`--> statement-breakpoint`; some files fail harmlessly) can be EXPLAIN-ed with
ZERO rows inserted — SQLite picks the plan from the schema, not the data. Build
the candidate SQL at several parameter counts (N=1,2,5,10) and diff the plan
strings; that is how PRF-005's OR-window index degradation was found in under a
minute (see [[review-recurring-issues]] pattern 15). Pair it with a second
scratch that seeds ~60k synthetic rows and `performance.now()`-benchmarks the
old vs new vs alternative SQL, so the finding carries a measured number.

**Proving old-vs-new equivalence for `loadHistoricalPortfolioValueAtDates`.**
This loader performs NO writes, so old and new can share one fixture DB (unlike
`loadHistoricalPortfolioValueSeries`, which writes). Build a two-security
fixture (one base-currency, one foreign so FX participates), parameterize it by
three date arrays (AUD prices / USD prices / FX rows), then `assert.deepEqual`
the sorted `Map` entries from both modules across: exact date, `-7` tolerance
edge, `-8` just outside, FX-only gap, no observations, overlapping adjacent
requested dates, 10 FY-end dates over dense daily prices, out-of-range dates,
and ~25 randomized-density fuzz trials. Price/FX share the SAME `toleranceDays`
and are both backward-only (`candidatesWithinTolerance`, offsets `0..N`), so a
`[date-7, date]` inclusive `BETWEEN` window is exactly equivalent. The one real
divergence to probe deliberately: a requested date sitting AT the
`MAX_CANDIDATE_DATES` 10-year clamp floor with its only price BELOW the floor —
the old full-range read reports `partial`/null, the new per-date window reports
a complete value.

**Proving a new suite's tests genuinely fail without the fix (repository
layer).** Dump the pre-commit repository module beside its replacement so its
relative imports still resolve:
`git show <commit>^:db/repositories/<mod>.ts > db/repositories/.review-old-<mod>.ts`,
`cp tests/<id>.test.ts tests/.review-scratch.test.ts`, then in the scratch copy
import ONLY the changed factory from the old module
(`import { createOwnedImportCommitRepository } from "../db/repositories/.review-old-import-commit.ts";`)
while every other helper still comes from `../db/repositories/index.ts` — the
rest of the pipeline (staging, preview, ready-service) is unchanged, so the
suite runs end-to-end against the old code. Used 2026-09-01 on PRF-007: 4 of
the 7 tests flipped to fail, which is what "this test carries the regression"
actually means. `rm` both scratch files before `npm run format:check`.

**Cheapest EXPLAIN check for a rewritten aggregate query.** A repo-root scratch
`.mjs` that `exec`s the `drizzle/*.sql` chain into `:memory:` can EXPLAIN both
the old (`git show <commit>^:<path>` text) and new SQL side by side with dummy
bound params and zero rows, and the same script can settle "does LIMIT apply
per-branch or to the aggregated result" with a 6-line toy `UNION ALL` + `GROUP
BY` probe. PRF-007: both UNION branches keep index seeks
(`SEARCH r USING INDEX import_rows_user_normalized_fingerprint_idx (user_id=?)`
then a PK/unique seek on `transactions`/`dividend_manual_records`), and the
outer `LIMIT` is applied after `GROUP BY`, so an `n+1` overflow guard still
works.

**Proving a `wrangler.json` env-scoped setting actually reaches production.**
`dist/server/wrangler.json` is the RESOLVED config the deploy uses
(`docs/PRODUCTION_DEPLOYMENT.md`: `CLOUDFLARE_ENV=production npm run build` then
`wrangler deploy --config dist/server/wrangler.json`). A plain `npm run build`
resolves the TOP-LEVEL env, so `env.production.*` keys are absent from it and
prove nothing. Run `CLOUDFLARE_ENV=production npx vinext build` and read the
resolved key out of `dist/server/wrangler.json` (this is how PRF-004's
`placement: {mode: smart}` was confirmed non-inert), then **re-run plain
`npx vinext build`** — `tests/runtime-config.test.ts` reads that same file and
would otherwise see production vars. Schema-validate new keys against
`node_modules/wrangler/config-schema.json` (`placement` exists on both
`RawConfig` and `RawEnvironment`).

**Re-measuring a census "before" number the cheap way.** The census harness
lives entirely in `tests/prf-002.test.ts` and mirrors the loaders rather than
importing a page, so the pre-fix number is one command:
`git show <commit>^:tests/prf-002.test.ts > tests/.review-old-prf-002.test.ts`
then `node --experimental-strip-types --test --test-name-pattern "per-page
census" tests/.review-old-prf-002.test.ts` and `rm` it. Used 2026-08-31 to
confirm PRF-006's root page really went 20/20 -> 19/19 D1 calls/statements.
Note the printed `stages=[...]` list shows a `batch:N` bucket only if a page
actually batches — as of PRF-006 no census page does, so harness changes to the
`batch()` handler are unexercised by the census tests.

**Measuring the per-page critical-path depth census.**
`node --experimental-strip-types --test tests/prf-002.test.ts 2>&1 | grep depth=`
prints the DP-based `depth`, `criticalPath` and informational
`concurrencyGroups` per page in a few seconds — always re-run it rather than
trusting a worker's depth table (see [[review-recurring-issues]] pattern 13).

**Measuring app-side Worker CPU (the thing a free-plan 10ms/1102 claim rests
on).** The repo's method is a `SqlClient` wrapper that accumulates time spent
inside `all/get/run/batch`, then reports `wall - sqlMs` (`timedClient` in
`tests/bug-010.test.ts`). Two rules: (1) it is only valid for a SEQUENTIAL call
chain — run it over a `Promise.all` page loader and overlapping SQL intervals
are double-counted, so the number goes NEGATIVE (measured -15ms for the root
overview census). To time a whole page, copy `tests/prf-002.test.ts` to a
scratch and rewrite the census function's `Promise.all` into sequential
`await`s. (2) It EXCLUDES D1 result deserialization, which in production IS
Worker CPU, so every number it produces understates the real Worker cost.
Measured 2026-09-01 on the prf-002 production fixture (dev machine, node:sqlite):
root overview page ≈ 8.4ms app CPU fully backfilled, ≈ 13.8ms with the series
wiped at `MAX_DERIVE_DATES_PER_READ = 10`, ≈ 118.8ms at the old 400. To
re-measure a per-date cost curve, call the exported
`backfillStoredValueHistoryForPortfolio(client, user, pf, N, now)` at
N = 1,5,10,20,50,100,200,400 against `tests/bug-010.test.ts`'s
`productionScaleFixture` — that is the whole harness.

**Attacking a stored "converged / nothing to do" marker.** Two scratch tests
settle it in under a minute (used 2026-09-02 on PRF-010, both landed):
(1) converge, let the marker be written, then make a SOURCE-side change only
(one `INSERT INTO price_observations` for a date not previously observed) and
run the tick — if it returns `missingDates: 0` the marker is blind to that
side; (2) force a count collision with real writers only — add N new interior
candidate dates, invalidate N interior stored dates through the real
invalidation entry point, then run ONE tick with `maxDeriveDates = N` so it
restores the count from the wrong end. Build the fixture small (1 security,
20 weekdays); the production-scale fixture is not needed for either.
Related: [[review-recurring-issues]] patterns 30/31.

**Proving a `MIN`/`MAX` probe is a seek and not a scan.** `EXPLAIN QUERY PLAN`
cannot tell you: both shapes print `SEARCH po USING INDEX … (security_id=? AND
adjustment_state=?)`. Two things do, in one repo-root scratch `.mjs` over the
46,800-row production fixture: (1) `EXPLAIN <sql>` (bytecode) — SQLite's
MIN/MAX optimization emits `Last`/`SeekLE`/`Prev` with a single `AggStep` and
**zero** `Next` opcodes, a full aggregate walk emits a `Next` loop; (2) median
`performance.now()` over 25 runs against a known-full-walk control
(`SELECT COUNT(*)` on the identical predicate) and a known-seek control (PK
lookup). Verified 2026-09-02 on PRF-010's `loadCandidateMaxDate`:
`MAX(market_date)` with an 18-value `security_id IN (…)` list plus the residual
`PRICE_SCOPE` filter runs 0.027 ms vs 5.30 ms for the same-predicate
`COUNT(*)` — the optimization **does** apply once per IN value.

**Proving a preview-layer diff's tests carry the regression (fastest variant).**
For `domain/imports/*` changes: `git show <commit>^:domain/imports/reconciliation.ts
> domain/imports/.review-old-reconciliation.ts` and the same for `review.ts`,
then `sed`/python-replace `./reconciliation.ts` -> `./.review-old-reconciliation.ts`
inside the old `review.ts` so the pair is self-consistent; copy the suite to
`tests/.review-scratch.test.ts` and repoint its two domain imports. BUG-013:
12 of 24 flipped to fail (the other 12 are true-negatives, new-module cap
tests, and source pins). ~30 seconds total.

**Mutation-testing source pins in one script.** Read the production file,
`String.replace` each mutation you care about, and re-run every pin regex over
the mutated text; also print `src.match(new RegExp(pin.source,"g")).length` per
pin. BUG-013: that count exposed a pin matching TWICE (both queries bind the
identical `[userId, MAX_... + 1]` array), so removing the `+ 1` from the FIRST
query was uncaught. `.replace` only hits the first occurrence, which is exactly
the mutation you want.

**Proving a preview-side SUPPRESSION set is not wider than the commit-side
SKIP set (the highest-value attack on any "don't warn on rows commit will
discard" fix).** Do not reason about it — build a shape matrix. In a
`tests/imp-004a.test.ts` scratch copy, loop over existing-row shapes
(`posted`/`reversed`/`superseded` x `csv_import`/`manual`/`system` x same
portfolio / other portfolio / other portfolio + a `kind:"portfolio"` mapping
decision), and for EACH: read `review.preview.resolvedTargets[rowId].portfolioId`,
build the suppression key yourself, test membership in the set the production
query returns, then actually run ready+commit and compare `skippedRows > 0`.
Assert `inSet === commitSkipped`. **Do not** use "warning absent" as the
suppression signal — it conflates suppression with "never economically matched"
(membership ids are portfolio-unique, so an other-portfolio fixture produces a
false divergence). Used 2026-09-02 on BUG-013's ruling 1: 11 shapes, all AGREE.

**End-to-end "advisory never blocks" proof.** `cp tests/imp-004a.test.ts
tests/.review-scratch.test.ts` and append a test: seed the existing DB record
with raw `database.exec`, stage two rows with `import_rows` INSERTs (NOT the
file's `stageRow` helper — it hardcodes `physical_row_number = 2`, so a second
call violates a unique index), then `pagePreview` -> `currentPreviewVersion` ->
`markImportReadyWithContext` -> `commitRepo.validate`/`commit` in a retry loop.
BUG-013 result: 2 warnings, `ready: true`, `committedRows: 2`, `skippedRows: 0`,
3 dividend rows persisted.

**Attacking a Sharesight sync classifier / counts claim (BRK-014 recipe, all
three probes ran in ~5 minutes).** `cp tests/brk-005.test.ts
tests/.review-scratchN.test.ts` — the file's `linkedFixture`, `fakeTrade`,
`fakePayout`, `fakeSharesightClient`, `commitBatch`, `migratedDatabase` give a
full sync→commit→re-sync round trip in ~20 lines. (1) *Does the reused path
really read STORED rows?* Sync, commit, then `UPDATE import_rows SET
normalized_fields_json = ?` on the staged row (an identical fetch reuses the
batch, so stored and fresh transform otherwise AGREE and the shipped test
cannot distinguish them). (2) *Is the classification non-vacuous?* Copy
`app/sharesight-sync-service.ts` to `app/.review-mut-…`, replace the value
comparison with `Boolean(existing…)`, repoint a scratch suite's import: only
tests that genuinely pin the value distinction flip. (3) *Which corrections
does it miss?* Re-sync the same Sharesight id with ONE field changed
(`frankingCreditsDecimal`, `transactionDate`, `exchangeRateDecimal`,
`brokerageDecimal`) and print `newRows`/`alreadyImportedRows` plus
`formatSyncResultMessage(result)`. `rm` every scratch file before
`format:check` (note `handoff.md`, if present in the worktree, is NOT
prettier-ignored — `.prettierignore` covers `.claude`, `dist`, `docs/
source-evidence/*` and friends, not the repo-root handoff. It has failed
`format:check` on its own before, but it was clean on 2026-09-03. Confirm with
`npx prettier --check handoff.md` before deciding; either way it is not a
worker finding).

**Reviewing a CSS-rule pin (`extractBlock` in `tests/brk-005b.test.ts`).** The
pin proves a rule EXISTS, never that it wins the cascade, and `extractBlock`'s
regex takes the FIRST `<selector> { … }` match — so run `grep -c "<class>"
app/globals.css` (expect 1) and, from the component, walk the element's ancestor
`className` chain and grep `globals.css` for any higher-specificity selector
(`.ancestor p`, `.ancestor .class`) declared later. As of 2026-09-03
`app/globals.css` has no `prefers-color-scheme`/`[data-theme]` blocks and each
token (`--muted`, …) is declared once, so "readable in both themes" claims in
CSS comments are unverifiable prose, not a defect.

**Why:** these were confirmed by running them during the EXP-003 review; the
full suite passing is weak evidence for UI-protocol changes (see
[[review-recurring-issues]]), so always pair it with reading the actual
request/response shapes.

**How to apply:** run format/lint/tsc plus the task's own suite and the suites of
every module the diff touches (`grep -rln <module-name> tests/` finds them),
before spending time on the full build.

**Attacking a chunked/finalize-gated reversal (BUG-016 recipe, five probes in
~10 minutes).** `cp tests/imp-006.test.ts tests/.review-scratch.test.ts` and
delete everything from the first `test("` onward — the file's `migratedDatabase`,
`buyRow`, `dividendRow`, `stageRow`, `seedManualRecord`, `commitBatch` helpers
give a full stage→commit→chunked-reverse round trip in ~30 lines
(`createOwnedImportReversalRepository(client, { chunkSize: 1 })`). Probes that
paid off: (1) print the `audit_events.metadata_json` for
`action LIKE 'import.reverse%'` after a NON-final chunk to see what the
metadata claims; (2) `advanceCalculationRuns({client, now}, {userId,
portfolioId, budget: 100000})` right after the reversal and dump
`calculation_runs` + `projection_publications` — this settles whether a queued
run's `ledger_high_water_start` is actionable (`''` sentinel and a real
transaction id BOTH complete, because `complete()` compares the stored token
against itself; the newest run wins and the others go
`failed/superseded_by_newer_run`); (3) a `SqlClient` wrapper whose `batch()`
throws once when `statements.some(s => s.sql.includes("DELETE FROM …"))` proves
resume-after-`atomic_failure` idempotency; (4) the same wrapper recording
`Math.max(largest, statements.length)` measures the atomic-unit budget (see
[[review-recurring-issues]] pattern 37); (5) pre-fix proof: `git show
<commit>^:db/repositories/import-reversal.ts >
db/repositories/.review-old-import-reversal.ts`, copy the suite, move ONLY
`createOwnedImportReversalRepository` to the old module's import, run with
`--test-name-pattern`. `rm` all three scratch files afterwards.

**Measuring a repository module's DECLARED per-invocation budgets at its own
ceiling (BUG-016 round 2 recipe).** Copy the first ~140 lines of
`tests/imp-003b.test.ts` (through `reversalInput`) into a scratch suite —
that prefix is exactly the fixture helpers with no `test(` blocks — add a
`seedDivPortfolio(db, i)` helper that raw-`exec`s a `portfolios` +
`portfolio_securities` + `dividend_manual_records` triple pointing at the
batch, then loop `for (const N of [1,6,25,26])` with a `SqlClient` wrapper
counting `queries` (all/get/run + every `batch()` statement), `statements`
(run + batch), and `largestAtomicUnit`. Seeding N portfolios directly is
cheap — 26 rows, no import pipeline needed — so the "impractical to
fixture" overflow case is one loop bound away. This is how
`maxQueriesPerInvocation = 56` was found broken at N>=7 (see
[[review-recurring-issues]] pattern 37b).

**Proving a post-action "advance the queued runs" gate is safe to tighten.**
`git show <commit>:app/<service>.ts | sed 's/<old condition>/<new
condition>/' > app/.review-gated-service.ts`, then a scratch suite whose
header repoints only that one import; drive the chunked action to
completion in a `for(;;)` loop printing per-invocation statement counts plus
`projection_publications` / `calculation_runs` status counts. Identical end
state at lower cost is the proof. Used 2026-09-03 on BUG-016 F1 (pattern 38).

**Note (2026-09-03): `tests/bug-010.test.ts:324` is a WALL-CLOCK assertion**
("bounded derive slice ... well under 20ms of app-side CPU"). It fails
under machine load — measured 25.8ms during a `npm test` run overlapping
scratch probes, and passes in isolation. Do not report it as a finding;
run `npm test` without competing work if you need a clean second pass.

**Proving a new repository FIELD's consumer carries the regression (swap the
SERVICE, not the repository).** When the fix spans repository (new returned
field) + service (new consumer), dump only the pre-fix SERVICE beside its
replacement: `git show <prev>:app/<service>.ts > app/.review-old-<service>.ts`,
`cp tests/<id>.test.ts tests/.review-prefix.test.ts`, `sed` that suite's ONE
import of the service to the old module, run with `--test-name-pattern`. The
repository still returns the new field, so assertions ON the field pass and
only the behavioural end-state assertions flip — which is exactly the
regression claim. Used 2026-09-03 on BUG-016 round 4: both new tests failed
with "portfolio-a still has 5 queued/running calculation runs". Re-measuring
the module's own budget table is one scratch test appended to
`tests/imp-003b.test.ts` looping N over `[0,1,25,26]` with its `countingClient`
(measured 50/25, 52/26, 76/50, 76/50 — matching the recorded table exactly).

**Whole-commit pre-fix tree in 3 commands (fastest for an app-layer diff whose
new suite spans loaders AND `.tsx` render tests).**
`mkdir -p "$TMPDIR/pre" && git archive <commit>^ | tar -x -C "$TMPDIR/pre" &&
ln -s <repo>/node_modules "$TMPDIR/pre/node_modules"`, copy the NEW test file
in, then run `node --experimental-strip-types --test tests/<id>.test.ts` from
that directory. Used 2026-09-03 on BUG-017: 11 fail / 3 pass, matching the
worker's claim, and the 3 passing are the negative "no notice rendered" guards
(a guard can never fail pre-fix -- see [[review-recurring-issues]] 36d). The
SAME tree also re-measures the census in one command
(`node --experimental-strip-types --test tests/prf-002.test.ts | grep -E
"holdings --|gains --"`), which is the honest before/after for pattern 10.

**Attacking a "newer than the published run" projection-staleness predicate
(BUG-017 round 2 recipe, all probes in ~3 minutes).** `head -142
tests/bug-017.test.ts > tests/.review-scratch.test.ts` — that prefix is
exactly the fixture helpers (`migratedDatabase`, `insertTransaction`,
`queueLedgerMutationRun`, `publicationCount`) with no `test(` blocks. Seed a
buy AND a sell (see [[review-recurring-issues]] 41c), advance once to get a
publication, then drive each ordering and print
`loadOwnedHoldings(...).projectionPending` beside
`loadOwnedCapitalGains(...).projectionPending`. To force an exact
`created_at` tie, pass the published run's own `created_at` as the second
`queueLedgerMutationRun`'s `now`. A repo-root scratch `.mjs` that `exec`s
`drizzle/*.sql` into `:memory:` and `prepare()`s the query with literals
instead of `?` settles both "does `r.rowid` resolve through the join alias"
and the EXPLAIN plan with zero rows.

**Getting the PRE-fix DEPTH table when the fixture changed too (PRF-011
recipe).** The whole-commit pre-fix tree (`git archive <commit>^ | tar -x -C
"$TMPDIR/pre"` + `node_modules` symlink + copy the NEW `tests/prf-002.test.ts`
in) gives the honest before/after for a diff that also extends
`productionScaleFixture` — but the depth test ASSERTS inside its per-page loop,
so it aborts at the first page over `DEPTH_CEILING` and you never see the page
you care about. Rewrite the ceilings to 99 in the pre-fix COPY only
(`python3` regex over the `DEPTH_CEILING` block, or `sed`), then
`--test-name-pattern "SEQUENTIAL DEPTH"`. Used 2026-09-03: with PRF-011's own
disposal fixture the pre-fix depths were `/gains` **8**, `/holdings` **8**,
`/holdings/:holdingId` **9** (post-fix 5 / 6 / 7), which is what proves a
raised ceiling is a real measurement rather than a loosening. Per-page
statements the same way: `--test-name-pattern "per-page census"`.
Note the census stage classifier buckets the gains allocations query under
`portfolio_securities`, not `lot_allocations`, so read the bucket TOTAL, not
the table names.

**Two fixture prefixes that make import-preview probes ~10 lines each.**
(1) `head -131 tests/bug-014.test.ts > tests/.review-scratch.test.ts` — the
prefix is exactly `PORTFOLIOS`/`SECURITY_CANDIDATES`/`dividendRow`/
`candidate`/`OVER_SCALE_DECIMAL` with no `test(` blocks, enough to attack
`createImportReconciliationPreview` field by field. (2) For the DB-level
stage→ready→commit round trip, slice `tests/imp-004a.test.ts` up to its first
`\ntest(` (python `src.index("\ntest(")`) — that gives `migratedDatabase`,
`stageRow`, `pagePreview`, `currentPreviewVersion` and every import, so a
probe only needs `stageRow` + `markImportReadyWithContext` +
`commitRepo.validate/commit`. Used 2026-09-03 on BUG-014 to prove a warned
row reaches commit and `validate()` throws there (see
[[review-recurring-issues]] 46/46b). `rm` both before `format:check`.

**Proving a `client.batch()` really rolls back MID-batch (the only honest
atomicity probe).** A `SqlClient` wrapper that throws when
`statements.some(s => matchSql(s.sql))` rejects the batch BEFORE any statement
runs, so it proves graceful-failure handling but says nothing about rollback —
shipped regression tests here are usually that shape. To fail the Nth statement
INSIDE the real transaction, install a SQLite trigger on the target table in a
scratch copy of the suite:
`db.exec("CREATE TRIGGER probe BEFORE UPDATE OF <col> ON <table> BEGIN SELECT
RAISE(ABORT,'probe'); END;")`, run the service call, assert the earlier
statements' rows are ABSENT, then `DROP TRIGGER` and retry through the same
entry point. Used 2026-09-03 on BUG-019 (`tests/exp-004.test.ts` prefix:
`migratedDatabase`, `seedFreshAccount`, `buildBundle`, `ctxFor` are all the
fixture needed; probes A-G took ~10 minutes). Companion probes worth repeating:
fail the statement AFTER the batch (assert the retry ADOPTS rather than
duplicating), fail every attempt (count the retry-loop iterations and assert
nothing is written plus the typed `ok:false`), fail only attempt 1 (shows which
code/name the row lands under), and pre-seed a genuine unique-key collision to
confirm the pre-existing fallback still works. Note
`createSqliteSqlClient.batch` returns `changes: 0` for every statement, so no
test here can assert a batched statement's affected-row count.

**Byte-identical old-vs-new loader proof with ZERO scratch files in the shared
worktree (PRF-008 recipe).** When other agents share the checkout (never
`git stash`/`git checkout` there), build BOTH trees under `$TMPDIR`:
`git archive <commit>^ | tar -x -C "$TMPDIR/pre"`, same for `<commit>` into
`$TMPDIR/post`, `ln -s <repo>/node_modules` into each. Then
`head -<N> tests/<suite>.test.ts > $TMPDIR/prefix.ts` (the fixture-helper
prefix, up to the first `\ntest(`; `tests/brk-012c.test.ts` = 235 lines), append
your own `test(...)` blocks that `console.log` a normalized
`JSON.stringify(result)`, write the concatenation into BOTH trees' `tests/`,
run each with `node --experimental-strip-types --test`, and `diff` the captured
lines. Used 2026-09-03 to prove PRF-008's enforce path (cold-fetch,
not-configured, fresh-cache shapes) is byte-identical across the commit.
The same two trees give the pre-fix failure count (copy the NEW test files into
`$TMPDIR/pre/tests/`) and the pre/post per-page census in one more command —
note the census `stages=[...]` ORDER is nondeterministic under `Promise.all`,
so diff only the `calls=`/`statements=` numbers.

**Attacking a value-history "unresolvable mark" / negative-cache diff (BUG-012
recipe, three probes in ~10 minutes, zero files in the shared worktree).** Build
`$TMPDIR/post` and `$TMPDIR/pre` with `git archive <commit>[^] | tar -x` plus a
`node_modules` symlink. Probe A (does path X clear the mark?): concatenate
`tests/bug-012.test.ts` lines 1-86 (imports + `migratedDatabase` + `weekdays`),
247-275 (`unresolvedRows`/`storedDates`) and 411-461 (`GAP_INDEX` +
`priceGapFixture`) into one scratch suite — that is the whole fixture. Read once
to create the mark, call the writer under test directly
(`upsertSharesightPriceObservations` takes a 8-field candidate literal), print
`unresolvedRows(db)`, then `DELETE FROM portfolio_value_history_unresolvable`
and re-read to prove the date WAS resolvable and only the stale mark hid it.
Probe B (FX): same fixture with a USD `portfolio_securities.source_currency_code`
and `fx_rate_observations` rows for every date but the gap. Probe C (statement
budget): `head -198 tests/mkt-003b.test.ts` is exactly the fixture helpers
(`createMigratedDatabase`, `seedMarketData`, `priceObservation`, `providerFor`,
`serviceFor`, `priceJobInput`); add N portfolios each holding `security-a`, then
`service.request(priceJobInput(...))` + `processPending()` and print the summary
plus `SELECT status,last_error_kind FROM market_data_refresh_jobs` — a rejected
chunk shows `jobsCompleted:0, observationsWritten:0` with the job still
`running`. Run the same file in the `pre` tree to prove the regression.

**Proving a preview-side guard's value is (or is not) PERSISTED at commit
(BUG-014 round-2 recipe, ~5 minutes).** Build `$TMPDIR/post` and
`$TMPDIR/pre` with `git archive <commit>[^] | tar -x` + a `node_modules`
symlink. Slice `tests/imp-004a.test.ts` up to its first `\ntest(` (python
`src.index("\ntest(")`) AND append its later `dividendNormalizedRow` helper
(regex `function dividendNormalizedRow[\s\S]*?\n\}\n`) — that pair is the
whole fixture. Then one `commitProbe(label, totalCash, seedCandidate)` that
raw-INSERTs the staged row with `sharesOwned/costPerShare = null` and
`totalCashDecimal = <bad value>`, runs `pagePreview` →
`markImportReadyWithContext` → `commitRepo.commit`, and prints the preview
issue codes, the commit result AND
`SELECT total_cash_decimal FROM dividend_manual_records WHERE
import_batch_id IS NOT NULL`. Run the identical file in BOTH trees: the pre
tree shows `COMMIT THREW`, the post tree shows `ok:true` with the malformed
value in the table. Seeding a `dividend_manual_records` candidate on the same
`(portfolio_security_id, payment_date)` is what makes the reconciliation
compare run at all — without it neither tree throws, which is why the
"nothing is persisted" claim looks true in a naive probe.

**Mirror-vs-production SQL parity in one command (PRF-009 round-3 recipe).**
`tests/imp-004a.test.ts`'s `pagePreview` and `tests/div-016c.test.ts`'s own
loader re-implement `app/import-actions.ts`'s private `loadReview` SQL
(pattern 28). To prove byte-identity rather than eyeball it, extract both
sides with the same regex and compare in one `node -e`:
`const re=/`SELECT portfolio_id, source_reference FROM (dividend_manual_records|transactions)[\s\S]*?`/g`
then `[...src.matchAll(re)].map(m=>m[0])` for each file and
`assert p[i]===t[i]` pairwise. Also `grep -rln "<distinctive FROM clause>"
tests/ app/ db/ domain/` first — there is usually MORE than one mirror
(imp-004a, div-016c), and a cap removal must land in every one of them.

**Proving a new write-boundary decimal bound is EXACTLY the read path's
(BUG-014 round-3 recipe, ~2 minutes).** Two scratch tests in a
`git archive <commit> | tar -x -C "$TMPDIR/post"` tree with a `node_modules`
symlink. (1) Parity fuzz: import the insert builder and `parseDecimal`, loop
`intDigits` 1..42 × scale {0,1,23,24,25,40} for EACH bounded column (per-share
columns need `sharesDecimal`+`dividendPerShareDecimal` present, totals columns
need `totalCashDecimal`), and assert `builder.ok === !parseDecimalThrows` — a
single divergence in either direction is the finding. (2) Mutation: `cp -R`
the tree, delete one clause of the new predicate, and re-run the diff's own
suites; if they stay green that half of the bound is uncovered. For the
preview half, `head -131 tests/bug-014.test.ts` is the fixture prefix
(`PORTFOLIOS`/`SECURITY_CANDIDATES`/`dividendRow`/`candidate`) — mutate
`row.normalized` in place to reach fields the helper does not expose
(`totalFrankingDecimal`, `frankingPerShare`) and print `preview.issues.map(i
=> i.code)`. To reach the OWNER-TYPED writer instead of the import one, slice
`tests/div-016a.test.ts` up to its first `\ntest(` (gives `fixture`,
`contextFor`, `saveDividendEntryWithContext`, `loadOwnedDividendHistory`) and
call the save action, then `loadOwnedDividendHistory(client, "a", "pa", new
Date(...))` — note the 4th arg is a bare `Date`, not an options object.

**Attacking a bounded invalidation builder (BUG-012 round-2 recipe, four
probes in ~10 minutes, zero files in the shared worktree).** Build
`$TMPDIR/post` + `$TMPDIR/pre` as usual. The fixture prefix for
`tests/bug-012.test.ts` (as of `d034e79`) is lines 1-88 (imports +
`migratedDatabase` + `weekdays` + `NOW`), 255-286 (`unresolvedRows`/
`storedDates`), 428-475 (`GAP_INDEX` + `priceGapFixture`), 752-775
(`sharesightCandidateFor`), and 866-919 (`FX_GAP_INDEX` +
`fxOnlyGapFixture`); note `priceGapFixture` already uses `ps-1`/`ps-2`, so a
loop seeding extra memberships must not reuse those ids. Probes that paid
off: (A) seed N extra portfolios holding the same security + a
`portfolio_value_history_unresolvable` row each, call
`upsertSharesightPriceObservations` once, print which marks/stored rows
survive — `LIMIT 20` truncation is visible immediately; (B) wrap
`createSqliteSqlClient` with `batch: async (s) => {max=Math.max(max,s.length)
…}` to measure the real worst-case batch (90 at 25 candidates); (C) run the
identical write 3× and print the survivors each time — proves the truncation
is deterministic, not eventually-consistent; (D) seed a SECOND owner's 25
portfolios holding the security BEFORE the writer's own membership row to
show the cross-owner budget starving the writer. For the FX half, add an
unpriced AUD security to `fxOnlyGapFixture` to build a date that is both
price- and FX-gapped, then `DELETE FROM portfolio_value_history_unresolvable`
as the control read.

**Cross-commit byte-identical parity, the cheap way (PRF-013 recipe,
2026-09-03).** When a diff claims "output is byte-identical" for a refactored
loader, do NOT settle for the diff's own before/after test (it runs one code
path twice). Build `$TMPDIR/<task>/pre` and `/post` from
`git archive <commit>^ | tar -x` / `git archive <commit> | tar -x` with a
`node_modules` symlink, then drop ONE scratch test file into the POST tree
that imports the OLD function by absolute path alongside the new one:

```ts
import { loadX as postX } from "../app/x.ts";
import { loadX as preX } from "/tmp/claude-501/<task>/pre/app/x.ts";
```

Both modules take the same `SqlClient`, so one `DatabaseSync` fixture feeds
both and `assert.equal(JSON.stringify(after), JSON.stringify(before))` is a
real cross-call-graph comparison. `--experimental-strip-types` does no type
checking, so a structural mismatch between the two trees' types is harmless.
Build the fixture RICH (supersession lineage, an excluded override, a
totals-mode imported record with a franking override, an FY override, a
multi-transaction shares-at-date derivation, a foreign-currency security) and
then `console.log` the resulting keys to prove the comparison was not over
empty objects. Delete the scratch test before running `tsc`/`eslint`/`npm
test` in that tree. Two SQLite gotchas hit while writing such fixtures:
`dividend_events` is UNIQUE on `(security_id, provider_id, ex_date)`, and
`portfolio_securities_resolution_check` forces `security_id IS NULL` to pair
with `status='unresolved'`.

**Fuzzing a per-portfolio invalidation SET against an independently computed
reference (BUG-012 round-4 recipe, whole attack in ~5 minutes).** In a
`git archive <commit> | tar -x -C "$TMPDIR/post"` tree with a `node_modules`
symlink, build the scratch suite from `tests/bug-012.test.ts` by
concatenating lines 26-90 (imports + `migratedDatabase` + `weekdays` + `NOW`),
276-288 (`storedDates`), 755-783 (`sharesightCandidateFor`), 1087-1196
(`sharesightInvalidationFixture` — note its `holdingsByPortfolioId` option,
plus `markCount`/`storedCount`/`recordingClient`) and 1426-1434
(`markedDates`). Then: snapshot `SELECT portfolio_id, value_date` from BOTH
`portfolio_value_history` and `portfolio_value_history_unresolvable` into a
`Set` before the write, run `upsertSharesightPriceObservations`, snapshot
again, and `assert.deepEqual(before \ after, union of per-security targets)`
computed in the test from the fixture's own holdings map — that is a real
cross-implementation reference, unlike the diff's own fixed-date probes. Loop
it over ~30 seeded-random trials (a tiny `mulberry32`) with duplicate dates
per security and securities nobody holds. The same scratch file measures the
budget (`recordingClient().batchSizes` and
`Math.max(...statements.map(s => s.params.length))`) and the >200-portfolio
fail-closed path (`SELECT COUNT(*) FROM price_observations` after the throw).
Note `npm run lint` in the SHARED worktree currently reports ~49 errors from
an untracked `ds-bundle/` directory — lint the `$TMPDIR` archive tree instead
(clean: 0 errors, only the known `tests/mkt-011a.test.ts:168` warning plus two
`worker-configuration.d.ts` unused-disable warnings).

**Attacking an "every writer now shares one bound" decimal diff (BUG-022
recipe, five probes in ~15 minutes, zero files in the shared worktree).**
Build `$TMPDIR/<task>/pre` and `/post` with `git archive <commit>[^] | tar
-x` + a `node_modules` symlink. (1) Writer census: `grep -rn "INTO
<table>\|UPDATE <table>" app db domain worker --include="*.ts"` plus a
grep for the Drizzle schema symbol (`dividendManualRecords`) — that pair
found all three INSERT sites and proved every other statement writes only
a link column. (2) Parity fuzz: a 25-line scratch test importing the
EXPORTED predicate and `parseDecimal`, looping intDigits 1..70 x scale
{0,1,23,24,25,40,63,64,65}, asserting `bound === parses`. (3) Both halves
of the bound: `cp -R` the post tree three times and delete one clause per
copy (scale, digits, the FX digit clause), re-running the new suite in
each — the fail counts (5/3/1) are the coverage proof. (4) Preview-to-
commit consistency: full-file copy of `tests/imp-004a.test.ts` + appended
probes (the `\ntest(` prefix slice does NOT work for `tests/exp-004.test.ts`
— its first `test(` is far above the fixture helpers, so copy the WHOLE
file and append instead) driving `pagePreview` -> `markImportReadyWithContext`
-> `commitRepo.commit` for a bad AND a good value, printing issue codes,
the commit result and the stored column. (5) Restore fail-closed: append a
probe to a full copy of `tests/exp-004.test.ts` that mutates one
`wasImported === false` record of `buildBundle()`'s output and calls
`commitPortfolioBundleDividendsPart` — prints `{ok:false,status:409}` and
`import_batches.status = 'failed'`.

**Re-measuring the census/depth in a PRE tree when the diff added a new
MODULE (PRF-012 recipe, 2026-09-03).** The usual "copy the new
`tests/prf-002.test.ts` into `$TMPDIR/pre`" trick fails outright if that suite
imports a module the pre-fix tree does not have (here
`../app/owned-portfolio-context.ts`) — every test in the file errors at
import, so you get `pass 0 / fail 1` and no numbers. Fix: also `cp
post/app/<new-module>.ts pre/app/`. The pre-fix loaders ignore it (the new
optional trailing parameter is simply unused), so the suite runs against
genuinely pre-fix code. Then `--test-name-pattern "per-page census"` and, for
depths, `sed -i '' -E 's/^(  "\/portfolio\/:id\/<page>[^"]*"): [0-9]+,/\1: 99,/'
tests/prf-002.test.ts` in the PRE copy only before
`--test-name-pattern "SEQUENTIAL DEPTH"` (the depth test asserts inside its
per-page loop and aborts at the first over-ceiling page). Fixture gotchas when
extending `productionScaleFixture` in a scratch copy: `price_observations`
requires a non-NULL `mapping_id` (insert a `security_provider_mappings` row
first) and `adjustment_state IN ('raw','split_adjusted','total_return_adjusted')`,
and any new `status='held'` `portfolio_securities` row needs a matching
`holding_projections` row or `loadOwnedHoldings` throws
`invalid_projection_count`. The full prefix slice for that suite is
`head -1130 tests/prf-002.test.ts` (through `PAGES`).

**Getting an assertion-level pre-fix count when the new suite imports a
classifier the fix introduced (BUG-021 recipe, 2026-09-03).** `git archive
<commit>^ | tar -x -C "$TMPDIR/<task>/pre"` + `node_modules` symlink + the new
test file fails at import (`does not provide an export named X`). Append the
new PURE helper verbatim to the pre tree's own module and add it to the
package `index.ts` re-export block — a pure classifier changes no pre-fix
behaviour, so the suite then runs against genuinely pre-fix derivation code.
BUG-021: 6 fail / 4 pass, the 4 being the classifier's own tests (guards by
construction, pattern 48b). The same pre/post pair settles "what did the bad
value do BEFORE?" in one probe file — pre threw
`Invalid decimal input: supported boundary exceeded` out of
`computeCashGrossOrTotals`, post returned a fabricated `"0"` (pattern 57).

**`$TMPDIR` scratch trees COLLIDE with other agents (2026-09-04).** `$TMPDIR`
is `/tmp/claude-501`, shared by every agent/session for this user, so
`mkdir -p $TMPDIR/post && git archive <c> | tar -x -C $TMPDIR/post` silently
inherits another agent's leftover untracked files. Symptom: `npx prettier
--check .` in the "clean" tree reports `tests/.review-*.test.ts` /
`tests/zz-probe.test.ts` (files `git ls-tree` proves are not tracked at that
commit) — and `npm test`'s `tests/*.test.ts` glob would run them. **How to
apply:** extract into the SESSION scratchpad
(`/private/tmp/claude-501/<project-slug>/<session-id>/scratchpad/<name>`) or
`rm -rf` the directory first; re-run `format:check`/`lint`/`npm test` there,
never in a reused `$TMPDIR/<generic-name>` tree. Verified good afterwards on
BUG-021 round 2: prettier clean, eslint 1 warning (the known `mkt-011a`
`_request`), `tsc --noEmit` clean, `npm test` 2989 tests / 0 fail / 10 skipped.
