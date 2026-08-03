import type { SqlClient } from "./sql-client.ts";

export type ManualLedgerSecurityOption = Readonly<{
  id: string;
  label: string;
  currencyCode: string;
}>;

export type ManualLedgerOptions = Readonly<{
  securities: readonly ManualLedgerSecurityOption[];
  currencies: readonly string[];
}>;

export async function loadOwnedManualLedgerOptions(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<ManualLedgerOptions> {
  const [securityRows, currencyRows] = await Promise.all([
    client.all<Record<string, unknown>>(
      `SELECT ps.id, ps.source_currency_code,
              COALESCE(ps.display_symbol, ps.source_symbol, s.canonical_name) AS label
         FROM portfolio_securities ps
         LEFT JOIN securities s ON s.id = ps.security_id
        WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status != 'archived'
        ORDER BY label, ps.id`,
      [userId, portfolioId],
    ),
    client.all<Record<string, unknown>>(
      "SELECT code FROM currencies WHERE is_active = 1 ORDER BY code",
      [],
    ),
  ]);

  return {
    securities: securityRows.map((row) => ({
      id: String(row.id),
      label: String(row.label ?? row.id),
      currencyCode: String(row.source_currency_code),
    })),
    currencies: currencyRows.map((row) => String(row.code)),
  };
}
