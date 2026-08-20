// UI-016: owner-scoped, portfolio-wide flattened dividend list
// (`/portfolio/:id/income/dividends`). The owner reported "I see the yearly
// aggregate amount. I don't see a list of dividends anywhere" -- every
// existing dividend view was either a single security's own tab or an
// aggregate total, never a list of INDIVIDUAL dividend rows across the
// whole portfolio. Reuses DIV-001's already-built, already-tested
// whole-portfolio composition (`loadOwnedDividendHistory`) for the derived
// rows -- no new derivation logic is introduced here (TASKS.md UI-016
// ruling 4: DIV-006 owns the TTM/forecast gap, not this task). This module
// only flattens each security's own row list into one date-descending list
// and bounds the OUTPUT.
//
// Mirrors `owned-security-dividends.ts`'s post-exit "no new dividend"
// artifact filter (a zero-share `source: "auto"` row dated after a full
// exit) so this list and the per-security tab never disagree about what
// counts as a real dividend -- see that module's header for the full
// rationale.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { loadOwnedDividendHistory } from "./owned-dividend-history.ts";
import type {
  DerivedDividendRow,
  DerivedDividendRowSource,
} from "../domain/dividends/index.ts";

/**
 * Caps the FLATTENED OUTPUT list. `loadOwnedDividendHistory` already bounds
 * its inputs (`MAX_SECURITIES`/`MAX_EVENTS_PER_PORTFOLIO`/etc), but a
 * portfolio with many securities each holding many dividends could still
 * flatten to a large combined list; this keeps the rendered table bounded
 * at real-world scale. Sorting happens BEFORE truncation (newest first), so
 * a capped list keeps the MOST RECENT dividends and drops only the oldest
 * tail -- disclosed via `truncated`, never silently dropped.
 */
export const MAX_DIVIDEND_LIST_ROWS = 2000;

export type OwnedDividendListRow = {
  /** Unique across the whole flattened list (`DerivedDividendRow.id` is only unique within one security's own row set). */
  id: string;
  portfolioSecurityId: string;
  symbol: string;
  /**
   * The ROW's own true currency (`DerivedDividendRow.currencyCode`), NOT
   * necessarily the security's own currency -- a degraded/unconverted
   * foreign payout (BRK-010 case C: security currency != portfolio base,
   * so no conversion is possible) keeps its ORIGINAL currency here, per
   * `history.ts`'s `currencyCodeOverride` mechanics. Review finding B1:
   * an earlier version used the security's own currency for every money
   * cell, which silently mislabelled a degraded unconverted USD payout on
   * an NZD security as "NZD" -- the security-dividends-tab.tsx precedent
   * this list mirrors always renders `row.currencyCode`, never the
   * security's, and this module now matches it.
   */
  currencyCode: string;
  paymentDate: string | null;
  exDate: string | null;
  /** True for a declared-but-unpaid row -- rendered as the existing "not paid" status text, never a fabricated cash amount. */
  notPaid: boolean;
  cashDecimal: string | null;
  frankingTotalDecimal: string | null;
  /** DIV-007: `true` when `frankingTotalDecimal` above is an INFERRED $0
   * (the imported Sharesight fact omitted its franking field entirely),
   * never a Sharesight-supplied explicit zero -- see
   * `DerivedDividendRow.frankingDerivedZero`'s doc comment. Rendered as a
   * "none reported" note so the owner can distinguish it from a real
   * confirmed-unfranked payout. */
  frankingDerivedZero: boolean;
  grossDecimal: string | null;
  source: DerivedDividendRowSource;
  /** Review finding B2: an owner-excluded row (event-override `exclude: true`) must not render identically to a counted one -- carried through and rendered as the security tab's own "· excluded" marker so the list never silently disagrees with the totals. */
  excluded: boolean;
  /** BRK-010/UI-014 conversion provenance -- non-null exactly when this row's cash was converted from a foreign Sharesight payout currency; see `DerivedDividendRow`'s doc comments. */
  originalCurrencyCode: string | null;
  fxRateToPortfolioDecimal: string | null;
  fxRateSource: string | null;
};

export type OwnedDividendList = {
  today: string;
  rows: OwnedDividendListRow[];
  /** True when the flattened list exceeded `MAX_DIVIDEND_LIST_ROWS` and was cut to the most recent rows. */
  truncated: boolean;
  totalCount: number;
};

/** Rows with a known date sort first, newest first; a row with neither a payment nor an ex-date sorts last -- never silently interleaved as if "unknown" meant "today" (AGENTS.md: missing data is never guessed). */
function sortDate(row: DerivedDividendRow): string | null {
  return row.paymentDate ?? row.exDate;
}

export async function loadOwnedDividendList(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
): Promise<OwnedDividendList> {
  const full = await loadOwnedDividendHistory(client, userId, portfolioId, now);

  const flattened: Array<{
    row: DerivedDividendRow;
    symbol: string;
  }> = [];
  for (const security of full.securities) {
    // Mirrors owned-security-dividends.ts's post-exit artifact filter (see
    // that module's header) so this list and the per-security tab never
    // disagree about what counts as a real dividend.
    const visibleRows = security.rows.filter(
      (row) => !(row.source === "auto" && row.sharesDecimal === "0"),
    );
    for (const row of visibleRows) {
      flattened.push({ row, symbol: security.symbol });
    }
  }

  flattened.sort((a, b) => {
    const aDate = sortDate(a.row);
    const bDate = sortDate(b.row);
    if (aDate === null && bDate === null) return 0;
    if (aDate === null) return 1; // undated rows sort after every dated row
    if (bDate === null) return -1;
    if (aDate === bDate) return 0;
    return aDate > bDate ? -1 : 1; // descending (newest first)
  });

  const totalCount = flattened.length;
  const truncated = totalCount > MAX_DIVIDEND_LIST_ROWS;
  const bounded = truncated
    ? flattened.slice(0, MAX_DIVIDEND_LIST_ROWS)
    : flattened;

  const rows: OwnedDividendListRow[] = bounded.map(({ row, symbol }) => ({
    id: `${row.portfolioSecurityId}:${row.id}`,
    portfolioSecurityId: row.portfolioSecurityId,
    symbol,
    // B1 fix: the ROW's own true currency, not the security's -- see
    // OwnedDividendListRow.currencyCode's doc comment.
    currencyCode: row.currencyCode,
    paymentDate: row.paymentDate,
    exDate: row.exDate,
    notPaid: row.status === "declared_pending",
    cashDecimal: row.cashDecimal,
    frankingTotalDecimal: row.frankingTotalDecimal,
    frankingDerivedZero: row.frankingDerivedZero,
    grossDecimal: row.grossDecimal,
    source: row.source,
    excluded: row.excluded,
    originalCurrencyCode: row.originalCurrencyCode,
    fxRateToPortfolioDecimal: row.fxRateToPortfolioDecimal,
    fxRateSource: row.fxRateSource,
  }));

  return { today: full.today, rows, truncated, totalCount };
}
