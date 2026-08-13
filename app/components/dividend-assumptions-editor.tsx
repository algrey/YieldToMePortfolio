"use client";

// UI-006B: the dividend assumptions editor (`/portfolio/:id/income/
// assumptions`) -- reached only from the Income screen's coverage link and
// "Set dividend assumptions" empty-state link (UI-006A), never a
// per-security navigation. Wireframe decisions (TASKS.md UI-006B, owner
// review 2026-08-13): the provider-franking column stays as an honest
// always-"unavail." seam for a future source; the whole-portfolio growth
// inputs sit BELOW the grid, separated by a divider; "+ Record dividend
// received" and "+ Override a past FY" live only on this screen; the
// record/override form is PER-SHARE (security, payment date, shares held at
// that date -- auto-populated, editable -- dividend per share, franking
// credit per share) with live computed cash/franking totals; mobile
// collapses the grid to one block per security separated by dividers, no
// filter box (the established `.desktop-only`/`.mobile-only` 700px
// breakpoint, matching every other responsive surface in this app).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  addDecimal,
  formatDecimalFixed,
  multiplyDecimal,
  parseDecimal,
} from "../../domain/calculations/decimal.ts";
import { formatIncomeMoney, formatIncomePercent } from "../income-format.ts";

type ProviderYield =
  | { ok: true; trailingYieldPercentDecimal: string }
  | { ok: false; reason: string };

export type DividendAssumptionsSecurityRowProps = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  providerYield: ProviderYield;
  providerFrankingStatus: "unavailable";
  ownerYieldPercentDecimal: string | null;
  ownerFrankingPercentDecimal: string | null;
  ownerGrowthPercentDecimal: string | null;
  version: number | null;
};

export type DividendAssumptionsPortfolioRowProps = {
  valueGrowthPercentDecimal: string | null;
  portfolioDividendGrowthPercentDecimal: string | null;
  version: number | null;
};

export type DividendAssumptionsFyOverrideProps = {
  financialYearEndingYear: number;
  grossedAmountDecimal: string;
  frankingAmountDecimal: string | null;
  version: number;
};

/** Mirrors `app/dividend-assumptions-actions.ts`'s `SavedAssumptionsRow` -- defined locally rather than imported so this client component never depends on the server-only actions module, even by type. */
type SavedAssumptionsRow = { portfolioSecurityId: string; version: number };

type SecurityDraft = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  providerYield: ProviderYield;
  yieldInput: string;
  frankingInput: string;
  growthInput: string;
  version: number | null;
};

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function providerYieldLabel(providerYield: ProviderYield): string {
  return providerYield.ok
    ? formatIncomePercent(providerYield.trailingYieldPercentDecimal)
    : "Unavailable";
}

function safeCents(compute: () => string): string | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

export function DividendAssumptionsEditor({
  portfolioId,
  today,
  securities,
  portfolio,
  fyOverrides,
  incomeHref,
  initialOverrideYear,
}: {
  portfolioId: string;
  today: string;
  securities: DividendAssumptionsSecurityRowProps[];
  portfolio: DividendAssumptionsPortfolioRowProps;
  fyOverrides: DividendAssumptionsFyOverrideProps[];
  incomeHref: string;
  initialOverrideYear: number | null;
}) {
  const [securityDrafts, setSecurityDrafts] = useState<SecurityDraft[]>(() =>
    securities.map((row) => ({
      portfolioSecurityId: row.portfolioSecurityId,
      symbol: row.symbol,
      currencyCode: row.currencyCode,
      providerYield: row.providerYield,
      yieldInput: row.ownerYieldPercentDecimal ?? "",
      frankingInput: row.ownerFrankingPercentDecimal ?? "",
      growthInput: row.ownerGrowthPercentDecimal ?? "",
      version: row.version,
    })),
  );
  const [portfolioDraft, setPortfolioDraft] = useState({
    valueGrowthInput: portfolio.valueGrowthPercentDecimal ?? "",
    dividendGrowthInput: portfolio.portfolioDividendGrowthPercentDecimal ?? "",
    version: portfolio.version,
  });
  const router = useRouter();

  // B5 (UI-006B review fix): the whole-grid save is NOT one atomic
  // transaction (DB-005 has no cross-entity atomic batch for this shape --
  // see the module comment on `saveDividendAssumptionsGridWithContext`), so
  // a mid-sequence failure must disclose EXACTLY which rows already
  // committed (never just a generic "save failed") -- `appliedSecurities`/
  // `failedPortfolioSecurityId` are carried into this state so the error UI
  // can name the conflicting security and state plainly that the remaining
  // rows and the portfolio row were not saved.
  const [saveState, setSaveState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | {
        status: "error";
        message: string;
        appliedSecurities: SavedAssumptionsRow[];
        failedPortfolioSecurityId?: string;
      }
    | { status: "saved" }
  >({ status: "idle" });

  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [fyDialogOpen, setFyDialogOpen] = useState(
    initialOverrideYear !== null,
  );
  const recordDialogRef = useRef<HTMLDialogElement>(null);
  const fyDialogRef = useRef<HTMLDialogElement>(null);
  // B4 (UI-006B review fix): mirrors `income-multi-year.tsx`'s
  // `rowOpenerRef` focus-management pattern (QA-001B K3) -- the button that
  // opened a dialog is captured here at click time so focus can be
  // restored to it when the dialog closes; when a dialog opens WITHOUT a
  // captured opener (the FY dialog auto-opening from `initialOverrideYear`,
  // a `?overrideYear=` deep link with no button click in this render), the
  // restore step below simply has nothing to focus and no-ops.
  const recordDialogOpenerRef = useRef<HTMLButtonElement | null>(null);
  const fyDialogOpenerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = recordDialogRef.current;
    if (recordDialogOpen && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!recordDialogOpen && dialog?.open) dialog.close();
    if (!recordDialogOpen && recordDialogOpenerRef.current) {
      recordDialogOpenerRef.current.focus();
      recordDialogOpenerRef.current = null;
    }
  }, [recordDialogOpen]);
  useEffect(() => {
    const dialog = fyDialogRef.current;
    if (fyDialogOpen && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!fyDialogOpen && dialog?.open) dialog.close();
    if (!fyDialogOpen && fyDialogOpenerRef.current) {
      fyDialogOpenerRef.current.focus();
      fyDialogOpenerRef.current = null;
    }
  }, [fyDialogOpen]);

  function symbolFor(portfolioSecurityId: string): string {
    return (
      securityDrafts.find(
        (row) => row.portfolioSecurityId === portfolioSecurityId,
      )?.symbol ?? portfolioSecurityId
    );
  }

  function updateSecurityDraft(
    portfolioSecurityId: string,
    field: "yieldInput" | "frankingInput" | "growthInput",
    value: string,
  ) {
    setSaveState({ status: "idle" });
    setSecurityDrafts((rows) =>
      rows.map((row) =>
        row.portfolioSecurityId === portfolioSecurityId
          ? { ...row, [field]: value }
          : row,
      ),
    );
  }

  async function saveGrid() {
    setSaveState({ status: "saving" });
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/dividend-assumptions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            securities: securityDrafts.map((row) => ({
              portfolioSecurityId: row.portfolioSecurityId,
              dividendYieldPercentDecimal: blankToNull(row.yieldInput),
              frankingPercentDecimal: blankToNull(row.frankingInput),
              dividendGrowthPercentDecimal: blankToNull(row.growthInput),
              expectedVersion: row.version,
            })),
            portfolio: {
              valueGrowthPercentDecimal: blankToNull(
                portfolioDraft.valueGrowthInput,
              ),
              portfolioDividendGrowthPercentDecimal: blankToNull(
                portfolioDraft.dividendGrowthInput,
              ),
              expectedVersion: portfolioDraft.version,
            },
          }),
        },
      );
      const result = (await response.json()) as
        | {
            ok: true;
            securities: SavedAssumptionsRow[];
            portfolio: { version: number };
          }
        | {
            ok: false;
            message: string;
            appliedSecurities: SavedAssumptionsRow[];
            failedPortfolioSecurityId?: string;
          };
      if (result.ok) {
        const versionById = new Map(
          result.securities.map((row) => [
            row.portfolioSecurityId,
            row.version,
          ]),
        );
        setSecurityDrafts((rows) =>
          rows.map((row) =>
            versionById.has(row.portfolioSecurityId)
              ? { ...row, version: versionById.get(row.portfolioSecurityId)! }
              : row,
          ),
        );
        setPortfolioDraft((draft) => ({
          ...draft,
          version: result.portfolio.version,
        }));
        setSaveState({ status: "saved" });
        // F4: this page's data (`securities`/`portfolio` props) is
        // server-rendered and would otherwise go stale in-session --
        // mirrors `portfolio-shell.tsx`'s settings-save `router.refresh()`
        // pattern.
        router.refresh();
        return;
      }
      if (result.appliedSecurities.length > 0) {
        const versionById = new Map(
          result.appliedSecurities.map((row) => [
            row.portfolioSecurityId,
            row.version,
          ]),
        );
        setSecurityDrafts((rows) =>
          rows.map((row) =>
            versionById.has(row.portfolioSecurityId)
              ? { ...row, version: versionById.get(row.portfolioSecurityId)! }
              : row,
          ),
        );
      }
      setSaveState({
        status: "error",
        message: result.message,
        appliedSecurities: result.appliedSecurities,
        failedPortfolioSecurityId: result.failedPortfolioSecurityId,
      });
    } catch {
      setSaveState({
        status: "error",
        message:
          "The assumptions could not be saved. Check your connection and retry.",
        appliedSecurities: [],
      });
    }
  }

  return (
    <main className="income-screen">
      <p className="eyebrow">Income</p>
      <h1>Dividend assumptions</h1>
      <p className="income-subtitle">
        <Link href={incomeHref}>Back to Income</Link>
      </p>

      <div className="dividend-assumptions-actions">
        <button
          type="button"
          onClick={(event) => {
            recordDialogOpenerRef.current = event.currentTarget;
            setRecordDialogOpen(true);
          }}
        >
          + Record dividend received
        </button>
        <button
          type="button"
          onClick={(event) => {
            fyDialogOpenerRef.current = event.currentTarget;
            setFyDialogOpen(true);
          }}
        >
          + Override a past FY
        </button>
      </div>

      {securityDrafts.length === 0 ? (
        <p>No held securities to set assumptions for yet.</p>
      ) : (
        <>
          <p id="dividend-assumptions-help" className="income-subtitle">
            Enter percentages as plain numbers, e.g. 4.2 for 4.2%. Franking:
            0-100, where 100 = fully franked. A blank cell uses the provider
            value where available; clearing a cell restores that fallback.
          </p>
          <div
            className="dividend-assumptions-grid"
            role="table"
            aria-label="Dividend assumptions per security"
          >
            <div
              className="dividend-assumptions-header-row desktop-only"
              role="row"
            >
              <span role="columnheader">Security</span>
              <span role="columnheader">Provider yield</span>
              <span role="columnheader">Provider franking</span>
              <span role="columnheader">Yield %</span>
              <span role="columnheader">Franking %</span>
              <span role="columnheader">Dividend growth %</span>
            </div>
            {securityDrafts.map((row) => (
              <div
                className="dividend-assumptions-row"
                role="row"
                key={row.portfolioSecurityId}
              >
                <span className="dividend-assumptions-symbol" role="rowheader">
                  {row.symbol}
                </span>
                <span className="dividend-assumptions-static" role="cell">
                  <span className="mobile-only dividend-assumptions-static-label">
                    Provider yield{" "}
                  </span>
                  {providerYieldLabel(row.providerYield)}
                </span>
                <span
                  className="dividend-assumptions-static unavailable"
                  role="cell"
                >
                  <span className="mobile-only dividend-assumptions-static-label">
                    Provider franking{" "}
                  </span>
                  Unavailable
                </span>
                <span role="cell">
                  <label>
                    <span className="mobile-only">{row.symbol} yield % </span>
                    <span className="desktop-only sr-only">
                      {row.symbol} dividend yield percent
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. 4.2"
                      aria-describedby="dividend-assumptions-help"
                      value={row.yieldInput}
                      onChange={(event) =>
                        updateSecurityDraft(
                          row.portfolioSecurityId,
                          "yieldInput",
                          event.target.value,
                        )
                      }
                    />
                  </label>
                </span>
                <span role="cell">
                  <label>
                    <span className="mobile-only">
                      {row.symbol} franking %{" "}
                    </span>
                    <span className="desktop-only sr-only">
                      {row.symbol} franking percent, 100 means fully franked
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0-100"
                      aria-describedby="dividend-assumptions-help"
                      value={row.frankingInput}
                      onChange={(event) =>
                        updateSecurityDraft(
                          row.portfolioSecurityId,
                          "frankingInput",
                          event.target.value,
                        )
                      }
                    />
                  </label>
                </span>
                <span role="cell">
                  <label>
                    <span className="mobile-only">
                      {row.symbol} dividend growth %{" "}
                    </span>
                    <span className="desktop-only sr-only">
                      {row.symbol} dividend growth percent
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. 2 or -1"
                      aria-describedby="dividend-assumptions-help"
                      value={row.growthInput}
                      onChange={(event) =>
                        updateSecurityDraft(
                          row.portfolioSecurityId,
                          "growthInput",
                          event.target.value,
                        )
                      }
                    />
                  </label>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="dividend-assumptions-portfolio">
        <p className="eyebrow">Whole-portfolio assumptions</p>
        <div className="manual-ledger-grid">
          <label>
            Portfolio value growth %
            <input
              type="text"
              inputMode="decimal"
              placeholder="e.g. 3"
              value={portfolioDraft.valueGrowthInput}
              onChange={(event) => {
                setSaveState({ status: "idle" });
                setPortfolioDraft((draft) => ({
                  ...draft,
                  valueGrowthInput: event.target.value,
                }));
              }}
            />
          </label>
          <label>
            Portfolio dividend growth %
            <input
              type="text"
              inputMode="decimal"
              placeholder="e.g. 2"
              value={portfolioDraft.dividendGrowthInput}
              onChange={(event) => {
                setSaveState({ status: "idle" });
                setPortfolioDraft((draft) => ({
                  ...draft,
                  dividendGrowthInput: event.target.value,
                }));
              }}
            />
          </label>
        </div>
      </div>

      <div className="dividend-assumptions-save-bar">
        <button
          type="button"
          onClick={saveGrid}
          disabled={saveState.status === "saving"}
        >
          {saveState.status === "saving" ? "Saving…" : "Save assumptions"}
        </button>
        {saveState.status === "error" ? (
          <div role="alert" className="unavailable">
            <p>{saveState.message}</p>
            {/* B5: the whole-grid save is not atomic -- state plainly which
                rows already committed, name the conflicting security, and
                say the rest (including the portfolio row) did not save. */}
            {saveState.appliedSecurities.length > 0 ? (
              <p>
                Saved so far:{" "}
                {saveState.appliedSecurities
                  .map((row) => symbolFor(row.portfolioSecurityId))
                  .join(", ")}
                .{" "}
                {saveState.failedPortfolioSecurityId
                  ? `${symbolFor(saveState.failedPortfolioSecurityId)} did not save; nothing after it, and the whole-portfolio row, was saved either.`
                  : "The whole-portfolio row did not save."}
              </p>
            ) : (
              <p>Nothing was saved.</p>
            )}
          </div>
        ) : null}
        {saveState.status === "saved" ? <p>Saved.</p> : null}
      </div>

      {recordDialogOpen ? (
        <RecordDividendDialog
          dialogRef={recordDialogRef}
          portfolioId={portfolioId}
          securities={securityDrafts}
          maxDate={today}
          onClose={() => setRecordDialogOpen(false)}
        />
      ) : null}

      {fyDialogOpen ? (
        <OverrideFyDialog
          dialogRef={fyDialogRef}
          portfolioId={portfolioId}
          existingOverrides={fyOverrides}
          initialYear={initialOverrideYear}
          onClose={() => setFyDialogOpen(false)}
        />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Record / override dividend dialog -- per-share (TASKS.md UI-006B's
// second-round wireframe revision). The same form records a manual
// dividend (no linked event) and overrides an auto-populated one (a linked
// event, pre-filled when opened from a history row -- UI-006C wires that
// entry point; this form already accepts the props it needs to).
// ---------------------------------------------------------------------------

export function RecordDividendDialog({
  dialogRef,
  portfolioId,
  securities,
  maxDate,
  onClose,
  initialPortfolioSecurityId = null,
  initialPaymentDate = null,
  initialDividendEventId = null,
  initialManualRecordId = null,
  initialSharesDecimal = null,
  initialDividendPerShareDecimal = null,
  initialFrankingCreditPerShareDecimal = null,
  initialExpectedVersion = null,
  initialExclude = false,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  portfolioId: string;
  securities: {
    portfolioSecurityId: string;
    symbol: string;
    currencyCode: string;
  }[];
  maxDate: string;
  onClose: () => void;
  initialPortfolioSecurityId?: string | null;
  initialPaymentDate?: string | null;
  initialDividendEventId?: string | null;
  initialManualRecordId?: string | null;
  initialSharesDecimal?: string | null;
  initialDividendPerShareDecimal?: string | null;
  initialFrankingCreditPerShareDecimal?: string | null;
  initialExpectedVersion?: number | null;
  initialExclude?: boolean;
}) {
  const router = useRouter();
  // Event-linked (overriding an auto/provider row) vs a plain owner-typed
  // manual record -- fixed for the dialog's lifetime by which entry point
  // opened it (UI-006C's history-row entry always supplies
  // `initialDividendEventId` for the former).
  const isEventLinked = initialDividendEventId !== null;
  const [portfolioSecurityId, setPortfolioSecurityId] = useState(
    initialPortfolioSecurityId ?? securities[0]?.portfolioSecurityId ?? "",
  );
  const [paymentDate, setPaymentDate] = useState(initialPaymentDate ?? "");
  const [shares, setShares] = useState(initialSharesDecimal ?? "");
  const [sharesTouched, setSharesTouched] = useState(
    initialSharesDecimal !== null,
  );
  const [dividendPerShare, setDividendPerShare] = useState(
    initialDividendPerShareDecimal ?? "",
  );
  const [frankingPerShare, setFrankingPerShare] = useState(
    initialFrankingCreditPerShareDecimal ?? "",
  );
  // B3: "Exclude this dividend" for an event-linked row is a checkbox on
  // this same save (routes to `dividend_event_overrides.exclude`, which
  // keeps the row retrievable/excluded rather than deleting anything).
  const [excludeChecked, setExcludeChecked] = useState(initialExclude);
  // F1 (UI-006B review fix): tracks the persisted identity/version so a
  // SECOND submit (e.g. the owner edits and saves again without closing)
  // UPDATES the row this dialog already created instead of silently
  // creating a duplicate `dividend_manual_records` row (which has no
  // uniqueness constraint to catch a resubmitted create). Event-linked
  // saves are keyed by `dividendEventId`, not an id this dialog tracks, but
  // still need their OWN version to switch from create to update the same
  // way.
  const [savedManualRecordId, setSavedManualRecordId] = useState(
    initialManualRecordId,
  );
  const [savedVersion, setSavedVersion] = useState(initialExpectedVersion);
  const [submitState, setSubmitState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | { status: "error"; message: string }
    | { status: "saved"; proximityWarning: string | null }
  >({ status: "idle" });
  const [deleteState, setDeleteState] = useState<
    | { status: "idle" }
    | { status: "deleting" }
    | { status: "error"; message: string }
    | { status: "deleted" }
  >({ status: "idle" });

  useEffect(() => {
    if (sharesTouched) return;
    if (!portfolioSecurityId || !paymentDate) return;
    let cancelled = false;
    fetch(
      `/api/portfolios/${portfolioId}/dividend-shares-at-date?${new URLSearchParams(
        { portfolioSecurityId, date: paymentDate },
      )}`,
    )
      .then((response) => response.json())
      .then((raw: unknown) => {
        const result = raw as { ok: boolean; sharesDecimal?: string };
        if (
          !cancelled &&
          result.ok &&
          typeof result.sharesDecimal === "string"
        ) {
          setShares(result.sharesDecimal);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [portfolioId, portfolioSecurityId, paymentDate, sharesTouched]);

  const cashTotal = safeCents(() =>
    formatDecimalFixed(
      multiplyDecimal(
        parseDecimal(shares || "0"),
        parseDecimal(dividendPerShare || "0"),
      ),
      2,
    ),
  );
  const frankingTotal = frankingPerShare.trim()
    ? safeCents(() =>
        formatDecimalFixed(
          multiplyDecimal(
            parseDecimal(shares || "0"),
            parseDecimal(frankingPerShare),
          ),
          2,
        ),
      )
    : null;
  const grossTotal =
    cashTotal !== null
      ? frankingTotal !== null
        ? safeCents(() =>
            formatDecimalFixed(
              addDecimal(parseDecimal(cashTotal), parseDecimal(frankingTotal)),
              2,
            ),
          )
        : cashTotal
      : null;
  const currencyCode =
    securities.find((row) => row.portfolioSecurityId === portfolioSecurityId)
      ?.currencyCode ?? "";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitState({ status: "saving" });
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/dividend-entries`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            portfolioSecurityId,
            paymentDate,
            sharesDecimal: shares,
            dividendPerShareDecimal: dividendPerShare,
            frankingCreditPerShareDecimal: blankToNull(frankingPerShare),
            dividendEventId: initialDividendEventId,
            manualRecordId: isEventLinked ? null : savedManualRecordId,
            expectedVersion: savedVersion,
            exclude: excludeChecked,
          }),
        },
      );
      const result = (await response.json()) as
        | {
            ok: true;
            target: "manual_record" | "event_override";
            id: string;
            version: number;
            proximityWarning: string | null;
          }
        | { ok: false; message: string };
      if (!result.ok) {
        setSubmitState({ status: "error", message: result.message });
        return;
      }
      // F1: switch to update mode for any further submit in this dialog.
      setSavedVersion(result.version);
      if (result.target === "manual_record") {
        setSavedManualRecordId(result.id);
      }
      setSubmitState({
        status: "saved",
        proximityWarning: result.proximityWarning,
      });
      router.refresh(); // F4
    } catch {
      setSubmitState({
        status: "error",
        message:
          "The dividend could not be saved. Check your connection and retry.",
      });
    }
  }

  async function deleteRecord() {
    if (savedManualRecordId === null || savedVersion === null) return;
    setDeleteState({ status: "deleting" });
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/dividend-entries`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            manualRecordId: savedManualRecordId,
            expectedVersion: savedVersion,
          }),
        },
      );
      const result = (await response.json()) as
        { ok: true } | { ok: false; message: string };
      if (!result.ok) {
        setDeleteState({ status: "error", message: result.message });
        return;
      }
      setDeleteState({ status: "deleted" });
      router.refresh(); // F4
      dialogRef.current?.close();
      onClose();
    } catch {
      setDeleteState({
        status: "error",
        message:
          "The dividend record could not be removed. Check your connection and retry.",
      });
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="income-dialog"
      aria-labelledby="record-dividend-title"
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
      <p className="eyebrow" id="record-dividend-title">
        {initialDividendEventId
          ? "Edit this dividend"
          : "Record dividend received"}
      </p>
      <form className="manual-ledger-form" onSubmit={submit}>
        <fieldset>
          <div className="manual-ledger-grid">
            <label>
              Security
              <select
                value={portfolioSecurityId}
                disabled={initialPortfolioSecurityId !== null}
                onChange={(event) => setPortfolioSecurityId(event.target.value)}
                required
              >
                {securities.map((security) => (
                  <option
                    key={security.portfolioSecurityId}
                    value={security.portfolioSecurityId}
                  >
                    {security.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Payment date
              <input
                type="date"
                value={paymentDate}
                max={maxDate}
                disabled={isEventLinked}
                onChange={(event) => setPaymentDate(event.target.value)}
                required
              />
            </label>
            {isEventLinked ? (
              // F2 (UI-006B review fix): an event-linked override's payment
              // date is not a persisted field on `dividend_event_overrides`
              // -- it always follows the linked provider event -- so the
              // field is disabled and annotated rather than silently
              // accepting an edit that never saves.
              <p className="dividend-form-note">
                Payment date follows the linked dividend event and is not
                changed here.
              </p>
            ) : null}
            <label>
              Shares held at that date
              <input
                type="text"
                inputMode="decimal"
                value={shares}
                onChange={(event) => {
                  setSharesTouched(true);
                  setShares(event.target.value);
                }}
                required
              />
            </label>
            <label>
              Dividend per share
              <input
                type="text"
                inputMode="decimal"
                value={dividendPerShare}
                onChange={(event) => setDividendPerShare(event.target.value)}
                required
              />
            </label>
            <label>
              Franking credit per share
              <input
                type="text"
                inputMode="decimal"
                placeholder="blank = unknown"
                value={frankingPerShare}
                onChange={(event) => setFrankingPerShare(event.target.value)}
              />
            </label>
            {isEventLinked ? (
              <label className="dividend-exclude-label">
                <input
                  type="checkbox"
                  checked={excludeChecked}
                  onChange={(event) => setExcludeChecked(event.target.checked)}
                />
                Exclude this dividend
              </label>
            ) : null}
          </div>
          <dl className="income-metric-list dividend-live-totals">
            <div className="income-metric-row">
              <dt>Cash</dt>
              <dd>
                {cashTotal !== null
                  ? formatIncomeMoney(currencyCode, cashTotal)
                  : "—"}
              </dd>
            </div>
            <div className="income-metric-row">
              <dt>Franking credits</dt>
              <dd>
                {frankingTotal !== null
                  ? formatIncomeMoney(currencyCode, frankingTotal)
                  : "Unknown"}
              </dd>
            </div>
            <div className="income-metric-row">
              <dt>Gross</dt>
              <dd>
                {grossTotal !== null
                  ? formatIncomeMoney(currencyCode, grossTotal)
                  : "—"}
              </dd>
            </div>
          </dl>
          <div className="manual-ledger-wide">
            <button type="submit" disabled={submitState.status === "saving"}>
              {submitState.status === "saving" ? "Saving…" : "Save dividend"}
            </button>
            {/* B3: "Exclude this dividend" for a non-event-linked OWNER-TYPED
                row being edited -- this tier has no exclude flag of its own
                (the row's own existence is what created it), so exclusion
                is a delete, only offered once a manual record actually
                exists to delete (i.e. this dialog is editing one, not
                creating a fresh one). */}
            {!isEventLinked && savedManualRecordId !== null ? (
              <button
                type="button"
                onClick={deleteRecord}
                disabled={deleteState.status === "deleting"}
              >
                {deleteState.status === "deleting"
                  ? "Removing…"
                  : "Exclude this dividend"}
              </button>
            ) : null}
            {submitState.status === "error" ? (
              <p role="alert" className="unavailable">
                {submitState.message}
              </p>
            ) : null}
            {submitState.status === "saved" ? (
              <>
                <p>Saved.</p>
                {submitState.proximityWarning ? (
                  <p role="status" className="unavailable">
                    {submitState.proximityWarning}
                  </p>
                ) : null}
              </>
            ) : null}
            {deleteState.status === "error" ? (
              <p role="alert" className="unavailable">
                {deleteState.message}
              </p>
            ) : null}
            {deleteState.status === "deleted" ? <p>Removed.</p> : null}
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Past-FY override dialog (gross + franking; cash derived at read time).
// ---------------------------------------------------------------------------

function OverrideFyDialog({
  dialogRef,
  portfolioId,
  existingOverrides,
  initialYear,
  onClose,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  portfolioId: string;
  existingOverrides: DividendAssumptionsFyOverrideProps[];
  initialYear: number | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const existing = initialYear
    ? (existingOverrides.find(
        (row) => row.financialYearEndingYear === initialYear,
      ) ?? null)
    : null;
  const [year, setYear] = useState(String(initialYear ?? ""));
  const [grossed, setGrossed] = useState(existing?.grossedAmountDecimal ?? "");
  const [franking, setFranking] = useState(
    existing?.frankingAmountDecimal ?? "",
  );
  // F1: tracks the persisted version so a second submit in this same dialog
  // session UPDATES the row it just created instead of re-attempting a
  // create (which the natural-key `NOT EXISTS` guard would simply reject).
  const [savedVersion, setSavedVersion] = useState(existing?.version ?? null);
  const [submitState, setSubmitState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | { status: "error"; message: string }
    | { status: "saved" }
  >({ status: "idle" });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const financialYearEndingYear = Number(year);
    setSubmitState({ status: "saving" });
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/dividend-fy-overrides`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            financialYearEndingYear,
            grossedAmountDecimal: grossed,
            frankingAmountDecimal: blankToNull(franking),
            expectedVersion: savedVersion,
          }),
        },
      );
      const result = (await response.json()) as
        { ok: true; version: number } | { ok: false; message: string };
      if (!result.ok) {
        setSubmitState({ status: "error", message: result.message });
        return;
      }
      setSavedVersion(result.version); // F1: switch to update mode
      setSubmitState({ status: "saved" });
      router.refresh(); // F4
    } catch {
      setSubmitState({
        status: "error",
        message:
          "The override could not be saved. Check your connection and retry.",
      });
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="income-dialog"
      aria-labelledby="override-fy-title"
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
      <p className="eyebrow" id="override-fy-title">
        Override a past financial year
      </p>
      <p>
        This overrides receipts and provider history for this FY&apos;s display
        -- it replaces the whole year&apos;s total.
      </p>
      <form className="manual-ledger-form" onSubmit={submit}>
        <fieldset>
          <div className="manual-ledger-grid">
            <label>
              Financial year ending (calendar year)
              <input
                type="number"
                value={year}
                onChange={(event) => setYear(event.target.value)}
                required
              />
            </label>
            <label>
              Total gross dividends
              <input
                type="text"
                inputMode="decimal"
                value={grossed}
                onChange={(event) => setGrossed(event.target.value)}
                required
              />
            </label>
            <label>
              Of which, franking credits
              <input
                type="text"
                inputMode="decimal"
                placeholder="blank = unknown"
                value={franking}
                onChange={(event) => setFranking(event.target.value)}
              />
            </label>
          </div>
          <div className="manual-ledger-wide">
            <button type="submit" disabled={submitState.status === "saving"}>
              {submitState.status === "saving" ? "Saving…" : "Save override"}
            </button>
            {submitState.status === "error" ? (
              <p role="alert" className="unavailable">
                {submitState.message}
              </p>
            ) : null}
            {submitState.status === "saved" ? <p>Saved.</p> : null}
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}
