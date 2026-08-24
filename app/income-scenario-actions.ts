// DIV-014 (owner directive, 2026-08-24): CSRF-gated, owner-scoped mutation
// actions for saved multi-year income what-if scenarios
// (`db/repositories/income-scenarios.ts` -- portfolio-scoped, stores ONLY
// the scenario's INPUTS, never a computed projection). Route modules
// (`app/api/portfolios/[portfolioId]/income-scenarios/route.ts`) call
// `rejectCrossSiteMutation` before invoking either mutation here, mirroring
// `app/watchlist-actions.ts`/`app/dividend-assumptions-actions.ts`'s
// established CSRF convention (docs/QA-001A_SECURITY_MATRIX.md section 1).
//
// Every mutation is split into a thin `xxxAction(portfolioId, value)`
// (resolves an authenticated, portfolio-ownership-verified context, then
// delegates) and an exported `xxxWithContext(context, portfolioId, value)`
// that does the actual work against an already-resolved context --
// mirroring `app/dividend-assumptions-actions.ts`'s identical split (see
// that file's header comment for why: the `Action` half transitively
// imports `next/headers` via `./portfolio-actions.ts`, only resolvable
// through vinext's bundler, not Node's strict ESM loader under
// `node --test`).
import {
  createIncomeScenarioRepository,
  type IncomeScenarioRecord,
  type SqlClient,
} from "../db/repositories/index.ts";
import type { CapitalEventInput } from "../domain/dividends/projection.ts";
import {
  INCOME_SCENARIO_MAX_ROWS,
  INCOME_SCENARIO_NAME_MAX_LENGTH,
  isValidCapitalEventInputRow,
  isValidGrowthInput,
} from "./income-whatif.ts";

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
};

export type IncomeScenarioActionContext = Readonly<{
  client: SqlClient;
  userId: string;
  requestId: string;
}>;

async function authenticatedContext(
  portfolioId: string,
): Promise<IncomeScenarioActionContext | ActionFailure> {
  const { getAuthenticatedSqlContext } = await import("./portfolio-actions.ts");
  return getAuthenticatedSqlContext(portfolioId);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** `undefined` is the "invalid" sentinel (distinct from the valid `null`
 * "untouched/follows portfolio" state) -- mirrors
 * `app/dividend-assumptions-actions.ts`'s `nullableString`-style tri-state
 * parsing convention. */
function nullableGrowthInput(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && isValidGrowthInput(value)
    ? value
    : undefined;
}

// ---------------------------------------------------------------------------
// Save: create-only (owner spec has no "edit a saved scenario" affordance).
// ---------------------------------------------------------------------------

export type SaveIncomeScenarioActionResult =
  { ok: true; scenario: IncomeScenarioRecord } | ActionFailure;

export async function saveIncomeScenarioWithContext(
  context: IncomeScenarioActionContext,
  portfolioId: string,
  value: unknown,
): Promise<SaveIncomeScenarioActionResult> {
  const input = record(value);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || name.length > INCOME_SCENARIO_NAME_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      message: "Enter a name for this scenario.",
    };
  }
  const rawRows = Array.isArray(input.rows) ? input.rows : null;
  if (!rawRows || rawRows.length > INCOME_SCENARIO_MAX_ROWS) {
    return {
      ok: false,
      status: 400,
      message: "This scenario has an invalid set of capital-change rows.",
    };
  }
  if (!rawRows.every(isValidCapitalEventInputRow)) {
    return {
      ok: false,
      status: 400,
      message: "This scenario has an invalid set of capital-change rows.",
    };
  }
  const rows = rawRows as CapitalEventInput[];
  const reinvestDividends = input.reinvestDividends === true;
  const valueGrowthPercentDecimal = nullableGrowthInput(
    input.valueGrowthPercentDecimal,
  );
  const dividendGrowthPercentDecimal = nullableGrowthInput(
    input.dividendGrowthPercentDecimal,
  );
  if (
    valueGrowthPercentDecimal === undefined ||
    dividendGrowthPercentDecimal === undefined
  ) {
    return {
      ok: false,
      status: 400,
      message: "The scenario's growth inputs are invalid.",
    };
  }
  const result = await createIncomeScenarioRepository(context.client).save(
    context.userId,
    portfolioId,
    {
      name,
      rows,
      reinvestDividends,
      valueGrowthPercentDecimal,
      dividendGrowthPercentDecimal,
      requestId: context.requestId,
    },
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.reason === "not_found" ? 404 : 503,
      message: "This scenario could not be saved.",
    };
  }
  return { ok: true, scenario: result.scenario };
}

export async function saveIncomeScenarioAction(
  portfolioId: string,
  value: unknown,
): Promise<SaveIncomeScenarioActionResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return context;
  return saveIncomeScenarioWithContext(context, portfolioId, value);
}

// ---------------------------------------------------------------------------
// Delete: permanent, NO confirmation (owner ruling), version-guarded,
// audited.
// ---------------------------------------------------------------------------

export type DeleteIncomeScenarioActionResult = { ok: true } | ActionFailure;

export async function deleteIncomeScenarioWithContext(
  context: IncomeScenarioActionContext,
  portfolioId: string,
  value: unknown,
): Promise<DeleteIncomeScenarioActionResult> {
  const input = record(value);
  const id =
    typeof input.id === "string" && input.id.length > 0 ? input.id : null;
  const expectedVersion = input.expectedVersion;
  if (!id || typeof expectedVersion !== "number") {
    return {
      ok: false,
      status: 400,
      message: "A scenario id and its current version are required.",
    };
  }
  const result = await createIncomeScenarioRepository(context.client).remove(
    context.userId,
    portfolioId,
    id,
    expectedVersion,
    context.requestId,
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.reason === "not_found" ? 404 : 409,
      message:
        result.reason === "not_found"
          ? "That scenario was already removed."
          : "This scenario changed elsewhere -- reload and retry.",
    };
  }
  return { ok: true };
}

export async function deleteIncomeScenarioAction(
  portfolioId: string,
  value: unknown,
): Promise<DeleteIncomeScenarioActionResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return context;
  return deleteIncomeScenarioWithContext(context, portfolioId, value);
}
