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
//
// CGT-002 (loss carry-forward): this component now ALSO computes
// `computeCapitalGainsCarryChain` (pure, over already-loaded props, exactly
// like `computeLifetimeCapitalGainsTotal` above it) and uses its output for
// the FY table's "Net estimate" column and the lifetime summary's headline
// net line -- both are now the TRUE, carried figure, not the standalone
// per-FY total `domain/gains/fy-aggregation.ts` alone would produce. The
// old standalone figures are NOT lost: they remain the FY table's
// Discountable/Non-discountable/Losses columns (unaffected by carry-in, by
// design -- see `fy-aggregation.ts`'s header) and are shown again,
// explicitly labelled "standalone", in the per-FY detail dialog alongside
// the new carried breakdown for that year.
import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { OwnedCapitalGainsHistory } from "../owned-capital-gains.ts";
import type { ProjectionPendingState } from "../owned-holdings-contract.ts";
import { buildCapitalGainsDisplayRows } from "../capital-gains-display-format.ts";
import {
  CGT_CARRY_FORWARD_NOTE,
  CGT_METHOD_LABELS,
  computeCapitalGainsCarryChain,
  computeLifetimeCapitalGainsTotal,
  type CapitalGainDisposalRow,
  type CapitalGainEligibilityLabel,
  type FyCapitalGainsTotal,
  type FyCarriedCapitalGains,
} from "../../domain/gains/index.ts";
import { formatIncomeMoney, formatQuantity } from "../income-format.ts";
import { IncomeNav } from "./income-nav.tsx";

// BUG-017: honest, visible (non-color, non-badge -- matches the
// established `.unavailable` `role="status"` advisory convention already
// used above for carried/coverage disclosures) disclosure that the
// figures below may not reflect the ledger's latest state. `null` when
// there is nothing to disclose.
function ProjectionPendingNotice({
  pending,
}: {
  pending: ProjectionPendingState | undefined;
}) {
  if (!pending?.pending) return null;
  return (
    <p className="unavailable" role="status">
      {pending.reason === "failed"
        ? "The last recalculation failed — figures reflect the previous successful calculation."
        : "Recalculating after your latest ledger change — figures may not yet reflect it."}
    </p>
  );
}

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
        {formatIncomeMoney(currencyCode, currencyCode, row.proceedsDecimal, {
          unavailableLabel: "Unknown",
        })}
      </td>
      <td className="numeric">
        {formatIncomeMoney(currencyCode, currencyCode, row.basisDecimal, {
          unavailableLabel: "Unknown",
        })}
      </td>
      <td className="numeric">
        {formatIncomeMoney(currencyCode, currencyCode, row.feeDecimal, {
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
        {formatIncomeMoney(currencyCode, currencyCode, gainStatus, {
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
  carried,
}: {
  fy: FyCapitalGainsTotal;
  currencyCode: string;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  /**
   * This FY's carried (chain-adjusted) totals from
   * `computeCapitalGainsCarryChain` -- optional so the presentational
   * component stays renderable from a bare `fy` fixture (as several
   * existing tests already do); the real screen always supplies it.
   */
  carried?: FyCarriedCapitalGains | null;
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
      <p className="eyebrow">Standalone (before prior-year carry-forward)</p>
      <dl className="detail-facts">
        <div>
          <dt>Discountable gains (gross)</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
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
              currencyCode,
              fy.totalNonDiscountableGainsGrossDecimal,
            )}
          </dd>
        </div>
        <div>
          <dt>Losses</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              currencyCode,
              fy.totalLossesDecimal,
            )}
          </dd>
        </div>
        <div>
          <dt>Loss applied to non-discountable</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
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
              currencyCode,
              fy.lossAppliedToDiscountableDecimal,
            )}
          </dd>
        </div>
        <div>
          <dt>Discount applied ({fy.discountRateDecimal})</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              currencyCode,
              fy.discountAppliedDecimal,
            )}
          </dd>
        </div>
        <div>
          <dt>Net capital gain estimate (standalone)</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              currencyCode,
              fy.netCapitalGainEstimateDecimal,
            )}
          </dd>
        </div>
      </dl>

      <p>{CGT_METHOD_LABELS.discountableGains}</p>
      <p>{CGT_METHOD_LABELS.nonDiscountableGains}</p>
      <p>{CGT_METHOD_LABELS.losses}</p>
      <p>{CGT_METHOD_LABELS.netCapitalGainEstimate}</p>

      {hasUnabsorbedLoss ? (
        <p className="unavailable" role="status">
          Unabsorbed loss this year (standalone):{" "}
          {formatIncomeMoney(
            currencyCode,
            currencyCode,
            fy.unabsorbedLossDecimal,
          )}
          .
        </p>
      ) : null}

      <p className="eyebrow">Carried (with prior-year losses applied)</p>
      <p>{CGT_CARRY_FORWARD_NOTE}</p>
      {carried ? (
        <>
          <dl className="detail-facts">
            <div>
              <dt>Brought forward</dt>
              <dd>
                {formatIncomeMoney(
                  currencyCode,
                  currencyCode,
                  carried.carryInLossDecimal,
                )}
              </dd>
            </div>
            <div>
              <dt>Applied this FY</dt>
              <dd>
                {formatIncomeMoney(
                  currencyCode,
                  currencyCode,
                  carried.carryInAppliedDecimal,
                )}
              </dd>
            </div>
            <div>
              <dt>Net capital gain estimate (carried, true)</dt>
              <dd>
                {formatIncomeMoney(
                  currencyCode,
                  currencyCode,
                  carried.netCapitalGainEstimateDecimal,
                )}
              </dd>
            </div>
            <div>
              <dt>Carried out to next FY</dt>
              <dd>
                {formatIncomeMoney(
                  currencyCode,
                  currencyCode,
                  carried.carryOutLossDecimal,
                )}
              </dd>
            </div>
          </dl>
          {carried.carriedFiguresPartial ? (
            <p className="unavailable" role="status">
              These carried figures may be understated or overstated: either
              this portfolio&apos;s declared history-completeness date does not
              reach back far enough (see the disclosure above the lifetime
              summary, when shown), or an earlier financial year in this chain
              excluded incomplete-cost-basis allocations (see that year&apos;s
              coverage disclosure).
            </p>
          ) : null}
        </>
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
  portfolioId,
  holdingsHref,
  result,
}: {
  portfolioId: string;
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
        <IncomeNav portfolioId={portfolioId} active="gains" />
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
        <IncomeNav portfolioId={portfolioId} active="gains" />
        <section className="empty-state" aria-labelledby="gains-empty-title">
          <h1 id="gains-empty-title">No disposals yet</h1>
          <p>
            This portfolio has no sell transactions yet, so there are no
            realised capital gains or losses to estimate. A capital gain or loss
            is only realised when a holding is sold.
          </p>
          <Link href={holdingsHref}>Go to holdings</Link>
        </section>
        <ProjectionPendingNotice pending={history.projectionPending} />
        <GainsDisclaimer />
      </main>
    );
  }

  const lifetime = computeLifetimeCapitalGainsTotal(history.fyTotals);

  // CGT-002: the carry-forward chain, pure over already-loaded props --
  // see this file's header comment. `carriedByYear` joins each FY row back
  // onto its carried totals; `history.fyTotals` and `carryChain.perFy` are
  // guaranteed to be the same set of FYs in the same order (both are
  // derived from the same `history.fyTotals` input), so every lookup below
  // is expected to hit.
  const carryChain = computeCapitalGainsCarryChain(
    history.fyTotals,
    history.historyCompleteFrom,
  );
  const carriedByYear = new Map(
    carryChain.perFy.map((entry) => [entry.endingYear, entry]),
  );
  const selectedCarried = selectedFy
    ? (carriedByYear.get(selectedFy.endingYear) ?? null)
    : null;
  const hasFinalCarryOut = carryChain.finalCarryOutLossDecimal !== "0";

  // CGT-004: `history.fyTotals` above (real disposal FYs only) still feeds
  // the carry chain and lifetime rollup exactly as before this task --
  // padding rows are never mixed into it, so a real FY's carried/lifetime
  // figures are unaffected by padding (see `tests/cgt-004.test.ts`'s
  // pass-through fixture, which pins a real FY's carried net estimate
  // across a padded gap year). `displayRows` is a SEPARATE, display-only
  // list padded out to the most recent `CAPITAL_GAINS_DISPLAY_YEARS`
  // financial years (real FYs outside that window are still included,
  // never dropped) -- see `buildCapitalGainsDisplayRows`'s header for the
  // honesty rules behind its two placeholder tiers.
  const displayRows = buildCapitalGainsDisplayRows(history);

  return (
    <main className="income-screen">
      <IncomeNav portfolioId={portfolioId} active="gains" />
      <ProjectionPendingNotice pending={history.projectionPending} />

      <div className="income-fy-table-wrap">
        <table className="income-fy-table">
          <caption>
            Realised capital gains by financial year -- Net estimate below is
            the TRUE, carried figure (that year&apos;s own losses, then any loss
            carried in from an earlier year, before the 50% discount);
            standalone per-year figures are in each row&apos;s detail view.
          </caption>
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
              <th scope="col" className="numeric">
                Brought forward
              </th>
              <th scope="col" className="numeric">
                Applied this FY
              </th>
              <th scope="col" className="numeric">
                Carried out
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              if (row.kind !== "data") {
                // CGT-004 placeholder row: no real `FyCapitalGainsTotal` to
                // open a detail dialog on, so the year is plain text, not a
                // button. `no_disposals` is a real known zero (the
                // completeness boundary -- declared, or evidence-based when
                // none was declared -- covers this whole FY); `unknown` is
                // genuinely unknown and must never render as $0. Review
                // ruling B2: wording never claims "before recorded
                // history" (false for a gap year between two real disposal
                // years, and for the still-open current FY) -- see
                // `buildCapitalGainsDisplayRows`'s header for the full
                // honesty rules.
                const known = row.kind === "no_disposals";
                const moneyCell = known
                  ? formatIncomeMoney(
                      history.baseCurrencyCode,
                      history.baseCurrencyCode,
                      "0",
                    )
                  : formatIncomeMoney(
                      history.baseCurrencyCode,
                      history.baseCurrencyCode,
                      null,
                      { unavailableLabel: "Unknown" },
                    );
                const statusText = known
                  ? row.isCurrentFy
                    ? "No disposals recorded so far this financial year"
                    : "No disposals recorded this financial year"
                  : row.isCurrentFy
                    ? "Unknown so far this financial year — no confirmed disposal record"
                    : "Unknown — no confirmed disposal record for this financial year";
                const coverageText =
                  known && row.isCurrentFy
                    ? "In progress" // review fold: never claim "Full" for a year that has not finished
                    : known
                      ? "Full"
                      : "Unknown";
                return (
                  <tr key={row.endingYear}>
                    <th scope="row">{row.label}</th>
                    <td className="numeric">{moneyCell}</td>
                    <td className="numeric">{moneyCell}</td>
                    <td className="numeric">{moneyCell}</td>
                    <td className="numeric">{moneyCell}</td>
                    {/* Review fold: this cell's real meaning (a status
                        explanation, not a calculation method) doesn't match
                        the "Method" column header a real row's cell means --
                        the aria-label overrides that association for
                        assistive tech; the visible text is unchanged. */}
                    <td aria-label={`Status: ${statusText}`}>
                      <span className="income-source">{statusText}</span>
                    </td>
                    <td>
                      {known ? (
                        coverageText
                      ) : (
                        <span className="unavailable">{coverageText}</span>
                      )}
                    </td>
                    {/* Review ruling B1: a real carried loss CAN legitimately
                        pass THROUGH a no-disposal year unchanged on its way
                        to a later FY -- this padding row never computes
                        that pass-through, so it must never claim "nothing
                        to carry" (a false assertion). Honest not-computed
                        state instead: an em dash, with the real reason in
                        the accessible name. */}
                    <td
                      className="numeric unavailable"
                      colSpan={3}
                      aria-label="Not computed for years with no disposals"
                    >
                      –
                    </td>
                  </tr>
                );
              }
              const fy = row.fy;
              const fyHasUnabsorbedLoss = fy.unabsorbedLossDecimal !== "0";
              const carried = carriedByYear.get(fy.endingYear) ?? null;
              const tainted = carried?.carriedFiguresPartial ?? false;
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
                      history.baseCurrencyCode,
                      fy.totalDiscountableGainsGrossDecimal,
                    )}
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      history.baseCurrencyCode,
                      fy.totalNonDiscountableGainsGrossDecimal,
                    )}
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
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
                            history.baseCurrencyCode,
                            fy.unabsorbedLossDecimal,
                          )}{" "}
                          unabsorbed (standalone)
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      history.baseCurrencyCode,
                      carried?.netCapitalGainEstimateDecimal ??
                        fy.netCapitalGainEstimateDecimal,
                    )}
                    {tainted ? <span className="unavailable"> *</span> : null}
                  </td>
                  <td>
                    <span className="income-source">
                      current-year losses, then carry-in, then 50% discount
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
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      history.baseCurrencyCode,
                      carried?.carryInLossDecimal ?? "0",
                    )}
                    {tainted ? <span className="unavailable"> *</span> : null}
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      history.baseCurrencyCode,
                      carried?.carryInAppliedDecimal ?? "0",
                    )}
                    {tainted ? <span className="unavailable"> *</span> : null}
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      history.baseCurrencyCode,
                      history.baseCurrencyCode,
                      carried?.carryOutLossDecimal ?? "0",
                    )}
                    {tainted ? <span className="unavailable"> *</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="income-assumption-summary">{CGT_CARRY_FORWARD_NOTE}</p>

      {!carryChain.historyComplete ? (
        <p className="unavailable" role="status">
          {carryChain.historyIncompleteMessage}
        </p>
      ) : null}

      {/* UI-026 (B2, Orchestrator ruling): every figure on this screen --
          the FY table above and the lifetime totals below -- is the
          portfolio's own base currency (CGT is always computed and
          reported in it, never a security's native currency), so this ONE
          screen-level statement covers every bare "$"-style figure on the
          page, mirroring portfolio-shell.tsx's "{homeCurrencyCode}
          reporting values" precedent. This is the tax screen, where
          precision matters most. */}
      <p className="income-assumption-summary">
        <strong>{history.baseCurrencyCode} reporting values</strong> -- every
        figure on this screen is this portfolio&apos;s base currency.
      </p>

      <dl className="income-metric-list" aria-label="Lifetime capital gains">
        <div className="income-metric-row">
          <dt>Lifetime discountable gains</dt>
          <dd>
            {formatIncomeMoney(
              history.baseCurrencyCode,
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
              history.baseCurrencyCode,
              lifetime.totalLossesDecimal,
            )}
            {/*
              Reviewer fix (round 1 BLOCKING): this used to show the
              STANDALONE per-FY unabsorbed sum (`lifetime.totalUnabsorbedLossDecimal`),
              which can be nonzero even when the carry chain has fully
              absorbed those losses into a later FY's gain (finalCarryOut
              "0") -- directly contradicting the carried net capital gain
              line below it. The suffix here is now driven by
              `carryChain.finalCarryOutLossDecimal` (the TRUE amount still
              unabsorbed after the whole chain, not any single FY's own
              standalone figure) so this row can never say "unabsorbed"
              while the chain below says otherwise: zero carry-out renders
              no suffix at all.
            */}
            {hasFinalCarryOut ? (
              <span className="unavailable">
                {" "}
                ·{" "}
                {formatIncomeMoney(
                  history.baseCurrencyCode,
                  history.baseCurrencyCode,
                  carryChain.finalCarryOutLossDecimal,
                )}{" "}
                still carrying forward
                {carryChain.lifetimeNetPartial ? " *" : ""}
              </span>
            ) : null}
          </dd>
        </div>
        <div className="income-metric-row">
          <dt>Lifetime net capital gain estimate (true, carried)</dt>
          <dd>
            {formatIncomeMoney(
              history.baseCurrencyCode,
              history.baseCurrencyCode,
              carryChain.lifetimeNetCapitalGainEstimateDecimal,
            )}
            {carryChain.lifetimeNetPartial ? (
              <span className="unavailable"> *</span>
            ) : null}
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
      {carryChain.perFy.some((entry) => entry.carriedFiguresPartial) ? (
        <p className="unavailable">
          * marks a carried figure that may be understated or overstated: either
          this portfolio&apos;s declared history-completeness date does not
          reach back far enough (see the disclosure above, when shown), or an
          earlier financial year in this chain excluded incomplete-cost-basis
          allocations (see that year&apos;s Coverage column / detail view).
        </p>
      ) : null}

      <GainsDisclaimer />

      {selectedFy ? (
        <FyDetailDialog
          fy={selectedFy}
          currencyCode={history.baseCurrencyCode}
          dialogRef={dialogRef}
          onClose={() => setSelectedFy(null)}
          carried={selectedCarried}
        />
      ) : null}
    </main>
  );
}
