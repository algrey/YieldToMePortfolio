---
name: project-copy-disjunction-honesty
description: Reviewers on this project fail user-facing copy that states "either X or Y" whenever a third code-known case exists; enumerate exhaustively before writing a disjunction.
metadata:
  type: project
---

Any user-facing sentence in this codebase that enumerates causes ("so
either A or B") is reviewed as a factual claim, and a single reachable
third case makes it a BLOCKING finding — not a style nit. BRK-014 burned
four review rounds this way: rounds 2-4 each narrowed the disjunction and
each time the reviewer reproduced a shape falsifying it.

The recurring blind spot is state that exists without the artefact that
normally produces it. The concrete instance: a system backup restore
(`domain/exports/portfolio-bundle.ts`'s `PortfolioBundleV1`) carries
`transactions` and `dividendManualRecords` — `sourceReference` intact —
but no `import_batches`, so a restored ledger holds committed
import-keyed rows with **no prior batch at all**. Any predicate phrased
as "differs from the last X" is false there; "matches no earlier X" is
the honest phrasing.

**Why:** the product's stated priority is explicit uncertainty over
confident copy; a sentence asserting a cause the code cannot establish is
treated as the same class of defect as a wrong number.

**How to apply:** before writing or approving enumerated copy, list every
way the state is reachable from the code (including restore, first-run,
and deleted-artefact paths), then either name them all or fall back to
stating only what was checked. Prefer "matches no earlier X" over
"differs from the last X". Mirror the same wording into the doc comment
and the `docs/ARCHITECTURE.md` append — the reviewer checks all three,
and a stale doc comment fails the round on its own. See
[[project-recorded-perf-figures-decay]] for the same
verify-the-claim-not-the-recollection habit applied to numbers.

Related: a test comment claiming "all N tests fail pre-fix" is also a
factual claim. Guard tests (which pass pre-fix by construction) must be
labelled as guards in both the block header and the assertion message.
