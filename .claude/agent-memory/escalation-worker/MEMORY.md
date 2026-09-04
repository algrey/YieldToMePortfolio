# Memory index

- [D1 vs node:sqlite limit divergence](project-d1-vs-node-sqlite-divergence.md) — a green suite proves nothing about SQLite limits D1 enforces and the local driver raises; never write `LIKE ?`.
- [Free-plan CPU budget](project-free-plan-cpu-budget.md) — size by D1 operation count, not local ms; on Free the cron handler gets the SAME 10 ms as a request.
- [Recorded perf figures decay](project-recorded-perf-figures-decay.md) — doc-cited ms-per-unit numbers have measured 3-5x optimistic; re-measure before sizing a bound on one.
- [Copy disjunction honesty](project-copy-disjunction-honesty.md) — "either X or Y" copy is a factual claim; a restored ledger has committed rows with no import batch at all.
- [Per-invocation budget scope](project-per-invocation-budget-scope.md) — deferring statements out of an atomic unit keeps them in the invocation budget; size bounds at the ceiling constant, not the fixture.
- [Chunked route gates](project-chunked-route-gates.md) — gate on the terminal status AND advance by portfolio; a chunk’s own run ids never cover the batch.
- [import_rows query-plan hint](import-rows-query-plan-hint.md) — a batch-scoped import_rows join drives owner-wide; `+user_id` restores the batch_id seek.
- [previewVersion hash invariants](preview-version-hash-invariants.md) — filtering an issue out of the hash is half the job; `ready`, `unresolved` and `resolvedTargets` leak it back and 409 every remedy.
- [Commit-time lookups see own chunks](commit-time-live-lookups-see-own-chunks.md) — a live "already exists?" query inside commit sees this batch's earlier chunks; scope by `import_batch_id`, test at an odd row count.
