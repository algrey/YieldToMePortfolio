# Memory index

- [Test-runner import constraints](test-runner-constraints.md) — plain Node test runner can't import `.tsx` files or anything pulling in `next/headers`; extract pure logic to a `.ts` sibling instead.
- [Resumable restore design](resumable-restore-design.md) — chunking a monolithic D1 commit across requests: durable derived keys beat in-process maps, archive-and-recreate retry strategies must become resume-in-place, prefer server-derived resume counts over client cursors, audit "finalize" steps for latent non-idempotency.
- [D1 query planning](d1-query-planning.md) — correlated EXISTS defeats indexes; full-row-fetch for a yes/no question wastes CPU even when seekable; count(*) precheck redundancy; duplicate identity resolution doubles a write; multi-window OR'd BETWEEN pattern for N narrow date ranges; fixture FK gotchas.
- [Worker TASKS.md boundary](worker-tasks-md-boundary.md) — never edit TASKS.md as a Worker even when the delegated task explicitly says to; that's Orchestrator-only per AGENTS.md's role division.
- [Sequential-depth parallelization](sequential-depth-parallelization.md) — D1 round-trip DEPTH (not call count) is a separate cost axis on Workers Free; how to measure it and the recurring safe-to-parallelize/must-stay-sequential shapes in this repo's loaders.
- [wrangler.json strict format](wrangler-json-strict-format.md) — keep it strict JSON, no comments; tests JSON.parse it directly even though wrangler itself tolerates JSONC.
- [vinext Link prefetch](vinext-link-prefetch.md) — auto-prefetch skips only dynamic PATH segments, not force-dynamic pages; a fixed-path link like "/" that's always in-viewport gets silently re-prefetched on every navigation.
- [HIST-001 no-batch invariant](hist-001-no-batch-invariant.md) — app/historical-portfolio-value.ts is pinned to never call client.batch()/client.run(); blocks a batch()-based rows_read fix for /income.
- [PRF census batch harness gap](prf-census-batch-harness-gap.md) — stageCensusClient missed client.batch() statements in stats.calls_ (fixed PRF-006); check before trusting a census that used batch().
- [vinext redirect vs try/catch](vinext-redirect-vs-trycatch.md) — redirect() throws a digest-tagged error vinext doesn't auto-rethrow; a wrapping try/catch silently swallows it. Use an output-slot + caller-side redirect() instead.
- [portfolio-shell owned-mode narrowing](portfolio-shell-owned-mode-narrowing.md) — `ownedMode && ownedWorkspace.foo` type-checks via TS aliased-condition narrowing; match this idiom, don't add `?.`/`!`.
