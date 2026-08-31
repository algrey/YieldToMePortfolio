---
name: project-backup-restore-design
description: Load-bearing invariants of the chunked system-backup restore (EXP-002/003/004) — derived keys, resume-in-place, fresh-account precondition — to check on any future backup/restore change
metadata:
  type: project
---

The system-backup restore is now a four-phase, browser-driven protocol
(scaffold → transactions parts → dividends parts → finalize) on top of a
FROZEN `SystemBackupV1` artifact; chunking is transport-level only.

**Why:** Cloudflare Workers Free 10 ms CPU per request (see
[[project-free-plan-constraints]]). EXP-003 chunked only prices; EXP-004
(2026-08-30) chunked the core after a real production 500 at transaction #63.

**How to apply:** when reviewing any later change to backup/restore, dividends,
`import_batches`, or `ledger.post/reverse/supersede`, these are the invariants
the whole design rests on — a change that breaks one is blocking:

- Row identity is the derived key `bundle:<fingerprint>:<ref>` in
  `transactions.idempotency_key` and (since EXP-004) in
  `dividend_manual_records.idempotency_key`. `fingerprint` is a sha256 hex of
  the bundle, so the resume `COUNT(*) ... LIKE 'bundle:<fp>:%'` needs no LIKE
  escaping — but that argument only holds because the LIKE call site uses the
  SERVER-computed fingerprint, not the client-echoed one the parts carry.
- Resume evidence is that live server-side count; the browser re-slices its
  chain-ordered array at it. Correctness depends on `chainOrder`
  (`domain/exports/chain-order.ts`) being deterministic and IDENTICAL on both
  sides, and on each bundle row producing exactly ONE keyed DB row.
- A `committing` `import_batches` row is the NORMAL state between parts. An
  interrupted portfolio is RESUMED IN PLACE; EXP-002's archive-and-recreate
  leftover handling was deleted. Merging a different backup into a half-restored
  portfolio is prevented only by `countUnrelatedPortfolios`' fresh-account
  precondition (a leftover from file A is "unrelated" to file B → 409).
- `income_whatif_scenarios` is deliberately create-only (no natural key), so
  finalize is idempotent only via its `status === 'committed'` short-circuit.
- The per-request budget is measured in D1 OPERATIONS, not local ms. Measured
  on the repo's own fixtures: one `ledger.post` replay ≈ 12-13 client calls /
  ~20 statements; a 20-row transactions part ≈ 243 calls / 403 statements and a
  50-row dividends part ≈ 203 / 253, both CONSTANT as the portfolio fills (I
  metered parts 0-20 … 100-120 — identical cost, no growth). The reference
  ceiling is the ~992 calls / ~1,534 statements request Cloudflare actually
  killed. A 100-row transactions part costs ~1,203 / ~2,003 — worse than the
  fatal one. Any future change that raises a part size must be re-metered.
- The SCAFFOLD request is the one thing that cannot be bounded by row count: it
  parses, validates and fingerprints the whole core payload once, because the
  fingerprint is frozen and is defined over the VALIDATED bundle. Its D1 work is
  small (~16 calls for 1 portfolio/1 security).
- The fingerprint's stability across the EXP-004 escalation rests on
  `validatePortfolioBundle` being idempotent w.r.t. `canonicalBundleJson`
  (verified empirically 2026-08-30). Any normalisation added to that validator
  that is not a fixed-point rewrites every derived idempotency key.
- Pre-EXP-004 partially-restored dividend rows have NULL `idempotency_key`;
  a resume over them fails closed with "a conflicting row already exists"
  (verified, not a duplicate) and needs manual cleanup.
