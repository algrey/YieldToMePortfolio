"use client";

// UI-006C: the per-security "Dividends" tab
// (`/portfolio/:id/securities/:portfolioSecurityId/dividends`). Reuses
// UI-006B's `RecordDividendDialog` unchanged for both "+ Record dividend"
// and every history row's click-to-edit/override entry point -- this file's
// job is presenting DIV-001's already-derived rows/lifetime totals in a
// scrollable table (mirroring `income-multi-year.tsx`'s `.income-fy-table`
// pattern) and computing each row's correct dialog PRE-FILL (see
// `buildDialogPrefill` below).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type {
  DerivedDividendRow,
  LifetimeDividendTotals,
} from "../../domain/dividends/index.ts";
import {
  buildDialogPrefill,
  decimalsEqual,
  foldedInImportedCount,
  foldedInReceiptCount,
  formatShares,
  frankingCell,
  freshEntryPrefill,
  SOURCE_LABEL,
  type DialogPrefill,
  type ManualFact,
  type OverrideFact,
} from "../dividend-history-prefill.ts";
import { formatIncomeMoney } from "../income-format.ts";
import { RecordDividendDialog } from "./dividend-assumptions-editor.tsx";

// UI-008 review (carried from portfolio-shell.tsx's dialogs): the refresh
// confirmation dialog disables its confirm button while a refresh is
// pending, so a fetch that never settles would leave the owner stuck with
// no way to retry. `runRefresh` races the fetch against this bounded
// timeout via AbortController so pending state always resolves and the
// dialog stays open and operable.
const DIALOG_FETCH_TIMEOUT_MS = 15_000;
// UI-009: this fires from a mutation submit (runRefresh), so "try again"
// would invite a retry the client can't know is safe -- reworded to convey
// the genuine uncertainty instead (see portfolio-shell.tsx's identical
// constant for the fuller rationale).
const DIALOG_TIMEOUT_MESSAGE =
  "The request timed out. It may still have gone through — check before retrying.";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function SecurityDividendsTab({
  portfolioId,
  portfolioSecurityId,
  symbol,
  currencyCode,
  today,
  rows,
  filteredArtifactCount,
  lifetimeTotals,
  overridesByEventId,
  manualRecordsById,
  assumptions,
  portfolioAssumptions,
  holdingsHref,
}: {
  portfolioId: string;
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  today: string;
  rows: DerivedDividendRow[];
  /** Count of post-exit zero-share auto rows already suppressed from `rows`
   * -- distinguishes "no dividend history at all" from "every dividend for
   * this security was a post-exit artifact" for the empty-state message
   * (review follow-up 2). */
  filteredArtifactCount: number;
  lifetimeTotals: LifetimeDividendTotals;
  overridesByEventId: Record<string, OverrideFact>;
  manualRecordsById: Record<string, ManualFact>;
  assumptions: {
    dividendYieldPercentDecimal: string | null;
    frankingPercentDecimal: string | null;
    dividendGrowthPercentDecimal: string | null;
    version: number | null;
  };
  portfolioAssumptions: {
    valueGrowthPercentDecimal: string | null;
    portfolioDividendGrowthPercentDecimal: string | null;
    version: number | null;
  };
  holdingsHref: string;
}) {
  const router = useRouter();
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [recordPrefill, setRecordPrefill] = useState<DialogPrefill>(() =>
    freshEntryPrefill(portfolioSecurityId),
  );
  // UI-010: the currently-open row's dominated evidence (a receipt and/or an
  // imported record consumed by this row -- never shown as its own row, see
  // `domain/dividends/history.ts`'s module header), carried alongside the
  // prefill so the dialog can render it as "superseded by this row"
  // provenance. Reset to empty for a fresh (non-row) entry -- there is no
  // row, so nothing can be dominated.
  const [recordDominated, setRecordDominated] = useState<{
    dominatedReceipt: DerivedDividendRow["dominatedReceipt"];
    dominatedImported: DerivedDividendRow["dominatedImported"];
    additionalReceiptsCount: number;
    additionalImportedCount: number;
  }>({
    dominatedReceipt: null,
    dominatedImported: null,
    additionalReceiptsCount: 0,
    additionalImportedCount: 0,
  });
  const recordDialogRef = useRef<HTMLDialogElement>(null);
  const recordOpenerRef = useRef<HTMLButtonElement | null>(null);

  const [refreshDialogOpen, setRefreshDialogOpen] = useState(false);
  const [refreshConfirmed, setRefreshConfirmed] = useState(false);
  const [refreshState, setRefreshState] = useState<
    | { status: "idle" }
    | { status: "pending" }
    | { status: "error"; message: string }
    | { status: "done"; summary: string }
  >({ status: "idle" });
  const refreshDialogRef = useRef<HTMLDialogElement>(null);
  const refreshOpenerRef = useRef<HTMLButtonElement | null>(null);

  const [frankingInput, setFrankingInput] = useState(
    assumptions.frankingPercentDecimal ?? "",
  );
  const [frankingState, setFrankingState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | { status: "error"; message: string }
    | { status: "saved" }
    | { status: "partial"; message: string }
  >({ status: "idle" });

  useEffect(() => {
    const dialog = recordDialogRef.current;
    if (recordDialogOpen && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!recordDialogOpen && dialog?.open) dialog.close();
    if (!recordDialogOpen && recordOpenerRef.current) {
      recordOpenerRef.current.focus();
      recordOpenerRef.current = null;
    }
  }, [recordDialogOpen]);

  useEffect(() => {
    const dialog = refreshDialogRef.current;
    if (refreshDialogOpen && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!refreshDialogOpen && dialog?.open) dialog.close();
    if (!refreshDialogOpen && refreshOpenerRef.current) {
      refreshOpenerRef.current.focus();
      refreshOpenerRef.current = null;
    }
  }, [refreshDialogOpen]);

  function openFreshRecordDialog(event: React.MouseEvent<HTMLButtonElement>) {
    recordOpenerRef.current = event.currentTarget;
    setRecordPrefill(freshEntryPrefill(portfolioSecurityId));
    setRecordDominated({
      dominatedReceipt: null,
      dominatedImported: null,
      additionalReceiptsCount: 0,
      additionalImportedCount: 0,
    });
    setRecordDialogOpen(true);
  }

  function openRowDialog(
    row: DerivedDividendRow,
    event: React.MouseEvent<HTMLButtonElement>,
  ) {
    recordOpenerRef.current = event.currentTarget;
    setRecordPrefill(
      buildDialogPrefill(
        row,
        portfolioSecurityId,
        overridesByEventId,
        manualRecordsById,
        today,
      ),
    );
    setRecordDominated({
      dominatedReceipt: row.dominatedReceipt,
      dominatedImported: row.dominatedImported,
      additionalReceiptsCount: row.additionalReceiptsCount,
      additionalImportedCount: row.additionalImportedCount,
    });
    setRecordDialogOpen(true);
  }

  async function runRefresh() {
    setRefreshState({ status: "pending" });
    // UI-008: "Refresh historical" is disabled while pending -- bound the
    // fetch so a stalled request can't leave the owner stuck.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/securities/${portfolioSecurityId}/dividends/refresh`,
        { method: "POST", signal: controller.signal },
      );
      const result = (await response.json()) as
        | {
            ok: true;
            summary: {
              dividends: {
                created: number;
                superseded: number;
                statusUpdated: number;
                unchanged: number;
              };
            };
          }
        | { ok: false; message: string };
      if (!result.ok) {
        setRefreshState({ status: "error", message: result.message });
        return;
      }
      const { created, superseded, statusUpdated, unchanged } =
        result.summary.dividends;
      setRefreshState({
        status: "done",
        summary: `${created} new, ${superseded} corrected, ${statusUpdated} updated, ${unchanged} unchanged. Your overrides and exclusions were preserved.`,
      });
      setRefreshConfirmed(false);
      router.refresh();
    } catch (error) {
      setRefreshState({
        status: "error",
        message: isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : "The refresh could not be started. Check your connection and retry.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function saveFrankingDefault() {
    setFrankingState({ status: "saving" });
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/dividend-assumptions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            securities: [
              {
                portfolioSecurityId,
                dividendYieldPercentDecimal:
                  assumptions.dividendYieldPercentDecimal,
                frankingPercentDecimal:
                  frankingInput.trim().length > 0 ? frankingInput.trim() : null,
                dividendGrowthPercentDecimal:
                  assumptions.dividendGrowthPercentDecimal,
                expectedVersion: assumptions.version,
              },
            ],
            portfolio: {
              valueGrowthPercentDecimal:
                portfolioAssumptions.valueGrowthPercentDecimal,
              portfolioDividendGrowthPercentDecimal:
                portfolioAssumptions.portfolioDividendGrowthPercentDecimal,
              expectedVersion: portfolioAssumptions.version,
            },
          }),
        },
      );
      const result = (await response.json()) as
        | { ok: true }
        | {
            ok: false;
            message: string;
            appliedSecurities: {
              portfolioSecurityId: string;
              version: number;
            }[];
          };
      if (result.ok) {
        setFrankingState({ status: "saved" });
        router.refresh();
        return;
      }
      // Follow-up 4 (review): the whole-grid endpoint is not atomic across
      // its security row(s) and the portfolio row (see
      // `saveDividendAssumptionsGridWithContext`'s own B5 note) -- a
      // portfolio-level version conflict AFTER this security's own row
      // already committed must not be reported as a bare, misleading
      // failure. `appliedSecurities` names every row that committed before
      // the failure; if THIS security is in it, the franking value is
      // already saved even though the response's top-level `ok` is false.
      const committed = result.appliedSecurities.some(
        (row) => row.portfolioSecurityId === portfolioSecurityId,
      );
      if (committed) {
        setFrankingState({
          status: "partial",
          message: `Franking default saved. ${result.message}`,
        });
        router.refresh();
        return;
      }
      setFrankingState({ status: "error", message: result.message });
    } catch {
      setFrankingState({
        status: "error",
        message:
          "The franking default could not be saved. Check your connection and retry.",
      });
    }
  }

  return (
    <main className="income-screen">
      <p className="eyebrow">Dividends</p>
      <h1>{symbol}</h1>
      <p className="income-subtitle">
        <Link href={holdingsHref}>Back to holdings</Link>
      </p>

      <div className="dividend-assumptions-actions">
        <button type="button" onClick={openFreshRecordDialog}>
          + Record dividend
        </button>
        <button
          type="button"
          onClick={(event) => {
            refreshOpenerRef.current = event.currentTarget;
            setRefreshState({ status: "idle" });
            setRefreshConfirmed(false);
            setRefreshDialogOpen(true);
          }}
        >
          Refresh historical
        </button>
      </div>

      <div className="dividend-franking-default">
        <label>
          Franking if not known (%)
          <input
            type="text"
            inputMode="decimal"
            placeholder="0-100"
            value={frankingInput}
            onChange={(event) => {
              setFrankingState({ status: "idle" });
              setFrankingInput(event.target.value);
            }}
          />
        </label>
        <button
          type="button"
          onClick={saveFrankingDefault}
          disabled={frankingState.status === "saving"}
        >
          {frankingState.status === "saving" ? "Saving…" : "Save default"}
        </button>
        {frankingState.status === "saved" ? <span>Saved.</span> : null}
        {frankingState.status === "partial" ? (
          <span role="status" className="dividend-status-partial">
            {frankingState.message}
          </span>
        ) : null}
        {frankingState.status === "error" ? (
          <span role="alert" className="unavailable">
            {frankingState.message}
          </span>
        ) : null}
      </div>

      <div className="income-fy-table-wrap">
        <table className="income-fy-table">
          <caption>{symbol} dividend history</caption>
          <thead>
            <tr>
              <th scope="col">Payment date</th>
              <th scope="col" className="numeric">
                Shares at ex-date
              </th>
              <th scope="col" className="numeric">
                Per share
              </th>
              <th scope="col" className="numeric">
                Franking/share
              </th>
              <th scope="col" className="numeric">
                Cash
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
                <td colSpan={8}>
                  {filteredArtifactCount > 0
                    ? "No dividends received while you held this security."
                    : "No dividend history for this security yet."}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const notPaid = row.status === "declared_pending";
                // Follow-up 2 (review): a STANDALONE imported row
                // (`source: "imported"`, no linked event) can only ever be
                // changed by reversing the import batch that created it --
                // `dividend-assumptions-actions.ts`'s B1 409 already
                // enforces this server-side. Rather than let the owner open
                // the edit dialog and discover that only on a failed save,
                // this row is not clickable at all; its date cell is plain
                // text annotated with why. An event-linked row where
                // "imported" merely happens to be the currently-winning
                // SOURCE (dividendEventId !== null) is NOT included here --
                // overriding the underlying provider event is still a
                // legitimate, unblocked action for that row.
                const importedReadOnly =
                  row.source === "imported" && row.dividendEventId === null;
                const dateLabel =
                  row.paymentDate ??
                  (row.exDate
                    ? `${row.exDate} (ex-date, payment date unknown)`
                    : "Unknown date");
                // B2 (review): the provider's own, unedited per-share amount
                // is computed for exactly this ("provider says X, you
                // overrode to Y" -- see docs/CALCULATIONS.md section 11) but
                // was never rendered anywhere. Shown whenever it differs
                // from the value actually winning the row, regardless of
                // which tier won (edited/manual/imported/receipt). Follow-up
                // 1 (review round 2): compared numerically via
                // `decimalsEqual`, not a raw string `!==` -- "1.5" and
                // "1.50" are the same value at different textual scale and
                // must never render a spurious "differs" annotation.
                const providerDiffers =
                  row.providerGrossPerShareDecimal !== null &&
                  row.dividendPerShareDecimal !== null &&
                  !decimalsEqual(
                    row.providerGrossPerShareDecimal,
                    row.dividendPerShareDecimal,
                  );
                // UI-010: dominated-evidence disclosure -- a receipt and/or
                // an imported record consumed by this row (never shown as
                // its own row) is disclosed here as a compact text marker so
                // the "disclosed, not silently dropped" guarantee is
                // actually visible, not just a type-level fact. Text, not
                // colour, per QA-001B.
                const foldedReceipts = foldedInReceiptCount(row);
                const foldedImported = foldedInImportedCount(row);
                return (
                  <tr
                    key={row.id}
                    className={notPaid ? "dividend-row-not-paid" : undefined}
                  >
                    <th scope="row">
                      {importedReadOnly ? (
                        <span>
                          {dateLabel}
                          <br />
                          <span className="dividend-imported-note">
                            imported · change via import reversal
                          </span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="income-row-trigger"
                          onClick={(event) => openRowDialog(row, event)}
                          aria-label={`Edit or override the dividend paid ${
                            row.paymentDate ??
                            row.exDate ??
                            "on an unknown date"
                          }`}
                        >
                          {dateLabel}
                        </button>
                      )}
                    </th>
                    <td className="numeric">
                      {row.sharesDecimal === null
                        ? "Unknown"
                        : formatShares(row.sharesDecimal)}
                    </td>
                    <td className="numeric">
                      {row.dividendPerShareDecimal === null
                        ? "Unknown"
                        : formatIncomeMoney(
                            row.currencyCode,
                            row.dividendPerShareDecimal,
                          )}
                      {providerDiffers ? (
                        <>
                          <br />
                          <span className="dividend-provider-note">
                            provider:{" "}
                            {formatIncomeMoney(
                              row.currencyCode,
                              row.providerGrossPerShareDecimal,
                            )}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="numeric">
                      {frankingCell(row.franking, row.currencyCode)}
                    </td>
                    <td className="numeric">
                      {formatIncomeMoney(row.currencyCode, row.cashDecimal)}
                    </td>
                    <td className="numeric">
                      {formatIncomeMoney(row.currencyCode, row.grossDecimal)}
                    </td>
                    <td>
                      <span className="income-source">
                        {SOURCE_LABEL[row.source]}
                        {row.excluded ? " · excluded" : ""}
                      </span>
                      {foldedReceipts > 0 ? (
                        <>
                          <br />
                          <span className="dividend-fold-note">
                            +{foldedReceipts} receipt
                            {foldedReceipts === 1 ? "" : "s"} folded in
                          </span>
                        </>
                      ) : null}
                      {foldedImported > 0 ? (
                        <>
                          <br />
                          <span className="dividend-fold-note">
                            +{foldedImported} imported folded in
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {notPaid ? (
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

      <dl className="income-metric-list dividend-lifetime-summary">
        <div className="income-metric-row">
          <dt>Cash received (lifetime)</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              lifetimeTotals.receivedCashDecimal,
            )}
          </dd>
        </div>
        <div className="income-metric-row">
          <dt>Franking credits received (lifetime)</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              lifetimeTotals.receivedFrankingKnownDecimal,
            )}
            {lifetimeTotals.receivedFrankingUnknownCount > 0
              ? ` · ${lifetimeTotals.receivedFrankingUnknownCount} with unknown franking`
              : ""}
          </dd>
        </div>
        <div className="income-metric-row">
          <dt>Gross received (lifetime)</dt>
          <dd>
            {formatIncomeMoney(
              currencyCode,
              lifetimeTotals.receivedGrossDecimal,
            )}
          </dd>
        </div>
        <div className="income-metric-row">
          <dt>Declared, not yet paid</dt>
          <dd>
            {lifetimeTotals.pendingCount === 0
              ? "None"
              : `${formatIncomeMoney(currencyCode, lifetimeTotals.pendingGrossDecimal)} across ${lifetimeTotals.pendingCount} dividend${lifetimeTotals.pendingCount === 1 ? "" : "s"}`}
          </dd>
        </div>
      </dl>
      {rows.some(
        (row) =>
          foldedInReceiptCount(row) > 0 || foldedInImportedCount(row) > 0,
      ) ? (
        <p className="income-subtitle">
          Some rows fold in additional records — see row details.
        </p>
      ) : null}
      {lifetimeTotals.excludedCount > 0 ||
      lifetimeTotals.unknownAmountCount > 0 ? (
        <p className="income-subtitle">
          {lifetimeTotals.excludedCount > 0
            ? `${lifetimeTotals.excludedCount} excluded from totals. `
            : ""}
          {lifetimeTotals.unknownAmountCount > 0
            ? `${lifetimeTotals.unknownAmountCount} with an unknown amount, excluded from totals.`
            : ""}
        </p>
      ) : null}

      {recordDialogOpen ? (
        <RecordDividendDialog
          dialogRef={recordDialogRef}
          portfolioId={portfolioId}
          securities={[{ portfolioSecurityId, symbol, currencyCode }]}
          maxDate={today}
          onClose={() => setRecordDialogOpen(false)}
          initialPortfolioSecurityId={recordPrefill.initialPortfolioSecurityId}
          initialPaymentDate={recordPrefill.initialPaymentDate}
          initialDividendEventId={recordPrefill.initialDividendEventId}
          initialManualRecordId={recordPrefill.initialManualRecordId}
          initialSharesDecimal={recordPrefill.initialSharesDecimal}
          initialDividendPerShareDecimal={
            recordPrefill.initialDividendPerShareDecimal
          }
          initialFrankingCreditPerShareDecimal={
            recordPrefill.initialFrankingCreditPerShareDecimal
          }
          initialExpectedVersion={recordPrefill.initialExpectedVersion}
          initialExclude={recordPrefill.initialExclude}
          dominatedReceipt={recordDominated.dominatedReceipt}
          dominatedImported={recordDominated.dominatedImported}
          additionalReceiptsCount={recordDominated.additionalReceiptsCount}
          additionalImportedCount={recordDominated.additionalImportedCount}
        />
      ) : null}

      {refreshDialogOpen ? (
        <dialog
          ref={refreshDialogRef}
          className="income-dialog"
          aria-labelledby="dividend-refresh-title"
          onCancel={(event) => {
            event.preventDefault();
            refreshDialogRef.current?.close();
            setRefreshDialogOpen(false);
          }}
          onClose={() => setRefreshDialogOpen(false)}
        >
          <button
            type="button"
            className="sheet-close"
            onClick={() => refreshDialogRef.current?.close()}
          >
            Close
          </button>
          <p className="eyebrow" id="dividend-refresh-title">
            Refresh historical dividends
          </p>
          <p>
            This re-pulls {symbol}&apos;s full provider dividend and split
            history. Your edits, overrides, and exclusions are preserved -- this
            only adds or corrects provider facts.
          </p>
          <label className="import-confirmation">
            <input
              type="checkbox"
              checked={refreshConfirmed}
              onChange={(event) => setRefreshConfirmed(event.target.checked)}
            />
            <span>I understand and want to refresh provider history.</span>
          </label>
          <button
            type="button"
            className="dividend-refresh-confirm-button"
            onClick={runRefresh}
            disabled={!refreshConfirmed || refreshState.status === "pending"}
          >
            {refreshState.status === "pending"
              ? "Refreshing…"
              : "Refresh historical"}
          </button>
          {refreshState.status === "error" ? (
            <p role="alert" className="unavailable">
              {refreshState.message}
            </p>
          ) : null}
          {refreshState.status === "done" ? (
            <p role="status">{refreshState.summary}</p>
          ) : null}
        </dialog>
      ) : null}
    </main>
  );
}
