// UI-006A: pure year-range clamping for the Income multi-year route's
// `?yearsBack=`/`?yearsForward=` query parameters. Split out of
// `app/portfolio/[portfolioId]/income/multi-year/page.tsx` (a JSX module) so
// it can be imported and behaviourally tested directly under the plain
// `node --experimental-strip-types` test runner, without a `tsx`-loader
// subprocess or pulling in that page's server-only imports.
export const DEFAULT_YEARS_BACK = 2;
export const DEFAULT_YEARS_FORWARD = 4;
export const MAX_YEARS = 10;

/**
 * Clamps an untrusted query-string year count to [minimum, MAX_YEARS],
 * falling back to `fallback` for anything unparseable -- the range
 * control's own <select> never offers a value outside its bounds, but a
 * hand-edited URL must still degrade to a safe default rather than reach
 * the service with an out-of-range value.
 */
export function clampYears(
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, MAX_YEARS));
}
