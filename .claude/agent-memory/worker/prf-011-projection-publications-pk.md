---
name: prf-011-projection-publications-pk
description: projection_publications.portfolio_id is the table's PRIMARY KEY -- at most one row per portfolio can ever exist, so the "2+ rows" branch of a LIMIT-2 multiplicity check on that table is schema-structurally unreachable (matches owned-holdings.ts's own PRF-004 precedent).
metadata:
  type: project
---

`db/schema.ts`/`drizzle/0017_bouncy_morgan_stark.sql` makes `projection_publications.portfolio_id` the table's `PRIMARY KEY` (one current publication per portfolio, by construction -- not merely convention). Consequently, when replacing a separate `count(*)` precheck against this table with the PRF-004 `LIMIT 2` + `rows.length !== 1` pattern, the only reachable failure branch is 0 rows ("no publication yet"); a genuine 2+ scenario cannot occur without a schema change, so no test needs to construct it (both `app/owned-holdings.ts` and `app/owned-capital-gains.ts` document this as defensive/future-proofing, not a live case).

**Why this matters:** confirms the `LIMIT 2` rewrite is safe and behavior-preserving without needing to prove the 2-row branch is reachable-and-correctly-handled -- it never fires today. If a future schema change ever makes multiple publications per portfolio possible (e.g. per-calculation-version publications), this guarantee would need re-verifying and a real 2+-row test would then become necessary.

**How to apply:** before writing a test for "more than one X row" on any owner-scoped pointer table in this codebase, check its migration for a `PRIMARY KEY`/unique-index on the scoping column(s) first -- if the multiplicity is schema-enforced to 1, don't spend effort constructing an unreachable scenario; document the guarantee instead (as this task did).

See also [[count-gate-removal-vs-orphan-detection]] for the sibling `lot_allocations` case on the SAME task, where the analogous "extra purpose" WAS reachable and needed real handling.
