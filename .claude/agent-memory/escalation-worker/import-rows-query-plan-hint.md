---
name: import-rows-query-plan-hint
description: An import_rows JOIN transactions query plans to an OWNER-wide drive by default; the `+user_id` unary-plus hint restores the batch_id seek.
metadata:
  type: project
---

`import_rows` has no `(user_id, batch_id)` index -- only `import_rows_batch_physical_row_unique (batch_id, physical_row_number)` and a `(user_id, normalized_fingerprint)` index. So a batch-scoped `import_rows JOIN transactions ... WHERE r.user_id = ? AND r.batch_id = ?` plans to an OWNER-wide drive (measured: `SEARCH source USING transactions_owner_portfolio_idempotency_unique (user_id=?)`, or `SEARCH r USING import_rows_user_normalized_fingerprint_idx (user_id=?)` -- both read every row the owner has, to find one batch's).

Writing the ownership predicate as `+source_row.user_id = ?` (SQLite's unary-plus no-index hint, same tool as PRF-009 fold-in (a)) restores the plan the established siblings `pendingTargets`/`impactsFor` already get:

    SEARCH source_row USING INDEX import_rows_batch_physical_row_unique (batch_id=?)
    SEARCH source USING INDEX transactions_id_user_unique (id=? AND user_id=?)

**Why:** PRF-009's lesson is usually cited as "restore the `user_id` seek", but the goal is the NARROWEST scope, and for a batch-scoped read that is `batch_id`. Ownership is not weakened -- `user_id = ?` still filters, and the `transactions` side is seeked on `(id, user_id)`. The commit side's PRF-007 query still has the un-hinted owner-wide plan, so this is a live divergence, not settled convention.

**How to apply:** always run EXPLAIN QUERY PLAN on a new `import_rows` join before claiming it is "index-seeking and bounded", and state in the comment that a `LIMIT` bounds rows RETURNED, not rows read. See [[chunked-route-gates]].
