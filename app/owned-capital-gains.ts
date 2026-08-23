// CGT-001A: owner-scoped read service composing the ledger's published
// projection tables (`tax_lots`, `lot_allocations`, DB-004/LED-002B) into
// the pure `domain/gains` per-disposal/per-FY calculations. Mirrors
// `app/owned-holdings.ts`'s (holdings) and `app/owned-dividend-history.ts`'s
// (dividends) composition pattern: this module owns SqlClient access and
// owner-scope predicates; every actual eligibility/aggregation rule lives
// in the pure `domain/gains` modules this file only composes. Read-only --
// no writes. UI-030 (the holdings row's "Realised:" line) now also composes
// this module's shared disposal-row loader via `loadOwnedRealisedGainTotals`
// below, alongside the Gains tab's `loadOwnedCapitalGains`.
//
// Publication-pointer discipline (identical requirement to
// `app/owned-holdings.ts`): `lot_allocations`/`tax_lots` are written by
// EVERY calculation run attempt, including superseded/stale ones -- only
// the run referenced by the single current `projection_publications` row
// for this portfolio is the CURRENT, trustworthy one. This module reads
// allocations WHERE calculation_run_id = <the published run id> exactly
// like holdings reads `holding_projections` the same way, so a stale or
// partially-completed run's rows are structurally invisible (never even
// selected), not filtered out after the fact.
//
// Empty-state short-circuit: a portfolio that has never posted an active
// (non-reversed) 'sell' transaction cannot have any `lot_allocations` rows
// regardless of whether a calculation run/publication exists yet (a
// brand-new portfolio has neither) -- this returns the ordinary empty
// "no disposals yet" state without requiring a publication, mirroring
// `loadOwnedHoldings`'s zero-held-securities short-circuit. Once an active
// sell exists, a valid current publication is REQUIRED (same checks as
// holdings); its absence is a typed failure (calculation not yet
// published), not a silent empty result -- a real disposal must never
// silently read as "no disposals yet".
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios.ts";
import { currentFyWindow } from "../domain/calculations/financial-year.ts";
import { parseDecimalResult } from "../domain/calculations/decimal.ts";
import {
  fyWindowForDate,
  fyWindowForEndingYear,
} from "../domain/dividends/fy-window.ts";
import {
  computeFyCapitalGainsTotals,
  computeSecurityRealisedGainTotals,
  deriveCapitalGainDisposalRow,
  evaluateHistoryCompleteness,
  type CapitalGainAllocationFact,
  type CapitalGainDisposalRow,
  type FyCapitalGainsTotal,
  type SecurityRealisedGainTotal,
} from "../domain/gains/index.ts";

const MAX_ALLOCATIONS = 10_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Matches `app/owned-holdings.ts`'s own `DECIMAL` boundary pattern exactly.
// Quantity/basis/proceeds/fee/tax are never negative in the ledger's model;
// `base_realised_gain_decimal` alone can be a loss, so it gets the signed
// variant.
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

type Row = Record<string, unknown>;

export type OwnedCapitalGainsHistory = {
  today: string;
  financialYearStartMonth: number;
  baseCurrencyCode: string;
  disposalCount: number;
  /** Sorted newest-FY-first, mirroring `app/owned-dividend-history.ts`. Empty when there have been no disposals at all. */
  fyTotals: FyCapitalGainsTotal[];
  /**
   * `portfolios.history_complete_from` verbatim (a `YYYY-MM-DD` local
   * calendar date, or `null` when never declared) -- CGT-002's carry-forward
   * chain (`domain/gains/carry-forward.ts`) needs this to decide whether the
   * chain can be trusted back to the earliest disposal FY. Passed through
   * raw rather than pre-computed here so the screen composes the same pure
   * `computeCapitalGainsCarryChain` function it already composes
   * `computeLifetimeCapitalGainsTotal` with.
   */
  historyCompleteFrom: string | null;
  /**
   * CGT-004 (review ruling B2): the portfolio's earliest recorded ledger
   * transaction date (`posted`/`reversed`, tie-broken by id -- the same
   * evidence resolution `db/repositories/snapshots.ts`'s
   * `resolveSnapshotRunRange` and `db/repositories/import-commit.ts`'s
   * `finalize` already use), or `null` if this portfolio has no
   * transactions at all. `buildCapitalGainsDisplayRows` uses this as the
   * fallback completeness boundary ONLY when `historyCompleteFrom` above is
   * unset -- a declared boundary always wins once set. Evidence-based, not
   * declared: the mere existence of a recorded transaction on/after a date
   * proves the ledger was actively tracking this portfolio by then, so a
   * padded year starting on/after this date with no disposal row is a real,
   * known zero -- never a fabricated one.
   */
  earliestTradeDate: string | null;
};

function field(row: Row, key: string): unknown {
  return row[key];
}
function requiredText(row: Row, key: string, pattern?: RegExp): string {
  const value = field(row, key);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (pattern && !pattern.test(value))
  )
    throw new Error(`invalid_${key}`);
  return value;
}
function optionalText(row: Row, key: string, pattern?: RegExp): string | null {
  const value = field(row, key);
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || (pattern && !pattern.test(value)))
    throw new Error(`invalid_${key}`);
  return value;
}
function integer(row: Row, key: string): number {
  const value = field(row, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid_${key}`);
  return value;
}
// Reviewer fix (round 2): validate money-shaped columns at the SQL
// boundary, mirroring `app/owned-holdings.ts`'s `sourceDecimal`/
// `resultDecimal` -- a typed `invalid_<key>` failure here, not an
// `optionalText` pass-through that only surfaces as an opaque
// "Invalid decimal string." once `domain/gains` tries to parse it
// downstream.
function requiredDecimal(row: Row, key: string): string {
  const value = requiredText(row, key, UNSIGNED_DECIMAL);
  parseDecimalResult(value);
  return value;
}
function optionalDecimal(
  row: Row,
  key: string,
  pattern: RegExp,
): string | null {
  const value = optionalText(row, key, pattern);
  if (value === null) return null;
  parseDecimalResult(value);
  return value;
}
function basisStatusValue(row: Row): CapitalGainAllocationFact["basisStatus"] {
  const value = requiredText(row, "basis_status");
  if (
    value !== "complete" &&
    value !== "incomplete_fx" &&
    value !== "incomplete_basis"
  )
    throw new Error("invalid_basis_status");
  return value;
}

// UI-030: shared shape returned by the internal loader below -- both
// `loadOwnedCapitalGains` (FY-bucketed, for the Gains tab) and
// `loadOwnedRealisedGainTotals` (security-bucketed, for the holdings row's
// fourth line) build on the SAME single SQL read/validation pass and the
// SAME already-derived `rows: CapitalGainDisposalRow[]` list -- neither
// re-queries the ledger nor re-derives a row.
type CapitalGainDisposalRowsResult = {
  today: string;
  financialYearStartMonth: number;
  baseCurrencyCode: string;
  historyCompleteFrom: string | null;
  earliestTradeDate: string | null;
  rows: CapitalGainDisposalRow[];
};

async function loadCapitalGainDisposalRows(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now: Date,
): Promise<CapitalGainDisposalRowsResult> {
  // CGT-004 (review ruling B2): `earliest_trade_date` is resolved in the
  // SAME query as the portfolio's own columns (one round trip, not two),
  // mirroring `db/repositories/snapshots.ts`'s `resolveSnapshotRunRange`
  // and `db/repositories/import-commit.ts`'s `finalize` -- same
  // posted/reversed status filter, same ORDER BY local_trade_date ASC, id
  // ASC tie-break, deliberately including reversed transactions (a
  // transaction that existed and was later reversed is still evidence the
  // ledger was actively tracking this portfolio on that date).
  const portfolio = await client.get<Row>(
    `SELECT p.base_currency_code, p.history_complete_from,
            (SELECT t.local_trade_date FROM transactions t
             WHERE t.user_id = p.user_id AND t.portfolio_id = p.id
               AND t.status IN ('posted', 'reversed')
             ORDER BY t.local_trade_date ASC, t.id ASC LIMIT 1) AS earliest_trade_date
     FROM portfolios p WHERE p.id = ? AND p.user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) throw new Error("not_owned");
  const baseCurrencyCode = requiredText(portfolio, "base_currency_code");
  const historyCompleteFrom = optionalText(
    portfolio,
    "history_complete_from",
    DATE,
  );
  const earliestTradeDate = optionalText(
    portfolio,
    "earliest_trade_date",
    DATE,
  );

  const settings = await createOwnedUserSettingsRepository(client).get(userId);
  if (!settings) throw new Error("missing_user_settings");
  const currentWindow = currentFyWindow(
    now.toISOString(),
    settings.financialYearStartMonth,
    settings.timezone,
  );
  if (!currentWindow.ok)
    throw new Error(`invalid_fy_window:${currentWindow.reason}`);
  const today = currentWindow.window.endDate;

  const activeSellCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM transactions t
     WHERE t.user_id = ? AND t.portfolio_id = ? AND t.type = 'sell'
       AND t.status IN ('posted', 'reversed') AND t.reverses_transaction_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM transactions r
         WHERE r.user_id = t.user_id AND r.portfolio_id = t.portfolio_id
           AND r.reverses_transaction_id = t.id AND r.status IN ('posted', 'reversed')
       )`,
    [userId, portfolioId],
  );
  const activeSellCount = integer(activeSellCountRow ?? {}, "count");
  if (activeSellCount === 0) {
    return {
      today,
      financialYearStartMonth: settings.financialYearStartMonth,
      baseCurrencyCode,
      historyCompleteFrom,
      earliestTradeDate,
      rows: [],
    };
  }

  const publicationCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM projection_publications pp WHERE pp.user_id = ? AND pp.portfolio_id = ?`,
    [userId, portfolioId],
  );
  if (integer(publicationCountRow ?? {}, "count") !== 1)
    throw new Error("invalid_projection_publication_count");
  const publication = await client.get<Row>(
    `SELECT pp.calculation_run_id, pp.calculation_version, pp.ledger_high_water,
            r.status AS run_status, r.calculation_version AS run_version,
            r.ledger_high_water_end
     FROM projection_publications pp
     JOIN calculation_runs r
       ON r.id = pp.calculation_run_id AND r.user_id = pp.user_id AND r.portfolio_id = pp.portfolio_id
     WHERE pp.user_id = ? AND pp.portfolio_id = ? LIMIT 1`,
    [userId, portfolioId],
  );
  if (!publication) throw new Error("missing_projection_publication");
  const runId = requiredText(publication, "calculation_run_id");
  const version = integer(publication, "calculation_version");
  if (
    requiredText(publication, "run_status") !== "completed" ||
    integer(publication, "run_version") !== version ||
    requiredText(publication, "ledger_high_water") !==
      requiredText(publication, "ledger_high_water_end")
  )
    throw new Error("invalid_projection_publication");

  const allocationCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM lot_allocations
     WHERE user_id = ? AND portfolio_id = ? AND calculation_run_id = ?`,
    [userId, portfolioId, runId],
  );
  const allocationCount = integer(allocationCountRow ?? {}, "count");
  if (allocationCount > MAX_ALLOCATIONS)
    throw new Error("too_many_allocations");

  const allocationRows = await client.all<Row>(
    `SELECT la.id AS allocation_id, la.portfolio_security_id,
            la.matched_quantity_decimal, la.allocated_base_basis_decimal,
            la.base_net_proceeds_decimal, la.fee_base_decimal,
            la.tax_base_decimal, la.base_realised_gain_decimal, la.basis_status,
            opening.local_trade_date AS acquired_date,
            sell.local_trade_date AS disposed_date,
            COALESCE(ps.display_symbol, ps.source_symbol) AS symbol,
            COALESCE(ps.display_name, s.canonical_name, ps.source_name, ps.source_symbol) AS name
     FROM lot_allocations la
     JOIN tax_lots tl
       ON tl.id = la.tax_lot_id AND tl.user_id = la.user_id
      AND tl.portfolio_id = la.portfolio_id AND tl.portfolio_security_id = la.portfolio_security_id
      AND tl.calculation_run_id = la.calculation_run_id
     JOIN transactions opening
       ON opening.id = tl.opening_transaction_id AND opening.user_id = la.user_id
      AND opening.portfolio_id = la.portfolio_id
     JOIN transactions sell
       ON sell.id = la.sell_transaction_id AND sell.user_id = la.user_id
      AND sell.portfolio_id = la.portfolio_id
     JOIN portfolio_securities ps
       ON ps.id = la.portfolio_security_id AND ps.user_id = la.user_id AND ps.portfolio_id = la.portfolio_id
     LEFT JOIN securities s ON s.id = ps.security_id
     WHERE la.user_id = ? AND la.portfolio_id = ? AND la.calculation_run_id = ?
     ORDER BY sell.local_trade_date, la.sell_transaction_id, la.allocation_sequence
     LIMIT ?`,
    [userId, portfolioId, runId, MAX_ALLOCATIONS + 1],
  );
  if (allocationRows.length > MAX_ALLOCATIONS)
    throw new Error("too_many_allocations");
  // Every JOIN above is a hard requirement (a lot allocation's acquisition
  // and disposal dates must always be resolvable via its tax lot's opening
  // transaction and its own sell transaction) -- if the joined row count
  // does not match the allocation count for this run, some allocation's
  // dates are unavailable. That "shouldn't happen" per CGT-001A's ruling,
  // so this fails typed/closed rather than silently under-reporting
  // disposals.
  if (allocationRows.length !== allocationCount)
    throw new Error("missing_allocation_dates");

  const facts: CapitalGainAllocationFact[] = allocationRows.map((row) => ({
    allocationId: requiredText(row, "allocation_id"),
    portfolioSecurityId: requiredText(row, "portfolio_security_id"),
    securitySymbol: requiredText(row, "symbol"),
    securityName: requiredText(row, "name"),
    acquiredDate: requiredText(row, "acquired_date", DATE),
    disposedDate: requiredText(row, "disposed_date", DATE),
    matchedQuantityDecimal: requiredDecimal(row, "matched_quantity_decimal"),
    allocatedBaseBasisDecimal: optionalDecimal(
      row,
      "allocated_base_basis_decimal",
      UNSIGNED_DECIMAL,
    ),
    baseNetProceedsDecimal: optionalDecimal(
      row,
      "base_net_proceeds_decimal",
      UNSIGNED_DECIMAL,
    ),
    feeBaseDecimal: optionalDecimal(row, "fee_base_decimal", UNSIGNED_DECIMAL),
    taxBaseDecimal: optionalDecimal(row, "tax_base_decimal", UNSIGNED_DECIMAL),
    baseRealisedGainDecimal: optionalDecimal(
      row,
      "base_realised_gain_decimal",
      SIGNED_DECIMAL,
    ),
    basisStatus: basisStatusValue(row),
  }));

  const rows: CapitalGainDisposalRow[] = facts.map((fact) => {
    const result = deriveCapitalGainDisposalRow(fact);
    if (!result.ok)
      throw new Error(`invalid_allocation_dates:${result.reason}`);
    return result.row;
  });

  return {
    today,
    financialYearStartMonth: settings.financialYearStartMonth,
    baseCurrencyCode,
    historyCompleteFrom,
    earliestTradeDate,
    rows,
  };
}

export async function loadOwnedCapitalGains(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
): Promise<OwnedCapitalGainsHistory> {
  const base = await loadCapitalGainDisposalRows(
    client,
    userId,
    portfolioId,
    now,
  );

  const fyResult = computeFyCapitalGainsTotals(
    base.rows,
    base.financialYearStartMonth,
  );
  if (!fyResult.ok)
    throw new Error(`invalid_fy_aggregation:${fyResult.reason}`);

  return {
    today: base.today,
    financialYearStartMonth: base.financialYearStartMonth,
    baseCurrencyCode: base.baseCurrencyCode,
    disposalCount: base.rows.length,
    fyTotals: fyResult.totals,
    historyCompleteFrom: base.historyCompleteFrom,
    earliestTradeDate: base.earliestTradeDate,
  };
}

// UI-030: portfolio-wide, per-security LIFETIME realised-gain rollup for
// the holdings row's fourth ("Realised:") line -- see
// `domain/gains/security-totals.ts`'s header for the full design rationale
// (one batched read, reusable map, no FIFO recomputation). `bySecurity` has
// no entry at all for a security that was never sold; see
// `SecurityRealisedGainTotal`'s own doc comments for how a caller should
// read `partialCoverage`/`knownDisposalCount` before trusting `gainDecimal`
// or `percentDecimal` as a COMPLETE figure.
export type OwnedRealisedGainTotals = {
  baseCurrencyCode: string;
  historyCompleteFrom: string | null;
  bySecurity: Map<string, SecurityRealisedGainTotal>;
};

export async function loadOwnedRealisedGainTotals(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
): Promise<OwnedRealisedGainTotals> {
  const base = await loadCapitalGainDisposalRows(
    client,
    userId,
    portfolioId,
    now,
  );
  return {
    baseCurrencyCode: base.baseCurrencyCode,
    historyCompleteFrom: base.historyCompleteFrom,
    bySecurity: computeSecurityRealisedGainTotals(base.rows),
  };
}

// CGT-004 (owner directive, verbatim): "For the Capital gains sub-tab
// increase the number of years to 10 years." Before this, the Gains tab's
// per-FY table showed exactly the financial years that contain at least
// one disposal allocation -- `computeFyCapitalGainsTotals`'s own "a
// financial year with zero disposal rows is simply not returned (no
// fabricated zero year)" rule (`domain/gains/fy-aggregation.ts`). That is
// correct as a MATH rule (never invent a real figure for a year with no
// evidence) but left no lower bound on how many years render: a portfolio
// whose disposal history spans two or three years showed only two or
// three rows, with no way to see "this is a full decade of activity, most
// of it quiet" versus "the ledger simply has not been going that long".
//
// This function is a pure, APP-LAYER, DISPLAY-ONLY padding step -- it
// never re-derives or adjusts a single CGT figure. (The only `domain/gains`
// change this task makes at all is exporting the existing
// `evaluateHistoryCompleteness` predicate below, unchanged, for direct
// reuse here instead of a second, potentially-diverging copy of the same
// comparison -- CGT-004 review fold ruling; no calculation anywhere
// changed.) It pads `fyTotals` out so the screen always has a row for
// each of the `CAPITAL_GAINS_DISPLAY_YEARS` most recent financial years
// (this FY back `CAPITAL_GAINS_DISPLAY_YEARS - 1` more), filling any of
// those years that have no real disposal row with an honest placeholder --
// never a fabricated real figure. Every REAL disposal FY is always kept
// even when it falls outside that recent window: this only ever ADDS rows,
// it never truncates real ones (a portfolio with 15 years of disposal
// history keeps all 15 real rows).
//
// Two placeholder tiers, reusing `domain/gains/carry-forward.ts`'s exported
// `evaluateHistoryCompleteness` predicate directly (not re-derived) for the
// underlying "is this reference date covered by the completeness boundary"
// boolean -- CGT-004 review ruling B2:
//   - `no_disposals`: the completeness boundary (below) is on/before this
//     FY's start date, so this whole FY is a declared-or-evidenced-complete
//     record -- the absence of any disposal row for it is a real, known
//     fact (a true zero), safe to show as "no disposals recorded".
//   - `unknown`: the boundary is unset or later than this FY's start date
//     -- whether this FY had real disposals is genuinely unknown, so it is
//     never shown as a zero, and its wording never claims "before recorded
//     history" (a gap year sandwiched between two REAL disposal years, or
//     the still-open current FY, both fail that literal claim).
//
// Completeness boundary (B2 ruling): `historyCompleteFrom` when the owner
// has declared one -- it ALWAYS wins once set, even where it makes a year
// `unknown`, never silently overridden by evidence. Only when
// `historyCompleteFrom` is `null` does this fall back to
// `earliestTradeDate` (the portfolio's own earliest recorded ledger
// transaction -- real evidence the ledger was tracking activity by then,
// same posted/reversed resolution as `resolveSnapshotRunRange`/
// `import-commit.ts`'s `finalize`). This mirrors the DIV-008 "evidence over
// declaration" philosophy: a fully-synced ledger with no explicit
// `history_complete_from` declaration no longer renders as nine unknown
// years out of ten.
//
// `isCurrentFy` (fold ruling): the still-open, in-progress FY (this FY, not
// yet closed) is marked distinctly so the screen can say "so far" rather
// than implicitly claiming a finished year's worth of coverage, and never
// claims "Full" basis coverage for a year that has not finished yet.
//
// The carry-forward chain (`computeCapitalGainsCarryChain`, called by the
// screen) is always fed the ORIGINAL, unpadded `fyTotals` array exactly as
// before this task -- padding rows never enter the chain, so
// `earliestFyStartDate`/`historyComplete`/every carried figure for a real
// FY are unaffected by padding (pinned by this task's own rendered test
// asserting the real FY's figures are unchanged when padding rows surround
// it -- see `tests/cgt-004.test.ts`). Placeholder rows themselves NEVER
// show a brought-forward/applied/carried-out figure, even for the
// `no_disposals` tier: a real loss CAN legitimately pass through a
// no-disposal year unchanged (this FY contributes nothing, but an earlier
// FY's unabsorbed loss still carries through it to the next FY that has
// one) -- since this function deliberately never computes that pass-through
// for a padding row, claiming "nothing to carry" would be a FALSE
// assertion. The carry columns instead render an honest not-computed
// state (B1 review ruling).
export const CAPITAL_GAINS_DISPLAY_YEARS = 10;

export type CapitalGainsDisplayFyRow =
  | { kind: "data"; endingYear: number; fy: FyCapitalGainsTotal }
  | {
      kind: "no_disposals";
      endingYear: number;
      label: string;
      isCurrentFy: boolean;
    }
  | {
      kind: "unknown";
      endingYear: number;
      label: string;
      isCurrentFy: boolean;
    };

export function buildCapitalGainsDisplayRows(history: {
  fyTotals: readonly FyCapitalGainsTotal[];
  today: string;
  financialYearStartMonth: number;
  historyCompleteFrom: string | null;
  earliestTradeDate: string | null;
}): CapitalGainsDisplayFyRow[] {
  const rowsByYear = new Map<number, CapitalGainsDisplayFyRow>();
  for (const fy of history.fyTotals) {
    rowsByYear.set(fy.endingYear, {
      kind: "data",
      endingYear: fy.endingYear,
      fy,
    });
  }

  // Fails closed: an unresolvable "today"/start month combination (should
  // not happen -- both are already validated by `loadOwnedCapitalGains`,
  // but a hand-built fixture could pass anything) simply skips padding
  // rather than throwing the whole screen -- every real FY still renders.
  const currentResolved = fyWindowForDate(
    history.today,
    history.financialYearStartMonth,
  );
  if (currentResolved.ok) {
    // B2 ruling: a declared boundary always wins once set; only fall back
    // to evidence (the earliest recorded transaction) when nothing was
    // declared at all.
    const boundary = history.historyCompleteFrom ?? history.earliestTradeDate;
    for (
      let yearsAgo = 0;
      yearsAgo < CAPITAL_GAINS_DISPLAY_YEARS;
      yearsAgo += 1
    ) {
      const endingYear = currentResolved.endingYear - yearsAgo;
      if (rowsByYear.has(endingYear)) continue; // real data already covers this FY
      const resolved = fyWindowForEndingYear(
        endingYear,
        history.financialYearStartMonth,
      );
      if (!resolved.ok) continue;
      const isCurrentFy = yearsAgo === 0;
      const known = evaluateHistoryCompleteness(
        boundary,
        resolved.window.startDate,
      ).complete;
      rowsByYear.set(
        endingYear,
        known
          ? {
              kind: "no_disposals",
              endingYear,
              label: resolved.label,
              isCurrentFy,
            }
          : {
              kind: "unknown",
              endingYear,
              label: resolved.label,
              isCurrentFy,
            },
      );
    }
  }

  return [...rowsByYear.values()].sort(
    (left, right) => right.endingYear - left.endingYear,
  );
}
