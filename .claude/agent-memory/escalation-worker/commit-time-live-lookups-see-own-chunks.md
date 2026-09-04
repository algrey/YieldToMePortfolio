---
name: commit-time-live-lookups-see-own-chunks
description: A live DB lookup inside import commit sees rows THIS batch wrote in an earlier chunk — scope it by import_batch_id or the outcome depends on where the chunk boundary fell.
metadata:
  type: project
---

`db/repositories/import-commit.ts` commits in chunks (`MAX_CHUNK_SIZE` is 2
today) across repeated `commit()` invocations. Any "does something like this
already exist?" query issued from inside the row loop therefore sees rows the
SAME batch inserted in an earlier chunk, not just genuinely pre-existing ones.

**Why:** BRK-019's near-match (paid-date correction) backstop queried
`dividend_manual_records` with no batch filter. Two legitimate distributions on
one security days apart at the same cash total — a shape confirmed on the
owner's real account — then lost the second whenever the pair straddled a chunk
boundary, and committed both when it did not. A financial outcome that depends
on chunk position is never acceptable, and a green suite hides it: an even row
count puts the pair in one chunk and passes.

**How to apply:** when a commit-time lookup is meant to mirror a preview-time
check, scope it to the PRE-BATCH snapshot (`import_batch_id IS NULL OR
import_batch_id <> ?`, bound to the batch id) — that is exactly what the preview
could see. Test at an ODD row count so the interesting pair straddles a chunk,
and keep a sibling test for the genuine cross-batch case. Verify the added
predicate does not move `EXPLAIN QUERY PLAN` off its index seek. Related:
[[preview-version-hash-invariants]], [[project-chunked-route-gates]].
