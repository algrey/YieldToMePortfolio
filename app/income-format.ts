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
import { currencyDisplayPrefix } from "./currency-display.ts";
import { formatQuantityDisplay } from "./quantity-format.ts";

/** Adds a "+" prefix for signed, non-zero, non-negative formatted figures; negative figures already carry their own "-" from decimal formatting. */
export function signPrefixed(formatted: string, signed: boolean): string {
  if (!signed) return formatted;
  if (formatted.startsWith("-") || formatted.startsWith("−")) return formatted;
  if (/^0(?:\.0+)?$/.test(formatted)) return formatted;
  return `+${formatted}`;
}

/**
 * "$1,234.56" when `currencyCode` is the portfolio's own `baseCurrencyCode`,
 * "US$1,234.56" (etc.) when it is foreign -- UI-026 (owner directive): a
 * bare symbol for the base currency, a flagged/code-bearing form for
 * anything else. Never a fabricated "0.00" (AGENTS.md: missing
 * dividend/value data is never zero).
 */
export function formatIncomeMoney(
  currencyCode: string,
  baseCurrencyCode: string,
  valueDecimal: string | null,
  options: { signed?: boolean; unavailableLabel?: string } = {},
): string {
  if (valueDecimal === null) return options.unavailableLabel ?? "Unavailable";
  try {
    const formatted = signPrefixed(
      groupThousands(formatDecimalFixed(parseDecimalResult(valueDecimal), 2)),
      options.signed ?? false,
    );
    return `${currencyDisplayPrefix(currencyCode, baseCurrencyCode)}${formatted}`;
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

/**
 * CGT-001B: a share/unit quantity, e.g. "1,234.5" -- whole-unless-
 * fractional (UI-027's owner-directed rule), never a fabricated "0" or a
 * rounded-away fractional position. Delegates to
 * `app/quantity-format.ts`'s `formatQuantityDisplay`, the ONE shared
 * quantity-trim implementation every quantity-rendering surface in the app
 * now uses -- see that module's header comment for the full rule and why
 * it is a plain, JSX-free `.ts` module. `null` renders the explicit label.
 */
export function formatQuantity(
  valueDecimal: string | null,
  unavailableLabel = "Unavailable",
): string {
  return formatQuantityDisplay(valueDecimal, unavailableLabel);
}
