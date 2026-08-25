/**
 * BUG-001: pure, DB-free display-padding logic for the Capital gains
 * sub-tab, split out of `app/owned-capital-gains.ts` (the DB read service)
 * for exactly the reason `app/price-history-coverage-format.ts` was split
 * from `app/price-history-coverage.ts` (MKT-018B) and
 * `app/price-history-chart-geometry.ts` was split from
 * `app/owned-price-history.ts` (UI-018): the "use client"
 * `app/components/capital-gains-screen.tsx` needs `buildCapitalGainsDisplayRows`
 * as a VALUE import (not just the `OwnedCapitalGainsHistory` type, which
 * erases at build time), and CGT-004 originally added that value import
 * pointing at `app/owned-capital-gains.ts` itself -- which transitively
 * imports `db/repositories/owned-portfolios.ts` (`node:crypto`'s
 * `randomUUID`). `node:crypto` has no browser build, so Vite externalizes
 * it in the client bundle; the resulting `Cannot access
 * "node:crypto.randomUUID" in client code` throws the moment the Capital
 * gains screen renders, not at build time (this is a pure `import`-graph
 * leak, not a type error, so `npm run build`/`tsc` do not catch it --
 * see `tests/bug-001.test.ts` for the generic client-bundle-safety guard
 * this task adds so the NEXT such leak fails a test instead of an owner's
 * browser).
 *
 * This module only ever computes plain, already-derived display rows over
 * caller-supplied data -- it queries nothing, imports nothing DB/Node/
 * Cloudflare-only, and re-derives no CGT figure (see
 * `buildCapitalGainsDisplayRows`'s own doc comment below, moved verbatim
 * from `app/owned-capital-gains.ts`). `app/owned-capital-gains.ts`
 * re-exports the same three symbols from here for backward compatibility
 * with existing server-side/test imports; the client component imports
 * this module directly instead.
 */
import {
  fyWindowForDate,
  fyWindowForEndingYear,
} from "../domain/dividends/fy-window.ts";
import {
  evaluateHistoryCompleteness,
  type FyCapitalGainsTotal,
} from "../domain/gains/index.ts";

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
// change CGT-004 made at all is exporting the existing
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
// FY are unaffected by padding (pinned by CGT-004's own rendered test
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
