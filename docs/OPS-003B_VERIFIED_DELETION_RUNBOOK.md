# OPS-003B Verified Account Deletion

Use this only for an account in `deletion_pending`. Never run a destructive
drill against production. Production execution requires the owner's exact
deletion idempotency key and the exact completed OPS-003A export attached to
that immutable request.

## Disclosure and confirmation

The deletion request revokes access immediately but does not delete data. A
24-hour cooling-off period starts at the immutable request time. Disclose that
final deletion removes portfolio, ledger, import, projection, export, and
user-scoped market data. Recovery can be a separate operator decision before
purge starts. After completion, Time Travel and encrypted backups remain
disaster-recovery evidence and must not selectively restore the purged account
into production.

The user must separately type `PERMANENTLY DELETE MY ACCOUNT`. Same-origin
checks run before authentication/database work. The exact request key makes
network retries deterministic.

## Execution and evidence

1. Verify the deletion request's own export is completed, unexpired, and has a
   reconciled digest. Never substitute an independent export.
2. Start or resume its single `account_purge_jobs` row. A `failed` job is
   terminal; investigate its redacted failure code rather than changing keys.
3. Repeatedly invoke bounded processing. Each call handles at most 100
   chunks/rows, including final artifact/lifecycle cleanup, and advances an
   atomic version-guarded checkpoint.
4. Stop on source, manifest, expiry, completeness, or digest mismatch. No
   delete begins until all exact source/chunk evidence validates.
5. Completion requires `completed`/`complete`, a `purged` user, the exact
   manifest digest and deletion counts, absence of all non-shared targets,
   deleted export artifacts, and one redacted `account.purge` audit.

Retain only immutable deletion intent; revoked issuer/subject linkage with
email and last-authentication time cleared; anonymized user tombstone; durable
purge proof; and one payload-free completion audit. A provider mapping still
referenced by another scope is shared and is not modified.
Audit rows are removed only when `target_owner_user_id` is the deleting owner;
actor-only involvement remains untouched. A guard row is not authority by
itself: triggers join its owner, job, expected version, status, and phase to the
live purge. Source locks reject owner/provider mutations after validation
starts.
UPDATE locks check old and new owners independently. Purge-control tables are
not retroactively added to OPS-003A manifest expectations; an exact export
completed before OPS-003B remains eligible when its original manifest verifies.

**Operational consequence of a schema-adding migration (e.g. DB-005, migration
`0030`):** unlike a purge-control-only migration (which stays excluded from
manifest expectations, so old exports remain eligible -- see above), a
migration that adds a new first-class owned/exported table changes
`ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS`'s expected table set for every purge
attempt from that point on, regardless of which database a given export was
captured against. Deploying such a migration invalidates any already-completed
export bound to a pending deletion request: `purgeAccount` fails closed with
`manifest-corrupt` (`"The export manifest does not reconcile."` /
`"...is incomplete."`) rather than silently purging without covering the new
table. The affected owner is not stuck -- `manifest-corrupt` is not terminal, and the
original request row is retained immutably as history -- but `request()` is
keyed by `(userId, requestType, idempotencyKey)`, so completing deletion
requires a genuinely new deletion request with a fresh idempotency key, which
mints a fresh `account_export_jobs` export against the post-migration schema
and its own 24-hour cooling-off. The old request/export pairing simply never
purges. When deploying a schema-adding migration, check for `deletion_pending`
accounts with a completed-but-unconsumed export from before the deploy and
expect their next purge attempt to fail closed until they (or an operator
acting on their behalf) submit a new deletion request.

## Synthetic drill

Create a new loopback/local D1 database, apply the migration chain, insert two
synthetic owners with representative ledger and market rows, export one owner,
advance beyond cooling-off, and process purge to completion. Record the digest,
counts, proof, retained-minimum checks, and byte-for-byte hashes for the other
owner before/after. Destroy the isolated database afterward. The deterministic
`tests/ops-003b.test.ts` fixture performs the same SQLite checks; it is not
authorization to target a configured database.

Migration `0028` deliberately replaces the conditional audit/lifecycle delete
triggers and appends source-lock triggers because Drizzle cannot express them.
Migrations `0025`–`0028` are an intentional
generated evolution: durable job, ephemeral guard, then final checked guard
shape and bounded cleanup phase. `0026` carries the final guard columns so the
subsequent generated rebuild applies on a fresh database. Tests cover ordinary
append-only behavior, fake/wrong-version guards, intermediate migration safety,
guarded deletion, old/new-owner source locking, legacy-manifest compatibility,
and bounded cleanup.
