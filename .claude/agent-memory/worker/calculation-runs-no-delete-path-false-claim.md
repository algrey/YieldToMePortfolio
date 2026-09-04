---
name: calculation-runs-no-delete-path-false-claim
description: BUG-020 review FAIL -- a worker wrote "no code path deletes calculation_runs" / "no delete path" into three sites without checking account-lifecycle.ts's purge machinery, which does delete that table's rows.
metadata:
  type: feedback
---

When documenting an "immutable" or "never deleted" property of a table for a
tie-break/ordering guarantee, grep `db/repositories/account-lifecycle.ts`'s
`OWNED_TABLES`/`PURGE_TABLES_IN_FK_ORDER` lists and the purge-lock triggers in
`drizzle/*.sql` (`account_purge_lock_<table>_delete`) BEFORE asserting a table
has no delete path. `calculation_runs` is user-owned data, so the GDPR-style
account purge (`account-lifecycle.ts`) deletes it via a rowid-batched
`DELETE FROM "<table>" WHERE rowid IN (...)`, and a purge-lock DELETE trigger
exists for it (`drizzle/0028_fancy_logan.sql`). This will be true for most
`OWNED_TABLES` entries -- assume a delete path exists for any owner-scoped
table unless you've checked both lists and the trigger set.

**Why:** commit `98ac6ad` added a `rowid`-based tie-break for
`calculation_runs` ([[calculation-runs-tiebreak-flakiness]]) and justified it
in three places (`docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md`,
`db/repositories/calculation-runs.ts`'s `hasNewerRun` comment) with "no code
path deletes a `calculation_runs` row" / "rowid table with no delete path".
Reviewer caught it as a BLOCKING documentation FAIL in the very next round
(`BUG-020`, 2026-09-03): false on all three counts. The underlying tie-break
logic was still correct -- rowid ordering survives a delete because SQLite
only ever assigns `max(rowid) + 1` from the rows that currently exist, so a
delete can lower the next assigned rowid but never disturbs the relative
order of surviving rows, and this table's ordering comparisons are always
scoped to one user/portfolio/pipeline anyway. The fix was purely textual: no
code change was needed, just replacing the false universal claim with the
narrower true guarantee (and noting that a future rebuild-style migration of
the table, like `drizzle/0017_bouncy_morgan_stark.sql`/
`drizzle/0040_bright_blindfold.sql`, must keep `ORDER BY rowid` in its copy
step to preserve the property).

**How to apply:** before writing "rows are never deleted from this table" or
similar into a doc/comment, check (1) `OWNED_TABLES` and
`PURGE_TABLES_IN_FK_ORDER` in `db/repositories/account-lifecycle.ts`, and (2)
whether a `drizzle/*.sql` migration defines an `account_purge_lock_<table>_*`
trigger set for it. If either lists the table, the true guarantee is about
relative *ordering* surviving deletes/rebuilds, not about deletes never
happening.
