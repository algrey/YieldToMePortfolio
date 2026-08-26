-- DIV-016 part A: owner-editable dividend rows via supersession, never an
-- in-place financial rewrite (AGENTS.md ledger-immutability rule). A plain
-- `ALTER TABLE ... ADD COLUMN` (no CHECK, no FK) plus a separate `CREATE
-- INDEX` -- neither statement touches the table's shape, so the three
-- `account_purge_lock_dividend_manual_records_*` triggers survive
-- untouched (unlike 0035/0042's genuine rebuilds, which had to
-- hand-recreate them). See `db/schema.ts`'s `dividendManualRecords` header
-- note for the full design: `superseded_by_record_id` is set ONLY on the
-- OLD (superseded) row, pointing forward to the NEW row that replaced it;
-- NULL means "current head of its lineage" (every pre-DIV-016 row). No FK
-- constraint, deliberately -- matching `import_batch_id`/`source_reference`/
-- `idempotency_key` above it, none of which carry one either.
ALTER TABLE `dividend_manual_records` ADD `superseded_by_record_id` text;--> statement-breakpoint
CREATE INDEX `dividend_manual_records_superseded_by_idx` ON `dividend_manual_records` (`superseded_by_record_id`);
