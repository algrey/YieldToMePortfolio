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
- `npx tsc --noEmit` — clean, no `npm run typecheck` script exists.
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

**Why:** these were confirmed by running them during the EXP-003 review; the
full suite passing is weak evidence for UI-protocol changes (see
[[review-recurring-issues]]), so always pair it with reading the actual
request/response shapes.

**How to apply:** run format/lint/tsc plus the task's own suite and the suites of
every module the diff touches (`grep -rln <module-name> tests/` finds them),
before spending time on the full build.
