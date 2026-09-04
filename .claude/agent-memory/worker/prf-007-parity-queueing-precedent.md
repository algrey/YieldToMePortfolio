---
name: prf-007-parity-queueing-precedent
description: When a TASKS.md entry says "mirror X's queueing/behavior for parity" even though X's own retraction says nothing consumes the data -- implement the mirror anyway; parity is the actual acceptance criterion.
metadata:
  type: project
---

PRF-007 (import-commit.ts) queues a `projection` `calculation_runs` row for a
dividend-only commit, and its own review B3 retraction states plainly that
nothing derived actually reads `dividend_manual_records` content (`/income`
reads dividends live; neither the projections repository nor
value-history/shares-held consume the table) -- so that queued run cannot
change any rendered figure. PRF-007 queued it anyway, "on its own merits,"
for parity between commit kinds.

BUG-016 asked to close the identical asymmetry on the reversal side (a
dividend-only/dividend-containing reversal queued no rebuild while commit
did), with instructions to first check whether anything downstream needs it
and, if not, "do NOT add a pointless rebuild" -- but ALSO to "mirror exactly
what PRF-007 queues and why." These read as contradictory in isolation, but
resolve cleanly: PRF-007 already established that this queueing is a
deliberate PARITY decision, not a data-driven necessity, and the task's own
acceptance criterion ("a dividend-only batch reversal queues the same
rebuild PRF-007's commit queues") makes the mirror the actual deliverable.
The right move was to implement the mirror (with a code comment explaining
the parity-not-necessity rationale), not to skip it citing "nothing needs
it."

**How to apply:** when a task cites a prior task's retraction/finding as
context and then asks you to mirror that prior task's behavior anyway, check
the acceptance criteria before treating the retraction as a reason to skip
work -- the retraction narrows CAUSATION claims, not necessarily the
deliverable itself. See [[import-commit-polymorphic-fk]] for the underlying
`import_rows.commit_transaction_id` polymorphism this queueing logic has to
navigate on both the commit and reversal sides.
