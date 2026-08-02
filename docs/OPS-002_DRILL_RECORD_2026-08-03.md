# OPS-002 Non-production D1 Restore Drill — 2026-08-03

Result: **PASS**. The controlled drill used synthetic portfolio data in two
temporary, isolated D1 databases in the Oceania region. It did not read, write,
export, or restore either configured application database. Both temporary D1
databases were deleted after verification at `2026-08-02T23:18:33Z`.

## Recovery measurements

| Measure                  |        Target |             Observed | Result |
| ------------------------ | ------------: | -------------------: | ------ |
| Long-term export RPO     |      24 hours |  1 minute 59 seconds | PASS   |
| Operator-led restore RTO |       4 hours | 5 minutes 35 seconds | PASS   |
| Total drill duration     | Informational | 11 minutes 2 seconds | PASS   |

RPO is the age of the completed encrypted source export when the first restore
attempt began. RTO runs from that first restore attempt through restored-D1
verification and the complete repository check, including diagnosis and retry
of the raw-import ordering problem.

## Time Travel evidence

Exact pre/post bookmarks and temporary database IDs are retained in the
mode-`0600`, ignored operator drill record. These SHA-256 fingerprints allow the
record to be checked without committing operational bookmark values:

| Bookmark                            | SHA-256 fingerprint                                                |
| ----------------------------------- | ------------------------------------------------------------------ |
| Source before migrations            | `fd5be918b8ce4a2b44405270ba20fbe51bb8efb7052e8f886f0aa945e510b872` |
| Source after migrations and fixture | `7bfb632ea280a37b3433a359a319e175fedfb4da8944207d8e6e97a44841f472` |
| Restore target before restore       | `85281a5f2034ae6f0522ccf86e47011e751c00d46705b116187c07f4e4307b6f` |
| Restore target after restore        | `685a1731e0cffd4aff3123400e1ace01d81208f2ff77be48c6b64ddd6953838d` |

Cloudflare reported both databases on the production D1 storage subsystem,
which supports Time Travel. No Time Travel restore was executed because that
operation overwrites a database in place and is outside the non-destructive
drill.

## Encrypted export and transfer

- Export completed at `2026-08-02T23:09:46Z`.
- AES-256-CBC encryption used a salted PBKDF2 derivation with 600,000 iterations.
- Ciphertext size: 41,168 bytes.
- Ciphertext SHA-256: `6684824255857c1c0158a1274c08b27775c0d517318bb2f7716f8567bbc6b9cc`.
- Pre/post-transfer ciphertext hashes matched at `2026-08-02T23:10:03Z`.
- The encrypted synthetic export and checksum are retained in an ignored,
  mode-`0700` operator recovery store; the object and separately stored key are
  mode `0600`. Retention expires `2026-09-06T23:10:03Z`.
- Plaintext SQL and temporary Wrangler logs were removed after verification.

The drill used the existing authenticated Wrangler OAuth session and issued
only D1 commands. The session exposed broader account scopes than a dedicated
D1-only token; a dedicated scoped token should be used for the next scheduled
drill. This exception did not expose production data because the drill used
only synthetic, isolated resources.

## Restore and verification

The raw D1 export placed child rows before parent rows and failed direct import
with foreign-key enforcement. The restore therefore applied the 14 checked-in
migrations to the fresh target, generated dependency-ordered row inserts from
the decrypted export, and imported those rows. The verifier and runbook now
support this real D1 export shape, with regression coverage.

Verification passed for:

- all 26 application tables and the checked-in schema hash;
- source/restored row counts and SHA-256 hashes for every table;
- owner counts for all owner-scoped tables;
- 2 portfolios, 1 transaction, 1 portfolio snapshot, 1 calculation run, and 1 audit event;
- SQLite integrity, foreign keys, and portfolio, transaction, snapshot, and calculation ownership smoke checks;
- `npm run check`: formatting, lint, typecheck, Vinext compatibility, production build, and 116 tests.

The access-controlled full record and redacted verifier JSON remain under
`outputs/ops-002/evidence/20260802T230618Z/`; the encrypted export and key are
separately retained under the corresponding ignored operator stores.
