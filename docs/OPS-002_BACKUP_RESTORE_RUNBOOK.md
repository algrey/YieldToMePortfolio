# OPS-002 Backup, Export, Migration, and Restore Drill

This is an operator-led recovery procedure for YieldToMe. It is deliberately
not a Worker job and does not add R2, Queues, Workflows, or an automated export
destination. Never run a destructive restore against production during a
drill.

## Recovery targets

- Long-term export RPO: 24 hours, in addition to D1 Time Travel for recent changes.
- Operator-led restore RTO: 4 hours.
- Evidence: an access-controlled JSON file containing migration hashes, schema
  and table checksums, ownership counts, representative table counts, and
  read-only application smoke results. It contains no row payloads or secrets.
- Retention: encrypted exports follow the controlled backup store's 35-day
  rotating operational retention unless a later policy changes it.

## Preconditions and access control

1. Confirm the target is a non-production D1 database for the drill. Do not
   restore in place. A production restore overwrites the database.
2. Confirm the operator has the least-privileged Cloudflare and backup-store
   access needed for this run. Do not put API tokens, export passphrases, SQL
   exports, or evidence in the repository, terminal transcripts, or issue
   comments.
3. Record the application commit, Wrangler version, database name, operator,
   UTC start time, and the non-production restore database name in the drill
   record.
4. Confirm `npm run format:check`, `npm run lint`, `npm run typecheck`, and
   `npm test` pass for the application commit being drilled.

## Time Travel bookmark

Time Travel is enabled by D1. Capture a bookmark before a production migration
and after it, and retain both in the controlled operational record:

```sh
npx wrangler d1 info "$PRODUCTION_DB"
npx wrangler d1 time-travel info "$PRODUCTION_DB"
```

Save the returned bookmark and timestamp in the record. To recover from a
failed production change, stop writes, confirm the incident approval, and use
the exact bookmark only after a separate restore decision:

```sh
npx wrangler d1 time-travel restore "$PRODUCTION_DB" --bookmark="$BOOKMARK"
```

This command is destructive and is not part of a drill. Record the returned
previous bookmark so the operation can be undone if the incident decision
changes.

## Encrypted long-term export

Export to a temporary directory outside the repository. The export is plaintext
only until the encryption command completes, so keep the directory on an
operator-controlled machine and remove the plaintext promptly.

```sh
umask 077
WORK_DIR="$(mktemp -d)"
RAW_EXPORT="$WORK_DIR/yieldtome-$(date -u +%Y%m%dT%H%M%SZ).sql"
ENCRYPTED_EXPORT="$RAW_EXPORT.enc"

npx wrangler d1 export "$PRODUCTION_DB" --remote --output="$RAW_EXPORT"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 \
  -in "$RAW_EXPORT" -out "$ENCRYPTED_EXPORT"
chmod 600 "$ENCRYPTED_EXPORT"
shasum -a 256 "$ENCRYPTED_EXPORT" > "$ENCRYPTED_EXPORT.sha256"
```

Copy the encrypted export and checksum to the separately controlled backup
store using its approved access-controlled channel. Keep the passphrase out of
the export, checksum, repository, and shell history. Verify the checksum after
transfer, then remove the plaintext SQL and temporary directory according to
the operator workstation policy.

## Non-production restore and migration checklist

1. Create or select an isolated non-production D1 database. Confirm it cannot
   receive production traffic.
2. Download the encrypted export, verify its checksum, decrypt it locally, and
   import it into the isolated database:

   ```sh
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
     -in "$ENCRYPTED_EXPORT" -out "$WORK_DIR/restore.sql"
   npx wrangler d1 execute "$RESTORE_DB" --remote --file="$WORK_DIR/restore.sql"
   ```

3. Export the isolated restored database to a temporary SQL file for local
   verification:

   ```sh
   RESTORED_EXPORT="$WORK_DIR/restored.sql"
   npx wrangler d1 export "$RESTORE_DB" --remote --output="$RESTORED_EXPORT"
   ```

4. Apply the checked-in migrations to a fresh local SQLite database and compare
   the restored SQL schema against them. First create a redacted baseline from
   the decrypted export, then require the restored export to match its schema,
   row hashes, and ownership counts. The verifier also checks SQLite integrity,
   foreign keys, required representative tables, and application-level
   portfolio/transaction/snapshot/calculation ownership.

   ```sh
   SOURCE_EVIDENCE="$WORK_DIR/source-evidence.json"
   node --experimental-strip-types scripts/ops-002-restore-drill.ts \
     --input "$WORK_DIR/restore.sql" \
     --output "$SOURCE_EVIDENCE" \
     --require-table portfolios \
     --require-table transactions \
     --require-table portfolio_daily_snapshots \
     --require-table calculation_runs \
     --require-table audit_events

   node --experimental-strip-types scripts/ops-002-restore-drill.ts \
     --input "$RESTORED_EXPORT" \
     --output "$WORK_DIR/restore-evidence.json" \
     --expected-evidence "$SOURCE_EVIDENCE" \
     --require-table portfolios \
     --require-table transactions \
     --require-table portfolio_daily_snapshots \
     --require-table calculation_runs \
     --require-table audit_events
   ```

5. Review every failed check. A checksum mismatch, missing table, unexpected
   table, ownership violation, integrity failure, or empty required table is a
   failed drill. Do not waive it by editing the evidence.
6. Run the repository smoke suite against the drilled application commit:

   ```sh
   npm test
   ```

   The verifier's read-only smoke checks are the database-side part of this
   suite; they do not mutate or expose restored rows.

7. Remove decrypted SQL and temporary evidence from the workstation after the
   controlled evidence record is stored. Keep only the encrypted export and
   evidence according to the approved retention and access policy.

## Evidence and RPO/RTO record

Record the following with the verifier JSON, without adding either export or
evidence to this repository:

| Field                             | Value |
| --------------------------------- | ----- |
| Operator and approval             |       |
| Application commit                |       |
| Production database               |       |
| Restore database                  |       |
| Pre-migration bookmark            |       |
| Post-migration bookmark           |       |
| Export completed at (UTC)         |       |
| Restore/import started at (UTC)   |       |
| Restore/import completed at (UTC) |       |
| Verification completed at (UTC)   |       |
| Measured RPO                      |       |
| Measured RTO                      |       |
| Result and exceptions             |       |
| Evidence location and access list |       |

The measured RPO passes only when the long-term export age is at most 24 hours
at the recovery point. The measured RTO passes only when the restored database,
verification, and application smoke suite complete within four hours.
