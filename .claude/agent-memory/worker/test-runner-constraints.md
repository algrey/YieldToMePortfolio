---
name: test-runner-constraints
description: Two hard import limits of this repo's plain Node test runner (node --experimental-strip-types --test) and the established workaround pattern.
metadata:
  type: project
---

This repo's test suite runs under the plain Node test runner
(`node --experimental-strip-types --test tests/*.test.ts`), not vitest/jest.
Two things cannot be imported directly under it, confirmed by direct
reproduction (2026-08-30):

1. **`.tsx` files** — fail with "Unknown file extension .tsx". `--experimental-strip-types`
   strips TypeScript type syntax only; it does not transform JSX. This means
   no function in a `.tsx` component file (even a plain exported helper with
   no JSX in it) can ever be imported by a test — only read as raw source
   text, or executed via the `renderComponent` shell-out helper (see
   `tests/eff-001.test.ts`'s `renderComponent`, which spawns a separate
   `node --import tsx` child process to call `renderToStaticMarkup` on a
   pure presentational component and capture the HTML).

2. **Anything statically importing `next/headers`** (even transitively) —
   fails with `ERR_MODULE_NOT_FOUND` (`next/headers` has no proper ESM
   subpath export, only `next/headers.js`, which nothing actually imports).
   `app/portfolio-actions.ts` (`getAuthenticatedSqlContext`) and
   `app/authenticated-workspace.ts` (`loadAuthenticatedWorkspace`, which
   imports `next/headers` directly at the top of the file) are the usual
   sources; anything that statically imports either at the top of the file
   (e.g. `system-backup-actions.ts`, `price-upload-actions.ts`, every
   `app/portfolio/[portfolioId]/**/page.tsx`) becomes untestable via direct
   import, and so does any `app/api/**/route.ts` that imports one of those
   action modules. Node's experimental `mock.module` does NOT rescue this —
   it mocks the *load* phase, not a resolution failure, so mocking
   `next/headers` before importing still throws. Confirmed again in PRF-002
   (2026-08-31): a census test that needs to measure `loadAuthenticatedWorkspace`'s
   own composed cost cannot import it — instead, reproduce its call
   sequence manually against the underlying loader functions it calls
   (`createOwnedUserSettingsRepository`, `loadOwnedHoldings`,
   `loadHistoricalPortfolioValueSeries`, etc.), or, for the auth-resolution
   layer specifically, import `domain/auth/request-context.ts`'s
   `resolveAuthenticatedRequestContext` directly — it and everything it
   calls (`domain/auth/identity-lifecycle.ts`, `db/repositories/identity.ts`)
   are plain `.ts` with no framework import, so THAT layer alone is
   directly testable even though the page-loader wrapper around it is not.
   Workaround already used elsewhere in the codebase: give the
   auth-dependent action a **dynamic** `await import("./portfolio-actions.ts")`
   inside the function body (see `app/market-data-actions.ts`'s
   `requestMarketDataRefreshAction`) so importing the *route* module doesn't
   eagerly trigger it — this is why `tests/ui-004.test.ts` can import
   `market-data/refresh/route.ts` directly (for its CSRF-rejection test)
   while `system-backup`/`price-upload` routes cannot. Modules that avoid
   this entirely by design (e.g. `app/price-upload-request-body.ts`) have
   header comments saying so explicitly — grep for "next/headers" in header
   comments before assuming a module is directly testable.

**Established pattern for testing logic trapped behind either constraint**
(see `tests/div-013.test.ts`'s header comment, and now
`app/system-backup-restore-progress.ts` / `app/api/system-backup/export/response-shape.ts`,
both added 2026-08-30 fixing EXP-003 review findings): extract the PURE
decision/parsing logic into a plain `.ts` sibling module with no JSX and no
`next/headers` import. Unit-test that module directly and for real. Then
only pin the component/route's WIRING to it (that it imports and calls the
right thing, with the right literal strings) via a `readFile` + regex
assertion on the source text — never claim that regex assertion alone is a
behavioural test of the actual logic; a reviewer will (rightly) reject a
test that ONLY does source-regex matching for something that has real
decision logic behind it.

See [[worker]] general conventions for the broader AGENTS.md test-proportionality
rule this satisfies.
