ALTER TABLE `dividend_manual_records` ADD `import_batch_id` text;--> statement-breakpoint
ALTER TABLE `dividend_manual_records` ADD `source_reference` text;--> statement-breakpoint
CREATE INDEX `dividend_manual_records_import_batch_idx` ON `dividend_manual_records` (`user_id`,`import_batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_manual_records_portfolio_source_reference_unique` ON `dividend_manual_records` (`portfolio_id`,`source_reference`);