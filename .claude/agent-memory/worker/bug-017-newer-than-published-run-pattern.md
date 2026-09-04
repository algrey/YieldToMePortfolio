---
name: bug-017-newer-than-published-run-pattern
description: A "latest matching-status row" scalar subquery must compare against the referenced/published row, not just filter by status, or a stale terminal state masks a later success forever.
metadata:
  type: project
---

BUG-017 round 2 (review B1, 2026-09-03): `app/owned-holdings.ts` and
`app/owned-capital-gains.ts` each had a correlated scalar subquery
(`PENDING_RUN_STATUS_SUBQUERY`) picking the newest `calculation_runs` row
matching `status IN ('queued','running','failed')` (excluding
`superseded_by_newer_run`) for a portfolio, to report a "projection may be
stale" flag. The candidate set filtered only by the CANDIDATE's own
status/failure_category -- it never compared the candidate against the
run the CURRENT publication actually references. Consequence: once a
terminally `failed` run was superseded by a later run that went on to
complete and publish, the failed run was still the newest row with a
matching status (the successful run is `completed`, not in the IN-list),
so the subquery kept returning `failed` forever on a fully current
portfolio.

Fix: add `AND (cr.created_at > r.created_at OR (cr.created_at = r.created_at
AND cr.rowid > r.rowid))` to the candidate predicate, where `r` is the
publication's own joined run (already in scope in `PUBLICATION_SQL`) --
i.e. "newer than the run this row's publication references", not merely
"any non-superseded candidate-status run". Uses the same BUG-020
`(created_at, rowid)` total order tie-break already established in
`db/repositories/calculation-runs.ts`.

**General pattern to watch for**: any "find the latest/relevant row of
kind X" correlated subquery feeding a staleness/pending flag needs to be
scoped relative to whatever row is CURRENTLY being served, not just
filtered by the candidate's own properties. A candidate can be "the
newest row matching a status filter" while still being OLDER than the
thing that superseded it if the filter's IN-list excludes the
superseding row's own (successful) status.

Related: [[calculation-runs-tiebreak-flakiness]] (the `(created_at,
rowid)` total order this reuses), [[hist-001-no-batch-invariant]] (a
different pinned invariant in an adjacent module).
