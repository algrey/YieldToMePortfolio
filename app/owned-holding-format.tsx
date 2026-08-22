// UI-023: shared display formatters for owned holding values, extracted
// verbatim from `portfolio-shell.tsx` so the standalone per-holding detail
// screens (`holding-detail.tsx`) render the SAME honest text as the
// holdings list -- unknown money is never zero, unavailable states carry
// their specific reason, and gain/movement figures carry explicit signs.
import type { ReactNode } from "react";
import {
  formatDecimalExact,
  formatDecimalFixed,
  formatDecimalTrimmed,
  groupThousands,
} from "./preview-decimal";
import { isZero, parseDecimalResult } from "../domain/calculations/index.ts";
import type { OwnedHoldingRow } from "./owned-holdings-contract";
import { currencyDisplayPrefix } from "./currency-display.ts";

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

// BRK-012C review round (2026-08-20, B3 fix; HISTORY -- narrowed by
// MKT-016 below): a cross-basis daily-movement comparison (e.g. today's
// price from Sharesight-delayed, yesterday's from the Yahoo-compatible EOD
// feed) was originally treated as genuinely NOT comparable -- deliberately
// left `priceClassComparable`-gated (STRICT) in `app/owned-holdings.ts`
// rather than computed anyway, since a delayed-vs-EOD delta was judged
// potentially misleading. The honesty defect from that round was the
// LABEL: falling through to the generic unavailable branch below falsely
// implied no price data exists at all, when the real, current price IS
// known -- only the MOVEMENT comparison wasn't. `reason ===
// "price_basis_changed"` (set by `app/owned-holdings.ts`'s
// `dailyMovement`/`dailyPercent` fields) renders its own honest, distinct
// text instead.
//
// MKT-016 (owner ruling, 2026-08-22, verbatim: "This is actually fine, the
// historical prices are closing prices. And if they are wrong it is a
// minor and temporary issue."): the EXACT pairing described above --
// Sharesight-delayed today vs. a previous-day `eod` close from ANY
// provider (Yahoo-compatible, `owner-import`, or otherwise) -- is no
// longer refused; `priceClassComparable` now treats a previous-day `eod`
// close as an acceptable baseline for any current price, so that pairing
// computes a real movement instead of landing here. This
// "Movement unavailable (price basis changed)" text still renders for the
// pairings the guard still refuses (see `app/owned-holdings.ts`'s
// `priceClassComparable`/`priceClassBasisComparable` for exactly which
// ones that now is -- e.g. cross-provider `delayed`-vs-`delayed`).
//
// UI-028 (owner ruling, 2026-08-22, one-off product wording change,
// AGENTS.md non-negotiable updated to match): the generic fallback below
// reads "unavailable", not "Price unavailable" -- scoped to THIS function,
// not a blanket app-wide relabel. WLT-001's review (B6) separately adopted
// the SAME "unavailable" wording for the watchlist's NEW strings
// (`app/owned-watchlist.ts`, `app/watchlist-contract.ts`), so this function
// and the watchlist now agree. Other, PRE-EXISTING surfaces still render
// the literal "Price unavailable" string (e.g. `holding-detail.tsx`'s own
// Price row, `app/quote-contract.ts`'s preview-mode quotes) -- aligning
// those is the Orchestrator's tracked follow-up, `UI-029`, not done here.
export function ownedHoldingUnavailableText(reason: string | null | undefined) {
  if (reason === "missing_basis") return "Basis unavailable";
  if (reason === "price_basis_changed")
    return "Movement unavailable (price basis changed)";
  return "unavailable";
}

// UI-026: `value.currencyCode` can legitimately be the active portfolio's
// base currency (home-view figures, gain/movement, basis) OR a security's
// native currency (native-view figures) -- `baseCurrencyCode` is required
// so every call site states which portfolio it is comparing against,
// rather than this shared helper guessing.
export function ownedHoldingAmount(
  baseCurrencyCode: string,
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
    return `${currencyDisplayPrefix(value.currencyCode, baseCurrencyCode)}${formatted}`;
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
// UI-028 review (B4, BLOCKING): a genuinely non-zero value must never
// render as an all-zeros string just because the display `scale` happens
// to round it away (AGENTS.md: missing/derived data is never presented as
// zero -- this is the same guarantee for a KNOWN non-zero value rounded to
// nothing, not a missing one). Wraps `ownedHoldingDecimal` at the ONE call
// site that needed it (the holdings row's average native cost,
// `portfolio-shell.tsx`) -- `ownedHoldingDecimal` itself is unchanged and
// still used elsewhere without this guard (e.g. cash subtotals, which are
// sums unlikely to round to a fake zero and where the existing behaviour
// is intentionally left alone per this task's scope).
export function ownedHoldingDecimalNeverFakeZero(
  value: string | null,
  scale: number,
): string {
  if (value === null) return "—";
  let parsed;
  try {
    parsed = parseDecimalResult(value);
  } catch {
    return ownedHoldingDecimal(value, scale);
  }
  const fixed = ownedHoldingDecimal(value, scale);
  if (isZero(parsed)) return fixed;
  const unsigned = fixed.replace(/^[-−]/, "").replaceAll(",", "");
  if (!/^0(?:\.0+)?$/.test(unsigned)) return fixed;
  // UI-028 review round 2 (fold): the trimmed fallback can ITSELF still
  // collapse to all-zeros for a sufficiently tiny non-zero value (e.g.
  // 0.0000001 rounds away to "0.000000" -> "0" even at
  // `ownedHoldingTrimmed`'s own 6dp default) -- never acceptable for a
  // KNOWN non-zero value (AGENTS.md: missing/derived data is never
  // presented as zero -- the same guarantee applies to a known non-zero
  // value rounded to nothing). Falls through to the FULL exact stored
  // precision (`formatDecimalExact`, no rounding at all) rather than a
  // wider but still-finite trimmed scale, which would only move the same
  // collapse to a smaller-but-still-reachable value.
  const trimmed = ownedHoldingTrimmed(value);
  const unsignedTrimmed = trimmed.replace(/^[-−]/, "").replaceAll(",", "");
  if (!/^0(?:\.0+)?$/.test(unsignedTrimmed)) return trimmed;
  try {
    return groupThousands(formatDecimalExact(parsed));
  } catch {
    return trimmed;
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
