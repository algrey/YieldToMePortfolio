import { randomUUID } from "node:crypto";
import {
  createAuditInsertStatement,
  createConditionalAuditInsertStatement,
} from "./audit.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { CapitalEventInput } from "../../domain/dividends/projection.ts";

// ---------------------------------------------------------------------------
// DIV-014 (owner directive, 2026-08-24): the owner's saved multi-year income
// what-if scenarios -- portfolio-scoped (`(portfolioId, userId)`, composite
// FK to `(portfolios.id, portfolios.userId)`, mirroring
// `createDividendFyOverrideRepository`'s identical shape in
// `db/repositories/dividends.ts`). Stores ONLY the scenario's INPUTS, never
// a computed projection -- see `db/schema.ts`'s `incomeWhatifScenarios`
// header comment for the full blank-follows-portfolio contract.
//
// Create-only + version-guarded delete (no update -- the owner spec has no
// "edit a saved scenario" affordance, only save-as-new/load/delete), so this
// repository is deliberately smaller than the fy-override create-or-update
// shape it otherwise mirrors.
// ---------------------------------------------------------------------------

export type IncomeScenarioRecord = {
  id: string;
  userId: string;
  portfolioId: string;
  name: string;
  rows: CapitalEventInput[];
  reinvestDividends: boolean;
  valueGrowthPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  createdAt: string;
  version: number;
};

export type SaveIncomeScenarioInput = {
  name: string;
  rows: CapitalEventInput[];
  reinvestDividends: boolean;
  valueGrowthPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  requestId: string;
};

export type IncomeScenarioMutationFailure = {
  ok: false;
  reason: "not_found" | "conflict" | "atomic_failure";
};

const SCENARIO_COLUMNS = `
  id, user_id, portfolio_id, name, capital_rows_json, reinvest_dividends,
  value_growth_percent_decimal, dividend_growth_percent_decimal, created_at,
  version
`;

/** `capital_rows_json` is untrusted-at-rest defensive parsing (the row shape
 * is validated by `app/income-whatif.ts`'s `isValidCapitalEventInputRow` at
 * the action layer BEFORE it ever reaches this repository, but a future
 * schema drift or hand-edited row must never throw a read into the caller --
 * a malformed stored blob degrades to an honest empty parcel list rather
 * than crashing the whole scenario list). */
function parseStoredRows(json: string): CapitalEventInput[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as CapitalEventInput[]) : [];
  } catch {
    return [];
  }
}

function mapScenario(row: Record<string, unknown>): IncomeScenarioRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: String(row.portfolio_id),
    name: String(row.name),
    rows: parseStoredRows(String(row.capital_rows_json)),
    reinvestDividends: Number(row.reinvest_dividends) === 1,
    valueGrowthPercentDecimal:
      row.value_growth_percent_decimal === null
        ? null
        : String(row.value_growth_percent_decimal),
    dividendGrowthPercentDecimal:
      row.dividend_growth_percent_decimal === null
        ? null
        : String(row.dividend_growth_percent_decimal),
    createdAt: String(row.created_at),
    version: Number(row.version),
  };
}

async function ownedPortfolio(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<boolean> {
  const row = await client.get<{ id: string }>(
    "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
    [portfolioId, userId],
  );
  return Boolean(row);
}

export function createIncomeScenarioRepository(
  client: SqlClient,
  now: () => string = () => new Date().toISOString(),
) {
  async function list(
    userId: string,
    portfolioId: string,
  ): Promise<IncomeScenarioRecord[]> {
    const rows = await client.all<Record<string, unknown>>(
      `SELECT ${SCENARIO_COLUMNS} FROM income_whatif_scenarios
       WHERE user_id = ? AND portfolio_id = ?
       ORDER BY created_at DESC, id DESC`,
      [userId, portfolioId],
    );
    return rows.map(mapScenario);
  }

  async function get(
    userId: string,
    portfolioId: string,
    id: string,
  ): Promise<IncomeScenarioRecord | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT ${SCENARIO_COLUMNS} FROM income_whatif_scenarios
       WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
      [id, userId, portfolioId],
    );
    return row ? mapScenario(row) : null;
  }

  /** Create-only (no natural business key to dedupe on -- an owner may
   * genuinely want two scenarios with the same name), so a plain
   * unconditional INSERT + unconditional audit insert is correct here: if
   * the INSERT throws (e.g. the `income_whatif_scenarios_name_check`
   * CHECK, defense-in-depth against a validation-layer bug), `client.batch`
   * rolls the WHOLE batch back atomically, so no dangling audit row for a
   * failed save is ever possible -- unlike `addSecurity`'s conditional
   * `WHERE NOT EXISTS` insert (`db/repositories/watchlist.ts`), which can
   * silently no-op WITHOUT throwing, this insert either fully applies or
   * throws; there is no silent-no-op case to guard the audit row against. */
  async function save(
    userId: string,
    portfolioId: string,
    input: SaveIncomeScenarioInput,
  ): Promise<
    { ok: true; scenario: IncomeScenarioRecord } | IncomeScenarioMutationFailure
  > {
    if (!(await ownedPortfolio(client, userId, portfolioId))) {
      return { ok: false, reason: "not_found" };
    }
    const id = randomUUID();
    const createdAt = now();
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO income_whatif_scenarios (
                id, user_id, portfolio_id, name, capital_rows_json,
                reinvest_dividends, value_growth_percent_decimal,
                dividend_growth_percent_decimal, created_at, version
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        params: [
          id,
          userId,
          portfolioId,
          input.name,
          JSON.stringify(input.rows),
          input.reinvestDividends ? 1 : 0,
          input.valueGrowthPercentDecimal,
          input.dividendGrowthPercentDecimal,
          createdAt,
        ],
      },
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "income_whatif_scenario.save",
          targetType: "income_whatif_scenario",
          targetId: id,
          requestId: input.requestId,
          result: "success",
          occurredAt: createdAt,
          metadata: { portfolioId, rowCount: input.rows.length },
        },
        now,
      ),
    ];
    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure" };
    }
    const scenario = await get(userId, portfolioId, id);
    return scenario
      ? { ok: true, scenario }
      : { ok: false, reason: "atomic_failure" };
  }

  /** Permanent, no confirmation (owner ruling), version-guarded, audited --
   * mirrors `db/repositories/watchlist.ts`'s `remove` shape exactly. */
  async function remove(
    userId: string,
    portfolioId: string,
    id: string,
    expectedVersion: number,
    requestId: string,
  ): Promise<{ ok: true } | IncomeScenarioMutationFailure> {
    const occurredAt = now();
    const statements: SqlStatement[] = [
      createConditionalAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "income_whatif_scenario.delete",
          targetType: "income_whatif_scenario",
          targetId: id,
          requestId,
          result: "success",
          occurredAt,
        },
        "EXISTS (SELECT 1 FROM income_whatif_scenarios WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?)",
        [id, userId, portfolioId, expectedVersion],
        now,
      ),
      {
        sql: `DELETE FROM income_whatif_scenarios
              WHERE id = ? AND user_id = ? AND portfolio_id = ? AND version = ?
              RETURNING id`,
        params: [id, userId, portfolioId, expectedVersion],
      },
    ];
    const rows = await client.batch(statements);
    const deleted = rows[rows.length - 1]?.results[0];
    if (!deleted) {
      const existing = await client.get<{ id: string }>(
        `SELECT id FROM income_whatif_scenarios WHERE id = ? AND user_id = ? AND portfolio_id = ?`,
        [id, userId, portfolioId],
      );
      return { ok: false, reason: existing ? "conflict" : "not_found" };
    }
    return { ok: true };
  }

  return { list, get, save, remove };
}

export type IncomeScenarioRepository = ReturnType<
  typeof createIncomeScenarioRepository
>;
