// DIV-001: derived dividend history for one portfolio security.
//
// Owner model (TASKS.md DIV-001, 2026-08-13): dividend history is DERIVED
// AT READ TIME. For each provider dividend event, the auto row = shares
// held at the ex-date x dividend per share. Owner overrides are sparse rows
// keyed to a specific event version (shares/dividend-per-share/franking, or
// exclude) so overriding an old dividend never blocks new events; manual
// records cover securities/events the provider misses. Double-count guard:
// for one security+event window, exactly one row wins.
//
// Precedence (DIV-004, 2026-08-13, correcting IMP-006's two-tier gap):
// override > manual (owner-typed) > receipt > imported > auto-derived, per
// event (highest first):
//   1. An owner override resolved via the supersedes-chain lineage
//      (`resolveEventOverrideForLineage`, the MKT-005-review-binding fix --
//      a naive "current active event only" lookup would silently lose an
//      override attached to a superseded prior version). `exclude` removes
//      the row from totals entirely but the row is still returned
//      (retrievable), never dropped from the list. An excluded event is
//      also removed from manual-matching/receipt-claiming consideration
//      entirely (see B3 below) -- it must not consume/hide separately
//      recorded owner facts.
//   2. An owner-typed manual record (`dividend_manual_records` with
//      `import_batch_id IS NULL` -- entered directly through the
//      manual-entry UI, not by the CSV importer) proximity-matched to the
//      event GLOBALLY (every candidate (event, manual) pair within
//      `PROXIMITY_WINDOW_DAYS` days, assigned nearest-distance-first across
//      the WHOLE set -- not a per-event greedy pass, which can mis-assign
//      when two events compete for one manual record; see
//      `matchManualRecordsGlobally`'s doc comment for the exact tie-break
//      rule). Ties in the assignment process are broken deterministically;
//      PROXIMITY_WINDOW_DAYS defaults to 7. If a receipt and/or an imported
//      row ALSO exist for the same event, both are consumed by this row (no
//      duplicate rows) but their values remain visible via `dominatedReceipt`
//      / `dominatedImported` -- never silently dropped.
//   3. An imported actual receipt tied to the event OR any version in its
//      lineage (the identical lineage-survival problem the override BINDING
//      fix addresses applies equally to a receipt recorded against a
//      since-superseded event id; resolved the same way here for
//      consistency, though not itself the literal BINDING clause). Multiple
//      receipts attached to one lineage: the latest by payment date wins;
//      the rest are not silently discarded -- `additionalReceiptsCount`
//      discloses how many were not individually shown. An imported row
//      matched to the same event is consumed and shown via
//      `dominatedImported`.
//   4. An imported row (`dividend_manual_records` with `import_batch_id`
//      present -- created by a CSV import, never directly by the owner),
//      proximity-matched to the event GLOBALLY using the identical
//      mechanism as tier 2, but run against the imported-only subset and
//      only wins the row when neither an owner manual record nor a receipt
//      claimed the same event. DIV-004: separated from the owner-manual
//      tier because an imported row is evidence the OWNER never personally
//      typed -- it must never outrank a receipt (actual payment evidence)
//      or an owner-typed manual record for the same real dividend.
//   5. Auto-derived: shares held at ex-date (`deriveSharesHeldAtDate`) x
//      the event's gross per share. A null `gross_per_share_decimal` (only
//      reachable via malformed/defensive input -- the DB CHECK constraint
//      requires it for a real `declared`/`paid` event) never fabricates a
//      "0" amount: the row's `dividendPerShareDecimal`/`cashDecimal`/
//      `grossDecimal` are `null` and `amountUnknown` is `true` instead.
// An owner manual record or receipt left unmatched after every event is
// processed becomes its own standalone row (no `dividendEventId`) -- the
// "covers securities/events the provider misses" case, UNLESS it transitively
// chains into another fact or event-winning fact (DIV-005, below). An
// imported row similarly left unmatched by any event does NOT automatically
// become its own standalone row: DIV-005 (2026-08-14, extending DIV-004's
// single-hop version of this rule) first proximity-chains it -- see the
// "DIV-005" comments further down for the two-round union-find/nearest-wins
// design -- against every event whose winning fact is itself close enough
// (Round A, single hop, event-anchored) and, failing that, transitively
// against every standalone owner-manual record and orphan receipt for the
// security, INCLUDING chains longer than one hop (Round B, eventless
// clusters only; there is no common event to anchor the comparison to in
// this case). Only an imported row that matches neither an event, a chain
// anchor, nor any eventless chain becomes its own standalone `source:
// "imported"` row. A receipt that no ACTIVE event's lineage claims at all
// (its event is cancelled, missing an ex-date, or otherwise never reached
// `activeEvents`) resurfaces the same way, as its own standalone row
// (`receipt:<id>`) built from the receipt's own dates -- this case silently
// drops owner/imported data otherwise (the matching cancelled/null-ex-date
// follow-up). A receipt dominated by a non-excluded override remains
// intentionally not shown (the owner's edit supersedes it).
//
// EXCLUDED events (review round 3, fixing a blocking double-count the round-2
// B3 fix introduced): a manual record and a receipt BOTH attached to the
// SAME excluded event must still collapse to exactly ONE resurfaced row --
// round 2's independent "manual falls through to the standalone loop" /
// "receipt resurfaces directly" paths did not dedupe against each other,
// so an excluded event with both produced two rows for one real dividend
// (repro: excluded event, receipt $500, manual $500 -> reported $1000).
// The fix: manual matching still considers excluded events as candidates
// (so a genuinely nearby manual record attaches to them, not just to
// non-excluded events), and receipts still attach via lineage to excluded
// events (not pushed straight to the orphan/standalone pool) -- then a
// SEPARATE post-pass runs the identical override-free precedence
// (`resolveOwnerFact`: manual wins, receipt attached as `dominatedReceipt`,
// consistent with B5) once per excluded event, emitting at most one
// resurfaced row per excluded event regardless of how many owner facts are
// attached to it. DIV-004 extends the same pass with the imported tier: an
// imported row matched to an excluded event resurfaces (as `dominatedImported`
// when a manual/receipt also resurfaces, or as its own `source: "imported"`
// resurfaced row when it is the only owner fact attached) using the exact
// same collapse rule -- an excluded event never resurfaces more than one row
// regardless of how many of the four tiers are attached to it.
//
// `status='paid'` binding note (MKT-005 review, 2026-08-13): the provider
// supplies no payment evidence -- `paid` is an ex-date-passage lifecycle
// column, not proof money was received. This module never reads the raw
// `status` string as receipt evidence and instead exposes a row-level
// `status` of `"ex_date_passed" | "declared_pending"`, computed
// independently from `exDate` vs `today` (every row reaching this
// computation is guaranteed a non-null `exDate` by the `activeEvents`
// filter, so there is no provider-status fallback branch to keep
// unambiguous).
import {
  deriveSharesHeldAtDate,
  type LedgerQuantityFact,
} from "./shares-held.ts";
import {
  resolveEventOverrideForLineage,
  type EventOverrideFact,
} from "./event-override-resolution.ts";
import { collectEventLineageIds } from "../market-data/corporate-action-ingestion.ts";
import {
  resolveFrankingPerShare,
  type FrankingResolution,
} from "./franking.ts";
import {
  addDecimal,
  formatDecimalExact,
  isZero,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
} from "../calculations/decimal.ts";

export const PROXIMITY_WINDOW_DAYS = 7;

export type ProviderDividendEventFact = {
  id: string;
  kind: "cash" | "special" | "capital_return";
  status: "estimated" | "declared" | "paid" | "cancelled" | "superseded";
  exDate: string | null;
  paymentDate: string | null;
  currencyCode: string;
  grossPerShareDecimal: string | null;
  supersedesEventId: string | null;
};

export type DividendReceiptFact = {
  id: string;
  dividendEventId: string;
  sharesDecimal: string;
  dividendPerShareDecimal: string;
  frankingPerShareDecimal: string | null;
  currencyCode: string;
  paymentDate: string;
};

export type DividendManualRecordFact = {
  id: string;
  paymentDate: string;
  // BRK-005: nullable -- a totals-mode Sharesight payout row (see
  // `db/schema.ts`'s `dividendManualRecords` header note) has no per-share
  // fact at all. `sharesDecimal`/`dividendPerShareDecimal` are null on that
  // row alone, and `totalCashDecimal` is set instead; every per-share row
  // still has both non-null and both `total*` fields null. DIV-016 part A:
  // the "imported" tier is no longer the only one that can carry a
  // totals-mode fact -- the owner-facing manual-entry dialog now offers a
  // totals mode too (`app/dividend-assumptions-actions.ts`'s
  // `saveDividendEntryWithContext`), so an `importBatchId === null`
  // ("manual" tier) record can be totals-mode as well. `dividend_receipts`
  // still only ever supplies per-share facts.
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  // Optional (not just nullable) so every pre-BRK-005 fixture/caller that
  // never mentions these two fields keeps compiling unchanged; read as
  // `?? null` everywhere this module consumes them.
  totalCashDecimal?: string | null;
  totalFrankingDecimal?: string | null;
  // DIV-004: present exactly for rows a CSV import batch created (IMP-006);
  // `null` for rows the owner entered directly through the manual-entry UI.
  // This is the sole signal this module uses to place a record in the
  // "manual" (owner-typed) tier vs the "imported" tier -- see the module
  // header precedence.
  importBatchId: string | null;
  // BRK-010 review finding B4: foreign-currency payout provenance -- present
  // only on an "imported" tier fact (a Sharesight payout) whose cash total
  // was recorded in a currency other than its OWN SECURITY's currency
  // (`db/schema.ts`'s `dividendManualRecords` header note's three-case
  // model); a manual/receipt fact never carries these.
  // `fxRateToPortfolioDecimal`/`fxRateSource` are paired (never present
  // without `currencyCode`), but `currencyCode` MAY stand alone (no
  // achievable rate -- see the schema header note's case C). Optional (not
  // just nullable) so every pre-BRK-010 fixture/caller that never mentions
  // these fields keeps compiling unchanged, mirroring `totalCashDecimal`
  // above -- read as `?? null` everywhere this module consumes them. See
  // `resolveImportedRecordCurrency` for how this module uses them.
  currencyCode?: string | null;
  fxRateToPortfolioDecimal?: string | null;
  fxRateSource?: string | null;
  // BRK-010 review finding F2/B4: INTERNAL bookkeeping flag, set by this
  // module's own `resolveImportedRecordCurrency` pre-pass -- never set by
  // any external caller (always `undefined`/falsy on a freshly loaded
  // fact). `true` only when `totalCashDecimal`/`totalFrankingDecimal` above
  // were ACTUALLY converted into the security's own currency (the
  // record's `currencyCode` differed from `securityCurrencyCode`, its own
  // `securityCurrencyCode` equalled the portfolio's base currency, and a
  // rate was present and applied). Row construction reads this to decide
  // between surfacing `originalCurrencyCode`/rate/source as PROVENANCE
  // (converted) vs. displaying the record's own `currencyCode` as the
  // row's TRUE currency, degrading to `mixed_currency` at aggregation
  // (never converted, or conversion was not achievable at all) -- see
  // `resolveOwnerFact`'s `originalCurrencyCode`/`degradedCurrencyCode`
  // split below.
  convertedToSecurityCurrency?: boolean;
  // DIV-007: INTERNAL bookkeeping flag, set by this module's own
  // `deriveAbsentImportedFranking` pre-pass -- never set by any external
  // caller (always `undefined`/falsy on a freshly loaded fact), mirroring
  // `convertedToSecurityCurrency`'s established convention above. `true`
  // only when this record's `totalFrankingDecimal` was rewritten from a
  // genuinely ABSENT (raw `null`) stored value to `"0"` by that pre-pass --
  // see its doc comment for the full ruling/evidence basis. Never set for a
  // Sharesight-supplied explicit zero/positive total (that value is already
  // known and passes through unchanged) or for the BRK-010 unverified-
  // nonzero-foreign guard's nulling (that stays genuinely unknown).
  frankingDerivedZero?: boolean;
  // BRK-011: EXTERNAL input -- the owner's persisted
  // `dividend_import_franking_overrides` figure for THIS specific imported
  // record, when one exists (`db/schema.ts`'s header note; only ever
  // meaningful for an `importBatchId !== null` totals-mode fact). `null`/
  // `undefined` on every record with no override. Consumed once, at the
  // very start of the imported-tier pipeline, by `applyFrankingCurrencyOverride`
  // below -- never read again downstream (the resulting
  // `frankingCurrencySource` flag is what the rest of this module tests).
  frankingOverrideTotalDecimal?: string | null;
  // BRK-011: INTERNAL bookkeeping flag, set ONLY by this module's own
  // `applyFrankingCurrencyOverride` pre-pass (never by any external caller,
  // mirroring `convertedToSecurityCurrency`/`frankingDerivedZero`'s
  // established convention) -- `"owner_manual"` exactly when
  // `frankingOverrideTotalDecimal` above was applied. The tier-1
  // (Sharesight-supplied AUD franking) and tier-2 (automatic payment-date
  // FX conversion) values this field's type reserves are NOT produced by
  // any code path today, both left UNCONFIRMED rather than disproven --
  // `scripts/sharesight-franking-fx-spike.mjs`'s live evidence (see
  // `docs/ARCHITECTURE.md` §8.2) found the documented tier-1-shaped
  // `tax_credit` field absent from all 10 of the owner's foreign (USD)
  // payouts AND all 61 of their franked native (AUD) payouts -- evidence
  // it does not populate on this account's wire, but the untested
  // foreign+franked combination stops short of proof; tier 2 stays
  // INCONCLUSIVE for the separate, simpler reason that no franked foreign
  // payout exists to confirm franking's own-currency denomination against.
  // Both tiers stay documented-but-unimplemented rather than guessing.
  // Once set, this SUPPRESSES `resolveImportedRecordCurrency`'s
  // unverified-nonzero-foreign guard (the override IS the owner's trusted,
  // deliberate resolution of exactly that uncertainty) and, because
  // `totalFrankingDecimal` is already non-null by the time
  // `deriveAbsentImportedFranking` runs, that function's absent-value
  // derivation naturally never fires for an overridden record either.
  frankingCurrencySource?: "owner_manual" | null;
  // BUG-021: INTERNAL bookkeeping flag, set ONLY by this module's own
  // `sanitizeManualRecordAmounts` pre-pass (never by any external caller,
  // mirroring `convertedToSecurityCurrency`/`frankingDerivedZero`'s
  // established convention) -- `true` when at least one of this record's
  // OWN stored decimal columns (`sharesDecimal`, `dividendPerShareDecimal`,
  // `frankingCreditPerShareDecimal`, `totalCashDecimal`,
  // `totalFrankingDecimal`) could not be read by `parseDecimal` (over
  // `DECIMAL_LIMITS.inputDigits`/`inputScale`, or simply non-canonical) --
  // a value written before BUG-014's write-time bound, or any other
  // direct-DB path that bound does not gate. That field is nulled by the
  // same pre-pass rather than left to throw downstream; see
  // `sanitizeManualRecordAmounts`'s doc comment.
  amountUnreadable?: boolean;
  // BUG-021 correction round: INTERNAL bookkeeping set, populated ONLY by
  // `sanitizeManualRecordAmounts` alongside `amountUnreadable` above --
  // names exactly WHICH of this record's own columns (and, for an imported
  // fact, `frankingOverrideTotalDecimal`) failed to parse. `amountUnreadable`
  // alone collapses every column into one flag; once a field is nulled, an
  // UNREADABLE value and a genuinely BLANK one are otherwise indistinguishable
  // to any downstream consumer. Two consumers must react differently to the
  // two cases rather than treating "unreadable" as "absent": `deriveAbsentImportedFranking`
  // (an absent stored total gets DIV-007's "$0, none reported" inference; an
  // UNREADABLE one must never get a derived zero -- it stays honestly
  // unknown with its own `frankingUnreadable` disclosure) and
  // `resolveImportedRecordCurrency`'s B2 guard (an unreadable cash total
  // must keep the conservative pre-sanitize outcome -- unconverted/unknown
  // -- never `convertedToSecurityCurrency: true` for a value nothing was
  // actually converted from).
  unreadableFields?: ReadonlySet<
    "totalCash" | "totalFranking" | "shares" | "perShare" | "frankingPerShare"
  >;
  // BUG-021 correction round: INTERNAL bookkeeping flag, set ONLY by this
  // module's own `deriveAbsentImportedFranking` (imported tier) or
  // `resolveOwnerFact` (owner-typed tier, read directly from
  // `unreadableFields` above) -- mirrors `frankingDerivedZero`'s established
  // convention. `true` exactly when this record's effective franking total
  // is `null` BECAUSE the stored `totalFrankingDecimal` (or an owner
  // `frankingOverrideTotalDecimal`) could not be parsed, never for a
  // genuinely absent or Sharesight-omitted one (those stay `frankingDerivedZero`/
  // plain-unknown, as before).
  frankingUnreadable?: boolean;
  // BRK-022 slice 3: `true` exactly for a `sharesight_pending_payouts`
  // observation fed in as a fact (`app/owned-dividend-history.ts`'s
  // `pending:<row id>` facts) -- a Sharesight ANNOUNCEMENT, never itself
  // payment evidence, unlike every other fact this module ever sees
  // (owner-typed manual entry, receipt, or a committed CSV/Sharesight
  // import). `undefined`/falsy on every other fact. This is also the
  // discriminator that routes such a fact into the "imported" tier
  // (alongside `importBatchId !== null`) below -- an announcement is
  // provider evidence the owner never personally typed, exactly DIV-004's
  // rationale for that tier, even though it never went through a CSV
  // import batch (`importBatchId` stays `null`, honestly reflecting that).
  announcedUnpaid?: boolean;
  // BRK-022 slice 3: the pending payout's own `ex_date` (Sharesight's
  // `goes_ex_on`), when known -- `DividendManualRecordFact` otherwise never
  // carries an ex-date (only `ProviderDividendEventFact`/`DividendReceiptFact`
  // do). Lets a standalone announced row (no matching event) still surface
  // and be attributed by ex-date, mirroring a receipt's `rawEvent?.exDate`
  // convention. `undefined`/null for every other fact.
  exDate?: string | null;
};

export type DerivedDividendRowSource =
  "auto" | "edited" | "receipt" | "manual" | "imported";
export type DerivedDividendRowLifecycleStatus =
  "ex_date_passed" | "declared_pending";

export type DominatedReceipt = {
  sharesDecimal: string;
  dividendPerShareDecimal: string;
  frankingPerShareDecimal: string | null;
  paymentDate: string;
};

/** Mirrors `DominatedReceipt` for an imported row consumed by a higher tier
 * (owner manual record or receipt) winning the same row -- its values stay
 * visible here rather than being silently dropped. BRK-005: nullable
 * per-share fields plus `totalCashDecimal`/`totalFrankingDecimal`, mirroring
 * `DividendManualRecordFact` -- a dominated totals-mode payout keeps its
 * real total visible rather than reading as "Unknown". */
export type DominatedImported = {
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  totalCashDecimal: string | null;
  totalFrankingDecimal: string | null;
  paymentDate: string;
  // BRK-010: the ORIGINAL payout currency/rate/source, when this dominated
  // fact was foreign-currency (by this point `totalCashDecimal`/
  // `totalFrankingDecimal` above have already been converted into the
  // security's own currency -- see `convertImportedRecordToSecurityCurrency`
  // -- so these three fields are the only place the original currency/rate
  // survives for display). `null` for a same-currency/legacy fact.
  currencyCode: string | null;
  fxRateToPortfolioDecimal: string | null;
  fxRateSource: string | null;
  /** DIV-007: mirrors `DerivedDividendRow.frankingDerivedZero` for a
   * dominated imported fact -- see that field's doc comment. */
  frankingDerivedZero: boolean;
  /** BRK-011: mirrors `DerivedDividendRow.frankingCurrencySource` for a
   * dominated imported fact -- see that field's doc comment. */
  frankingCurrencySource: "owner_manual" | null;
};

export type DerivedDividendRow = {
  id: string;
  portfolioSecurityId: string;
  dividendEventId: string | null;
  kind: "cash" | "special" | "capital_return" | "manual";
  currencyCode: string;
  exDate: string | null;
  paymentDate: string | null;
  /** `null` only for a BRK-005 totals-mode row (a Sharesight payout, or -- DIV-016 part A -- an owner-typed totals-mode entry, neither of which reports a share count) -- rendered as "Unknown", never fabricated by deriving a share count from unrelated ledger holdings. Non-null for every other tier/source. */
  sharesDecimal: string | null;
  /** `null` when the per-share amount is genuinely unknown -- no override/receipt/manual value AND the provider event's own amount is null, OR a BRK-005 totals-mode row (which has no per-share fact at all, only a total) -- never fabricated as "0". */
  dividendPerShareDecimal: string | null;
  cashDecimal: string | null;
  franking: FrankingResolution;
  frankingTotalDecimal: string | null;
  grossDecimal: string | null;
  grossIncludesFranking: boolean;
  status: DerivedDividendRowLifecycleStatus;
  source: DerivedDividendRowSource;
  excluded: boolean;
  /** True exactly when `cashDecimal` is `null` -- equivalent to `dividendPerShareDecimal === null` for every row EXCEPT a BRK-005 totals-mode row, whose per-share amount is unknown but whose cash total is known (so it is never counted as amount-unknown and its real total still contributes to lifetime sums). */
  amountUnknown: boolean;
  /** The provider event's own, unedited per-share amount (present whenever an event backs the row, regardless of source), so a detail view can show "provider says X, you overrode to Y" (UI-006C). */
  providerGrossPerShareDecimal: string | null;
  /** Set when a receipt existed for this event but a manual record won the row (manual > receipt precedence): the receipt is consumed (no duplicate row), its values kept visible here. */
  dominatedReceipt: DominatedReceipt | null;
  /** Set when an imported row (DIV-004) existed for this event/proximity match but an owner manual record or a receipt won the row: the imported row is consumed (no duplicate row), its values kept visible here. */
  dominatedImported: DominatedImported | null;
  /** Receipts attached to this event's lineage beyond the single one used (as the row itself, or as `dominatedReceipt`) -- not silently discarded, counted here. */
  additionalReceiptsCount: number;
  /** DIV-005: imported rows transitively chained into this row (Round B, eventless clusters only) beyond the single one shown via `dominatedImported` -- not silently discarded, counted here, mirroring `additionalReceiptsCount`'s convention. Always 0 for event-anchored rows (Round A only ever attaches one). */
  additionalImportedCount: number;
  /** BRK-010: non-null only when `source === "imported"` and the WINNING
   * fact was a foreign-currency Sharesight payout -- the currency the
   * payout was actually paid in, before conversion (`cashDecimal`/
   * `grossDecimal` above are already converted into this row's own
   * `currencyCode`, matching this module's per-security single-currency
   * invariant -- see the module header's scope-boundary note). `null` for
   * every other source and for a same-currency/legacy imported row. */
  originalCurrencyCode: string | null;
  /** BRK-010: Sharesight's own rate that converted `originalCurrencyCode`
   * into this row's `currencyCode` -- see `convertImportedRecordToSecurityCurrency`.
   * Non-null exactly when `originalCurrencyCode` is. */
  fxRateToPortfolioDecimal: string | null;
  /** BRK-010: currently always `"sharesight"` when set -- see
   * `db/schema.ts`'s `dividendManualRecords` header note for the closed
   * source set. Non-null exactly when `originalCurrencyCode` is. */
  fxRateSource: string | null;
  /** DIV-007 (owner ruling 2026-08-20): `true` exactly when this row's
   * `frankingTotalDecimal` is `"0"` because the winning Sharesight-imported
   * totals-mode fact OMITTED its franking field entirely (stored `null` --
   * the field was never sent on the wire), inferred as $0 franking from
   * Sharesight's demonstrated behaviour of sending an EXPLICIT `0` for
   * unfranked native-currency payouts (see
   * `deriveAbsentImportedFranking`'s doc comment; documented as an
   * inference in `docs/CALCULATIONS.md` section 11). `false` for a
   * Sharesight-supplied explicit zero/positive franking total (a real
   * reported figure, not an inference) and for every non-imported source.
   * The BRK-010 nonzero-foreign-franking unverified-currency guard is
   * unrelated and untouched -- that case stays `frankingTotalDecimal: null`
   * (genuinely unknown), never reaching this flag at all. */
  frankingDerivedZero: boolean;
  /** BRK-011: non-null exactly `"owner_manual"` when this row's
   * `frankingTotalDecimal` came from an owner-entered
   * `dividend_import_franking_overrides` figure (tier 3 of the owner's
   * BINDING resolution cascade -- see `docs/CALCULATIONS.md` section 11).
   * `null` for every other source, including a Sharesight-reported figure
   * (whether an explicit value or DIV-007's inferred absent-field zero) and
   * the BRK-010 unverified-currency guard's null. The owner's cascade also
   * names tier-1 (`"sharesight"`) and tier-2 (`"sharesight_rate"`)
   * provenance, but neither is implemented by any code path today -- this
   * field's type stays a plain `"owner_manual" | null` rather than a wider
   * union with unreachable members; widening it is the natural extension
   * point if a future evidence-backed implementation adds either tier. See
   * `DividendManualRecordFact.frankingCurrencySource`'s doc comment for the
   * live-spike evidence this reflects. */
  frankingCurrencySource: "owner_manual" | null;
  /** BUG-021: `true` exactly when this row's `amountUnknown` (`cashDecimal
   * === null`) is caused by a stored `dividend_manual_records` amount this
   * module could not read (`sanitizeManualRecordAmounts`), NOT by a
   * genuinely absent one -- lets a consumer render the distinct
   * "amount unavailable -- needs correction" copy rather than the generic
   * missing-data label a plain unknown amount gets. Always implies
   * `amountUnknown: true`; never the reverse (a genuinely blank field is
   * NOT unreadable). `false`/`undefined` for `"auto"`/`"edited"` sources
   * (never built from a `dividend_manual_records` row) and for a clean
   * manual/receipt/imported record. Optional so every pre-BUG-021
   * fixture/caller that never mentions it keeps compiling and behaving
   * unchanged, mirroring this module's other internal-flag fields. */
  amountUnreadable?: boolean;
  /** BUG-021 correction round: `true` exactly when this row's
   * `frankingTotalDecimal` is `null` BECAUSE the underlying stored
   * `totalFrankingDecimal` (or an owner `frankingOverrideTotalDecimal`)
   * could not be read (`sanitizeManualRecordAmounts`), NOT because it was
   * genuinely absent/omitted -- see `deriveAbsentImportedFranking`'s doc
   * comment. Lets a consumer render the distinct "Franking unavailable --
   * needs correction" copy rather than "Unknown" or DIV-007's "none
   * reported" inference. `false`/`undefined` for `"auto"`/`"edited"`
   * sources and for a clean manual/receipt/imported record, mirroring
   * `amountUnreadable`'s convention. BUG-023: also `true` when the cause is
   * an unreadable PER-SHARE franking credit
   * (`frankingCreditPerShareDecimal`) rather than an unreadable TOTAL --
   * see `resolveFrankingPerShareRespectingUnreadable`'s doc comment. A
   * consumer never needs to distinguish the two causes; both mean "a real
   * franking figure exists here but this app could not read it, never
   * substitute the default assumption". */
  frankingUnreadable?: boolean;
  /** BRK-022 slice 3: `true` exactly when this row's underlying fact is a
   * `sharesight_pending_payouts` announcement (`DividendManualRecordFact.announcedUnpaid`)
   * -- never payment evidence, unlike every other `source` this row could
   * carry. `false` for every auto-derived/override/receipt/owner-manual/
   * committed-imported row, INCLUDING an event-anchored row an announced
   * fact happens to win (`dividendEventId` set) -- that row's `status`
   * still derives from the event's own `exDate` as before (a real declared
   * event backs it), this flag only marks that the WINNING fact was itself
   * an announcement rather than a receipt/committed import. Consumers:
   * `domain/dividends/forecast.ts` excludes a STANDALONE announced row
   * (`announcedUnpaid && dividendEventId === null`) from declared coverage
   * (an event-anchored one keeps counting -- it replaced the provider row
   * that already counted); `app/owned-dividend-list.ts`/UI render
   * "announced (Sharesight)" alongside the not-paid status. */
  announcedUnpaid: boolean;
};

export type DeriveDividendHistoryInput = {
  portfolioSecurityId: string;
  securityCurrencyCode: string;
  /** BRK-010 review finding B4: the committing portfolio's own base
   * currency (`portfolios.base_currency_code`) -- used so
   * `resolveImportedRecordCurrency` can assert that a stored
   * record-currency -> portfolio-base rate is actually being applied
   * TOWARD the portfolio base (the only direction it is valid for) before
   * ever using it to convert an imported fact's totals; see that
   * function's doc comment for the full three-case model. Optional,
   * defaulting to `securityCurrencyCode` when omitted -- every pre-BRK-010
   * fixture/caller that never supplies a foreign `currencyCode` on a
   * manual record is completely unaffected by this default either way
   * (the conversion function's very first check short-circuits before this
   * field is ever consulted), so every existing test/caller keeps
   * compiling and behaving unchanged; `app/owned-dividend-history.ts`, the
   * one production caller, always supplies the real value explicitly. */
  portfolioBaseCurrencyCode?: string;
  /** ALL events for the security (active AND superseded -- required for lineage). */
  events: readonly ProviderDividendEventFact[];
  overrides: readonly EventOverrideFact[];
  receipts: readonly DividendReceiptFact[];
  manualRecords: readonly DividendManualRecordFact[];
  transactions: readonly LedgerQuantityFact[];
  defaultFrankingPercentDecimal: string | null;
  today: string;
};

function daysBetween(a: string, b: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / msPerDay,
  );
}

function lifecycleStatus(
  exDate: string,
  today: string,
): DerivedDividendRowLifecycleStatus {
  return exDate <= today ? "ex_date_passed" : "declared_pending";
}

function computeCashGross(
  sharesDecimal: string,
  dividendPerShareDecimal: string | null,
  franking: FrankingResolution,
): {
  cashDecimal: string | null;
  frankingTotalDecimal: string | null;
  grossDecimal: string | null;
  grossIncludesFranking: boolean;
} {
  if (dividendPerShareDecimal === null) {
    return {
      cashDecimal: null,
      frankingTotalDecimal: null,
      grossDecimal: null,
      grossIncludesFranking: false,
    };
  }
  const shares = parseDecimal(sharesDecimal);
  const cash = formatDecimalExact(
    multiplyDecimal(shares, parseDecimal(dividendPerShareDecimal)),
  );
  if (franking.source === "unknown") {
    return {
      cashDecimal: cash,
      frankingTotalDecimal: null,
      grossDecimal: cash,
      grossIncludesFranking: false,
    };
  }
  const frankingTotal = formatDecimalExact(
    multiplyDecimal(shares, parseDecimal(franking.perShareDecimal)),
  );
  const gross = formatDecimalExact(
    addDecimal(parseDecimal(cash), parseDecimal(frankingTotal)),
  );
  return {
    cashDecimal: cash,
    frankingTotalDecimal: frankingTotal,
    grossDecimal: gross,
    grossIncludesFranking: true,
  };
}

/**
 * BRK-005: additive wrapper around `computeCashGross` that also handles a
 * totals-mode fact (a Sharesight payout, which reports a total cash amount
 * and total franking credits with no share count/per-share amount at all --
 * see `DividendManualRecordFact`'s header note). When `dividendPerShareDecimal`
 * is non-null this delegates to `computeCashGross` UNCHANGED (byte-identical
 * for every pre-BRK-005 row, verified by the existing DIV-001/004/005 test
 * suites); when it is null AND a `totalCashDecimal` is supplied, the total
 * IS the cash fact (never derived from shares x per-share, since neither is
 * known) and franking is the supplied total directly rather than run through
 * `resolveFrankingPerShare`'s per-share gross-up math (there is no per-share
 * base to gross up). When neither is available this falls through to the
 * same "genuinely unknown" null result `computeCashGross` already returns.
 */
function computeCashGrossOrTotals(
  dividendPerShareDecimal: string | null,
  sharesDecimal: string | null,
  totalCashDecimal: string | null,
  totalFrankingDecimal: string | null,
  franking: FrankingResolution,
): {
  cashDecimal: string | null;
  frankingTotalDecimal: string | null;
  grossDecimal: string | null;
  grossIncludesFranking: boolean;
} {
  if (dividendPerShareDecimal !== null && sharesDecimal !== null) {
    return computeCashGross(sharesDecimal, dividendPerShareDecimal, franking);
  }
  if (totalCashDecimal !== null) {
    if (totalFrankingDecimal === null) {
      return {
        cashDecimal: totalCashDecimal,
        frankingTotalDecimal: null,
        grossDecimal: totalCashDecimal,
        grossIncludesFranking: false,
      };
    }
    const gross = formatDecimalExact(
      addDecimal(
        parseDecimal(totalCashDecimal),
        parseDecimal(totalFrankingDecimal),
      ),
    );
    return {
      cashDecimal: totalCashDecimal,
      frankingTotalDecimal: totalFrankingDecimal,
      grossDecimal: gross,
      grossIncludesFranking: true,
    };
  }
  return {
    cashDecimal: null,
    frankingTotalDecimal: null,
    grossDecimal: null,
    grossIncludesFranking: false,
  };
}

/**
 * BUG-023: the single point every franking-per-share derivation in this
 * module goes through (main per-event loop, `pushEventlessRow`, excluded-
 * event resurfacing), so the three call sites cannot drift apart the way
 * BUG-021's `frankingUnreadable`/`amountUnreadable` guards already had to be
 * kept in sync by hand across them. When the winning fact's OWN per-share
 * franking credit could not be read (`frankingPerShareUnreadable`, the
 * `"frankingPerShare"` marker `sanitizeManualRecordAmounts` sets), the
 * franking resolution is forced to `"unknown"` WITHOUT ever calling
 * `resolveFrankingPerShare` -- that function cannot distinguish "no
 * per-share credit was ever entered" from "one was entered but is
 * unreadable" (both reach it as `overridePerShareDecimal: null`), so calling
 * it here would let its default-percent tier silently substitute the
 * security's "franking if not known" assumption for a value that in fact
 * exists but this app cannot currently read -- exactly the fabricated-
 * known-from-corrupt pattern BUG-021 closed for the franking TOTAL.
 */
function resolveFrankingPerShareRespectingUnreadable(
  frankingPerShareUnreadable: boolean,
  overrideFrankingPerShare: string | null,
  defaultFrankingPercentDecimal: string | null,
  dividendPerShareDecimal: string | null,
): FrankingResolution {
  if (frankingPerShareUnreadable) {
    return { source: "unknown", perShareDecimal: null };
  }
  return resolveFrankingPerShare(
    overrideFrankingPerShare,
    defaultFrankingPercentDecimal,
    dividendPerShareDecimal,
  );
}

// BRK-010: half-even rounding at the same 24-decimal-place intermediate
// scale `franking.ts`'s `DEFAULT_TIER_SCALE` establishes for financial math
// with no natural terminating decimal scale (see that module's header
// comment) -- reused here rather than re-exported, since a Sharesight FX
// rate multiplied against a cash total is likewise not guaranteed to
// terminate at a fixed decimal count the way `computeCashGross`'s
// shares-times-per-share multiplication normally does.
const FX_CONVERSION_SCALE = 24;

function convertDecimalToSecurityCurrency(
  amountDecimal: string,
  fxRateToPortfolioDecimal: string,
): string {
  return formatDecimalExact(
    roundDecimal(
      multiplyDecimal(
        parseDecimal(amountDecimal),
        parseDecimal(fxRateToPortfolioDecimal),
      ),
      FX_CONVERSION_SCALE,
    ),
  );
}

/**
 * BRK-010 review finding B4 (BINDING CORRECTION): the stored rate's
 * semantics are record-currency -> PORTFOLIO BASE (matching the
 * `fx_rate_to_portfolio_decimal` column name literally) -- it does NOT know
 * how to convert into an arbitrary SECURITY's own currency. This function
 * may therefore apply it ONLY when the requested target
 * (`securityCurrencyCode`) equals `portfolioBaseCurrencyCode` -- asserted
 * at this, the one call site that ever attempts a conversion. When they
 * differ (a security whose own currency is neither the payout's currency
 * NOR the portfolio's base -- e.g. an NZD-denominated security paying a
 * USD dividend inside an AUD-base portfolio), NO CASH conversion is
 * attempted and `totalCashDecimal` stays in the payout's own (foreign)
 * currency; `convertedToSecurityCurrency` stays falsy, so row construction
 * displays the record's TRUE currency (never silently relabelled as the
 * security's own) and DIV-001's existing `mixed_currency` aggregation
 * degradation naturally applies -- see `computeLifetimeDividendTotals`'s/
 * `computeFyDividendTotals`'s pre-existing currency-agreement checks, which
 * this function does nothing to bypass. `totalFrankingDecimal` is handled
 * SEPARATELY from cash and independently of this achievable/not-achievable
 * split -- see the B2 franking rule below, which can null it out even in
 * this unachievable case.
 *
 * A record whose `currencyCode` is null (legacy) or already equal to
 * `securityCurrencyCode` is native -- returned unchanged, matching
 * `domain/ledger/projections.ts`'s "rate is trivially exact by currency
 * identity" convention for the same case. When conversion IS achievable
 * (`securityCurrencyCode === portfolioBaseCurrencyCode`) but no rate is
 * present -- defensively reached only if `import-commit.ts`'s fail-closed
 * gate was somehow bypassed -- totals become genuinely unknown (never
 * guessed at 1:1, never left mislabelled as the security's currency
 * either: the record's own currency still displays as the row's TRUE
 * currency). BRK-010 review finding F3: the actual arithmetic is wrapped
 * in try/catch -- a malformed or over-precision stored rate (write-time
 * validation should already reject one, but this is defence-in-depth, and
 * a legacy/direct-DB-write row is not otherwise guarded) degrades ONLY
 * this one record's totals to unavailable, never throws and aborts the
 * whole security's dividend history.
 *
 * BRK-010 review round 2 finding B2 (product ruling, franking): franking
 * credits are an AU-tax construct; whether Sharesight denominates a
 * FOREIGN payout's franking fields in AUD or in the payout's own currency
 * is UNVERIFIED. For ANY foreign record (this function's very first
 * branch above already excludes native ones) whose `totalFrankingDecimal`
 * is genuinely NONZERO, this function nulls it out (marks it unknown) --
 * NEVER converts it, NEVER trusts it as-stored -- independently of whether
 * the cash figure above is achievable (case B) or not (case C). A
 * zero/absent franking total (the overwhelmingly common shape for a
 * foreign-currency dividend, which is typically unfranked) is left
 * completely unaffected.
 */
// BRK-010 review round 2 finding B2: `true` only for a genuinely present,
// non-zero decimal string -- mirrors `domain/sharesight-sync/transform.ts`'s
// identical `isNonZeroDecimal` (duplicated rather than shared, matching
// this module's own established pattern of re-deriving small primitives
// rather than depending across that boundary). Malformed input degrades to
// `false` defensively.
function isNonZeroStoredDecimal(value: string | null): boolean {
  if (value === null) return false;
  try {
    return !isZero(parseDecimal(value));
  } catch {
    return false;
  }
}

/**
 * BUG-021: does `domain/calculations/decimal.ts`'s own `parseDecimal`
 * accept this stored decimal string? Delegates to the EXACT function every
 * consumer of a `dividend_manual_records` amount column re-parses it with
 * (`computeCashGrossOrTotals` below; `history-row-derivation.ts`'s
 * `deriveHistoryRowDps`/`deriveHistoryRowFrankingPerShare`) rather than
 * re-checking `DECIMAL_LIMITS.inputDigits`/`inputScale` a second time -- the
 * READ-path mirror of `db/repositories/dividends.ts`'s write-time
 * `isWithinReadPathDecimalBounds`, which references those SAME
 * `DECIMAL_LIMITS` constants for the identical reason: this bound must
 * never drift away from the parse it exists to protect. Catches both an
 * over-bound value (more digits than `DECIMAL_LIMITS.inputDigits`, or more
 * fractional places than `DECIMAL_LIMITS.inputScale`) AND a non-canonical
 * one (a stray trailing space, a leading zero, "-0", ...) -- `parseDecimal`'s
 * own format check already rejects the latter, so there is no separate
 * canonical-form rule to keep in sync here.
 */
export function isReadableStoredDecimal(value: string): boolean {
  try {
    parseDecimal(value);
    return true;
  } catch {
    return false;
  }
}

type UnreadableFieldMarker =
  "totalCash" | "totalFranking" | "shares" | "perShare" | "frankingPerShare";

function sanitizeStoredAmount(
  value: string | null,
  fieldName: string,
  marker: UnreadableFieldMarker,
  unreadableFieldNames: string[],
  unreadableFields: Set<UnreadableFieldMarker>,
): string | null {
  if (value === null) return null;
  if (isReadableStoredDecimal(value)) return value;
  unreadableFieldNames.push(fieldName);
  unreadableFields.add(marker);
  return null;
}

/**
 * BUG-021: per-record isolation for a stored `dividend_manual_records`
 * amount this module's downstream arithmetic cannot parse -- mirrors
 * `resolveImportedRecordCurrency`'s BRK-010 F3 precedent (a malformed FX
 * rate degrades only ITS OWN record's conversion, never aborts the whole
 * security's derivation) for the read-path amount columns BUG-014 only
 * closed at the WRITE boundary. A value written before that fix (or by any
 * direct-DB path BUG-014 does not gate -- BUG-022 tracks closing every
 * writer) would otherwise reach `computeCashGrossOrTotals`'s/
 * `deriveHistoryRowDps`'s own `parseDecimal` calls raw and THROW, aborting
 * `deriveDividendHistoryForSecurity` for EVERY event/record of the whole
 * security (see this module's header note).
 *
 * Runs as the VERY FIRST thing `deriveDividendHistoryForSecurity` does to
 * `input.manualRecords`, before the owner/imported tier split and every
 * other pre-pass (`applyFrankingCurrencyOverride`,
 * `resolveImportedRecordCurrency`, `deriveAbsentImportedFranking`) -- every
 * downstream consumer of a manual record (tier matching, `resolveOwnerFact`,
 * `computeCashGrossOrTotals`) therefore only ever sees an already-validated
 * (or already-nulled) amount, never a raw corrupt one. This matters even
 * for a NATIVE-currency record: `resolveImportedRecordCurrency`'s very
 * first branch returns a same-currency record UNCHANGED (there is no FX
 * question), so it never validates `totalCashDecimal` either -- isolation
 * has to happen here, upstream of that function, not inside it.
 *
 * Never fabricates "0": an unreadable field becomes `null` (this module's
 * existing "genuinely unknown" representation, which `amountUnknown`
 * already surfaces and every aggregation/projection already excludes from
 * its sums), `amountUnreadable` is set alongside it so a consumer can render
 * the DISTINCT "needs correction" copy rather than the generic missing-data
 * label a plain absent value gets, and -- correction round, F1 -- the
 * per-field `unreadableFields` marker records WHICH column(s) were nulled
 * this way, so a null value this pre-pass produced can never be mistaken
 * for a genuinely blank one by a downstream consumer that must tell the two
 * apart (`deriveAbsentImportedFranking`'s DIV-007 zero inference,
 * `resolveImportedRecordCurrency`'s B2 guard): both read `unreadableFields`
 * instead of re-deriving readability from a value that is already `null`.
 * `frankingOverrideTotalDecimal` (BRK-011, unbounded at its own writers) is
 * sanitized in this SAME pass, under the same `"totalFranking"` marker as
 * `totalFrankingDecimal` -- `applyFrankingCurrencyOverride` runs immediately
 * after this pre-pass and would otherwise hand an unreadable override
 * straight to `parseDecimal` downstream; nulling it here makes that function
 * treat the record as having no override at all, which is the correct,
 * conservative fallback (never a fabricated zero, never a throw). Emits
 * exactly ONE structured warning per affected record, naming the record id
 * and which column(s) failed to parse -- never the value itself (AGENTS.md:
 * keep financial values out of logs).
 */
function sanitizeManualRecordAmounts(
  record: DividendManualRecordFact,
): DividendManualRecordFact {
  const unreadableFieldNames: string[] = [];
  const unreadableFields = new Set<UnreadableFieldMarker>();
  const sharesDecimal = sanitizeStoredAmount(
    record.sharesDecimal,
    "sharesDecimal",
    "shares",
    unreadableFieldNames,
    unreadableFields,
  );
  const dividendPerShareDecimal = sanitizeStoredAmount(
    record.dividendPerShareDecimal,
    "dividendPerShareDecimal",
    "perShare",
    unreadableFieldNames,
    unreadableFields,
  );
  const frankingCreditPerShareDecimal = sanitizeStoredAmount(
    record.frankingCreditPerShareDecimal,
    "frankingCreditPerShareDecimal",
    "frankingPerShare",
    unreadableFieldNames,
    unreadableFields,
  );
  const totalCashDecimal = sanitizeStoredAmount(
    record.totalCashDecimal ?? null,
    "totalCashDecimal",
    "totalCash",
    unreadableFieldNames,
    unreadableFields,
  );
  const totalFrankingDecimal = sanitizeStoredAmount(
    record.totalFrankingDecimal ?? null,
    "totalFrankingDecimal",
    "totalFranking",
    unreadableFieldNames,
    unreadableFields,
  );
  const frankingOverrideTotalDecimal = sanitizeStoredAmount(
    record.frankingOverrideTotalDecimal ?? null,
    "frankingOverrideTotalDecimal",
    "totalFranking",
    unreadableFieldNames,
    unreadableFields,
  );
  if (unreadableFieldNames.length === 0) return record;
  console.warn("dividend_manual_records amount unreadable", {
    recordId: record.id,
    fields: unreadableFieldNames,
  });
  return {
    ...record,
    sharesDecimal,
    dividendPerShareDecimal,
    frankingCreditPerShareDecimal,
    totalCashDecimal,
    totalFrankingDecimal,
    frankingOverrideTotalDecimal,
    amountUnreadable: true,
    unreadableFields,
  };
}

/**
 * BRK-011 tier 3 (owner-entered conversion, the only tier this task's live
 * evidence lets it implement -- see `DividendManualRecordFact.frankingCurrencySource`'s
 * doc comment): applied as the VERY FIRST step of the imported-tier
 * pipeline, before `resolveImportedRecordCurrency`'s unverified-nonzero-
 * foreign guard or `deriveAbsentImportedFranking`'s absent-value inference
 * ever run, so the owner's deliberate figure is never re-nulled by either.
 * A record with no override (`frankingOverrideTotalDecimal` absent/null) is
 * returned completely unchanged -- every pre-BRK-011 fixture/caller keeps
 * behaving byte-identically.
 */
function applyFrankingCurrencyOverride(
  record: DividendManualRecordFact,
): DividendManualRecordFact {
  const overrideTotal = record.frankingOverrideTotalDecimal ?? null;
  if (overrideTotal === null) return record;
  return {
    ...record,
    totalFrankingDecimal: overrideTotal,
    frankingCurrencySource: "owner_manual",
  };
}

function resolveImportedRecordCurrency(
  record: DividendManualRecordFact,
  securityCurrencyCode: string,
  portfolioBaseCurrencyCode: string,
): DividendManualRecordFact {
  const recordCurrency = record.currencyCode ?? null;
  if (recordCurrency === null || recordCurrency === securityCurrencyCode) {
    return record; // Case A: native -- no FX question of any kind.
  }

  // BRK-010 review round 2 finding B2 (product ruling): franking credits
  // are an AU-tax construct; whether Sharesight denominates a FOREIGN
  // payout's franking fields in AUD or in the payout's own currency is an
  // UNVERIFIED ASSUMPTION this codebase will not resolve by inspecting real
  // tax amounts. A NONZERO franking total on a foreign record is therefore
  // NEVER trusted as-stored and NEVER converted -- it becomes unknown
  // (`null`), regardless of whether the CASH conversion below succeeds
  // (case B) or degrades (case C, below). A zero/absent franking total --
  // the overwhelmingly common shape, since foreign-currency dividends are
  // typically unfranked -- is left completely unaffected either way.
  //
  // BRK-011: this guard is SUPPRESSED when `applyFrankingCurrencyOverride`
  // already applied an owner-entered figure (`frankingCurrencySource ===
  // "owner_manual"`) -- the owner's deliberate conversion IS the trusted
  // resolution of exactly the uncertainty this guard exists to protect
  // against, so it must never re-null the value it just set.
  const rawTotalFranking = record.totalFrankingDecimal ?? null;
  const frankingOverridden = record.frankingCurrencySource === "owner_manual";
  const frankingUnverified =
    !frankingOverridden && isNonZeroStoredDecimal(rawTotalFranking);
  const totalFrankingDecimal = frankingUnverified ? null : rawTotalFranking;

  if (securityCurrencyCode !== portfolioBaseCurrencyCode) {
    // Case C: cash conversion not achievable -- see this function's own
    // doc comment above for the full three-case model. The franking fix
    // above still applies regardless.
    return { ...record, totalFrankingDecimal };
  }
  const rate = record.fxRateToPortfolioDecimal ?? null;
  if (rate === null) {
    return { ...record, totalCashDecimal: null, totalFrankingDecimal: null };
  }
  // BUG-021 correction round (F1's B2 fold-in): `sanitizeManualRecordAmounts`
  // has already nulled an unreadable stored `totalCashDecimal` UPSTREAM of
  // this function, so the ternary below would see `null` and take its
  // "genuinely absent" branch -- skipping `convertDecimalToSecurityCurrency`
  // entirely and returning through the SUCCESS path with
  // `convertedToSecurityCurrency: true`, even though nothing was actually
  // converted. Before that pre-pass existed, the raw unreadable string
  // reached `convertDecimalToSecurityCurrency` and threw, landing in the F3
  // catch block below (cash+franking nulled, no conversion flag set) -- the
  // conservative, "cannot verify" outcome the B2 guard is named for. This
  // check reproduces that exact outcome for the now-pre-nulled case, rather
  // than silently upgrading an unreadable value to "verified converted".
  if (record.unreadableFields?.has("totalCash")) {
    return { ...record, totalCashDecimal: null, totalFrankingDecimal: null };
  }
  const totalCashDecimal = record.totalCashDecimal ?? null;
  try {
    return {
      ...record,
      totalCashDecimal:
        totalCashDecimal !== null
          ? convertDecimalToSecurityCurrency(totalCashDecimal, rate)
          : null,
      // Franking is NEVER converted (B2) -- either already nulled above
      // (unverified/nonzero) or passed through as the trusted zero/absent
      // value; `convertDecimalToSecurityCurrency` is never called on it.
      totalFrankingDecimal,
      convertedToSecurityCurrency: true,
    };
  } catch {
    // F3: never let one malformed rate abort the whole derivation.
    return { ...record, totalCashDecimal: null, totalFrankingDecimal: null };
  }
}

/**
 * DIV-007 (owner ruling 2026-08-20, "zero if zero"): investigation of the
 * owner's real local-DB data (documented in `TASKS.md`) found Sharesight
 * sends an EXPLICIT `franking_credits: 0` for unfranked AUD (native-
 * currency) payouts (48 confirmed) and positive values for franked ones
 * (60), but OMITS the franking field entirely -- stored `totalFrankingDecimal:
 * null` -- on every one of the owner's 10 USD (foreign-currency) payouts.
 * The stored fact stays exactly what Sharesight sent (never rewritten --
 * "null = Sharesight said nothing"); this function only affects the
 * DERIVED row: a genuinely ABSENT franking total on an imported (Sharesight)
 * totals-mode fact is treated as $0 franking REPORTED, an inference from
 * Sharesight's own demonstrated explicit-zero behaviour on native payouts
 * (documented as an inference, not an observed tax fact, in
 * `docs/CALCULATIONS.md` section 11) -- `frankingDerivedZero` marks the
 * inference so the UI can label it distinctly from a real Sharesight-
 * supplied zero ("none reported" vs a reported figure).
 *
 * Scope, precisely:
 * - Only ever called over the `importedRecords` array (this module's
 *   `importBatchId !== null` tier) -- an owner-typed manual record never
 *   reaches this function at all, so its own null franking keeps the
 *   existing "unknown" semantics untouched (the owner may simply not have
 *   entered it, which is a different fact than "Sharesight sent nothing").
 * - Only fires for a totals-mode fact (`totalCashDecimal !== null` on the
 *   ORIGINAL, pre-conversion record) -- the imported tier is the only one
 *   that can ever carry a totals-mode fact at all (see
 *   `DividendManualRecordFact`'s header note); a hypothetical per-share
 *   imported fact never reaches this branch.
 * - Only fires when the RAW stored `totalFrankingDecimal` was `null`
 *   (checked on `original`, before `resolveImportedRecordCurrency` ran) --
 *   NOT when it was genuinely present but NULLED BY THE BRK-010 UNVERIFIED-
 *   NONZERO-FOREIGN GUARD (`resolveImportedRecordCurrency`'s B2 rule, left
 *   completely untouched by this function): that guard's null means
 *   "Sharesight told us something we do not trust", the exact opposite of
 *   "absent". A raw explicit "0" (native or foreign) is already `!== null`
 *   and never reaches this branch either -- it already displays correctly
 *   as a real reported zero, with `frankingDerivedZero` staying `false`.
 * - Only fires when the fact's CASH conversion did not itself fail closed
 *   (`converted.totalCashDecimal !== null`) -- a record whose currency
 *   conversion could not be completed (missing/malformed rate) stays fully
 *   unknown rather than surfacing a lone derived $0 franking figure next to
 *   an unavailable cash amount.
 * - CORRECTION ROUND (F1, BLOCKING): "the RAW stored `totalFrankingDecimal`
 *   was `null`" above is ambiguous between "Sharesight genuinely sent
 *   nothing" and "`sanitizeManualRecordAmounts` nulled an UNREADABLE stored
 *   value (or an unreadable owner override) before this function ever ran" --
 *   the two are byte-identical (`null`) by the time this function sees them.
 *   Treating the latter as "absent" fabricated a KNOWN "$0.00 (none
 *   reported)" for a tax figure this module could not actually read, which
 *   flowed uncaught into FY/lifetime franking sums -- exactly the fabricated
 *   zero this module's header claims never to produce. `original.unreadableFields`
 *   (set by `sanitizeManualRecordAmounts`, preserved unchanged through
 *   `applyFrankingCurrencyOverride`) now disambiguates the two: an
 *   unreadable total/override short-circuits BEFORE the absent-value branch
 *   below and is marked `frankingUnreadable: true` instead -- never a
 *   derived zero, never a silent plain "Unknown" either, so the row can
 *   render actionable "needs correction" copy. A record whose override WAS
 *   readable and applied still reaches the absent-value branch normally (its
 *   `converted.totalFrankingDecimal` is the override value, not `null`, so
 *   the `unreadable` short-circuit's own null check does not fire for it).
 */
function deriveAbsentImportedFranking(
  original: DividendManualRecordFact,
  converted: DividendManualRecordFact,
): DividendManualRecordFact {
  const totalFrankingUnreadable =
    original.unreadableFields?.has("totalFranking") === true;
  if (
    totalFrankingUnreadable &&
    (converted.totalFrankingDecimal ?? null) === null
  ) {
    return { ...converted, frankingUnreadable: true };
  }
  const isTotalsMode = (original.totalCashDecimal ?? null) !== null;
  const rawTotalFrankingAbsent =
    (original.totalFrankingDecimal ?? null) === null;
  if (
    isTotalsMode &&
    rawTotalFrankingAbsent &&
    converted.totalCashDecimal !== null &&
    (converted.totalFrankingDecimal ?? null) === null
  ) {
    return {
      ...converted,
      totalFrankingDecimal: "0",
      frankingDerivedZero: true,
    };
  }
  return converted;
}

/**
 * BRK-010 review finding B4/F2: the row-level currency signal an
 * "imported" tier fact contributes -- `currencyCodeOverride` is the row's
 * TRUE currency when the fact's totals were NEVER converted into the
 * security's own currency (native already, so no override needed -- `null`
 * -- or genuinely foreign and degraded, in which case the override IS the
 * record's own currency, never silently defaulted to the security's);
 * `originalCurrencyCode`/`fxRateToPortfolioDecimal`/`fxRateSource` are the
 * PROVENANCE trio, populated only when a conversion actually occurred (F2).
 * Exactly one of the two is ever non-null for a genuinely foreign fact.
 */
function importedFactCurrencyDisplay(record: DividendManualRecordFact): {
  currencyCodeOverride: string | null;
  originalCurrencyCode: string | null;
  fxRateToPortfolioDecimal: string | null;
  fxRateSource: string | null;
} {
  const recordCurrency = record.currencyCode ?? null;
  if (record.convertedToSecurityCurrency === true) {
    return {
      currencyCodeOverride: null,
      originalCurrencyCode: recordCurrency,
      fxRateToPortfolioDecimal: record.fxRateToPortfolioDecimal ?? null,
      fxRateSource: record.fxRateSource ?? null,
    };
  }
  return {
    currencyCodeOverride: recordCurrency,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
  };
}

/**
 * GLOBAL nearest-wins proximity matching (B4 fix, replacing an earlier
 * per-event-greedy pass that could mis-assign a manual record to a nearby
 * but not-actually-closest event when two events compete for it -- e.g. an
 * interim and a special dividend a few days apart). Builds every candidate
 * (event, manual record) pair within `PROXIMITY_WINDOW_DAYS` days, sorts ALL
 * pairs by ascending distance with a fully deterministic tie-break
 * (distance, then the event's own reference date, then event id, then
 * manual-record id), and assigns greedily in that global order -- the
 * globally closest pair wins first, consuming both sides, before any
 * farther pair is considered. This matches `docs/CALCULATIONS.md`'s
 * "nearest match wins" text literally rather than only within one event's
 * local neighbourhood.
 *
 * DIV-004 reuses this UNCHANGED for the imported tier: called once with the
 * owner-typed subset of `manualRecords` (tier 2) and once with the imported
 * subset (tier 4), against the same `candidateEvents`. Each call assigns
 * independently, so an event can simultaneously have an owner-manual match
 * AND an imported match -- precedence between them is resolved afterward by
 * `resolveOwnerFact`, not here.
 */
function matchManualRecordsGlobally(
  candidateEvents: readonly {
    event: ProviderDividendEventFact;
    referenceDate: string;
  }[],
  manualRecords: readonly DividendManualRecordFact[],
): Map<string, DividendManualRecordFact> {
  type Pair = {
    eventId: string;
    referenceDate: string;
    record: DividendManualRecordFact;
    diff: number;
  };
  const pairs: Pair[] = [];
  for (const { event, referenceDate } of candidateEvents) {
    for (const record of manualRecords) {
      const diff = Math.abs(daysBetween(referenceDate, record.paymentDate));
      if (diff <= PROXIMITY_WINDOW_DAYS) {
        pairs.push({ eventId: event.id, referenceDate, record, diff });
      }
    }
  }
  pairs.sort(
    (left, right) =>
      left.diff - right.diff ||
      left.referenceDate.localeCompare(right.referenceDate) ||
      left.eventId.localeCompare(right.eventId) ||
      left.record.id.localeCompare(right.record.id),
  );
  const usedEvents = new Set<string>();
  const usedRecords = new Set<string>();
  const matches = new Map<string, DividendManualRecordFact>();
  for (const pair of pairs) {
    if (usedEvents.has(pair.eventId) || usedRecords.has(pair.record.id)) {
      continue;
    }
    matches.set(pair.eventId, pair.record);
    usedEvents.add(pair.eventId);
    usedRecords.add(pair.record.id);
  }
  return matches;
}

function toDominatedReceipt(receipt: DividendReceiptFact): DominatedReceipt {
  return {
    sharesDecimal: receipt.sharesDecimal,
    dividendPerShareDecimal: receipt.dividendPerShareDecimal,
    frankingPerShareDecimal: receipt.frankingPerShareDecimal,
    paymentDate: receipt.paymentDate,
  };
}

function toDominatedImported(
  record: DividendManualRecordFact,
): DominatedImported {
  // BRK-010 review finding F2: provenance fields are set ONLY when a
  // conversion actually occurred -- see `DividendManualRecordFact.convertedToSecurityCurrency`'s
  // doc comment.
  const converted = record.convertedToSecurityCurrency === true;
  return {
    sharesDecimal: record.sharesDecimal,
    dividendPerShareDecimal: record.dividendPerShareDecimal,
    frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
    totalCashDecimal: record.totalCashDecimal ?? null,
    totalFrankingDecimal: record.totalFrankingDecimal ?? null,
    paymentDate: record.paymentDate,
    currencyCode: converted ? (record.currencyCode ?? null) : null,
    fxRateToPortfolioDecimal: converted
      ? (record.fxRateToPortfolioDecimal ?? null)
      : null,
    fxRateSource: converted ? (record.fxRateSource ?? null) : null,
    frankingDerivedZero: record.frankingDerivedZero === true,
    frankingCurrencySource: record.frankingCurrencySource ?? null,
  };
}

/**
 * DIV-004: the STANDALONE half of imported/owner-fact cross-tier proximity
 * dedupe. Once event-anchored matching is done, some owner-typed manual
 * records and some receipts remain unmatched to any event (they become
 * their own standalone rows below), and separately some imported rows
 * remain unmatched to any event too. Without this pass, an imported row
 * whose real-world dividend the owner ALSO typed manually (or that a
 * receipt ALSO recorded) -- but where neither one lines up with a provider
 * event -- would incorrectly surface as a second, duplicate standalone row.
 * There is no common event to anchor the comparison to here, so this
 * matches directly on payment date using the identical GLOBAL nearest-wins
 * algorithm as `matchManualRecordsGlobally` (candidates are owner-manual
 * records keyed `manual:<id>` and receipts keyed `receipt:<id>`, unified
 * into one candidate pool so an imported row competes fairly for whichever
 * owner fact -- manual or receipt -- it is actually closest to).
 */
function matchStandaloneOwnerFactsToImported(
  ownerFactCandidates: readonly { key: string; referenceDate: string }[],
  importedRecords: readonly DividendManualRecordFact[],
): Map<string, DividendManualRecordFact> {
  type Pair = {
    key: string;
    referenceDate: string;
    record: DividendManualRecordFact;
    diff: number;
  };
  const pairs: Pair[] = [];
  for (const candidate of ownerFactCandidates) {
    for (const record of importedRecords) {
      const diff = Math.abs(
        daysBetween(candidate.referenceDate, record.paymentDate),
      );
      if (diff <= PROXIMITY_WINDOW_DAYS) {
        pairs.push({
          key: candidate.key,
          referenceDate: candidate.referenceDate,
          record,
          diff,
        });
      }
    }
  }
  pairs.sort(
    (left, right) =>
      left.diff - right.diff ||
      left.referenceDate.localeCompare(right.referenceDate) ||
      left.key.localeCompare(right.key) ||
      left.record.id.localeCompare(right.record.id),
  );
  const usedKeys = new Set<string>();
  const usedRecords = new Set<string>();
  const matches = new Map<string, DividendManualRecordFact>();
  for (const pair of pairs) {
    if (usedKeys.has(pair.key) || usedRecords.has(pair.record.id)) continue;
    matches.set(pair.key, pair.record);
    usedKeys.add(pair.key);
    usedRecords.add(pair.record.id);
  }
  return matches;
}

export function deriveDividendHistoryForSecurity(
  input: DeriveDividendHistoryInput,
): DerivedDividendRow[] {
  const activeEvents = input.events.filter(
    (event) =>
      event.status !== "superseded" &&
      event.status !== "cancelled" &&
      event.status !== "estimated" &&
      event.exDate !== null,
  );
  const eventById = new Map(input.events.map((event) => [event.id, event]));

  const overrideByEvent = new Map<string, EventOverrideFact | null>();
  for (const event of activeEvents) {
    overrideByEvent.set(
      event.id,
      resolveEventOverrideForLineage(input.events, event.id, input.overrides),
    );
  }
  const excludedEventIds = new Set(
    activeEvents
      .filter((event) => overrideByEvent.get(event.id)?.exclude)
      .map((event) => event.id),
  );

  // Reverse index: which ACTIVE event's lineage does each raw event id
  // belong to (used to classify every receipt below), the first (closest)
  // active event walking its own lineage wins -- lineages are disjoint
  // trees per security's history, so this is unambiguous in practice.
  const eventIdToActiveEventId = new Map<string, string>();
  for (const event of activeEvents) {
    for (const id of collectEventLineageIds(input.events, event.id)) {
      if (!eventIdToActiveEventId.has(id)) {
        eventIdToActiveEventId.set(id, event.id);
      }
    }
  }

  // Classify every receipt: claimed by a live active event (feeds either
  // the normal per-event tier resolution below, when that event has no
  // override, OR the excluded-event resurfacing pass, when that event's
  // override is an exclusion); dominated by a non-excluded override
  // (intentionally dropped -- the owner's edit supersedes it); or a true
  // ORPHAN -- no active event's lineage claims it at all (its event is
  // cancelled, missing an ex-date, or otherwise never reached
  // `activeEvents`). Only orphans go straight to `resurfacedReceipts`; a
  // receipt attached to an EXCLUDED event is tracked in
  // `receiptsByActiveEvent` like any other so the resurfacing pass below
  // can dedupe it against a manual record attached to the SAME event
  // (review round 3 fix -- see the module header).
  //
  // Reviewer's cancelled-reissue note (round 2): no current provider
  // (Yahoo-compatible) ever writes `status = 'cancelled'` -- this whole
  // orphan path is exercised today only by defensive/malformed input or a
  // future provider capability. Documented as intentional now so a later
  // provider that DOES reissue a cancelled event's dividend under a new id
  // does not need to rediscover this: a receipt against the cancelled id
  // resurfaces standalone rather than silently vanishing, exactly like any
  // other orphan.
  const receiptsByActiveEvent = new Map<string, DividendReceiptFact[]>();
  const resurfacedReceipts: DividendReceiptFact[] = [];
  for (const receipt of input.receipts) {
    const claimingId = eventIdToActiveEventId.get(receipt.dividendEventId);
    if (claimingId === undefined) {
      resurfacedReceipts.push(receipt);
      continue;
    }
    const claimingOverride = overrideByEvent.get(claimingId);
    if (claimingOverride && !claimingOverride.exclude) continue; // dominated by a non-excluded override
    const list = receiptsByActiveEvent.get(claimingId) ?? [];
    list.push(receipt);
    receiptsByActiveEvent.set(claimingId, list);
  }
  function resolveReceipts(
    eventId: string,
  ): { latest: DividendReceiptFact; additionalCount: number } | null {
    const candidates = receiptsByActiveEvent.get(eventId);
    if (!candidates || candidates.length === 0) return null;
    const sorted = [...candidates].sort(
      (left, right) =>
        right.paymentDate.localeCompare(left.paymentDate) ||
        right.id.localeCompare(left.id),
    );
    return { latest: sorted[0]!, additionalCount: sorted.length - 1 };
  }

  // BUG-021: isolate any unreadable stored amount BEFORE anything else in
  // this function ever looks at `input.manualRecords` -- see
  // `sanitizeManualRecordAmounts`'s doc comment for why this must run
  // first, ahead of even the tier split immediately below.
  const sanitizedManualRecords = input.manualRecords.map((record) =>
    sanitizeManualRecordAmounts(record),
  );

  // DIV-004: split `dividend_manual_records` rows by `importBatchId` into
  // the owner-typed tier (2) and the imported tier (4) BEFORE any matching
  // happens, so the two tiers are matched to events independently and can
  // never be confused with each other downstream. BRK-022 slice 3: a
  // `sharesight_pending_payouts` announcement (`announcedUnpaid: true`)
  // never went through a CSV import batch (`importBatchId` stays `null`,
  // honestly), but it is still provider evidence the owner never personally
  // typed -- DIV-004's exact rationale for the imported tier -- so it is
  // routed there by this second condition rather than by `importBatchId`.
  const ownerManualRecords = sanitizedManualRecords.filter(
    (record) =>
      record.importBatchId === null && record.announcedUnpaid !== true,
  );
  // BRK-010 review finding B4: attempt to convert every imported
  // (Sharesight-derived) fact's totals into the security's own currency
  // BEFORE any matching/collapsing logic below runs -- ONLY WHEN that
  // conversion is actually achievable (`securityCurrencyCode ===
  // portfolioBaseCurrencyCode`; see `resolveImportedRecordCurrency`'s doc
  // comment for the full three-case model). A fact left unconverted
  // (native already, or genuinely not achievable) keeps its OWN recorded
  // currency, so `importedFactCurrencyDisplay` below can surface it
  // honestly at row-construction time rather than the rest of this module
  // silently assuming every imported fact is already security-native.
  const importedRecords = sanitizedManualRecords
    .filter(
      (record) =>
        record.importBatchId !== null || record.announcedUnpaid === true,
    )
    .map((record) => applyFrankingCurrencyOverride(record))
    .map((record) =>
      deriveAbsentImportedFranking(
        record,
        resolveImportedRecordCurrency(
          record,
          input.securityCurrencyCode,
          input.portfolioBaseCurrencyCode ?? input.securityCurrencyCode,
        ),
      ),
    );
  const candidateEvents = activeEvents.map((event) => ({
    event,
    referenceDate: event.paymentDate ?? event.exDate!,
  }));

  // Manual matching runs against EVERY active event, INCLUDING excluded
  // ones (review round 3 fix): a genuinely nearby manual record must still
  // attach to an excluded event so the resurfacing pass below can dedupe
  // it against any receipt on that same event, rather than the manual
  // record falling through to the fully-standalone loop and producing a
  // SECOND row alongside the resurfaced receipt for one real dividend. It
  // also still runs against non-excluded override-present events, so a
  // manual record duplicating an edited-but-not-excluded event is
  // correctly suppressed from becoming a spurious standalone row (the
  // override still wins that row; the manual record is just recognised as
  // the same real-world dividend and not shown twice).
  const manualMatches = matchManualRecordsGlobally(
    candidateEvents,
    ownerManualRecords,
  );
  const consumedOwnerManualIds = new Set(
    [...manualMatches.values()].map((record) => record.id),
  );

  // DIV-004: the imported tier is matched against the SAME candidate events
  // using the identical mechanism, independently of the owner-manual match
  // above -- an event can carry both an owner-manual match AND an imported
  // match at once; `resolveOwnerFact` below decides which one (if either)
  // wins the row and which becomes `dominatedImported`/`dominatedReceipt`.
  const importedEventMatches = matchManualRecordsGlobally(
    candidateEvents,
    importedRecords,
  );
  const consumedImportedEventIds = new Set(
    [...importedEventMatches.values()].map((record) => record.id),
  );

  /**
   * Shared four-way precedence (manual > receipt > imported, B5 extended by
   * DIV-004: the winning fact's row consumes every lower-tier fact matched
   * to the same event, keeping their values visible via `dominatedReceipt`/
   * `dominatedImported` rather than silently dropping them) -- used both by
   * the main per-event loop (non-excluded events) and the excluded-event
   * resurfacing pass, so the two paths cannot drift apart the way round 2's
   * independent implementations did.
   */
  function resolveOwnerFact(
    manual: DividendManualRecordFact | null,
    receiptResolution: {
      latest: DividendReceiptFact;
      additionalCount: number;
    } | null,
    imported: DividendManualRecordFact | null,
  ): {
    source: "manual" | "receipt" | "imported";
    sharesDecimal: string | null;
    dividendPerShareDecimal: string | null;
    overrideFrankingPerShare: string | null;
    // BRK-005: non-null only when `source === "imported"` AND the winning
    // fact is a Sharesight payout's totals-mode row -- manual/receipt facts
    // never carry totals (see `DividendManualRecordFact`'s header note).
    totalCashDecimal: string | null;
    totalFrankingDecimal: string | null;
    paymentDate: string;
    dominatedReceipt: DominatedReceipt | null;
    dominatedImported: DominatedImported | null;
    additionalReceiptsCount: number;
    // BRK-010: non-null only when `source === "imported"` -- see
    // `importedFactCurrencyDisplay`'s doc comment for the
    // override-vs-provenance split.
    currencyCodeOverride: string | null;
    originalCurrencyCode: string | null;
    fxRateToPortfolioDecimal: string | null;
    fxRateSource: string | null;
    // DIV-007: non-null only meaningfully `true` when `source === "imported"`
    // -- see `DerivedDividendRow.frankingDerivedZero`'s doc comment.
    frankingDerivedZero: boolean;
    // BRK-011: non-null only when `source === "imported"` -- see
    // `DerivedDividendRow.frankingCurrencySource`'s doc comment.
    frankingCurrencySource: "owner_manual" | null;
    // BUG-021: mirrors `DividendManualRecordFact.amountUnreadable` for the
    // winning fact -- see that field's doc comment. Always `false` for a
    // receipt (this module never sanitizes `dividend_receipts`; out of
    // BUG-021's scope, which is `dividend_manual_records` only).
    amountUnreadable: boolean;
    // BUG-021 correction round: mirrors `DerivedDividendRow.frankingUnreadable`
    // for the winning fact -- see that field's doc comment. Always `false`
    // for a receipt, matching `amountUnreadable`'s convention above.
    frankingUnreadable: boolean;
    // BUG-023: `true` exactly when the winning fact's OWN per-share
    // franking credit (`frankingCreditPerShareDecimal`, marked
    // `"frankingPerShare"` by `sanitizeManualRecordAmounts`) could not be
    // read. Named separately from `frankingUnreadable` above -- that field
    // only ever tracks an unreadable TOTAL (`totalFrankingDecimal`/
    // `frankingOverrideTotalDecimal`, the `"totalFranking"` marker), which
    // is a distinct stored column from this one. `overrideFrankingPerShare`
    // above is already `null` in this case (nulled by the same pre-pass),
    // which is indistinguishable from "no per-share credit was ever
    // entered" to `resolveFrankingPerShare` -- without this flag, its
    // default-percent tier would silently substitute the security's
    // "franking if not known" assumption for a value that in fact exists
    // but could not be read, exactly the fabricated-known-from-corrupt
    // pattern BUG-021 closed for the total. Always `false` for a receipt
    // (never sanitized) and for a manual/imported fact with no unreadable
    // per-share field.
    frankingPerShareUnreadable: boolean;
    // BRK-022 slice 3: mirrors `DerivedDividendRow.announcedUnpaid` -- `true`
    // exactly when `source === "imported"` AND the winning fact is a
    // Sharesight pending-payout announcement. Always `false` for the manual
    // and receipt branches (neither tier can ever carry the flag).
    announcedUnpaid: boolean;
  } | null {
    if (manual) {
      return {
        source: "manual",
        sharesDecimal: manual.sharesDecimal,
        dividendPerShareDecimal: manual.dividendPerShareDecimal,
        overrideFrankingPerShare: manual.frankingCreditPerShareDecimal,
        // DIV-016 part A: an owner-typed record can now be a BRK-005
        // totals-mode fact too (previously only the "imported" tier ever
        // carried one -- see this module's header note and
        // `DividendManualRecordFact`'s doc comment, both corrected by this
        // change). Read through generically exactly like the "imported"
        // branch below, so a totals-mode owner entry renders its real
        // cash/franking total instead of reading as "Unknown".
        totalCashDecimal: manual.totalCashDecimal ?? null,
        totalFrankingDecimal: manual.totalFrankingDecimal ?? null,
        paymentDate: manual.paymentDate,
        dominatedReceipt: receiptResolution
          ? toDominatedReceipt(receiptResolution.latest)
          : null,
        dominatedImported: imported ? toDominatedImported(imported) : null,
        additionalReceiptsCount: receiptResolution?.additionalCount ?? 0,
        currencyCodeOverride: null,
        originalCurrencyCode: null,
        fxRateToPortfolioDecimal: null,
        fxRateSource: null,
        frankingDerivedZero: false,
        frankingCurrencySource: null,
        amountUnreadable: manual.amountUnreadable === true,
        // BUG-021 correction round: an owner-typed record never goes
        // through `deriveAbsentImportedFranking` (imported tier only), so
        // its own `unreadableFields` (set directly by
        // `sanitizeManualRecordAmounts`) is read here instead -- an owner
        // manual record's `totalFrankingDecimal` is nulled by that same
        // pre-pass exactly like every other column, with no zero-inference
        // step in between to distinguish from.
        frankingUnreadable:
          manual.unreadableFields?.has("totalFranking") === true,
        // BUG-023: the per-share companion to the total check immediately
        // above -- `manual.frankingCreditPerShareDecimal` (already read as
        // `overrideFrankingPerShare` above) was nulled by the same
        // `"frankingPerShare"` marker when unreadable.
        frankingPerShareUnreadable:
          manual.unreadableFields?.has("frankingPerShare") === true,
        announcedUnpaid: false,
      };
    }
    if (receiptResolution) {
      return {
        source: "receipt",
        sharesDecimal: receiptResolution.latest.sharesDecimal,
        dividendPerShareDecimal:
          receiptResolution.latest.dividendPerShareDecimal,
        overrideFrankingPerShare:
          receiptResolution.latest.frankingPerShareDecimal,
        totalCashDecimal: null,
        totalFrankingDecimal: null,
        paymentDate: receiptResolution.latest.paymentDate,
        dominatedReceipt: null,
        dominatedImported: imported ? toDominatedImported(imported) : null,
        additionalReceiptsCount: receiptResolution.additionalCount,
        currencyCodeOverride: null,
        originalCurrencyCode: null,
        fxRateToPortfolioDecimal: null,
        fxRateSource: null,
        frankingDerivedZero: false,
        frankingCurrencySource: null,
        amountUnreadable: false,
        frankingUnreadable: false,
        frankingPerShareUnreadable: false,
        announcedUnpaid: false,
      };
    }
    if (imported) {
      const display = importedFactCurrencyDisplay(imported);
      return {
        source: "imported",
        sharesDecimal: imported.sharesDecimal,
        dividendPerShareDecimal: imported.dividendPerShareDecimal,
        overrideFrankingPerShare: imported.frankingCreditPerShareDecimal,
        totalCashDecimal: imported.totalCashDecimal ?? null,
        totalFrankingDecimal: imported.totalFrankingDecimal ?? null,
        paymentDate: imported.paymentDate,
        dominatedReceipt: null,
        dominatedImported: null,
        additionalReceiptsCount: 0,
        currencyCodeOverride: display.currencyCodeOverride,
        originalCurrencyCode: display.originalCurrencyCode,
        fxRateToPortfolioDecimal: display.fxRateToPortfolioDecimal,
        fxRateSource: display.fxRateSource,
        frankingDerivedZero: imported.frankingDerivedZero === true,
        frankingCurrencySource: imported.frankingCurrencySource ?? null,
        amountUnreadable: imported.amountUnreadable === true,
        frankingUnreadable: imported.frankingUnreadable === true,
        // BUG-023: mirrors the manual branch above -- an imported
        // per-share fact's own unreadable franking credit.
        frankingPerShareUnreadable:
          imported.unreadableFields?.has("frankingPerShare") === true,
        announcedUnpaid: imported.announcedUnpaid === true,
      };
    }
    return null;
  }

  // DIV-005: transitive proximity chaining. The precedence resolution above
  // (`resolveOwnerFact`) only ever compares a fact against an EVENT's own
  // reference date -- an owner-manual/receipt fact anchored to event E (tier
  // 2/3, within E's own window) and an imported row within THAT FACT's own
  // window but outside E's window never collapsed together (reviewer repro,
  // TASKS.md DIV-005: event pay 03-20, owner manual 03-27 (7 days, attaches
  // to E), imported 03-31 (4 days from the manual, 11 from E) -- produced two
  // rows, 240 counted vs 120 real). Fixed in two rounds below (ROUND A here;
  // ROUND B, the eventless multi-hop case, is below the main per-event
  // loop):
  //
  // ROUND A (single-hop, event-anchored): every event whose row is won by a
  // manual or receipt fact (main-loop and excluded-resurfacing alike, but
  // NEVER an event fully suppressed by a winning non-excluded override --
  // that fact's data is intentionally not shown at all per the existing
  // "override wins outright" tier-matrix test, so there is nothing to chain
  // from) becomes a "chain anchor" dated at the WINNING fact's own payment
  // date instead of the event's. Leftover imported rows (not already
  // directly matched to any event) compete for these anchors using the exact
  // same proven global nearest-wins, one-to-one algorithm as the standalone
  // pass below (`matchStandaloneOwnerFactsToImported`). Reusing a 1-1
  // algorithm here is what PREVENTS the multi-event over-merge case required
  // by DIV-005: two events can never be pulled into one row because a given
  // imported row can only ever win ONE anchor, never bridge two, and anchors
  // never compete with or connect to each other.
  //
  // Review round 1 BLOCKING fix (B1): an event that ALREADY has its own
  // DIRECT imported match (`importedEventMatches`, tier 4, whether it won the
  // row or was itself dominated by the winning manual/receipt) must NOT also
  // become a chain anchor. `chainAnchorDominatedImported` is a 1-1 map keyed
  // by event id -- a SECOND, more-distant imported row chaining onto the same
  // event would be silently swallowed by the `dominatedImported === null`
  // guard at the row-construction site below (the slot is already taken by
  // the direct match) rather than falling through to Round B/standalone,
  // deleting real money with no disclosure (reviewer repro: event with a
  // direct import AND a manual-bridged second import -- HEAD's 2 rows/$250
  // silently became 1 row/$120, the second import's $130 vanishing
  // entirely). Excluding such events from the anchor pool restores the
  // correct HEAD behaviour for the leftover imported row: it falls through
  // to Round B exactly as it did before this event ever had anything to
  // chain from.
  const chainAnchors: { key: string; referenceDate: string }[] = [];
  for (const event of activeEvents) {
    const override = overrideByEvent.get(event.id) ?? null;
    if (override && !override.exclude) continue; // fully suppressed by a winning override -- nothing to chain from
    if (importedEventMatches.get(event.id)) continue; // already has a direct imported match -- its dominatedImported slot is taken; nothing more to chain onto it
    const anchorOwnerFact = resolveOwnerFact(
      manualMatches.get(event.id) ?? null,
      resolveReceipts(event.id),
      importedEventMatches.get(event.id) ?? null,
    );
    if (
      anchorOwnerFact &&
      (anchorOwnerFact.source === "manual" ||
        anchorOwnerFact.source === "receipt")
    ) {
      chainAnchors.push({
        key: event.id,
        referenceDate: anchorOwnerFact.paymentDate,
      });
    }
  }
  const importedNotDirectlyMatched = importedRecords.filter(
    (record) => !consumedImportedEventIds.has(record.id),
  );
  const chainAnchorDominatedImported = matchStandaloneOwnerFactsToImported(
    chainAnchors,
    importedNotDirectlyMatched,
  );
  const consumedByChainAnchors = new Set(
    [...chainAnchorDominatedImported.values()].map((record) => record.id),
  );

  const rows: DerivedDividendRow[] = [];
  for (const event of activeEvents) {
    const override = overrideByEvent.get(event.id) ?? null;
    // Only relevant for override-FREE events: when any override is present
    // (excluded or not), this row is built from the override branch below
    // instead, and -- for an excluded override specifically -- the manual/
    // receipt facts attached to this event are resolved separately in the
    // resurfacing pass, never here (that is what fixes the round-2 double
    // count: this event never ALSO produces an "auto tier" owner-fact row).
    const ownerFact = override
      ? null
      : resolveOwnerFact(
          manualMatches.get(event.id) ?? null,
          resolveReceipts(event.id),
          importedEventMatches.get(event.id) ?? null,
        );
    const status = lifecycleStatus(event.exDate!, input.today);

    let sharesDecimal: string | null;
    let dividendPerShareDecimal: string | null;
    let overrideFrankingPerShare: string | null;
    let totalCashDecimal: string | null = null;
    let totalFrankingDecimal: string | null = null;
    let source: DerivedDividendRowSource;
    let excluded = false;
    let dominatedReceipt: DominatedReceipt | null = null;
    let dominatedImported: DominatedImported | null = null;
    let additionalReceiptsCount = 0;
    let paymentDate: string | null;
    let originalCurrencyCode: string | null = null;
    let fxRateToPortfolioDecimal: string | null = null;
    let fxRateSource: string | null = null;
    let currencyCodeOverride: string | null = null;
    let frankingDerivedZero = false;
    let frankingCurrencySource: "owner_manual" | null = null;
    let amountUnreadableFact = false;
    let frankingUnreadableFact = false;
    let frankingPerShareUnreadableFact = false;
    // BRK-022 slice 3: only ever `true` when `ownerFact.source === "imported"`
    // and the winning fact is a pending-payout announcement -- stays `false`
    // for the override/auto branches (this event's own status already comes
    // from its real `exDate` via `lifecycleStatus` above; this flag only
    // records what backed the row, never changes `status` itself here).
    let announcedUnpaidFact = false;

    if (override) {
      source = "edited";
      excluded = override.exclude;
      sharesDecimal =
        override.sharesDecimal ??
        deriveSharesHeldAtDate(input.transactions, event.exDate!);
      dividendPerShareDecimal =
        override.dividendPerShareDecimal ?? event.grossPerShareDecimal;
      overrideFrankingPerShare = override.frankingCreditPerShareDecimal;
      paymentDate = event.paymentDate;
    } else if (ownerFact) {
      source = ownerFact.source;
      sharesDecimal = ownerFact.sharesDecimal;
      dividendPerShareDecimal = ownerFact.dividendPerShareDecimal;
      overrideFrankingPerShare = ownerFact.overrideFrankingPerShare;
      totalCashDecimal = ownerFact.totalCashDecimal;
      totalFrankingDecimal = ownerFact.totalFrankingDecimal;
      paymentDate = ownerFact.paymentDate;
      dominatedReceipt = ownerFact.dominatedReceipt;
      dominatedImported = ownerFact.dominatedImported;
      additionalReceiptsCount = ownerFact.additionalReceiptsCount;
      originalCurrencyCode = ownerFact.originalCurrencyCode;
      fxRateToPortfolioDecimal = ownerFact.fxRateToPortfolioDecimal;
      fxRateSource = ownerFact.fxRateSource;
      currencyCodeOverride = ownerFact.currencyCodeOverride;
      frankingDerivedZero = ownerFact.frankingDerivedZero;
      frankingCurrencySource = ownerFact.frankingCurrencySource;
      amountUnreadableFact = ownerFact.amountUnreadable;
      frankingUnreadableFact = ownerFact.frankingUnreadable;
      frankingPerShareUnreadableFact = ownerFact.frankingPerShareUnreadable;
      announcedUnpaidFact = ownerFact.announcedUnpaid;
      // DIV-005 Round A: an imported row that missed this event's own
      // window but is within window of the WINNING manual/receipt fact's
      // own date chains in here instead of surfacing as a second row.
      if (
        dominatedImported === null &&
        (ownerFact.source === "manual" || ownerFact.source === "receipt")
      ) {
        const chained = chainAnchorDominatedImported.get(event.id);
        if (chained) dominatedImported = toDominatedImported(chained);
      }
    } else {
      source = "auto";
      sharesDecimal = deriveSharesHeldAtDate(input.transactions, event.exDate!);
      dividendPerShareDecimal = event.grossPerShareDecimal;
      overrideFrankingPerShare = null;
      paymentDate = event.paymentDate;
    }

    const franking = resolveFrankingPerShareRespectingUnreadable(
      frankingPerShareUnreadableFact,
      overrideFrankingPerShare,
      input.defaultFrankingPercentDecimal,
      dividendPerShareDecimal,
    );
    const {
      cashDecimal,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
    } = computeCashGrossOrTotals(
      dividendPerShareDecimal,
      sharesDecimal,
      totalCashDecimal,
      totalFrankingDecimal,
      franking,
    );

    rows.push({
      id: event.id,
      portfolioSecurityId: input.portfolioSecurityId,
      dividendEventId: event.id,
      kind: event.kind,
      // BRK-010 review finding B4: an imported fact's degraded (unconverted
      // foreign) currency overrides the event's own currency here -- see
      // `importedFactCurrencyDisplay`'s doc comment. `null` for every other
      // source/case, leaving the event's own currency as before.
      currencyCode: currencyCodeOverride ?? event.currencyCode,
      exDate: event.exDate,
      paymentDate,
      sharesDecimal,
      dividendPerShareDecimal,
      cashDecimal,
      franking,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
      status,
      source,
      excluded,
      amountUnknown: cashDecimal === null,
      providerGrossPerShareDecimal: event.grossPerShareDecimal,
      dominatedReceipt,
      dominatedImported,
      additionalReceiptsCount,
      additionalImportedCount: 0, // Round A only ever attaches one imported row per event
      originalCurrencyCode,
      fxRateToPortfolioDecimal,
      fxRateSource,
      frankingDerivedZero,
      frankingCurrencySource,
      // BUG-021: only meaningful when the amount actually ended up unknown
      // -- a record with some OTHER unreadable field (e.g. franking) whose
      // cash figure still resolved must not show the "needs correction"
      // cash-cell copy for a cash amount that is, in fact, fine.
      amountUnreadable: amountUnreadableFact && cashDecimal === null,
      // BUG-021 correction round: mirrors the guard immediately above,
      // scoped to franking instead of cash. BUG-023: ORs in the per-share
      // unreadable cause too -- either an unreadable TOTAL or an unreadable
      // PER-SHARE credit ends this row's franking at `null`, and both must
      // render the same "needs correction" disclosure.
      frankingUnreadable:
        (frankingUnreadableFact || frankingPerShareUnreadableFact) &&
        frankingTotalDecimal === null,
      announcedUnpaid: announcedUnpaidFact,
    });
  }

  // DIV-005 ROUND B: eventless transitive collapse. `unconsumedOwnerManual`
  // and `resurfacedReceipts` are the owner-manual records and receipts that
  // did NOT attach to any event above; `unconsumedImportedAfterChaining` is
  // the imported rows that matched neither an event directly (per-event loop
  // above) nor a chain anchor (Round A above). These three pools are
  // clustered by union-find over proximity edges -- manual<->imported and
  // receipt<->imported, each tested against the OTHER fact's own payment
  // date, within `PROXIMITY_WINDOW_DAYS` -- so a chain of facts spanning MORE
  // than one window end-to-end (e.g. manual -> imported -> receipt ->
  // imported, each adjacent pair within window but the two ends far apart)
  // still collapses to exactly ONE row: the honest reading of "the same
  // dividend recorded multiple ways" (TASKS.md DIV-005 "long chains"
  // direction -- an eventless chain is never capped, it always collapses
  // fully). Deliberately excluded: imported<->imported edges (cross-batch
  // import dedupe is IMP-004B's job at ingestion time, not this module's --
  // see the existing "does NOT warn -- that is cross-batch dedupe's job"
  // preview-warning boundary) and manual<->receipt edges (no pairing ever
  // compared those two directly; they still collapse together when bridged
  // by a shared imported record, exactly like the base repro).
  //
  // Since chain anchors (Round A) are never members of this pool, an
  // eventless cluster can, by construction, never contain more than one
  // event's evidence -- there is nothing here for it to over-merge into.
  //
  // Determinism: cluster membership depends only on the (order-independent)
  // pairwise distance test between every candidate pair, never on input
  // array order -- union-find always converges on the lexicographically
  // smallest node key as a cluster's root regardless of union order.
  //
  // Review round 1 BLOCKING fix (B2): a cluster can contain MORE THAN ONE
  // owner-typed fact of the SAME tier (two-plus manuals, or two-plus orphan
  // receipts) purely because each is independently within window of a
  // shared imported bridge -- e.g. manual A and manual B, each within window
  // of one imported record C, but A and B more than `PROXIMITY_WINDOW_DAYS`
  // apart from EACH OTHER. The original version picked the LATEST of the
  // two as an outright winner and silently dropped the other with zero
  // disclosure (reviewer repro: two independent manual records bridged by
  // one imported row -- correct output 2 rows/$110 became 1 row/$60). A
  // cluster with at most one manual and at most one receipt (any number of
  // imported records) still collapses to exactly ONE row via the
  // highest-precedence tier present (manual > receipt > imported, matching
  // the module's established precedence) with extra same-tier imported
  // records disclosed via `additionalImportedCount` (mirroring the existing
  // multi-receipt "latest wins, the rest disclosed via a count"
  // convention). A cluster with two-plus manuals OR two-plus receipts
  // instead falls back to a LOCAL DIV-004 1-1 nearest-wins assignment
  // scoped to that cluster (`pushEventlessRow` called once per owner fact
  // below): every owner fact keeps its own row, and only the cluster's
  // imported records are distributed among them by proximity -- two owner
  // facts are never merged into one row unless they are within window of
  // EACH OTHER (which no pairing in this module ever tests for manual<->
  // manual or receipt<->receipt, so that case cannot arise here at all).
  const unconsumedOwnerManual = ownerManualRecords.filter(
    (record) => !consumedOwnerManualIds.has(record.id),
  );
  const unconsumedImportedAfterChaining = importedNotDirectlyMatched.filter(
    (record) => !consumedByChainAnchors.has(record.id),
  );

  const chainParent = new Map<string, string>();
  function chainFind(key: string): string {
    if (!chainParent.has(key)) chainParent.set(key, key);
    let root = key;
    while (chainParent.get(root) !== root) root = chainParent.get(root)!;
    let cursor = key;
    while (chainParent.get(cursor) !== root) {
      const next = chainParent.get(cursor)!;
      chainParent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
  function chainMerge(a: string, b: string): void {
    const rootA = chainFind(a);
    const rootB = chainFind(b);
    if (rootA === rootB) return;
    // Deterministic regardless of union order: the lexicographically
    // smaller key always ends up as the eventual root of the merged
    // component (provable by induction over any sequence of merges).
    if (rootA < rootB) chainParent.set(rootB, rootA);
    else chainParent.set(rootA, rootB);
  }

  const chainNodeKeys: string[] = [];
  for (const record of unconsumedOwnerManual) {
    const key = `manual:${record.id}`;
    chainFind(key);
    chainNodeKeys.push(key);
  }
  for (const receiptFact of resurfacedReceipts) {
    const key = `receipt:${receiptFact.id}`;
    chainFind(key);
    chainNodeKeys.push(key);
  }
  for (const record of unconsumedImportedAfterChaining) {
    const key = `imported:${record.id}`;
    chainFind(key);
    chainNodeKeys.push(key);
  }
  for (const manualRecord of unconsumedOwnerManual) {
    for (const importedRecord of unconsumedImportedAfterChaining) {
      if (
        Math.abs(
          daysBetween(manualRecord.paymentDate, importedRecord.paymentDate),
        ) <= PROXIMITY_WINDOW_DAYS
      ) {
        chainMerge(
          `manual:${manualRecord.id}`,
          `imported:${importedRecord.id}`,
        );
      }
    }
  }
  for (const receiptFact of resurfacedReceipts) {
    for (const importedRecord of unconsumedImportedAfterChaining) {
      if (
        Math.abs(
          daysBetween(receiptFact.paymentDate, importedRecord.paymentDate),
        ) <= PROXIMITY_WINDOW_DAYS
      ) {
        chainMerge(
          `receipt:${receiptFact.id}`,
          `imported:${importedRecord.id}`,
        );
      }
    }
  }

  const chainClusters = new Map<string, string[]>();
  for (const key of chainNodeKeys) {
    const root = chainFind(key);
    const members = chainClusters.get(root) ?? [];
    members.push(key);
    chainClusters.set(root, members);
  }

  const unconsumedManualById = new Map(
    unconsumedOwnerManual.map((record) => [record.id, record] as const),
  );
  const resurfacedReceiptById = new Map(
    resurfacedReceipts.map(
      (receiptFact) => [receiptFact.id, receiptFact] as const,
    ),
  );
  const unconsumedImportedById = new Map(
    unconsumedImportedAfterChaining.map(
      (record) => [record.id, record] as const,
    ),
  );

  function latestWins<T extends { paymentDate: string; id: string }>(
    items: readonly T[],
  ): { winner: T; additionalCount: number } {
    const sorted = [...items].sort(
      (left, right) =>
        right.paymentDate.localeCompare(left.paymentDate) ||
        right.id.localeCompare(left.id),
    );
    return { winner: sorted[0]!, additionalCount: sorted.length - 1 };
  }

  function pushEventlessRow(fields: {
    source: DerivedDividendRowSource;
    rowId: string;
    dividendEventId?: string | null;
    kind?: "cash" | "special" | "capital_return" | "manual";
    currencyCode?: string;
    exDate?: string | null;
    providerGrossPerShareDecimal?: string | null;
    sharesDecimal: string | null;
    dividendPerShareDecimal: string | null;
    overrideFrankingPerShare: string | null;
    // BRK-005: set for a totals-mode fact -- a Sharesight payout
    // (`source === "imported"`) or, DIV-016 part A, an owner-typed
    // totals-mode entry (`source === "manual"`) -- see
    // `DividendManualRecordFact`'s header note.
    totalCashDecimal?: string | null;
    totalFrankingDecimal?: string | null;
    paymentDate: string;
    dominatedReceipt?: DominatedReceipt | null;
    dominatedImported?: DominatedImported | null;
    additionalReceiptsCount?: number;
    additionalImportedCount?: number;
    // BRK-010: only ever set when `source === "imported"` for a
    // foreign-currency Sharesight payout fact -- see `DerivedDividendRow`'s
    // matching doc comment.
    originalCurrencyCode?: string | null;
    fxRateToPortfolioDecimal?: string | null;
    fxRateSource?: string | null;
    // DIV-007: only ever set `true` for a `source === "imported"` field
    // whose franking total was derived from an absent stored value -- see
    // `DerivedDividendRow.frankingDerivedZero`'s doc comment.
    frankingDerivedZero?: boolean;
    // BRK-011: only ever set for a `source === "imported"` field whose
    // franking total came from an owner override -- see
    // `DerivedDividendRow.frankingCurrencySource`'s doc comment.
    frankingCurrencySource?: "owner_manual" | null;
    // BUG-021: mirrors `DividendManualRecordFact.amountUnreadable` for the
    // manual/imported record this eventless row was built from -- see
    // `DerivedDividendRow.amountUnreadable`'s doc comment. Omitted (falsy)
    // for a `source === "receipt"` row, matching `resolveOwnerFact`'s own
    // receipt branch.
    amountUnreadable?: boolean;
    // BUG-021 correction round: mirrors `DerivedDividendRow.frankingUnreadable`
    // for the manual/imported record this eventless row was built from.
    // Omitted (falsy) for a `source === "receipt"` row, matching
    // `resolveOwnerFact`'s own receipt branch.
    frankingUnreadable?: boolean;
    // BUG-023: mirrors `resolveOwnerFact`'s identical field for the manual/
    // imported record this eventless row was built from. Omitted (falsy)
    // for a `source === "receipt"` row, matching `frankingUnreadable` above.
    frankingPerShareUnreadable?: boolean;
    // BRK-022 slice 3: mirrors `DerivedDividendRow.announcedUnpaid` for the
    // imported record this eventless row was built from -- only ever set
    // for `source === "imported"`. Omitted (falsy) for a manual/receipt
    // row, which can never carry the flag.
    announcedUnpaid?: boolean;
  }): void {
    const franking = resolveFrankingPerShareRespectingUnreadable(
      fields.frankingPerShareUnreadable ?? false,
      fields.overrideFrankingPerShare,
      input.defaultFrankingPercentDecimal,
      fields.dividendPerShareDecimal,
    );
    const {
      cashDecimal,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
    } = computeCashGrossOrTotals(
      fields.dividendPerShareDecimal,
      fields.sharesDecimal,
      fields.totalCashDecimal ?? null,
      fields.totalFrankingDecimal ?? null,
      franking,
    );
    rows.push({
      id: fields.rowId,
      portfolioSecurityId: input.portfolioSecurityId,
      dividendEventId: fields.dividendEventId ?? null,
      kind: fields.kind ?? "manual",
      currencyCode: fields.currencyCode ?? input.securityCurrencyCode,
      exDate: fields.exDate ?? null,
      paymentDate: fields.paymentDate,
      sharesDecimal: fields.sharesDecimal,
      dividendPerShareDecimal: fields.dividendPerShareDecimal,
      cashDecimal,
      franking,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
      // Owner-typed/receipt/imported evidence -- always treated as paid,
      // same convention as every other owner-fact row in this module.
      // BRK-022 slice 3: EXCEPT a pending-payout announcement, which is
      // never payment evidence -- such a row stays `declared_pending`
      // regardless of its own payment date having already passed (only a
      // committed receipt/import/manual record proves payment; read-time
      // suppression, not date passage, is what removes an announcement once
      // its committed twin lands -- see `app/owned-dividend-history.ts`).
      status: fields.announcedUnpaid ? "declared_pending" : "ex_date_passed",
      source: fields.source,
      excluded: false,
      amountUnknown: cashDecimal === null,
      providerGrossPerShareDecimal: fields.providerGrossPerShareDecimal ?? null,
      dominatedReceipt: fields.dominatedReceipt ?? null,
      dominatedImported: fields.dominatedImported ?? null,
      additionalReceiptsCount: fields.additionalReceiptsCount ?? 0,
      additionalImportedCount: fields.additionalImportedCount ?? 0,
      originalCurrencyCode: fields.originalCurrencyCode ?? null,
      fxRateToPortfolioDecimal: fields.fxRateToPortfolioDecimal ?? null,
      fxRateSource: fields.fxRateSource ?? null,
      frankingDerivedZero: fields.frankingDerivedZero ?? false,
      frankingCurrencySource: fields.frankingCurrencySource ?? null,
      // BUG-021: see the main per-event loop's identical guard above.
      amountUnreadable:
        (fields.amountUnreadable ?? false) && cashDecimal === null,
      // BUG-021 correction round: see the main per-event loop's identical
      // guard above, scoped to franking. BUG-023: ORs in the per-share
      // unreadable cause too, mirroring the main per-event loop's identical
      // guard.
      frankingUnreadable:
        ((fields.frankingUnreadable ?? false) ||
          (fields.frankingPerShareUnreadable ?? false)) &&
        frankingTotalDecimal === null,
      announcedUnpaid: fields.announcedUnpaid ?? false,
    });
  }

  // Sorted cluster-root order gives a stable, order-independent row
  // emission SEQUENCE (cluster membership itself is already
  // order-independent per the comment above; this only fixes the array
  // order of the resulting rows for reproducible output/tests).
  for (const root of [...chainClusters.keys()].sort()) {
    const members = chainClusters.get(root)!;
    const clusterManuals: DividendManualRecordFact[] = [];
    const clusterReceipts: DividendReceiptFact[] = [];
    const clusterImported: DividendManualRecordFact[] = [];
    for (const key of members) {
      const separatorIndex = key.indexOf(":");
      const type = key.slice(0, separatorIndex);
      const id = key.slice(separatorIndex + 1);
      if (type === "manual") {
        clusterManuals.push(unconsumedManualById.get(id)!);
      } else if (type === "receipt") {
        clusterReceipts.push(resurfacedReceiptById.get(id)!);
      } else {
        clusterImported.push(unconsumedImportedById.get(id)!);
      }
    }

    if (clusterManuals.length > 1 || clusterReceipts.length > 1) {
      // Review round 1 BLOCKING fix (B2): more than one SAME-TIER owner-typed
      // fact (two-plus manuals, or two-plus orphan receipts) ended up in one
      // cluster only because each is independently within window of a
      // shared imported bridge -- they are not within window of EACH OTHER.
      // Collapsing them into one row (the original `latestWins`-picks-one
      // approach) silently erased the losing owner fact with zero disclosure
      // (reviewer repro: two independent manual records bridged by one
      // imported row -- HEAD's 2 rows/$110 became 1 row/$60). Fall back to
      // the DIV-004 1-1 nearest-wins assignment SCOPED TO THIS CLUSTER:
      // every owner fact (manual or receipt) keeps its own row; only the
      // cluster's imported records are distributed among them by proximity,
      // never merging two owner facts together.
      const partitionCandidates: { key: string; referenceDate: string }[] = [
        ...clusterManuals.map((record) => ({
          key: `manual:${record.id}`,
          referenceDate: record.paymentDate,
        })),
        ...clusterReceipts.map((receiptFact) => ({
          key: `receipt:${receiptFact.id}`,
          referenceDate: receiptFact.paymentDate,
        })),
      ];
      const partitionMatches = matchStandaloneOwnerFactsToImported(
        partitionCandidates,
        clusterImported,
      );
      const partitionConsumedImportedIds = new Set(
        [...partitionMatches.values()].map((record) => record.id),
      );

      for (const record of clusterManuals) {
        const matchedImported =
          partitionMatches.get(`manual:${record.id}`) ?? null;
        pushEventlessRow({
          source: "manual",
          rowId: `manual:${record.id}`,
          sharesDecimal: record.sharesDecimal,
          dividendPerShareDecimal: record.dividendPerShareDecimal,
          overrideFrankingPerShare: record.frankingCreditPerShareDecimal,
          // DIV-016 part A: see the header note's/`resolveOwnerFact`'s
          // identical addition -- an owner-typed record can be
          // totals-mode too now.
          totalCashDecimal: record.totalCashDecimal ?? null,
          totalFrankingDecimal: record.totalFrankingDecimal ?? null,
          paymentDate: record.paymentDate,
          dominatedImported: matchedImported
            ? toDominatedImported(matchedImported)
            : null,
          amountUnreadable: record.amountUnreadable === true,
          frankingUnreadable:
            record.unreadableFields?.has("totalFranking") === true,
          frankingPerShareUnreadable:
            record.unreadableFields?.has("frankingPerShare") === true,
        });
      }
      for (const receiptFact of clusterReceipts) {
        const matchedImported =
          partitionMatches.get(`receipt:${receiptFact.id}`) ?? null;
        const rawEvent = eventById.get(receiptFact.dividendEventId) ?? null;
        pushEventlessRow({
          source: "receipt",
          rowId: `receipt:${receiptFact.id}`,
          dividendEventId: receiptFact.dividendEventId,
          kind: rawEvent?.kind ?? "cash",
          currencyCode: receiptFact.currencyCode,
          exDate: rawEvent?.exDate ?? null,
          providerGrossPerShareDecimal: rawEvent?.grossPerShareDecimal ?? null,
          sharesDecimal: receiptFact.sharesDecimal,
          dividendPerShareDecimal: receiptFact.dividendPerShareDecimal,
          overrideFrankingPerShare: receiptFact.frankingPerShareDecimal,
          paymentDate: receiptFact.paymentDate,
          dominatedImported: matchedImported
            ? toDominatedImported(matchedImported)
            : null,
        });
      }
      for (const record of clusterImported) {
        if (partitionConsumedImportedIds.has(record.id)) continue;
        const display = importedFactCurrencyDisplay(record);
        pushEventlessRow({
          source: "imported",
          rowId: `imported:${record.id}`,
          sharesDecimal: record.sharesDecimal,
          dividendPerShareDecimal: record.dividendPerShareDecimal,
          overrideFrankingPerShare: record.frankingCreditPerShareDecimal,
          totalCashDecimal: record.totalCashDecimal,
          totalFrankingDecimal: record.totalFrankingDecimal,
          paymentDate: record.paymentDate,
          exDate: record.exDate ?? null,
          currencyCode: display.currencyCodeOverride ?? undefined,
          originalCurrencyCode: display.originalCurrencyCode,
          fxRateToPortfolioDecimal: display.fxRateToPortfolioDecimal,
          fxRateSource: display.fxRateSource,
          frankingDerivedZero: record.frankingDerivedZero === true,
          frankingCurrencySource: record.frankingCurrencySource ?? null,
          amountUnreadable: record.amountUnreadable === true,
          frankingUnreadable: record.frankingUnreadable === true,
          frankingPerShareUnreadable:
            record.unreadableFields?.has("frankingPerShare") === true,
          announcedUnpaid: record.announcedUnpaid === true,
        });
      }
      continue;
    }

    // At most one manual and at most one receipt reach here -- the normal,
    // established tier-precedence collapse (manual > receipt > imported).
    const manualPick = clusterManuals.length
      ? latestWins(clusterManuals)
      : null;
    const receiptPick = clusterReceipts.length
      ? latestWins(clusterReceipts)
      : null;
    const importedPick = clusterImported.length
      ? latestWins(clusterImported)
      : null;

    if (manualPick) {
      pushEventlessRow({
        source: "manual",
        rowId: `manual:${manualPick.winner.id}`,
        sharesDecimal: manualPick.winner.sharesDecimal,
        dividendPerShareDecimal: manualPick.winner.dividendPerShareDecimal,
        overrideFrankingPerShare:
          manualPick.winner.frankingCreditPerShareDecimal,
        // DIV-016 part A: see the header note's/`resolveOwnerFact`'s
        // identical addition -- an owner-typed record can be totals-mode
        // too now.
        totalCashDecimal: manualPick.winner.totalCashDecimal ?? null,
        totalFrankingDecimal: manualPick.winner.totalFrankingDecimal ?? null,
        paymentDate: manualPick.winner.paymentDate,
        dominatedReceipt: receiptPick
          ? toDominatedReceipt(receiptPick.winner)
          : null,
        dominatedImported: importedPick
          ? toDominatedImported(importedPick.winner)
          : null,
        additionalImportedCount: importedPick?.additionalCount ?? 0,
        amountUnreadable: manualPick.winner.amountUnreadable === true,
        frankingUnreadable:
          manualPick.winner.unreadableFields?.has("totalFranking") === true,
        frankingPerShareUnreadable:
          manualPick.winner.unreadableFields?.has("frankingPerShare") === true,
      });
    } else if (receiptPick) {
      const rawEvent =
        eventById.get(receiptPick.winner.dividendEventId) ?? null;
      pushEventlessRow({
        source: "receipt",
        rowId: `receipt:${receiptPick.winner.id}`,
        dividendEventId: receiptPick.winner.dividendEventId,
        kind: rawEvent?.kind ?? "cash",
        currencyCode: receiptPick.winner.currencyCode,
        exDate: rawEvent?.exDate ?? null,
        providerGrossPerShareDecimal: rawEvent?.grossPerShareDecimal ?? null,
        sharesDecimal: receiptPick.winner.sharesDecimal,
        dividendPerShareDecimal: receiptPick.winner.dividendPerShareDecimal,
        overrideFrankingPerShare: receiptPick.winner.frankingPerShareDecimal,
        paymentDate: receiptPick.winner.paymentDate,
        dominatedImported: importedPick
          ? toDominatedImported(importedPick.winner)
          : null,
        additionalImportedCount: importedPick?.additionalCount ?? 0,
      });
    } else if (importedPick) {
      const display = importedFactCurrencyDisplay(importedPick.winner);
      pushEventlessRow({
        source: "imported",
        rowId: `imported:${importedPick.winner.id}`,
        sharesDecimal: importedPick.winner.sharesDecimal,
        dividendPerShareDecimal: importedPick.winner.dividendPerShareDecimal,
        overrideFrankingPerShare:
          importedPick.winner.frankingCreditPerShareDecimal,
        totalCashDecimal: importedPick.winner.totalCashDecimal,
        totalFrankingDecimal: importedPick.winner.totalFrankingDecimal,
        paymentDate: importedPick.winner.paymentDate,
        exDate: importedPick.winner.exDate ?? null,
        additionalImportedCount: importedPick.additionalCount,
        currencyCode: display.currencyCodeOverride ?? undefined,
        originalCurrencyCode: display.originalCurrencyCode,
        fxRateToPortfolioDecimal: display.fxRateToPortfolioDecimal,
        fxRateSource: display.fxRateSource,
        frankingDerivedZero: importedPick.winner.frankingDerivedZero === true,
        frankingCurrencySource:
          importedPick.winner.frankingCurrencySource ?? null,
        amountUnreadable: importedPick.winner.amountUnreadable === true,
        frankingUnreadable: importedPick.winner.frankingUnreadable === true,
        frankingPerShareUnreadable:
          importedPick.winner.unreadableFields?.has("frankingPerShare") ===
          true,
        announcedUnpaid: importedPick.winner.announcedUnpaid === true,
      });
    }
  }

  // Excluded-event resurfacing (B3, fixed for the round-3 double-count;
  // DIV-004 extended it to the imported tier): exactly ONE row per excluded
  // event that has a manual match, an attached receipt, and/or an imported
  // match, using the identical precedence the non-excluded path uses
  // (`resolveOwnerFact`) so every owner fact attached to the event collapses
  // together instead of each producing its own row. An excluded event with
  // none of the three contributes nothing here (its only row is the
  // excluded, zero-contributing one already pushed above).
  for (const event of activeEvents) {
    if (!excludedEventIds.has(event.id)) continue;
    const ownerFact = resolveOwnerFact(
      manualMatches.get(event.id) ?? null,
      resolveReceipts(event.id),
      importedEventMatches.get(event.id) ?? null,
    );
    if (!ownerFact) continue;
    // DIV-005 Round A: an imported row that missed this excluded event's own
    // window but is within window of the WINNING manual/receipt fact's own
    // date chains in here too, identically to the non-excluded main loop.
    let dominatedImported = ownerFact.dominatedImported;
    if (
      dominatedImported === null &&
      (ownerFact.source === "manual" || ownerFact.source === "receipt")
    ) {
      const chained = chainAnchorDominatedImported.get(event.id);
      if (chained) dominatedImported = toDominatedImported(chained);
    }
    const franking = resolveFrankingPerShareRespectingUnreadable(
      ownerFact.frankingPerShareUnreadable,
      ownerFact.overrideFrankingPerShare,
      input.defaultFrankingPercentDecimal,
      ownerFact.dividendPerShareDecimal,
    );
    const {
      cashDecimal,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
    } = computeCashGrossOrTotals(
      ownerFact.dividendPerShareDecimal,
      ownerFact.sharesDecimal,
      ownerFact.totalCashDecimal,
      ownerFact.totalFrankingDecimal,
      franking,
    );
    const sourceId =
      ownerFact.source === "manual"
        ? (manualMatches.get(event.id)?.id ?? event.id)
        : ownerFact.source === "receipt"
          ? (resolveReceipts(event.id)?.latest.id ?? event.id)
          : (importedEventMatches.get(event.id)?.id ?? event.id);
    rows.push({
      id: `${ownerFact.source}:${sourceId}`,
      portfolioSecurityId: input.portfolioSecurityId,
      dividendEventId: event.id,
      kind: event.kind,
      // BRK-010 review finding B4: see the non-excluded main loop's
      // identical override above.
      currencyCode: ownerFact.currencyCodeOverride ?? event.currencyCode,
      exDate: event.exDate,
      paymentDate: ownerFact.paymentDate,
      sharesDecimal: ownerFact.sharesDecimal,
      dividendPerShareDecimal: ownerFact.dividendPerShareDecimal,
      cashDecimal,
      franking,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
      // Owner-asserted/imported evidence -- always treated as paid, same
      // convention as the standalone manual/orphan-receipt rows above.
      // BRK-022 slice 3: EXCEPT a pending-payout announcement -- see the
      // identical guard in `pushEventlessRow`.
      status: ownerFact.announcedUnpaid ? "declared_pending" : "ex_date_passed",
      source: ownerFact.source,
      excluded: false,
      amountUnknown: cashDecimal === null,
      providerGrossPerShareDecimal: event.grossPerShareDecimal,
      dominatedReceipt: ownerFact.dominatedReceipt,
      dominatedImported,
      additionalReceiptsCount: ownerFact.additionalReceiptsCount,
      additionalImportedCount: 0, // Round A only ever attaches one imported row per event
      originalCurrencyCode: ownerFact.originalCurrencyCode,
      fxRateToPortfolioDecimal: ownerFact.fxRateToPortfolioDecimal,
      fxRateSource: ownerFact.fxRateSource,
      frankingDerivedZero: ownerFact.frankingDerivedZero,
      frankingCurrencySource: ownerFact.frankingCurrencySource,
      // BUG-021: see the main per-event loop's identical guard above.
      amountUnreadable: ownerFact.amountUnreadable && cashDecimal === null,
      // BUG-021 correction round: see the main per-event loop's identical
      // guard above, scoped to franking. BUG-023: ORs in the per-share
      // unreadable cause too, mirroring the main per-event loop's identical
      // guard.
      frankingUnreadable:
        (ownerFact.frankingUnreadable ||
          ownerFact.frankingPerShareUnreadable) &&
        frankingTotalDecimal === null,
      announcedUnpaid: ownerFact.announcedUnpaid,
    });
  }

  return rows;
}
