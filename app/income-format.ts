// UI-006A: shared display-only formatting for the Income screens. Mirrors
// the money/percent formatting conventions already established in
// `app/components/portfolio-shell.tsx` (thousands separators, explicit
// +/- signs, decimal-string-only arithmetic) so the new screens read
// consistently with the rest of the app -- never routes money through
// JavaScript binary floating point (AGENTS.md).
import {
  formatDecimalFixed,
  formatDecimalTrimmed,
  groupThousands,
  parseDecimalResult,
} from "../domain/calculations/index.ts";

/** Adds a "+" prefix for signed, non-zero, non-negative formatted figures; negative figures already carry their own "-" from decimal formatting. */
export function signPrefixed(formatted: string, signed: boolean): string {
  if (!signed) return formatted;
  if (formatted.startsWith("-") || formatted.startsWith("−")) return formatted;
  if (/^0(?:\.0+)?$/.test(formatted)) return formatted;
  return `+${formatted}`;
}

/** "AUD 1,234.56", or an explicit unavailable label -- never a fabricated "0.00" (AGENTS.md: missing dividend/value data is never zero). */
export function formatIncomeMoney(
  currencyCode: string,
  valueDecimal: string | null,
  options: { signed?: boolean; unavailableLabel?: string } = {},
): string {
  if (valueDecimal === null) return options.unavailableLabel ?? "Unavailable";
  try {
    const formatted = signPrefixed(
      groupThousands(formatDecimalFixed(parseDecimalResult(valueDecimal), 2)),
      options.signed ?? false,
    );
    return `${currencyCode} ${formatted}`;
  } catch {
    return options.unavailableLabel ?? "Unavailable";
  }
}

/** "12.34%", or an explicit unavailable label -- percentages carry 2dp trimmed precision. */
export function formatIncomePercent(
  valueDecimal: string | null,
  options: { signed?: boolean; unavailableLabel?: string } = {},
): string {
  if (valueDecimal === null) return options.unavailableLabel ?? "Unavailable";
  try {
    const formatted = signPrefixed(
      formatDecimalTrimmed(parseDecimalResult(valueDecimal), 2, {
        trimTrailingZeros: true,
      }),
      options.signed ?? false,
    );
    return `${formatted}%`;
  } catch {
    return options.unavailableLabel ?? "Unavailable";
  }
}

/** "21 of 23" coverage disclosure -- never a bare count with no denominator. */
export function formatCoverage(included: number, total: number): string {
  return `${included} of ${total}`;
}
