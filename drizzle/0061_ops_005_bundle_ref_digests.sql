-- OPS-005 round 2 (F1): persist the server's OWN record of a portfolio-
-- bundle restore's expected ref set, so `commitPortfolioBundleFinalize` can
-- compare it against what the CLIENT claims to have sent (previously
-- finalize only re-verified refs the client itself supplied, so a client
-- sending a SHORTER list than the bundle actually contains passed trivially
-- and the batch reached `committed` with silently fewer rows). Plain
-- `ALTER TABLE ... ADD COLUMN` (no CHECK, no FK, no rebuild) -- the
-- 0053-0057 precedent; all four columns nullable, defaulting to NULL, so
-- every pre-existing row (ordinary CSV imports never set these; a
-- bundle-restore batch scaffolded before this migration lands) is
-- unaffected and finalize's new comparison is skipped when NULL rather than
-- failing closed on a legacy batch it cannot verify.
ALTER TABLE `import_batches` ADD `bundle_transaction_refs_digest` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `bundle_transaction_refs_count` integer;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `bundle_dividend_refs_digest` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `bundle_dividend_refs_count` integer;
