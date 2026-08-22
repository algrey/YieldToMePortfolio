// UI-026 (owner directive, verbatim): "If the currency is set to AUD it
// should not show 'AUD' it should show $number (eg: $4.21). If amounts are
// USD, then it should show the USD symbol. Visa versa if the portfolio is
// set to USD it should only show the currency for AUD." Orchestrator
// ruling: formatting is relative to the ACTIVE PORTFOLIO's base currency
// (per-portfolio, not per-user). An amount IN the base currency renders as
// a bare symbol ($4.21, £4.21, €4.21, ¥421); an amount in any OTHER
// currency renders flagged so it can never be mistaken for a base-currency
// figure -- dollar-family currencies get the standard AU-style
// country-flagged prefix (US$4.21, A$4.21, NZ$4.21, C$4.21, S$4.21,
// HK$4.21) because "$" alone is shared across many currencies; £/€/¥ are
// already unambiguous on their own, so a foreign GBP/EUR/JPY amount stays
// visually distinct from a base amount by virtue of being a different
// symbol, without needing a country flag. A currency with no well-known
// symbol keeps the pre-existing "CODE 4.21" form in EITHER direction (base
// or foreign) -- never stripping the ISO code from an amount whose only
// identity is that code.
//
// This is the ONE module that owns the currency -> symbol map and the
// base/foreign rule. Every money formatter in the app should derive its
// currency prefix from `currencyDisplayPrefix` (or the convenience
// wrappers below) rather than re-deriving its own "CODE " prefix, so the
// rule never drifts between screens.
//
// Display-only: this module never touches stored values, CSV/backup
// exports, or import-preview persisted data -- only how an already-decimal
// amount is glued to its currency marker for on-screen text.
//
// Surfaces with NO portfolio in scope (e.g. a user's watchlist before any
// portfolio exists) have no base currency to compare against. Those call
// sites pass "AUD" as an explicit, documented fallback base -- never a
// silent guess -- per the Orchestrator ruling (see call sites and
// docs/ARCHITECTURE.md's Home-currency presentation section).
export const WATCHLIST_NO_PORTFOLIO_BASE_CURRENCY = "AUD";

/**
 * Dollar-family currencies: "$" alone is ambiguous across all of these, so
 * a FOREIGN amount in one of these currencies gets the standard AU-style
 * country-flagged prefix. When one of these IS the base currency, it
 * renders as a bare "$" (no flag) since a bare "$" always means "my own
 * portfolio's currency" -- the same convention every plain brokerage
 * statement uses.
 */
const DOLLAR_FAMILY_SYMBOLS: Readonly<Record<string, string>> = {
  AUD: "A$",
  USD: "US$",
  NZD: "NZ$",
  CAD: "C$",
  SGD: "S$",
  HKD: "HK$",
};

/**
 * Non-dollar currencies with a well-known symbol that is already
 * unambiguous on its own -- rendered the same way whether the amount is
 * base or foreign, since the symbol itself already disambiguates it from
 * every other currency in this table (and from the dollar family).
 */
const PLAIN_SYMBOLS: Readonly<Record<string, string>> = {
  GBP: "£",
  EUR: "€",
  JPY: "¥",
};

/** True when `currencyCode` renders as the bare, unflagged base symbol for this `baseCurrencyCode` (case-insensitive ISO comparison). */
export function isBaseCurrencyDisplay(
  currencyCode: string,
  baseCurrencyCode: string,
): boolean {
  return (
    currencyCode.trim().toUpperCase() === baseCurrencyCode.trim().toUpperCase()
  );
}

/**
 * The prefix to glue directly before a formatted amount string (e.g.
 * `"$" + "4.21"`, `"US$" + "4.21"`, `"CODE " + "4.21"` -- note the fallback
 * form keeps its own trailing space, matching the pre-existing "CODE 4.21"
 * rendering byte-for-byte for unknown codes).
 *
 * Sign placement: this codebase still has TWO different sign conventions
 * for a signed amount, though UI-030's review (2026-08-23) narrowed it to
 * one holdout:
 *   - `app/income-format.ts`'s `formatIncomeMoney` alone still embeds the
 *     sign INSIDE the formatted amount (via `signPrefixed`) and glues this
 *     prefix directly in front of THAT, so the sign lands AFTER the
 *     prefix: `"$" + "+10.00"` -> `"$+10.00"`, `"$" + "-10.00"` ->
 *     `"$-10.00"`. Recorded follow-up, not done here (out of scope for
 *     both UI-026 and UI-030): unifying this one holdout with the
 *     sign-before-prefix convention below.
 *   - `app/overview-read-model.ts`'s `formatMoney`,
 *     `app/overview-fy-range.ts`'s `windowChangeAmount`, AND (as of the
 *     UI-030 review ruling, 2026-08-23 -- the owner's own UI-030 examples,
 *     "+$15000"/"+$333,000", put the sign before the symbol) `app/owned-
 *     holding-format.tsx`'s `ownedHoldingAmount` all put the sign BEFORE
 *     this prefix: `"+" + "$" + "10.00"` -> `"+$10.00"`, `"−"/"-" + "$" +
 *     "10.00"` -> `"−$10.00"`/`"-$10.00"`. `ownedHoldingAmount` still
 *     computes ITS sign character via `signPrefixed` internally (same
 *     rules as before) and then relocates it in front of this prefix,
 *     rather than computing the sign separately the way the overview
 *     helpers do -- same visible convention, different internal path.
 */
export function currencyDisplayPrefix(
  currencyCode: string,
  baseCurrencyCode: string,
): string {
  const code = currencyCode.trim().toUpperCase();
  const isBase = isBaseCurrencyDisplay(code, baseCurrencyCode);
  const dollarSymbol = DOLLAR_FAMILY_SYMBOLS[code];
  if (dollarSymbol !== undefined) {
    return isBase ? "$" : dollarSymbol;
  }
  const plainSymbol = PLAIN_SYMBOLS[code];
  if (plainSymbol !== undefined) {
    return plainSymbol;
  }
  // Unknown/no-symbol code: unchanged "CODE " fallback, base or foreign.
  return `${code} `;
}
