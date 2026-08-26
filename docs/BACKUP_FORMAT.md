# Portfolio bundle export/import format (EXP-001)

Normative for the single-portfolio export/import bundle delivered by
`TASKS.md`'s `EXP-001`. A new document rather than a `CSV_IMPORT_SPEC.md`
section because the bundle is JSON, not CSV, and covers many tables at
once rather than one row shape — `CSV_IMPORT_SPEC.md` gets a short pointer
to this file instead of a duplicated section.

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

## Owned-table classification

Every table in `db/repositories/account-lifecycle.ts`'s `OWNED_TABLES`
checklist, classified IN the bundle / EXCLUDED-derived (regenerates) /
EXCLUDED-price (covered by the price-history backup) / EXCLUDED-other
(with reason).

| Table                                                                                                                                                                                 | Classification             | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_settings`                                                                                                                                                                       | EXCLUDED-other             | Account-level, not portfolio-scoped; out of EXP-001's single-portfolio scope (candidate for EXP-002).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `user_identities`                                                                                                                                                                     | EXCLUDED-other             | Account-level auth identity, not portfolio data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `portfolios`                                                                                                                                                                          | **IN**                     | Identity fields: name, code, base currency, timezone, accounting method, `history_complete_from`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `portfolio_settings`                                                                                                                                                                  | **IN**                     | `quote_staleness_policy` (a row is optional; genuinely unused by any current read path in this codebase — grepped clean — but restored when present for `OWNED_TABLES` completeness).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `portfolio_securities`                                                                                                                                                                | **IN**                     | Exported as "resolution facts" (source symbol/exchange/currency + the linked security's ticker/ISIN/Sharesight-instrument identifiers and canonical name) — re-resolved on import via the same create-if-absent machinery BRK-009B's Sharesight auto-resolution uses, never by ticker text alone.                                                                                                                                                                                                                                                                                                                                                                             |
| `dividend_receipts`                                                                                                                                                                   | EXCLUDED-other (known gap) | A dormant/legacy table: `db/repositories/import-commit.ts`'s own header comment states dividend rows now write `dividend_manual_records` exclusively ("why not `dividend_receipts`"), and no current write path in this codebase inserts new rows here. It is still read as one evidence tier by `domain/dividends/history.ts`, so a portfolio with old pre-migration receipts would see a real (if small) evidence gap after restore. **Not implemented in this v1** — flagged to the Orchestrator; check `SELECT COUNT(*) FROM dividend_receipts WHERE portfolio_id = ...` before relying on EXP-001 for a portfolio that predates the `dividend_manual_records` migration. |
| `dividend_security_assumptions`                                                                                                                                                       | **IN**                     | Per-security yield/franking/growth overrides, including the DIV-016 `force_assumption` flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dividend_portfolio_assumptions`                                                                                                                                                      | **IN**                     | Portfolio-level growth assumption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `dividend_fy_overrides`                                                                                                                                                               | **IN**                     | Owner-entered FY actual-income corrections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `dividend_event_overrides`                                                                                                                                                            | **IN**                     | Tied to the shared `dividend_events` table by ID; verified to still exist at import time (same-deployment restore only — see "Design decisions" below), honestly skipped and counted if the referenced provider event is gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dividend_manual_records`                                                                                                                                                             | **IN**                     | Full supersession chains (`superseded_by_record_id` links), import batch/source-reference provenance, BRK-010 foreign-currency fields. Originally-manual rows replay through the owner-dialog `create()` path and stay editable; see "Design decisions".                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `dividend_import_franking_overrides`                                                                                                                                                  | **IN**                     | BRK-011 owner-entered franking-currency corrections, tied to this bundle's own replayed `dividend_manual_records` rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sharesight_sync_state`                                                                                                                                                               | EXCLUDED-other             | Account-level (keyed by `user_id`, not portfolio) sync cursor bookkeeping; no token material; regenerates on the next sync.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sharesight_delayed_prices`                                                                                                                                                           | EXCLUDED-price             | Price cache/freshness gate; covered by the price-history backup and provider re-fetch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `intraday_price_points`                                                                                                                                                               | EXCLUDED-price             | Intraday capture cache; regenerates via the capture cron.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `price_upload_batches`                                                                                                                                                                | EXCLUDED-price             | Bookkeeping for the price-history CSV upload flow itself; the price data it attributes is what the price-history backup already exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `import_batches`, `import_commit_chunks`, `import_rows`, `import_issues`, `import_mapping_decisions`                                                                                  | EXCLUDED-other             | The SOURCE portfolio's own historical CSV-import audit trail. Not needed for functionality (the transactions/dividends those imports created are already in the bundle via `transactions`/`dividend_manual_records`); a fresh set of these rows is created for the bundle-import batch itself.                                                                                                                                                                                                                                                                                                                                                                                |
| `transactions`                                                                                                                                                                        | **IN**                     | Full ledger, including reversal/supersession chains, replayed via the same `post`/`reverse`/`supersede` repository functions the app itself uses (never a second write path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ledger_mutation_guards`, `manual_ledger_mutation_keys`                                                                                                                               | EXCLUDED-derived           | Idempotency/concurrency guard bookkeeping tied to specific historical requests; regenerates as new writes happen and carries no standalone financial meaning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cash_accounts`, `cash_ledger_entries`                                                                                                                                                | EXCLUDED-derived           | Pure byproducts of posting a transaction (created automatically by `ledger.post`/`reverse`/`supersede`); replaying the transactions above regenerates them identically — never a second, independently-typed fact.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `manual_overrides`                                                                                                                                                                    | EXCLUDED-other (known gap) | Owner-entered price/FX quote corrections (MKT-014's correction dialog; `type IN ('price','fx_rate')`). Genuinely owner-authored, but PRICE-domain data that the existing price-history backup (MKT-008) does not currently cover either (it only backs up `price_observations` CSV rows, not this override mechanism) — a real gap in the price-backup story, not something EXP-001's non-price bundle should paper over. Flagged as a follow-up for MKT-008/EXP-002.                                                                                                                                                                                                         |
| `portfolio_daily_snapshots`, `holding_daily_snapshots`, `calculation_runs`, `snapshot_publications`, `projection_publications`, `tax_lots`, `lot_allocations`, `holding_projections`  | EXCLUDED-derived           | The calculation-run pipeline's output over `transactions`; regenerates once the pipeline (re-)runs, byte-identical for the same ledger facts. Includes the Cap Gains tab's own data (finding 1 above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `watchlist_entries`                                                                                                                                                                   | EXCLUDED-other             | Account-scoped, not portfolio-scoped (finding 2 above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `income_whatif_scenarios`                                                                                                                                                             | **IN**                     | Saved what-if scenario inputs only (never a computed projection).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `portfolio_value_history`                                                                                                                                                             | EXCLUDED-derived           | HIST-002's persisted cache of the read-time historical-value derivation; regenerates from `transactions`/price data on the next read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `users` (special-cased)                                                                                                                                                               | EXCLUDED-other             | Internal account record, not portfolio data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `price_observations`, `fx_rate_observations` (special-cased, `scope_user_id`)                                                                                                         | EXCLUDED-price             | Covered by the price-history backup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `market_data_refresh_jobs` (special-cased)                                                                                                                                            | EXCLUDED-derived           | Operational refresh-job bookkeeping; regenerates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `security_provider_mappings` (special-cased, `verified_by_user_id`)                                                                                                                   | EXCLUDED-derived           | A verification ATTRIBUTION on the shared, deployment-wide `securities`/`security_identifiers` master, not owner data; re-resolution/re-verification regenerates equivalent mappings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `audit_events` (special-cased)                                                                                                                                                        | EXCLUDED-other             | A redacted historical log of actions taken, not a portfolio fact needed for functionality; replaying this bundle's writes naturally produces its OWN new audit trail for the import action. The original historical trail is not reconstructed (default-excluded per the task's own instruction; documented here).                                                                                                                                                                                                                                                                                                                                                            |
| `account_lifecycle_requests`, `account_export_*`, `account_purge_*` (special-cased)                                                                                                   | EXCLUDED-other             | Account-lifecycle/export-job control state, unrelated to portfolio functionality.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `currencies`, `exchanges`, `securities`, `security_identifiers`, `market_data_providers`, `dividend_events`, `split_events`, `corporate_action_refresh_state` (shared reference data) | EXCLUDED-other             | Deployment-shared, not owner data; `portfolio_securities`'s resolution facts (above) carry enough identity to re-resolve/re-create the relevant `securities`/`security_identifiers` rows on import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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
    "financialYearStartMonthAtExport": 7   // informational only, see finding 4
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
  no-op — never a duplicate.
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
