---
name: preview-version-hash-invariants
description: Excluding an issue code from previewVersion's hash is only half the job — ready, counts.unresolved and resolvedTargets are DERIVED from the issue list and leak the same evidence back into the hash.
metadata:
  type: project
---

`domain/imports/review.ts`'s `hashedPreview` filters page-only-evidence issue
codes out of the hashed issue list. That filter is NOT sufficient on its own:
`hashedPreview` is built by spreading `preview`, and three fields are derived
from the FULL issue list — `ready`, `counts.unresolved`, and (in
`reconciliation.ts`) `resolvedTargets`, which is only populated for a row with
no error-severity issue. Any error-severity code added to the filter therefore
still moves the hash through all three unless each is neutralised.

**Why:** the page/refresh path supplies evidence (`committedTradeValues`,
`committedDividendValues`, `existingDividendEntries`,
`existing*SourceReferences`) that the ready/exclusion loader and
`commitRepository.validate()` never load. A hash that moves with that evidence
makes the page's `expectedPreviewVersion` disagree with every writer, so each
`POST .../exclusions` and `.../ready` 409s "This preview is stale" — with no
recovery path, which silently kills whatever remedy the issue's own message
advertises. Found twice now (BRK-019 rounds 1 and 2).

**How to apply:** before filtering a new code out of `hashedPreview.issues`,
check its severity. If it can be `error`, also recompute `ready` from the
filtered list, subtract its `unresolved` increments, and exempt the code from
`resolvedTargets`' error gate. Then pin it: assert the page-evidence preview,
the shared ready loader, and `commitRepository.validate()` hash byte-identically
for that shape, and that an exclusion + mark-ready driven by the PAGE's version
does not 409. Related: [[project-chunked-route-gates]].
