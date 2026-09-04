---
name: calculation-runs-tiebreak-flakiness
description: supersedeStaleQueuedRuns/nextClaimable/hasNewerRun tie-break on created_at -- FIXED in BUG-020 to use rowid instead of UUID id; history kept for context if similar millisecond-tie bugs recur elsewhere.
metadata:
  type: project
---

`db/repositories/calculation-runs.ts`'s `supersedeStaleQueuedRuns`,
`nextClaimable`, and `hasNewerRun` decide "is this calculation_runs row
superseded by a newer one" on a `created_at` (millisecond-resolution ISO
string) tie. Originally the fallback was `id` (a `randomUUID()`, not
chronological), which could treat an OLDER row as "newer" on a tie -- see
`tests/imp-003b.test.ts`'s BUG-016 fold-in note about a ~25% flake rate
from tight commit -> reverse -> advance sequences on one portfolio.

**Status: fixed** (`BUG-020`, commit `98ac6ad`; a review round on
`2026-09-03` corrected a false "no delete path" claim baked into the fix's
own doc/comment text -- see [[calculation-runs-no-delete-path-false-claim]]).
The tie-break is now `(created_at, rowid)`: SQLite's implicit
`rowid` on this TEXT-PK, non-`WITHOUT ROWID` table is insertion order among
currently-existing rows, including across an account purge's deletes (a
delete only lowers the next assigned rowid, never disturbs surviving
rows' relative order). No migration, no new column. Regression coverage:
`tests/calc-003.test.ts`'s "BUG-016 fold-in regression" test (ids chosen so
insertion order contradicts lexicographic id order -- this is what would
have caught the old bug) plus a "BUG-020 guard" test for the complementary
order (insertion order agrees with id order -- passes under both old and
new tie-break, so it's a guard, not a regression).

**How to apply:** if a new test chains commit/reverse/advance calls on one
portfolio and sees an unexpected `failed`/`superseded_by_newer_run` run,
the tie-break itself is no longer the suspect -- look at your own
atomic-batch/ordering logic instead. Do not reintroduce a `setTimeout`
workaround for this specific race; it's no longer needed.
