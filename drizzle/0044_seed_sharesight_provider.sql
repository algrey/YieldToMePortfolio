-- BRK-012B (HAND-AUTHORED, AGENTS.md disclosure, `--custom` empty file):
-- this migration is entirely hand-written -- there is no schema change for
-- drizzle-kit to diff (the `market_data_providers` table shape is unchanged
-- from 0007/0008), so `drizzle-kit generate` would emit nothing here. The
-- `market_data_providers` row this INSERT seeds is static reference data
-- describing the SECOND provider this codebase now sources delayed prices
-- from (`domain/sharesight/client.ts`'s `listUserInstruments`, id
-- `sharesight`, code `sharesight`) -- it is not user data, not a secret, and
-- not deployment-specific, so it belongs in the migration chain rather than
-- a manual per-environment seeding step. Mirrors MKT-007's identical
-- `yahoo-compatible` seed (0037_steady_signal.sql) exactly.
--
-- `db/repositories/sharesight-price-refresh.ts`'s accretion write path
-- writes `price_observations.provider_id = 'sharesight'`, which is a hard
-- FK to this table (`price_observations_provider_id_market_data_providers_id_fk`)
-- -- without this row, every accretion write would fail closed on that FK,
-- not silently degrade.
--
-- `status = 'enabled'` here means "this is a provider the codebase knows
-- how to talk to" -- unlike MKT-007's Yahoo row, there is no separate
-- per-deployment activation env var gating Sharesight price refresh: the
-- REAL gate is `worker/sharesight-config.ts`'s `SHARESIGHT_CLIENT_ID`/
-- `SHARESIGHT_CLIENT_SECRET` (absent -> integration disabled, no client, no
-- request) combined with each owner's own `sharesight_sync_state.enabled`
-- flag (see `app/sharesight-price-refresh-service.ts`) -- this row alone
-- activates nothing.
--
-- `capabilities_json`/`rate_limit_json` are seeded as `'{}'` for the same
-- reason MKT-007's comment gives: free-form JSON text per `db/schema.ts`,
-- no code currently reads structured fields out of either for this
-- provider, so an honest empty object is correct rather than fabricated
-- capability/rate-limit numbers this repo has not verified.
--
-- The bare `ON CONFLICT DO NOTHING` (no target) makes this migration
-- idempotent against BOTH unique constraints this table carries -- the `id`
-- primary key AND `market_data_providers_code_unique` -- exactly like
-- MKT-007's identical seed. Pure INSERT -- no ALTER/rebuild/trigger
-- involved, so there is no rebuild-drops-the-trigger hazard.
INSERT INTO `market_data_providers`
  (`id`, `code`, `name`, `status`, `capabilities_json`, `rate_limit_json`)
VALUES
  ('sharesight', 'sharesight', 'Sharesight delayed price feed', 'enabled', '{}', '{}')
ON CONFLICT DO NOTHING;
