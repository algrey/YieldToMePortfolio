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
  multiplyDecimal,
  parseDecimal,
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
  // row alone, and `totalCashDecimal` is set instead; every owner-typed or
  // CSV-imported per-share row still has both non-null and both `total*`
  // fields null. Structurally, only the "imported" tier can ever carry a
  // totals-mode fact (the manual-entry UI and `dividend_receipts` both only
  // ever supply per-share facts).
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
};

export type DerivedDividendRow = {
  id: string;
  portfolioSecurityId: string;
  dividendEventId: string | null;
  kind: "cash" | "special" | "capital_return" | "manual";
  currencyCode: string;
  exDate: string | null;
  paymentDate: string | null;
  /** `null` only for a BRK-005 totals-mode imported row (a Sharesight payout, which reports no share count at all) -- rendered as "Unknown", never fabricated by deriving a share count from unrelated ledger holdings. Non-null for every other tier/source. */
  sharesDecimal: string | null;
  /** `null` when the per-share amount is genuinely unknown -- no override/receipt/manual value AND the provider event's own amount is null, OR a BRK-005 totals-mode imported row (which has no per-share fact at all, only a total) -- never fabricated as "0". */
  dividendPerShareDecimal: string | null;
  cashDecimal: string | null;
  franking: FrankingResolution;
  frankingTotalDecimal: string | null;
  grossDecimal: string | null;
  grossIncludesFranking: boolean;
  status: DerivedDividendRowLifecycleStatus;
  source: DerivedDividendRowSource;
  excluded: boolean;
  /** True exactly when `cashDecimal` is `null` -- equivalent to `dividendPerShareDecimal === null` for every row EXCEPT a BRK-005 totals-mode imported row, whose per-share amount is unknown but whose cash total is known (so it is never counted as amount-unknown and its real total still contributes to lifetime sums). */
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
};

export type DeriveDividendHistoryInput = {
  portfolioSecurityId: string;
  securityCurrencyCode: string;
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
  return {
    sharesDecimal: record.sharesDecimal,
    dividendPerShareDecimal: record.dividendPerShareDecimal,
    frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
    totalCashDecimal: record.totalCashDecimal ?? null,
    totalFrankingDecimal: record.totalFrankingDecimal ?? null,
    paymentDate: record.paymentDate,
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

  // DIV-004: split `dividend_manual_records` rows by `importBatchId` into
  // the owner-typed tier (2) and the imported tier (4) BEFORE any matching
  // happens, so the two tiers are matched to events independently and can
  // never be confused with each other downstream.
  const ownerManualRecords = input.manualRecords.filter(
    (record) => record.importBatchId === null,
  );
  const importedRecords = input.manualRecords.filter(
    (record) => record.importBatchId !== null,
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
  } | null {
    if (manual) {
      return {
        source: "manual",
        sharesDecimal: manual.sharesDecimal,
        dividendPerShareDecimal: manual.dividendPerShareDecimal,
        overrideFrankingPerShare: manual.frankingCreditPerShareDecimal,
        totalCashDecimal: null,
        totalFrankingDecimal: null,
        paymentDate: manual.paymentDate,
        dominatedReceipt: receiptResolution
          ? toDominatedReceipt(receiptResolution.latest)
          : null,
        dominatedImported: imported ? toDominatedImported(imported) : null,
        additionalReceiptsCount: receiptResolution?.additionalCount ?? 0,
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
      };
    }
    if (imported) {
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

    const franking = resolveFrankingPerShare(
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
      currencyCode: event.currencyCode,
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
    // BRK-005: only ever set when `source === "imported"` for a totals-mode
    // Sharesight payout fact -- see `DividendManualRecordFact`'s header note.
    totalCashDecimal?: string | null;
    totalFrankingDecimal?: string | null;
    paymentDate: string;
    dominatedReceipt?: DominatedReceipt | null;
    dominatedImported?: DominatedImported | null;
    additionalReceiptsCount?: number;
    additionalImportedCount?: number;
  }): void {
    const franking = resolveFrankingPerShare(
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
      status: "ex_date_passed",
      source: fields.source,
      excluded: false,
      amountUnknown: cashDecimal === null,
      providerGrossPerShareDecimal: fields.providerGrossPerShareDecimal ?? null,
      dominatedReceipt: fields.dominatedReceipt ?? null,
      dominatedImported: fields.dominatedImported ?? null,
      additionalReceiptsCount: fields.additionalReceiptsCount ?? 0,
      additionalImportedCount: fields.additionalImportedCount ?? 0,
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
          paymentDate: record.paymentDate,
          dominatedImported: matchedImported
            ? toDominatedImported(matchedImported)
            : null,
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
        pushEventlessRow({
          source: "imported",
          rowId: `imported:${record.id}`,
          sharesDecimal: record.sharesDecimal,
          dividendPerShareDecimal: record.dividendPerShareDecimal,
          overrideFrankingPerShare: record.frankingCreditPerShareDecimal,
          totalCashDecimal: record.totalCashDecimal,
          totalFrankingDecimal: record.totalFrankingDecimal,
          paymentDate: record.paymentDate,
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
        paymentDate: manualPick.winner.paymentDate,
        dominatedReceipt: receiptPick
          ? toDominatedReceipt(receiptPick.winner)
          : null,
        dominatedImported: importedPick
          ? toDominatedImported(importedPick.winner)
          : null,
        additionalImportedCount: importedPick?.additionalCount ?? 0,
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
        additionalImportedCount: importedPick.additionalCount,
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
    const franking = resolveFrankingPerShare(
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
      currencyCode: event.currencyCode,
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
      status: "ex_date_passed",
      source: ownerFact.source,
      excluded: false,
      amountUnknown: cashDecimal === null,
      providerGrossPerShareDecimal: event.grossPerShareDecimal,
      dominatedReceipt: ownerFact.dominatedReceipt,
      dominatedImported,
      additionalReceiptsCount: ownerFact.additionalReceiptsCount,
      additionalImportedCount: 0, // Round A only ever attaches one imported row per event
    });
  }

  return rows;
}
