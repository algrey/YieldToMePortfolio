---
name: project-free-plan-constraints
description: YieldToMe runs on the Cloudflare Workers Free plan in production; per-request CPU and daily D1 row-write limits are a real design constraint on bulk import/export work
metadata:
  type: project
---

Production runs on the Cloudflare Workers **Free** plan. The binding limits for
bulk data work are 10 ms CPU per HTTP request, 100k Worker requests/day, 128 MB
memory, and D1's ~100k rows written/day (index writes count).

**Why:** the owner hit this in production on 2026-08-28 — the EXP-002
one-request full-system export/restore failed, and the client's 30 s abort
reported Cloudflare's non-JSON limit page as a generic "connection error". EXP-003
was opened to make the same `SystemBackupV1` artifact transferable in bounded
parts (browser-driven paged export, 200-row chunked restore through MKT-008's
existing write path, localStorage resume cursor).

**How to apply:** when reviewing anything that reads or writes a whole table in
one request (exports, imports, backfills, recomputes), treat "it works in the
test fixture" as insufficient — ask what happens at the real row counts (the
price-backup format caps at 130,000 rows). Also check that any chunked
loop degrades honestly: a chunk that legitimately contains no writable rows must
not hard-fail and deadlock the whole run, and a resume cursor must not let a
later run silently skip data. See [[review-recurring-issues]].
