// UI-006B: request-boundary validation shared by the dividend-assumptions
// grid, manual-entry/override, and past-FY-override actions. Mirrors
// `db/repositories/dividends.ts`'s decimal-string pattern (money/quantity/
// percentage values are validated decimal strings, never JS floats -- see
// AGENTS.md's non-negotiable rules), but adds ACTION-LAYER range/label
// decisions the repository intentionally leaves to its caller:
//
// - Franking is a PERCENT (the Australian franked proportion, 0-100 where
//   100 = fully franked -- see docs/CALCULATIONS.md section 11's
//   "Default-tier formula"), so it is bounded to [0, 100] here, tighter
//   than the repository's bare non-negative check.
// - Dividend yield % must be non-negative (a yield cannot be negative) but
//   has no natural upper bound; a generous sanity ceiling catches an
//   obvious unit mistake (e.g. entering "420" meaning "4.20%") without
//   rejecting a real, unusually high yield.
// - Dividend growth % (security and portfolio level) may reasonably be
//   negative (a shrinking payout) but not be nonsensically extreme.
//
// This is a deliberate, documented decision (TASKS.md UI-006B, requirement
// 6): "yields/growth may reasonably be negative for growth, not for
// yield/franking".
const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" && DECIMAL_PATTERN.test(value) && value !== "-0"
  );
}

export function isNonNegativeDecimalString(value: unknown): value is string {
  return isDecimalString(value) && !value.startsWith("-");
}

export function isPositiveDecimalString(value: unknown): value is string {
  return isNonNegativeDecimalString(value) && /[1-9]/.test(value);
}

export type FieldValidation =
  { ok: true; value: string | null } | { ok: false; message: string };

/** `undefined`/`null`/missing -> `null` (blank cell = "use the fallback"); anything else must be a well-formed, in-range decimal string. */
function boundedPercent(
  value: unknown,
  label: string,
  options: { min: number; max: number; unitHint: string },
): FieldValidation {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!isDecimalString(value)) {
    return {
      ok: false,
      message: `${label} must be a plain percentage number (${options.unitHint}).`,
    };
  }
  const numeric = Number(value);
  if (
    !Number.isFinite(numeric) ||
    numeric < options.min ||
    numeric > options.max
  ) {
    return {
      ok: false,
      message: `${label} must be between ${options.min} and ${options.max}.`,
    };
  }
  return { ok: true, value };
}

export function validateOwnerYieldPercent(value: unknown): FieldValidation {
  return boundedPercent(value, "Dividend yield %", {
    min: 0,
    max: 1000,
    unitHint: "e.g. 4.2 for 4.2%, not 0.042",
  });
}

/** 100 = fully franked -- pinned in the message per QA-001B's percentage-unit-ambiguity requirement. */
export function validateFrankingPercent(value: unknown): FieldValidation {
  return boundedPercent(value, "Franking %", {
    min: 0,
    max: 100,
    unitHint: "0-100, where 100 = fully franked",
  });
}

export function validateGrowthPercent(
  value: unknown,
  label = "Dividend growth %",
): FieldValidation {
  return boundedPercent(value, label, {
    min: -100,
    max: 1000,
    unitHint: "may be negative for a shrinking payout",
  });
}

export function validateValueGrowthPercent(value: unknown): FieldValidation {
  return boundedPercent(value, "Portfolio value growth %", {
    min: -100,
    max: 1000,
    unitHint: "may be negative for an expected decline",
  });
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

/** Plain calendar-day difference -- matches `domain/imports/reconciliation.ts`'s identical local helper (DIV-004's proximity check reused there). */
export function daysBetweenDates(a: string, b: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / msPerDay,
  );
}
