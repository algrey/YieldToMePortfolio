// DIV-012 (owner directive, 2026-08-24): pure helpers for the Multi-Year
// income view's what-if growth inputs, split out of
// `app/components/income-multi-year.tsx` into a plain `.ts` module (no JSX)
// so `tests/div-012.test.ts` can import them directly under the repo's
// `node --experimental-strip-types` test runner, which cannot load a
// `.tsx` file's JSX syntax at module import time (type-stripping only,
// no JSX transform) -- `.tsx` files are otherwise only ever exercised via
// the `tsx`-loader child-process render trick used across `tests/*.test.ts`.

/** A plain, optionally-signed decimal growth percentage -- "3", "-1.5", but
 * not scientific notation, a percent sign, or anything non-numeric. */
export function isValidGrowthInput(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value.trim());
}

/** DIV-012 (owner directive + review B3 ruling): the settled-invalid/empty
 * FALLBACK for a what-if growth input. The inputs themselves SEED from the
 * portfolio's saved growth assumption when one is recorded (owner-set values
 * are never overridden -- CALCULATIONS DIV-011); this constant applies only
 * when no assumption exists or an edited value settles empty/invalid. */
export const WHATIF_DEFAULT_GROWTH_PERCENT_DECIMAL = "6";

/** DIV-012: resolves a raw what-if growth input to the decimal string
 * actually fed into the live projection -- an empty or invalid entry
 * (mid-typing a bare "-" or "." included) honestly falls back to the real,
 * non-zero 6%/yr default, NEVER a fabricated "0" and NEVER a NaN reaching
 * the pure domain projector. Exported so this fallback contract is
 * independently unit-testable without rendering the component (see
 * `tests/div-012.test.ts`). Each of the two growth axes in
 * `IncomeMultiYear` calls this on its OWN input only, so the two fields'
 * resolved values can never cross-influence one another -- see that
 * component's module header for the root-cause note this replaces.
 */
export function resolveWhatIfGrowthPercentDecimal(raw: string): string {
  const trimmed = raw.trim();
  return isValidGrowthInput(trimmed)
    ? trimmed
    : WHATIF_DEFAULT_GROWTH_PERCENT_DECIMAL;
}

// ---------------------------------------------------------------------------
// DIV-013 (owner directive, 2026-08-24): pure helpers for the "Add/Remove
// Capital" what-if subsection -- draft-row validation, sort order, the
// session-storage read/write pair (dependency-injected on a `StorageLike`
// so `tests/div-013.test.ts` can exercise them against an in-memory fake
// without a DOM/`sessionStorage` global), and the mapping into the pure
// domain projector's own `CapitalEventInput` shape
// (`domain/dividends/projection.ts`). Split out for the identical reason
// the DIV-012 helpers above are: this file has no JSX, so it can be
// imported directly by the repo's native-`node --experimental-strip-types`
// test runner.
import type { CapitalEventInput } from "../domain/dividends/projection.ts";
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  formatDecimalExact,
  formatDecimalTrimmed,
  fromInteger,
  multiplyDecimal,
  parseDecimal,
} from "../domain/calculations/decimal.ts";

/** DIV-013 owner defaults ("dividend yield (default 2%)"; "name (default
 * 'Change')"). */
export const CAPITAL_EVENT_DEFAULT_YIELD_PERCENT_DECIMAL = "2";
export const CAPITAL_EVENT_DEFAULT_NAME = "Change";

/** One COMMITTED (post-Apply) capital-change row -- the state shape a
 * future DIV-014 "save this scenario" task can persist verbatim (owner
 * directive: "design the state shape so DIV-014 can persist it: capital
 * rows incl. blank-follow flags"). `capitalGrowthPercentDecimal`/
 * `dividendGrowthPercentDecimal` being `null` (not an empty string, not
 * omitted) IS the blank-follows-portfolio flag -- the same tri-state
 * contract `CapitalEventInput` uses, deliberately, so this type maps onto
 * it with no lossy conversion in either direction. */
export type CapitalEventRowState = {
  id: string;
  name: string;
  amountDecimal: string;
  month: number;
  year: number;
  yieldPercentDecimal: string;
  capitalGrowthPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
};

/** The full session-persisted shape (owner directive: "session persistence
 * ... capital rows incl. blank-follow flags + reinvest flag"). */
export type CapitalEventsSessionState = {
  rows: CapitalEventRowState[];
  reinvestDividends: boolean;
};

/** The raw (uncommitted, still-being-typed) "Add/Remove Capital" input
 * fields -- `month`/`year` are already-parsed numbers (the month comes from
 * a `<select>`, always a valid 1-12 integer by construction; the year comes
 * from a free-text field and may be `NaN` here, caught by
 * `isValidCapitalEventDraft` below exactly like every other field).
 * `capitalGrowthInput`/`dividendGrowthInput` stay RAW strings (not yet
 * null-coerced) so an in-progress "" can be told apart from a settled
 * invalid entry by the caller's own hint logic, mirroring the DIV-012
 * growth-input convention above. */
export type CapitalEventDraft = {
  name: string;
  amountDecimal: string;
  month: number;
  year: number;
  yieldPercentDecimal: string;
  capitalGrowthInput: string;
  dividendGrowthInput: string;
};

/** DIV-013 owner directive: "month + year (default January next year)".
 * Takes an explicit reference date (never calls `new Date()` itself) so
 * this stays a pure, independently unit-testable function -- the component
 * supplies `new Date()` at render time. */
export function defaultCapitalEventMonthYear(referenceDate: Date): {
  month: number;
  year: number;
} {
  return { month: 1, year: referenceDate.getFullYear() + 1 };
}

/**
 * A capital-change draft is Apply-able only when every REQUIRED field is a
 * genuinely valid plain decimal/integer. The two growth fields are the
 * SOLE optional ones (owner directive: blank means live-follow the
 * portfolio), so an empty string is valid there specifically and nowhere
 * else -- amount/yield reuse `isValidGrowthInput`'s plain-signed-decimal
 * grammar (identical shape to a growth percentage: optionally signed,
 * digits, optional decimal point -- no scientific notation, no currency/
 * percent symbols), and month/year must be real integers in range.
 */
export function isValidCapitalEventDraft(draft: CapitalEventDraft): boolean {
  if (!isValidGrowthInput(draft.amountDecimal)) return false;
  if (!isValidGrowthInput(draft.yieldPercentDecimal)) return false;
  if (!Number.isInteger(draft.month) || draft.month < 1 || draft.month > 12) {
    return false;
  }
  if (!Number.isInteger(draft.year) || draft.year < 1900 || draft.year > 2999) {
    return false;
  }
  if (
    draft.capitalGrowthInput.trim() !== "" &&
    !isValidGrowthInput(draft.capitalGrowthInput)
  ) {
    return false;
  }
  if (
    draft.dividendGrowthInput.trim() !== "" &&
    !isValidGrowthInput(draft.dividendGrowthInput)
  ) {
    return false;
  }
  return true;
}

/** Converts a validated draft (caller must have confirmed
 * `isValidCapitalEventDraft` first) into a committed row -- an empty name
 * falls back to the owner's "Change" default; an empty growth field becomes
 * the `null` blank-follows-portfolio flag. */
export function capitalEventDraftToRow(
  draft: CapitalEventDraft,
  id: string,
): CapitalEventRowState {
  return {
    id,
    name:
      draft.name.trim() === "" ? CAPITAL_EVENT_DEFAULT_NAME : draft.name.trim(),
    amountDecimal: draft.amountDecimal.trim(),
    month: draft.month,
    year: draft.year,
    yieldPercentDecimal: draft.yieldPercentDecimal.trim(),
    capitalGrowthPercentDecimal:
      draft.capitalGrowthInput.trim() === ""
        ? null
        : draft.capitalGrowthInput.trim(),
    dividendGrowthPercentDecimal:
      draft.dividendGrowthInput.trim() === ""
        ? null
        : draft.dividendGrowthInput.trim(),
  };
}

/** Owner directive: "sorted by date, oldest at top". `Array.prototype.sort`
 * is a STABLE sort, so two rows sharing a (year, month) keep their existing
 * relative (insertion/apply) order rather than an arbitrary one. */
export function sortCapitalEventRows(
  rows: readonly CapitalEventRowState[],
): CapitalEventRowState[] {
  return [...rows].sort((a, b) => a.year - b.year || a.month - b.month);
}

/** The one place a committed row is mapped onto the pure domain projector's
 * own input shape -- shared by the component's live render path and (once
 * it exists) DIV-014's load-a-saved-scenario path, so the two never drift
 * apart. */
export function capitalEventRowToDomainInput(
  row: CapitalEventRowState,
): CapitalEventInput {
  return {
    id: row.id,
    name: row.name,
    amountDecimal: row.amountDecimal,
    month: row.month,
    year: row.year,
    yieldPercentDecimal: row.yieldPercentDecimal,
    capitalGrowthPercentDecimal: row.capitalGrowthPercentDecimal,
    dividendGrowthPercentDecimal: row.dividendGrowthPercentDecimal,
  };
}

/** The subset of the DOM `Storage` interface this module needs -- lets
 * `tests/div-013.test.ts` pass an in-memory fake instead of a real
 * `sessionStorage` (unavailable under the plain Node test runner), and lets
 * the component pass `window.sessionStorage` unchanged. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** Per-portfolio session-storage key -- namespaced so two portfolios open
 * in the same session (different tabs, or navigating between them) never
 * share or clobber each other's draft capital-change rows. */
export function capitalEventsStorageKey(portfolioId: string): string {
  return `yieldtome:income-whatif-capital-events:${portfolioId}`;
}

/** Exported (DIV-014): reused by `isValidCapitalEventInputRow` below to
 * validate an untrusted saved-scenario row payload from the same shape this
 * sessionStorage guard already trusts. */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensively validates one persisted row's shape before trusting it --
 * `sessionStorage` content is untrusted input (another tab, a stale schema
 * from a future app version, or hand-edited devtools content), never
 * assumed well-formed just because `JSON.parse` succeeded. */
function isValidStoredRow(value: unknown): value is CapitalEventRowState {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.amountDecimal === "string" &&
    typeof value.month === "number" &&
    typeof value.year === "number" &&
    typeof value.yieldPercentDecimal === "string" &&
    (value.capitalGrowthPercentDecimal === null ||
      typeof value.capitalGrowthPercentDecimal === "string") &&
    (value.dividendGrowthPercentDecimal === null ||
      typeof value.dividendGrowthPercentDecimal === "string")
  );
}

/** DIV-013 (owner directive: "persists for the session and resets unless
 * saved"): reads this session's capital-change rows + reinvest flag back
 * out of `storage` (normally `window.sessionStorage`, which browsers
 * already clear at the end of the session -- the "resets on a new session"
 * half of the requirement is satisfied structurally, by the browser API's
 * own contract, not by anything this function does). try/catch wrapped
 * (AGENTS.md: a private/incognito tab, a storage quota, or corrupted JSON
 * must never break rendering) and defensively re-validates every row's
 * shape before trusting it. Returns the honest "nothing recorded this
 * session yet" empty/reinvest-off state on ANY failure, never throws into
 * the caller. */
export function loadCapitalEventsSession(
  storage: StorageLike,
  key: string,
): CapitalEventsSessionState {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { rows: [], reinvestDividends: false };
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return { rows: [], reinvestDividends: false };
    const rows = Array.isArray(parsed.rows)
      ? parsed.rows.filter(isValidStoredRow)
      : [];
    const reinvestDividends = parsed.reinvestDividends === true;
    return { rows, reinvestDividends };
  } catch {
    return { rows: [], reinvestDividends: false };
  }
}

/** Mirror write path -- try/catch wrapped for the identical reasons (a full
 * or blocked storage must never surface as a rendering error; the what-if
 * simply won't survive navigation in that case). */
export function saveCapitalEventsSession(
  storage: StorageLike,
  key: string,
  state: CapitalEventsSessionState,
): void {
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Storage unavailable/full/blocked -- swallowed deliberately.
  }
}

// ---------------------------------------------------------------------------
// DIV-014 (owner directive, 2026-08-24): pure helpers for the "Save
// Scenario" subsection -- the reverse (loaded scenario -> component state)
// mapping DIV-013's own doc comment on `CapitalEventRowState` anticipated,
// the untrusted-payload row validator the server action uses (mirroring
// `isValidStoredRow` above's shape but with full decimal-grammar/range
// checking, since this crosses a real network boundary, not just
// sessionStorage read-back), and the row-summary derivations the saved-
// scenario list row renders (net amount invested, yield).
// ---------------------------------------------------------------------------

/** Server-side name/row caps -- exported so the client input's `maxLength`
 * and the action's own validation share exactly one source of truth. */
export const INCOME_SCENARIO_NAME_MAX_LENGTH = 120;
export const INCOME_SCENARIO_MAX_ROWS = 500;

/** The exact reverse of `capitalEventRowToDomainInput` above -- both types
 * are structurally identical (see that function's own doc comment), so this
 * is a plain field-for-field copy, never a lossy conversion. Used when a
 * saved scenario (persisted as `CapitalEventInput[]`, the domain shape) is
 * loaded back into the component's own `CapitalEventRowState[]` session
 * state. */
export function capitalEventInputToRow(
  input: CapitalEventInput,
): CapitalEventRowState {
  return {
    id: input.id,
    name: input.name,
    amountDecimal: input.amountDecimal,
    month: input.month,
    year: input.year,
    yieldPercentDecimal: input.yieldPercentDecimal,
    capitalGrowthPercentDecimal: input.capitalGrowthPercentDecimal,
    dividendGrowthPercentDecimal: input.dividendGrowthPercentDecimal,
  };
}

/** Full runtime validation of ONE untrusted capital-change row from a
 * client-submitted save-scenario payload -- unlike `isValidStoredRow`
 * (sessionStorage read-back, same-origin, already-typed-by-this-app
 * content), this crosses a real network boundary, so every decimal field's
 * GRAMMAR (`isValidGrowthInput`) and every integer field's RANGE are
 * checked too, mirroring `isValidCapitalEventDraft`'s own rigor. */
export function isValidCapitalEventInputRow(
  value: unknown,
): value is CapitalEventInput {
  if (!isPlainRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    return false;
  }
  if (
    typeof value.amountDecimal !== "string" ||
    !isValidGrowthInput(value.amountDecimal)
  ) {
    return false;
  }
  if (
    typeof value.month !== "number" ||
    !Number.isInteger(value.month) ||
    value.month < 1 ||
    value.month > 12
  ) {
    return false;
  }
  if (
    typeof value.year !== "number" ||
    !Number.isInteger(value.year) ||
    value.year < 1900 ||
    value.year > 2999
  ) {
    return false;
  }
  if (
    typeof value.yieldPercentDecimal !== "string" ||
    !isValidGrowthInput(value.yieldPercentDecimal)
  ) {
    return false;
  }
  if (
    value.capitalGrowthPercentDecimal !== null &&
    (typeof value.capitalGrowthPercentDecimal !== "string" ||
      !isValidGrowthInput(value.capitalGrowthPercentDecimal))
  ) {
    return false;
  }
  if (
    value.dividendGrowthPercentDecimal !== null &&
    (typeof value.dividendGrowthPercentDecimal !== "string" ||
      !isValidGrowthInput(value.dividendGrowthPercentDecimal))
  ) {
    return false;
  }
  return true;
}

/** DIV-014 (owner ruling): "decide and document how an untouched axis is
 * stored so a loaded scenario still follows the portfolio assumption". A
 * `NULL`-stored axis (the owner never edited it away from its seed before
 * saving) resolves back to the CURRENT `portfolioGrowthPercentDecimal` --
 * i.e. it seeds the input box exactly like a fresh mount does
 * (`IncomeMultiYear`'s own `useState(portfolioValueGrowthPercentDecimal)`
 * seed) and stays `touched: false`, so it keeps live-following the
 * portfolio's own assumption on every future render, never a frozen copy of
 * whatever that assumption happened to be at SAVE time. A non-null stored
 * value is the owner's own frozen edit, restored verbatim with
 * `touched: true` (an already-touched axis never re-seeds from the
 * portfolio, matching `CALCULATIONS.md`:696's "an owner-set value is used
 * exactly as typed, never overridden"). */
export function resolveLoadedScenarioGrowthField(
  storedPercentDecimal: string | null,
  currentPortfolioGrowthPercentDecimal: string,
): { input: string; touched: boolean } {
  return storedPercentDecimal === null
    ? { input: currentPortfolioGrowthPercentDecimal, touched: false }
    : { input: storedPercentDecimal, touched: true };
}

/** DIV-014 owner ruling: the saved-scenario row's "amount invested" is the
 * NET signed sum of every parcel's own signed amount (additions positive,
 * removals negative, per DIV-013's own "Amount (signed; negative removes)"
 * convention) -- a removal genuinely nets AGAINST an addition rather than
 * being reported as a separate gross figure, so this is honestly a NET
 * figure, never a fabricated "total contributed" gross sum. An empty
 * scenario (no parcels) sums to exact "0". */
export function sumCapitalEventAmounts(
  rows: readonly CapitalEventInput[],
): string {
  let total = fromInteger(0n);
  for (const row of rows) {
    total = addDecimal(total, parseDecimal(row.amountDecimal));
  }
  return formatDecimalExact(total);
}

/** DIV-014 owner ruling: "for yield either the single common parcel yield
 * or an honest mixed indicator ... never a fabricated average presented as
 * exact". `"none"` when the scenario has no capital-change parcels at all
 * (there is no parcel yield to report -- a top-level growth axis is a
 * DIFFERENT figure, rendered separately); `"single"` when every parcel
 * shares the identical yield (compared as DECIMAL VALUES via
 * `compareDecimal`, not raw strings, so "2" and "2.00" still count as the
 * same yield); `"average"` otherwise -- the NET-AMOUNT-WEIGHTED average of
 * the parcels' yields (owner ruling 2026-08-24, superseding the DIV-014
 * round-1 "Mixed" label: "Yield in the saved scenarios should be the total
 * average portfolio yield for the scenario, not 'mixed'"). The weighting is
 * over SIGNED amounts (a removal's yield reduces the blend exactly as it
 * reduces the scenario's income), so the figure is the yield of the
 * scenario's NET capital change -- consistent with the row's net "amount
 * invested" cell beside it. A net amount of exactly zero has no meaningful
 * blended yield and falls back to `"indeterminate"` (rendered as an
 * em-dash, never a fabricated figure or a divide-by-zero). */
export type IncomeScenarioYieldSummary =
  | { kind: "none" }
  | { kind: "single"; yieldPercentDecimal: string }
  | { kind: "average"; yieldPercentDecimal: string }
  | { kind: "indeterminate" };

export function deriveIncomeScenarioYieldSummary(
  rows: readonly CapitalEventInput[],
): IncomeScenarioYieldSummary {
  if (rows.length === 0) return { kind: "none" };
  try {
    const first = rows[0]!.yieldPercentDecimal;
    const allMatch = rows.every(
      (row) =>
        compareDecimal(
          parseDecimal(row.yieldPercentDecimal),
          parseDecimal(first),
        ) === 0,
    );
    if (allMatch) return { kind: "single", yieldPercentDecimal: first };
    let weighted = fromInteger(0n);
    let net = fromInteger(0n);
    for (const row of rows) {
      const amount = parseDecimal(row.amountDecimal);
      net = addDecimal(net, amount);
      weighted = addDecimal(
        weighted,
        multiplyDecimal(amount, parseDecimal(row.yieldPercentDecimal)),
      );
    }
    if (compareDecimal(net, fromInteger(0n)) === 0) {
      return { kind: "indeterminate" };
    }
    return {
      kind: "average",
      yieldPercentDecimal: formatDecimalTrimmed(
        divideDecimal(weighted, net),
        2,
      ),
    };
  } catch {
    return { kind: "indeterminate" };
  }
}
