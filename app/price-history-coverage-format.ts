/**
 * MKT-018B (guided flow) — pure types/classification/display formatting for
 * the "Download price history" coverage panel, kept in a PLAIN `.ts` module
 * deliberately separate from `app/price-history-coverage.ts` (the DB read)
 * so the "use client" panel (`app/components/historical-data-panel.tsx`)
 * never pulls a server-only module into the client bundle -- mirrors
 * `app/price-history-chart-geometry.ts`'s existing split from
 * `app/owned-price-history.ts` for the UI-018 chart. `price-history-
 * coverage.ts`'s dynamic `import("./portfolio-actions.ts")` transitively
 * reaches `db/d1-sql-client.ts`'s `cloudflare:workers` import; a client
 * component importing that file directly (even for an unrelated pure
 * export) fails the production client-bundle build with an unresolved
 * `cloudflare:workers` import (verified: this split was added specifically
 * because `npm run build` failed that way before it).
 */
import { dateDayOffset } from "./price-history-chart-geometry.ts";

const INTELLIGENT_INVESTOR_SHARE_HOST =
  "https://www.intelligentinvestor.com.au/shares/asx-";

/**
 * Review ruling B1(b), 2026-08-24: day-to-day price freshness is the LIVE
 * capture pipeline's job (MKT-011A's intraday sweep / Sharesight's 10-minute
 * gate) -- this panel exists to catch a BULK CSV-backfill gap, not to nag
 * about ordinary next-day lag. 30 days deliberately ignores routine
 * day-to-day/weekend/holiday lag and only flags a genuinely stale or
 * abandoned history (see `classifyPriceHistoryCoverage`'s doc comment for
 * the full rule, and `docs/MARKET_DATA_STRATEGY.md` §24 for the same
 * rationale recorded normatively).
 */
export const TRAILING_STALENESS_DAYS = 30;

export type PriceHistoryCoverageClassification = "zero" | "partial" | "covered";

export type PriceHistoryCoverageRow = Readonly<{
  portfolioSecurityId: string;
  securityId: string;
  ticker: string;
  name: string;
  observationCount: number;
  firstObservationDate: string | null;
  lastObservationDate: string | null;
  firstTransactionDate: string | null;
  /** Review round-2 fix (B3): resolved via `domain/dividends/shares-held.ts`'s
   * `deriveSharesHeldAtDate` (the same split- and reversal-aware quantity
   * derivation DIV-001's shares-at-date action uses) is `<= 0` as of this
   * read's own `today` -- an unresolvable/unparseable result defaults to
   * `false`, the safer "not exempt" case (see `app/price-history-coverage.ts`'s
   * `loadSoldOutPortfolioSecurityIds` doc comment). Gates ONLY the B1(b)
   * trailing-staleness rule below; it never affects the structural
   * pre/during-holding gap checks. */
  isSoldOut: boolean;
  classification: PriceHistoryCoverageClassification;
}>;

/**
 * Pure classification -- no DB access, so a fixture never needs a real
 * database to pin the zero/partial/covered boundary:
 *   - `zero`    — no `price_observations` row at all for this security.
 *   - `partial` — any of:
 *       (i)   the earliest observation is AFTER the first-transaction date
 *             (a real gap at the START of the holding period);
 *       (ii)  B1(a), review round-1 fix: the LATEST observation is BEFORE
 *             the first-transaction date -- the entire stored history
 *             predates the holding and never actually reaches into it.
 *             (Before this fix, `firstObservationDate <= firstTransactionDate`
 *             alone was mistaken for "covered" even when EVERY observation
 *             was from before the holding started -- inference read as
 *             observation.)
 *       (iii) B1(b), review ruling 2026-08-24: the security is currently
 *             HELD (not `isSoldOut`) and its last observation is more than
 *             `TRAILING_STALENESS_DAYS` before `today` -- see that
 *             constant's doc comment. A SOLD-OUT security is EXEMPT from
 *             this rule (no ongoing freshness need for a position the
 *             owner no longer holds); its pre/during-holding gaps (i)/(ii)
 *             above still classify normally.
 *       (iv)  the first-transaction date could not be resolved at all (an
 *             honest "cannot verify" case, never silently treated as
 *             covered).
 *   - `covered` — reaches across the whole holding period (i)/(ii) both
 *                 pass, and either sold-out or not stale (iii) -- never
 *                 shown in either list.
 */
export function classifyPriceHistoryCoverage(row: {
  observationCount: number;
  firstObservationDate: string | null;
  lastObservationDate: string | null;
  firstTransactionDate: string | null;
  isSoldOut: boolean;
  /** ISO `YYYY-MM-DD`, the caller's own "today" -- always explicit, never
   * derived internally, so this function stays a pure, directly-testable
   * boundary (matches this codebase's `now`-injection convention). */
  today: string;
}): PriceHistoryCoverageClassification {
  if (row.observationCount <= 0) return "zero";
  if (
    !row.firstObservationDate ||
    !row.lastObservationDate ||
    !row.firstTransactionDate
  ) {
    return "partial";
  }
  if (row.lastObservationDate < row.firstTransactionDate) return "partial"; // (ii) B1(a)
  if (row.firstObservationDate > row.firstTransactionDate) return "partial"; // (i)
  if (!row.isSoldOut) {
    const staleDays =
      dateDayOffset(row.today) - dateDayOffset(row.lastObservationDate);
    if (staleDays > TRAILING_STALENESS_DAYS) return "partial"; // (iii) B1(b)
  }
  return "covered";
}

/** The guide's own URL pattern (`docs/ASXCSVDownloadGuide.md` section 1) --
 * the bare ticker page, lower-cased, redirects to the full slugged page. */
export function iiShareUrl(ticker: string): string {
  return `${INTELLIGENT_INVESTOR_SHARE_HOST}${ticker.trim().toLowerCase()}/`;
}

/** The guide's own filename convention (section 3's `exporting.filename`) --
 * what the owner's browser actually names the downloaded CSV. */
export function iiDownloadFilename(ticker: string): string {
  return `ASX-${ticker.trim().toUpperCase()}.csv`;
}

/**
 * Honest gap report for a `partial` row -- states the REAL dates the read
 * returned, never a fabricated or estimated range or day count.
 * `dateDayOffset` (shared with the UI-018 chart's own gap classification)
 * turns two ISO dates into a real calendar-day count only when both are
 * present. Mirrors `classifyPriceHistoryCoverage`'s own branch order
 * exactly (reasons (i)-(iv) there) so the stated reason always matches why
 * the row was actually classified `partial` -- when NEITHER structural gap
 * condition holds, the only reason `classifyPriceHistoryCoverage` would
 * still have called this row `partial` is the B1(b) trailing-staleness
 * rule, which only ever applies when `isSoldOut` is false.
 */
export function coverageGapSummary(row: {
  firstObservationDate: string | null;
  lastObservationDate: string | null;
  firstTransactionDate: string | null;
  isSoldOut: boolean;
}): string {
  const {
    firstObservationDate,
    lastObservationDate,
    firstTransactionDate,
    isSoldOut,
  } = row;
  if (!firstObservationDate || !lastObservationDate) {
    return "Price history exists but its date range could not be read.";
  }
  const range = `Price history covers ${firstObservationDate} to ${lastObservationDate}.`;
  if (!firstTransactionDate) {
    return `${range} This holding's first-transaction date is unavailable, so the gap before it cannot be reported.`;
  }
  if (lastObservationDate < firstTransactionDate) {
    return `${range} Held since ${firstTransactionDate} — this history is entirely from BEFORE the holding started; no observation exists during the holding period at all.`;
  }
  if (firstObservationDate > firstTransactionDate) {
    const gapDays =
      dateDayOffset(firstObservationDate) - dateDayOffset(firstTransactionDate);
    return `${range} Held since ${firstTransactionDate} — ${gapDays} day(s) of holding history before the first observation are not covered.`;
  }
  if (!isSoldOut) {
    return `${range} Held since ${firstTransactionDate}, but the last observation is ${lastObservationDate} — more than ${TRAILING_STALENESS_DAYS} days ago.`;
  }
  return `${range} Held since ${firstTransactionDate} — no gap before the first observation.`;
}
