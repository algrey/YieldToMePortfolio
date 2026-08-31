---
name: project-d1-vs-node-sqlite-divergence
description: Production D1 enforces SQLite limits that node:sqlite raises, so a green test suite proves nothing about them — the LIKE pattern limit already caused one incident.
metadata:
  type: project
---

Every test in this repo runs against `node:sqlite`; production runs on
Cloudflare D1. **D1 enforces SQLite's DEFAULT compile-time limits;
`node:sqlite` raises several of them.** A query can therefore pass 2,600 local
tests and fail 100% of the time in production.

Known instance (production incident, EXP-004, 2026-08-31):

- `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` is **50 bytes** on D1, **50,000** on
  `node:sqlite`. A prefix count using
  `idempotency_key LIKE 'bundle:<64-hex-sha256>:%'` — 73 bytes — threw
  `D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR` on every
  production request while the suite stayed green.

**How to apply:**

- Never write `LIKE ?` / `GLOB ?` in `app/` or `db/repositories/`. A bound
  pattern has no statically knowable length. Use a half-open byte range
  instead: `col >= 'prefix' AND col < 'prefix' + nextByte` (e.g. `:` → `;`).
  It has no pattern limit, is exact under BINARY collation, and is
  index-friendly. `bundleKeyPrefixRange` in
  `app/portfolio-bundle-service.ts` is the worked example.
  `tests/exp-004.test.ts` has a structural guard test that scans both trees
  and fails on any bound pattern or an over-50-byte literal — extend that test
  rather than writing a new one if another limit bites.
- More generally: when a query works locally but a Worker 500s, suspect a
  limit divergence before suspecting logic or [[project-free-plan-cpu-budget]].
  Other D1-enforced defaults worth checking are variable count (999), column
  count, compound-SELECT terms, and expression depth.
- Behavioural tests cannot cover this class at all, because the local driver
  will not reproduce it. Guard it structurally, and verify the guard fails by
  reintroducing the defect before trusting it.
