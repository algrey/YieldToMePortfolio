ALTER TABLE `calculation_runs` ADD `stall_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `calculation_runs` ADD `stall_checkpoint` text;