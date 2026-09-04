---
name: sharesight-sync-observation-table-pattern
description: BRK-022 patterns for a sync-time OBSERVATION table (never a ledger fact) layered on top of the Sharesight staging pipeline -- withdraw-on-absence vs withdraw-on-state-change, bare vs prefixed source_reference keys, and wholesale-validation-but-chunked-write repository semantics.
metadata:
  type: project
---

BRK-022 slice 2 (review round, 2026-09-04) fixed three related defects worth remembering for any future observation/cache table synced from an external provider:

1. **"Withdraw when no longer observed" must mean absence from the FETCH, never a state transition inside the app.** The original code built the withdrawal "observed set" only from the SUBSET of fetched rows that get recorded (e.g. only future-dated candidates), so an item that simply moved from "pending" to "about to stage as a real row" dropped out of that subset and looked withdrawn on the very next sync -- even though the provider still listed it and nothing had committed yet. Fix: build the observed set from the WHOLE fetch (every item the provider returned, recorded or not, colliding or not), and let a SEPARATE, later mechanism (slice 3's read-time suppression here) handle "this is superseded by a committed record."

2. **A repository doc comment claiming "fails a batch wholesale, never partially" is a common false generalization.** Check separately: is VALIDATION wholesale (yes, typically -- one bad row rejects the whole call before any statement is built) vs are WRITES wholesale (often no -- multiple `client.batch()` calls, one per chunk, so a later chunk's failure can leave earlier chunks applied). The mitigating property that makes this safe is usually "the write is idempotent, so the next sync repairs it" -- state that explicitly rather than the false "atomic" claim.

3. **A bare provider-identity key stored in an observation table is NOT byte-equal to the prefixed `source_reference` a commit pipeline mints for the "same" identity.** `import-commit.ts` wraps every staged row's fingerprint in an `import-fingerprint:` prefix; an observation table that stores the bare fingerprint (because it predates staging) needs an explicit, exported, single-source-of-truth function (here `domain/imports/committed-source-reference.ts`'s `committedSourceReferenceForFingerprint`) to relate the two -- never assert or document them as "the same key."

4. **Same-fetch identity collisions in a provider feed recur as a pattern (BRK-005C precedent, extended by BRK-022 F2):** when two items in one fetch share an identity key the system cannot disambiguate, the correct move is to record NEITHER (never guess/pick one arbitrarily), count how many were affected, and surface it to the owner naming the provider-side remedy -- reuse the SAME collision-counting helper (`countPayoutKeyCollisions`) across every place this predicate is needed rather than re-deriving it.

5. **A "positive decimal" validation on a provider-observation amount field is often too strict** -- a genuine `$0` announcement is representable and should be accepted (`isNonNegativeDecimalString`), especially when the write is validated WHOLESALE: one rejected zero-amount row can otherwise silently block every OTHER row in the same call.

Related: [[worker-tasks-md-boundary]], [[hist-001-no-batch-invariant]] (a sibling "never call client.batch()" invariant in this same sync-adjacent codebase area).
