# Portfolio bundle and full-system backup formats (EXP-001, EXP-002)

Normative for two related JSON backup/restore formats: the single-portfolio
export/import bundle delivered by `TASKS.md`'s `EXP-001`, and the
full-system backup delivered by `EXP-002` (which NESTS the EXP-001 bundle
format unchanged rather than reinventing it — see "Full-system backup
(EXP-002)" below). A new document rather than a `CSV_IMPORT_SPEC.md`
section because both are JSON, not CSV, and cover many tables at once
rather than one row shape — `CSV_IMPORT_SPEC.md` gets a short pointer to
this file instead of a duplicated section.

## Acceptance sentence (owner's own words)

> "If I export the historical prices and the portfolio, I should be able
> to recreate that portfolio with ALL of its functionality (ok if that
> occurs after a chron runs to generate something, but should not need new
> data)."

This bundle is the **portfolio** half of that pair. The **historical
prices** half is the pre-existing price-history backup
(MKT-008/IMP-010A, `/api/market-data/price-uploads/export` and the
"Price-history backup" section of the import page). Restoring both
together, then letting the calculation engine and provider quote fetches
run once, reproduces the portfolio's functionality without any new data
being typed in.

## Investigation findings (required before-the-fact per the task)

1. **Cap Gains sub-tab (CGT-004).** `app/owned-capital-gains.ts` reads
   `tax_lots`/`lot_allocations` written by the calculation-run pipeline
   over the published `projection_publications` pointer. Both tables are
   populated exclusively by re-running the FIFO lot-matching engine over
   `transactions` — nothing on the Cap Gains tab is owner-typed. It is
   **purely derived**, so nothing capital-gains-specific is in this
   bundle; replaying the transaction ledger (which the bundle carries in
   full, including reversal/supersession chains) and letting the
   calculation engine run again reproduces the identical Cap Gains tab.
2. **Watchlist scope.** `watchlist_entries` (`db/schema.ts`) has a
   `user_id` column and **no `portfolio_id` column at all** — it is
   account-scoped, not portfolio-scoped (the WLT-001 header comment on
   `db/repositories/account-lifecycle.ts`'s `OWNED_TABLES` confirms this
   is deliberate: "owner-scoped watchlist — interest only, never a
   position"). Excluded from this single-portfolio bundle; in scope for
   `EXP-002`'s full-account backup instead.
3. **Table-by-table classification.** See the table below — every
   `OWNED_TABLES` entry (`db/repositories/account-lifecycle.ts`) is
   accounted for.
4. **FY start month is NOT portfolio data.** `user_settings.
financial_year_start_month` (`db/schema.ts`) is explicitly "a per-user
   setting only; there is no per-portfolio override." The owner's EXP-001
   directive lists "FY start month" among the portfolio settings to
   export, but it structurally cannot be — it applies to every portfolio
   of this owner at once. It is exported as **informational context only**
   (`portfolio.financialYearStartMonthAtExport`) and is never restored on
   import (restoring it would silently rewrite the importing owner's
   account-wide FY convention for every other portfolio too).

## Owned-table classification (EXP-001, single-portfolio bundle)

Every table in `db/repositories/account-lifecycle.ts`'s `OWNED_TABLES`
checklist, classified IN the bundle / EXCLUDED-derived (regenerates) /
EXCLUDED-price (covered by the price-history backup) / EXCLUDED-other
(with reason). **This table is EXP-001's own single-portfolio classification
only** — the two rows marked "known gap" below (`dividend_receipts`,
`manual_overrides`) are re-investigated for EXP-002's full-system scope in
that section's own coverage table further down; see there for whether
EXP-002 closes either gap.

| Table                                                                                                                                                                                 | Classification             | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user_settings`                                                                                                                                                                       | EXCLUDED-other             | Account-level, not portfolio-scoped; out of EXP-001's single-portfolio scope (candidate for EXP-002).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `user_identities`                                                                                                                                                                     | EXCLUDED-other             | Account-level auth identity, not portfolio data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `portfolios`                                                                                                                                                                          | **IN**                     | Identity fields: name, code, base currency, timezone, accounting method, `history_complete_from`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `portfolio_settings`                                                                                                                                                                  | **IN**                     | `quote_staleness_policy` (a row is optional; genuinely unused by any current read path in this codebase — grepped clean — but restored when present for `OWNED_TABLES` completeness).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `portfolio_securities`                                                                                                                                                                | **IN**                     | Exported as "resolution facts" (source symbol/exchange/currency + the linked security's ticker/ISIN/Sharesight-instrument identifiers and canonical name) — re-resolved on import via the same create-if-absent machinery BRK-009B's Sharesight auto-resolution uses, never by ticker text alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dividend_receipts`                                                                                                                                                                   | EXCLUDED-other (known gap) | A dormant/legacy table: `db/repositories/import-commit.ts`'s own header comment states dividend rows now write `dividend_manual_records` exclusively ("why not `dividend_receipts`"), and no current write path in this codebase inserts new rows here. It is still read as one evidence tier by `domain/dividends/history.ts`, so a portfolio with old pre-migration receipts would see a real (if small) evidence gap after restore. **Not implemented in this v1** — flagged to the Orchestrator; check `SELECT COUNT(*) FROM dividend_receipts WHERE portfolio_id = ...` before relying on EXP-001 for a portfolio that predates the `dividend_manual_records` migration.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dividend_security_assumptions`                                                                                                                                                       | **IN**                     | Per-security yield/franking/growth overrides, including the DIV-016 `force_assumption` flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `dividend_portfolio_assumptions`                                                                                                                                                      | **IN**                     | Portfolio-level growth assumption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `dividend_fy_overrides`                                                                                                                                                               | **IN**                     | Owner-entered FY actual-income corrections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `dividend_event_overrides`                                                                                                                                                            | **IN**                     | Tied to the shared `dividend_events` table by ID; verified to still exist at import time (same-deployment restore only — see "Design decisions" below), honestly skipped and counted if the referenced provider event is gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dividend_manual_records`                                                                                                                                                             | **IN**                     | Full supersession chains (`superseded_by_record_id` links), import batch/source-reference provenance, BRK-010 foreign-currency fields. Originally-manual rows replay through the owner-dialog `create()` path and stay editable; see "Design decisions".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `dividend_import_franking_overrides`                                                                                                                                                  | **IN**                     | BRK-011 owner-entered franking-currency corrections, tied to this bundle's own replayed `dividend_manual_records` rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sharesight_sync_state`                                                                                                                                                               | EXCLUDED-other (KNOWN GAP) | **The two claims previously recorded here were both wrong** (corrected 2026-08-31, EXP-005). It is NOT account-level: `db/schema.ts` gives it a `NOT NULL` `portfolio_id` with a composite FK to `(portfolios.id, portfolios.userId)`, so it is per-portfolio state that belongs in the nested portfolio bundle. It does NOT regenerate on the next sync: `linkSharesightPortfolio`/`linkExclusive` (`app/sharesight-sync-service.ts`, reached only from the `/import` Sharesight panel) is the only writer that CREATES a row, and the sync's own `upsert` runs after reading an existing link — a sync cannot run without one. Confirmed in production 2026-08-31: a full-system restore reproduced the `sharesight_instrument` identifiers and both source settings but left zero rows here, so Sharesight prices stayed silent until the owner re-linked by hand. Only "no token material" was correct (credentials live in Worker secrets, `worker/sharesight-config.ts`) — which argues for inclusion. EXP-005 scopes carrying `sharesight_portfolio_id`/`enabled` only. |
| `sharesight_delayed_prices`                                                                                                                                                           | EXCLUDED-price             | Price cache/freshness gate; covered by the price-history backup and provider re-fetch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sharesight_pending_payouts` (BRK-022)                                                                                                                                                | EXCLUDED-derived           | A pure sync-time OBSERVATION cache of announced-but-unpaid Sharesight payouts, not a ledger fact; `upsertObserved` re-derives it in full on the very next Sharesight sync after a restore, once the owner re-links the portfolio (see the `sharesight_sync_state` row above) -- the same reasoning `sharesight_delayed_prices` above gives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `intraday_price_points`                                                                                                                                                               | EXCLUDED-price             | Intraday capture cache; regenerates via the capture cron.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `price_upload_batches`                                                                                                                                                                | EXCLUDED-price             | Bookkeeping for the price-history CSV upload flow itself; the price data it attributes is what the price-history backup already exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `import_batches`, `import_commit_chunks`, `import_rows`, `import_issues`, `import_mapping_decisions`                                                                                  | EXCLUDED-other             | The SOURCE portfolio's own historical CSV-import audit trail. Not needed for functionality (the transactions/dividends those imports created are already in the bundle via `transactions`/`dividend_manual_records`); a fresh set of these rows is created for the bundle-import batch itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `transactions`                                                                                                                                                                        | **IN**                     | Full ledger, including reversal/supersession chains, replayed via the same `post`/`reverse`/`supersede` repository functions the app itself uses (never a second write path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ledger_mutation_guards`, `manual_ledger_mutation_keys`                                                                                                                               | EXCLUDED-derived           | Idempotency/concurrency guard bookkeeping tied to specific historical requests; regenerates as new writes happen and carries no standalone financial meaning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cash_accounts`, `cash_ledger_entries`                                                                                                                                                | EXCLUDED-derived           | Pure byproducts of posting a transaction (created automatically by `ledger.post`/`reverse`/`supersede`); replaying the transactions above regenerates them identically — never a second, independently-typed fact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `manual_overrides`                                                                                                                                                                    | EXCLUDED-other (known gap) | Owner-entered price/FX quote corrections (MKT-014's correction dialog; `type IN ('price','fx_rate')`). Genuinely owner-authored, but PRICE-domain data that the existing price-history backup (MKT-008) does not currently cover either (it only backs up `price_observations` CSV rows, not this override mechanism) — a real gap in the price-backup story, not something EXP-001's non-price bundle should paper over. Flagged as a follow-up for MKT-008/EXP-002.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `portfolio_daily_snapshots`, `holding_daily_snapshots`, `calculation_runs`, `snapshot_publications`, `projection_publications`, `tax_lots`, `lot_allocations`, `holding_projections`  | EXCLUDED-derived           | The calculation-run pipeline's output over `transactions`; regenerates once the pipeline (re-)runs, byte-identical for the same ledger facts. Includes the Cap Gains tab's own data (finding 1 above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `watchlist_entries`                                                                                                                                                                   | EXCLUDED-other             | Account-scoped, not portfolio-scoped (finding 2 above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `income_whatif_scenarios`                                                                                                                                                             | **IN**                     | Saved what-if scenario inputs only (never a computed projection).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `portfolio_value_history`                                                                                                                                                             | EXCLUDED-derived           | HIST-002's persisted cache of the read-time historical-value derivation; regenerates from `transactions`/price data on the next read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `users` (special-cased)                                                                                                                                                               | EXCLUDED-other             | Internal account record, not portfolio data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `price_observations`, `fx_rate_observations` (special-cased, `scope_user_id`)                                                                                                         | EXCLUDED-price             | Covered by the price-history backup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `market_data_refresh_jobs` (special-cased)                                                                                                                                            | EXCLUDED-derived           | Operational refresh-job bookkeeping; regenerates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `security_provider_mappings` (special-cased, `verified_by_user_id`)                                                                                                                   | EXCLUDED-derived           | A verification ATTRIBUTION on the shared, deployment-wide `securities`/`security_identifiers` master, not owner data; re-resolution/re-verification regenerates equivalent mappings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `audit_events` (special-cased)                                                                                                                                                        | EXCLUDED-other             | A redacted historical log of actions taken, not a portfolio fact needed for functionality; replaying this bundle's writes naturally produces its OWN new audit trail for the import action. The original historical trail is not reconstructed (default-excluded per the task's own instruction; documented here).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `account_lifecycle_requests`, `account_export_*`, `account_purge_*` (special-cased)                                                                                                   | EXCLUDED-other             | Account-lifecycle/export-job control state, unrelated to portfolio functionality.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `currencies`, `exchanges`, `securities`, `security_identifiers`, `market_data_providers`, `dividend_events`, `split_events`, `corporate_action_refresh_state` (shared reference data) | EXCLUDED-other             | Deployment-shared, not owner data; `portfolio_securities`'s resolution facts (above) carry enough identity to re-resolve/re-create the relevant `securities`/`security_identifiers` rows on import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Bundle shape (schema version 1)

One JSON file per portfolio (browser download, `content-type:
application/json`), shape defined in `domain/exports/portfolio-bundle.ts`
(`PortfolioBundleV1`):

```
{
  "schemaVersion": 1,
  "exportedAt": "<server-stamped request-now, ISO-8601>",
  "portfolio": {
    "name": "...", "code": "...", "baseCurrencyCode": "AUD",
    "timezone": "...", "accountingMethod": "fifo",
    "historyCompleteFrom": "YYYY-MM-DD" | null,
    "financialYearStartMonthAtExport": 7,  // informational only, see finding 4
    "status": "active" | "archived"        // see changelog note below
  },
  "portfolioSettings": { "quoteStalenessPolicy": string | null },
  "securities": [ { "ref": "...", "sourceSymbol": "...", ... } ],
  "transactions": [ { "ref": "...", "securityRef": "...", "reversesRef": "...|null", "supersedesRef": "...|null", ... } ],
  "dividendManualRecords": [ { "ref": "...", "securityRef": "...", "supersedesRef": "...|null", "wasImported": bool, ... } ],
  "dividendSecurityAssumptions": [ ... ],
  "dividendPortfolioAssumption": { ... } | null,
  "dividendFyOverrides": [ ... ],
  "dividendEventOverrides": [ ... ],
  "dividendImportFrankingOverrides": [ ... ],
  "whatifScenarios": [ ... ]
}
```

Every decimal field is a validated decimal string (never JS binary
floating point). `ref` fields are bundle-local identifiers (not the
source database's row IDs) used only to preserve chain topology within
the file; the server assigns fresh IDs on import. `MAX_BUNDLE_ENTITIES`
(20,000, `domain/exports/portfolio-bundle.ts`) and
`MAX_BUNDLE_REQUEST_BYTES` (32 MiB) are the measured-bytes/row-count caps,
mirroring `domain/market-data/price-backup-csv.ts`'s
`DEFAULT_PRICE_BACKUP_LIMITS` precedent — a personal-portfolio-scale
ceiling, not a platform limit; a portfolio that genuinely exceeds it would
need chunked/resumable commit, which this v1 does not implement (see
below).

No secrets are exported: every field above is a financial/identity fact
the owner already sees in the app; there is no credential, token, or
provider-session material in this table set.

**Changelog**: `portfolio.status` added (B2 ruling, 2026-08-27, part of
EXP-002's review) — `schemaVersion` stayed `1` rather than bumping, since
this format has never shipped to a real deployment (no external consumer to
break). OPTIONAL on input for forward tolerance (a bundle without the field
validates as `"active"`, the pre-B2 behaviour); ALWAYS present on a
validated bundle's output.

## Restore (import)

Staged → previewed → validated → idempotent → batch-attributable →
reversible, per `AGENTS.md`'s CSV non-negotiables, applied to a JSON
bundle instead of CSV rows:

- **Staged/previewed**: the browser reads the uploaded file as text and
  `JSON.parse`s it only (no CPU-heavy parsing is needed for JSON, unlike
  CSV) and POSTs it to `/api/portfolio-bundle/import/preview`, which
  reports entity counts, the base-currency precondition, and whether this
  exact bundle was already imported — with **zero DB writes**.
- **Validated**: the server (`domain/exports/portfolio-bundle.ts`'s
  `validatePortfolioBundle`) is the sole structural validation authority
  (IMP-010B) — every field is re-checked from scratch, never trusted
  because it parsed as JSON. In-bundle referential integrity is part of
  that check: a chain ref naming a row the bundle does not contain, and a
  reversal/supersession graph that refers back to itself (a cycle or
  self-reference, only reachable from a corrupted/hand-edited file), are
  both rejected before any database write — never partially imported as
  mutually-superseding rows that would silently vanish from evidence. `POST /api/portfolio-bundle/import/commit`
  re-validates independently of the preview call.
- **Idempotent**: the bundle's canonical JSON (keys sorted at every level,
  `domain/exports/portfolio-bundle.ts`'s `canonicalBundleJson`) is
  SHA-256-fingerprinted; the fingerprint is stored on a new
  `import_batches` row (`parser_format = 'portfolio-bundle-json'`,
  `parser_version = '1'`, reusing that table's existing
  `(user_id, file_sha256, parser_format, parser_version)` unique index).
  Re-importing the identical bundle for the same owner finds the
  already-`committed` batch and returns its existing portfolio as a
  no-op — never a duplicate. (`BRK-020`, 2026-09-03: that index is now
  PARTIAL, `WHERE status <> 'reversed'`, see `docs/DATA_MODEL.md`. The
  restore path is unaffected — it reads the key with a plain `SELECT` and
  only ever `INSERT`s when no row exists at all — but "structurally
  impossible" below now holds for non-reversed rows only.)
- **Batch-attributable**: at the PORTFOLIO level. A bundle-import always
  creates a brand-new portfolio (see "Design decisions"), so
  `import_batches.target_portfolio_id` names the ONE batch that created
  every row in it — a simpler, equally honest attribution than CSV
  import's per-row `import_row_id` linkage (which is CSV-row-shaped and
  does not fit a multi-table bundle). Every replayed `dividend_manual_
records` row additionally carries that batch's `import_batch_id`
  directly (that table's own native provenance column).
- **Reversible**: undo a bundle import by **archiving the portfolio it
  created** (the pre-existing `archivePortfolioAction` /
  `POST` portfolio-archive flow). Since import always creates a fresh
  portfolio, archiving it removes 100% of what the import wrote, reusing
  already-tested machinery rather than a bespoke per-row reversal.

### Security re-resolution

Every `securities` entry in the bundle is re-resolved via
`db/repositories/security-resolution.ts`'s `resolveAndLink` — the SAME
create-if-absent machinery BRK-009B's Sharesight auto-resolution uses
(strict ticker/ISIN/Sharesight-instrument match → same-owner ticker+
currency match → cross-owner ticker+currency match on the shared
`securities` master → genuine creation, guarded on ticker+currency, never
ticker text alone). A ticker is never treated as a durable ID on its own.

### Transaction/dividend chain replay

Transactions are replayed **in `createdAt` order** through the exact same
`ledger.post`/`reverse`/`supersede` repository functions the app itself
uses (never a second write path) — a row with `reversesRef`/`supersedesRef`
set is always processed after the row it targets, since a reversal or
supersession can only ever have been created strictly after its target in
the source portfolio. Each replayed transaction's idempotency key is
derived as `` `bundle:<fingerprint>:<ref>` `` — deterministic, so a second
commit of the identical bundle naturally dedupes at the ledger layer too.

Dividend manual records are replayed via
`buildDividendManualRecordImportInsertStatements` (the same builder
CSV/Sharesight dividend imports use) for **every** row, followed by a
`superseded_by_record_id` link-up pass once both ends of a chain exist.

BUG-022/BUG-021 consequence: a legacy dividend record or franking override
whose amount exceeds `DECIMAL_LIMITS.inputScale`/`inputDigits` — creatable
only before those two tasks closed every writer at that bound — now fails
the whole restore part with the typed "could not be replayed" failure
instead of silently importing an unreadable figure; the remedy is
correcting the offending record in the source account before exporting it
again.

## Design decisions (flagged to the Orchestrator, not silently assumed)

1. **Import always creates a NEW portfolio** from the bundle's own
   identity; it never targets an existing portfolio. A brand-new
   portfolio is trivially "empty", satisfying the collision policy's
   simplest honest form (see below) without general pre-existing-row
   collision detection against an arbitrary target. If the owner wants
   "restore into this specific empty portfolio I already created" later,
   that is a follow-up, not implemented here.
2. **Base currency precondition.** `db/repositories/owned-portfolios.ts`'s
   `create()` always sets the new portfolio's base currency to the
   owner's CURRENT `user_settings.home_currency_code` — there is no
   parameter to request a different one. If the bundle's own recorded
   `baseCurrencyCode` disagrees with the owner's current home currency,
   commit is **rejected** (409, actionable message: change your home
   currency first) rather than silently creating a portfolio whose base
   currency doesn't match what the bundle's amounts assume.
3. **Collision policy**: since import always targets a fresh portfolio,
   there is no pre-existing-data collision to resolve in this v1 — the
   "simplest honest v1: require an empty target, reject otherwise"
   language in `TASKS.md`'s EXP-001 entry is satisfied structurally.
   Re-importing the identical bundle is the one legitimate "collision",
   handled by the idempotency check above (no-op, never a silent merge).
4. **Editability preserved by write path.** A dividend row that was
   ORIGINALLY manual (`import_batch_id IS NULL` in the source) replays via
   the SAME owner-dialog `create()` repository function the manual-entry
   UI itself uses, keeping it dialog-editable after restore. A row that
   was ORIGINALLY imported replays via the import-insert builder
   (`buildDividendManualRecordImportInsertStatements`), matching its own
   original non-editable status. This is lossless: `create()`/`supersede()`
   never write the BRK-010 foreign-currency fields
   (`currencyCode`/`fxRateToPortfolioDecimal`/`fxRateSource`) at all, so a
   manual row can never have carried them — an earlier version of this
   design routed every row through the import-insert builder "for
   fidelity," which in fact bought nothing (those fields were always null
   on a manual row) while costing every restored manual row its
   editability and its "manual" evidence-source label; reviewer-caught and
   corrected. `superseded_by_record_id` chain links replay identically
   regardless of which path created either end (a manual ancestor later
   reconciled by an imported successor, DIV-016 part C, replays correctly).
5. **Tombstoned dividend rows stay excluded (never resurrected).**
   DIV-016A's DELETE semantics allow head-deleting a row, which can leave
   an ancestor's `superseded_by_record_id` pointing at an id that no
   longer exists — a deliberate, permanent exclusion from evidence
   (DATA_MODEL "DELETE semantics"). The bundle carries this as an explicit
   `supersededByDeletedRecord: boolean` on the ancestor row (the deleted
   successor cannot be exported — it doesn't exist — so without this flag
   the exclusion is invisible and the ancestor would import as ordinary,
   live, un-superseded income). On import, a tombstoned row's
   `superseded_by_record_id` is repointed at a freshly generated,
   genuinely non-existent id (the column carries no FK constraint),
   recreating the identical dangling-pointer/permanently-excluded shape.
   Reviewer-caught (B1): the pre-fix version silently resurrected a
   tombstoned ancestor's income on every restore.
6. **A failed/interrupted commit is retryable**, not permanently bricked.
   Re-POSTing the identical bundle after a `failed` or still-`committing`
   attempt reuses and resets that SAME `import_batches` row (fresh
   `target_portfolio_id`, status back to `committing`) rather than trying
   to `INSERT` a second row for the same
   `(user_id, file_sha256, parser_format, parser_version)` — which the
   table's own unique index makes structurally impossible, so an earlier
   version of this design's "just re-import" remedy could never actually
   run (reviewer-caught, B2). This is safe because every transaction/
   dividend natural key this module derives is scoped to the (freshly
   created) destination `portfolio_id`, so replaying into a brand-new
   portfolio on retry can never collide with anything a failed attempt
   already wrote. Any portfolio a failed attempt already created is left
   in place (not auto-archived) for the owner to clean up manually.
7. **`portfolio_securities` display/status fields are restored**, not just
   used for security re-resolution. `resolveAndLink` always inserts a
   fresh link with `status = 'held'` and every display/relevant-date
   column NULL; commit follows up with an owner-scoped `UPDATE` applying
   the bundle's own `status`/`displaySymbol`/`displayName`/
   `firstRelevantDate`/`lastRelevantDate` (reviewer-caught, B5 — without
   this, a hidden or watch-only security would wrongly reappear in
   Holdings after restore). One exception: `status = 'unresolved'` cannot
   be restored literally — `portfolio_securities_resolution_check`
   requires `security_id IS NULL` for that status, and `resolveAndLink`'s
   result structurally always has a real `security_id` — so an
   originally-`unresolved` row is left at the freshly-linked `held`
   default instead.
8. **No chunked/resumable mid-commit progress.** Commit processes the
   whole bundle in one server request/loop, not the CSV pipeline's
   chunked, resumable, high-water-mark commit — a THROWN failure partway
   through does not resume from where it left off (decision 6 above makes
   a full RETRY safe, but the retry starts over, not resumes). Flagged as
   a follow-up if the entity-count ceiling proves too tight in practice
   for a real portfolio.
9. **`dividend_receipts` and `manual_overrides` are known gaps** — see the
   classification table above. Both are genuinely owner-scoped tables not
   covered by this v1; flagged rather than silently dropped.

## Tests

`tests/exp-001.test.ts`: export reads every included table plus the
reversal and dividend-supersession chains; a cross-user export probe
(404, never another owner's data); round-trip export → import into a
fresh portfolio → row-count parity and chain-topology parity (the
reversal's target is still present and still `reversed`; the dividend
supersession chain is still linked); idempotent double-import (second
commit is a no-op targeting the SAME portfolio, no duplicate created);
base-currency-mismatch rejection; malformed/schema-version-mismatched
bundle rejection at structural validation; an over-`MAX_BUNDLE_ENTITIES`
bundle rejection.

# Full-system backup (EXP-002)

Owner directive (verbatim): "Then do a full system backup and restore
export / import. Is should back up everything need to restore the system
for ALL portfolios." Primary use case: migrating the owner's complete local
D1 database onto a fresh production deployment. Unlike EXP-001's bundle
(which pairs with the pre-existing price-history backup and is explicitly
NOT sufficient alone), **this artifact must be sufficient alone** — one
downloaded file, restorable into a genuinely empty deployment with no other
input required.

## Cloudflare Workers Free transfer protocol (EXP-003)

The artifact remains `SystemBackupV1`; no schema version changed. Only the
browser/server transfer protocol is different:

- Export fetches the account/portfolio core once and owner-scoped price rows
  in deterministic 500-row pages. The browser formats the existing
  `yieldtome-price-backup-v1` CSV, embeds it in the existing
  `priceBackupCsv` field, and downloads one JSON file.
- Preview parses the price CSV in the browser with the shared MKT-008 parser
  and sends the price-free core to the existing server validator. Every price
  row is still revalidated by the server's unchanged MKT-008 validator before
  any write.
- Confirm restores the price-free core first, then sends price history in
  sequential 200-row requests with a short browser yield between them. Each
  request uses the existing owner-scoped resolution, natural-key upsert,
  attribution, and value-history invalidation path. Rows within one file are
  ordered provider/symbol/date, so a single consecutively-unresolvable symbol
  can fill an entire 200-row part; each chunked request is marked `chunked:
true` so a fully-unresolved part advances with `written: 0` instead of
  hard-failing the whole restore (review B2 fix, 2026-08-28) — the standalone
  "Historical Data" whole-file backup restore does not set this flag, so a
  genuinely unresolvable whole-file upload there still fails closed as
  before.
- The browser stores `{nextChunk, written, unresolvedRowCount,
unchangedCount, batchIds}` under a SHA-256 digest of the selected file — the
  id of every price-upload batch the completed parts actually created, no
  backup contents/prices/names. Because the digest depends only on the FILE,
  not the restore target, a resume is honored only after a cheap owner-scoped
  probe (`GET /api/market-data/price-uploads`) confirms every claimed batch
  id still exists on the CURRENT server; any mismatch (a fresh deployment, or
  the owner having undone the earlier restore) discards the cursor and
  restarts at chunk 0 with zeroed totals rather than silently skipping
  unwritten rows (review B3 fix, 2026-08-28). An ambiguous last request is
  otherwise safe to retry because writes are natural-key idempotent.
- D1 Free's daily row-write allowance can be lower than the physical writes
  needed for a large price history once index writes are included. A restore
  that reaches that allowance pauses honestly and can resume after the quota
  resets at 00:00 UTC. This is resumability, not a claim that waiting seconds
  increases the daily allowance.

## Cloudflare Workers Free CORE transfer protocol (EXP-004)

EXP-003 (above) paged only the PRICE section — the core commit (account
settings, every portfolio's securities/transactions/dividends/overrides/
scenarios, watchlist) remained one unbounded request, an explicitly recorded
EXP-003 follow-up ("(i) the core commit remains one unbounded request; only
the price section was paged"). This became a production incident on the
Free plan: restoring a real backup (1 portfolio, 107 transactions, 119
dividend records) hit HTTP 500 at transaction #63, the request's 10ms CPU
budget exhausted mid-replay, leaving 63 transactions committed and no way to
resume other than starting the whole portfolio over. EXP-004 makes the CORE
commit resumable/chunked the same way EXP-003 already made price restore
resumable/chunked, WITHOUT changing the `SystemBackupV1` artifact format —
chunking is transport-level only, exactly like EXP-003's own price paging.

### Part decomposition

One system-backup restore now proceeds as four kinds of request instead of
one:

1. **Scaffold** (one request, covers every nested portfolio): the
   fresh-account precondition, `user_settings` overwrite, and for EACH
   portfolio bundle — its destination portfolio (create-once, reuse
   thereafter), `portfolio_settings`, and every security's `resolveAndLink`
   resolution/`portfolio_securities` restoration (`commitPortfolioBundleScaffold`,
   `app/portfolio-bundle-service.ts`) — then the watchlist. Bounded by
   portfolio + security COUNT, never transaction/dividend count. Its
   DATABASE work is what that bound describes: the request still receives,
   parses, validates and fingerprints the whole core payload once (see
   "What the scaffold actually costs" below). Returns each portfolio's
   destination id, its `securities` ref→id map (the browser needs this for
   every later part), and resume evidence — **corrected 2026-09-04, OPS-005:**
   the actual resume mechanism is `missingTransactionRefs`/
   `missingDividendRefs` (server-computed, in current chain order);
   `committedTransactionCount`/`committedDividendCount` are LIVE counts kept
   only as an informational/diagnostic figure — see "Resume evidence" below.
2. **Transactions part** (one portfolio, 20 rows/request —
   `TRANSACTIONS_RESTORE_CHUNK_ROWS`, `system-backup-panel.tsx`):
   `commitPortfolioBundleTransactionsPart` replays a bounded, already
   chain-ordered (`domain/exports/chain-order.ts`) slice via the SAME
   `ledger.post`/`reverse`/`supersede` calls the whole-bundle path always
   used.
3. **Dividends part** (one portfolio, 50 rows/request —
   `DIVIDENDS_RESTORE_CHUNK_ROWS`): `commitPortfolioBundleDividendsPart`
   replays a bounded, chain-ordered slice via the SAME manual-create/
   import-insert paths as before.
4. **Finalize** (one portfolio, once every transactions/dividends part for
   it has completed): `commitPortfolioBundleFinalize` — dividend
   supersession linkage + tombstone exclusion, per-security/portfolio
   assumptions, FY/event/franking overrides, saved what-if scenarios,
   archiving to match the bundle's own exported status, and marking that
   portfolio's `import_batches` row `committed`. Small-cardinality data,
   bounded by override/scenario counts, not transaction count.

### Chain ordering (`domain/exports/chain-order.ts`)

Both the whole-bundle path and the chunked path replay a portfolio's
transactions (and its dividend records) in the order `chainOrder` computes
from the bundle's own explicit `ref` graph — never a `createdAt` sort, whose
millisecond ties are routine and whose UUID tiebreak has no relation to
dependency order.

**Corrected 2026-09-04, OPS-005:** this section originally said the browser
slicer (`system-backup-panel.tsx`) imports this module so both sides of a
chunked restore compute a byte-identical order. That stopped being true in
OPS-005 round 2 (and was never safely sufficient — a chain-order change
straddling a deploy could desynchronise the two sides' independently
recomputed orders regardless). The panel no longer imports `chain-order.ts`
at all; it sends back exactly the `missingTransactionRefs`/
`missingDividendRefs` the server names in its scaffold response (see "Resume
evidence" below), so only the SERVER ever computes chain order for a
resumed restore.

The ordering rule, since `BUG-018` review round 2: **a reversal or
supersession is emitted immediately after the transaction it targets**, and
transitively its own dependents, before any other unrelated root. Unrelated
roots — and sibling children of one parent — keep the same deterministic
`createdAt`-then-`ref` order they always had.

The immediacy is load-bearing, not cosmetic. `BUG-018` narrowed
`transactions_portfolio_source_reference_unique` to
`WHERE status <> 'reversed'`, so a portfolio may legitimately hold a
REVERSED original and a re-imported TWIN sharing one `source_reference`.
The earlier breadth-first traversal emitted every root before any child —
[reversed original, twin, mirror] — which posted the twin while the
original was still `posted`, and the partial index rightly rejected it: a
perfectly valid exported portfolio failed to restore with
"A transaction could not be replayed (conflict)". Depth-first emits
[original, mirror, twin]: the reversal that FREES the key is replayed before
the row that reuses it.

A chunk boundary falling between an original and its reversal is safe. The
chunked path never resolves a dependency from in-process state: it looks its
target up in the database by the derived idempotency key
(`bundle:<fingerprint>:<ref>`, `findTransactionIdByRef`), so a dependency
written by an EARLIER part — or by an earlier, interrupted attempt at the
same part — resolves normally. What the ordering must guarantee is only that
a dependency is never in a LATER part than its dependent, which the slicing
of this single ordered array gives directly.

### The actual production root cause: D1's LIKE pattern limit

Confirmed from `wrangler tail` on 2026-08-31, after the part-size work below
had already shipped: every scaffold request threw

```
D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
```

Resume evidence (`committedTransactionCount`/`committedDividendCount`) was
counted with `idempotency_key LIKE 'bundle:<fingerprint>:%'`. That pattern is
`"bundle:"` (7 bytes) + a 64-character sha256 digest + `":%"` (2 bytes) = **73
bytes**, and production D1 enforces SQLite's default
`SQLITE_LIMIT_LIKE_PATTERN_LENGTH` of **50 bytes**. Every scaffold therefore
500'd before writing anything — which is why the owner's D1 never changed
across attempts, and why this ALSO means the original EXP-004 code never got
past scaffold in production: the part-size defect described below was real,
but had never been reached.

This was invisible to the test suite because `node:sqlite` raises the same
limit to 50,000, so the identical query passes locally forever. The fix
replaces the pattern match with a half-open byte range — no pattern matching,
therefore no pattern limit:

```sql
idempotency_key >= 'bundle:<fp>:' AND idempotency_key < 'bundle:<fp>;'
```

`;` is `:` + 1 in byte order, so the range covers exactly the prefix and
excludes a sibling fingerprint that shares the literal `bundle:` prefix. No
`idempotency_key` column declares a `COLLATE`, so SQLite's default BINARY
collation applies and the range is both exact and index-friendly on
`transactions_owner_portfolio_idempotency_unique`. `bundleKeyPrefixRange`
(`app/portfolio-bundle-service.ts`) owns the two bounds.

`tests/exp-004.test.ts` guards the whole class structurally, since no
behavioural test on `node:sqlite` ever can: it scans every module under
`app/` and `db/repositories/` and fails on any `LIKE`/`GLOB` with a BOUND
pattern (length unknowable) or a literal pattern over 50 bytes.

### Per-request work census (EXP-004 correction, 2026-08-30)

EXP-004 originally shipped both part sizes at 100 rows as an unmeasured
"starting point". Measured against a production-shaped payload (1 portfolio,
18 securities, 107 transactions, 119 dividend records, ~124 KB core), that
was the reason a restore STILL could not finish on the Free plan. The unit
that matters is the number of D1 operations one request performs — each
statement is marshalled and its results parsed inside the isolate, so it
costs CPU whether or not it is sent inside a `batch()`:

| Request                                                                                                        | D1 client calls | SQL statements |
| -------------------------------------------------------------------------------------------------------------- | --------------- | -------------- |
| **Reference: the pre-EXP-004 single core commit Cloudflare killed** (scaffold pass + 63 `ledger.post` replays) | ~992            | ~1,534         |
| Scaffold (fresh account, 18 securities)                                                                        | 173             | 211            |
| Scaffold (resume into an existing destination)                                                                 | 64              | 65             |
| Transactions part, 100 rows (EXP-004 as shipped)                                                               | **1,303**       | **2,103**      |
| Transactions part, 20 rows (now)                                                                               | 263             | 423            |
| Dividends part, 100 rows (EXP-004 as shipped)                                                                  | 403             | 503            |
| Dividends part, 50 rows (now)                                                                                  | 203             | 253            |
| Finalize (119 dividend linkage items)                                                                          | 123             | 123            |
| Price chunk, 200 rows (EXP-003, unchanged)                                                                     | 65              | 457            |

One `ledger.post` replay costs ~13 client calls / ~21 statements: inventory
and decimal validation, the transaction and its cash entry, audit rows, and
the queued `calculation_runs` siblings. So EXP-004's own 100-row
transactions part performed MORE database work in one request than the
single old-code request that had already been terminated — the part size,
not the payload handling, was the dominant defect. 20 transaction rows /
50 dividend rows keep every core request at roughly a quarter of that
known-fatal request, comparable to the 200-row price chunk EXP-003 already
proved in the same budget. `tests/exp-004.test.ts`'s "per-request work
census" test pins this: it meters a real full-size part and fails if either
part ever approaches half the known-fatal figure again.

Local timings are NOT Workers CPU accounting and are not used as the
budget; the operation census above is the portable measure. For reference
only, removing the scaffold's redundant passes (below) cut its own
non-database JS from ~4.0 ms to ~2.9 ms per request on a development
machine.

### What the scaffold actually costs

Correcting an overstatement in EXP-004's original text: the scaffold's
_writes_ are bounded by portfolio + security count, but the REQUEST is not
bounded that way. It receives the entire core payload and must, once:

- read and JSON-parse the body (`readSystemBackupRequestBody`);
- run `validateSystemBackup` over the whole artifact — the account block,
  the watchlist, and every nested bundle's rows via the unchanged
  `validatePortfolioBundle`;
- canonicalise and SHA-256 each nested bundle (`fingerprintBundle`), because
  the fingerprint is both the fresh-account precondition's relatedness key
  and the `bundle:<fingerprint>:<ref>` namespace every later part writes
  under.

That work is O(total rows) and irreducible: the fingerprint is frozen (live
accounts already hold rows keyed with it) and it is defined over the
VALIDATED bundle, so it cannot be derived without validating. What was
reducible was doing it more than once. Until this correction the scaffold
ran `validateSystemBackup` AND `validatePortfolioBundle` over the same
bundles, fingerprinted each bundle TWICE, and serialised each one a third
time purely to compute `import_batches.byte_size`. It now validates once,
canonicalises once (`fingerprintBundleWithByteLength`, which returns the
byte size from the same canonical bytes — `sortKeysDeep` only reorders keys,
so that length is byte-identical to the previous `JSON.stringify` length,
pinned by test), and passes both into
`commitValidatedPortfolioBundleScaffold`.

Validation authority is unchanged by that split. `validatePortfolioBundle`
is idempotent, so the removed second pass could only ever re-confirm the
first; the scaffold passes the OUTPUT of validation onward, never a raw wire
value; and every row-writing part still fully validates its own rows
independently, as below.

Every part independently re-validates its OWN inputs against the live
database (IMP-010B: chunking must never move validation authority to the
browser) — `commitPortfolioBundleTransactionsPart`/`...DividendsPart` re-run
`validateTransaction`/`validateDividendManualRecord`
(`domain/exports/portfolio-bundle.ts`, exported for this reuse) on every row,
verify the target portfolio belongs to the authenticated owner, and verify
every `portfolioSecurityId` the browser echoes back from scaffold actually
belongs to that owner/portfolio before writing anything.

Since this correction they ALSO verify the browser-held
`batchId`/`fingerprint`/`portfolioId` triple against the owner's own
`import_batches` row (`requireOwnedRestoreBatch`, one indexed lookup). The
fingerprint half had been trusted verbatim even though every idempotency key
a part writes is derived from it — a stale or garbled value would not have
failed, it would have silently begun a SECOND, unresumable copy of the
owner's ledger beside the first. Finalize makes its already-`committed`
decision from that same read rather than a second one.

### Idempotent identity per row type

Every write is either ALREADY idempotent by an EXISTING natural/derived key
(reused unchanged), or gained one under this task per the binding design
constraint ("if no idempotent identity exists for a row type, pick the
smallest sound one and document it here"):

- **Transactions**: unchanged — `bundle:<fingerprint>:<ref>` (already the
  whole-bundle path's own derived `idempotencyKey`), enforced by
  `transactions_owner_portfolio_idempotency_unique`. A reversal/
  supersession's TARGET transaction is looked up by this SAME key via a
  direct, owner/portfolio-scoped query rather than an in-process `Map` —
  necessary because a `Map` cannot survive a Worker request boundary once
  target lookup and the write that created the target land in DIFFERENT
  HTTP requests.
- **Dividend manual records**: EXTENDED. The whole-bundle path only ever set
  `idempotency_key` for the owner-dialog CREATE path (`wasImported: false`);
  the import-insert path (`wasImported: true`) relied solely on
  `dividend_manual_records_portfolio_source_reference_unique` — sufficient
  when a doomed retry always replayed into a brand-new portfolio (see
  "Resume strategy" below), but NOT sufficient once a retry can legitimately
  resend an already-written row into the SAME portfolio: a raw unique-index
  hit is not itself a graceful "already done" signal. EXP-004 sets the SAME
  derived key, `bundle:<fingerprint>:<ref>`, as `idempotency_key` on EVERY
  dividend manual record this replay creates, regardless of path
  (`buildDividendManualRecordImportInsertStatements` gained an optional
  `idempotencyKey` field for this; `db/repositories/dividends.ts`'s
  `createDividendManualRecordRepository` gained an exported
  `getByIdempotencyKey` to look it up later, scoped by
  `(portfolio_security_id, idempotency_key)` per the existing
  `dividend_manual_records_security_idempotency_unique` index). This key is
  purely a replay-dedupe mechanism; the row's own `source_reference`
  (preserved verbatim when the ORIGINAL import already recorded one) is
  untouched.
- **Securities**: unchanged — `resolveAndLink`'s own natural-key
  (`portfolio_id`, `source_symbol`, `source_exchange_alias`,
  `source_currency_code`) check, safe to re-run on every scaffold call
  including a resume.
- **Watchlist / account settings**: unchanged from EXP-002 (already
  idempotent by construction on every prior retry path too).
- **What-if scenarios**: genuinely NO natural key (`income_whatif_scenarios`
  is deliberately create-only — "an owner may genuinely want two scenarios
  with the same name", `db/repositories/income-scenarios.ts`'s own `save()`
  comment). `commitPortfolioBundleFinalize` short-circuits as a whole no-op
  once its batch already reads `committed`, which covers the common retry
  case (the browser never saw an earlier successful response). The narrow
  residual gap — a crash PARTWAY through one finalize call's own body,
  before the final status flip, followed by a retry — could duplicate a
  what-if scenario. Accepted, not fixed: this is non-ledger planning data,
  never a transaction/dividend/holding figure, and finalize's own body is
  small (bounded by override/scenario counts) so this window is narrow.

### Resume strategy: resume in place, not archive-and-recreate

**Superseded design note**: EXP-002/EXP-003's own retry strategy (see
"Failure isolation and retry" above) ARCHIVED a leftover portfolio from a
failed/interrupted attempt and replayed into a BRAND-NEW one on every retry
— correct and necessary for a single-shot whole-portfolio commit, where a
non-`committed` batch could only mean an abandoned attempt (nothing durable
beyond a possibly-empty destination portfolio could exist yet). EXP-004
makes this the WRONG strategy: a chunked restore deliberately leaves a
`committing` `import_batches` row with REAL, wanted transactions/dividends
between every part request — archiving it on resume would DESTROY genuine
progress, which is the exact failure mode this task exists to prevent.

`commitPortfolioBundleScaffold` therefore REUSES an existing
`target_portfolio_id` whenever one is already recorded for this bundle's
fingerprint (regardless of `committing`/`failed`/`committed` status) rather
than resetting it — the destination portfolio, its code, and every
already-written row all stay exactly as they are; only the missing
transactions/dividends get written by the parts that follow.
`findLeftoverPortfolioForRetry`/`archiveLeftoverPortfolio` (the machinery
this replaces) have been deleted as dead code, not left running alongside
the new strategy. The fresh-account precondition
(`countUnrelatedPortfolios`) is UNCHANGED in behavior (any-status
relatedness still applies) but no longer needs its own "exclude an archived
leftover" carve-out, since there is no longer a leftover to exclude.

This is exactly what makes EXP-004 correct against the production
incident's own aftermath: the account currently has a portfolio with ~63 of
107 transactions committed under the OLD, unchunked code. Re-running the
SAME backup file after this deploy computes the SAME fingerprint and the
SAME per-row derived keys the old code already used, so scaffold recognizes
and resumes into that exact portfolio, and the transactions/dividends parts
write only the missing rows — no wipe, no duplication, no manual
intervention required (though the owner may still choose to wipe and retry
clean).

### Resume evidence: server-derived, not a client-trusted cursor

Unlike EXP-003's price-chunk cursor (a browser-held `{nextChunk, ...,
batchIds}` claim, honored only after a separate server probe confirms the
claimed batch ids still exist), the CORE restore needs no client-side cursor
at all for correctness. Every scaffold call — fresh or resumed, even after a
browser reload mid-restore — returns LIVE counts
(`committedTransactionCount`/`committedDividendCount`, a direct
`COUNT(*) ... WHERE idempotency_key LIKE 'bundle:<fingerprint>:%'` query
against the target portfolio) of rows ALREADY durably written under this
bundle's own derived-key namespace. The browser always re-derives "how much
is left" by slicing its own chain-ordered array at that count
(`orderedTransactions.slice(committedTransactionCount)`), never from
anything stored in `localStorage`. A stale or wrong client-side guess can
therefore never skip real, unwritten rows — at worst it would resend
already-written rows, which every write tolerates as a cheap no-op via the
idempotency keys above. `system-backup-panel.tsx` still relies on
`ledger.post`/`reverse`/`supersede`'s existing built-in idempotency-key
short-circuit for a mid-part interruption (the SAME part resent after a
crash replays already-written rows as no-ops and continues from there),
exactly as the whole-bundle path already did within one request.

**Correction (2026-09-03, BUG-018 round 3):** this guarantee holds only when
the scaffold call that produced the count and the client's own slice are
both served by the same build -- the count is server-derived and safe on its
own, but the slice index is meaningful only against the chain order that
produced it, and BUG-018 round 2 changed that order from breadth-first to
depth-first (see `docs/ARCHITECTURE.md`'s BUG-018 entry). A chunked CORE
restore interrupted before this task's round-2 depth-first `chainOrder` fix
is deployed must be started over from scratch, not resumed, once the new
build is live.

**Superseding correction (2026-09-04, OPS-005, extended round 2 the same
day):** the same-build condition above is now REMOVED, not merely documented
as a hazard -- resume no longer depends on any chain order agreeing across
two requests at all, for EITHER the transactions or the dividends phase.
`commitPortfolioBundleScaffold` recomputes the bundle's chain order fresh on
every call (never carried over from an earlier request) and, for each ref in
that order, runs a bounded, chunked, owner-scoped existence probe
(`listMissingRefsByIdempotencyKey`, one shared helper parameterised only by
table) against `transactions.idempotency_key` and, separately,
`dividend_manual_records.idempotency_key` (`bundle:<fingerprint>:<ref>`,
chunked at <=50 refs per `IN (...)` lookup -- e.g. a 200-transaction
portfolio costs 4 SELECT statements). The scaffold response's
`missingTransactionRefs` and `missingDividendRefs` fields are the actual
resume mechanism for their respective phases: every ref not yet written,
already in the server's own current chain order. `system-backup-panel.tsx`
sends exactly each list back on its following part(s) -- it no longer
derives "what remains" from `committedTransactionCount`/
`committedDividendCount` sliced against its own locally recomputed chain
order for EITHER phase (round 1 fixed only the transactions phase; a
reviewer reproduced the identical hazard still standing in the dividend
phase the same day, closed here). Both committed-counts are kept only as
informational/diagnostic figures (now derived from their own probe, so
neither can ever disagree with its corresponding missing-refs list).

Because resume is now a ref-membership question ("is this specific row
durably written?") rather than a position question ("how many rows are
before the cut?"), it is correct regardless of which chain order -- old
breadth-first, new depth-first, or any future change -- wrote the rows
already on disk. The operational rule above (start over rather than resume
across this specific deploy) no longer applies to any FUTURE chain-order
change; it is retained only as a historical record of the hazard this fix
closes.

Defence in depth: `commitPortfolioBundleFinalize` runs the identical
existence probe over every transaction ref the bundle carries (a
`transactionRefs` field, mirroring `dividendLinkage`'s pre-existing role for
dividends) before doing anything else, and fails closed -- a typed 409
naming how many refs are missing, marking the batch `failed`, never
`committed` -- if any are absent. This catches a transactions part silently
skipped, replayed out of order, or a row removed between parts by some other
means, exactly as the pre-existing dividend-linkage re-lookup already
protects the dividend side.

**Hardening (2026-09-04, OPS-005 round 2, F1):** the existence probes above
only ever proved that every ref the CLIENT claimed to have sent was actually
written -- they never proved the client's claimed list was itself complete.
A client finalizing with a genuinely SHORTER `transactionRefs`/
`dividendLinkage` list than the bundle actually contains passed both probes
trivially (the omitted rows were simply never checked) and could reach
`committed` with silently fewer rows than the backup file described.
`commitPortfolioBundleScaffold` now additionally persists, onto four new
nullable `import_batches` columns (`bundle_transaction_refs_digest`/`_count`
and `bundle_dividend_refs_digest`/`_count` -- migration
`0061_ops_005_bundle_ref_digests.sql`, a plain `ALTER TABLE ... ADD COLUMN`),
a sha256 digest and count over the bundle's OWN sorted transaction refs and,
separately, its sorted dividend refs -- recomputed and overwritten on every
scaffold call from the same fingerprinted bundle content, so a resume can
never disagree with an earlier scaffold's own write. `commitPortfolioBundleFinalize`
now compares the client-supplied ref lists' own digest+count against this
persisted, server-derived record BEFORE running the existence probes above,
failing closed with a typed 409 naming the expected-vs-received count
difference on any mismatch. A legacy batch scaffolded before this migration
landed has NULL digests; finalize treats that as "cannot verify" and skips
this comparison rather than failing closed on a batch it has no record for
(see `docs/DATA_MODEL.md`).

### Partial-failure messaging (per-phase, honest)

Each phase reports failure with wording specific to what actually happened
(`system-backup-panel.tsx`): a transactions/dividends part failure names the
portfolio and part index and states that completed work is safe (naming the
D1 daily-write-limit/00:00 UTC reset, mirroring EXP-003's own price-chunk
message); a scaffold failure states that any already-prepared portfolio
stays prepared; a finalize failure states that the portfolio's transactions/
dividends are already safely restored and only its final annotations/status
remain. This targets EXP-003's own recorded follow-up (g) ("`fetchJson`'s
non-JSON error copy claims chunk progress was saved even on ... paths with
no chunks") for the NEW core-restore call sites this task adds — the
generic price-chunk wording was accurate only for price chunks; it is not
reused verbatim for scaffold/finalize, which are not "chunks" in the same
sense even though they ARE safely resumable.

### Legacy whole-core commit path

`commitSystemBackupImport` (`app/system-backup-service.ts`) still exists,
but is no longer reachable over HTTP — `commitSystemBackupImportAction` and
its dedicated route dispatch were removed; `/api/system-backup/import/commit`
now dispatches the four phases above by a `phase` field
(`system-backup-actions.ts`'s `commitSystemBackupCorePartAction`). The
function itself was rewritten to COMPOSE the same scaffold/parts/finalize
functions in one call (never a second, independent write path) and is kept
only as a non-chunked convenience for tests and any future non-HTTP caller.

## Design: reuse, not reinvention

`domain/exports/system-backup.ts` / `db/repositories/system-backup.ts` /
`app/system-backup-service.ts` implement EXP-002 as an ORCHESTRATION layer
over THREE pieces of already-shipped, unchanged machinery, never a second
implementation of anything they already do:

1. **Every portfolio** — one bundle per portfolio, in the artifact's
   `portfolios` array, each validated with EXP-001's own
   `validatePortfolioBundle` (`domain/exports/portfolio-bundle.ts`,
   byte-identical schema) and committed with EXP-001's own
   `commitPortfolioBundleImport` (`app/portfolio-bundle-service.ts`) —
   unmodified. Every EXP-001 guarantee (chain replay order, idempotency-key
   derivation, failed-batch retry, security re-resolution,
   `portfolio_securities` display/status restoration, tombstone handling)
   applies per nested portfolio exactly as it does for a standalone EXP-001
   import.
2. **Price history** — the artifact's `priceBackupCsv` field is the
   pre-existing MKT-008 backup CSV TEXT verbatim
   (`domain/market-data/price-backup-csv.ts`'s `formatPriceBackupCsv`
   output), parsed with the unchanged `parsePriceBackupCsv` and committed
   with the unchanged `confirmBackupPriceUpload`
   (`app/price-upload-service.ts`) — the SAME function the standalone
   "Price-history backup" import-page section calls. This is what the task
   meant by "reuse the 64MiB backup ceiling rationale... do not invent new
   resumability": price-history rows are never re-parsed or re-resolved by
   a second implementation.
3. **Account settings and watchlist** — genuinely NEW EXP-002 code
   (`db/repositories/system-backup.ts`), since EXP-001 deliberately excluded
   both as account-scoped, not portfolio-scoped (see the classification
   table above).

## Coverage table (extends EXP-001's classification above)

Every `OWNED_TABLES` row EXP-001 marked `EXCLUDED-other` for being
account-level (not portfolio-scoped) is re-classified here for the
full-system artifact. Rows unmentioned below are unchanged from the
EXP-001 table (still `EXCLUDED-derived`/`EXCLUDED-price`/`EXCLUDED-other`
for the SAME reasons — regenerated data, or genuinely excluded — since
EXP-002 nests EXP-001's bundle unchanged for every portfolio-scoped table).

| Table                                                                  | Classification                              | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_settings`                                                        | **IN**                                      | Home currency, timezone, holding-currency-view preference, FY start month, price-source preference, daily-capture source/interval — the full account-configuration row, restored via one direct `UPDATE` (see "Restore order" below). Account-level, so this is EXP-002's job, not EXP-001's (finding 4 above still applies to the nested per-portfolio bundle's own informational `financialYearStartMonthAtExport` field).                                                                                                                                                                                                                                                                                                                                                              |
| `watchlist_entries`                                                    | **IN**                                      | Both `kind`s: currency pairs restore unconditionally (identity-only, no security dependency); securities restore only when they resolve against the shared `securities` master AFTER portfolios have been restored (most commonly because one of THIS backup's own portfolios just re-created/matched that same security) — see "Watch-only security limitation" below for the genuine v1 gap.                                                                                                                                                                                                                                                                                                                                                                                            |
| `price_observations`, `fx_rate_observations` (user-scoped-observation) | **IN (via price-history backup reuse)**     | `price_observations` rides the embedded `priceBackupCsv` section (point 2 above) — MKT-008's format does not currently export/restore `fx_rate_observations` (currency-pair quotes) at all; the owner's real backup has 0 such rows, so this is a genuine but currently-empty gap, flagged rather than silently assumed covered. A restored watchlist currency pair does NOT get its rate re-primed automatically (restore makes no live provider calls by design — see "No network calls" below); it shows `unavailable` until the existing WLT-001/MKT-021 refresh path runs (documented pre-existing gap, not new here).                                                                                                                                                               |
| `dividend_receipts`                                                    | EXCLUDED-other (known gap, re-investigated) | Still 0 rows for the owner. Re-investigated for EXP-002: this table has NO live write path anywhere in the current codebase (confirmed again — `import-commit.ts`'s own header comment states dividend rows write `dividend_manual_records` exclusively) and no existing repository function builds a replay-safe INSERT for it. Building one from scratch, for a table with a genuinely dormant write path and zero real rows, is not "trivially includable" — it would be new, untested write machinery for a legacy table nothing currently populates. **Not closed in EXP-002 either** — same documented gap as EXP-001, carried forward honestly rather than silently dropped a second time.                                                                                         |
| `manual_overrides`                                                     | EXCLUDED-other (known gap, re-investigated) | Still 0 rows for the owner. Re-investigated: this table is NOT cleanly portfolio- or account-scoped — `portfolio_id` and `security_id` are BOTH nullable, `type` spans four kinds (`price`, `fx_rate`, `security_mapping`, `transaction_fx`) each with a different `value_json` shape, and rows form their OWN supersession chain (`supersedes_override_id`) independent of every other chain this backup already replays. Correctly restoring it would need a THIRD, type-aware replay path (distinct from both the per-portfolio bundle's chain replay and the account-level watchlist/settings restore) — a materially new design surface, not a cheap fold-in for a 0-row table. **Not closed in EXP-002** — flagged to the Orchestrator as a real gap if this table ever gains rows. |

Every other `OWNED_TABLES` entry keeps its EXP-001 classification
unchanged: portfolio-scoped facts (`portfolios`, `portfolio_settings`,
`portfolio_securities`, `transactions`, `dividend_manual_records` and its
sibling override tables, `income_whatif_scenarios`) travel inside each
nested portfolio bundle exactly as EXP-001 already exports/restores them;
derived/regenerable data (`portfolio_daily_snapshots`,
`calculation_runs`, `tax_lots`, `portfolio_value_history`, etc.) stays
excluded (regenerates once the calculation engine and provider quote
fetches run, per the acceptance sentence's own "ok if that occurs after a
chron runs" allowance); operational/attribution bookkeeping
(`import_batches`, `security_provider_mappings`, `audit_events`,
account-lifecycle/export/purge control state) stays excluded for the same
reasons EXP-001 gives. `sharesight_sync_state` was listed here too until
2026-08-31; it is a KNOWN GAP rather than an operational-bookkeeping
exclusion — see its own row in the classification table above and EXP-005.
`users` (the internal account
record itself) stays excluded — restore always targets an EXISTING
authenticated account (see "Precondition" below), never creates one.

Every table in `OWNED_TABLES` (37 entries) plus the 6 special-cased tables
EXP-001's own table documents is now accounted for: **IN** (this bundle or
the price-history backup), **EXCLUDED-derived** (regenerates), or
**EXCLUDED-other** (with reason, both gaps carried forward honestly).
No unclassified table remains.

## Artifact shape (schema version 1)

One JSON file (browser download, `content-type: application/json`), shape
defined in `domain/exports/system-backup.ts` (`SystemBackupV1`):

```
{
  "schemaVersion": 1,
  "exportedAt": "<server-stamped request-now, ISO-8601>",
  "account": {
    "homeCurrencyCode": "AUD", "timezone": "...",
    "defaultHoldingCurrencyView": "native" | "home",
    "financialYearStartMonth": 7,
    "priceSourcePreference": "sharesight_delayed" | "yahoo_anonymous" | "yahoo_authenticated",
    "dailyCaptureSource": "sharesight" | "yahoo_anonymous" | "yahoo_authenticated",
    "dailyCaptureIntervalMinutes": 30 | 60
  },
  "watchlistEntries": [
    { "kind": "security", "tickerIdentifier": "...", "isinIdentifier": "...|null",
      "sharesightInstrumentId": "...|null", "currencyCode": "AUD", "canonicalName": "...|null" },
    { "kind": "currency_pair", "baseCurrencyCode": "USD", "quoteCurrencyCode": "AUD" }
  ],
  "portfolios": [ /* EXP-001 PortfolioBundleV1, unchanged, one per portfolio */ ],
  "priceBackupCsv": "format_version,provider_id,...\r\n...\r\n"  // MKT-008 CSV text verbatim
}
```

`MAX_SYSTEM_BACKUP_PORTFOLIOS` (200, `domain/exports/system-backup.ts`) is a
personal-account-scale ceiling on the outer `portfolios` array, mirroring
EXP-001's `MAX_BUNDLE_ENTITIES` reasoning; each nested bundle is
independently capped at `MAX_BUNDLE_ENTITIES` already.
`MAX_SYSTEM_BACKUP_REQUEST_BYTES` (64 MiB) reuses
`app/price-upload-request-body.ts`'s `MAX_BACKUP_REQUEST_BYTES` rationale
verbatim: price history dominates this artifact's size (the owner's real
export is a ~142 KB portfolio-bundle section plus a ~6.1 MiB price-history
section — well inside the ceiling, measured on the real account below), and
that number is already the one place this codebase accepts a
price-history-shaped payload of this scale.

No secrets are exported: every field is a financial/identity/preference
fact the owner already sees in the app, identical in kind to what EXP-001
and MKT-008 already export separately.

## Restore (import)

Staged → previewed → validated → idempotent → batch-attributable →
reversible, per `AGENTS.md`'s CSV non-negotiables, composed from THREE
already-compliant pieces rather than re-implemented:

- **Staged/previewed**: the browser reads the file as text and
  `JSON.parse`s it, POSTing to `/api/system-backup/import/preview` — zero
  DB writes. The preview reports per-portfolio counts, status (active/
  archived), and base-currency agreement, watchlist counts, price-history
  row/malformed counts (parsed but NOT resolved against the owner's
  securities — those do not exist yet before any portfolio has been
  committed, so an "unresolved" figure at preview time would be
  structurally misleading), the precondition check result (see below), and
  (S2 fold) a per-field "current → new" disclosure of every account setting
  this restore will unconditionally overwrite — the backup's own recorded
  values alongside the account's CURRENT live values (`currentAccount`,
  read live, zero writes), so the owner sees exactly what changes before
  confirming.
- **Validated**: `domain/exports/system-backup.ts`'s `validateSystemBackup`
  is the sole structural authority (IMP-010B) — schema version, account
  settings (each field type/enum-checked), watchlist entries (per-kind
  shape, at least one durable identity fact for a security entry), and
  every nested portfolio bundle via EXP-001's OWN unchanged
  `validatePortfolioBundle` (so a malformed nested bundle is rejected with
  the SAME per-field messages EXP-001 already gives, prefixed with which
  portfolio index failed). `POST /api/system-backup/import/commit`
  re-validates independently of the preview call.
- **Idempotent** — composed from three ALREADY-idempotent pieces, no new
  system-level fingerprint/table needed:
  - each nested portfolio bundle keeps its OWN EXP-001 fingerprint
    (`fingerprintBundle`, computed from that bundle's own canonical JSON)
    and OWN `import_batches` row; re-committing the identical system
    backup re-derives the SAME per-portfolio fingerprints and EXP-001's own
    `findExistingBatch` short-circuits each as a no-op.
  - watchlist adds are idempotent by construction
    (`createOwnedWatchlistRepository`'s `addSecurity`/`addCurrencyPair`,
    unchanged, WLT-001).
  - price-history rows converge via the pre-existing EFF-001 write-avoidance
    inside `writePriceUploadObservations` (unchanged) — a re-restore writes
    a fresh `price_upload_batches` bookkeeping row (as any repeat price
    backup upload already does) but `unchangedCount` reflects that no
    `price_observations` row actually changed.
  - account settings are unconditionally overwritten to the backup's own
    recorded values on every commit (first-time or retry) — applying the
    same values twice is a no-op in effect; see "Precondition" for why this
    is safe.

  **S3 fold (2026-08-27): a price section with rows in the file but ZERO of
  them resolving to a restored security is a legitimate, non-fatal
  outcome, never a 409 for a restore whose other pieces already
  committed.** `confirmBackupPriceUpload` (MKT-008, unchanged) itself
  hard-fails when nothing resolves — correct for a STANDALONE price-backup
  upload (nothing to do IS suspicious there) but wrong here: this module
  previews resolution FIRST (`previewBackupPriceUpload`, zero DB writes) and,
  when nothing would resolve, skips the write entirely and reports
  `written: 0` with an explanatory `note` in the commit result rather than
  failing the whole restore — the SAME "no usable price history is honest,
  not an error" reasoning the empty-CSV-section case already applies.
  `malformedCount` and `unresolvedRowCount` are always reported alongside
  `written`/`unchangedCount` (S1 fold — the commit result line mirrors
  MKT-008's own price-backup panel's disclosure).

- **Batch-attributable**: at the PIECE level, reusing existing attribution
  rather than inventing a system-level batch row (no migration needed) —
  each portfolio via its OWN `import_batches` row (EXP-001), price history
  via its OWN `price_upload_batches` row (MKT-008), watchlist adds via the
  existing per-add `audit_events` rows (WLT-001), account settings via a
  new `audit_events` row (`settings.restored_from_backup`) written in the
  same guarded batch as the `user_settings` `UPDATE`.
- **Reversible** — composed, stated honestly rather than claiming one
  bespoke undo:
  - each restored portfolio: archive it (EXP-001's own reversal story,
    unchanged — `archivePortfolioAction`).
  - restored price-history rows: delete the price-history backup's own
    upload batch (MKT-008's existing `deleteOwnedPriceUpload`/"Delete this
    upload" affordance in the Price-history backup section) — works
    identically for a system-restore-originated batch, since it is the
    SAME `price_upload_batches` mechanism.
  - restored watchlist entries: remove them individually from the
    Watchlist tab (the existing per-entry remove affordance) — no bespoke
    "undo the whole restored watchlist" action exists; each entry's own
    removal is already reversible and version-guarded.
  - restored account settings: **no automated undo**. Unlike a portfolio or
    a price-history batch, settings have no "batch" shape to revert as a
    unit — the owner would need to manually reset each field (Settings
    page) to whatever it was before restoring. This is an honestly
    documented gap, not a silent one: restore's own PRECONDITION (below)
    means settings only ever get overwritten on what was, by definition, a
    fresh account with default/just-configured settings — the practical
    blast radius of "no automated settings undo" is low precisely because
    the precondition never lets restore touch a populated account's real
    settings.

### Precondition: restore targets a FRESH account

Mirrors EXP-001's own fail-safe philosophy ("don't merge into populated
accounts"), stated precisely at the ACCOUNT level: restore is rejected
(409) unless every ACTIVE portfolio the target account currently has is
traceable to ONE of THIS backup's own nested portfolio bundles via an
`import_batches` row (`db/repositories/system-backup.ts`'s
`countUnrelatedPortfolios`, reusing EXP-001's own attribution table — no
new migration). Concretely:

- A genuinely empty account (zero active portfolios) always passes.
- An account whose ONLY active portfolios are the product of a PRIOR
  attempt (successful OR interrupted/failed) at this EXACT backup also
  passes — this is what makes retrying an INTERRUPTED restore actually
  work (see "Failure isolation and retry" below).
- An account with ANY other pre-existing ACTIVE portfolio — one the owner
  created independently, or one from a DIFFERENT backup — fails closed with
  an actionable count, before any write (settings, watchlist, and every
  portfolio all stay untouched on a precondition failure).
- Archived portfolios are never counted toward "unrelated" at all (B2
  ruling: they are exported/restored as real data, not excluded — see
  "Archived portfolios" below; and B1 ruling: this is also what keeps a
  cleaned-up leftover from a prior interrupted attempt, once archived by
  this module's own retry cleanup, from tripping the precondition on a
  later run — its `import_batches` row has by then been re-pointed at the
  NEW portfolio the successful retry created, so it is only reachable by
  fingerprint through its `active` status, which this rule excludes).

**B1 ruling (2026-08-27): relatedness is checked by fingerprint against an
`import_batches` row of ANY status** (`committed`, `committing`, or
`failed`), not only `committed`. The realistic migration-restore failure is
an INTERRUPTION mid-replay (a Worker timeout, a transient DB error, or a
ledger-level rejection partway through a longer transaction list) — "start
over with a fresh account" is not an acceptable remedy for that, so the
precondition itself must not block the very retry it exists to allow: an
interrupted attempt's own leftover portfolio is `active` and its batch row
is `failed`/`committing`, not `committed` — restricting relatedness to
`committed` would make that leftover count as "unrelated" and permanently
block every subsequent retry.

Watchlist and settings do not get their OWN separate precondition check:
the portfolio-level precondition is what keeps the blast radius of
"settings get unconditionally overwritten" and "watchlist adds are
idempotent, never merged against conflicting existing entries" acceptable
— a "not fresh" account is rejected before either is ever touched.

### Archived portfolios

**B2 ruling (2026-08-27): archived portfolios are DATA, not noise.**
`exportSystemBackup` includes every portfolio regardless of status (one
nested EXP-001 bundle each); EXP-001's own bundle format gained an
additive `portfolio.status: "active" | "archived"` field to carry this
(`domain/exports/portfolio-bundle.ts` — `schemaVersion` stays `1`: this
format has never shipped to a real deployment, so there is no compatibility
concern to a version bump). `commitPortfolioBundleImport` restores an
archived source portfolio AS archived — the LAST step of that portfolio's
own commit (after every other write, so the full ledger/dividend/
assumption/scenario replay runs through the exact same write paths an
active restore uses; nothing in this codebase's repositories checks
portfolio status before writing). An archived portfolio round-trips
archived, never silently resurrected active.

### Restore order

Account settings → each portfolio (array order, one nested
`commitPortfolioBundleImport` call at a time) → watchlist → price history.
**EXP-004 note**: this describes `commitSystemBackupImport`'s own (now
test-only, non-HTTP) composed call order. The actual browser-driven HTTP
protocol interleaves differently — ONE scaffold request covers account
settings + every portfolio's own destination/securities + watchlist
together, THEN each portfolio's transactions/dividends/finalize follow as
separate requests — see "Cloudflare Workers Free CORE transfer protocol
(EXP-004)" below for the real sequencing.
Settings restore FIRST guarantees every nested portfolio's own
EXP-001 base-currency precondition (bundle currency must equal the
account's CURRENT home currency) is checked against the just-restored
value, not a fresh account's arbitrary default. Watchlist and price history
restore AFTER every portfolio, since watchlist security resolution and
price-history security matching both depend on the securities those
portfolios just created/resolved.

**Known inherited limitation**: if the backup's portfolios were originally
in DIFFERENT base currencies than the account's single home-currency
setting (a multi-currency multi-portfolio owner), only the portfolio(s)
matching the JUST-restored home currency commit; the rest reject with
EXP-001's own actionable currency-mismatch message. This is EXP-001's own
precondition, unmodified — not a new EXP-002 defect. A retry after manually
changing the home currency in Settings resumes correctly (the precondition
above still recognizes the already-committed portfolios as accounted-for).
The owner's real account is single-portfolio/single-currency, so this does
not affect the acceptance/real-data results below.

### Failure isolation and retry (atomic per piece, not atomic for the whole artifact)

**Superseded by EXP-004** (see "Cloudflare Workers Free CORE transfer
protocol (EXP-004)" below): the archive-and-recreate retry strategy this
section documents applied to the single-shot whole-core commit
(`commitPortfolioBundleImport`, still used by EXP-001's own standalone
per-portfolio bundle import UI, unaffected). The system-backup restore's OWN
core commit now goes through EXP-004's resumable scaffold/transactions/
dividends/finalize functions instead, which RESUME an interrupted portfolio
in place rather than archiving it — this section is retained for historical
context (why the original design worked the way it did) but no longer
describes current CORE-restore behavior.

Portfolios commit ONE AT A TIME in the backup's own array order. The FIRST
portfolio failure stops the whole commit immediately: account settings and
any EARLIER portfolios already committed are left in place (never rolled
back); watchlist and price history are never even attempted for that
commit call. The failure message names which portfolio (1-based index and
name) failed and how many portfolios were already restored and remain in
place. This mirrors EXP-001's own documented lack of whole-bundle atomicity
(`docs/BACKUP_FORMAT.md`'s EXP-001 "Design decisions" #8 above), extended
honestly to the multi-portfolio case rather than claiming a stronger
guarantee EXP-001 itself does not provide.

**B1 ruling (2026-08-27): retries must actually work, including for a
portfolio that failed AFTER its own portfolio row was already created**
(e.g. a ledger-level rejection partway through a longer transaction list —
`commitPortfolioBundleImport` sets `target_portfolio_id` immediately after
creating the destination portfolio, well before transaction replay
finishes). Before retrying ONE nested bundle,
`findLeftoverPortfolioForRetry` (`db/repositories/system-backup.ts`) reads
that bundle's own `import_batches` row (by fingerprint) and, if its status
is not `committed` and it already has a `target_portfolio_id`, captures
that id — BEFORE calling `commitPortfolioBundleImport`, which would
otherwise reset the batch row's `target_portfolio_id` to `NULL` as part of
its own EXP-001 retry-reuse (B2 fix), losing the only pointer to that
leftover portfolio. The leftover is then archived
(`archiveLeftoverPortfolio`, `app/system-backup-service.ts`) BEFORE the
retry proceeds, so:

- the account never accumulates unattributable orphan portfolios across
  repeated failed attempts (each retry archives the PREVIOUS attempt's own
  leftover, one at a time);
- the retry's fresh portfolio (EXP-001's own `commitPortfolioBundleImport`
  always creates a brand-new one, never resumes into the old one) cleanly
  replaces it;
- the archived leftover does not itself trip the precondition on a later
  run (the precondition only checks `active` portfolios — see
  "Precondition" above).

**Known cosmetic consequence**: `portfolios_user_id_code_unique` is
unconditional, not status-scoped, so an archived leftover STILL holds its
original `code` forever. The next successful attempt's `portfolios.create()`
call therefore collides on that code and falls back to EXP-001's own
pre-existing `-restored`-suffixed retry (`commitPortfolioBundleImport`'s
existing collision handling, unmodified) — the restored portfolio's code
may end up `"MYCODE-restored"` rather than the original `"MYCODE"` after a
recovered interruption. `commitSystemBackupImport`'s own result reports the
ACTUAL persisted code (read back from the row it just created), never the
bundle's originally-requested one, so this is disclosed honestly rather
than silently misreported.

A retry of the IDENTICAL backup resumes correctly end to end: portfolios
already `committed` short-circuit as idempotent no-ops (via their own
EXP-001 fingerprint lookup, unchanged), and a `failed`/still-`committing`
one has its leftover archived and then is retried via EXP-001's own
failed-batch-reuse machinery — never a half-restored, silently "successful"
result, and never an accumulating pile of orphaned partial portfolios.

### Watch-only security limitation

A watchlist `kind: "security"` entry restores by matching its exported
ticker (falling back to ISIN, then Sharesight-instrument id) against the
shared `securities`/`security_identifiers` master — the SAME global
ticker+currency dedupe tier `security-resolution.ts`'s `resolveAndLink`
uses internally, but WITHOUT creating anything: a watchlist entry has no
portfolio-linked candidate to create-if-absent from, and this codebase's
only security-CREATION paths either require a `portfolio_securities` link
(EXP-001's own per-portfolio resolution, which DOES create) or a LIVE
provider re-verification (`security-verification.ts`'s `publishOnly`,
which would stamp a `security_provider_mappings` row falsely claiming
fresh provider-verified evidence — a provenance fabrication this codebase's
honesty rules forbid). Practically: a security ALSO held in one of this
backup's own portfolios restores correctly (the common case — the portfolio
restore creates/matches it first); a security watched but NEVER held
anywhere in this backup has no restorable identity in this v1 and is
counted as `securitiesSkipped` in the commit result, never silently dropped
without a signal. The owner's real watchlist has zero security-kind entries
(one currency pair only), so this gap does not affect the real-data result
below; flagged as a follow-up if wanted (would need a bespoke,
provenance-honest "watch-only security create" path).

### No network calls

Every write in this restore is derived purely from the artifact's own
JSON/CSV content — no live market-data provider call is made at any point
(unlike, e.g., `addWatchlistSecurityWithContext`'s normal add-by-search
flow, which DOES call a provider). This is deliberate: a fresh-deployment
restore should not depend on provider credentials/availability being
already configured. The cost is the watch-only-security limitation above
and that a restored watchlist currency pair's rate is not pre-primed
(shows `unavailable` until the existing refresh path runs — the SAME
documented MKT-021 gap the "WATCH-ONLY REFRESH GAP" follow-up already
records, not a new one).

## Size ceilings and real-data results

Exported and round-tripped against a read-only, MD5-verified copy of the
owner's real local D1 database (1 portfolio, 107 transactions, 119
dividend records, 18 securities, 1 watchlist entry (a currency pair),
42,921 price-history observations):

- Portfolio-bundle section: 141,828 bytes (matches EXP-001's own
  documented ~141 KB figure for the same portfolio).
- Price-history CSV section: 6,422,266 bytes (~6.1 MiB) for 42,921 rows —
  comfortably under `DEFAULT_PRICE_BACKUP_LIMITS.maxBytes` (20 MiB raw CSV)
  and `MAX_SYSTEM_BACKUP_REQUEST_BYTES` (64 MiB) with wide headroom; price
  history genuinely dominates artifact size exactly as predicted.
- Full restore into a fresh scratch database: 1 portfolio / 107
  transactions / 119 dividend records / 18 securities / 1 watchlist entry /
  42,921 price observations — **exact parity on every count**, plus an
  exact match on total posted-transaction quantity (260,464, the same
  figure EXP-001's own real-data check reports). Idempotent re-restore
  confirmed: a second commit of the identical backup left the portfolio
  count unchanged (no duplicate).

## Tests

`tests/exp-002.test.ts`: `validateSystemBackup` structural rejections
(schema-version mismatch, malformed shape, over-`MAX_SYSTEM_BACKUP_PORTFOLIOS`);
full export → restore into a fresh account (2 portfolios, a watchlist
security + currency pair, non-default account settings, one price-history
observation) with deep count/value parity, watchlist security resolved to
the SAME security id its portfolio restored (not a duplicate), settings
overwritten, then an idempotent re-restore proving no duplicates anywhere;
the fresh-account precondition rejecting restore into an account with an
unrelated pre-existing portfolio, with zero writes proven afterward; an
account/cross-user probe (unknown user id) failing closed on export;
per-portfolio failure isolation (a second, currency-mismatched portfolio
fails without touching the first, and a retry stays idempotent for the
first while failing the second identically); a watch-only security with no
matching ticker anywhere restorable, skipped and counted rather than
fabricated. Plus the real-data round-trip described above.

**B1/B2/S3 regression tests (2026-08-27 review round)**: a portfolio with a
leftover partial-replay remnant from an interrupted attempt (seeded
directly at the DB level — a deterministic "same broken content" retry can
never itself flip from failure to success once replayed into a fresh
portfolio each attempt, since the retry strategy never resumes into the old
portfolio; this fixture instead reproduces the STATE a genuine interruption
leaves, which is what the leftover-archiving mechanism actually operates
on) is archived automatically, the retry succeeds (the archived leftover's
own held `code` forces the new portfolio onto a `-restored`-suffixed code,
honestly reported), a third run is fully idempotent, and the archived
remnant is confirmed NOT to trip the precondition afterward
(`countUnrelatedPortfolios` asserted `0` both immediately after the retry
and before the third run); an archived source portfolio round-trips
archived (never resurrected active); a price section whose rows all fail to
resolve still succeeds overall (`written: 0`, an explanatory `note`,
`unresolvedRowCount`/`malformedCount` both reported), and a MIXED section
(one resolvable row alongside one unresolvable one) still writes the
resolvable row and reports the rest honestly.
