---
name: node-test-file-import-side-effect
description: importing another *.test.ts file's helper functions re-executes its top-level test() registrations; duplicate/extend logic locally instead
metadata:
  type: feedback
---

Node's test runner (`node --test`) treats a `*.test.ts` file as an ordinary
ES module when it is `import`ed from another test file. If file B imports
even one named export from file A (e.g. a shared walker/parser helper),
importing B also re-executes ALL of A's top-level `test(...)` calls inside
B's own module scope — A's tests get registered a second time whenever B
runs standalone or alongside A in the same `node --test <glob>` invocation.

**Why:** discovered in PRF-014's step-1 correction round: the task asked to
"generalise the source pin ... (tests/bug-001.test.ts has the walker)".
Importing `bug-001.test.ts`'s `parseImportEdges`/`listSourceFiles`/etc. into
`tests/prf-014.test.ts` would have silently re-run BUG-001's entire guard
suite (including a repo-wide app/ walk) every time prf-014's file executes,
and doubled its test count when both files are passed to `node --test`
together (as this repo's verification commands always do).

**How to apply:** when a task says "reuse test file X's helper/walker" for
a NEW test file, duplicate the small pure-function logic locally (with a
comment noting it deliberately does not import X, and why) rather than
importing X directly. This is the repo's own precedent shape (see
`tests/bug-001.test.ts`'s comment about `tests/imp-010a.test.ts`/
`tests/ui-003.test.ts` being separate, parallel regex-scan implementations,
not a shared import) — small controlled duplication beats accidental
cross-file test registration. Only exception: helpers exported from a
non-test `.ts` module (never a `*.test.ts` file) are safe to import
normally, since those have no top-level `test()` calls to re-run.
