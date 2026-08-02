INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
VALUES ('AUD', 36, 'Australian dollar', 2, 1);

INSERT INTO users (
  id, status, primary_email, timezone, created_at, updated_at, version
) VALUES
  ('ops-002-user-a', 'active', 'ops-002-a@example.invalid', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
  ('ops-002-user-b', 'active', 'ops-002-b@example.invalid', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);

INSERT INTO portfolios (
  id, user_id, code, name, base_currency_code, timezone,
  accounting_method, status, created_at, updated_at, version
) VALUES
  ('ops-002-portfolio-a', 'ops-002-user-a', 'DRILL-A', 'Restore drill A', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
  ('ops-002-portfolio-b', 'ops-002-user-b', 'DRILL-B', 'Restore drill B', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);

INSERT INTO transactions (
  id, user_id, portfolio_id, type, status, trade_at, local_trade_date,
  currency_code, gross_amount_decimal, fee_amount_decimal,
  tax_amount_decimal, source_type, created_by_user_id,
  calculation_version, created_at, idempotency_key
) VALUES (
  'ops-002-transaction-a', 'ops-002-user-a', 'ops-002-portfolio-a',
  'cash_deposit', 'posted', '2026-08-03T00:00:00Z', '2026-08-03',
  'AUD', '100.00', '0', '0', 'manual', 'ops-002-user-a', 1,
  '2026-08-03T00:00:00Z', 'ops-002-transaction-a'
);

INSERT INTO portfolio_daily_snapshots (
  id, user_id, portfolio_id, snapshot_date, base_currency_code,
  total_value_decimal, cost_basis_decimal, coverage_json, completeness,
  status, ledger_high_water, calculation_version, rebuilt_at
) VALUES (
  'ops-002-snapshot-a', 'ops-002-user-a', 'ops-002-portfolio-a',
  '2026-08-03', 'AUD', '100.00', '100.00', '{}', 'complete', 'ready',
  'ops-002-ledger-1', 1, '2026-08-03T00:01:00Z'
);

INSERT INTO calculation_runs (
  id, user_id, portfolio_id, range_from, range_to, calculation_version,
  reason, status, attempt, ledger_high_water_start,
  processed_snapshot_count, processed_holding_count, idempotency_key,
  created_at, updated_at
) VALUES (
  'ops-002-run-a', 'ops-002-user-a', 'ops-002-portfolio-a',
  '2026-08-03', '2026-08-03', 1, 'transaction_change', 'completed', 1,
  'ops-002-ledger-1', 1, 0, 'ops-002-run-1',
  '2026-08-03T00:01:00Z', '2026-08-03T00:01:00Z'
);

INSERT INTO audit_events (
  id, actor_user_id, target_owner_user_id, action, target_type,
  target_id, request_id, result, metadata_json, occurred_at
) VALUES (
  'ops-002-audit-a', 'ops-002-user-a', 'ops-002-user-a',
  'restore.fixture', 'test', 'ops-002-fixture', 'ops-002-request-a',
  'success', '{}', '2026-08-03T00:01:00Z'
);
