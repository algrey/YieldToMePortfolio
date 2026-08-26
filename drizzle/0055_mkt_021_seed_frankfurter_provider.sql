-- MKT-021 (HAND-AUTHORED, AGENTS.md disclosure, `--custom` empty file):
-- this migration is entirely hand-written -- there is no schema change for
-- drizzle-kit to diff (the `market_data_providers` table shape is unchanged
-- from 0007/0008), so `drizzle-kit generate` emits an empty placeholder for
-- a `--custom` migration here. Mirrors MKT-007's (`0037_steady_signal.sql`)
-- and BRK-012B's (`0044_seed_sharesight_provider.sql`) identical
-- seed-migration technique exactly.
--
-- The `market_data_providers` row this INSERT seeds is static reference
-- data describing the THIRD FX-capable/FOURTH overall provider this
-- codebase now sources market data from (`domain/market-data/frankfurter.ts`,
-- id `frankfurter`) -- it is not user data, not a secret, and not
-- deployment-specific, so it belongs in the migration chain rather than a
-- manual per-environment seeding step.
--
-- `app/watchlist-actions.ts`'s `primeWatchlistCurrencyPairRate` write path
-- writes `fx_rate_observations.provider_id = 'frankfurter'`, which is a
-- hard FK to this table
-- (`fx_rate_observations_provider_id_market_data_providers_id_fk`) --
-- without this row, every prime write would fail closed on that FK, not
-- silently degrade.
--
-- `status = 'enabled'` here doubles as this provider's ONLY runtime gate
-- (`app/frankfurter-fx-service.ts`'s `frankfurterProviderEnabled`) --
-- Frankfurter needs no credentials/env config (a free, no-API-key public
-- feed), unlike Yahoo's `MARKET_DATA_PROVIDER` env var or Sharesight's
-- client id/secret, so flipping this single column is the only lever an
-- operator has to disable it deployment-wide without a redeploy.
--
-- `capabilities_json`/`rate_limit_json` are seeded as `'{}'` for the same
-- reason MKT-007's and BRK-012B's seeds give: free-form JSON text per
-- `db/schema.ts`, no code currently reads structured fields out of either
-- for this provider, so an honest empty object is correct rather than
-- fabricated capability/rate-limit numbers this repo has not verified.
--
-- The bare `ON CONFLICT DO NOTHING` (no target) makes this migration
-- idempotent against BOTH unique constraints this table carries -- the `id`
-- primary key AND `market_data_providers_code_unique` -- exactly like the
-- two seeds it mirrors. Pure INSERT -- no ALTER/rebuild/trigger involved,
-- so there is no rebuild-drops-the-trigger hazard.
INSERT INTO `market_data_providers`
  (`id`, `code`, `name`, `status`, `capabilities_json`, `rate_limit_json`)
VALUES
  ('frankfurter', 'frankfurter', 'Frankfurter (ECB reference rate) FX feed', 'enabled', '{}', '{}')
ON CONFLICT DO NOTHING;
