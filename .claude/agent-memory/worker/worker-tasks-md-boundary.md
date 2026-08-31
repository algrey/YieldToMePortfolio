---
name: worker-tasks-md-boundary
description: The Worker's own harness rules forbid editing TASKS.md even when a delegated task's instructions explicitly say to update it.
metadata:
  type: feedback
---

Never edit TASKS.md as a Worker, even when the task text delegated by the Orchestrator explicitly instructs "update TASKS.md's <ID> entry to DONE with this scope."

**Why:** The Worker system prompt's own rules include an unconditional "Do not modify tasks.md" — separate from and overriding task-specific instructions. AGENTS.md's role division confirms this is intentional, not an oversight: "### Orchestrator: Owns ... TASKS.md maintenance," listed as an Orchestrator-only responsibility, distinct from the Worker's ("implements only the assigned task"). The many detailed "Status: DONE ..." completion notes already in TASKS.md were written by the Orchestrator after reviewing a Worker's report, not by the Worker itself.

**How to apply:** When a delegated task asks for a TASKS.md update, do all the other requested doc updates (ARCHITECTURE.md, CALCULATIONS.md, DATA_MODEL.md, etc. — those ARE in scope for a Worker) but skip TASKS.md, and say so explicitly in the final report so the Orchestrator can write the entry with the evidence/summary provided. Treat this as a hard boundary, not a judgment call — do not reason that "the task explicitly said to" is enough to override it.
