---
name: project-recorded-perf-figures-decay
description: Performance numbers recorded in docs/ARCHITECTURE.md and docs/CALCULATIONS.md are point-in-time and have measured 3-5x optimistic — re-measure before sizing anything on them.
metadata:
  type: project
---

`docs/ARCHITECTURE.md` / `docs/CALCULATIONS.md` carry very specific measured
performance figures (ms-per-unit, rows-per-load) from the task that recorded
them. **Treat them as a point-in-time observation, not a current fact.**

**Why:** BUG-010 (2026-09-01 production outage) turned on ARCHITECTURE.md §9.2's
recorded "~0.05 ms per candidate date". Re-measured against the same fixture
shape and the same code path, the derivation alone cost ~0.17 ms/date and the
whole slice ~0.26 ms/date — 3.4-5x optimistic. That figure had been used to
justify a bound (400 dates ≈ "20 ms") that was really ~104 ms, i.e. ~10x over
the [[project-free-plan-cpu-budget]] rather than the ~2x the doc's own numbers
implied. A whole class of bound was sized on it.

Related trap: a recorded figure often measured a NARROWER thing than the bound
it justifies (there, the pure derivation function, excluding row mapping,
validation, and the upsert construction that scale with the same N).

**How to apply:** when a task hands you a doc-cited number as the basis for a
limit, chunk size, or budget, re-measure it yourself on a production-shaped
fixture before you use it — and, when correcting it, append a dated supersession
note in the doc's own inline-correction style rather than editing the old
number in place (both files follow a never-rewrite-history convention).
