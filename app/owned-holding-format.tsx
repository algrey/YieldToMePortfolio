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
import { formatQuantityDisplay } from "./quantity-format.ts";
import type { Tone } from "./prototype-data.ts";
import type { SecurityRealisedGainTotal } from "../domain/gains/index.ts";

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
// reads "unavailable", not "Price unavailable" -- scoped to THIS function
// when first introduced, not a blanket app-wide relabel at the time.
// WLT-001's review (B6) separately adopted the SAME "unavailable" wording
// for the watchlist's NEW strings (`app/owned-watchlist.ts`,
// `app/watchlist-contract.ts`). UI-029 (2026-08-23) has since aligned every
// other PRE-EXISTING surface that still rendered the literal
// "Price unavailable" string (e.g. `holding-detail.tsx`'s own Price row,
// `app/quote-contract.ts`'s preview-mode quotes) to the same "unavailable"
// wording, so the app is no longer in a transition state between the two.
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
//
// UI-030 review ruling (2026-08-23, resolving the UI-026 sign-placement
// follow-up for the holdings surfaces in the owner's direction): the
// owner's own literal UI-030 examples ("+$15000", "+$333,000") put the SIGN
// BEFORE the currency symbol, twice. This flips `ownedHoldingAmount`'s
// signed rendering from "$+10.00"/"$-10.00" to "+$10.00"/"-$10.00" -- every
// holdings-surface consumer (daily movement, gain cells, and UI-030's
// Realised line) picks this up together, since they all route through this
// one function. `signPrefixed` itself is untouched (still used as-is by
// `ownedHoldingPercent`, which has no currency prefix to reorder around).
// Deliberately scoped to the holdings surfaces only -- `income-format.ts`'s
// `formatIncomeMoney` and `overview-read-model.ts`'s `formatMoney` keep
// their own existing, independent sign conventions (see
// `currency-display.ts`'s `currencyDisplayPrefix` doc comment for the
// full two-convention history); unifying those is still a recorded,
// out-of-scope follow-up.
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
    // `signPrefixed` decides the sign exactly as before (still "-"-only for
    // a negative amount regardless of `signed`, "+"-prefixed for a
    // positive non-zero amount only when `signed` is true, and no sign at
    // all for an exact/display-rounded-to-zero amount) -- only WHERE that
    // sign character lands relative to the currency prefix changes here.
    const formatted = signPrefixed(
      groupThousands(
        formatDecimalFixed(parseDecimalResult(value.value), scale),
      ),
      signed,
    );
    const hasSign =
      formatted.startsWith("+") ||
      formatted.startsWith("-") ||
      formatted.startsWith("−");
    const signChar = hasSign ? formatted.slice(0, 1) : "";
    const magnitude = hasSign ? formatted.slice(1) : formatted;
    return `${signChar}${currencyDisplayPrefix(value.currencyCode, baseCurrencyCode)}${magnitude}`;
  } catch {
    return ownedHoldingUnavailableText(value.reason);
  }
}
// UI-031B (owner directive, verbatim: "For the summary row all amounts
// should be whole dollars only"): whole-dollar variant of
// `ownedHoldingAmount`, used ONLY by the holdings summary footer
// (`portfolio-shell.tsx`'s `HoldingsSummaryFooterRow`) -- every OTHER
// money surface (per-row lines incl. UI-030's Realised line, holding
// detail, transactions, dividends, etc.) keeps its existing 2dp rendering
// untouched; this is a display-only sibling, not a replacement. Same
// half-even rounding (`formatDecimalFixed`'s `Decimal.ROUND_HALF_EVEN`),
// thousands grouping, and sign-before-symbol convention as
// `ownedHoldingAmount`, but at 0dp. The never-fake-zero guard applies
// here too, at a coarser threshold than `ownedHoldingDecimalNeverFakeZero`
// (which guards a 2dp render): a genuinely non-zero total under $0.50
// rounds to "$0" at 0dp, which would misstate a real non-zero figure as
// nothing, so it falls back to the trimmed EXACT form (2dp/6dp,
// trailing zeros trimmed) for that one value instead, matching the same
// fallback chain `ownedHoldingDecimalNeverFakeZero` already established.
export function ownedHoldingAmountWhole(
  baseCurrencyCode: string,
  value: {
    status: "available" | "unavailable";
    currencyCode: string;
    value: string | null;
    reason?: string | null;
  },
  signed = false,
) {
  if (value.status !== "available" || value.value === null)
    return ownedHoldingUnavailableText(value.reason);
  try {
    const parsed = parseDecimalResult(value.value);
    const whole = groupThousands(formatDecimalFixed(parsed, 0));
    const rawFormatted = isFakeZeroAmount(whole, parsed)
      ? neverFakeZeroWholeFallback(value.value, parsed)
      : whole;
    const formatted = signPrefixed(rawFormatted, signed);
    const hasSign =
      formatted.startsWith("+") ||
      formatted.startsWith("-") ||
      formatted.startsWith("−");
    const signChar = hasSign ? formatted.slice(0, 1) : "";
    const magnitude = hasSign ? formatted.slice(1) : formatted;
    return `${signChar}${currencyDisplayPrefix(value.currencyCode, baseCurrencyCode)}${magnitude}`;
  } catch {
    return ownedHoldingUnavailableText(value.reason);
  }
}
function isFakeZeroAmount(
  formatted: string,
  parsed: ReturnType<typeof parseDecimalResult>,
): boolean {
  if (isZero(parsed)) return false;
  const unsigned = formatted.replace(/^[-−]/, "").replaceAll(",", "");
  return /^0(?:\.0+)?$/.test(unsigned);
}
function neverFakeZeroWholeFallback(
  value: string,
  parsed: ReturnType<typeof parseDecimalResult>,
): string {
  const trimmed = ownedHoldingTrimmed(value);
  if (!isFakeZeroAmount(trimmed, parsed)) return trimmed;
  return groupThousands(formatDecimalExact(parsed));
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
// UI-027: the ONE shared share/unit quantity formatter (whole-unless-
// fractional, never a fake zero) -- see `app/quantity-format.ts`'s header
// comment for the full rule and why the trim implementation lives there
// (a plain, JSX-free `.ts` module) rather than only here. This is a thin
// re-export under the `ownedHoldingXxx` naming convention every other
// holding-value formatter in this file already uses, for the `.tsx` call
// sites that import alongside `ownedHoldingTrimmed`/`ownedHoldingDecimal`
// (`portfolio-shell.tsx`'s holdings row -- where this rule was originally
// delivered inline during the UI-028 review -- `holding-detail.tsx`,
// `holding-transactions.tsx`, `portfolio-details.tsx`). `.ts` call sites
// that cannot import a `.tsx` file (`income-format.ts`'s `formatQuantity`,
// `dividend-history-prefill.ts`'s `formatShares`) import
// `formatQuantityDisplay` directly instead.
export function ownedHoldingQuantity(value: string | null): string {
  return formatQuantityDisplay(value, "—");
}

// UI-036 (owner directive, verbatim, 2026-08-23): a fully sold holding
// (current quantity exactly zero) omits the row-tertiary "avg cost x
// quantity" line entirely rather than rendering "Basis unavailable x 0" --
// a sold-out position's per-share cost is not a current fact worth a line,
// and the row-quaternary "Realised:" line (UI-030) already carries the
// story. Uses the same exact-decimal zero convention as the rest of the
// owned-holdings zero-quantity handling (`app/owned-holdings.ts`'s
// `isZero(parseDecimalResult(quantity))`), never string equality with
// "0" -- `holding.quantity` always arrives as a validated decimal string
// (see `resultDecimal` in `owned-holdings.ts`), but an unparsable value
// fails closed to "not zero" so the line stays rather than silently
// vanishing.
export function ownedHoldingQuantityIsZero(value: string): boolean {
  try {
    return isZero(parseDecimalResult(value));
  } catch {
    return false;
  }
}

// UI-040 (owner directive, verbatim, 2026-08-25): "Let add a 'Hide Sold'
// button for the holdings ... I think partially sold holdings should stay
// as they are." Reuses `ownedHoldingQuantityIsZero` VERBATIM -- the exact
// same UI-036 exact-decimal-zero convention decides which rows are "sold"
// for both features, so a row that keeps its row-tertiary line (partially
// sold, quantity > 0) is guaranteed to also survive this filter. Pure and
// generic over any row shape carrying a `quantity` string so it can be unit
// tested directly against plain fixtures, independent of `OwnedHoldingRow`'s
// full shape.
export function ownedHoldingVisibleWhenHideSold<T extends { quantity: string }>(
  rows: readonly T[],
  hideSold: boolean,
): readonly T[] {
  return hideSold
    ? rows.filter((row) => !ownedHoldingQuantityIsZero(row.quantity))
    : rows;
}

// Counts the fully-sold rows a `true` `hideSold` value would remove --
// independent of the CURRENT toggle state, so the count stays accurate for
// the sr-only disclosure regardless of whether the toggle is on or off.
export function ownedHoldingHiddenSoldCount<T extends { quantity: string }>(
  rows: readonly T[],
): number {
  return rows.filter((row) => ownedHoldingQuantityIsZero(row.quantity)).length;
}

// UI-040 review (B1, BLOCKING, owner's one explicit layout requirement: "I
// would like the dollar signs to line up"): `ownedHoldingAmountWhole`'s
// SHARED sign-before-symbol convention ("+$333,000" / "-$1,204" / "$0", no
// sign for a genuine zero) is untouched by this task -- per the review
// ruling, the shared formatter is never modified. Instead this LOCAL,
// footer-only helper splits the formatter's own output back into its
// leading sign (if any) and the rest of the string, so the caller can
// render the sign inside a fixed one-character-wide slot: "+", "-"/"−", and
// "" (no sign, e.g. a genuine "$0") all occupy the SAME slot width, so the
// "$" that immediately follows always lands at the same x offset on both
// the All Time and Realised lines regardless of which of the three sign
// states either line is in. Before this fix, the sign was rendered inline
// with the rest of the text, so its own (variable, or ABSENT) width shifted
// every subsequent character -- the exact defect the review measured (a
// mixed +/− pair 2.6px off, an unsigned "$0" Realised line 9.35px off).
export function ownedHoldingSplitLeadingSign(text: string): {
  sign: string;
  rest: string;
} {
  if (text.startsWith("+") || text.startsWith("-") || text.startsWith("−")) {
    return { sign: text.slice(0, 1), rest: text.slice(1) };
  }
  return { sign: "", rest: text };
}

// UI-040 Orchestrator ruling (owner follow-up, verbatim: "No explanatory
// text on the screen please ... Preserving information density on the
// holding screen is very important"): this text is NEVER rendered visibly --
// it feeds ONLY an sr-only live region (no `title`/hover disclosure --
// review B3: a hover tooltip is still visible text, forbidden by the same
// ruling) so the totals-vs-visible-rows relationship stays honestly
// reachable to assistive tech without adding a single visible word to the
// row list. `null` when there is nothing to disclose (nothing hidden).
export function ownedHoldingHiddenSoldDisclosureText(
  count: number,
): string | null {
  if (count <= 0) return null;
  return `${count} sold holding${count === 1 ? "" : "s"} hidden`;
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

// UI-031: exported so the holdings summary row (`portfolio-shell.tsx`) can
// derive line tone from a plain decimal string the same way UI-030's
// "Realised:" line already does, immediately below -- one tone rule for
// every signed holdings-surface figure, not a second implementation.
export function ownedHoldingToneFromDecimal(value: string): Tone {
  return /^0(?:\.0*)?$/.test(value)
    ? "neutral"
    : value.startsWith("-")
      ? "negative"
      : "positive";
}

// UI-030 (owner directive, verbatim: "In holdings, for any ticker row that
// has sold shares, there should be a forth line. On the left column on the
// fourth line it should say 'Realised:' and then have the realised capital
// followed by the gain expressed as a percent of the basis at the time of
// the gain. Example: 'Realised: +$15000 (+13.91%)'."). Renders the
// holdings row's fourth line from CGT-001A's per-security LIFETIME
// realised-gain rollup (`domain/gains/security-totals.ts`'s
// `computeSecurityRealisedGainTotals`, composed once per portfolio load by
// `app/owned-capital-gains.ts`'s `loadOwnedRealisedGainTotals` -- one
// batched query for the whole portfolio, never a per-row query).
//
// `total` is `undefined` for a security that was never sold (no fourth
// line -- `null` is returned) OR when the realised-gains enrichment itself
// failed to load for this request (`app/authenticated-workspace.ts` treats
// that load as best-effort, mirroring `app/owned-holdings.ts`'s Sharesight
// price-freshness gate, so a rare CGT-side failure never blocks the
// primary holdings figures). Either way, omitting the line is honest: it
// never claims "never sold" when the truth is merely "unknown right now."
//
// Every realised-gain amount is already in the portfolio's BASE currency
// (see `disposal-rows.ts`'s header), so `homeCurrencyCode` is always used
// as BOTH the value's own currency and the comparison base -- the amount
// always renders as the bare, unflagged base symbol (UI-026), never a
// foreign-flagged one.
export function ownedHoldingRealisedGainLine(
  homeCurrencyCode: string,
  total: SecurityRealisedGainTotal | undefined,
): { tone: Tone; content: ReactNode } | null {
  if (!total || total.disposalCount === 0) return null;

  if (total.knownDisposalCount === 0) {
    // Every disposal for this security has an incomplete cost basis -- the
    // known-gain sum would be a fabricated "$0" (AGENTS.md: missing cost
    // basis is never presented as zero), so the whole figure honestly
    // reads "unavailable" rather than a misleading amount.
    return {
      tone: "neutral",
      content: (
        <>
          Realised: unavailable{" "}
          <span className="sr-only">
            — cost basis is incomplete for every lot match of this security.
          </span>
        </>
      ),
    };
  }

  const tone = ownedHoldingToneFromDecimal(total.gainDecimal);
  const amountText = ownedHoldingAmount(
    homeCurrencyCode,
    {
      status: "available",
      currencyCode: homeCurrencyCode,
      value: total.gainDecimal,
      reason: null,
    },
    2,
    true,
  );

  if (total.partialCoverage) {
    // Mirrors `capital-gains-screen.tsx`'s own partial-coverage disclosure
    // convention: show the KNOWN partial sum plus an explicit qualifier
    // rather than hiding it, but never a percent beside it -- the
    // denominator itself excludes the same unknown disposals (UI-030
    // ruling: never a fabricated/partial percent presented as complete).
    // Built as ONE plain string (rather than several JSX text/expression
    // children) so the rendered whitespace is exact and unambiguous.
    // CGT-001A's standing ruling (`capital-gains-screen.tsx`'s own
    // completion-note comment): `disposalCount` counts ALLOCATIONS (lot
    // matches), not distinct sale transactions -- never labelled
    // "disposals" unqualified anywhere in the app.
    const lotMatchWord =
      total.disposalCount === 1 ? "lot match" : "lot matches";
    const qualifier = `partial — ${total.excludedIncompleteCount} of ${total.disposalCount} ${lotMatchWord} excluded, cost basis incomplete`;
    return {
      tone,
      content: `Realised: ${amountText} (${qualifier})`,
    };
  }

  const percentText =
    total.percentDecimal === null
      ? "percent unavailable" // zero-basis edge (e.g. free shares) -- never a divide-by-zero
      : `${signPrefixed(total.percentDecimal, true)}%`;

  return {
    tone,
    content: `Realised: ${amountText} (${percentText})`,
  };
}
