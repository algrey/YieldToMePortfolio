---
name: brk-016-narrowing-and-overclaim-pattern
description: TS narrowing gotcha for a nullable executor-captured callback, and the shape of doc/comment overclaims a review round catches after a concurrency/perf fix.
metadata:
  type: feedback
---

Two reusable lessons from the BRK-016 correction round (`tests/brk-003.test.ts`,
`worker/sharesight-config.ts`, `app/sharesight-sync-service.ts`,
`docs/ARCHITECTURE.md`):

**Narrowing gotcha:** a variable typed `T | null = null`, assigned only
inside a `new Promise((resolve) => { x = resolve })` executor, does NOT
narrow to `T` after `assert.ok(x)` — TS still sees the outer `let` binding's
declared type at the assignment site inside the closure, so a later `x!(...)`
where `x` was narrowed to `never` errors as "not callable". Fix: declare as
`T | undefined` with no initializer (`let x: T | undefined;`) instead of
`T | null = null`; then `assert.ok(x)` narrows correctly and no `!` is
needed. Always run `npx tsc --noEmit` after adding this executor-capture
pattern in a test — it silently passes `node --test` (JS has no static
types) while failing typecheck.

**Overclaim shape to watch for in a Reviewer FAIL on a concurrency/perf
fix:** comments and ARCHITECTURE.md prose written alongside a `Promise.all`
memoization/parallelization change tend to overstate uniformity —
"every test injects X" (false: some real-shaped tests skip X and are only
safe via ordering + reset-in-finally), "N tests fail pre-fix" (undercounts
by missing tests whose failure mode is a missing test-only reset seam, not
the semantic assertion), and "failure handling is UNCHANGED" (true only for
the typed-result branch, not for a hypothetical rejection race the new
`Promise.all` newly surfaces). None of these needed a code redesign — all
three were comment/doc corrections plus labeling already-passing tests as
`(guard)` in their titles, matching the codebase's existing guard-test
naming convention (see `tests/brk-005.test.ts`'s guard-test comments).
