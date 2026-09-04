---
name: source-shape-pins-and-contract-types
description: Two recurring gotchas when adding a field to a widely-shared server loader's return type in this repo — source-regex "shape pin" tests, and the *-contract.ts type-split convention.
metadata:
  type: feedback
---

Two things worth checking before threading a new field through a loader like
`loadOwnedHoldings`/`loadOwnedCapitalGains` and up into `portfolio-shell.tsx`:

1. **Source-shape "pin" tests exist and will break on an unrelated-looking
   refactor.** Some tests (e.g. `tests/ui-047.test.ts`) assert against the
   literal *source text* of a function (via `readFile` + regex on an
   excerpt), not just its behavior — e.g. pinning the exact
   `const [portfolioValueHistory, holdingsSummary] = await Promise.all([...])`
   destructuring shape in `app/authenticated-workspace.ts` to prove two reads
   still run concurrently. Renaming a destructured variable or merging two
   Promise.all results into one object breaks these even though behavior is
   unchanged. Fix: grep the target file's name across `tests/` for
   `readFile`/`excerptAfter`/`assert.match` before restructuring it, and if a
   pin exists, thread new data out via an **output-slot** (a mutable
   `{ current: X }` box set as a side effect inside the existing `.then()`)
   rather than changing the tuple/return shape the pin depends on. This repo
   already uses that exact output-slot idiom for `sqlContextOut`/
   `landingRedirectOut` in `authenticated-workspace.ts` — matching it kept an
   unrelated pin test green while still adding a new derived value from the
   same read.

2. **Presentation types live in a `*-contract.ts` sibling, not the loader
   file itself, even though `import type` is fully erased and would be
   bundle-safe either way.** `app/owned-holdings-contract.ts` holds
   `OwnedHoldingRow`/`OwnedCashSummary`/etc. purely so `portfolio-shell.tsx`
   imports types from a file with no server-only value exports, rather than
   `owned-holdings.ts` itself (which pulls in `db/repositories/...`,
   `domain/market-data/...`, etc.) — this is a deliberate architectural
   split for clarity, not a technical bundler requirement (contrast with
   `capital-gains-screen.tsx`, which DOES `import type` straight from
   `owned-capital-gains.ts` — that's fine too). When adding a new type meant
   to reach a "use client" component, check whether the loader already has a
   `*-contract.ts`/`*-summary.ts` sibling and add it there to match the
   existing split, rather than importing from the loader file directly.

See also [[portfolio-shell-owned-mode-narrowing]] for another
portfolio-shell.tsx-specific idiom to match rather than fight.
