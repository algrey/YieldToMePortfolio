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
  groupThousands,
  parseDecimalResult,
} from "../domain/calculations/decimal.ts";
import type {
  DerivedDividendRow,
  FrankingResolution,
} from "../domain/dividends/index.ts";
import { formatIncomeMoney } from "./income-format.ts";

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

export function formatShares(value: string): string {
  try {
    return groupThousands(
      formatDecimalTrimmed(parseDecimalResult(value), 4, {
        trimTrailingZeros: true,
      }),
    );
  } catch {
    return value;
  }
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
): string {
  if (franking.source === "unknown") return "Unknown";
  return `${formatIncomeMoney(currencyCode, franking.perShareDecimal)} (${franking.source})`;
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
      initialExpectedVersion: override?.version ?? null,
      initialExclude: override?.exclude ?? row.excluded,
    };
  }
  const separatorIndex = row.id.indexOf(":");
  const prefix = separatorIndex >= 0 ? row.id.slice(0, separatorIndex) : "";
  const rawId = separatorIndex >= 0 ? row.id.slice(separatorIndex + 1) : "";
  const recordId = prefix === "manual" || prefix === "imported" ? rawId : null;
  const record = recordId ? (manualRecordsById[recordId] ?? null) : null;
  return {
    initialPortfolioSecurityId: portfolioSecurityId,
    initialPaymentDate: row.paymentDate ?? today,
    initialDividendEventId: null,
    initialManualRecordId: recordId,
    initialSharesDecimal: row.sharesDecimal,
    initialDividendPerShareDecimal: row.dividendPerShareDecimal,
    initialFrankingCreditPerShareDecimal: rawFranking,
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
    initialExpectedVersion: null,
    initialExclude: false,
  };
}
