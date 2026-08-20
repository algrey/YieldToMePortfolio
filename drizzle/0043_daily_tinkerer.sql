ALTER TABLE `sharesight_sync_state` ADD `last_price_refresh_at` text;--> statement-breakpoint
ALTER TABLE `sharesight_sync_state` ADD `last_price_refresh_status` text;--> statement-breakpoint
ALTER TABLE `sharesight_sync_state` ADD `last_price_refresh_error_kind` text;--> statement-breakpoint
CREATE UNIQUE INDEX `price_observations_provider_scope_mapping_date_unique` ON `price_observations` (`provider_id`,`scope_key`,`mapping_id`,`interval`,`market_date`,`adjustment_state`) WHERE "price_observations"."provider_id" = 'sharesight';