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
import { useRouter } from "next/navigation";
import { IncomeNav } from "./income-nav";
import { useEffect, useRef, useState } from "react";
import {
  addDecimal,
  formatDecimalFixed,
  multiplyDecimal,
  parseDecimal,
} from "../../domain/calculations/decimal.ts";
import type { DerivedDividendRow } from "../../domain/dividends/index.ts";
import { formatFxRate, formatShares } from "../dividend-history-prefill.ts";
import { formatIncomeMoney, formatIncomePercent } from "../income-format.ts";

// UI-010: local aliases for the two dominated-evidence shapes carried on a
// derived row (see `domain/dividends/history.ts`'s `DominatedReceipt`/
// `DominatedImported`) -- extracted structurally via `DerivedDividendRow`
// rather than importing the types by name so this client-reachable form
// module keeps depending only on the row shape it already needs.
type DominatedReceiptFact = NonNullable<DerivedDividendRow["dominatedReceipt"]>;
type DominatedImportedFact = NonNullable<
  DerivedDividendRow["dominatedImported"]
>;

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

// UI-008 review (carried from portfolio-shell.tsx's dialogs): both dialogs
// below disable their submit button while a save is pending, so a fetch that
// never settles would leave the owner stuck with no way to retry. Their
// submit paths race the fetch against this bounded timeout via
// AbortController so pending state always resolves and the dialog stays
// open and operable.
const DIALOG_FETCH_TIMEOUT_MS = 15_000;
// UI-009: every dialog this message can fire from is a mutation submit, so
// "try again" would invite a retry the client can't know is safe -- a
// slow-but-successful save followed by a retry could double the effect.
// The manual dividend CREATE below additionally carries a server-side
// idempotency-key guard (idempotencyKey, generated once per dialog open)
// so a retry-after-timeout on THAT specific path is actually safe; this
// message stays honestly uncertain regardless, since the other two submits
// here (delete, FY override) are version-guarded, not idempotency-keyed.
const DIALOG_TIMEOUT_MESSAGE =
  "The request timed out. It may still have gone through — check before retrying.";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

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
  baseCurrencyCode,
  today,
  securities,
  portfolio,
  fyOverrides,
  initialOverrideYear,
}: {
  portfolioId: string;
  /** UI-026: the active portfolio's own base currency -- money renders as a
   * bare symbol when its own currency matches this, flagged otherwise. */
  baseCurrencyCode: string;
  today: string;
  securities: DividendAssumptionsSecurityRowProps[];
  portfolio: DividendAssumptionsPortfolioRowProps;
  fyOverrides: DividendAssumptionsFyOverrideProps[];
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
      {/* UI-042: the Assumptions page is a peer Income sub-tab (UI-039 added
          it to the nav), so it renders the SAME five-tab bar and back
          control as every other Income view instead of its own heading and
          return-to-Income text link -- the "Next 12 months" tab is that
          link now. */}
      <IncomeNav portfolioId={portfolioId} active="assumptions" />
      <h1>Dividend assumptions</h1>

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
          baseCurrencyCode={baseCurrencyCode}
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
  baseCurrencyCode,
  maxDate,
  onClose,
  initialPortfolioSecurityId = null,
  initialPaymentDate = null,
  initialDividendEventId = null,
  initialManualRecordId = null,
  initialSharesDecimal = null,
  initialDividendPerShareDecimal = null,
  initialFrankingCreditPerShareDecimal = null,
  initialAmountMode = "per_share",
  initialTotalCashDecimal = null,
  initialTotalFrankingDecimal = null,
  initialExpectedVersion = null,
  initialExclude = false,
  dominatedReceipt = null,
  dominatedImported = null,
  additionalReceiptsCount = 0,
  additionalImportedCount = 0,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  portfolioId: string;
  securities: {
    portfolioSecurityId: string;
    symbol: string;
    currencyCode: string;
  }[];
  /** UI-026: the active portfolio's own base currency -- money renders as a
   * bare symbol when its own currency matches this, flagged otherwise. */
  baseCurrencyCode: string;
  maxDate: string;
  onClose: () => void;
  initialPortfolioSecurityId?: string | null;
  initialPaymentDate?: string | null;
  initialDividendEventId?: string | null;
  initialManualRecordId?: string | null;
  initialSharesDecimal?: string | null;
  initialDividendPerShareDecimal?: string | null;
  initialFrankingCreditPerShareDecimal?: string | null;
  /** DIV-016 part A: "totals" only for a standalone (non-event-linked)
   * manual/imported row already recorded in the BRK-005 totals shape --
   * see `app/dividend-history-prefill.ts`'s `DialogPrefill` doc comment.
   * An event-linked override never offers this mode (`dividend_event_
   * overrides` has no totals shape). */
  initialAmountMode?: "per_share" | "totals";
  initialTotalCashDecimal?: string | null;
  initialTotalFrankingDecimal?: string | null;
  initialExpectedVersion?: number | null;
  initialExclude?: boolean;
  /** UI-010: the row's dominated evidence (see the type alias comment above)
   * -- omitted (defaulting to null/0) by every caller except UI-006C's
   * per-security tab, which always supplies whatever the opened row itself
   * carries (frequently empty). Rendered read-only; never part of the save
   * payload -- this dialog cannot edit superseded evidence, only the row
   * that consumed it. */
  dominatedReceipt?: DominatedReceiptFact | null;
  dominatedImported?: DominatedImportedFact | null;
  additionalReceiptsCount?: number;
  additionalImportedCount?: number;
}) {
  const router = useRouter();
  // Event-linked (overriding an auto/provider row) vs a plain owner-typed
  // manual record -- fixed for the dialog's lifetime by which entry point
  // opened it (UI-006C's history-row entry always supplies
  // `initialDividendEventId` for the former).
  const isEventLinked = initialDividendEventId !== null;
  // UI-014 follow-up: the same compact conversion-provenance disclosure the
  // dividends tab's Cash cell renders (`app/components/security-dividends-
  // tab.tsx`) -- only when BOTH plumbed fields are populated (a converted
  // foreign payout; `toDominatedImported` never sets one without the
  // other), never a back-derived original amount. `?? null` on each field
  // individually (rather than `dominatedImported.currencyCode !== null`
  // directly) guards a defensively-possible absent key the same way
  // `toDominatedImported` itself already does, and lets TypeScript narrow
  // these LOCAL consts (a property-access expression can't be narrowed the
  // same way).
  const dominatedImportedOriginalCurrencyCode =
    dominatedImported?.currencyCode ?? null;
  const dominatedImportedFxRate =
    dominatedImported?.fxRateToPortfolioDecimal ?? null;
  const dominatedImportedFxProvenance =
    dominatedImportedOriginalCurrencyCode !== null &&
    dominatedImportedFxRate !== null
      ? `${dominatedImportedOriginalCurrencyCode} @ ${formatFxRate(dominatedImportedFxRate)}${
          dominatedImported?.fxRateSource
            ? ` (${dominatedImported.fxRateSource})`
            : ""
        }`
      : null;
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
  // DIV-016 part A: the amount-mode toggle -- only ever offered for a
  // non-event-linked save (`dividend_event_overrides` has no totals shape,
  // see `initialAmountMode`'s doc comment). Fixed at "per_share" for an
  // event-linked dialog regardless of the prop, defensively.
  const [amountMode, setAmountMode] = useState<"per_share" | "totals">(
    isEventLinked ? "per_share" : initialAmountMode,
  );
  const [totalCash, setTotalCash] = useState(initialTotalCashDecimal ?? "");
  const [totalFranking, setTotalFranking] = useState(
    initialTotalFrankingDecimal ?? "",
  );
  // B3: "Exclude this dividend" for an event-linked row is a checkbox on
  // this same save (routes to `dividend_event_overrides.exclude`, which
  // keeps the row retrievable/excluded rather than deleting anything).
  const [excludeChecked, setExcludeChecked] = useState(initialExclude);
  // UI-009: a client-generated idempotency key for the standalone manual
  // dividend CREATE path, generated ONCE per dialog mount (this component
  // is conditionally rendered -- `{recordDialogOpen ? <RecordDividendDialog
  // .../> : null}` in both callers -- so a fresh open always gets a fresh
  // key, while every retry within THIS open reuses the same one). Sent on
  // every submit; the server only consumes it for the manual-record CREATE
  // branch (dividend-assumptions-actions.ts) so a slow-but-successful save
  // followed by a timeout-triggered retry dedupes into the SAME record
  // instead of creating a second one.
  const [dialogIdempotencyKey] = useState(() => crypto.randomUUID());
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
    | {
        status: "saved";
        proximityWarning: string | null;
        // UI-009 finishing item 1: set only when this save was an
        // idempotency-key retry that matched an EXISTING manual record.
        // `storedDiffers` true means the payload just submitted was NOT
        // what got persisted -- the form has already been resynced to the
        // actually-stored values below, and this must render as a distinct
        // message from a plain "Saved." (silently claiming the just-typed
        // values were saved would misrepresent what's on record).
        deduped?: boolean;
        storedDiffers?: boolean;
      }
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

  // DIV-016 part A: in "totals" mode the owner types the totals directly --
  // no shares/per-share multiplication, mirroring how a Sharesight totals
  // payout is stored/derived (`domain/dividends/history.ts`'s
  // `computeCashGrossOrTotals`, totals-mode branch: the cash/franking
  // totals ARE the raw inputs, never a derived product).
  const cashTotal =
    amountMode === "totals"
      ? totalCash.trim()
        ? safeCents(() => formatDecimalFixed(parseDecimal(totalCash), 2))
        : null
      : safeCents(() =>
          formatDecimalFixed(
            multiplyDecimal(
              parseDecimal(shares || "0"),
              parseDecimal(dividendPerShare || "0"),
            ),
            2,
          ),
        );
  const frankingTotal =
    amountMode === "totals"
      ? totalFranking.trim()
        ? safeCents(() => formatDecimalFixed(parseDecimal(totalFranking), 2))
        : null
      : frankingPerShare.trim()
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
    // UI-008: "Save dividend" is disabled while saving -- bound the fetch so
    // a stalled request can't leave the owner stuck with no way to retry.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/dividend-entries`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            portfolioSecurityId,
            paymentDate,
            // DIV-016 part A: a non-event-linked save is EITHER mode --
            // `amountMode` tells the server which of the two field groups
            // below to validate/persist; the other group is sent as its
            // "not applicable" value (blank shares/DPS/franking in totals
            // mode, blank totals in per-share mode) but is never read
            // server-side for the mode that isn't selected.
            sharesDecimal: amountMode === "totals" ? null : shares,
            dividendPerShareDecimal:
              amountMode === "totals" ? null : dividendPerShare,
            frankingCreditPerShareDecimal:
              amountMode === "totals" ? null : blankToNull(frankingPerShare),
            totalCashDecimal: amountMode === "totals" ? totalCash : null,
            totalFrankingDecimal:
              amountMode === "totals" ? blankToNull(totalFranking) : null,
            amountMode,
            dividendEventId: initialDividendEventId,
            manualRecordId: isEventLinked ? null : savedManualRecordId,
            expectedVersion: savedVersion,
            exclude: excludeChecked,
            idempotencyKey: dialogIdempotencyKey,
          }),
          signal: controller.signal,
        },
      );
      const result = (await response.json()) as
        | {
            ok: true;
            target: "manual_record" | "event_override";
            id: string;
            version: number;
            proximityWarning: string | null;
            deduped?: boolean;
            storedDiffers?: boolean;
            storedRecord?: {
              paymentDate: string;
              sharesDecimal: string | null;
              dividendPerShareDecimal: string | null;
              frankingCreditPerShareDecimal: string | null;
              totalCashDecimal: string | null;
              totalFrankingDecimal: string | null;
            };
          }
        | { ok: false; message: string };
      if (!result.ok) {
        setSubmitState({ status: "error", message: result.message });
        return;
      }
      // F1: switch to update mode for any further submit in this dialog.
      // DIV-016 part A: on a correction (supersede), `result.id` is the NEW
      // (superseding) row's id, never the original -- a further submit in
      // this same dialog session correctly targets that new row next.
      setSavedVersion(result.version);
      if (result.target === "manual_record") {
        setSavedManualRecordId(result.id);
      }
      // UI-009 finishing item 1: an idempotency-key retry that matched an
      // existing record whose stored fields differ from what was just
      // submitted (e.g. the owner edited the form, the first save actually
      // committed, then a client-visible timeout triggered a resubmit with
      // the NEW values) -- resync the form to the ACTUALLY-STORED values
      // rather than leaving the just-typed ones displayed as if they saved.
      // DIV-016 part A: `storedRecord` reflects whichever mode actually won
      // -- resync `amountMode` along with the fields so the form's shown
      // inputs match the stored shape.
      if (result.storedDiffers && result.storedRecord) {
        setPaymentDate(result.storedRecord.paymentDate);
        if (result.storedRecord.totalCashDecimal !== null) {
          setAmountMode("totals");
          setTotalCash(result.storedRecord.totalCashDecimal);
          setTotalFranking(result.storedRecord.totalFrankingDecimal ?? "");
        } else {
          setAmountMode("per_share");
          setShares(result.storedRecord.sharesDecimal ?? "");
          setSharesTouched(true);
          setDividendPerShare(
            result.storedRecord.dividendPerShareDecimal ?? "",
          );
          setFrankingPerShare(
            result.storedRecord.frankingCreditPerShareDecimal ?? "",
          );
        }
      }
      setSubmitState({
        status: "saved",
        proximityWarning: result.proximityWarning,
        deduped: result.deduped,
        storedDiffers: result.storedDiffers,
      });
      router.refresh(); // F4
    } catch (error) {
      setSubmitState({
        status: "error",
        message: isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : "The dividend could not be saved. Check your connection and retry.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function deleteRecord() {
    if (savedManualRecordId === null || savedVersion === null) return;
    setDeleteState({ status: "deleting" });
    // UI-008: "Exclude this dividend" is disabled while deleting -- bound
    // the fetch so a stalled request can't leave the owner stuck.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
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
          signal: controller.signal,
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
    } catch (error) {
      setDeleteState({
        status: "error",
        message: isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : "The dividend record could not be removed. Check your connection and retry.",
      });
    } finally {
      clearTimeout(timeout);
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
      {dominatedReceipt ||
      dominatedImported ||
      additionalReceiptsCount > 0 ||
      additionalImportedCount > 0 ? (
        // UI-010: honest provenance for evidence this row consumed (never
        // shown as its own row) -- clearly labelled as superseded and not
        // part of this dialog's editable/saved fields.
        <div className="dividend-dominated-evidence">
          <p className="dividend-form-note">
            Superseded by this row -- not counted separately in totals:
          </p>
          <ul>
            {dominatedReceipt ? (
              <li>
                Receipt:{" "}
                {formatIncomeMoney(
                  currencyCode,
                  baseCurrencyCode,
                  dominatedReceipt.dividendPerShareDecimal,
                )}
                /share × {formatShares(dominatedReceipt.sharesDecimal)} shares,
                paid {dominatedReceipt.paymentDate}
                {dominatedReceipt.frankingPerShareDecimal !== null
                  ? ` · franking ${formatIncomeMoney(currencyCode, baseCurrencyCode, dominatedReceipt.frankingPerShareDecimal)}/share`
                  : ""}
              </li>
            ) : null}
            {additionalReceiptsCount > 0 ? (
              <li>
                +{additionalReceiptsCount} more receipt
                {additionalReceiptsCount === 1 ? "" : "s"} not shown
                individually
              </li>
            ) : null}
            {dominatedImported ? (
              <li>
                Imported:{" "}
                {dominatedImported.dividendPerShareDecimal !== null
                  ? `${formatIncomeMoney(currencyCode, baseCurrencyCode, dominatedImported.dividendPerShareDecimal)}/share × ${
                      dominatedImported.sharesDecimal !== null
                        ? formatShares(dominatedImported.sharesDecimal)
                        : "Unknown"
                    } shares`
                  : dominatedImported.totalCashDecimal !== null
                    ? `${formatIncomeMoney(currencyCode, baseCurrencyCode, dominatedImported.totalCashDecimal)} total`
                    : "Unknown amount"}
                , paid {dominatedImported.paymentDate}
                {dominatedImported.frankingCreditPerShareDecimal !== null
                  ? ` · franking ${formatIncomeMoney(currencyCode, baseCurrencyCode, dominatedImported.frankingCreditPerShareDecimal)}/share`
                  : ""}
                {dominatedImportedFxProvenance ? (
                  <>
                    <br />
                    <span className="dividend-fx-provenance">
                      converted from {dominatedImportedFxProvenance}
                    </span>
                  </>
                ) : null}
              </li>
            ) : null}
            {additionalImportedCount > 0 ? (
              <li>
                +{additionalImportedCount} more imported not shown individually
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
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
            {!isEventLinked ? (
              // DIV-016 part A: a non-event-linked save is either PER-SHARE
              // or the BRK-005 TOTALS shape -- `dividend_event_overrides`
              // has no totals shape, so this toggle is never offered for an
              // event-linked override.
              <fieldset className="dividend-amount-mode-toggle">
                <legend>Amount entry</legend>
                <label>
                  <input
                    type="radio"
                    name="dividend-amount-mode"
                    value="per_share"
                    checked={amountMode === "per_share"}
                    onChange={() => setAmountMode("per_share")}
                  />
                  Per share
                </label>
                <label>
                  <input
                    type="radio"
                    name="dividend-amount-mode"
                    value="totals"
                    checked={amountMode === "totals"}
                    onChange={() => setAmountMode("totals")}
                  />
                  Total amount
                </label>
              </fieldset>
            ) : null}
            {amountMode === "per_share" ? (
              <>
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
                    onChange={(event) =>
                      setDividendPerShare(event.target.value)
                    }
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
                    onChange={(event) =>
                      setFrankingPerShare(event.target.value)
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Total cash
                  <input
                    type="text"
                    inputMode="decimal"
                    value={totalCash}
                    onChange={(event) => setTotalCash(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Total franking credit
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="blank = unknown"
                    value={totalFranking}
                    onChange={(event) => setTotalFranking(event.target.value)}
                  />
                </label>
              </>
            )}
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
                  ? formatIncomeMoney(currencyCode, baseCurrencyCode, cashTotal)
                  : "—"}
              </dd>
            </div>
            <div className="income-metric-row">
              <dt>Franking credits</dt>
              <dd>
                {frankingTotal !== null
                  ? formatIncomeMoney(
                      currencyCode,
                      baseCurrencyCode,
                      frankingTotal,
                    )
                  : "Unknown"}
              </dd>
            </div>
            <div className="income-metric-row">
              <dt>Gross</dt>
              <dd>
                {grossTotal !== null
                  ? formatIncomeMoney(
                      currencyCode,
                      baseCurrencyCode,
                      grossTotal,
                    )
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
                {submitState.storedDiffers ? (
                  <p role="status">
                    This matched an earlier save — the stored values are shown.
                  </p>
                ) : (
                  <p>Saved.</p>
                )}
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
    // UI-008: "Save override" is disabled while saving -- bound the fetch so
    // a stalled request can't leave the owner stuck.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
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
          signal: controller.signal,
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
    } catch (error) {
      setSubmitState({
        status: "error",
        message: isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : "The override could not be saved. Check your connection and retry.",
      });
    } finally {
      clearTimeout(timeout);
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
