// UI-006C: owner-scoped read service for one security's Dividends tab
// (`/portfolio/:id/securities/:portfolioSecurityId/dividends`). Reuses
// DIV-001's already-built, already-tested whole-portfolio composition
// (`loadOwnedDividendHistory`) for the derived rows -- no new derivation
// logic is introduced here, only a single-security selection plus the extra
// raw override/manual-record/assumptions facts the per-row edit dialog
// (UI-006B's `RecordDividendDialog`) needs to pre-fill correctly:
//
// - `overridesByEventId`: the RAW (sparse, possibly null-field) persisted
//   `dividend_event_overrides` row that WINS for a row's CURRENT active
//   event, keyed by that active event's id, with its `version` -- required
//   so re-opening an ALREADY-overridden row sends the correct
//   `expectedVersion` (an UPDATE) rather than a stray `null` (CREATE).
//   Review fix (B1, blocking): an earlier version keyed this map by the
//   override's own STORED `dividendEventId` directly. `DerivedDividendRow
//   .dividendEventId` is always the row's CURRENT ACTIVE event id
//   (`domain/dividends/history.ts` only ever sets it from `activeEvents`),
//   but an override stays keyed to whichever event id was active WHEN THE
//   OWNER CREATED IT (`domain/dividends/event-override-resolution.ts`'s
//   BINDING note) -- a later corporate-action refresh that supersedes that
//   event (a corrected amount) mints a NEW active event id, so a naive
//   direct-key lookup by the row's current id MISSES an override attached
//   to the now-superseded prior version. The tab's prefill then silently
//   sent `expectedVersion: null`, which the repository's `save()` treats as
//   CREATE (its `WHERE NOT EXISTS` guard no-ops rather than erroring) --
//   reachable via nothing more than the ordinary background refresh sweep,
//   with no owner action at fault. Fixed by resolving each row's winning
//   override the IDENTICAL way `deriveDividendHistoryForSecurity` itself
//   does -- `resolveEventOverrideForLineage`, walking the
//   `supersedes_event_id` chain backward from the row's current active event
//   id -- then keying the map by that CURRENT id (matching what every row's
//   `dividendEventId` actually is), with the id/version looked up back
//   against the raw persisted record the resolution matched.
// - `manualRecordsById`: the persisted `dividend_manual_records` row's
//   `version`/`importBatchId` for a standalone (non-event-linked) manual or
//   imported row, keyed by its own id (the suffix of `DerivedDividendRow.id`
//   for `manual:<id>`/`imported:<id>` rows) -- same "correct version for an
//   update, not a stray create" reason. `importBatchId` lets the tab
//   (`app/components/security-dividends-tab.tsx`) recognise an imported row
//   BEFORE ever opening the edit dialog and skip opening it entirely --
//   dividend-assumptions-actions.ts's B1 409 still enforces this
//   server-side as defense in depth, but the tab no longer relies on
//   attempting-then-failing to disclose it (follow-up 2, correcting this
//   comment's earlier "client-side why-did-that-save-fail hint" framing,
//   which described a UI behaviour this task no longer has).
// - `assumptions`/`portfolioAssumptions`: this security's and the whole
//   portfolio's current dividend-assumptions-grid row, so the tab's visible
//   "franking if not known" default can be edited and saved through the
//   IDENTICAL whole-grid endpoint UI-006B's editor uses
//   (`saveDividendAssumptionsGridWithContext`, which always replaces a
//   security row/portfolio row in full) without silently nulling out this
//   security's yield/growth inputs or the portfolio's growth inputs that the
//   franking-only edit never intended to touch.
//
// SOLD SHARES: `loadOwnedDividendHistory` selects `portfolio_securities`
// WHERE `status = 'held'` -- but `portfolio_securities.status` has no
// "closed"/"sold" state at all (`db/schema.ts`'s check constraint is
// `'held' | 'watch' | 'hidden' | 'unresolved'`), so a fully-exited holding
// stays `status = 'held'` at zero current quantity forever; it is never
// excluded by this filter. DIV-001's derivation is itself quantity-agnostic
// (`deriveSharesHeldAtDate` naturally resolves to "0" once every share is
// sold), so a fully-sold security's full dividend history and lifetime
// totals load and total exactly as they did before the sale -- no special
// "closed position" code path is needed for genuine pre-sale dividends to
// survive the sale.
//
// Orchestrator ruling (post-review follow-up 1): a provider event dated
// AFTER a full exit is a "no new dividend" ARTIFACT, not a real one -- the
// owner never held shares for it, so its auto-derived row is always shares
// "0"/cash "0" and adds only noise. DIV-001's domain layer stays unchanged
// (a portfolio-wide consumer may still want the raw row); THIS presentation
// layer filters `source: "auto"` rows with `sharesDecimal === "0"` out of
// the TAB's rendered list and recomputes `lifetimeTotals` from the filtered
// set (`computeLifetimeDividendTotals` is a pure function of whatever row
// list it is given) so the unknown-amount/franking counts reflect only real
// dividends. Filtering can only ever remove a "0"-contributing row, so the
// dollar totals themselves are unaffected. An "edited" row can never be
// zero-share this way -- `isPositiveDecimalString` rejects a zero override
// shares value server-side -- so this filter cannot hide an owner's
// explicit correction.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  createDividendAssumptionsRepository,
  createDividendEventOverrideRepository,
  createDividendImportFrankingOverrideRepository,
  createDividendManualRecordRepository,
} from "../db/repositories/dividends.ts";
import { loadOwnedDividendHistory } from "./owned-dividend-history.ts";
import {
  computeLifetimeDividendTotals,
  resolveEventOverrideForLineage,
  type DerivedDividendRow,
  type EventOverrideFact,
  type EventOverrideLineageNode,
  type LifetimeDividendTotals,
} from "../domain/dividends/index.ts";

type Row = Record<string, unknown>;
const MAX_EVENTS_PER_SECURITY = 20_000;

export type OwnedSecurityDividendOverrideFact = {
  id: string;
  version: number;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  exclude: boolean;
  /**
   * The override's OWN persisted `dividend_event_id` -- NOT necessarily the
   * same as the map's key (the row's CURRENT active event id after this
   * fix). `dividend_event_overrides` stays keyed to whichever event id was
   * active when the owner created it (never rewritten/re-keyed by a later
   * supersession -- `event-override-resolution.ts`'s BINDING note), and the
   * repository's `save()` UPDATE targets a row by this exact stored id, not
   * by whatever the security's CURRENT active event happens to be. A save
   * MUST reuse this value as `dividendEventId`, never the map's own key,
   * or the UPDATE's `WHERE ... AND dividend_event_id = ?` matches zero rows
   * (404 "not found") even though the resolved override is correct.
   */
  storedDividendEventId: string;
};

export type OwnedSecurityDividendManualFact = {
  version: number;
  importBatchId: string | null;
};

/** BRK-011: the owner's persisted franking-currency override for one
 * imported record, when one exists -- keyed by `dividendManualRecordId` in
 * `OwnedSecurityDividendDetail.frankingOverridesByManualRecordId` so the
 * tab's entry point can pre-fill an ALREADY-overridden row's edit form with
 * the correct `expectedVersion` (an update, never a stray create). */
export type OwnedSecurityDividendFrankingOverrideFact = {
  id: string;
  version: number;
  frankingTotalDecimal: string;
};

export type OwnedSecurityDividendAssumptions = {
  dividendYieldPercentDecimal: string | null;
  frankingPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  version: number | null;
};

export type OwnedSecurityDividendPortfolioAssumptions = {
  valueGrowthPercentDecimal: string | null;
  portfolioDividendGrowthPercentDecimal: string | null;
  version: number | null;
};

export type OwnedSecurityDividendDetail = {
  portfolioSecurityId: string;
  securityId: string;
  symbol: string;
  currencyCode: string;
  today: string;
  rows: DerivedDividendRow[];
  /** Count of post-exit zero-share auto rows suppressed from `rows` (see the
   * module header's Orchestrator ruling) -- lets the tab distinguish "no
   * dividend history at all" from "every dividend event for this security
   * was a post-exit artifact" for its empty-state wording (review follow-up
   * 2: the two cases mean different things and should not share one
   * message). */
  filteredArtifactCount: number;
  lifetimeTotals: LifetimeDividendTotals;
  overridesByEventId: Record<string, OwnedSecurityDividendOverrideFact>;
  manualRecordsById: Record<string, OwnedSecurityDividendManualFact>;
  /** BRK-011: keyed by `dividendManualRecordId` -- see
   * `OwnedSecurityDividendFrankingOverrideFact`'s doc comment. */
  frankingOverridesByManualRecordId: Record<
    string,
    OwnedSecurityDividendFrankingOverrideFact
  >;
  assumptions: OwnedSecurityDividendAssumptions;
  portfolioAssumptions: OwnedSecurityDividendPortfolioAssumptions;
};

export async function loadOwnedSecurityDividendDetail(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  portfolioSecurityId: string,
  now = new Date(),
): Promise<OwnedSecurityDividendDetail> {
  const identity = await client.get<{ id: string }>(
    `SELECT ps.id FROM portfolio_securities ps
     WHERE ps.id = ? AND ps.user_id = ? AND ps.portfolio_id = ?
       AND ps.security_id IS NOT NULL
     LIMIT 1`,
    [portfolioSecurityId, userId, portfolioId],
  );
  if (!identity) throw new Error("not_found");

  // Reuses DIV-001's whole-portfolio composition rather than duplicating its
  // batched events/overrides/manual/receipts/transactions derivation -- see
  // the module header. Bounded by that function's own MAX_SECURITIES/etc
  // caps.
  const full = await loadOwnedDividendHistory(client, userId, portfolioId, now);
  const security = full.securities.find(
    (row) => row.portfolioSecurityId === portfolioSecurityId,
  );
  if (!security) throw new Error("not_dividend_eligible");

  const assumptionsRepository = createDividendAssumptionsRepository(client);
  const [
    eventRows,
    overrideRecords,
    manualRecords,
    frankingOverrideRecords,
    securityAssumptions,
    portfolioAssumptions,
  ] = await Promise.all([
    // Every event (active AND superseded) for this security, needed to walk
    // the supersession lineage (B1 fix) -- matches
    // `owned-dividend-history.ts`'s own events query, narrowed to one
    // security.
    client.all<Row>(
      `SELECT id, supersedes_event_id FROM dividend_events
       WHERE security_id = ? LIMIT ?`,
      [security.securityId, MAX_EVENTS_PER_SECURITY + 1],
    ),
    createDividendEventOverrideRepository(client).list(
      userId,
      portfolioId,
      portfolioSecurityId,
    ),
    createDividendManualRecordRepository(client).list(
      userId,
      portfolioId,
      portfolioSecurityId,
    ),
    createDividendImportFrankingOverrideRepository(client).list(
      userId,
      portfolioId,
      portfolioSecurityId,
    ),
    assumptionsRepository.getSecurityAssumptions(
      userId,
      portfolioId,
      portfolioSecurityId,
    ),
    assumptionsRepository.getPortfolioAssumptions(userId, portfolioId),
  ]);
  if (eventRows.length > MAX_EVENTS_PER_SECURITY) {
    throw new Error("too_many_dividend_events");
  }

  // B1 fix: resolve each row's WINNING override the identical way
  // `deriveDividendHistoryForSecurity` does (`resolveEventOverrideForLineage`,
  // walking `supersedes_event_id` backward from the row's CURRENT active
  // event id), then key the result by that current id -- never by the
  // override's own stored (possibly since-superseded) `dividendEventId`. See
  // the module header for the full defect this replaces.
  const lineageNodes: EventOverrideLineageNode[] = eventRows.map((row) => ({
    id: String(row.id),
    supersedesEventId:
      row.supersedes_event_id === null ? null : String(row.supersedes_event_id),
  }));
  const overrideFacts: EventOverrideFact[] = overrideRecords.map(
    (override) => ({
      dividendEventId: override.dividendEventId,
      sharesDecimal: override.sharesDecimal,
      dividendPerShareDecimal: override.dividendPerShareDecimal,
      frankingCreditPerShareDecimal: override.frankingCreditPerShareDecimal,
      exclude: override.exclude,
    }),
  );
  const overrideRecordByStoredEventId = new Map(
    overrideRecords.map((override) => [override.dividendEventId, override]),
  );
  const activeEventIds = [
    ...new Set(
      security.rows
        .map((row) => row.dividendEventId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const overridesByEventId: Record<string, OwnedSecurityDividendOverrideFact> =
    {};
  for (const activeEventId of activeEventIds) {
    const resolved = resolveEventOverrideForLineage(
      lineageNodes,
      activeEventId,
      overrideFacts,
    );
    if (!resolved) continue;
    // `resolved.dividendEventId` is whichever lineage id the override was
    // actually STORED against -- look the raw record back up by that id to
    // recover its id/version (never available on the resolved fact itself).
    const record = overrideRecordByStoredEventId.get(resolved.dividendEventId);
    if (!record) continue; // defensive; the resolver only ever returns a fact sourced from overrideFacts above
    overridesByEventId[activeEventId] = {
      id: record.id,
      version: record.version,
      sharesDecimal: record.sharesDecimal,
      dividendPerShareDecimal: record.dividendPerShareDecimal,
      frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
      exclude: record.exclude,
      storedDividendEventId: record.dividendEventId,
    };
  }

  const manualRecordsById: Record<string, OwnedSecurityDividendManualFact> = {};
  for (const record of manualRecords) {
    manualRecordsById[record.id] = {
      version: record.version,
      importBatchId: record.importBatchId,
    };
  }

  const frankingOverridesByManualRecordId: Record<
    string,
    OwnedSecurityDividendFrankingOverrideFact
  > = {};
  for (const override of frankingOverrideRecords) {
    frankingOverridesByManualRecordId[override.dividendManualRecordId] = {
      id: override.id,
      version: override.version,
      frankingTotalDecimal: override.frankingTotalDecimal,
    };
  }

  // Orchestrator ruling (follow-up 1): drop post-exit "no new dividend"
  // artifacts from the TAB's view and recompute lifetime totals from the
  // filtered set -- see the module header.
  const visibleRows = security.rows.filter(
    (row) => !(row.source === "auto" && row.sharesDecimal === "0"),
  );
  const lifetimeTotals =
    visibleRows.length === security.rows.length
      ? security.lifetimeTotals
      : computeLifetimeDividendTotals(visibleRows, security.currencyCode);

  return {
    portfolioSecurityId: security.portfolioSecurityId,
    securityId: security.securityId,
    symbol: security.symbol,
    currencyCode: security.currencyCode,
    today: full.today,
    rows: visibleRows,
    filteredArtifactCount: security.rows.length - visibleRows.length,
    lifetimeTotals,
    overridesByEventId,
    manualRecordsById,
    frankingOverridesByManualRecordId,
    assumptions: {
      dividendYieldPercentDecimal:
        securityAssumptions?.dividendYieldPercentDecimal ?? null,
      frankingPercentDecimal:
        securityAssumptions?.frankingPercentDecimal ?? null,
      dividendGrowthPercentDecimal:
        securityAssumptions?.dividendGrowthPercentDecimal ?? null,
      version: securityAssumptions?.version ?? null,
    },
    portfolioAssumptions: {
      valueGrowthPercentDecimal:
        portfolioAssumptions?.valueGrowthPercentDecimal ?? null,
      portfolioDividendGrowthPercentDecimal:
        portfolioAssumptions?.portfolioDividendGrowthPercentDecimal ?? null,
      version: portfolioAssumptions?.version ?? null,
    },
  };
}
