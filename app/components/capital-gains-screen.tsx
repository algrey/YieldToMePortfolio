"use client";

// CGT-001B: the Income area's Capital gains screen -- the third tab
// alongside "Next 12 months"/"Multi-year" (`income-landing.tsx`,
// `income-multi-year.tsx`). Consumes CGT-001A's read-only
// `app/owned-capital-gains.ts` (`OwnedCapitalGainsHistory`) and the pure
// `domain/gains` calculations -- this component itself computes nothing
// beyond the lifetime rollup (`computeLifetimeCapitalGainsTotal`, itself a
// pure domain function over already-derived per-FY totals, never routed
// through JS binary floating point).
//
// Row-detail dialog: purely presentational over already-loaded props (no
// fetch happens when a row opens), so the established ref+showModal
// pattern applies WITHOUT UI-008's in-flight fetch timeout -- there is
// nothing in flight to time out. Mirrors `income-multi-year.tsx`'s row
// dialog exactly (opener-capture, first-field focus, onCancel
// preventDefault + manual close, focus restored to the opener on close).
//
// Display-rounding decision (CGT-001A's completion note: the net estimate
// and every per-FY figure are EXACT/unrounded decimal strings -- the
// screen must make an explicit call): every money figure here goes through
// the SAME `formatIncomeMoney` (2dp, `Decimal.ROUND_HALF_EVEN`, see
// `domain/calculations/decimal.ts#formatDecimalFixed`) already used by the
// other two Income screens, so this screen introduces no new rounding
// convention. No footnote-style "this may not sum exactly" disclosure is
// added: the visible columns (discountable/non-discountable/losses/net
// estimate) are independently-computed EXACT figures from
// `domain/gains/fy-aggregation.ts`, not a decomposition where displayed
// parts are claimed to sum to a displayed total -- the 50% discount and
// loss-offset ordering mean gross discountable + gross non-discountable -
// losses does NOT equal the net estimate even at full precision, by
// design, so there is no "parts should sum to the whole but a rounded
// half-cent broke it" hazard for a reader to be misled by. The one place
// a half-cent tie can occur (a discount landing exactly on a
// `x.xx5` boundary) rounds to the same even digit every other money
// figure in this app already rounds to, silently and consistently -- not
// a CGT-specific concern.
import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { OwnedCapitalGainsHistory } from "../owned-capital-gains.ts";
import {
  CGT_CARRY_FORWARD_OUT_OF_SCOPE_NOTE,
  CGT_METHOD_LABELS,
  computeLifetimeCapitalGainsTotal,
  type CapitalGainDisposalRow,
  type CapitalGainEligibilityLabel,
  type FyCapitalGainsTotal,
} from "../../domain/gains/index.ts";
import { formatIncomeMoney, formatQuantity } from "../income-format.ts";

/** Human-readable label for each `CapitalGainEligibilityLabel` -- never the raw enum value, and "unknown" is spelled out rather than implying a fabricated zero. */
const ELIGIBILITY_LABELS: Record<CapitalGainEligibilityLabel, string> = {
  discount_eligible: "Discount eligible (held over 12 months)",
  discount_ineligible: "Discount ineligible (held 12 months or less)",
  not_applicable_loss: "Loss — no discount applies",
  not_applicable_zero: "No gain or loss",
  unknown_incomplete_basis: "Unknown — incomplete cost basis",
};

export type CapitalGainsScreenResult =
  | { status: "ok"; history: OwnedCapitalGainsHistory }
  | {
      status: "unavailable";
      /**
       * Distinct, honest copy per typed failure the read service can
       * produce (CGT-001A's `app/owned-capital-gains.ts`): `unpublished`
       * covers a portfolio with real disposals whose calculation run has
       * not published yet; `missing_dates` covers the (should-not-happen)
       * case where an allocation's acquisition/disposal dates could not be
       * resolved; `error` is the generic catch-all for every other typed
       * failure (invalid FY window, invalid decimal boundary, etc.).
       */
      reason: "unpublished" | "missing_dates" | "error";
    };

function GainsTabs({
  incomeHref,
  multiYearHref,
}: {
  incomeHref: string;
  multiYearHref: string;
}) {
  return (
    <nav className="income-view-tabs" aria-label="Income views">
      <Link href={incomeHref}>Next 12 months</Link>
      <Link href={multiYearHref}>Multi-year</Link>
      <span aria-current="page">Capital gains</span>
    </nav>
  );
}

function GainsDisclaimer() {
  return (
    <p className="gains-disclaimer">
      <strong>Informational only — not tax advice.</strong> Consult a registered
      tax agent before relying on these figures for an actual return.
    </p>
  );
}

function AllocationRow({
  row,
  currencyCode,
}: {
  row: CapitalGainDisposalRow;
  currencyCode: string;
}) {
  const gainStatus = row.gainDecimal;
  return (
    <tr>
      <th scope="row">{row.securityName}</th>
      <td>{row.acquiredDate}</td>
      <td>{row.disposedDate}</td>
      <td className="numeric">{formatQuantity(row.quantityDecimal)}</td>
      <td className="numeric">
        {formatIncomeMoney(currencyCode, row.proceedsDecimal, {
          unavailableLabel: "Unknown",
        })}
      </td>
      <td className="numeric">
        {formatIncomeMoney(currencyCode, row.basisDecimal, {
          unavailableLabel: "Unknown",
        })}
      </td>
      <td className="numeric">
        {formatIncomeMoney(currencyCode, row.feeDecimal, {
          unavailableLabel: "Unknown",
        })}
      </td>
      <td
        className={
          gainStatus === null
            ? "numeric unavailable"
            : gainStatus.startsWith("-")
              ? "numeric tone-negative"
              : "numeric tone-positive"
        }
      >
        {formatIncomeMoney(currencyCode, gainStatus, {
          signed: true,
          unavailableLabel: "Unknown",
        })}
      </td>
      <td>{ELIGIBILITY_LABELS[row.eligibility]}</td>
    </tr>
  );
}

// Exported (not just used internally) so its allocation-row markup --
// eligibility labels, incomplete-basis "Unknown" figures, quantity
// formatting, and the in-dialog unabsorbed-loss note -- gets direct
// rendered-test coverage (`tests/cgt-001b.test.ts`) rather than only
// source-regex assertions. `CapitalGainsScreen` only ever mounts this once
// `selectedFy` is set client-side; a static render always passes `fy`
// directly as a prop.
export function FyDetailDialog({
  fy,
  currencyCode,
  dialogRef,
  onClose,
}: {
  fy: FyCapitalGainsTotal;
  currencyCode: string;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClose: () => void;
}) {
  const hasUnabsorbedLoss = fy.unabsorbedLossDecimal !== "0";
  return (
    <dialog
      ref={dialogRef}
      className="income-dialog gains-dialog"
      aria-labelledby="gains-fy-title"
      onCancel={(event) => {
        event.preventDefault();
        dialogRef.current?.close();
        onClose();
      }}
      onClose={onClose}
    >
      <button
        type="button"
        className="sheet-close"
        onClick={() => dialogRef.current?.close()}
      >
        Close
      </button>
      <p className="eyebrow" id="gains-fy-title">
        {fy.label}
      </p>
      <dl className="detail-facts">
        <div>
          <dt>Discountable gains (gross)</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              fy.totalDiscountableGainsGrossDecimal,
            )}
          </dd>
        </div>
        <div>
          <dt>Non-discountable gains (gross)</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              fy.totalNonDiscountableGainsGrossDecimal,
            )}
          </dd>
        </div>
        <div>
          <dt>Losses</dt>
          <dd>{formatIncomeMoney(currencyCode, fy.totalLossesDecimal)}</dd>
        </div>
        <div>
          <dt>Loss applied to non-discountable</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              fy.lossAppliedToNonDiscountableDecimal,
            )}
          </dd>
        </div>
        <div>
          <dt>Loss applied to discountable</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              fy.lossAppliedToDiscountableDecimal,
            )}
          </dd>
        </div>
        <div>
          <dt>Discount applied ({fy.discountRateDecimal})</dt>
          <dd>{formatIncomeMoney(currencyCode, fy.discountAppliedDecimal)}</dd>
        </div>
        <div>
          <dt>Net capital gain estimate</dt>
          <dd>
            {formatIncomeMoney(currencyCode, fy.netCapitalGainEstimateDecimal)}
          </dd>
        </div>
      </dl>

      <p>{CGT_METHOD_LABELS.discountableGains}</p>
      <p>{CGT_METHOD_LABELS.nonDiscountableGains}</p>
      <p>{CGT_METHOD_LABELS.losses}</p>
      <p>{CGT_METHOD_LABELS.netCapitalGainEstimate}</p>

      {hasUnabsorbedLoss ? (
        <p className="unavailable" role="status">
          Unabsorbed loss this year:{" "}
          {formatIncomeMoney(currencyCode, fy.unabsorbedLossDecimal)}.{" "}
          {CGT_CARRY_FORWARD_OUT_OF_SCOPE_NOTE}
        </p>
      ) : null}

      {fy.partialCoverage ? (
        <>
          <p className="unavailable">
            {fy.excludedIncompleteCount} allocation
            {fy.excludedIncompleteCount === 1 ? "" : "s"} excluded from these
            totals — cost basis is incomplete for:
          </p>
          <ul className="income-exclusions">
            {fy.excludedIncompleteSecurityNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="eyebrow">Lot matches this year</p>
      <div className="income-fy-table-wrap">
        <table className="income-fy-table gains-allocation-table">
          <caption>
            Every matched tax-lot allocation attributed to this financial year
            (one sale spanning several tax lots counts as more than one row
            here).
          </caption>
          <thead>
            <tr>
              <th scope="col">Security</th>
              <th scope="col">Acquired</th>
              <th scope="col">Disposed</th>
              <th scope="col" className="numeric">
                Quantity
              </th>
              <th scope="col" className="numeric">
                Proceeds
              </th>
              <th scope="col" className="numeric">
                Basis
              </th>
              <th scope="col" className="numeric">
                Fees
              </th>
              <th scope="col" className="numeric">
                Gain / loss
              </th>
              <th scope="col">Eligibility</th>
            </tr>
          </thead>
          <tbody>
            {fy.rows.map((row) => (
              <AllocationRow
                key={row.allocationId}
                row={row}
                currencyCode={currencyCode}
              />
            ))}
          </tbody>
        </table>
      </div>
    </dialog>
  );
}

export function CapitalGainsScreen({
  incomeHref,
  multiYearHref,
  holdingsHref,
  result,
}: {
  incomeHref: string;
  multiYearHref: string;
  holdingsHref: string;
  result: CapitalGainsScreenResult;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rowOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [selectedFy, setSelectedFy] = useState<FyCapitalGainsTotal | null>(
    null,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (selectedFy && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!selectedFy && rowOpenerRef.current) {
      rowOpenerRef.current.focus();
      rowOpenerRef.current = null;
    }
  }, [selectedFy]);

  if (result.status === "unavailable") {
    const copy =
      result.reason === "unpublished"
        ? {
            title: "Capital gains are not published yet",
            message:
              "This portfolio's calculations have not finished publishing, so realised capital gains cannot be estimated right now. This usually resolves on its own shortly after a change to your ledger.",
          }
        : result.reason === "missing_dates"
          ? {
              title: "Capital gains cannot be estimated",
              message:
                "Some disposals in this portfolio are missing the acquisition or disposal dates needed to estimate capital gains right now.",
            }
          : {
              title: "Capital gains are unavailable",
              message: "The capital gains estimate could not be loaded.",
            };
    return (
      <main className="income-screen">
        <p className="eyebrow">Income</p>
        <GainsTabs incomeHref={incomeHref} multiYearHref={multiYearHref} />
        <section
          className="empty-state"
          aria-labelledby="gains-unavailable-title"
        >
          <h1 id="gains-unavailable-title">{copy.title}</h1>
          <p>{copy.message}</p>
        </section>
      </main>
    );
  }

  const { history } = result;

  // CGT-001A's completion note: `disposalCount` counts ALLOCATIONS (lot
  // matches), not distinct sale transactions -- never labelled "disposals"
  // unqualified anywhere on this screen.
  if (history.disposalCount === 0) {
    return (
      <main className="income-screen">
        <p className="eyebrow">Income</p>
        <GainsTabs incomeHref={incomeHref} multiYearHref={multiYearHref} />
        <section className="empty-state" aria-labelledby="gains-empty-title">
          <h1 id="gains-empty-title">No disposals yet</h1>
          <p>
            This portfolio has no sell transactions yet, so there are no
            realised capital gains or losses to estimate. A capital gain or loss
            is only realised when a holding is sold.
          </p>
          <Link href={holdingsHref}>Go to holdings</Link>
        </section>
        <GainsDisclaimer />
      </main>
    );
  }

  const lifetime = computeLifetimeCapitalGainsTotal(history.fyTotals);
  const hasLifetimeUnabsorbedLoss = lifetime.totalUnabsorbedLossDecimal !== "0";

  return (
    <main className="income-screen">
      <p className="eyebrow">Income</p>
      <GainsTabs incomeHref={incomeHref} multiYearHref={multiYearHref} />

      <div className="income-fy-table-wrap">
        <table className="income-fy-table">
          <caption>Realised capital gains by financial year</caption>
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col" className="numeric">
                Discountable gains
              </th>
              <th scope="col" className="numeric">
                Non-discountable gains
              </th>
              <th scope="col" className="numeric">
                Losses
              </th>
              <th scope="col" className="numeric">
                Net estimate
              </th>
              <th scope="col">Method</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {history.fyTotals.map((fy) => {
              const fyHasUnabsorbedLoss = fy.unabsorbedLossDecimal !== "0";
              return (
                <tr key={fy.endingYear}>
                  <th scope="row">
                    <button
                      type="button"
                      className="income-row-trigger"
                      onClick={(event) => {
                        rowOpenerRef.current = event.currentTarget;
                        setSelectedFy(fy);
                      }}
                    >
                      {fy.label}
                    </button>
                  </th>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      fy.totalDiscountableGainsGrossDecimal,
                    )}
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      fy.totalNonDiscountableGainsGrossDecimal,
                    )}
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      fy.totalLossesDecimal,
                    )}
                    {fyHasUnabsorbedLoss ? (
                      <>
                        {" "}
                        <span className="unavailable">
                          ·{" "}
                          {formatIncomeMoney(
                            history.baseCurrencyCode,
                            fy.unabsorbedLossDecimal,
                          )}{" "}
                          unabsorbed
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      fy.netCapitalGainEstimateDecimal,
                    )}
                  </td>
                  <td>
                    <span className="income-source">
                      losses first, then 50% discount
                    </span>
                  </td>
                  <td>
                    {fy.partialCoverage ? (
                      <span className="unavailable">
                        Partial · {fy.excludedIncompleteCount} excluded
                      </span>
                    ) : (
                      "Full"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="income-assumption-summary">
        {CGT_CARRY_FORWARD_OUT_OF_SCOPE_NOTE}
      </p>

      <dl className="income-metric-list" aria-label="Lifetime capital gains">
        <div className="income-metric-row">
          <dt>Lifetime discountable gains</dt>
          <dd>
            {formatIncomeMoney(
              history.baseCurrencyCode,
              lifetime.totalDiscountableGainsGrossDecimal,
            )}
          </dd>
        </div>
        <div className="income-metric-row">
          <dt>Lifetime non-discountable gains</dt>
          <dd>
            {formatIncomeMoney(
              history.baseCurrencyCode,
              lifetime.totalNonDiscountableGainsGrossDecimal,
            )}
          </dd>
        </div>
        <div className="income-metric-row">
          <dt>Lifetime losses</dt>
          <dd>
            {formatIncomeMoney(
              history.baseCurrencyCode,
              lifetime.totalLossesDecimal,
            )}
            {hasLifetimeUnabsorbedLoss ? (
              <span className="unavailable">
                {" "}
                ·{" "}
                {formatIncomeMoney(
                  history.baseCurrencyCode,
                  lifetime.totalUnabsorbedLossDecimal,
                )}{" "}
                unabsorbed
              </span>
            ) : null}
          </dd>
        </div>
        <div className="income-metric-row">
          <dt>
            Lifetime net capital gain estimate (sum of each year, standalone)
          </dt>
          <dd>
            {formatIncomeMoney(
              history.baseCurrencyCode,
              lifetime.netCapitalGainEstimateDecimal,
            )}
          </dd>
        </div>
        <div className="income-metric-row">
          <dt>Lot matches</dt>
          <dd>
            {lifetime.disposalCount} across {lifetime.fyCount} financial year
            {lifetime.fyCount === 1 ? "" : "s"}
          </dd>
        </div>
      </dl>
      {lifetime.partialCoverage ? (
        <p className="unavailable">
          {lifetime.excludedIncompleteCount} allocation
          {lifetime.excludedIncompleteCount === 1 ? "" : "s"} excluded from the
          totals above — cost basis is incomplete for:{" "}
          {lifetime.excludedIncompleteSecurityNames.join(", ")}
        </p>
      ) : null}

      <GainsDisclaimer />

      {selectedFy ? (
        <FyDetailDialog
          fy={selectedFy}
          currencyCode={history.baseCurrencyCode}
          dialogRef={dialogRef}
          onClose={() => setSelectedFy(null)}
        />
      ) : null}
    </main>
  );
}
