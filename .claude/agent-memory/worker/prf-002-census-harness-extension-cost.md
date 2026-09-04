---
name: prf-002-census-harness-extension-cost
description: tests/prf-002.test.ts's PAGES/DEPTH_CEILING census array requires faithfully re-deriving a page's full next/headers-free read sequence to add a new entry safely -- for a page whose fix is just "one fewer identity resolution," a source-regex + oneResolutionStatements-style test (matching the existing six-page precedent) is a safer, equally valid substitute the task's own "(or the census harness)" wording allows.
metadata:
  type: project
---

`tests/prf-002.test.ts`'s `PAGES` array (each entry a `censusXPage(client)` function) and its paired `DEPTH_CEILING` map exist because `app/authenticated-workspace.ts`/`getAuthenticatedSqlContext` pull in `next/headers` and cannot be imported under plain `node --test` -- each census function hand-reproduces the page's exact composed-loader call sequence against an already-resolved client/userId instead. Adding a new page here means correctly re-deriving that ENTIRE sequence (including whatever `loadAuthenticatedWorkspace`'s internal reads are for that page's option flags), not just the one function you actually changed -- get it wrong and you get a silently-inaccurate census, not a test failure.

**Why this matters:** PRF-011 needed to prove `/import` and `/portfolio/:id/ledger/new` now cost ONE identity resolution instead of two. Both pages ONLY ever exercised as `getAuthenticatedSqlContext`'s duplicate call (never anything covered by the existing `baseWorkspaceLoad` stand-in), so faithfully modeling them in `PAGES` would have meant either building a brand-new stand-in or risking a wrong one. The task's own instruction offered an explicit escape hatch: "extend tests/prf-002.test.ts's PAGES to cover /import and /ledger/new (**or the census harness**)". The six pages PRF-002 originally fixed (`ui-006a.test.ts`, `ui-016.test.ts`, `cgt-001b.test.ts`, etc.) were ALL verified this same way at the time -- a source regex asserting `sqlContextOut` threading is present and `getAuthenticatedSqlContext(` is absent -- not by adding them to `PAGES` either.

**How to apply:** when a task asks to prove an auth-duplication fix on a NEW page under this pattern, prefer a dedicated test (in `tests/prf-002.test.ts`, referencing the existing `oneResolutionStatements` figure computed via the SAME `resolveAuthenticatedRequestContext` direct-import trick) plus a source-regex assertion (`assert.match(page, /sqlContextOut/)`, `assert.doesNotMatch(page, /getAuthenticatedSqlContext\(/)`) over trying to force the page into `PAGES`/`DEPTH_CEILING`. Reserve actual `PAGES` additions for pages whose OWN section-specific loader chain (beyond auth) also needs census/depth coverage.

Also recorded: adding a genuine active-disposal fixture to `productionScaleFixture()` (for `/gains`'s statement/depth measurement) requires updating `DEPTH_CEILING["/portfolio/:id/gains"]` too -- the OLD ceiling was calibrated to the zero-sell short-circuit's shallow depth, not a real disposal chain, and will fail once the fixture actually exercises the chain.

**Correction (round 2, PRF-011 F2 fold-in, 2026-09-03): a `PAGES` addition is
safe WITHOUT re-deriving `loadAuthenticatedWorkspace`'s branch for that page
when the page's own real extra cost beyond `baseWorkspaceLoad` is the whole
point of the census entry.** `baseWorkspaceLoad` (settings + FX,
`Promise.all`) already omits the `portfolioRecords` list read for EVERY
existing census page, uniformly -- that omission is a pre-existing,
established simplification, not something a new page's addition has to
solve. Added `/import` (`loadAuthenticatedWorkspace(undefined, {})`, which
takes the `activePortfolio === null` early return right after the shared
wave) as `censusImportPage = baseWorkspaceLoad(client) then
loadOwnedSharesightLinks(...)` -- measured 3 statements / depth 2, the
shallowest page in the census. To find a new page's measured depth before
committing to a `DEPTH_CEILING` number: temporarily set a high placeholder
(e.g. 99), run `node --experimental-strip-types --test tests/prf-002.test.ts`,
read the printed `depth=N` line for that page's row, then set the exact N.
