// UI-006C: pure helpers for the per-security Dividends tab
// (`app/components/security-dividends-tab.tsx`). Split out of that "use
// client" `.tsx` file into a plain `.ts` module for two reasons: it keeps
// this codebase's small-pure-function convention (AGENTS.md), and it lets
// `tests/ui-006c.test.ts` import `buildDialogPrefill` directly -- `node
// --experimental-strip-types` (this repo's test runtime) can type-strip a
// `.ts` file but cannot parse JSX in a `.tsx` file for a plain top-level
// `import`, only via the `tsx`-loader `execFileSync` render trick this
// suite's other rendered-HTML assertions already use.
import {
  compareDecimal,
  formatDecimalTrimmed,
  parseDecimalResult,
} from "../domain/calculations/decimal.ts";
import type {
  DerivedDividendRow,
  FrankingResolution,
} from "../domain/dividends/index.ts";
import { formatIncomeMoney } from "./income-format.ts";
import { formatQuantityDisplay } from "./quantity-format.ts";

/** Mirrors `app/owned-security-dividends.ts`'s shapes, defined locally so
 * this client-reachable module never depends on that server-only loader
 * module, even by type -- the same convention
 * `dividend-assumptions-editor.tsx`'s `SavedAssumptionsRow` documents. */
export type OverrideFact = {
  id: string;
  version: number;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  exclude: boolean;
  /** The override's OWN persisted `dividend_event_id` (see
   * `app/owned-security-dividends.ts`'s field doc) -- a save MUST target
   * this, never the row's current active event id, or the repository's
   * UPDATE matches zero rows. */
  storedDividendEventId: string;
};
export type ManualFact = { version: number; importBatchId: string | null };

export const SOURCE_LABEL: Record<DerivedDividendRow["source"], string> = {
  auto: "auto",
  edited: "edited",
  receipt: "receipt",
  manual: "manual",
  imported: "imported",
};

// UI-027: delegates to `app/quantity-format.ts`'s `formatQuantityDisplay`,
// the ONE shared quantity-trim implementation every quantity-rendering
// surface in the app now uses (whole-unless-fractional, never a fake
// zero) -- see that module's header comment for the full rule. Falls back
// to the raw string on a malformed value, mirroring the previous
// behaviour (never expected from a validated, DB-sourced decimal).
export function formatShares(value: string): string {
  return formatQuantityDisplay(value, value);
}

/**
 * Review follow-up 1: two decimal STRINGS can represent the identical VALUE
 * with different textual scale ("1.5" vs "1.50" -- both perfectly normal,
 * e.g. a provider figure stored at one scale vs an owner-typed override at
 * another). A raw `!==` string comparison would render a spurious "provider
 * differs" annotation for a pair that is not actually different. Parses and
 * compares numerically via `compareDecimal`; a malformed string (never
 * expected from validated, DB-sourced decimals) falls back to the raw
 * string comparison rather than throwing during render.
 */
export function decimalsEqual(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return (
      compareDecimal(parseDecimalResult(left), parseDecimalResult(right)) === 0
    );
  } catch {
    return false;
  }
}

export function frankingCell(
  franking: FrankingResolution,
  currencyCode: string,
  baseCurrencyCode: string,
): string {
  if (franking.source === "unknown") return "Unknown";
  return `${formatIncomeMoney(currencyCode, baseCurrencyCode, franking.perShareDecimal)} (${franking.source})`;
}

/**
 * DIV-007: a BRK-005 totals-mode row (`dividendPerShareDecimal === null`,
 * only ever an imported Sharesight payout -- see `DerivedDividendRow`'s
 * header note) carries no per-share franking fact at all, so `row.franking`
 * (a PER-SHARE resolution) is `{ source: "unknown" }` unless a franking-only
 * override/receipt/manual fact was recorded directly against it -- reading
 * it via `frankingCell` above would otherwise render "Unknown" even when
 * `frankingTotalDecimal` holds a real reported (or DIV-007-derived) TOTAL
 * figure. This wraps `frankingCell` to read the row's TOTAL in that case
 * instead (mirroring `owned-dividend-list.tsx`'s equivalent display).
 *
 * Review round 1 fixes:
 * - **F1**: the totals-vs-per-share branch is NOT simply
 *   `dividendPerShareDecimal === null` -- a franking-only override/receipt/
 *   manual fact can exist on a row whose OWN `dividendPerShareDecimal` is
 *   null (e.g. an "edited" row where the dividend-per-share amount itself
 *   is unknown but the owner separately entered a franking-per-share
 *   credit); `row.franking.source !== "unknown"` in that case, and the
 *   per-share path must still win (`frankingCell` renders the owner's real
 *   "AUD 0.42 (override)" figure) rather than regressing to this totals
 *   branch's "Unavailable"/derived-zero handling.
 * - **B1**: a TOTAL must be labelled distinctly from a PER-SHARE figure in
 *   the same "Franking/share" column header (security-dividends-tab.tsx) --
 *   otherwise a real franked AUD payout's dollar total silently reads as if
 *   it were a per-share credit, misstating the unit basis on a real tax
 *   figure. Appends " total", mirroring `dividend-assumptions-editor.tsx`'s
 *   existing totals-mode-dominated-imported-fact precedent
 *   (`${formatIncomeMoney(...)} total`), then the "none reported"
 *   provenance note for a DIV-007-derived $0 (an inference from
 *   Sharesight's absent field, never a Sharesight-supplied explicit zero --
 *   see `DerivedDividendRow.frankingDerivedZero`'s doc comment).
 * - **B2**: a genuinely unknown TOTAL renders the identical "Unknown" text
 *   the per-share path uses for the same meaning (no usable franking figure
 *   at all) -- `docs/CALCULATIONS.md`'s BRK-010 paragraph documents this
 *   reading "Unknown", so the two paths must never silently diverge on
 *   wording for one concept.
 */
export function frankingDisplay(
  row: DerivedDividendRow,
  baseCurrencyCode: string,
): string {
  if (
    row.dividendPerShareDecimal !== null ||
    row.franking.source !== "unknown"
  ) {
    return frankingCell(row.franking, row.currencyCode, baseCurrencyCode);
  }
  if (row.frankingTotalDecimal === null) return "Unknown";
  const amount = `${formatIncomeMoney(row.currencyCode, baseCurrencyCode, row.frankingTotalDecimal)} total`;
  if (row.frankingDerivedZero) return `${amount} (none reported)`;
  // BRK-011: an owner-entered franking-currency override (tier 3 of the
  // owner's BINDING cascade -- see docs/CALCULATIONS.md section 11) is
  // labelled distinctly from a Sharesight-reported figure, mirroring
  // `frankingDerivedZero`'s "none reported" precedent -- the owner must
  // always be able to tell their own entered figure apart from a provider
  // fact.
  if (row.frankingCurrencySource === "owner_manual") {
    return `${amount} (owner-entered)`;
  }
  return amount;
}

/**
 * BRK-011: the underlying `dividend_manual_records` id for a row eligible
 * to receive a franking-currency override -- non-null ONLY for a
 * STANDALONE imported row (`source === "imported" && dividendEventId ===
 * null`, the `imported:<id>` row-id shape `buildDialogPrefill`'s second
 * branch already parses identically), never for an imported fact that
 * proximity-matched a provider event (that row's `id` is the EVENT id, not
 * the manual record id -- out of this feature's scope for now, matching the
 * existing `importedReadOnly` boundary the per-share edit dialog already
 * draws at exactly this same line).
 */
export function frankingOverrideManualRecordId(
  row: DerivedDividendRow,
): string | null {
  if (row.source !== "imported" || row.dividendEventId !== null) return null;
  const separatorIndex = row.id.indexOf(":");
  if (separatorIndex < 0 || row.id.slice(0, separatorIndex) !== "imported") {
    return null;
  }
  return row.id.slice(separatorIndex + 1);
}

/**
 * BRK-011: whether the Dividends tab should offer the franking-override
 * entry point for this row -- only ever a standalone imported row (see
 * `frankingOverrideManualRecordId`) whose franking is either genuinely
 * UNKNOWN (BRK-010's unverified-nonzero-foreign guard, or a cash-conversion
 * failure -- both only ever reachable on a foreign-currency imported fact,
 * since a native fact's absent franking is always resolved to a known $0 by
 * DIV-007 regardless of currency) or ALREADY carries an owner override
 * (offered again so the owner can revise a previous entry).
 *
 * Review finding F1 (silent no-effect override): `row.amountUnknown` -- the
 * row's CASH conversion itself failed closed (a missing/malformed BRK-010
 * rate) -- is excluded here even though its `frankingTotalDecimal` also
 * reads `null`. `domain/dividends/history.ts`'s `resolveImportedRecordCurrency`
 * unconditionally nulls `totalFrankingDecimal` on that fail-closed path,
 * REGARDLESS of an owner override having just set it (`applyFrankingCurrencyOverride`
 * runs first, but its result is discarded the moment cash conversion itself
 * fails) -- so offering entry on such a row would let the owner save
 * repeatedly with no visible effect, ever. This mirrors DIV-007's own
 * established principle (`deriveAbsentImportedFranking`'s doc comment):
 * never surface a lone franking figure beside an unavailable cash amount.
 * An owner who already has a stored override on such a row (rare -- see
 * that function's doc comment) sees it silently stop being offered too,
 * rather than a misleading "no effect" entry point; deleting/clearing a
 * stranded override is an explicit, documented backlog item, not solved
 * here.
 */
export function shouldOfferFrankingOverride(row: DerivedDividendRow): boolean {
  if (frankingOverrideManualRecordId(row) === null) return false;
  if (row.amountUnknown) return false;
  return (
    row.frankingTotalDecimal === null ||
    row.frankingCurrencySource === "owner_manual"
  );
}

/**
 * UI-014 part 4 (BRK-010 provenance rendering): a compact display form of a
 * stored FX rate for the "converted from" disclosure below -- the stored
 * rate itself (`DerivedDividendRow.fxRateToPortfolioDecimal`) is kept at a
 * 24dp intermediate scale (see `domain/dividends/history.ts`'s
 * `FX_CONVERSION_SCALE`), too long to show inline. This ONLY trims the
 * DISPLAY string (half-even at 6dp, trailing zeros dropped) -- it never
 * reads back into any calculation, mirroring `formatShares`'s identical
 * display-only convention above. Malformed input (never expected from a
 * validated, DB-sourced decimal) falls back to the raw string rather than
 * throwing during render.
 */
export function formatFxRate(rateDecimal: string): string {
  try {
    return formatDecimalTrimmed(parseDecimalResult(rateDecimal), 6, {
      trimTrailingZeros: true,
    });
  } catch {
    return rateDecimal;
  }
}

/**
 * UI-010: a row's total count of receipts folded into it and not shown as
 * their own row -- `dominatedReceipt` (the one whose values ARE shown,
 * consumed by a higher-precedence winner) plus `additionalReceiptsCount`
 * (further receipts beyond that one, never individually shown regardless of
 * which tier won -- see `domain/dividends/history.ts`'s `resolveReceipts`).
 * Zero for a row with no folded-in receipt evidence at all.
 */
export function foldedInReceiptCount(row: DerivedDividendRow): number {
  return (row.dominatedReceipt !== null ? 1 : 0) + row.additionalReceiptsCount;
}

/** Mirrors `foldedInReceiptCount` for imported rows folded into this row via
 * `dominatedImported`/`additionalImportedCount` (DIV-004/DIV-005). */
export function foldedInImportedCount(row: DerivedDividendRow): number {
  return (row.dominatedImported !== null ? 1 : 0) + row.additionalImportedCount;
}

export type DialogPrefill = {
  initialPortfolioSecurityId: string;
  initialPaymentDate: string | null;
  initialDividendEventId: string | null;
  initialManualRecordId: string | null;
  initialSharesDecimal: string | null;
  initialDividendPerShareDecimal: string | null;
  initialFrankingCreditPerShareDecimal: string | null;
  /** DIV-016 part A: "totals" only for a standalone (non-event-linked)
   * manual/imported row whose own per-share amount is null -- a BRK-005
   * totals-mode fact, now reachable for an owner-typed row too, not only an
   * imported Sharesight payout. Always "per_share" for an event-linked row
   * (`dividend_event_overrides` has no totals shape) and for a fresh entry. */
  initialAmountMode: "per_share" | "totals";
  initialTotalCashDecimal: string | null;
  initialTotalFrankingDecimal: string | null;
  initialExpectedVersion: number | null;
  initialExclude: boolean;
};

/**
 * Every history row is clickable (TASKS.md UI-006C's acceptance) and opens
 * the SAME per-share dialog UI-006B already built, pre-filled for
 * edit/override. Two cases:
 *
 * - `dividendEventId !== null` (event-linked -- auto/edited rows, and any
 *   manual/receipt/imported row that matched a provider event, including a
 *   resurfaced excluded-event row): look up the RAW persisted override
 *   already resolved through the supersession lineage (see
 *   `app/owned-security-dividends.ts`'s B1 fix) so an ALREADY-overridden row
 *   sends its correct `expectedVersion` (an UPDATE), falling back to the
 *   row's own resolved values when no override exists yet (a plain auto row
 *   -- `expectedVersion: null` correctly CREATES a new override on save).
 *   `initialDividendEventId` is the override's OWN `storedDividendEventId`
 *   when one exists -- NEVER the row's current active id -- because
 *   `dividend_event_overrides` stays keyed to whichever event was active
 *   WHEN THE OVERRIDE WAS CREATED and the repository's UPDATE targets a row
 *   by that exact stored key (B1 review round 2: sending the row's current
 *   active id here matches zero rows post-supersession and 404s, even
 *   though `expectedVersion` was correctly resolved). With no existing
 *   override, the row's current active id is exactly right -- a brand-new
 *   override should key to whatever event is active NOW. `initialPaymentDate`
 *   is ALWAYS supplied here even though an event-linked save never persists
 *   it (UI-006B's F2 note) -- the dialog's date input is disabled but still
 *   a CONTROLLED value sent in the save request, and an empty one fails the
 *   server's `isValidDateString` check (400). Falls back through
 *   `paymentDate` -> `exDate` -> `today` so this is never null.
 * - `dividendEventId === null` (a standalone `manual:<id>`/`imported:<id>`
 *   row -- or a rare orphan `receipt:<id>` row, see
 *   `domain/dividends/history.ts`'s own "no current provider ever writes
 *   cancelled" disclosure; this codebase has no owner-facing receipt-edit
 *   path today, so a receipt row opens a FRESH, non-event-linked entry
 *   prefilled from its values rather than an edit): look up the manual
 *   record's version by the id encoded in `row.id`.
 */
export function buildDialogPrefill(
  row: DerivedDividendRow,
  portfolioSecurityId: string,
  overridesByEventId: Record<string, OverrideFact>,
  manualRecordsById: Record<string, ManualFact>,
  today: string,
): DialogPrefill {
  const rawFranking =
    row.franking.source === "override" ? row.franking.perShareDecimal : null;
  if (row.dividendEventId !== null) {
    const override = overridesByEventId[row.dividendEventId] ?? null;
    return {
      initialPortfolioSecurityId: portfolioSecurityId,
      initialPaymentDate: row.paymentDate ?? row.exDate ?? today,
      initialDividendEventId:
        override?.storedDividendEventId ?? row.dividendEventId,
      initialManualRecordId: null,
      initialSharesDecimal: override?.sharesDecimal ?? row.sharesDecimal,
      initialDividendPerShareDecimal:
        override?.dividendPerShareDecimal ?? row.dividendPerShareDecimal,
      initialFrankingCreditPerShareDecimal:
        override?.frankingCreditPerShareDecimal ?? rawFranking,
      initialAmountMode: "per_share",
      initialTotalCashDecimal: null,
      initialTotalFrankingDecimal: null,
      initialExpectedVersion: override?.version ?? null,
      initialExclude: override?.exclude ?? row.excluded,
    };
  }
  const separatorIndex = row.id.indexOf(":");
  const prefix = separatorIndex >= 0 ? row.id.slice(0, separatorIndex) : "";
  const rawId = separatorIndex >= 0 ? row.id.slice(separatorIndex + 1) : "";
  const recordId = prefix === "manual" || prefix === "imported" ? rawId : null;
  const record = recordId ? (manualRecordsById[recordId] ?? null) : null;
  // DIV-016 part A: `row.dividendPerShareDecimal === null` is this
  // codebase's established totals-mode detection (matches
  // `shouldOfferFrankingOverride`/`frankingDisplay`'s identical check) --
  // for a totals-mode row, `row.cashDecimal`/`row.frankingTotalDecimal` ARE
  // the raw total figures verbatim (see `computeCashGrossOrTotals`'s
  // totals-mode branch in `domain/dividends/history.ts`: no per-share
  // derivation ever runs for this shape, and an owner-typed row is never
  // FX-converted the way an imported one can be), so they can be read
  // straight into the totals prefill.
  const isTotalsMode = row.dividendPerShareDecimal === null;
  return {
    initialPortfolioSecurityId: portfolioSecurityId,
    initialPaymentDate: row.paymentDate ?? today,
    initialDividendEventId: null,
    initialManualRecordId: recordId,
    initialSharesDecimal: row.sharesDecimal,
    initialDividendPerShareDecimal: row.dividendPerShareDecimal,
    initialFrankingCreditPerShareDecimal: rawFranking,
    initialAmountMode: isTotalsMode ? "totals" : "per_share",
    initialTotalCashDecimal: isTotalsMode ? row.cashDecimal : null,
    initialTotalFrankingDecimal: isTotalsMode ? row.frankingTotalDecimal : null,
    initialExpectedVersion: record?.version ?? null,
    initialExclude: false,
  };
}

export function freshEntryPrefill(portfolioSecurityId: string): DialogPrefill {
  return {
    initialPortfolioSecurityId: portfolioSecurityId,
    initialPaymentDate: null,
    initialDividendEventId: null,
    initialManualRecordId: null,
    initialSharesDecimal: null,
    initialDividendPerShareDecimal: null,
    initialFrankingCreditPerShareDecimal: null,
    initialAmountMode: "per_share",
    initialTotalCashDecimal: null,
    initialTotalFrankingDecimal: null,
    initialExpectedVersion: null,
    initialExclude: false,
  };
}
