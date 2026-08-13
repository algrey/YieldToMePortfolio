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
// Precedence (Orchestrator ruling, 2026-08-13, correcting an earlier
// inversion): override > manual > imported receipt > auto-derived, per
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
//   2. A manual record proximity-matched to the event GLOBALLY (every
//      candidate (event, manual) pair within `PROXIMITY_WINDOW_DAYS` days,
//      assigned nearest-distance-first across the WHOLE set -- not a
//      per-event greedy pass, which can mis-assign when two events compete
//      for one manual record; see `matchManualRecordsGlobally`'s doc
//      comment for the exact tie-break rule). Ties in the assignment
//      process are broken deterministically; PROXIMITY_WINDOW_DAYS
//      defaults to 7. If a receipt ALSO exists for the same event, the
//      receipt is still consumed by this row (no duplicate row) but its
//      values remain visible via `dominatedReceipt` (Orchestrator ruling:
//      manual wins the row, receipt stays available as secondary
//      information, exactly matching TASKS.md's stated precedence).
//   3. An imported actual receipt tied to the event OR any version in its
//      lineage (the identical lineage-survival problem the override BINDING
//      fix addresses applies equally to a receipt recorded against a
//      since-superseded event id; resolved the same way here for
//      consistency, though not itself the literal BINDING clause). Multiple
//      receipts attached to one lineage: the latest by payment date wins;
//      the rest are not silently discarded -- `additionalReceiptsCount`
//      discloses how many were not individually shown.
//   4. Auto-derived: shares held at ex-date (`deriveSharesHeldAtDate`) x
//      the event's gross per share. A null `gross_per_share_decimal` (only
//      reachable via malformed/defensive input -- the DB CHECK constraint
//      requires it for a real `declared`/`paid` event) never fabricates a
//      "0" amount: the row's `dividendPerShareDecimal`/`cashDecimal`/
//      `grossDecimal` are `null` and `amountUnknown` is `true` instead.
// A manual record left unmatched after every event is processed becomes its
// own standalone row (no `dividendEventId`) -- the "covers securities/
// events the provider misses" case. A receipt that no ACTIVE event's
// lineage claims at all (its event is cancelled, missing an ex-date, or
// otherwise never reached `activeEvents`) resurfaces the same way, as its
// own standalone row (`receipt:<id>`) built from the receipt's own dates --
// this case silently drops owner/imported data otherwise (the matching
// cancelled/null-ex-date follow-up). A receipt dominated by a non-excluded
// override remains intentionally not shown (the owner's edit supersedes
// it).
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
// attached to it.
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
};

export type DerivedDividendRowSource = "auto" | "edited" | "receipt" | "manual";
export type DerivedDividendRowLifecycleStatus =
  "ex_date_passed" | "declared_pending";

export type DominatedReceipt = {
  sharesDecimal: string;
  dividendPerShareDecimal: string;
  frankingPerShareDecimal: string | null;
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
    activeEvents.map((event) => ({
      event,
      referenceDate: event.paymentDate ?? event.exDate!,
    })),
    input.manualRecords,
  );
  const consumedManualIds = new Set(
    [...manualMatches.values()].map((record) => record.id),
  );

  /**
   * Shared manual-vs-receipt precedence (B5: manual wins the row, an
   * outranked receipt is consumed but visible via `dominatedReceipt`) --
   * used both by the main per-event loop (non-excluded events) and the
   * excluded-event resurfacing pass, so the two paths cannot drift apart
   * the way round 2's independent implementations did.
   */
  function resolveOwnerFact(
    manual: DividendManualRecordFact | null,
    receiptResolution: {
      latest: DividendReceiptFact;
      additionalCount: number;
    } | null,
  ): {
    source: "manual" | "receipt";
    sharesDecimal: string;
    dividendPerShareDecimal: string;
    overrideFrankingPerShare: string | null;
    paymentDate: string;
    dominatedReceipt: DominatedReceipt | null;
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
          ? {
              sharesDecimal: receiptResolution.latest.sharesDecimal,
              dividendPerShareDecimal:
                receiptResolution.latest.dividendPerShareDecimal,
              frankingPerShareDecimal:
                receiptResolution.latest.frankingPerShareDecimal,
              paymentDate: receiptResolution.latest.paymentDate,
            }
          : null,
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
        additionalReceiptsCount: receiptResolution.additionalCount,
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
        );
    const status = lifecycleStatus(event.exDate!, input.today);

    let sharesDecimal: string;
    let dividendPerShareDecimal: string | null;
    let overrideFrankingPerShare: string | null;
    let source: DerivedDividendRowSource;
    let excluded = false;
    let dominatedReceipt: DominatedReceipt | null = null;
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
      additionalReceiptsCount,
    });
  }

  for (const record of input.manualRecords) {
    if (consumedManualIds.has(record.id)) continue;
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
      additionalReceiptsCount: 0,
    });
  }

  // Excluded-event resurfacing (B3, fixed for the round-3 double-count):
  // exactly ONE row per excluded event that has a manual match and/or an
  // attached receipt, using the identical manual-wins-over-receipt
  // precedence the non-excluded path uses (`resolveOwnerFact`) so the two
  // owner facts collapse together instead of each producing their own row.
  // An excluded event with neither contributes nothing here (its only row
  // is the excluded, zero-contributing one already pushed above).
  for (const event of activeEvents) {
    if (!excludedEventIds.has(event.id)) continue;
    const ownerFact = resolveOwnerFact(
      manualMatches.get(event.id) ?? null,
      resolveReceipts(event.id),
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
        : (resolveReceipts(event.id)?.latest.id ?? event.id);
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
      additionalReceiptsCount: ownerFact.additionalReceiptsCount,
    });
  }

  return rows;
}
