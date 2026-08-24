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
