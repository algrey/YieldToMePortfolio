// UI-016: portfolio-wide list of INDIVIDUAL dividends
// (`/portfolio/:id/income/dividends`), reachable from the Income tab's
// "All dividends" link. Owner clarification (2026-08-20): "I see the
// yearly aggregate amount. I don't see a list of dividends anywhere."
// Read-only -- no dialogs/mutations, so this stays a plain server-renderable
// component (no "use client"), mirroring `income-multi-year.tsx`'s
// `.income-fy-table` pattern for the table itself. Honest states only:
// `formatIncomeMoney(null)` renders the same "Unavailable" text the rest of
// the Income screens use for an unknown amount (never a fabricated zero or
// blank cell), and a declared-but-unpaid row renders the SAME
// "not paid" status text/class `security-dividends-tab.tsx` uses so the two
// views never disagree about what "not paid" means.
import Link from "next/link";
import {
  MAX_DIVIDEND_LIST_ROWS,
  type OwnedDividendListRow,
} from "../owned-dividend-list.ts";
import {
  addDaysUtc,
  NEXT12_PAID_WINDOW_DAYS,
  type DividendListFilter,
} from "../dividend-list-query.ts";
import { SOURCE_LABEL, formatFxRate } from "../dividend-history-prefill.ts";
import { formatIncomeMoney } from "../income-format.ts";
import { groupThousands } from "../../domain/calculations/index.ts";
import { IncomeNav } from "./income-nav.tsx";

function dateLabel(row: OwnedDividendListRow): string {
  if (row.paymentDate) return row.paymentDate;
  if (row.exDate) return `${row.exDate} (ex-date, payment date unknown)`;
  return "Unknown date";
}

const DEFAULT_FILTER: DividendListFilter = {
  mode: "all",
  invalidFyRequested: false,
};

export function OwnedDividendList({
  portfolioId,
  allYearsHref,
  today,
  rows,
  truncated,
  totalCount,
  filter = DEFAULT_FILTER,
  undatedRowCount = 0,
}: {
  portfolioId: string;
  /** UI-017: link back to the unfiltered list -- omitted (no back link
   * rendered) when the caller has no filtered view to return from,
   * matching the pre-UI-017 all-dividends-only callers. */
  allYearsHref?: string;
  today: string;
  rows: OwnedDividendListRow[];
  truncated: boolean;
  totalCount: number;
  /** UI-017: which of `?fy=`/`?window=next12` is active, if any. Defaults
   * to the plain all-years view so existing callers built before UI-017
   * keep working unchanged. */
  filter?: DividendListFilter;
  /** UI-017: only meaningful when `filter.mode === "fy"` -- count of rows
   * with NEITHER a payment date nor an ex-date, computed portfolio-wide
   * (not scoped to the requested year -- see `dividend-list-query.ts`'s
   * `filterRowsForFyWindow`/`undatedRowCount` doc comment for why). */
  undatedRowCount?: number;
}) {
  const heading =
    filter.mode === "fy"
      ? `${filter.label} dividends`
      : filter.mode === "next12"
        ? "Known dividends in the next 12 months"
        : "All dividends";

  // B3a (round-1 review): the empty state must match what was actually
  // asked for -- the portfolio-wide "yet" copy reads as a contradiction
  // next to a filtered count line, and previously rendered even when the
  // PORTFOLIO has dividends but none fall in the requested FY/window.
  const emptyMessage =
    filter.mode === "fy"
      ? `No dividends recorded in ${filter.label}.`
      : filter.mode === "next12"
        ? "No known dividends in this window."
        : "No dividends found across this portfolio yet.";

  return (
    <main className="income-screen">
      {/* UI-022: this list is a peer Income sub-tab, not a leaf page --
          it renders the SAME four-tab bar as every other Income view
          (owner-reported: "All dividends should be equal to the other
          Income sub-tabs. The list of dividends should have the sub-tab
          bar at the top."). The old "Back to Income" text link below the
          heading is gone: the "Next 12 months" tab is that link now. */}
      <IncomeNav portfolioId={portfolioId} active="dividends" />
      <h1>{heading}</h1>
      {filter.mode === "fy" ? (
        <p>
          Dividends attributed to {filter.window.startDate} &ndash;{" "}
          {filter.window.endDate} by payment date, or by ex-date where no
          payment date is recorded.
        </p>
      ) : filter.mode === "next12" ? (
        <p>
          This shows only dividends that are already known as of {today} --
          declared but not yet paid (shown whatever their date), or paid between{" "}
          {today} and {addDaysUtc(today, NEXT12_PAID_WINDOW_DAYS)}. It is not a
          forecast of future income.
        </p>
      ) : (
        <p>
          Every individual dividend across this portfolio, most recent first, as
          of {today}.
        </p>
      )}
      {filter.mode === "all" && filter.invalidFyRequested ? (
        <p className="status-banner warning" role="status">
          <strong>Requested financial year unavailable</strong>
          <span>
            The requested financial year could not be shown, so every year is
            shown instead.
          </span>
        </p>
      ) : null}
      {filter.mode === "fy" || filter.mode === "next12" ? (
        <p>
          Showing {groupThousands(String(rows.length))} of{" "}
          {groupThousands(String(totalCount))} dividends across the portfolio.
        </p>
      ) : null}
      {filter.mode === "fy" && undatedRowCount > 0 ? (
        <p className="status-banner warning" role="status">
          <strong>
            {groupThousands(String(undatedRowCount))} undated dividend
            {undatedRowCount === 1 ? "" : "s"} across the portfolio not shown in
            any financial-year view
          </strong>
          <span>
            A dividend with neither a payment date nor an ex-date cannot be
            attributed to any financial year -- this count is portfolio-wide,
            not specific to {filter.label}.
          </span>
        </p>
      ) : null}
      {allYearsHref && filter.mode !== "all" ? (
        <p>
          <Link href={allYearsHref}>All years</Link>
        </p>
      ) : null}

      {truncated && filter.mode === "all" ? (
        <p className="status-banner warning" role="status">
          <strong>
            Showing the most recent {groupThousands(String(rows.length))} of{" "}
            {groupThousands(String(totalCount))} dividends
          </strong>
          <span>
            The full history is available on each security&apos;s own dividends
            tab.
          </span>
        </p>
      ) : null}
      {/* B3b (round-1 review): under an active fy/next12 filter, "most
          recent {filteredCount} of {total}" is not just imprecise -- it
          describes numbers that have nothing to do with each other (the CAP
          applies to the whole portfolio's date-descending list, BEFORE this
          filter narrows it). State the real mechanics instead: the loader
          already dropped the oldest rows portfolio-wide, so an older
          financial year viewed here may be missing some of its rows. */}
      {truncated && filter.mode !== "all" ? (
        <p className="status-banner warning" role="status">
          <strong>
            This portfolio has more than{" "}
            {groupThousands(String(MAX_DIVIDEND_LIST_ROWS))} dividends
          </strong>
          <span>
            Only the most recent{" "}
            {groupThousands(String(MAX_DIVIDEND_LIST_ROWS))} are loaded,
            portfolio-wide -- an older financial year shown here may be missing
            some of its rows. The full history is available on each
            security&apos;s own dividends tab.
          </span>
        </p>
      ) : null}

      <div className="income-fy-table-wrap">
        <table className="income-fy-table">
          <caption>Individual dividends across the portfolio</caption>
          <thead>
            <tr>
              <th scope="col">Symbol</th>
              <th scope="col">Payment date</th>
              <th scope="col" className="numeric">
                Cash
              </th>
              <th scope="col" className="numeric">
                Franking
              </th>
              <th scope="col" className="numeric">
                Gross
              </th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>{emptyMessage}</td>
              </tr>
            ) : (
              rows.map((row) => {
                const fxProvenance =
                  row.originalCurrencyCode !== null &&
                  row.fxRateToPortfolioDecimal !== null
                    ? `${row.originalCurrencyCode} @ ${formatFxRate(row.fxRateToPortfolioDecimal)}${row.fxRateSource ? ` (${row.fxRateSource})` : ""}`
                    : null;
                return (
                  <tr
                    key={row.id}
                    className={
                      row.notPaid ? "dividend-row-not-paid" : undefined
                    }
                  >
                    <th scope="row">
                      <Link
                        href={`/portfolio/${portfolioId}/holdings/${row.portfolioSecurityId}/dividends`}
                      >
                        {row.symbol}
                      </Link>
                    </th>
                    <td>{dateLabel(row)}</td>
                    <td className="numeric">
                      {formatIncomeMoney(row.currencyCode, row.cashDecimal)}
                      {fxProvenance ? (
                        <>
                          <br />
                          <span className="dividend-fx-provenance">
                            converted from {fxProvenance}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="numeric">
                      {formatIncomeMoney(
                        row.currencyCode,
                        row.frankingTotalDecimal,
                      )}
                      {row.frankingDerivedZero ? (
                        <>
                          <br />
                          <span className="dividend-franking-provenance">
                            none reported
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="numeric">
                      {formatIncomeMoney(row.currencyCode, row.grossDecimal)}
                    </td>
                    <td>
                      <span className="income-source">
                        {SOURCE_LABEL[row.source]}
                        {row.excluded ? " · excluded" : ""}
                      </span>
                    </td>
                    <td>
                      {row.notPaid ? (
                        <span className="dividend-status-not-paid">
                          not paid
                        </span>
                      ) : (
                        <span>paid</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
