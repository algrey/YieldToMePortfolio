-- drizzle-kit generates only the target index. Older deployments may contain
-- several active date windows for one target, so coalesce those rows before
-- installing the new concurrency invariant. Replaying the union from its
-- beginning is deliberate: observation upserts are idempotent and retaining a
-- later high-water mark could skip an earlier queued window.
UPDATE `market_data_refresh_jobs`
SET `range_from` = (
      SELECT MIN(`candidate`.`range_from`)
      FROM `market_data_refresh_jobs` AS `candidate`
      WHERE `candidate`.`provider_id` = `market_data_refresh_jobs`.`provider_id`
        AND `candidate`.`scope_key` = `market_data_refresh_jobs`.`scope_key`
        AND `candidate`.`target_kind` = `market_data_refresh_jobs`.`target_kind`
        AND `candidate`.`target_key` = `market_data_refresh_jobs`.`target_key`
        AND `candidate`.`status` IN ('queued', 'running')
    ),
    `range_to` = (
      SELECT MAX(`candidate`.`range_to`)
      FROM `market_data_refresh_jobs` AS `candidate`
      WHERE `candidate`.`provider_id` = `market_data_refresh_jobs`.`provider_id`
        AND `candidate`.`scope_key` = `market_data_refresh_jobs`.`scope_key`
        AND `candidate`.`target_kind` = `market_data_refresh_jobs`.`target_kind`
        AND `candidate`.`target_key` = `market_data_refresh_jobs`.`target_key`
        AND `candidate`.`status` IN ('queued', 'running')
    ),
    `high_water_date` = NULL,
    `status` = 'queued',
    `lease_owner` = NULL,
    `lease_expires_at` = NULL,
    `completed_at` = NULL,
    `last_error_kind` = NULL
WHERE `status` IN ('queued', 'running')
  AND `id` = (
    SELECT `survivor`.`id`
    FROM `market_data_refresh_jobs` AS `survivor`
    WHERE `survivor`.`provider_id` = `market_data_refresh_jobs`.`provider_id`
      AND `survivor`.`scope_key` = `market_data_refresh_jobs`.`scope_key`
      AND `survivor`.`target_kind` = `market_data_refresh_jobs`.`target_kind`
      AND `survivor`.`target_key` = `market_data_refresh_jobs`.`target_key`
      AND `survivor`.`status` IN ('queued', 'running')
    ORDER BY `survivor`.`created_at`, `survivor`.`id`
    LIMIT 1
  )
  AND EXISTS (
    SELECT 1
    FROM `market_data_refresh_jobs` AS `duplicate`
    WHERE `duplicate`.`provider_id` = `market_data_refresh_jobs`.`provider_id`
      AND `duplicate`.`scope_key` = `market_data_refresh_jobs`.`scope_key`
      AND `duplicate`.`target_kind` = `market_data_refresh_jobs`.`target_kind`
      AND `duplicate`.`target_key` = `market_data_refresh_jobs`.`target_key`
      AND `duplicate`.`status` IN ('queued', 'running')
      AND `duplicate`.`id` <> `market_data_refresh_jobs`.`id`
  );--> statement-breakpoint
UPDATE `market_data_refresh_jobs`
SET `status` = 'failed',
    `lease_owner` = NULL,
    `lease_expires_at` = NULL,
    `last_error_kind` = 'coalesced_by_migration'
WHERE `status` IN ('queued', 'running')
  AND `id` <> (
    SELECT `survivor`.`id`
    FROM `market_data_refresh_jobs` AS `survivor`
    WHERE `survivor`.`provider_id` = `market_data_refresh_jobs`.`provider_id`
      AND `survivor`.`scope_key` = `market_data_refresh_jobs`.`scope_key`
      AND `survivor`.`target_kind` = `market_data_refresh_jobs`.`target_kind`
      AND `survivor`.`target_key` = `market_data_refresh_jobs`.`target_key`
      AND `survivor`.`status` IN ('queued', 'running')
    ORDER BY `survivor`.`created_at`, `survivor`.`id`
    LIMIT 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `market_data_refresh_jobs_one_active_target_unique` ON `market_data_refresh_jobs` (`provider_id`,`scope_key`,`target_kind`,`target_key`) WHERE "market_data_refresh_jobs"."status" IN ('queued', 'running');
