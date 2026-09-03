// UI-006B: owner-scoped mutation actions behind the dividend assumptions
// editor and its manual-entry/override/FY-override forms. Every repository
// call here is one of DB-005's already-built, version-guarded
// `db/repositories/dividends.ts` factories (`createDividendAssumptionsRepository`,
// `createDividendManualRecordRepository`, `createDividendEventOverrideRepository`,
// `createDividendFyOverrideRepository`); this file's job is request
// validation, owner-scoped context resolution, and the persistence-mapping
// decision documented in `docs/CALCULATIONS.md` section 11's
// "Manual entry and overrides (UI-006B)" note:
//
//   no linked provider event -> `dividend_manual_records`
//   a linked provider event  -> `dividend_event_overrides` (sparse fields + exclude)
//
// Route modules (`app/api/portfolios/[portfolioId]/dividend-*/route.ts`)
// call `rejectCrossSiteMutation` before invoking any of these; GET-only
// `sharesAtDateAction` performs no mutation and needs no CSRF gate, matching
// this codebase's established "reads are N/A for CSRF" convention (see
// docs/QA-001A_SECURITY_MATRIX.md section 1).
//
// Every mutation is split into a thin `xxxAction(portfolioId, value)`
// (resolves an authenticated context, then delegates) and an exported
// `xxxWithContext(context, portfolioId, value)` that does the actual work
// against an already-resolved context -- mirroring
// `app/manual-ledger-actions.ts`'s `postManualLedgerWithContext` split. This
// is not just a style choice: `authenticatedContext` below dynamically
// imports `./portfolio-actions.ts`, which transitively imports
// `next/headers` (only resolvable through vinext's bundler, not Node's
// strict ESM loader under `node --test` -- see tests/fy-001b.test.ts's
// identical note). The `WithContext` functions never touch that import, so
// `tests/ui-006b.test.ts` can exercise every validation/persistence-mapping/
// proximity-warning rule directly against a real sqlite-backed `SqlClient`.
import {
  createDividendAssumptionsRepository,
  createDividendEventOverrideRepository,
  createDividendFyOverrideRepository,
  createDividendImportFrankingOverrideRepository,
  createDividendManualRecordRepository,
  createDividendReceiptRepository,
  isWithinReadPathDecimalBounds,
  type DividendManualRecordRecord,
  type SqlClient,
} from "../db/repositories/index.ts";
import { deriveSharesHeldAtDate } from "../domain/dividends/shares-held.ts";
import { PROXIMITY_WINDOW_DAYS } from "../domain/dividends/history.ts";
import {
  daysBetweenDates,
  isNonNegativeDecimalString,
  isPositiveDecimalString,
  isValidDateString,
  validateFrankingPercent,
  validateGrowthPercent,
  validateOwnerYieldPercent,
  validateValueGrowthPercent,
} from "./dividend-form-validation.ts";

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
};

// F3 (UI-006B review fix): the MAX+1 overflow-throw pattern
// `app/owned-dividend-history.ts`/`app/owned-income-projection.ts` use for
// every bounded whole-collection read -- ask for one row past the cap, and
// if it comes back, the true row count is unknown/unbounded, so fail
// closed with an explicit, typed failure rather than a bare `LIMIT` that
// would silently truncate the ledger and derive a wrong shares-held figure
// with no disclosure. One security's own ledger history, not a whole
// portfolio's, so a materially smaller cap than the portfolio-wide
// `MAX_TRANSACTIONS_PER_PORTFOLIO` (100,000) is honestly generous.
const MAX_TRANSACTIONS_PER_SECURITY = 20_000;

export type DividendActionContext = Readonly<{
  client: SqlClient;
  userId: string;
  requestId: string;
}>;

async function authenticatedContext(
  portfolioId: string,
): Promise<DividendActionContext | ActionFailure> {
  const { getAuthenticatedSqlContext } = await import("./portfolio-actions.ts");
  return getAuthenticatedSqlContext(portfolioId);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function expectedVersionOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return undefined; // malformed sentinel, distinct from "absent"/"null"
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Grid save: the whole assumptions grid (per-security rows + the portfolio
// row) in one request. Each row keeps its OWN version-guarded repository
// call (DB-005 has no cross-entity atomic batch for this shape); rows are
// applied sequentially and this action stops at the first failure so a
// caller never silently loses track of a partial save -- `appliedSecurities`
// reports exactly which rows already committed (with their fresh versions)
// before the failure, so the client can resync those rows without
// re-submitting them as stale.
// ---------------------------------------------------------------------------

export type DividendAssumptionsGridSecurityInput = {
  portfolioSecurityId: string;
  dividendYieldPercentDecimal: string | null;
  frankingPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  /** DIV-016 part B (override-as-bridge): the owner's explicit per-security
   * force flag. Omitted (not just `false`) on a request defaults to
   * `false` -- never implicitly forced. */
  forceAssumption: boolean;
  expectedVersion: number | null;
};

export type DividendAssumptionsGridPortfolioInput = {
  valueGrowthPercentDecimal: string | null;
  portfolioDividendGrowthPercentDecimal: string | null;
  expectedVersion: number | null;
};

export type SavedAssumptionsRow = {
  portfolioSecurityId: string;
  version: number;
};

export type DividendAssumptionsGridActionResult =
  | {
      ok: true;
      securities: SavedAssumptionsRow[];
      portfolio: { version: number };
    }
  | (ActionFailure & {
      appliedSecurities: SavedAssumptionsRow[];
      failedPortfolioSecurityId?: string;
    });

function parseGridRow(
  value: unknown,
): DividendAssumptionsGridSecurityInput | { message: string } {
  const input = record(value);
  const portfolioSecurityId =
    typeof input.portfolioSecurityId === "string" &&
    input.portfolioSecurityId.length > 0
      ? input.portfolioSecurityId
      : null;
  if (!portfolioSecurityId)
    return { message: "Each grid row needs a security id." };
  const expectedVersion = expectedVersionOf(input.expectedVersion);
  if (expectedVersion === undefined)
    return {
      message: "Each grid row needs a valid version (or null to create).",
    };
  const yieldResult = validateOwnerYieldPercent(
    input.dividendYieldPercentDecimal,
  );
  if (!yieldResult.ok) return { message: yieldResult.message };
  const frankingResult = validateFrankingPercent(input.frankingPercentDecimal);
  if (!frankingResult.ok) return { message: frankingResult.message };
  const growthResult = validateGrowthPercent(
    input.dividendGrowthPercentDecimal,
  );
  if (!growthResult.ok) return { message: growthResult.message };
  // DIV-016 part B: `forceAssumption` omitted or anything other than the
  // literal boolean `true` reads as `false` -- never implicitly forced.
  const forceAssumption = input.forceAssumption === true;
  return {
    portfolioSecurityId,
    dividendYieldPercentDecimal: yieldResult.value,
    frankingPercentDecimal: frankingResult.value,
    dividendGrowthPercentDecimal: growthResult.value,
    forceAssumption,
    expectedVersion,
  };
}

function parseGridPortfolio(
  value: unknown,
): DividendAssumptionsGridPortfolioInput | { message: string } {
  const input = record(value);
  const expectedVersion = expectedVersionOf(input.expectedVersion);
  if (expectedVersion === undefined)
    return {
      message: "The portfolio row needs a valid version (or null to create).",
    };
  const valueGrowthResult = validateValueGrowthPercent(
    input.valueGrowthPercentDecimal,
  );
  if (!valueGrowthResult.ok) return { message: valueGrowthResult.message };
  const dividendGrowthResult = validateGrowthPercent(
    input.portfolioDividendGrowthPercentDecimal,
    "Portfolio dividend growth %",
  );
  if (!dividendGrowthResult.ok)
    return { message: dividendGrowthResult.message };
  return {
    valueGrowthPercentDecimal: valueGrowthResult.value,
    portfolioDividendGrowthPercentDecimal: dividendGrowthResult.value,
    expectedVersion,
  };
}

export async function saveDividendAssumptionsGridWithContext(
  context: DividendActionContext,
  portfolioId: string,
  value: unknown,
): Promise<DividendAssumptionsGridActionResult> {
  const input = record(value);
  const rawSecurities = Array.isArray(input.securities)
    ? input.securities
    : null;
  if (!rawSecurities) {
    return {
      ok: false,
      status: 400,
      message: "A list of security assumption rows is required.",
      appliedSecurities: [],
    };
  }
  const parsedSecurities: DividendAssumptionsGridSecurityInput[] = [];
  for (const raw of rawSecurities) {
    const parsed = parseGridRow(raw);
    if ("message" in parsed)
      return {
        ok: false,
        status: 400,
        message: parsed.message,
        appliedSecurities: [],
      };
    parsedSecurities.push(parsed);
  }
  const parsedPortfolio = parseGridPortfolio(input.portfolio);
  if ("message" in parsedPortfolio)
    return {
      ok: false,
      status: 400,
      message: parsedPortfolio.message,
      appliedSecurities: [],
    };

  const assumptions = createDividendAssumptionsRepository(context.client);
  const appliedSecurities: SavedAssumptionsRow[] = [];
  for (const row of parsedSecurities) {
    const result = await assumptions.saveSecurityAssumptions(
      context.userId,
      portfolioId,
      row.portfolioSecurityId,
      {
        dividendYieldPercentDecimal: row.dividendYieldPercentDecimal,
        frankingPercentDecimal: row.frankingPercentDecimal,
        dividendGrowthPercentDecimal: row.dividendGrowthPercentDecimal,
        forceAssumption: row.forceAssumption,
        expectedVersion: row.expectedVersion,
        requestId: context.requestId,
      },
    );
    if (!result.ok) {
      return {
        ok: false,
        status:
          result.reason === "version_conflict"
            ? 409
            : result.reason === "not_found"
              ? 404
              : result.reason === "invalid_input"
                ? 400
                : 503,
        message:
          result.reason === "version_conflict"
            ? "This security's assumptions changed elsewhere -- reload and retry."
            : result.reason === "not_found"
              ? "That security is not held in this portfolio."
              : "The assumption row could not be saved.",
        appliedSecurities,
        failedPortfolioSecurityId: row.portfolioSecurityId,
      };
    }
    appliedSecurities.push({
      portfolioSecurityId: row.portfolioSecurityId,
      version: result.assumptions.version,
    });
  }

  const portfolioResult = await assumptions.savePortfolioAssumptions(
    context.userId,
    portfolioId,
    {
      valueGrowthPercentDecimal: parsedPortfolio.valueGrowthPercentDecimal,
      portfolioDividendGrowthPercentDecimal:
        parsedPortfolio.portfolioDividendGrowthPercentDecimal,
      expectedVersion: parsedPortfolio.expectedVersion,
      requestId: context.requestId,
    },
  );
  if (!portfolioResult.ok) {
    return {
      ok: false,
      status:
        portfolioResult.reason === "version_conflict"
          ? 409
          : portfolioResult.reason === "not_found"
            ? 404
            : portfolioResult.reason === "invalid_input"
              ? 400
              : 503,
      message:
        portfolioResult.reason === "version_conflict"
          ? "The portfolio-level assumptions changed elsewhere -- reload and retry."
          : "The portfolio-level assumptions could not be saved.",
      appliedSecurities,
    };
  }

  return {
    ok: true,
    securities: appliedSecurities,
    portfolio: { version: portfolioResult.assumptions.version },
  };
}

export async function saveDividendAssumptionsGridAction(
  portfolioId: string,
  value: unknown,
): Promise<DividendAssumptionsGridActionResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return { ...context, appliedSecurities: [] };
  return saveDividendAssumptionsGridWithContext(context, portfolioId, value);
}

// ---------------------------------------------------------------------------
// Save a dividend entry: routes to `dividend_manual_records` (no linked
// event) or `dividend_event_overrides` (a linked event, including the
// "Exclude this dividend" flag) based on whether `dividendEventId` is
// present -- the persistence-mapping decision this task documents in
// `docs/CALCULATIONS.md` section 11.
// ---------------------------------------------------------------------------

export type DividendEntryActionResult =
  | {
      ok: true;
      target: "manual_record" | "event_override";
      id: string;
      version: number;
      /** DIV-004: a non-blocking proximity warning when this payment date lands within `PROXIMITY_WINDOW_DAYS` days of another existing owner-typed entry for the same security. */
      proximityWarning: string | null;
      /** UI-009 finishing item 1, extended by DIV-016 part A to the
       * manual-record CORRECTION (supersede) path too: `deduped` true means
       * an idempotency-key retry matched an EXISTING record (a fresh CREATE,
       * or -- DIV-016 -- an already-applied correction) rather than
       * creating a second one; `storedDiffers` additionally means the
       * incoming payload's material fields differ from what is actually
       * stored (e.g. the owner edited the form between the original
       * save/edit and a client-visible-timeout retry) -- `storedRecord`
       * then carries the real persisted values (whichever amount mode
       * actually won) so the caller can resync its form instead of
       * silently claiming the just-submitted values were saved. Disclosure
       * parity: this applies identically whether the dedupe matched a
       * CREATE or a correction (supersede) -- an owner who edits the form
       * again during a timeout-triggered retry must see the same honest
       * "this matched an earlier save" resync either way. */
      deduped?: boolean;
      storedDiffers?: boolean;
      storedRecord?: {
        paymentDate: string;
        sharesDecimal: string | null;
        dividendPerShareDecimal: string | null;
        frankingCreditPerShareDecimal: string | null;
        totalCashDecimal: string | null;
        totalFrankingDecimal: string | null;
      };
    }
  | ActionFailure;

/**
 * UI-009 finishing item 1 / DIV-016 part A: the STORED-truth disclosure
 * shape for a `dividend_manual_records` row, shared by both the CREATE
 * dedupe path and the supersede (correction) dedupe path so the two never
 * drift -- reads whichever amount mode the record actually is (BRK-005
 * totals vs. per-share) rather than assuming one.
 */
function manualRecordStoredDisclosure(record: DividendManualRecordRecord): {
  paymentDate: string;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  totalCashDecimal: string | null;
  totalFrankingDecimal: string | null;
} {
  return record.sharesDecimal !== null &&
    record.dividendPerShareDecimal !== null
    ? {
        paymentDate: record.paymentDate,
        sharesDecimal: record.sharesDecimal,
        dividendPerShareDecimal: record.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
        totalCashDecimal: null,
        totalFrankingDecimal: null,
      }
    : {
        paymentDate: record.paymentDate,
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: record.totalCashDecimal,
        totalFrankingDecimal: record.totalFrankingDecimal,
      };
}

export async function computeProximityWarning(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  portfolioSecurityId: string,
  paymentDate: string,
  excludeManualRecordId: string | null,
): Promise<string | null> {
  const [manualRecords, receipts] = await Promise.all([
    createDividendManualRecordRepository(client).list(
      userId,
      portfolioId,
      portfolioSecurityId,
    ),
    createDividendReceiptRepository(client).list(userId, portfolioId),
  ]);
  const existingDates: string[] = [
    ...manualRecords
      .filter((row) => row.id !== excludeManualRecordId)
      .map((row) => row.paymentDate),
    ...receipts
      .filter((row) => row.portfolioSecurityId === portfolioSecurityId)
      .map((row) => row.paymentDate),
  ];
  const near = existingDates.some(
    (existing) =>
      Math.abs(daysBetweenDates(existing, paymentDate)) <=
      PROXIMITY_WINDOW_DAYS,
  );
  return near
    ? `This dividend is within ${PROXIMITY_WINDOW_DAYS} days of an existing entry already recorded for this security -- check it is not a duplicate before saving.`
    : null;
}

export async function saveDividendEntryWithContext(
  context: DividendActionContext,
  portfolioId: string,
  value: unknown,
): Promise<DividendEntryActionResult> {
  const input = record(value);
  const portfolioSecurityId =
    typeof input.portfolioSecurityId === "string" &&
    input.portfolioSecurityId.length > 0
      ? input.portfolioSecurityId
      : null;
  const dividendEventId =
    typeof input.dividendEventId === "string" &&
    input.dividendEventId.length > 0
      ? input.dividendEventId
      : null;
  const manualRecordId =
    typeof input.manualRecordId === "string" && input.manualRecordId.length > 0
      ? input.manualRecordId
      : null;
  // UI-009: best-effort dedupe key for the standalone manual-record CREATE
  // below (client-generated, stable across retries within one dialog
  // session -- see RecordDividendDialog). Absent/malformed is never a
  // client error here: it only disables the idempotency guard for this
  // particular request, it never blocks the save itself.
  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0
      ? input.idempotencyKey
      : null;
  if (!portfolioSecurityId) {
    return { ok: false, status: 400, message: "A security is required." };
  }

  const paymentDate = input.paymentDate;
  if (!isValidDateString(paymentDate)) {
    return {
      ok: false,
      status: 400,
      message: "A valid payment date is required.",
    };
  }
  // B2 (review fix): `sharesDecimal`/`dividendPerShareDecimal`/
  // `frankingCreditPerShareDecimal` keep the ORIGINAL strict semantics
  // (an omitted key is malformed, 400) for EVERY branch, including the
  // event-linked one -- these three fields predate DIV-016 and the
  // event-linked path's tri-state save (`dividend_event_overrides.save()`)
  // relies on `undefined` reading as "malformed", never as "omitted,
  // clear this field" (a prior version of this change loosened all three
  // uniformly, which let an event-linked save with an OMITTED sharesDecimal
  // silently clear the stored override's shares field via the repository's
  // `hasOwn` tri-state instead of failing closed with 400 -- reproduced and
  // fixed). The dialog for BOTH branches always sends these three keys
  // explicitly (a controlled form), so this strictness costs nothing in
  // practice.
  const sharesDecimal = nullableString(input.sharesDecimal);
  const dividendPerShareDecimal = nullableString(input.dividendPerShareDecimal);
  const frankingCreditPerShareDecimal = nullableString(
    input.frankingCreditPerShareDecimal,
  );
  // DIV-016 part A: the BRK-005 totals shape, now also reachable from the
  // owner-facing manual-entry dialog (previously only the Sharesight
  // import-commit path ever wrote these two fields) -- entirely NEW fields
  // with no pre-DIV-016 caller, and never read by the event-linked branch
  // at all, so an omitted key reads as `null` here (never malformed) --
  // this is unlike the three fields above, which have an established
  // "omission is malformed" contract on the event-linked path this change
  // must not disturb.
  const optionalNullableString = (value: unknown): string | null | undefined =>
    value === undefined ? null : nullableString(value);
  const totalCashDecimal = optionalNullableString(input.totalCashDecimal);
  const totalFrankingDecimal = optionalNullableString(
    input.totalFrankingDecimal,
  );
  const amountMode = input.amountMode === "totals" ? "totals" : "per_share";
  if (
    sharesDecimal === undefined ||
    dividendPerShareDecimal === undefined ||
    frankingCreditPerShareDecimal === undefined ||
    totalCashDecimal === undefined ||
    totalFrankingDecimal === undefined
  ) {
    return {
      ok: false,
      status: 400,
      message: "Dividend amounts are malformed.",
    };
  }
  if (
    frankingCreditPerShareDecimal !== null &&
    !isNonNegativeDecimalString(frankingCreditPerShareDecimal)
  ) {
    return {
      ok: false,
      status: 400,
      message: "Franking credit per share cannot be negative.",
    };
  }

  const proximityWarning = await computeProximityWarning(
    context.client,
    context.userId,
    portfolioId,
    portfolioSecurityId,
    paymentDate,
    dividendEventId === null ? manualRecordId : null,
  );

  if (dividendEventId !== null) {
    // Event-linked: sparse tri-state fields against `dividend_event_overrides`.
    const expectedVersion = expectedVersionOf(input.expectedVersion);
    if (expectedVersion === undefined) {
      return {
        ok: false,
        status: 400,
        message: "A valid version is required.",
      };
    }
    if (sharesDecimal !== null && !isPositiveDecimalString(sharesDecimal)) {
      return {
        ok: false,
        status: 400,
        message: "Shares must be a positive number.",
      };
    }
    if (
      dividendPerShareDecimal !== null &&
      !isPositiveDecimalString(dividendPerShareDecimal)
    ) {
      return {
        ok: false,
        status: 400,
        message: "Dividend per share must be a positive number.",
      };
    }
    const exclude = input.exclude === true;
    const result = await createDividendEventOverrideRepository(
      context.client,
    ).save(context.userId, portfolioId, portfolioSecurityId, dividendEventId, {
      sharesDecimal,
      dividendPerShareDecimal,
      frankingCreditPerShareDecimal,
      exclude,
      expectedVersion,
      requestId: context.requestId,
    });
    if (!result.ok) {
      return {
        ok: false,
        status:
          result.reason === "version_conflict"
            ? 409
            : result.reason === "not_found"
              ? 404
              : result.reason === "invalid_input"
                ? 400
                : 503,
        message:
          result.reason === "version_conflict"
            ? "This dividend changed elsewhere -- reload and retry."
            : result.reason === "not_found"
              ? "That security or dividend event was not found."
              : "The dividend override could not be saved.",
      };
    }
    return {
      ok: true,
      target: "event_override",
      id: result.override.id,
      version: result.override.version,
      proximityWarning,
    };
  }

  // No linked event: `dividend_manual_records`, either a brand-new record
  // or a correction (supersession, DIV-016 part A) of an existing
  // owner-typed one. `amountMode` picks one of two mutually-exclusive
  // shapes (mirrors `dividend_manual_records_amount_mode_check` and
  // `validateManualRecordAmounts`'s re-validation of the same invariant at
  // the repository boundary): PER-SHARE (shares + per-share amounts) or
  // TOTALS (a BRK-005-shaped total cash + total franking figure).
  let sharesForSave: string | null = null;
  let dividendPerShareForSave: string | null = null;
  let frankingPerShareForSave: string | null = null;
  let totalCashForSave: string | null = null;
  let totalFrankingForSave: string | null = null;
  // BUG-022: `isPositiveDecimalString`/`isNonNegativeDecimalString` above
  // bound FORM only (digits and an optional decimal point), never SIZE.
  // `db/repositories/dividends.ts`'s `validateManualRecordAmounts`/
  // `resolveSupersedeAmounts` are the authoritative boundary (bounded at
  // `isWithinReadPathDecimalBounds`, this file's follow-up import) and
  // reject a too-large value regardless of what happens here -- but a
  // generic "could not be saved" from that repository rejection gives the
  // owner no way to tell WHICH field was wrong. Pre-checking the same bound
  // here, on this file's already-parsed local variables, lets the field
  // actually at fault name itself before the request even reaches the
  // repository.
  function amountBoundMessage(field: string): string {
    return `${field} must have at most 24 decimal places and 64 digits in total.`;
  }
  if (amountMode === "totals") {
    if (
      totalCashDecimal === null ||
      !isPositiveDecimalString(totalCashDecimal)
    ) {
      return {
        ok: false,
        status: 400,
        message: "Total cash must be a positive number.",
      };
    }
    if (!isWithinReadPathDecimalBounds(totalCashDecimal)) {
      return {
        ok: false,
        status: 400,
        message: amountBoundMessage("Total cash"),
      };
    }
    if (
      totalFrankingDecimal !== null &&
      !isWithinReadPathDecimalBounds(totalFrankingDecimal)
    ) {
      return {
        ok: false,
        status: 400,
        message: amountBoundMessage("Total franking credits"),
      };
    }
    totalCashForSave = totalCashDecimal;
    totalFrankingForSave = totalFrankingDecimal;
  } else {
    if (sharesDecimal === null || !isPositiveDecimalString(sharesDecimal)) {
      return {
        ok: false,
        status: 400,
        message: "Shares must be a positive number.",
      };
    }
    if (!isWithinReadPathDecimalBounds(sharesDecimal)) {
      return {
        ok: false,
        status: 400,
        message: amountBoundMessage("Shares"),
      };
    }
    if (
      dividendPerShareDecimal === null ||
      !isPositiveDecimalString(dividendPerShareDecimal)
    ) {
      return {
        ok: false,
        status: 400,
        message: "Dividend per share must be a positive number.",
      };
    }
    if (!isWithinReadPathDecimalBounds(dividendPerShareDecimal)) {
      return {
        ok: false,
        status: 400,
        message: amountBoundMessage("Dividend per share"),
      };
    }
    if (
      frankingCreditPerShareDecimal !== null &&
      !isWithinReadPathDecimalBounds(frankingCreditPerShareDecimal)
    ) {
      return {
        ok: false,
        status: 400,
        message: amountBoundMessage("Franking credit per share"),
      };
    }
    sharesForSave = sharesDecimal;
    dividendPerShareForSave = dividendPerShareDecimal;
    frankingPerShareForSave = frankingCreditPerShareDecimal;
  }

  const repository = createDividendManualRecordRepository(context.client);
  if (manualRecordId !== null) {
    const expectedVersion = expectedVersionOf(input.expectedVersion);
    if (typeof expectedVersion !== "number") {
      return {
        ok: false,
        status: 400,
        message: "A valid version is required to edit an existing record.",
      };
    }
    // B1 (UI-006B review fix, still enforced under DIV-016 part A's
    // supersede()): an IMPORTED row (`import_batch_id` set by IMP-006's CSV
    // commit) is not owner-editable through this form -- its facts change
    // only by reversing the import batch that created it (preserving
    // IMP-006's reversal accounting and keeping the imported tier's numbers
    // honestly attributed to the provider/import source, never blended with
    // an owner edit). Checked explicitly here so the rejection carries a
    // specific, actionable message; the repository's `import_batch_id IS
    // NULL` predicate is defense-in-depth against a future caller that
    // skips this check.
    const existing = await repository.get(
      context.userId,
      portfolioId,
      manualRecordId,
    );
    if (existing && existing.importBatchId !== null) {
      return {
        ok: false,
        status: 409,
        message:
          "This is an imported dividend row. Imported rows can only be changed by reversing the import batch that created them.",
      };
    }
    // DIV-016 part A: corrections are NEVER an in-place rewrite -- see
    // `db/repositories/dividends.ts`'s `supersede()` (replaces the
    // pre-DIV-016 `update()`). Success returns the NEW row's id/version;
    // the original row is retained, unmodified, and marked superseded.
    const result = await repository.supersede(
      context.userId,
      portfolioId,
      manualRecordId,
      {
        paymentDate,
        sharesDecimal: sharesForSave,
        dividendPerShareDecimal: dividendPerShareForSave,
        frankingCreditPerShareDecimal: frankingPerShareForSave,
        totalCashDecimal: totalCashForSave,
        totalFrankingDecimal: totalFrankingForSave,
        expectedVersion,
        idempotencyKey,
        requestId: context.requestId,
      },
    );
    if (!result.ok) {
      return {
        ok: false,
        status:
          result.reason === "version_conflict"
            ? 409
            : result.reason === "not_found"
              ? 404
              : result.reason === "invalid_input"
                ? 400
                : 503,
        message:
          result.reason === "version_conflict"
            ? "This dividend changed elsewhere -- reload and retry."
            : result.reason === "not_found"
              ? "That dividend record was not found."
              : "The dividend record could not be saved.",
      };
    }
    return {
      ok: true,
      target: "manual_record",
      id: result.record.id,
      version: result.record.version,
      proximityWarning,
      deduped: result.deduped,
      storedDiffers: result.storedDiffers,
      storedRecord: result.storedDiffers
        ? manualRecordStoredDisclosure(result.record)
        : undefined,
    };
  }

  const result = await repository.create(context.userId, portfolioId, {
    portfolioSecurityId,
    paymentDate,
    sharesDecimal: sharesForSave,
    dividendPerShareDecimal: dividendPerShareForSave,
    frankingCreditPerShareDecimal: frankingPerShareForSave,
    totalCashDecimal: totalCashForSave,
    totalFrankingDecimal: totalFrankingForSave,
    idempotencyKey,
    requestId: context.requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      status:
        result.reason === "not_found"
          ? 404
          : result.reason === "invalid_input"
            ? 400
            : 503,
      message:
        result.reason === "not_found"
          ? "That security is not held in this portfolio."
          : "The dividend record could not be saved.",
    };
  }
  // BRK-005/DIV-016: the stored record is EITHER shape (per-share or
  // totals) depending on `amountMode` above; disclose whichever one the
  // STORED record actually is, never the just-submitted payload.
  const storedRecord = result.storedDiffers
    ? manualRecordStoredDisclosure(result.record)
    : undefined;
  return {
    ok: true,
    target: "manual_record",
    id: result.record.id,
    version: result.record.version,
    proximityWarning,
    deduped: result.deduped,
    storedDiffers: result.storedDiffers,
    storedRecord,
  };
}

export async function saveDividendEntryAction(
  portfolioId: string,
  value: unknown,
): Promise<DividendEntryActionResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return context;
  return saveDividendEntryWithContext(context, portfolioId, value);
}

export type DeleteDividendManualRecordActionResult =
  { ok: true } | ActionFailure;

export async function deleteDividendManualRecordWithContext(
  context: DividendActionContext,
  portfolioId: string,
  value: unknown,
): Promise<DeleteDividendManualRecordActionResult> {
  const input = record(value);
  const manualRecordId =
    typeof input.manualRecordId === "string" && input.manualRecordId.length > 0
      ? input.manualRecordId
      : null;
  const expectedVersion = input.expectedVersion;
  if (!manualRecordId || typeof expectedVersion !== "number") {
    return {
      ok: false,
      status: 400,
      message: "A record id and its current version are required.",
    };
  }
  const manualRecordRepository = createDividendManualRecordRepository(
    context.client,
  );
  // B1: same imported-row immutability rule as the update branch above --
  // an imported row is deleted only by reversing its import batch, never
  // through this owner-facing "Exclude this dividend" action.
  const existing = await manualRecordRepository.get(
    context.userId,
    portfolioId,
    manualRecordId,
  );
  if (existing && existing.importBatchId !== null) {
    return {
      ok: false,
      status: 409,
      message:
        "This is an imported dividend row. Imported rows can only be changed by reversing the import batch that created them.",
    };
  }
  const result = await manualRecordRepository.remove(
    context.userId,
    portfolioId,
    manualRecordId,
    expectedVersion,
    context.requestId,
  );
  if (!result.ok) {
    return {
      ok: false,
      status:
        result.reason === "version_conflict"
          ? 409
          : result.reason === "not_found"
            ? 404
            : result.reason === "invalid_input"
              ? 400
              : 503,
      message:
        result.reason === "version_conflict"
          ? "This dividend changed elsewhere -- reload and retry."
          : "The dividend record could not be removed.",
    };
  }
  return { ok: true };
}

export async function deleteDividendManualRecordAction(
  portfolioId: string,
  value: unknown,
): Promise<DeleteDividendManualRecordActionResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return context;
  return deleteDividendManualRecordWithContext(context, portfolioId, value);
}

// ---------------------------------------------------------------------------
// BRK-011: owner-entered franking-currency override for a foreign-currency
// Sharesight payout -- tier 3 of the owner's BINDING resolution cascade
// (see docs/CALCULATIONS.md section 11). `db/repositories/dividends.ts`'s
// `createDividendImportFrankingOverrideRepository` already enforces the
// imported-row precondition (`ownedImportedManualRecord`: the target must
// be a Sharesight-sourced, `import_batch_id`-attributed row); this layer
// only validates the request shape, mirroring `saveDividendFyOverrideWithContext`'s
// structure exactly (a single required decimal field, `expectedVersion`
// null-or-number for create-or-update).
// ---------------------------------------------------------------------------

export type DividendFrankingOverrideActionResult =
  { ok: true; id: string; version: number } | ActionFailure;

export async function saveDividendFrankingOverrideWithContext(
  context: DividendActionContext,
  portfolioId: string,
  value: unknown,
): Promise<DividendFrankingOverrideActionResult> {
  const input = record(value);
  const portfolioSecurityId =
    typeof input.portfolioSecurityId === "string" &&
    input.portfolioSecurityId.length > 0
      ? input.portfolioSecurityId
      : null;
  const dividendManualRecordId =
    typeof input.dividendManualRecordId === "string" &&
    input.dividendManualRecordId.length > 0
      ? input.dividendManualRecordId
      : null;
  if (!portfolioSecurityId || !dividendManualRecordId) {
    return {
      ok: false,
      status: 400,
      message: "A security and dividend record are required.",
    };
  }
  const frankingTotalDecimal = input.frankingTotalDecimal;
  if (
    typeof frankingTotalDecimal !== "string" ||
    !isNonNegativeDecimalString(frankingTotalDecimal)
  ) {
    return {
      ok: false,
      status: 400,
      message: "Franking credits must be a non-negative amount.",
    };
  }
  const expectedVersion = expectedVersionOf(input.expectedVersion);
  if (expectedVersion === undefined) {
    return { ok: false, status: 400, message: "A valid version is required." };
  }

  const result = await createDividendImportFrankingOverrideRepository(
    context.client,
  ).save(
    context.userId,
    portfolioId,
    portfolioSecurityId,
    dividendManualRecordId,
    {
      frankingTotalDecimal,
      expectedVersion,
      requestId: context.requestId,
    },
  );
  if (!result.ok) {
    return {
      ok: false,
      status:
        result.reason === "version_conflict"
          ? 409
          : result.reason === "not_found"
            ? 404
            : result.reason === "invalid_input"
              ? 400
              : 503,
      message:
        result.reason === "version_conflict"
          ? "This override changed elsewhere -- reload and retry."
          : result.reason === "not_found"
            ? "That dividend record was not found, or is not an imported foreign-currency payout."
            : "The franking override could not be saved.",
    };
  }
  return { ok: true, id: result.override.id, version: result.override.version };
}

export async function saveDividendFrankingOverrideAction(
  portfolioId: string,
  value: unknown,
): Promise<DividendFrankingOverrideActionResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return context;
  return saveDividendFrankingOverrideWithContext(context, portfolioId, value);
}

// ---------------------------------------------------------------------------
// Past-FY override: gross + franking, cash derived at read time (DIV-001).
// ---------------------------------------------------------------------------

export type DividendFyOverrideActionResult =
  | { ok: true; financialYearEndingYear: number; version: number }
  | ActionFailure;

export async function saveDividendFyOverrideWithContext(
  context: DividendActionContext,
  portfolioId: string,
  value: unknown,
): Promise<DividendFyOverrideActionResult> {
  const input = record(value);
  const financialYearEndingYear = input.financialYearEndingYear;
  if (
    typeof financialYearEndingYear !== "number" ||
    !Number.isInteger(financialYearEndingYear) ||
    financialYearEndingYear < 1900 ||
    financialYearEndingYear > 2999
  ) {
    return {
      ok: false,
      status: 400,
      message: "A valid financial year is required.",
    };
  }
  const grossedAmountDecimal = input.grossedAmountDecimal;
  if (!isNonNegativeDecimalString(grossedAmountDecimal)) {
    return {
      ok: false,
      status: 400,
      message: "Total gross dividends must be a non-negative amount.",
    };
  }
  const frankingAmountDecimal = nullableString(input.frankingAmountDecimal);
  if (
    frankingAmountDecimal === undefined ||
    (frankingAmountDecimal !== null &&
      !isNonNegativeDecimalString(frankingAmountDecimal))
  ) {
    return {
      ok: false,
      status: 400,
      message: "Franking credits must be a non-negative amount, or left blank.",
    };
  }
  const expectedVersion = expectedVersionOf(input.expectedVersion);
  if (expectedVersion === undefined) {
    return { ok: false, status: 400, message: "A valid version is required." };
  }

  const result = await createDividendFyOverrideRepository(context.client).save(
    context.userId,
    portfolioId,
    financialYearEndingYear,
    {
      grossedAmountDecimal,
      frankingAmountDecimal,
      expectedVersion,
      requestId: context.requestId,
    },
  );
  if (!result.ok) {
    return {
      ok: false,
      status:
        result.reason === "version_conflict"
          ? 409
          : result.reason === "not_found"
            ? 404
            : result.reason === "invalid_input"
              ? 400
              : 503,
      message:
        result.reason === "version_conflict"
          ? "This financial year's override changed elsewhere -- reload and retry."
          : "The financial-year override could not be saved.",
    };
  }
  return {
    ok: true,
    financialYearEndingYear: result.override.financialYearEndingYear,
    version: result.override.version,
  };
}

export async function saveDividendFyOverrideAction(
  portfolioId: string,
  value: unknown,
): Promise<DividendFyOverrideActionResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return context;
  return saveDividendFyOverrideWithContext(context, portfolioId, value);
}

// ---------------------------------------------------------------------------
// Shares held at a date: server-derived auto-population for the per-share
// entry form (DIV-001's `deriveSharesHeldAtDate`), scoped to one owned
// holding.
// ---------------------------------------------------------------------------

export type SharesAtDateActionResult =
  { ok: true; sharesDecimal: string } | ActionFailure;

export async function sharesAtDateWithContext(
  context: DividendActionContext,
  portfolioId: string,
  value: unknown,
): Promise<SharesAtDateActionResult> {
  const input = record(value);
  const portfolioSecurityId =
    typeof input.portfolioSecurityId === "string" &&
    input.portfolioSecurityId.length > 0
      ? input.portfolioSecurityId
      : null;
  const date = input.date;
  if (!portfolioSecurityId || !isValidDateString(date)) {
    return {
      ok: false,
      status: 400,
      message: "A security and a valid date are required.",
    };
  }

  const holding = await context.client.get<{ id: string }>(
    `SELECT id FROM portfolio_securities WHERE id = ? AND user_id = ? AND portfolio_id = ? LIMIT 1`,
    [portfolioSecurityId, context.userId, portfolioId],
  );
  if (!holding) {
    return { ok: false, status: 404, message: "That security was not found." };
  }

  const rows = await context.client.all<Record<string, unknown>>(
    `SELECT id, type, status, local_trade_date, trade_at, quantity_decimal,
            unit_price_decimal, reverses_transaction_id
     FROM transactions
     WHERE user_id = ? AND portfolio_id = ? AND portfolio_security_id = ?
       AND status IN ('posted', 'reversed')
     ORDER BY local_trade_date, trade_at, id
     LIMIT ?`,
    [
      context.userId,
      portfolioId,
      portfolioSecurityId,
      MAX_TRANSACTIONS_PER_SECURITY + 1,
    ],
  );
  if (rows.length > MAX_TRANSACTIONS_PER_SECURITY) {
    return {
      ok: false,
      status: 503,
      message:
        "This security has too much ledger history for shares-at-date to compute safely. Enter shares manually.",
    };
  }
  const transactions = rows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    status: String(row.status) as "posted" | "reversed",
    localTradeDate: String(row.local_trade_date),
    tradeAt: String(row.trade_at),
    quantityDecimal:
      row.quantity_decimal === null ? null : String(row.quantity_decimal),
    unitPriceDecimal:
      row.unit_price_decimal === null ? null : String(row.unit_price_decimal),
    reversesTransactionId:
      row.reverses_transaction_id === null
        ? null
        : String(row.reverses_transaction_id),
  }));

  const sharesDecimal = deriveSharesHeldAtDate(transactions, date);
  return { ok: true, sharesDecimal };
}

export async function sharesAtDateAction(
  portfolioId: string,
  value: unknown,
): Promise<SharesAtDateActionResult> {
  const context = await authenticatedContext(portfolioId);
  if (!("client" in context)) return context;
  return sharesAtDateWithContext(context, portfolioId, value);
}
