---
name: portfolio-shell-owned-mode-narrowing
description: portfolio-shell.tsx relies on TS's aliased-condition control-flow narrowing for `ownedMode && ownedWorkspace.foo` — don't add unnecessary `?.`/`!` when editing owned-mode branches there.
metadata:
  type: project
---

`app/components/portfolio-shell.tsx` declares `const ownedMode = ownedWorkspace !== undefined;` once near the top (the prop itself is `ownedWorkspace?: OwnedWorkspace`), then uses `ownedMode && ownedWorkspace.activePortfolio` / `ownedMode ? ownedWorkspace.foo : ...` directly, with no `?.` or `!`, throughout the rest of the component (e.g. the primary-tabs href logic, the Income tab guard, and — added in UI-051 — the topbar-brand/popover/drawer chrome links' hrefs).

This type-checks because TypeScript ≥4.4's "control flow analysis of aliased conditions" narrows `ownedWorkspace` inside any block/expression guarded by the `ownedMode` const, since it's a simple `!== undefined` alias. It is not obvious from reading a single call site — if you're skimming a small excerpt you'd expect `ownedWorkspace` to still be `OwnedWorkspace | undefined` there and reach for `ownedWorkspace?.activePortfolio` or a non-null assertion. Match the existing idiom (`ownedMode && ownedWorkspace.X`) instead — adding `?.`/`!` is a needless deviation, not a correctness fix.
