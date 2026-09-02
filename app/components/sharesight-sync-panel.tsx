"use client";

// BRK-005B: import-screen wiring for BRK-005's already-tested backend
// (`app/sharesight-sync-actions.ts` and its three CSRF-first-where-mutating
// routes). Mirrors the established modal dialog pattern (UI-007: ref +
// showModal(), opener-capture focus restore, onCancel guarded while
// pending, in-dialog errors) and its UI-008 shared 15s AbortController
// fetch timeout (`security-dividends-tab.tsx`'s refresh dialog is the
// closest sibling: a confirmation-free single action with its own bounded
// fetch and in-panel result rendering).
//
// Review finding B1 (BLOCKING): this component used to own its OWN `link`
// state, seeded ONCE from an `initialLink` prop -- since the panel remounts
// on every target-portfolio switch (`key={targetPortfolioId}` in
// `ImportReview`), switching away and back re-read the STALE server-
// rendered snapshot, silently discarding a link created earlier in the
// same session. Fixed by making `link` a fully CONTROLLED prop (owned by
// `ImportReview`'s hoisted `sharesightLinkOverrides` state, which persists
// across every switch) with an `onLinked` callback reporting a successful
// link upward instead of setting local state -- see
// `mergeSharesightLinks`'s header note in `sharesight-sync-panel-helpers.ts`
// for the exact merge `ImportReview` performs. Every OTHER piece of this
// panel's state (the list dialog, sync result, pending flags) is still
// correctly reset per portfolio via the same `key` remount -- only the link
// itself needed to survive it.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  formatSyncResultMessage,
  isDisabledIntegrationMessage,
  type SharesightLinkStatus,
  type SharesightSyncSuccess,
  type SharesightSyncWindowSummary,
} from "../sharesight-sync-panel-helpers.ts";

const DIALOG_FETCH_TIMEOUT_MS = 15_000;
// UI-009: the link and sync submits below are safe to retry (linking is an
// idempotent upsert -- `linkExclusive` -- and a re-synced fetch that
// already staged identically just resolves to the same reused batch), but
// the client cannot prove that from a bare timeout, so this reuses the
// established uncertain wording rather than a bespoke "try again".
const DIALOG_TIMEOUT_MESSAGE =
  "The request timed out. It may still have gone through — check before retrying.";
// Review follow-up 3: `loadPortfolios` is a plain GET against Sharesight --
// nothing was submitted, so there is nothing that "may still have gone
// through" to check before retrying. Reusing the mutation-submit wording
// here would invite a needless, confusing check for a read that either
// happened or didn't.
const DIALOG_READ_TIMEOUT_MESSAGE = "The request timed out. Retry when ready.";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

type SharesightPortfolioOption = {
  id: string;
  name: string;
  currencyCode: string;
};

type ListState =
  | { status: "loading" }
  | { status: "loaded"; portfolios: SharesightPortfolioOption[] }
  | { status: "disabled"; message: string }
  | { status: "error"; message: string };

type SyncResult =
  SharesightSyncSuccess | { ok: false; message: string; disabled: boolean };

export function SharesightSyncPanel({
  portfolioId,
  link,
  onLinked,
  onOpenBatch,
}: {
  portfolioId: string;
  link: SharesightLinkStatus;
  onLinked: (portfolioId: string, sharesightPortfolioId: string) => void;
  onOpenBatch: (batchId: string) => void;
}) {
  const router = useRouter();
  const isLinked = link.status === "linked";
  const currentlyLinkedId =
    link.status === "linked" ? link.sharesightPortfolioId : null;

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const [listState, setListState] = useState<ListState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState("");
  const [linkPending, setLinkPending] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [syncPending, setSyncPending] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (linkDialogOpen && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!linkDialogOpen && dialog?.open) dialog.close();
    if (!linkDialogOpen && openerRef.current) {
      openerRef.current.focus();
      openerRef.current = null;
    }
  }, [linkDialogOpen]);

  async function loadPortfolios() {
    setListState({ status: "loading" });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/sharesight-portfolios`,
        { cache: "no-store", signal: controller.signal },
      );
      const result = (await response.json()) as
        | { ok: true; portfolios: SharesightPortfolioOption[] }
        | { ok: false; message: string };
      if (!result.ok) {
        setListState(
          isDisabledIntegrationMessage(result.message)
            ? { status: "disabled", message: result.message }
            : { status: "error", message: result.message },
        );
        return;
      }
      setListState({ status: "loaded", portfolios: result.portfolios });
      // Review follow-up 4: preselect the portfolio ALREADY linked (its id
      // is known from `link`) rather than always defaulting to whichever
      // Sharesight happened to return first -- re-opening the dialog to
      // "change" a link should not silently default away from the current
      // one.
      const preselect =
        currentlyLinkedId &&
        result.portfolios.some((option) => option.id === currentlyLinkedId)
          ? currentlyLinkedId
          : (result.portfolios[0]?.id ?? "");
      setSelectedId(preselect);
    } catch (error) {
      setListState({
        status: "error",
        message: isAbortError(error)
          ? DIALOG_READ_TIMEOUT_MESSAGE
          : "Sharesight portfolios could not be loaded. Check your connection and retry.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function openLinkDialog(event: React.MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    setLinkError(null);
    setLinkDialogOpen(true);
    void loadPortfolios();
  }

  async function submitLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (listState.status !== "loaded" || !selectedId) return;
    setLinkPending(true);
    setLinkError(null);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/sharesight-link`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sharesightPortfolioId: selectedId }),
          signal: controller.signal,
        },
      );
      const result = (await response.json()) as
        | { ok: true; sharesightPortfolioId: string; version: number }
        | { ok: false; message: string };
      if (!result.ok) throw new Error(result.message);
      // Reports the link UP into `ImportReview`'s hoisted state -- see this
      // file's header note (B1) -- rather than setting any local state,
      // since none exists here anymore. `router.refresh()` additionally
      // re-runs the page's Server Component data load (Round-2 follow-up
      // 2), converging the server-seeded `sharesightLinks` snapshot itself
      // with reality -- the override stays the IMMEDIATE feedback layer
      // (it applies synchronously, before this async refresh resolves) so
      // the owner never sees a flash back to "not linked" while it's
      // in flight.
      onLinked(portfolioId, result.sharesightPortfolioId);
      router.refresh();
      setSyncResult(null);
      dialogRef.current?.close();
    } catch (error) {
      setLinkError(
        isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "This Sharesight portfolio could not be linked.",
      );
    } finally {
      clearTimeout(timeout);
      setLinkPending(false);
    }
  }

  // BRK-015: `mode` selects the query param the sync route reads --
  // `"routine"` (the default button) is the watermark-narrowed sync;
  // `"full"` is the explicit secondary "Full resync" action that preserves
  // today's unconditional inception-to-now fetch (needed to still catch a
  // Sharesight-side correction to an old record a narrowed window would
  // never see).
  async function runSync(mode: "routine" | "full") {
    if (!isLinked) return;
    setSyncPending(true);
    setSyncResult(null);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DIALOG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/sharesight-sync?mode=${mode}`,
        { method: "POST", signal: controller.signal },
      );
      const result = (await response.json()) as
        | {
            ok: true;
            batchId: string;
            batchStatus: string;
            rowsStaged: number;
            skippedPayouts: number;
            reused: boolean;
            window: SharesightSyncWindowSummary;
          }
        | { ok: false; message: string };
      if (!result.ok) {
        setSyncResult({
          ok: false,
          message: result.message,
          disabled: isDisabledIntegrationMessage(result.message),
        });
        return;
      }
      setSyncResult({
        ok: true,
        batchId: result.batchId,
        batchStatus: result.batchStatus,
        rowsStaged: result.rowsStaged,
        skippedPayouts: result.skippedPayouts,
        reused: result.reused,
        window: result.window,
      });
    } catch (error) {
      setSyncResult({
        ok: false,
        message: isAbortError(error)
          ? DIALOG_TIMEOUT_MESSAGE
          : "Sharesight sync could not be started. Check your connection and retry.",
        disabled: false,
      });
    } finally {
      clearTimeout(timeout);
      setSyncPending(false);
    }
  }

  return (
    <section
      className="sharesight-sync-panel"
      aria-labelledby="sharesight-sync-title"
    >
      <p className="eyebrow">Sharesight</p>
      <h2 id="sharesight-sync-title">Sync from Sharesight</h2>
      <p className="sharesight-link-status">
        {link.status === "linked" ? (
          <>
            Linked to Sharesight portfolio{" "}
            <code>{link.sharesightPortfolioId}</code>.
          </>
        ) : link.status === "needs_repair" ? (
          "Link needs repair -- re-link."
        ) : link.status === "unknown" ? (
          "Link status unavailable — reload to retry."
        ) : (
          "Not linked to a Sharesight portfolio."
        )}
      </p>
      <div className="sharesight-sync-actions">
        <button type="button" onClick={openLinkDialog}>
          {isLinked
            ? "Change linked Sharesight portfolio"
            : "Link Sharesight portfolio"}
        </button>
        {isLinked ? (
          <button
            type="button"
            onClick={() => void runSync("routine")}
            disabled={syncPending}
          >
            {syncPending ? "Syncing…" : "Sync from Sharesight"}
          </button>
        ) : null}
        {isLinked ? (
          <button
            type="button"
            onClick={() => void runSync("full")}
            disabled={syncPending}
            title="Checks your ENTIRE Sharesight history, not just recent activity -- slower, but the only way to catch a correction to an old record."
          >
            {syncPending ? "Syncing…" : "Full resync"}
          </button>
        ) : null}
      </div>

      {syncResult ? (
        syncResult.ok ? (
          <p className="sharesight-sync-result" role="status">
            {formatSyncResultMessage(syncResult)}{" "}
            <button
              type="button"
              onClick={() => onOpenBatch(syncResult.batchId)}
            >
              Open in review
            </button>
          </p>
        ) : (
          <p
            className={
              syncResult.disabled
                ? "sharesight-sync-inert"
                : "sharesight-sync-error"
            }
            role={syncResult.disabled ? "status" : "alert"}
          >
            {syncResult.message}
          </p>
        )
      ) : null}

      {linkDialogOpen ? (
        <dialog
          ref={dialogRef}
          className="sharesight-dialog"
          aria-labelledby="sharesight-link-title"
          onCancel={(event) => {
            event.preventDefault();
            if (linkPending) return;
            dialogRef.current?.close();
          }}
          onClose={() => setLinkDialogOpen(false)}
        >
          <button
            type="button"
            className="sheet-close"
            onClick={() => {
              if (linkPending) return;
              dialogRef.current?.close();
            }}
          >
            Close
          </button>
          <p className="eyebrow" id="sharesight-link-title">
            Link Sharesight portfolio
          </p>
          <p>
            Choose a Sharesight portfolio to link to this portfolio. Linking
            replaces any previous link -- only one Sharesight portfolio can be
            linked at a time.
          </p>
          {listState.status === "loading" ? (
            <p role="status">Loading Sharesight portfolios…</p>
          ) : null}
          {listState.status === "disabled" ? (
            <p role="status" className="sharesight-sync-inert">
              {listState.message}
            </p>
          ) : null}
          {listState.status === "error" ? (
            <p role="alert" className="sharesight-sync-error">
              {listState.message}{" "}
              <button type="button" onClick={() => void loadPortfolios()}>
                Retry
              </button>
            </p>
          ) : null}
          {listState.status === "loaded" ? (
            listState.portfolios.length === 0 ? (
              <p>No Sharesight portfolios were found for your account.</p>
            ) : (
              <form onSubmit={submitLink}>
                <fieldset>
                  <legend>Sharesight portfolios</legend>
                  {listState.portfolios.map((option) => (
                    <label
                      key={option.id}
                      className="sharesight-portfolio-option"
                    >
                      <input
                        type="radio"
                        name="sharesightPortfolioId"
                        value={option.id}
                        checked={selectedId === option.id}
                        onChange={() => setSelectedId(option.id)}
                      />
                      {option.name} ({option.currencyCode})
                      {option.id === currentlyLinkedId
                        ? " -- currently linked"
                        : ""}
                    </label>
                  ))}
                </fieldset>
                <div className="dialog-actions">
                  <button
                    type="button"
                    onClick={() => dialogRef.current?.close()}
                    disabled={linkPending}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={linkPending || !selectedId}>
                    {linkPending ? "Linking…" : "Link this portfolio"}
                  </button>
                </div>
              </form>
            )
          ) : null}
          {linkError ? (
            <p role="alert" className="sharesight-sync-error">
              {linkError}
            </p>
          ) : null}
        </dialog>
      ) : null}
    </section>
  );
}
