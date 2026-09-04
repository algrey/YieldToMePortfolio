---
name: new-owned-table-checklist
description: Every new user-owned table must be registered in account-lifecycle.ts (OWNED_TABLES + PURGE_TABLES_IN_FK_ORDER) and get account_purge_lock_* triggers hand-appended in its migration, or a real test breaks/behavior regresses.
metadata:
  type: project
---

Adding a new `user_id`-scoped table to `db/schema.ts` (e.g. BRK-022's
`sharesight_pending_payouts`) requires more than the table + migration
itself, even when the delegated task text doesn't mention it:

1. **`db/repositories/account-lifecycle.ts`'s `OWNED_TABLES` array** — add
   the table name here. `tableNames()` throws
   `unclassified_export_table:<name>` for any real table not present in
   `ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS` (auto-derived from
   `OWNED_TABLES`), and `tests/ops-003a.test.ts`'s "schema-derived export
   classification covers every table" test runs the full migrated schema
   through this — so skipping this step is a real test failure, not just a
   documentation gap.
2. **Same file's `PURGE_TABLES_IN_FK_ORDER` array** — add the table,
   positioned so it precedes every table it FKs to (children before
   parents). A table with a composite FK to BOTH `portfolios` AND
   `portfolio_securities` must precede `portfolio_securities` specifically,
   not merely `portfolios` (unlike `sharesight_sync_state`, which only
   references `portfolios`).
3. **`account_purge_lock_*` INSERT/UPDATE/DELETE triggers**, hand-appended
   in the SAME migration file that creates the table (drizzle-kit's schema
   model has no concept of these triggers and never generates them). Copy
   the exact three-trigger SQL block from a recent precedent (e.g.
   `drizzle/0045_brk_012c_sharesight_delayed_prices.sql`) and rename.
4. **`tests/db-schema.test.ts`'s `tableNames(database)` assertion list** —
   add the new table name in alphabetical order, or the "generated
   migration applies cleanly" test fails.

None of this is mentioned by name in every task brief that adds a table —
it only becomes visible by noticing the `unclassified_export_table` throw
path and the precedent comments on sibling Sharesight/dividend tables. Do
this proactively for any new owned table; it is small, mechanical, and
required for account deletion/export to keep working, not optional scope
creep.
