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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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
