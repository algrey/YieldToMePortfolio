---
name: vinext-redirect-vs-trycatch
description: Calling next/navigation's redirect() from code wrapped in a try/catch silently breaks the redirect under vinext — how to detect it and the output-slot workaround used in UI-051.
metadata:
  type: project
---

vinext's `next/navigation` shim (`node_modules/vinext/dist/shims/navigation.js`) implements `redirect()` by **throwing** a `VinextNavigationError` whose `.digest` starts with `"NEXT_REDIRECT;"` — this is how the framework distinguishes "please navigate" from a real error. There is no `isRedirectError` export from vinext's shim (unlike real Next.js), so nothing rethrows it for you automatically.

**Consequence:** if `redirect()` is called from inside a function whose call site (or an enclosing scope) has a plain `try { ... } catch (error) { ...fallback... }` that does not special-case this digest, the catch swallows the redirect and the page silently renders the fallback instead of navigating. `app/authenticated-workspace.ts`'s `loadAuthenticatedWorkspace` has exactly this shape (an outer try/catch around the whole identity+read pipeline that converts any thrown error into `unavailableWorkspace(...)`), so a naive "just call `redirect()` as soon as we know a portfolio exists" inside that function would have been silently defeated by its own error-handling.

**How to apply:** never call `redirect()` from inside code with a surrounding generic try/catch unless you've verified the catch rethrows `NEXT_REDIRECT` digests. The safer pattern (used in UI-051, see [[d1-query-planning]]'s auth-duplication entry for the companion constraint) is an **output slot**: the inner function sets `someOutSlot.current = <value>` and does a plain early `return` (no throw) instead of calling `redirect()` itself; the caller (the page/Server Component, which has no wrapping try/catch) checks the slot after the call returns and calls `redirect()` itself, at the top level, exactly where `redirect()` is already safely called elsewhere in that same file.
