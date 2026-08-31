# Memory index

- [Recurring review issues](review-recurring-issues.md) — envelope mismatches, source-regex tests, alias-blind EXPLAIN guards, OR-window index degradation, D1 100-param cap, orphan promises, missing ARCHITECTURE.md entries, route-redirect blast radius.
- [Verification commands](review-verification-commands.md) — what to run, schema-only EXPLAIN probes, old-vs-new loader equivalence recipes, depth census, and the one pre-existing lint warning that is not a finding.
- [Free-plan constraints on backup/restore](project-free-plan-constraints.md) — why EXP-003 exists: Workers Free CPU/D1 limits shape the backup transfer design.
- [Snapshot pipeline retired (CALC-005)](project-snapshot-pipeline-retired.md) — what is now dead code, what must never be re-queued, and the CALC-005 ID collision.
- [Chunked restore invariants](project-backup-restore-design.md) — derived keys, resume-in-place, fresh-account precondition; what must not break in later backup work.
