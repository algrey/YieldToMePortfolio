---
name: project-free-plan-cpu-budget
description: Sizing Workers Free-plan requests in this repo — count D1 operations against the known production calibration, and rule out a D1/local-sqlite divergence first.
metadata:
  type: project
---

This app runs on the **Cloudflare Workers Free plan (10 ms CPU per request)**.
Size any per-request loop (restore parts, import chunks, backfills) by counting
**D1 operations**, not by timing it locally.

**Rule out [[project-d1-vs-node-sqlite-divergence]] BEFORE concluding "CPU".**
A CPU eviction and a thrown D1 error can look alike from the browser (both
non-JSON HTTP 500). They differ in `wrangler tail`: a CPU kill logs nothing at
all — no exception, no outcome line — while a thrown error logs a route-handler
error you can read. If tail shows an exception, it is not a budget problem.

**Calibration anchor (real production kill, 2026-08-30):** the pre-EXP-004
single core-commit request performed **~992 D1 client calls / ~1,534 SQL
statements** (a scaffold pass plus 63 `ledger.post` replays) before Cloudflare
terminated it. Keep any new request at roughly **a quarter** of that.

Measured per-row costs (production-shaped payload):

- `ledger.post` replay: ~13 client calls / ~21 statements per transaction
- dividend manual record replay: ~4 calls / ~5 statements
- price-backup row: batched — 200 rows is only ~65 calls / ~457 statements
- whole-payload JSON parse + validate + canonicalise + SHA-256 of a ~124 KB
  backup: well under 1 ms locally. Payload handling is almost never the
  dominant cost; the database-operation count is

**How to apply:** before changing or trusting a chunk-size constant, meter a
real full-size part through a counting `SqlClient` wrapper (see
`tests/exp-004.test.ts`'s "per-request work census" test) and assert a ceiling.
Say plainly in any report that local Node timings are not Workers CPU
accounting — the operation census is the portable measure, and a sizing fix is
a margin argument, not a proof of a millisecond cost.

**Correction worth remembering (2026-08-31):** on EXP-004 I concluded from this
census that oversized parts were THE root cause of a failing restore. They were
a real defect, but the actual production failure was a thrown D1 error that
meant those parts were never even reached. The census was sound and the
evidence (unchanged production D1, no tail outcome) genuinely fit — but I
treated a consistent explanation as a confirmed one without a server-side error
line to close the loop. Get the actual error out of the platform before naming
a root cause "confirmed".
