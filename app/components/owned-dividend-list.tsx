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
import type { OwnedDividendListRow } from "../owned-dividend-list.ts";
import { SOURCE_LABEL, formatFxRate } from "../dividend-history-prefill.ts";
import { formatIncomeMoney } from "../income-format.ts";
import { groupThousands } from "../../domain/calculations/index.ts";

function dateLabel(row: OwnedDividendListRow): string {
  if (row.paymentDate) return row.paymentDate;
  if (row.exDate) return `${row.exDate} (ex-date, payment date unknown)`;
  return "Unknown date";
}

export function OwnedDividendList({
  portfolioId,
  landingHref,
  today,
  rows,
  truncated,
  totalCount,
}: {
  portfolioId: string;
  landingHref: string;
  today: string;
  rows: OwnedDividendListRow[];
  truncated: boolean;
  totalCount: number;
}) {
  return (
    <main className="income-screen">
      <p className="eyebrow">Income</p>
      <h1>All dividends</h1>
      <p>
        Every individual dividend across this portfolio, most recent first, as
        of {today}.
      </p>
      <p>
        <Link href={landingHref}>Back to Income</Link>
      </p>

      {truncated ? (
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
                <td colSpan={7}>
                  No dividends found across this portfolio yet.
                </td>
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
                        href={`/portfolio/${portfolioId}/securities/${row.portfolioSecurityId}/dividends`}
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
