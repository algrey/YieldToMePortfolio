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
// "covers securities/events the provider misses" case. DIV-004 cross-tier
// rule: an imported row similarly left unmatched by any event is NOT
// automatically its own standalone row -- it is first proximity-matched
// (same window, same nearest-wins global assignment) directly against every
// standalone owner-manual record and standalone/orphan receipt for the
// security (there is no common event to anchor the comparison to in this
// case), and collapses into whichever one it is nearest to within the
// window (owner wins, imported value kept as `dominatedImported` on that
// row). Only an imported row that matches neither an event nor a standalone
// owner fact becomes its own standalone `source: "imported"` row. A receipt
// that no ACTIVE event's lineage claims at all (its event is cancelled,
// missing an ex-date, or otherwise never reached `activeEvents`) resurfaces
// the same way, as its own standalone row (`receipt:<id>`) built from the
// receipt's own dates -- this case silently drops owner/imported data
// otherwise (the matching cancelled/null-ex-date follow-up). A receipt
// dominated by a non-excluded override remains intentionally not shown (the
// owner's edit supersedes it).
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
  sharesDecimal: string;
  dividendPerShareDecimal: string;
  frankingCreditPerShareDecimal: string | null;
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
 * visible here rather than being silently dropped. */
export type DominatedImported = {
  sharesDecimal: string;
  dividendPerShareDecimal: string;
  frankingCreditPerShareDecimal: string | null;
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
  sharesDecimal: string;
  /** `null` only when the per-share amount is genuinely unknown (no override/receipt/manual value AND the provider event's own amount is null) -- never fabricated as "0". */
  dividendPerShareDecimal: string | null;
  cashDecimal: string | null;
  franking: FrankingResolution;
  frankingTotalDecimal: string | null;
  grossDecimal: string | null;
  grossIncludesFranking: boolean;
  status: DerivedDividendRowLifecycleStatus;
  source: DerivedDividendRowSource;
  excluded: boolean;
  /** True exactly when `dividendPerShareDecimal` is `null`. */
  amountUnknown: boolean;
  /** The provider event's own, unedited per-share amount (present whenever an event backs the row, regardless of source), so a detail view can show "provider says X, you overrode to Y" (UI-006C). */
  providerGrossPerShareDecimal: string | null;
  /** Set when a receipt existed for this event but a manual record won the row (manual > receipt precedence): the receipt is consumed (no duplicate row), its values kept visible here. */
  dominatedReceipt: DominatedReceipt | null;
  /** Set when an imported row (DIV-004) existed for this event/proximity match but an owner manual record or a receipt won the row: the imported row is consumed (no duplicate row), its values kept visible here. */
  dominatedImported: DominatedImported | null;
  /** Receipts attached to this event's lineage beyond the single one used (as the row itself, or as `dominatedReceipt`) -- not silently discarded, counted here. */
  additionalReceiptsCount: number;
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
    sharesDecimal: string;
    dividendPerShareDecimal: string;
    overrideFrankingPerShare: string | null;
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
        paymentDate: imported.paymentDate,
        dominatedReceipt: null,
        dominatedImported: null,
        additionalReceiptsCount: 0,
      };
    }
    return null;
  }

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

    let sharesDecimal: string;
    let dividendPerShareDecimal: string | null;
    let overrideFrankingPerShare: string | null;
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
      paymentDate = ownerFact.paymentDate;
      dominatedReceipt = ownerFact.dominatedReceipt;
      dominatedImported = ownerFact.dominatedImported;
      additionalReceiptsCount = ownerFact.additionalReceiptsCount;
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
    } = computeCashGross(sharesDecimal, dividendPerShareDecimal, franking);

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
      amountUnknown: dividendPerShareDecimal === null,
      providerGrossPerShareDecimal: event.grossPerShareDecimal,
      dominatedReceipt,
      dominatedImported,
      additionalReceiptsCount,
    });
  }

  // DIV-004: standalone cross-tier dedupe. `unconsumedOwnerManual` and
  // `resurfacedReceipts` are the owner-manual records and receipts that did
  // NOT attach to any event above (they become their own standalone rows
  // below); `unconsumedImported` is the imported rows that likewise did not
  // attach to any event. Before any of them become standalone rows, match
  // the imported leftovers directly against the owner-manual/receipt
  // leftovers by payment-date proximity (see
  // `matchStandaloneOwnerFactsToImported`'s doc comment for why this needs
  // its own direct match rather than reusing the event-anchored one) so an
  // imported row that duplicates a standalone owner fact collapses into it
  // instead of producing a second, duplicate standalone row.
  //
  // KNOWN LIMITATION (reviewer finding, review round 1, follow-up -- tracked
  // in TASKS.md, not fixed here): this pool only ever contains OWNER FACTS
  // THAT ARE THEMSELVES UNCONSUMED (i.e. not already event-anchored). A
  // transitive case falls through both this pass and the per-event pass: an
  // event E, an owner-manual/receipt B within `PROXIMITY_WINDOW_DAYS` of E
  // (so B attaches to E's row, tier 2/3, and is REMOVED from this standalone
  // pool), and an imported row C within `PROXIMITY_WINDOW_DAYS` of B but
  // OUTSIDE that window of E itself. C is compared against E (event-anchored
  // matching) and against every UNCONSUMED owner fact (this pass) -- never
  // against B directly, since B is no longer in either pool once it attaches
  // to E. C therefore either matches a different event or surfaces as its
  // own standalone `imported` row, producing two rows for what may be one
  // real dividend. This is a narrow proximity-chaining gap already latent in
  // DIV-001's pre-existing manual/receipt matching (an owner-manual record
  // and a receipt that are each independently within the window of the same
  // event but more than `PROXIMITY_WINDOW_DAYS` apart from EACH OTHER
  // already collapse via the event, not a direct A-to-B distance check);
  // DIV-004 inherits the same band behaviour for the imported tier rather
  // than introducing a new, more permissive transitive-matching algorithm
  // for imported records only.
  const unconsumedOwnerManual = ownerManualRecords.filter(
    (record) => !consumedOwnerManualIds.has(record.id),
  );
  const unconsumedImported = importedRecords.filter(
    (record) => !consumedImportedEventIds.has(record.id),
  );
  const standaloneOwnerFactCandidates: {
    key: string;
    referenceDate: string;
  }[] = [
    ...unconsumedOwnerManual.map((record) => ({
      key: `manual:${record.id}`,
      referenceDate: record.paymentDate,
    })),
    ...resurfacedReceipts.map((receipt) => ({
      key: `receipt:${receipt.id}`,
      referenceDate: receipt.paymentDate,
    })),
  ];
  const standaloneDominatedImported = matchStandaloneOwnerFactsToImported(
    standaloneOwnerFactCandidates,
    unconsumedImported,
  );
  const consumedStandaloneImportedIds = new Set(
    [...standaloneDominatedImported.values()].map((record) => record.id),
  );

  for (const record of unconsumedOwnerManual) {
    const franking = resolveFrankingPerShare(
      record.frankingCreditPerShareDecimal,
      input.defaultFrankingPercentDecimal,
      record.dividendPerShareDecimal,
    );
    const {
      cashDecimal,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
    } = computeCashGross(
      record.sharesDecimal,
      record.dividendPerShareDecimal,
      franking,
    );
    const dominatingImport = standaloneDominatedImported.get(
      `manual:${record.id}`,
    );
    rows.push({
      id: `manual:${record.id}`,
      portfolioSecurityId: input.portfolioSecurityId,
      dividendEventId: null,
      kind: "manual",
      currencyCode: input.securityCurrencyCode,
      exDate: null,
      paymentDate: record.paymentDate,
      sharesDecimal: record.sharesDecimal,
      dividendPerShareDecimal: record.dividendPerShareDecimal,
      cashDecimal,
      franking,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
      // A manual record is the owner asserting a dividend was actually
      // paid -- there is no "declared but not yet paid" manual concept.
      status: "ex_date_passed",
      source: "manual",
      excluded: false,
      amountUnknown: false,
      providerGrossPerShareDecimal: null,
      dominatedReceipt: null,
      dominatedImported: dominatingImport
        ? toDominatedImported(dominatingImport)
        : null,
      additionalReceiptsCount: 0,
    });
  }

  for (const receipt of resurfacedReceipts) {
    const rawEvent = eventById.get(receipt.dividendEventId) ?? null;
    const franking = resolveFrankingPerShare(
      receipt.frankingPerShareDecimal,
      input.defaultFrankingPercentDecimal,
      receipt.dividendPerShareDecimal,
    );
    const {
      cashDecimal,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
    } = computeCashGross(
      receipt.sharesDecimal,
      receipt.dividendPerShareDecimal,
      franking,
    );
    const dominatingImport = standaloneDominatedImported.get(
      `receipt:${receipt.id}`,
    );
    rows.push({
      id: `receipt:${receipt.id}`,
      portfolioSecurityId: input.portfolioSecurityId,
      dividendEventId: receipt.dividendEventId,
      kind: rawEvent?.kind ?? "cash",
      currencyCode: receipt.currencyCode,
      exDate: rawEvent?.exDate ?? null,
      paymentDate: receipt.paymentDate,
      sharesDecimal: receipt.sharesDecimal,
      dividendPerShareDecimal: receipt.dividendPerShareDecimal,
      cashDecimal,
      franking,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
      // A receipt is actual receipt evidence -- always treated as paid.
      status: "ex_date_passed",
      source: "receipt",
      excluded: false,
      amountUnknown: false,
      providerGrossPerShareDecimal: rawEvent?.grossPerShareDecimal ?? null,
      dominatedReceipt: null,
      dominatedImported: dominatingImport
        ? toDominatedImported(dominatingImport)
        : null,
      additionalReceiptsCount: 0,
    });
  }

  // DIV-004: an imported row survives to here only when it matched neither
  // an event (per-event loop above) nor a standalone owner-manual
  // record/receipt (the cross-tier match just above) -- i.e. it is
  // genuinely the sole evidence for its real-world dividend. It becomes its
  // own standalone row, mirroring the owner-manual standalone loop above
  // but labelled `source: "imported"` so the distinction stays visible to
  // consumers (UI-006C's wireframe vocabulary: auto/edited/manual/imported).
  for (const record of unconsumedImported) {
    if (consumedStandaloneImportedIds.has(record.id)) continue;
    const franking = resolveFrankingPerShare(
      record.frankingCreditPerShareDecimal,
      input.defaultFrankingPercentDecimal,
      record.dividendPerShareDecimal,
    );
    const {
      cashDecimal,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
    } = computeCashGross(
      record.sharesDecimal,
      record.dividendPerShareDecimal,
      franking,
    );
    rows.push({
      id: `imported:${record.id}`,
      portfolioSecurityId: input.portfolioSecurityId,
      dividendEventId: null,
      kind: "manual",
      currencyCode: input.securityCurrencyCode,
      exDate: null,
      paymentDate: record.paymentDate,
      sharesDecimal: record.sharesDecimal,
      dividendPerShareDecimal: record.dividendPerShareDecimal,
      cashDecimal,
      franking,
      frankingTotalDecimal,
      grossDecimal,
      grossIncludesFranking,
      // An imported row came from an actual broker CSV row -- treated as
      // paid, same convention as a standalone manual record.
      status: "ex_date_passed",
      source: "imported",
      excluded: false,
      amountUnknown: false,
      providerGrossPerShareDecimal: null,
      dominatedReceipt: null,
      dominatedImported: null,
      additionalReceiptsCount: 0,
    });
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
    } = computeCashGross(
      ownerFact.sharesDecimal,
      ownerFact.dividendPerShareDecimal,
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
      amountUnknown: false,
      providerGrossPerShareDecimal: event.grossPerShareDecimal,
      dominatedReceipt: ownerFact.dominatedReceipt,
      dominatedImported: ownerFact.dominatedImported,
      additionalReceiptsCount: ownerFact.additionalReceiptsCount,
    });
  }

  return rows;
}
