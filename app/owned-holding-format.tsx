// UI-023: shared display formatters for owned holding values, extracted
// verbatim from `portfolio-shell.tsx` so the standalone per-holding detail
// screens (`holding-detail.tsx`) render the SAME honest text as the
// holdings list -- unknown money is never zero, unavailable states carry
// their specific reason, and gain/movement figures carry explicit signs.
import type { ReactNode } from "react";
import {
  formatDecimalFixed,
  formatDecimalTrimmed,
  groupThousands,
} from "./preview-decimal";
import { parseDecimalResult } from "../domain/calculations/index.ts";
import type { OwnedHoldingRow } from "./owned-holdings-contract";

// Gain/movement figures must carry an explicit +/− sign so the direction
// does not depend on colour alone (UI_SPEC §10, QUAL-001). Negative values
// already come back "-"-prefixed from formatDecimalFixed/Trimmed; this only
// adds the missing "+" for positive, non-zero values.
export function signPrefixed(formatted: string, signed: boolean): string {
  if (!signed) return formatted;
  if (formatted.startsWith("-") || formatted.startsWith("−")) return formatted;
  if (/^0(?:\.0+)?$/.test(formatted)) return formatted;
  return `+${formatted}`;
}

// BRK-012C review round (2026-08-20, B3 fix): a cross-basis daily-movement
// comparison (e.g. today's price from Sharesight-delayed, yesterday's from
// the Yahoo-compatible EOD feed) is genuinely NOT comparable -- deliberately
// left `priceClassComparable`-gated (STRICT) in `app/owned-holdings.ts`
// rather than computed anyway, since a delayed-vs-EOD delta can be
// misleading. The honesty defect was the LABEL: falling through to the
// generic "Price unavailable" branch below falsely implied no price data
// exists at all, when the real, current price IS known -- only the
// MOVEMENT comparison isn't. `reason === "price_basis_changed"` (set by
// `app/owned-holdings.ts`'s `dailyMovement`/`dailyPercent` fields) now
// renders its own honest, distinct text instead.
export function ownedHoldingUnavailableText(reason: string | null | undefined) {
  if (reason === "missing_basis") return "Basis unavailable";
  if (reason === "price_basis_changed")
    return "Movement unavailable (price basis changed)";
  return "Price unavailable";
}

export function ownedHoldingAmount(
  value: {
    status: "available" | "unavailable";
    currencyCode: string;
    value: string | null;
    reason?: string | null;
  },
  scale = 2,
  signed = false,
) {
  if (value.status !== "available" || value.value === null)
    return ownedHoldingUnavailableText(value.reason);
  try {
    const formatted = signPrefixed(
      groupThousands(
        formatDecimalFixed(parseDecimalResult(value.value), scale),
      ),
      signed,
    );
    return `${value.currencyCode} ${formatted}`;
  } catch {
    return ownedHoldingUnavailableText(value.reason);
  }
}
export function ownedHoldingDecimal(value: string | null, scale = 2): string {
  if (value === null) return "—";
  try {
    return groupThousands(formatDecimalFixed(parseDecimalResult(value), scale));
  } catch {
    return "—";
  }
}
export function ownedHoldingTrimmed(value: string | null, scale = 6): string {
  if (value === null) return "—";
  try {
    return groupThousands(
      formatDecimalTrimmed(parseDecimalResult(value), scale, {
        trimTrailingZeros: true,
      }),
    );
  } catch {
    return "—";
  }
}
export function ownedHoldingPercent(
  value: OwnedHoldingRow["dailyPercent"],
  signed = false,
): ReactNode {
  return value.status === "available" && value.value !== null ? (
    (() => {
      try {
        const formatted = signPrefixed(
          formatDecimalTrimmed(parseDecimalResult(value.value), 2, {
            trimTrailingZeros: true,
          }),
          signed,
        );
        return `${formatted}%`;
      } catch {
        return (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">Percentage unavailable</span>
          </>
        );
      }
    })()
  ) : (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">Percentage unavailable</span>
    </>
  );
}
