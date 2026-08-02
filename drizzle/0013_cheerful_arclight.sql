ALTER TABLE `transactions` ADD `idempotency_key` text;--> statement-breakpoint
-- The pre-column service stored the retry key in source_reference only when no
-- explicit source reference was supplied. Backfill only references that are
-- unambiguous within the new owner/portfolio scope; ambiguous legacy rows stay
-- nullable because their original retry key cannot be reconstructed safely.
UPDATE `transactions` AS `candidate`
SET `idempotency_key` = `candidate`.`source_reference`
WHERE `candidate`.`source_reference` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `transactions` AS `duplicate`
    WHERE `duplicate`.`user_id` = `candidate`.`user_id`
      AND `duplicate`.`portfolio_id` = `candidate`.`portfolio_id`
      AND `duplicate`.`source_reference` = `candidate`.`source_reference`
      AND `duplicate`.`id` <> `candidate`.`id`
  );--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_owner_portfolio_idempotency_unique` ON `transactions` (`user_id`,`portfolio_id`,`idempotency_key`);
