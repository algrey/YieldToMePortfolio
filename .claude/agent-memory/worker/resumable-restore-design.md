---
name: resumable-restore-design
description: How to make a monolithic per-owner commit path resumable/chunked on Cloudflare Workers Free without an in-process ref->id map, and why archive-and-recreate retry strategies break once chunking introduces real cross-request progress.
metadata:
  type: project
---

Pattern used for EXP-004 (chunking the full-system restore's CORE commit
after EXP-003 only chunked price history) — reusable whenever a
single-request D1 write path needs to be split across multiple HTTP
requests to fit the Free plan's ~10ms CPU budget per request.

**Why an in-process `Map<ref, dbId>` cannot be the cross-part linking
mechanism**: once a batch of related rows (e.g. a transaction chain with
reversals/supersessions, or a dividend supersession chain) is split across
separate HTTP requests, any JS-side `Map` built during request N is gone by
request N+1 (Workers do not persist in-memory state across invocations).
The fix is to derive a **durable, deterministic key** per row (e.g.
`bundle:<fingerprint>:<ref>`) that is written to a DB column at insert time
and can be looked up again with a plain, owner/portfolio-scoped `SELECT`
whenever a LATER part or a finalize step needs to reference an
earlier-inserted row. Check whether the target repository already has (or
can cheaply gain) an idempotency-key column and lookup function before
building anything bespoke — in this codebase `transactions.idempotency_key`
already existed and was reused as-is; `dividend_manual_records` had one
column path with a key (manual-create) and one without (import-insert) —
the fix was adding the key to the WEAKER path, not inventing a new
mechanism.

**Why "archive the leftover and start over" retry strategies stop being
correct once you chunk**: a design that treats any non-`committed` batch
status as "abandoned attempt, safe to discard" is only sound when the whole
commit happens in ONE request (so a `committing`/`failed` row can only ever
represent a doomed, low-value partial state). The moment you split writes
into separate parts, `committing` becomes the NORMAL steady state between
parts, holding real durable progress. Any pre-existing "resume" logic that
archives/discards a non-committed row must be re-examined and almost
certainly changed to "reuse this target and continue from server-measured
progress" instead — otherwise the chunking work is pointless (every retry
still destroys and redoes everything). Grep for whatever function currently
implements the old strategy (in this repo: `findLeftoverPortfolioForRetry`
/ `archiveLeftoverPortfolio`) and expect to delete it as dead code once the
new resume-in-place scaffold ships, not leave it running in parallel.

**Resume evidence should be server-derived counts, not a client-held
cursor, whenever the target ordering is deterministic**: rather than
mirroring a price-chunk-style `{nextChunk, batchIds}` localStorage cursor
(which needs a separate server probe to validate before trusting), if the
rows are always replayed in one fixed, recomputable order (topological/
chain order here), the server can just report "how many rows for this
target are already durably written" (a live `COUNT(*) WHERE
idempotency_key LIKE 'prefix:%'`) on every request, and the client always
slices its own freshly-recomputed ordered array at that count. This
eliminates a whole class of cursor-trust bugs and works correctly even
across a full browser reload with zero persisted client state.

**Watch for latent non-idempotency exposed by resume-in-place**: functions
that were only ever called ONCE per commit under the old single-shot design
(e.g. `income_whatif_scenarios.save()`, deliberately create-only, "an owner
may want two scenarios with the same name") can silently duplicate rows
once a finalize/final step becomes retryable into the SAME target. Audit
every write in the "finalize" step specifically for this — the fix used
here was a whole-step short-circuit (skip the entire finalize body if the
batch already reads `committed`), accepting a narrow residual gap (a crash
mid-finalize, before the status flip, followed by a retry) rather than
retrofitting a natural key onto something deliberately designed without
one.

See [[test-runner-constraints]] for why the browser-side chunking logic
(`chainOrder`, `chunkRows`) needs to live in a plain `.ts` domain module
shared between server and client, not inline in the `.tsx` panel — that is
also what makes it directly unit-testable.
