---
name: slice-handoff-barrel-export-gap
description: A prior slice's new repository module can exist and be fully tested without ever being wired into db/repositories/index.ts -- check the barrel export before assuming a sibling slice's deliverable is consumable.
metadata:
  type: feedback
---

When a multi-slice task (e.g. BRK-022 slice 1 -> slice 2) hands off a new repository file to a later slice, the earlier slice may have built and tested the repository module directly (`import { X } from "../db/repositories/some-file.ts"` in its own test file) without ever adding it to `db/repositories/index.ts`'s barrel export list. This compiles and tests fine in isolation because nothing forces the export.

**Why:** `db/repositories/index.ts` is a hand-maintained barrel (many `export { ... } from "./file.ts"` blocks); there is no lint rule or generator that keeps it in sync with every repository file's exports. A slice that only wrote its own direct-import test file leaves the gap invisible until a later slice tries `import { X } from "../db/repositories/index.ts"` (the convention every `app/*-service.ts` module actually uses) and gets a resolution error.

**How to apply:** Before wiring a later slice's service code against a prior slice's repository, `grep` `db/repositories/index.ts` for the expected export names first. If missing, add the export block (matching the file's existing alphabetical/grouped style) as part of the current slice's own change -- this is in-scope wiring work, not scope creep, even though the file itself was "done" in a previous slice/commit. Same applies to `domain/*/index.ts` barrels for domain modules (e.g. `domain/sharesight-sync/index.ts`) when a pure function needs exporting for reuse across modules.
