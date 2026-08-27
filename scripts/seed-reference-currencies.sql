-- DEP-002: per-environment reference-currency seed for a fresh remote D1
-- database. Apply ONCE after the migration chain, before first login:
--
--   npx wrangler d1 execute <db> --remote --yes --file=scripts/seed-reference-currencies.sql
--
-- Deliberately NOT a drizzle migration: the test suite's fixtures apply the
-- full migration chain and then seed their own currency subsets with plain
-- INSERTs, so the chain must leave `currencies` empty. Local dev is seeded
-- by `scripts/setup-local-db.mjs` (its `CURRENCIES` constant is this same
-- list -- keep the two in sync); this file is the remote/production
-- equivalent. `INSERT OR IGNORE` makes re-running a no-op.
--
-- Without these rows JIT user provisioning (default home currency AUD),
-- portfolio creation, and every FK into `currencies` fail closed on the
-- very first authenticated request.
INSERT OR IGNORE INTO currencies (code, numeric_code, name, minor_unit_digits, is_active) VALUES
  ('AUD', 36, 'Australian dollar', 2, 1),
  ('USD', 840, 'US dollar', 2, 1),
  ('GBP', 826, 'Pound sterling', 2, 1),
  ('EUR', 978, 'Euro', 2, 1),
  ('NZD', 554, 'New Zealand dollar', 2, 1),
  ('CAD', 124, 'Canadian dollar', 2, 1),
  ('HKD', 344, 'Hong Kong dollar', 2, 1),
  ('SGD', 702, 'Singapore dollar', 2, 1),
  ('CHF', 756, 'Swiss franc', 2, 1),
  ('JPY', 392, 'Yen', 0, 1);
