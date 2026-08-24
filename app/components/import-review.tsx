"use client";

import { useState } from "react";
import { HistoryBackControl } from "./back-control";
import { useEffect, useRef } from "react";
import type { ImportHistoryDetail } from "../import-history-service.ts";
import type { ImportReversalActionResult } from "../import-reversal-service.ts";
import {
  ImportHistoryDetailPanel,
  isMutableExclusionStatus,
  isResumableReviewStatus,
} from "./import-history-detail.tsx";
import { SharesightSyncPanel } from "./sharesight-sync-panel.tsx";
import { HistoricalDataPanel } from "./historical-data-panel.tsx";
import {
  mergeSharesightLinks,
  type SharesightLinkStatus,
} from "../sharesight-sync-panel-helpers.ts";
import {
  acceptLoopProgress,
  committedConfirmationText,
  deriveCommittedStatusLine,
  isCommittedOrReversed as deriveIsCommittedOrReversed,
  runAcceptCommitLoop,
  scopeCommitToBatch,
} from "../import-review-commit-state.ts";
import type { RowSummary } from "../../domain/imports/row-summary.ts";

type PortfolioOption = { id: string; name: string; homeCurrencyCode: string };
// BRK-009C: distinct securities the "Review securities" table renders, one
// per distinct security a `sharesight_sync` batch's rows reference. See
// `domain/imports/security-summary.ts`'s `SharesightSecuritySummaryEntry`
// (the server-side source of truth this type mirrors) for why "conflict"
// and "unresolved" are both genuine, distinct, non-fabricated states.
type SecuritySummaryEntry = {
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
  name: string | null;
  securityId: string | null;
  rowCount: number;
  state: "resolved" | "created" | "conflict" | "unresolved";
  // BRK-009C review round (finding B1): whether THIS user's name-edit
  // request would actually be accepted right now -- `state === "created"`
  // AND sole-linked to this user AND no active verified provider mapping.
  // Optional/defaulted to false so a pre-review-round test fixture keeps
  // compiling; the server's own guarded `UPDATE ... WHERE` re-enforces the
  // identical predicates regardless of what this flag says.
  nameEditable?: boolean;
  // UI-015: extra payout currencies actually present among rows folded into
  // this line (BRK-010's dividend-currency-agnostic merge -- see
  // `domain/imports/security-summary.ts`'s field of the same name).
  // Optional/defaulted to `[]` for the same pre-existing-test-fixture reason
  // as `nameEditable` above.
  additionalPayoutCurrencyCodes?: string[];
  // UI-015 review round F4: true for a solo line composed entirely of
  // totals-mode dividend rows (the payout-only steady state -- no primary
  // sibling in this batch to merge into). Optional/defaulted to false for
  // the same pre-existing-test-fixture reason as `nameEditable` above.
  dividendOnly?: boolean;
};
type Review = {
  batch: {
    id: string;
    filename: string;
    status: string;
    version: number;
    targetPortfolioId: string | null;
    // BRK-009C: gates the "Review securities" section -- present on every
    // review the server issues, but optional here so any pre-BRK-009C
    // test-constructed `Review` literal keeps compiling; treated as a
    // non-Sharesight (CSV) batch when absent.
    parserFormat?: string;
  };
  previewVersion: string;
  preview: {
    ready: boolean;
    counts: {
      transactionCreates: number;
      dividendCreates: number;
      candidateCreates: number;
      skips: number;
      unresolved: number;
    };
    projectedQuantities: Record<string, string>;
    unresolvedCandidates: Array<{
      id: string;
      portfolioId: string;
      sourceSymbol: string;
      sourceExchangeAlias: string | null;
      sourceCurrencyCode: string;
      securityId: string | null;
    }>;
    issues: Array<{
      code: string;
      severity: string;
      rowId?: string;
      physicalRowNumber?: number;
      sourceKey?: string;
      message: string;
    }>;
  };
  securityCandidates: Array<{
    id: string;
    portfolioId: string;
    sourceSymbol: string;
    sourceExchangeAlias: string | null;
    sourceCurrencyCode: string;
    securityId: string | null;
  }>;
  issues: Array<{
    id: string;
    rowId: string | null;
    physicalRowNumber: number | null;
    severity: "error" | "warning" | "info";
    code: string;
    message: string;
    resolvedAt: string | null;
  }>;
  excludedRows: Array<{
    id: string;
    physicalRowNumber: number;
    symbol: string | null;
  }>;
  // IMP-009: resolved-candidate `securities.id` values that are
  // owner-attested and not yet provider-verified -- drives the "Owner-attested
  // identity; market data unavailable until provider-verified" label.
  // Optional/defaulted here so any test-constructed `Review` literal that
  // predates IMP-009 keeps compiling and rendering unchanged.
  attestedSecurityIds?: string[];
  // BRK-009C: `[]` for a CSV batch; optional/defaulted for the same
  // pre-existing-test-fixture reason as `attestedSecurityIds` above.
  securities?: SecuritySummaryEntry[];
  // UI-013 review round B1: real commit-machinery row counts (never
  // reconciliation intent) -- see `app/import-preview.ts`'s field of the
  // same name and `deriveCommittedStatusLine`'s doc comment. Optional/
  // defaulted (all zero) for the same pre-existing-test-fixture reason as
  // `attestedSecurityIds` above.
  commitProgress?: {
    committedRows: number;
    skippedRows: number;
    excludedByOwnerRows: number;
    remainingRows: number;
  };
  // UI-014 part 3: business-basics facts for rows an issue references (see
  // `app/import-preview.ts`'s field of the same name). Optional/defaulted
  // to `{}` for the same pre-existing-test-fixture reason as
  // `attestedSecurityIds` above -- a fixture that omits it simply renders no
  // inline row facts, never a crash.
  rowSummaries?: Record<string, RowSummary>;
};

const EMPTY_COMMIT_PROGRESS = {
  committedRows: 0,
  skippedRows: 0,
  excludedByOwnerRows: 0,
  remainingRows: 0,
};

// IMP-008: the row(s) an exclude/include confirm dialog is currently open
// for -- mirrors `SharesightSyncPanel`'s dialog-state pattern (a single
// `useState` describing what the dialog is FOR, opened imperatively via
// `showModal()`).
type ExclusionTarget =
  | {
      kind: "securityCandidate";
      portfolioId: string;
      sourceSymbol: string;
      sourceExchangeAlias: string | null;
      sourceCurrencyCode: string;
    }
  | { kind: "issue"; issueId: string }
  | { kind: "rowIds"; rowIds: string[] };

type PendingExclusion = {
  action: "exclude" | "include";
  target: ExclusionTarget;
  description: string;
};

// IMP-009: the unresolved security candidate a "Resolve manually" confirm
// dialog is currently open for, plus the owner-editable display name field
// (default: the symbol) the dialog collects.
type PendingAttestation = {
  candidate: {
    portfolioId: string;
    sourceSymbol: string;
    sourceExchangeAlias: string | null;
    sourceCurrencyCode: string;
  };
  displayName: string;
};

type PendingMapping = {
  key: string;
  kind: "portfolio" | "security" | "fx";
  sourceKey: string;
  message: string;
};

type HistoryBatch = {
  id: string;
  filename: string;
  status: string;
  version: number;
  targetPortfolioId: string | null;
  totalRows: number;
  transactionRows: number;
  errorCount: number;
  warningCount: number;
  createdAt: string;
  updatedAt: string;
  parsedAt: string | null;
  committedAt: string | null;
  reversedAt: string | null;
  supersedesBatchId: string | null;
};

type CommitResult = {
  batchId: string;
  status: "committing" | "committed";
  resumed: boolean;
  idempotent: boolean;
  highWaterRow: number;
  committedRows: number;
  skippedRows: number;
  excludedByOwnerRows: number;
  // UI-013 review round B1: still-`staged` rows -- the real denominator for
  // "N of M rows" accept progress (see `acceptLoopProgress`).
  remainingRows: number;
  rebuildJobId: string | null;
};

function businessDate(value: string): string {
  return value.slice(0, 10);
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

// UI-014 part 1 (owner-reported): the Review securities table used to
// render an editable name input + Save for EVERY name-editable row, even
// one Sharesight already supplied a real name for -- implying the owner
// must act on every row, when only a still-placeholder name genuinely
// needs one. `nameEditable` alone (gated below, unchanged) says WHETHER an
// edit is allowed; this says whether one is actually NEEDED. A
// `state === "created"` security's placeholder name is always exactly
// "Unnamed security" (BRK-009B's `sanitizeCanonicalName` fallback --
// `canonical_name` is `NOT NULL`, so it is never blank/null in practice);
// "Unknown"/blank/null are also treated as missing defensively, matching
// this table's own pre-existing "Unknown" display fallback for a
// non-editable entry with no instrument name.
function isSecurityNameMissing(name: string | null): boolean {
  if (name === null) return true;
  const trimmed = name.trim();
  return (
    trimmed.length === 0 ||
    trimmed === "Unknown" ||
    trimmed === "Unnamed security"
  );
}

// UI-014 follow-up: the same identity tuple the securities table keys its
// `<tr>` on (below) and `submitSecurityMetadata` arms its post-save focus
// target with -- one definition so the two never drift apart.
function securityRowKey(entry: {
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
}): string {
  return `${entry.sourceSymbol}|${entry.sourceExchangeAlias ?? ""}|${entry.sourceCurrencyCode}`;
}

// UI-015: the identical key shape reconciliation.ts's own `securityKey()`
// builds server-side (portfolioId RAW, symbol/exchange/currency normalized)
// -- lets the securities table recognize which pending "security" mapping,
// if any, actually names THIS entry's group, so the "Awaiting resolution"
// affordance only ever claims an affordance that genuinely exists above.
function pendingSecurityMappingKeyFor(
  portfolioId: string,
  entry: {
    sourceSymbol: string;
    sourceExchangeAlias: string | null;
    sourceCurrencyCode: string;
  },
): string {
  return [
    portfolioId,
    normalizedKeyPart(entry.sourceSymbol),
    normalizedKeyPart(entry.sourceExchangeAlias ?? ""),
    normalizedKeyPart(entry.sourceCurrencyCode),
  ].join("|");
}

// UI-014 part 3: renders one row's business-basics facts (symbol/type/
// date/quantity/amount/currency, "Not recorded" fallbacks already baked in
// by `summarizeRow`) as a compact, text-only inline disclosure -- reused by
// both the "Row and field issues" and "Blocked rows" sections below so the
// owner can see what a row-linked issue is actually ABOUT without hunting
// through import history (owner-reported gap, UI-014 part 3).
function rowFactsText(summary: RowSummary): string {
  return `Symbol ${summary.symbol} · Type ${summary.type} · Date ${summary.date} · Quantity ${summary.quantity} · Amount ${summary.amount} · Currency ${summary.currency}`;
}

// IMP-008 review finding B2-residual: nothing ever marks a persisted issue
// resolved just because the OWNER excluded its row (excluding is a
// separate mechanism from resolving the issue -- see
// `app/import-row-exclusion-service.ts`), so a row's unresolved issue would
// otherwise sit in "Blocked rows" forever, including after commit, still
// asserting "blocked" about a row that is no longer blocked (already
// excluded, and shown accurately in "Excluded rows" instead) or blocking
// (batch may be committed). True only for an issue that is STILL genuinely
// blocking: unresolved, error-severity, and not already excluded.
function isRowStillBlocking(
  issue: { severity: string; resolvedAt: string | null; rowId: string | null },
  excludedRowIds: ReadonlySet<string>,
): boolean {
  return (
    issue.severity === "error" &&
    issue.resolvedAt === null &&
    (issue.rowId === null || !excludedRowIds.has(issue.rowId))
  );
}

// Mirrors `normalized()` in domain/imports/reconciliation.ts so the client
// can recognize which `preview.unresolvedCandidates` entry a pending
// "security" mapping's `sourceKey` (built the same way, server-side, by
// `securityKey()`) refers to, without the server needing to expose a
// separate id for it.
function normalizedKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function isStalePreviewMessage(value: string): boolean {
  return value.toLowerCase().includes("stale");
}

function isImportReversalResult(
  value: unknown,
): value is ImportReversalActionResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true) {
    if (typeof candidate.reversal !== "object" || candidate.reversal === null)
      return false;
    const reversal = candidate.reversal as Record<string, unknown>;
    return reversal.status === "reversing" || reversal.status === "reversed";
  }
  return candidate.ok === false && typeof candidate.message === "string";
}

export function ImportReview({
  portfolios,
  sharesightLinks = {},
}: {
  portfolios: PortfolioOption[];
  sharesightLinks?: Record<string, SharesightLinkStatus>;
}) {
  const [targetPortfolioId, setTargetPortfolioId] = useState(
    portfolios[0]?.id ?? "",
  );
  // Review finding B1 (BLOCKING): hoisted here, NOT inside
  // `SharesightSyncPanel` -- the panel remounts (via `key={targetPortfolioId}`
  // below) every time the owner switches the target portfolio, so any link
  // state living only inside it is lost on switch-away-and-back. This map
  // persists for the page's whole lifetime and is merged over the
  // server-seeded `sharesightLinks` snapshot on every render (see
  // `mergeSharesightLinks`'s header note for the exact guarantee this
  // pins). Only entries for portfolios actually linked/re-linked in this
  // session are ever written here; every other portfolio keeps reading its
  // server-seeded status untouched.
  const [sharesightLinkOverrides, setSharesightLinkOverrides] = useState<
    Record<string, SharesightLinkStatus>
  >({});
  const [review, setReview] = useState<Review | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [readyPending, setReadyPending] = useState(false);
  const [commitPending, setCommitPending] = useState(false);
  const [commit, setCommit] = useState<CommitResult | null>(null);
  const [commitConfirmed, setCommitConfirmed] = useState(false);
  const [commitKey, setCommitKey] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryBatch[]>([]);
  const [historyDetail, setHistoryDetail] =
    useState<ImportHistoryDetail | null>(null);
  const [historyPending, setHistoryPending] = useState(false);
  const [reversalPending, setReversalPending] = useState(false);
  const [reversal, setReversal] = useState<ImportReversalActionResult | null>(
    null,
  );
  const [reversalKey, setReversalKey] = useState<string | null>(null);
  const [successorPending, setSuccessorPending] = useState(false);
  // IMP-008: skip/un-skip confirm dialog -- mirrors `SharesightSyncPanel`'s
  // ref + `showModal()`/opener-focus-restore pattern.
  const [pendingExclusion, setPendingExclusion] =
    useState<PendingExclusion | null>(null);
  const exclusionDialogRef = useRef<HTMLDialogElement>(null);
  const exclusionOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [exclusionPending, setExclusionPending] = useState(false);
  const [exclusionError, setExclusionError] = useState<string | null>(null);
  // IMP-009: "Resolve manually" confirm dialog -- mirrors the exclusion
  // dialog's ref + `showModal()`/opener-focus-restore pattern above.
  const [pendingAttestation, setPendingAttestation] =
    useState<PendingAttestation | null>(null);
  const attestationDialogRef = useRef<HTMLDialogElement>(null);
  const attestationOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [attestationPending, setAttestationPending] = useState(false);
  const [attestationError, setAttestationError] = useState<string | null>(null);
  // BRK-009C: "Accept Import" confirm dialog for a `sharesight_sync`
  // batch's "Review securities" section -- ONE dialog shared by both the
  // top and bottom accept buttons, mirroring the exclusion/attestation
  // dialogs' identical ref + `showModal()`/opener-focus-restore pattern.
  const [acceptDialogOpen, setAcceptDialogOpen] = useState(false);
  const acceptDialogRef = useRef<HTMLDialogElement>(null);
  const acceptOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [acceptPending, setAcceptPending] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  // UI-013: accept drives a multi-chunk commit (`db/repositories/import-
  // commit.ts` processes at most `MAX_CHUNK_SIZE` rows per server
  // invocation, by architectural design -- see ARCHITECTURE.md's "processes
  // one chunk per invocation" -- so a single accept response can still be
  // `committing`) to COMPLETION client-side: `submitAccept` below loops the
  // same idempotent accept call (via `runAcceptCommitLoop`) until the batch
  // is `committed`, and this tracks the running "N of M rows" progress --
  // both numbers from the commit machinery's OWN response fields
  // (`acceptLoopProgress`), never reconciliation-intent preview counts --
  // so the owner is never left pumping chunks by hand.
  const [acceptProgress, setAcceptProgress] = useState<{
    processed: number;
    total: number;
  } | null>(null);
  // UI-013 review round (unmount/navigation guard, UI-008's bounded-fetch
  // pattern applied to a LOOP rather than a single request): aborts the
  // in-flight accept loop's current fetch if the component unmounts mid-
  // loop (see the cleanup effect below) -- otherwise a slow multi-request
  // accept keeps issuing requests and writing state after the owner has
  // navigated away.
  const acceptAbortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      acceptAbortControllerRef.current?.abort();
    };
  }, []);
  // BRK-009C: per-security name/exchange metadata edit -- reuses the shared
  // `pending`/`message` state every other one-off preview mutation in this
  // component already reuses (`resolveMapping`, `verifySecurityCandidate`),
  // rather than inventing a new per-row pending scheme.
  // UI-014 follow-up: a successful rename unmounts the row's Save button
  // (Part 1's fix flips the row to plain text once the name is no longer
  // missing), so focus would otherwise silently fall back to <body> --
  // mirrors this file's other opener-focus-restore refs (exclusion/
  // attestation/accept dialogs above), but targets the row's own new-text
  // cell rather than a dialog opener: armed with the just-saved row's key
  // in `submitSecurityMetadata`, consumed by that cell's callback ref
  // (`securitiesReview.map` below) the moment it mounts in the same commit
  // the form unmounts in.
  const savedNameFocusRowKeyRef = useRef<string | null>(null);
  // UI-012: the review section (`import-review-result` below) renders far
  // ABOVE the import-history section further down the page. Opening a
  // pre-commit batch's review from history via `resumeReviewFromHistory`
  // therefore needs to scroll the now-populated review section into view --
  // otherwise the owner's "no errors or ability to commit" report repeats,
  // since the restored resolution cards render off-screen above where they
  // clicked.
  // UI-019 (owner-reported): the Sharesight sync panel's own "Open in
  // review" affordance (`onOpenBatch` below) has the SAME defect --
  // this component renders `<HistoricalDataPanel />` between the sync panel
  // and this review section, so the loaded review lands well below where
  // the owner clicked, "under the Import Historical Data section" in the
  // owner's own words, leaving them looking at the wrong place. There is
  // only ONE review section (never a separate CSV vs. sync render target --
  // see `loadReviewByBatchId`'s own header comment), so the fix is simply to
  // arm this same scroll request from `onOpenBatch` too, exactly as
  // `resumeReviewFromHistory` already does.
  const reviewSectionRef = useRef<HTMLElement | null>(null);
  // UI-019: focus target for the same scroll-into-view moment -- a
  // keyboard/screen-reader user gets no benefit from a visual scroll alone
  // (QA-001B). `tabIndex={-1}` on the heading below makes it
  // programmatically focusable without adding it to the normal Tab order.
  const reviewHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingReviewScrollBatchIdRef = useRef<string | null>(null);

  useEffect(() => {
    const dialog = exclusionDialogRef.current;
    if (pendingExclusion && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!pendingExclusion && dialog?.open) dialog.close();
    if (!pendingExclusion && exclusionOpenerRef.current) {
      exclusionOpenerRef.current.focus();
      exclusionOpenerRef.current = null;
    }
  }, [pendingExclusion]);

  useEffect(() => {
    const dialog = attestationDialogRef.current;
    if (pendingAttestation && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!pendingAttestation && dialog?.open) dialog.close();
    if (!pendingAttestation && attestationOpenerRef.current) {
      attestationOpenerRef.current.focus();
      attestationOpenerRef.current = null;
    }
  }, [pendingAttestation]);

  useEffect(() => {
    const dialog = acceptDialogRef.current;
    if (acceptDialogOpen && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!acceptDialogOpen && dialog?.open) dialog.close();
    if (!acceptDialogOpen && acceptOpenerRef.current) {
      acceptOpenerRef.current.focus();
      acceptOpenerRef.current = null;
    }
  }, [acceptDialogOpen]);

  useEffect(() => {
    void loadHistory();
  }, []);

  // UI-012/UI-019: fires once the review that `resumeReviewFromHistory` (or
  // the Sharesight sync panel's `onOpenBatch`) requested has actually landed
  // in state (matched by batch id, not just "any review changed") -- see the
  // ref's own header note above. Review finding: no explicit
  // `behavior: "smooth"` here -- passing it would override the CSS
  // `scroll-behavior` property entirely (including globals.css's
  // `@media (prefers-reduced-motion: reduce)` rule that forces
  // `scroll-behavior: auto !important`), reintroducing motion for a reader
  // who asked their OS to suppress it. Omitting `behavior` leaves the
  // browser to follow that CSS property, so the reduced-motion override
  // already applies unchanged. `preventScroll: true` on the focus call stops
  // the browser's own default "scroll the newly focused element into view"
  // behaviour from firing a SECOND, redundant scroll right after the first.
  useEffect(() => {
    if (review && pendingReviewScrollBatchIdRef.current === review.batch.id) {
      pendingReviewScrollBatchIdRef.current = null;
      reviewSectionRef.current?.scrollIntoView({ block: "start" });
      reviewHeadingRef.current?.focus({ preventScroll: true });
    }
  }, [review]);

  async function loadHistory() {
    setHistoryPending(true);
    try {
      const response = await fetch("/api/import/history", {
        cache: "no-store",
      });
      const result = (await response.json()) as
        { ok: true; history: HistoryBatch[] } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "Import history could not be loaded.",
        );
      }
      setHistory(result.history);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Import history could not be loaded.",
      );
    } finally {
      setHistoryPending(false);
    }
  }

  async function loadHistoryDetail(batchId: string, offset = 0) {
    if (offset === 0) {
      setReversal(null);
      setReversalKey(null);
    }
    setHistoryPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/import/history/${batchId}?offset=${offset}`,
        {
          cache: "no-store",
        },
      );
      const result = (await response.json()) as
        | { ok: true; detail: ImportHistoryDetail }
        | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "Import batch history could not be loaded.",
        );
      }
      setHistoryDetail((current) => {
        if (offset === 0 || current?.batch.id !== result.detail.batch.id) {
          return result.detail;
        }
        return {
          ...result.detail,
          rows: [...current.rows, ...result.detail.rows],
          issues: [...current.issues, ...result.detail.issues],
          mappings: [...current.mappings, ...result.detail.mappings],
          audit: [...current.audit, ...result.detail.audit],
        };
      });
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Import batch history could not be loaded.",
      );
    } finally {
      setHistoryPending(false);
    }
  }

  async function reverseHistoryImport(expectedVersion: number) {
    if (!historyDetail) return;
    const idempotencyKey = reversalKey ?? crypto.randomUUID();
    setReversalKey(idempotencyKey);
    setReversalPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/import/commit/${historyDetail.batch.id}/reverse`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion,
            idempotencyKey,
            confirmation: true,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      const result: ImportReversalActionResult = isImportReversalResult(payload)
        ? payload
        : {
            ok: false,
            status: 503,
            message: "The reversal response was invalid.",
          };
      if (!response.ok && result.ok) {
        setMessage("The reversal response was invalid.");
      }
      if (result.ok) {
        await Promise.all([
          loadHistory(),
          loadHistoryDetail(historyDetail.batch.id),
        ]);
      }
      setReversal(result);
      setReversalKey(idempotencyKey);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Import reversal could not be completed.",
      );
    } finally {
      setReversalPending(false);
    }
  }

  async function stageCorrectedSuccessor(file: File) {
    if (
      historyDetail?.batch.status !== "reversed" ||
      !historyDetail.batch.targetPortfolioId
    ) {
      setMessage(
        "Only a reversed import with one target portfolio can be corrected.",
      );
      return;
    }
    const supersededBatchId = historyDetail.batch.id;
    const targetId = historyDetail.batch.targetPortfolioId;
    const form = new FormData();
    form.set("file", file);
    form.set("targetPortfolioId", targetId);
    form.set("supersedesBatchId", supersededBatchId);
    setSuccessorPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/import/preview", {
        method: "POST",
        body: form,
      });
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "The corrected import preview could not be created.",
        );
      }
      setTargetPortfolioId(targetId);
      setReview(result.review);
      setCommit(null);
      setCommitConfirmed(false);
      setCommitKey(null);
      await Promise.all([
        loadHistory(),
        loadHistoryDetail(result.review.batch.id),
      ]);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The corrected import preview could not be created.",
      );
    } finally {
      setSuccessorPending(false);
    }
  }

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!form.get("file") || !targetPortfolioId) {
      setMessage("Choose a CSV file and portfolio before previewing.");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      form.set("targetPortfolioId", targetPortfolioId);
      const response = await fetch("/api/import/preview", {
        method: "POST",
        body: form,
      });
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "The import preview could not be created.",
        );
      }
      setReview(result.review);
      setCommit(null);
      setCommitConfirmed(false);
      setCommitKey(null);
      await loadHistory();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The import preview could not be created.",
      );
    } finally {
      setPending(false);
    }
  }

  async function resolveMapping(
    mapping: PendingMapping,
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!review) return;
    const form = new FormData(event.currentTarget);
    const targetId =
      mapping.kind === "fx" ? null : String(form.get("targetId") ?? "");
    const targetValue =
      mapping.kind === "fx" ? String(form.get("targetValue") ?? "") : null;
    if (mapping.kind !== "fx" && !targetId) {
      setMessage("Choose a target before saving this mapping.");
      return;
    }
    if (mapping.kind === "fx" && !targetValue) {
      setMessage("Choose an FX direction before saving this mapping.");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/import/preview/${review.batch.id}/mappings`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: mapping.kind,
            scope: "batch",
            confidence: "user",
            sourceKey: mapping.sourceKey,
            normalizedSourceValue: mapping.sourceKey,
            targetId,
            targetValue,
            expectedVersion: review.batch.version,
            expectedPreviewVersion: review.previewVersion,
          }),
        },
      );
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "The mapping could not be saved.",
        );
      }
      setReview(result.review);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The mapping could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  async function verifySecurityCandidate(
    candidate: {
      portfolioId: string;
      sourceSymbol: string;
      sourceExchangeAlias: string | null;
      sourceCurrencyCode: string;
    },
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!review) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/import/preview/${review.batch.id}/securities/verify`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            portfolioId: candidate.portfolioId,
            sourceSymbol: candidate.sourceSymbol,
            sourceExchangeAlias: candidate.sourceExchangeAlias,
            sourceCurrencyCode: candidate.sourceCurrencyCode,
            expectedVersion: review.batch.version,
            expectedPreviewVersion: review.previewVersion,
          }),
        },
      );
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "This security could not be verified.",
        );
      }
      setReview(result.review);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "This security could not be verified.",
      );
    } finally {
      setPending(false);
    }
  }

  // IMP-009: opens the "Resolve manually" confirm dialog for one unresolved
  // security candidate, defaulting the owner-editable display name to the
  // symbol per the Orchestrator ruling.
  function openAttestationDialog(
    event: React.MouseEvent<HTMLButtonElement>,
    candidate: PendingAttestation["candidate"],
  ) {
    attestationOpenerRef.current = event.currentTarget;
    setAttestationError(null);
    setPendingAttestation({ candidate, displayName: candidate.sourceSymbol });
  }

  async function submitAttestation() {
    if (!review || !pendingAttestation) return;
    setAttestationPending(true);
    setAttestationError(null);
    try {
      const response = await fetch(
        `/api/import/preview/${review.batch.id}/securities/attest`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            portfolioId: pendingAttestation.candidate.portfolioId,
            sourceSymbol: pendingAttestation.candidate.sourceSymbol,
            sourceExchangeAlias:
              pendingAttestation.candidate.sourceExchangeAlias,
            sourceCurrencyCode: pendingAttestation.candidate.sourceCurrencyCode,
            displayName: pendingAttestation.displayName,
            expectedVersion: review.batch.version,
            expectedPreviewVersion: review.previewVersion,
          }),
        },
      );
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "This security could not be resolved manually.",
        );
      }
      setReview(result.review);
      setMessage(
        `${pendingAttestation.candidate.sourceSymbol} was resolved manually. Owner-attested identity; market data unavailable until provider-verified.`,
      );
      setPendingAttestation(null);
    } catch (error) {
      setAttestationError(
        error instanceof Error
          ? error.message
          : "This security could not be resolved manually.",
      );
    } finally {
      setAttestationPending(false);
    }
  }

  // IMP-008: opens the consequence-stating confirm dialog for a skip
  // (exclude) or un-skip (include) action. `description` is the exact
  // consequence copy shown in the dialog -- callers compose it from
  // whatever they already know about the target (symbol, row count).
  function openExclusionDialog(
    event: React.MouseEvent<HTMLButtonElement>,
    action: "exclude" | "include",
    target: ExclusionTarget,
    description: string,
  ) {
    exclusionOpenerRef.current = event.currentTarget;
    setExclusionError(null);
    setPendingExclusion({ action, target, description });
  }

  async function submitExclusion() {
    if (!review || !pendingExclusion) return;
    setExclusionPending(true);
    setExclusionError(null);
    try {
      const response = await fetch(
        `/api/import/preview/${review.batch.id}/exclusions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: pendingExclusion.action,
            target: pendingExclusion.target,
            expectedVersion: review.batch.version,
            expectedPreviewVersion: review.previewVersion,
          }),
        },
      );
      const result = (await response.json()) as
        | { ok: true; review: Review; changedRowCount: number }
        | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "This exclusion could not be saved.",
        );
      }
      setReview(result.review);
      setMessage(
        result.changedRowCount === 0
          ? "No rows changed -- they may already be in that state."
          : pendingExclusion.action === "exclude"
            ? `${result.changedRowCount} row${result.changedRowCount === 1 ? "" : "s"} excluded -- they will not be committed.`
            : `${result.changedRowCount} row${result.changedRowCount === 1 ? "" : "s"} restored and will be committed again.`,
      );
      setPendingExclusion(null);
    } catch (error) {
      setExclusionError(
        error instanceof Error
          ? error.message
          : "This exclusion could not be saved.",
      );
    } finally {
      setExclusionPending(false);
    }
  }

  // BRK-005B: opens a batch (a Sharesight sync's own staged batch, or any
  // other batch id) into the SAME review section a CSV upload's preview
  // response already renders below -- there is no separate review PAGE to
  // link to, so this is the "link to the batch's existing review page"
  // this task's acceptance criteria describes.
  async function loadReviewByBatchId(batchId: string) {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/import/preview/${batchId}`, {
        cache: "no-store",
      });
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "The batch preview could not be loaded.",
        );
      }
      setReview(result.review);
      setCommit(null);
      setCommitConfirmed(false);
      setCommitKey(null);
      await loadHistory();
    } catch (error) {
      // UI-012 review follow-up: clear a scroll request armed by
      // `resumeReviewFromHistory` on failure too -- otherwise a LATER,
      // unrelated successful load of the SAME batch id (e.g. a retry after
      // fixing the error, or `refreshPreview()`/`onOpenBatch` reusing this
      // same function) would still match the stale armed id and trigger an
      // unexpected scroll.
      pendingReviewScrollBatchIdRef.current = null;
      setMessage(
        error instanceof Error
          ? error.message
          : "The batch preview could not be loaded.",
      );
    } finally {
      setPending(false);
    }
  }

  // UI-012: the explicit "Open review" affordance for a pre-commit batch
  // reached from import history (list entry or detail panel) -- arms the
  // scroll-into-view ref above, then reuses `loadReviewByBatchId` exactly
  // as the Sharesight sync panel's `onOpenBatch` does. Callers are
  // responsible for status-gating (see `isMutableExclusionStatus`); this
  // function does not re-check status itself since the server's own
  // preview endpoint is the authority on whether a batch still has a
  // reviewable preview.
  function resumeReviewFromHistory(batchId: string) {
    pendingReviewScrollBatchIdRef.current = batchId;
    void loadReviewByBatchId(batchId);
  }

  async function refreshPreview() {
    if (!review) return;
    setPending(true);
    try {
      const response = await fetch(`/api/import/preview/${review.batch.id}`, {
        cache: "no-store",
      });
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "The preview could not be refreshed.",
        );
      }
      setReview(result.review);
      setMessage(null);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The preview could not be refreshed.",
      );
    } finally {
      setPending(false);
    }
  }

  async function markReady() {
    if (!review || !review.preview.ready) return;
    setReadyPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/import/preview/${review.batch.id}/ready`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: review.batch.version,
            expectedPreviewVersion: review.previewVersion,
          }),
        },
      );
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "This import could not be marked ready.",
        );
      }
      setReview(result.review);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "This import could not be marked ready.",
      );
    } finally {
      setReadyPending(false);
    }
  }

  async function commitImport() {
    if (!review || !review.preview.ready || !commitConfirmed) return;
    const idempotencyKey = commitKey ?? crypto.randomUUID();
    setCommitKey(idempotencyKey);
    setCommitPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/import/commit/${review.batch.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: review.batch.version,
          expectedPreviewVersion: review.previewVersion,
          idempotencyKey,
          confirmation: true,
        }),
      });
      const result = (await response.json()) as
        { ok: true; commit: CommitResult } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "The import commit could not be completed.",
        );
      }
      setCommit(result.commit);
      await loadHistory();
      if (result.commit.status === "committed") {
        await loadHistoryDetail(review.batch.id);
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The import commit could not be completed.",
      );
    } finally {
      setCommitPending(false);
    }
  }

  // BRK-009C: opens the ONE "Accept Import" confirm dialog shared by both
  // the top and bottom accept buttons on the "Review securities" section.
  function openAcceptDialog(event: React.MouseEvent<HTMLButtonElement>) {
    acceptOpenerRef.current = event.currentTarget;
    setAcceptError(null);
    setAcceptDialogOpen(true);
  }

  // UI-013: an owner-reported defect after the first real Sharesight commit
  // -- accept could return with the batch still `committing` (each
  // server-side `commit()` call is bounded to `MAX_CHUNK_SIZE` (2) staged
  // rows by design -- see `db/repositories/import-commit.ts` and
  // ARCHITECTURE.md's "processes one chunk per invocation" -- and
  // `acceptImportWithContext` only loops that call up to its own bounded
  // safety cap, `ACCEPT_COMMIT_LOOP_MAX_ITERATIONS`, before returning
  // whatever status it reached), leaving the owner to click Commit
  // repeatedly to pump the rest. `acceptImportWithContext`'s server-side
  // loop now finishes realistically-sized batches in ONE request; this
  // client-side loop (`runAcceptCommitLoop`, `app/import-review-commit-
  // state.ts` -- pulled out to a pure function so its termination behaviour
  // has its own real-input/real-output tests) is the layer above it that
  // finishes the rest for a batch large enough to exceed even that cap, so
  // the owner NEVER manually pumps chunks either way: each iteration
  // re-POSTs the identical accept request (safe -- `acceptImportWithContext`
  // uses a deterministic `accept:<batchId>` commit idempotency key, so a
  // repeat call against a `committing` batch resumes from
  // `commit_high_water_row` via the existing idempotent resume branch, not
  // a fresh commit attempt) until the response reports `committed`, a real
  // error (a 409/etc. ends the loop immediately with that error shown,
  // never silently retried), the request is aborted (unmount), or the
  // safety iteration cap is hit. `acceptProgress` drives the dialog's
  // "Committing... N of M rows" text between iterations, sourced from the
  // commit machinery's own response fields (`acceptLoopProgress`), never
  // preview reconciliation counts.
  async function submitAccept() {
    if (!review) return;
    const batchId = review.batch.id;
    acceptAbortControllerRef.current?.abort();
    const controller = new AbortController();
    acceptAbortControllerRef.current = controller;
    setAcceptPending(true);
    setAcceptError(null);
    setAcceptProgress(null);
    try {
      const outcome = await runAcceptCommitLoop<CommitResult>({
        // Generous bound, not a realistic ceiling: at `MAX_CHUNK_SIZE` (2)
        // rows per iteration this still covers many thousands of
        // committable rows while guaranteeing the loop terminates even if
        // the server ever stops making forward progress, rather than
        // hanging the tab.
        maxIterations: 5000,
        signal: controller.signal,
        fetchAccept: () =>
          fetch(`/api/import/preview/${batchId}/accept`, {
            method: "POST",
            signal: controller.signal,
          }),
        onProgress: (commitResult) => {
          setCommit(commitResult);
          const { processed, total } = acceptLoopProgress(commitResult);
          setAcceptProgress({ processed, total });
        },
      });
      if (!outcome.ok) {
        if (outcome.aborted) return;
        throw new Error(outcome.message);
      }
      setAcceptDialogOpen(false);
      await refreshPreview();
      await loadHistory();
      await loadHistoryDetail(batchId);
    } catch (error) {
      setAcceptError(
        error instanceof Error
          ? error.message
          : "This import could not be accepted.",
      );
    } finally {
      setAcceptPending(false);
      setAcceptProgress(null);
      if (acceptAbortControllerRef.current === controller) {
        acceptAbortControllerRef.current = null;
      }
    }
  }

  // BRK-009C: the per-security name edit -- `entry` supplies the CURRENT
  // identity tuple the server re-derives batch membership from. Exchange
  // and currency have NO edit path at all (review round finding B2 removed
  // the exchange branch as dead UI -- see the Exchange/Currency cells
  // below, which always render read-only text). Reuses the shared
  // `pending`/`message` state, matching this component's other one-off
  // preview mutations (`resolveMapping`, `verifySecurityCandidate`).
  async function submitSecurityMetadata(
    entry: SecuritySummaryEntry,
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!review) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "");
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/import/preview/${review.batch.id}/securities/metadata`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            portfolioId: review.batch.targetPortfolioId,
            sourceSymbol: entry.sourceSymbol,
            sourceExchangeAlias: entry.sourceExchangeAlias,
            sourceCurrencyCode: entry.sourceCurrencyCode,
            securityId: entry.securityId,
            name,
            expectedVersion: review.batch.version,
            expectedPreviewVersion: review.previewVersion,
          }),
        },
      );
      const result = (await response.json()) as
        { ok: true; review: Review } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "This security's details could not be saved.",
        );
      }
      setReview(result.review);
      // UI-014 part 2 root cause: the previous version never called
      // `setMessage` on SUCCESS -- only on error -- and the name `<input>`
      // is UNCONTROLLED (`defaultValue`, not `value`), so re-rendering with
      // the server's updated `entry.name` never changed what the input
      // visibly showed either (a `defaultValue` prop change is ignored by
      // React once a DOM node exists). Combined, a successful save looked
      // IDENTICAL to a silent no-op: the spinner (the shared `pending`
      // state) went away and the same form, showing the same typed text,
      // reappeared -- indistinguishable from failure. Part 1's fix (the
      // form only renders while the name is still missing) now makes a
      // successful save visibly flip the row to plain text; this explicit
      // confirmation is the second half of the fix.
      setMessage(`${entry.sourceSymbol}'s name was saved.`);
      // UI-014 follow-up: the Save button this submit came from is about to
      // unmount (Part 1's fix). `entry`'s identity tuple (symbol/exchange/
      // currency) is unaffected by a name-only edit, so it still matches
      // the SAME row's key in the next render -- arm the focus-restore ref
      // consumed by that row's text-cell callback ref below.
      savedNameFocusRowKeyRef.current = securityRowKey(entry);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "This security's details could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  async function resumeHistoryCommit() {
    if (
      historyDetail?.batch.status !== "committing" ||
      !historyDetail.progress.idempotencyKey
    ) {
      return;
    }
    setCommitPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/import/commit/${historyDetail.batch.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: historyDetail.batch.version,
            expectedPreviewVersion: "resume-existing-commit",
            idempotencyKey: historyDetail.progress.idempotencyKey,
            confirmation: true,
          }),
        },
      );
      const result = (await response.json()) as
        { ok: true; commit: CommitResult } | { ok: false; message: string };
      if (!response.ok || result.ok === false) {
        throw new Error(
          result.ok === false
            ? result.message
            : "The import commit could not be resumed.",
        );
      }
      setCommit(result.commit);
      await Promise.all([
        loadHistory(),
        loadHistoryDetail(historyDetail.batch.id),
      ]);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The import commit could not be resumed.",
      );
    } finally {
      setCommitPending(false);
    }
  }

  // Server-seeded snapshot overlaid by whatever has actually been
  // linked/re-linked client-side since (see `mergeSharesightLinks`'s header
  // note -- this is the B1 fix's whole point: computed fresh every render
  // from state that survives a target-portfolio switch, unlike the old
  // per-panel `initialLink` prop).
  const effectiveSharesightLinks = mergeSharesightLinks(
    sharesightLinks,
    sharesightLinkOverrides,
  );

  // One resolve form per distinct (kind, sourceKey) pending mapping, not per
  // row: many transaction rows commonly share the same unresolved portfolio,
  // security, or FX source key, and a `scope: "batch"` decision (saved
  // below) resolves all of them at once.
  const pendingMappings: PendingMapping[] = review
    ? [
        ...new Map(
          review.preview.issues
            .filter(
              (issue) =>
                issue.code === "PORTFOLIO_MAPPING_REQUIRED" ||
                issue.code === "PORTFOLIO_MAPPING_INVALID" ||
                issue.code === "SECURITY_MAPPING_REQUIRED" ||
                issue.code === "SECURITY_MAPPING_AMBIGUOUS" ||
                issue.code === "FX_DIRECTION_REQUIRED",
            )
            .map((issue) => {
              const kind: PendingMapping["kind"] =
                issue.code === "PORTFOLIO_MAPPING_REQUIRED" ||
                issue.code === "PORTFOLIO_MAPPING_INVALID"
                  ? "portfolio"
                  : issue.code === "FX_DIRECTION_REQUIRED"
                    ? "fx"
                    : "security";
              const sourceKey = issue.sourceKey ?? "";
              const key = `${kind}:${sourceKey}`;
              return [
                key,
                { key, kind, sourceKey, message: issue.message },
              ] as const;
            }),
        ).values(),
      ]
    : [];

  // UI-015: the exact set of "security" pending-mapping keys the block
  // above actually produced -- the securities table's "Awaiting resolution"
  // affordance below must never claim a link to the pending-mappings
  // section that isn't genuinely there.
  const pendingSecurityMappingKeys = new Set(
    pendingMappings
      .filter((mapping) => mapping.kind === "security")
      .map((mapping) => mapping.sourceKey),
  );

  // IMP-008 review finding B2-residual: an already-excluded row's issue is
  // shown, accurately, in "Excluded rows" below -- suppressed here (see
  // `isRowStillBlocking`) rather than relabelled, to avoid listing the same
  // row in two places.
  const excludedRowIds = new Set(
    review ? review.excludedRows.map((row) => row.id) : [],
  );
  const blockedRowIssues = review
    ? review.issues.filter((issue) => isRowStillBlocking(issue, excludedRowIds))
    : [];

  // BRK-009C: `parserFormat` distinguishes a `sharesight_sync` batch (gets
  // the "Review securities" section) from a `strict-versioned-csv` one
  // (unchanged UI, per the Orchestrator ruling) -- literal string, matching
  // this file's existing convention of comparing batch status by literal
  // rather than importing a server-only domain constant into a client
  // component.
  const securitiesReview =
    review && review.batch.parserFormat === "sharesight_sync"
      ? (review.securities ?? [])
      : null;
  // BRK-009C review round (finding B3): gates ONLY on PERSISTED,
  // error-severity, non-excluded issues (`blockedRowIssues`, already
  // exactly that -- computed `SECURITY_MAPPING_REQUIRED`/`_AMBIGUOUS` are
  // never persisted to `import_issues`, so they never appear here) plus
  // pending/already-committed. Deliberately NOT `review.preview.ready`:
  // that COMPUTED flag also reflects `SECURITY_MAPPING_REQUIRED` for a
  // merely `unresolved` security, which accept's own first step (the
  // resolution pass) resolves automatically -- gating the button on it
  // would grey out "Accept Import" in exactly the pre-resolution state the
  // button exists to fix. If the server's resolution pass still cannot
  // resolve everything, `acceptImportWithContext` returns its existing
  // honest error and `acceptError` below surfaces it.
  // UI-013 review round B2 (BLOCKING): `commit` is set by BOTH this
  // review's own accept/commit actions AND the independent "Resume this
  // commit" affordance for a DIFFERENT batch shown in the import-history
  // panel below (`resumeHistoryCommit`) -- reading raw `commit` here would
  // let resuming batch B's interrupted commit falsely mark THIS review
  // (batch A) as committed. Every read of `commit` in the review section
  // below goes through this scoped value, never the raw state.
  const reviewCommit = scopeCommitToBatch(
    commit,
    review ? { id: review.batch.id, status: review.batch.status } : null,
  );
  const acceptDisabled =
    !review ||
    blockedRowIssues.length > 0 ||
    acceptPending ||
    reviewCommit?.status === "committed" ||
    review.batch.status === "committed";
  const acceptTargetPortfolioName =
    portfolios.find(
      (portfolio) => portfolio.id === review?.batch.targetPortfolioId,
    )?.name ?? "this portfolio";
  // BRK-009C review round (B3): the informational (non-blocking)
  // counterpart to the blocked-row summary -- how many of THIS batch's
  // distinct securities are merely `unresolved` (not blocked by any
  // persisted issue), which accept's own resolution pass will resolve
  // automatically. Shown only when there is nothing actually blocking.
  const unresolvedSecurityCount = (securitiesReview ?? []).filter(
    (entry) => entry.state === "unresolved",
  ).length;
  // UI-013: once a batch is done -- server-confirmed `committed`/`reversed`
  // (reachable after a reload/resume of an already-finished batch), or
  // `reviewCommit` reports `committed` from an action taken THIS session for
  // THIS batch (CSV's `commitImport()` deliberately never refreshes
  // `review.batch.status`, see its own comment, so `review.batch.status`
  // alone would miss a same-session CSV commit) -- neither the Accept
  // Import buttons nor the legacy commit panel render: both are "do this to
  // commit" affordances, and the batch is already done. A status line
  // replaces them; the rest of the review (securities table, issues,
  // excluded rows) stays as evidence.
  const isCommittedOrReversed =
    review !== null &&
    deriveIsCommittedOrReversed(
      { id: review.batch.id, status: review.batch.status },
      reviewCommit,
    );
  // UI-013 review round B1: the committed/reversed status line's exact
  // text, sourced from real commit-machinery counts only -- see
  // `deriveCommittedStatusLine`'s doc comment for why (never reconciliation
  // -intent `preview.counts`).
  const committedStatusLine =
    review && isCommittedOrReversed
      ? deriveCommittedStatusLine(
          review.batch.status,
          reviewCommit,
          review.commitProgress ?? EMPTY_COMMIT_PROGRESS,
        )
      : null;
  // UI-020: this batch's own persisted history-list entry, matched by id --
  // see `committedConfirmationText`'s header note for why this, and never
  // `historyDetail`.
  const reviewHistoryEntry = review
    ? (history.find((batch) => batch.id === review.batch.id) ?? null)
    : null;
  // UI-013 (one blessed path per batch type): a `sharesight_sync` batch's
  // pre-commit path is Accept Import ALONE -- it collapses resolve
  // securities -> mark ready -> commit (BRK-009B) into one action, and its
  // commit step is the same idempotent `commit()` resume used everywhere
  // else, so a `committing` batch (see `acceptDisabled` above, which does
  // not gate on `committing`) is resumed automatically by `submitAccept`'s
  // own client-side continuation loop -- no separate click, no separate
  // affordance needed. Accept Import doubles as the resume affordance, so
  // the legacy "Mark import ready"/"Financial commit" panels never render
  // for these batches at all (avoiding the exact "two buttons, unsure which
  // one to click" confusion the owner reported). The history detail panel's
  // separate "Resume this commit" affordance (`import-history-detail.tsx`)
  // remains available too, independent of batch type, for a `committing`
  // batch reached from import history (a fresh page load, no live
  // `review`/`commit` state) rather than from this live review.
  const isSharesightSyncBatch = securitiesReview !== null;

  return (
    <main className="import-review-page">
      {/* UI-038 (owner-reported orphan): /import is opened from the top
          bar's "+" menu on every primary tab, so the back control goes BACK
          in history rather than to one hard-coded parent; a direct arrival
          falls back to the workspace overview. */}
      <div className="subnav-heading">
        <HistoryBackControl fallbackHref="/" label="Back" />
        <p className="eyebrow">Import review</p>
      </div>
      <h1>Preview a CSV import</h1>
      <p className="import-intro">
        Upload, inspect, and resolve issues before an explicit financial commit
        can create reviewed facts.
      </p>
      <form className="import-upload-form" onSubmit={upload}>
        <label>
          CSV file
          <input name="file" type="file" accept=".csv,text/csv" required />
        </label>
        <label>
          Target portfolio
          <select
            value={targetPortfolioId}
            onChange={(event) => setTargetPortfolioId(event.target.value)}
            required
          >
            {portfolios.map((portfolio) => (
              <option value={portfolio.id} key={portfolio.id}>
                {portfolio.name} · {portfolio.homeCurrencyCode}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Preparing preview…" : "Create review preview"}
        </button>
      </form>

      {targetPortfolioId ? (
        <SharesightSyncPanel
          key={targetPortfolioId}
          portfolioId={targetPortfolioId}
          link={
            effectiveSharesightLinks[targetPortfolioId] ?? {
              status: "not_linked",
            }
          }
          onLinked={(linkedPortfolioId, sharesightPortfolioId) =>
            setSharesightLinkOverrides((prev) => ({
              ...prev,
              [linkedPortfolioId]: {
                status: "linked",
                sharesightPortfolioId,
              },
            }))
          }
          // UI-019 (owner-reported): "Open in review" after a Sharesight
          // sync used to reuse `loadReviewByBatchId` alone, WITHOUT arming
          // the scroll-into-view/focus request `resumeReviewFromHistory`
          // arms below -- so the loaded review rendered silently below the
          // `HistoricalDataPanel` just underneath, "under the Import
          // Historical Data section" in the owner's words, leaving the
          // owner right where they clicked. Mirrors
          // `resumeReviewFromHistory` exactly: arm the same ref with this
          // batch id, then reuse the same load.
          onOpenBatch={(batchId) => {
            pendingReviewScrollBatchIdRef.current = batchId;
            void loadReviewByBatchId(batchId);
          }}
        />
      ) : null}

      <HistoricalDataPanel portfolioId={targetPortfolioId} />

      {message ? (
        <p className="action-feedback" role="alert">
          <span>{message}</span>
          {review && isStalePreviewMessage(message) ? (
            <button
              type="button"
              onClick={() => void refreshPreview()}
              disabled={pending}
            >
              {pending ? "Refreshing…" : "Refresh preview"}
            </button>
          ) : null}
        </p>
      ) : null}

      {review ? (
        <section
          className="import-review-result"
          aria-labelledby="review-title"
          ref={reviewSectionRef}
        >
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Server-issued preview</p>
              <h2 id="review-title" ref={reviewHeadingRef} tabIndex={-1}>
                {review.batch.filename}
              </h2>
            </div>
            {/* UI-020 (owner-reported): this pill used to read
                "Ready to review"/"Needs resolution" forever, even after the
                batch was actually committed or reversed -- it never checked
                `isCommittedOrReversed` at all. Reversed is only ever known
                from the PERSISTED `review.batch.status` (never a live
                same-session commit result, which can only ever report
                "committed") -- see `deriveCommittedStatusLine`'s identical
                distinction. */}
            <span
              className={
                isCommittedOrReversed
                  ? review.batch.status === "reversed"
                    ? "status-blocked"
                    : "status-ready"
                  : review.preview.ready
                    ? "status-ready"
                    : "status-blocked"
              }
            >
              {isCommittedOrReversed
                ? review.batch.status === "reversed"
                  ? "Reversed"
                  : "Committed"
                : review.preview.ready
                  ? "Ready to review"
                  : "Needs resolution"}
            </span>
          </div>
          <p className="import-preview-version">
            Preview version <code>{review.previewVersion}</code> · batch status{" "}
            {review.batch.status}
          </p>
          <div className="import-counts" aria-label="Preview counts">
            <span>
              {review.preview.counts.transactionCreates} transaction rows
            </span>
            <span>{review.preview.counts.dividendCreates} dividend rows</span>
            <span>{review.preview.counts.candidateCreates} new candidates</span>
            <span>{review.preview.counts.skips} skipped</span>
            <span>{review.preview.counts.unresolved} unresolved</span>
            <span>{review.excludedRows.length} excluded by owner</span>
          </div>

          {committedStatusLine ? (
            <p className="import-commit-status complete" role="status">
              {committedStatusLine}
            </p>
          ) : null}

          {securitiesReview ? (
            <section
              className="import-securities-review"
              aria-labelledby="securities-title"
            >
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Review securities</p>
                  <h3 id="securities-title">
                    {securitiesReview.length} distinct{" "}
                    {securitiesReview.length === 1 ? "security" : "securities"}
                  </h3>
                </div>
              </div>
              <p>
                Accepting will commit {review.preview.counts.transactionCreates}{" "}
                transaction row
                {review.preview.counts.transactionCreates === 1
                  ? ""
                  : "s"} and {review.preview.counts.dividendCreates} dividend
                row
                {review.preview.counts.dividendCreates === 1
                  ? ""
                  : "s"} into {acceptTargetPortfolioName}.
              </p>
              {blockedRowIssues.length > 0 ? (
                <p role="note">
                  Resolve {blockedRowIssues.length} blocked row
                  {blockedRowIssues.length === 1 ? "" : "s"} below before this
                  import can be accepted.
                </p>
              ) : unresolvedSecurityCount > 0 ? (
                <p role="note">
                  {unresolvedSecurityCount} unresolved securit
                  {unresolvedSecurityCount === 1 ? "y" : "ies"} will be resolved
                  automatically on accept.
                </p>
              ) : null}
              {!isCommittedOrReversed ? (
                <div className="import-accept-actions">
                  <button
                    type="button"
                    onClick={(event) => openAcceptDialog(event)}
                    disabled={acceptDisabled}
                    aria-busy={acceptPending || undefined}
                  >
                    Accept Import
                  </button>
                </div>
              ) : null}

              <div className="table-scroll">
                <table className="import-securities-table">
                  <caption className="sr-only">
                    Distinct securities referenced by this import, one row per
                    security
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Ticker</th>
                      <th scope="col">Exchange</th>
                      <th scope="col">Currency</th>
                      <th scope="col">Name</th>
                      <th scope="col">Rows</th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {securitiesReview.map((entry) => {
                      const rowKey = securityRowKey(entry);
                      return (
                        <tr key={rowKey}>
                          <td>{entry.sourceSymbol}</td>
                          {/* Exchange and currency are always read-only --
                              review round finding B2: a Sharesight row can
                              never carry a missing market_code/currency_code
                              (domain/sharesight/parse.ts's requiredString
                              gate), so an edit control for either would be
                              dead UI. */}
                          <td>{entry.sourceExchangeAlias ?? "Unknown"}</td>
                          <td>
                            {entry.sourceCurrencyCode}
                            {/* UI-015: a dividend-only foreign-currency
                                group merged into this line (BRK-010's
                                dividend-currency-agnostic match) discloses
                                the extra payout currency honestly, text not
                                color -- never fabricated, only currencies
                                genuinely present among this line's own
                                rows. */}
                            {(entry.additionalPayoutCurrencyCodes ?? [])
                              .length > 0 ? (
                              <>
                                {" "}
                                (dividends in{" "}
                                {(
                                  entry.additionalPayoutCurrencyCodes ?? []
                                ).join(", ")}
                                )
                              </>
                            ) : null}
                            {/* UI-015 review round F4: a solo payout-only
                                line (dividendOnly, no primary sibling to
                                merge into) hints that this currency is the
                                PAYOUT currency -- not necessarily the
                                security's own trading currency -- so a USD
                                cell on what is really an AUD security is
                                never ambiguous. */}
                            {entry.dividendOnly ? <> (dividends only)</> : null}
                          </td>
                          <td>
                            {/* UI-014 part 1 (owner-reported): a prefilled
                                name is plain text -- no input, no Save --
                                since nothing about it needs owner action.
                                The edit affordance renders ONLY when the
                                name is still missing (see
                                `isSecurityNameMissing`) AND editable. */}
                            {isSecurityNameMissing(entry.name) &&
                            entry.nameEditable &&
                            isMutableExclusionStatus(review.batch.status) ? (
                              <form
                                className="import-securities-edit"
                                onSubmit={(event) =>
                                  void submitSecurityMetadata(entry, event)
                                }
                              >
                                <label>
                                  Name for {entry.sourceSymbol}
                                  <input
                                    name="name"
                                    defaultValue={entry.name ?? ""}
                                    maxLength={120}
                                    required
                                    disabled={pending}
                                  />
                                </label>
                                <button
                                  type="submit"
                                  disabled={pending}
                                  aria-busy={pending || undefined}
                                >
                                  {pending ? "Saving…" : "Save"}
                                </button>
                              </form>
                            ) : (
                              <span
                                tabIndex={-1}
                                ref={(node) => {
                                  // UI-014 follow-up: focus this cell the
                                  // moment it mounts, but ONLY when it is
                                  // the row a save just succeeded for
                                  // (never on an unrelated render, e.g. a
                                  // different row's save, or the initial
                                  // load of an already-named row).
                                  if (
                                    node &&
                                    savedNameFocusRowKeyRef.current === rowKey
                                  ) {
                                    node.focus();
                                    savedNameFocusRowKeyRef.current = null;
                                  }
                                }}
                              >
                                {entry.name ?? "Unknown"}
                              </span>
                            )}
                          </td>
                          <td>
                            {entry.rowCount} row
                            {entry.rowCount === 1 ? "" : "s"}
                          </td>
                          <td>
                            {entry.state === "conflict" ? (
                              <a href="#blocked-rows-title">
                                Conflict -- see blocked rows below
                              </a>
                            ) : entry.state === "unresolved" ? (
                              // UI-015: the affordance this text points at
                              // must actually exist -- an "unresolved"
                              // group with no matching pending mapping
                              // (e.g. already satisfied by a batch-scope
                              // mapping decision) never claims a link to
                              // nothing. Names the symbol either way.
                              pendingSecurityMappingKeys.has(
                                pendingSecurityMappingKeyFor(
                                  review.batch.targetPortfolioId ?? "",
                                  entry,
                                ),
                              ) ? (
                                <a href="#mappings-title">
                                  Awaiting resolution -- see pending mappings
                                  above ({entry.sourceSymbol})
                                </a>
                              ) : (
                                `Not yet resolved (${entry.sourceSymbol})`
                              )
                            ) : entry.state === "created" ? (
                              "Newly added security"
                            ) : (
                              "Resolved to an existing security"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!isCommittedOrReversed ? (
                <div className="import-accept-actions">
                  <button
                    type="button"
                    onClick={(event) => openAcceptDialog(event)}
                    disabled={acceptDisabled}
                    aria-busy={acceptPending || undefined}
                  >
                    Accept Import
                  </button>
                </div>
              ) : (
                // UI-020 (owner-reported): the Accept Import button that used
                // to sit here disappears once the batch is committed --
                // this is the text-level confirmation that replaces it, so
                // the bottom of the section (where the owner was just
                // looking, having clicked the button that was there) never
                // goes silent.
                <p className="import-commit-status complete" role="status">
                  {committedConfirmationText(
                    review.batch.status,
                    reviewHistoryEntry,
                  )}
                </p>
              )}
            </section>
          ) : null}

          {pendingMappings.length > 0 ? (
            <section
              className="import-mapping-list"
              aria-labelledby="mappings-title"
            >
              <h3 id="mappings-title">
                Resolve {pendingMappings.length} pending mapping
                {pendingMappings.length === 1 ? "" : "s"}
              </h3>
              {pendingMappings.map((mapping) => {
                if (mapping.kind === "fx") {
                  const [nativeCurrency, homeCurrency] =
                    mapping.sourceKey.split("->");
                  return (
                    <form
                      className="import-mapping-form"
                      key={mapping.key}
                      onSubmit={(event) => void resolveMapping(mapping, event)}
                    >
                      <p>{mapping.message}</p>
                      <label>
                        Issue source
                        <input value={mapping.sourceKey} readOnly />
                      </label>
                      <label>
                        FX direction
                        <select name="targetValue" required defaultValue="">
                          <option value="" disabled>
                            Choose how this rate converts
                          </option>
                          <option value="native_to_home">
                            Converts {nativeCurrency ?? "native"} to{" "}
                            {homeCurrency ?? "home"} currency
                          </option>
                          <option value="home_to_native">
                            Converts {homeCurrency ?? "home"} to{" "}
                            {nativeCurrency ?? "native"} currency (invert)
                          </option>
                        </select>
                      </label>
                      <button type="submit" disabled={pending}>
                        Save mapping and refresh preview
                      </button>
                    </form>
                  );
                }
                if (mapping.kind === "portfolio") {
                  return (
                    <form
                      className="import-mapping-form"
                      key={mapping.key}
                      onSubmit={(event) => void resolveMapping(mapping, event)}
                    >
                      <p>{mapping.message}</p>
                      <label>
                        Issue source
                        <input value={mapping.sourceKey} readOnly />
                      </label>
                      <label>
                        Target portfolio
                        <select name="targetId" required defaultValue="">
                          <option value="" disabled>
                            Choose a private portfolio
                          </option>
                          {portfolios.map((portfolio) => (
                            <option value={portfolio.id} key={portfolio.id}>
                              {portfolio.name} · {portfolio.homeCurrencyCode}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="submit" disabled={pending}>
                        Save mapping and refresh preview
                      </button>
                    </form>
                  );
                }
                // Security mapping: an existing owner-private security
                // candidate that is already resolved (linked to a security --
                // provider-verified OR, since IMP-009, owner-attested; see
                // the "Owner-attested identity" label appended to its option
                // below) is one valid target -- committing against an
                // unresolved candidate is never allowed (AGENTS.md: a
                // ticker is not a durable security ID). A brand-new symbol
                // that matches no existing resolved candidate cannot be
                // published as a canonical security from a user decision
                // here (`securities` is a shared master writable only
                // through the server-verified path in
                // `security-verification-service.ts`, or the owner-attested
                // path in `security-attestation-service.ts`); instead this
                // offers a request for server-side verification against the
                // configured market-data provider (IMP-004B) or manual
                // resolution (IMP-009).
                const [portfolioId] = mapping.sourceKey.split("|");
                const candidates = review.securityCandidates.filter(
                  (candidate) =>
                    candidate.portfolioId === portfolioId &&
                    candidate.securityId !== null,
                );
                const unresolvedCandidate =
                  review.preview.unresolvedCandidates.find(
                    (candidate) =>
                      candidate.portfolioId === portfolioId &&
                      candidate.securityId === null &&
                      [
                        candidate.portfolioId,
                        normalizedKeyPart(candidate.sourceSymbol),
                        normalizedKeyPart(candidate.sourceExchangeAlias ?? ""),
                        normalizedKeyPart(candidate.sourceCurrencyCode),
                      ].join("|") === mapping.sourceKey,
                  );
                // IMP-008 review finding B4: the ruling's exact copy is
                // "Skip N rows referencing SYMBOL" -- every row currently
                // blocked by this candidate carries its own
                // `SECURITY_MAPPING_REQUIRED` issue with this candidate's
                // `sourceKey` (see `rowsBlockedBySecurityCandidate` in
                // `app/import-row-exclusion-service.ts`, which counts the
                // SAME way server-side when resolving the exclude target).
                const blockedRowCount = review.preview.issues.filter(
                  (issue) =>
                    issue.code === "SECURITY_MAPPING_REQUIRED" &&
                    issue.sourceKey === mapping.sourceKey,
                ).length;
                return (
                  <div className="import-mapping-form" key={mapping.key}>
                    <p>{mapping.message}</p>
                    <p>
                      Issue source: <code>{mapping.sourceKey}</code>
                    </p>
                    {candidates.length > 0 ? (
                      <form
                        onSubmit={(event) =>
                          void resolveMapping(mapping, event)
                        }
                      >
                        <label>
                          Target security candidate
                          <select name="targetId" required defaultValue="">
                            <option value="" disabled>
                              Choose an existing resolved candidate
                            </option>
                            {candidates.map((candidate) => (
                              <option value={candidate.id} key={candidate.id}>
                                {candidate.sourceSymbol} ·{" "}
                                {candidate.sourceCurrencyCode} · {candidate.id}
                                {candidate.securityId &&
                                (review.attestedSecurityIds ?? []).includes(
                                  candidate.securityId,
                                )
                                  ? " · Owner-attested identity; market data unavailable until provider-verified"
                                  : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button type="submit" disabled={pending}>
                          Save mapping and refresh preview
                        </button>
                      </form>
                    ) : null}
                    {unresolvedCandidate ? (
                      <form
                        onSubmit={(event) =>
                          void verifySecurityCandidate(
                            unresolvedCandidate,
                            event,
                          )
                        }
                      >
                        <p>
                          Request server-side verification of{" "}
                          <strong>{unresolvedCandidate.sourceSymbol}</strong>
                          {unresolvedCandidate.sourceExchangeAlias
                            ? ` on ${unresolvedCandidate.sourceExchangeAlias}`
                            : ""}{" "}
                          ({unresolvedCandidate.sourceCurrencyCode}) against the
                          configured market-data provider. A successful,
                          currency- and exchange-agreeing match publishes a
                          verified security record and links this candidate; a
                          mismatch or unavailable provider leaves it unresolved
                          and private.
                        </p>
                        <button type="submit" disabled={pending}>
                          {pending
                            ? "Verifying…"
                            : "Verify with market-data provider"}
                        </button>
                      </form>
                    ) : null}
                    {unresolvedCandidate ? (
                      // IMP-009: manual resolution for when the provider is
                      // unavailable, or the ticker is delisted and can never
                      // be provider-verified.
                      <button
                        type="button"
                        onClick={(event) =>
                          openAttestationDialog(event, {
                            portfolioId: unresolvedCandidate.portfolioId,
                            sourceSymbol: unresolvedCandidate.sourceSymbol,
                            sourceExchangeAlias:
                              unresolvedCandidate.sourceExchangeAlias,
                            sourceCurrencyCode:
                              unresolvedCandidate.sourceCurrencyCode,
                          })
                        }
                      >
                        Resolve manually
                      </button>
                    ) : null}
                    {unresolvedCandidate ? (
                      <button
                        type="button"
                        onClick={(event) =>
                          openExclusionDialog(
                            event,
                            "exclude",
                            {
                              kind: "securityCandidate",
                              portfolioId: unresolvedCandidate.portfolioId,
                              sourceSymbol: unresolvedCandidate.sourceSymbol,
                              sourceExchangeAlias:
                                unresolvedCandidate.sourceExchangeAlias,
                              sourceCurrencyCode:
                                unresolvedCandidate.sourceCurrencyCode,
                            },
                            `Skip ${blockedRowCount} row${blockedRowCount === 1 ? "" : "s"} referencing ${unresolvedCandidate.sourceSymbol} -- they will not be committed. Skipped rows are absent from holdings, gains, and income until you include them again.`,
                          )
                        }
                      >
                        Skip {blockedRowCount} row
                        {blockedRowCount === 1 ? "" : "s"} referencing{" "}
                        {unresolvedCandidate.sourceSymbol}
                      </button>
                    ) : null}
                    {candidates.length === 0 && !unresolvedCandidate ? (
                      <p role="note">
                        No existing resolved security in this portfolio matches
                        yet, and this symbol could not be prepared for
                        verification. Refresh the preview and try again.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ) : null}

          {/* UI-013: hidden entirely for a `sharesight_sync` batch -- Accept
              Import (above) is the ONE path for these batches, including
              marking ready; see `isSharesightSyncBatch`'s definition for why
              a second, legacy "Mark ready" affordance would recreate the
              exact two-buttons confusion the owner reported. */}
          {!isSharesightSyncBatch &&
          (review.batch.status === "parsed" ||
            review.batch.status === "needs_mapping") ? (
            <section
              className="import-commit-panel"
              aria-labelledby="ready-title"
            >
              <p className="eyebrow">Readiness</p>
              <h3 id="ready-title">Mark this import ready</h3>
              <p>
                {review.preview.ready
                  ? "All required mappings are resolved and no blocking issues remain. Marking this import ready unlocks the explicit commit step below."
                  : "Resolve every blocking issue and required mapping above before this import can be marked ready."}
              </p>
              <button
                type="button"
                onClick={() => void markReady()}
                disabled={!review.preview.ready || readyPending}
                aria-busy={readyPending || undefined}
              >
                {readyPending ? "Marking ready…" : "Mark import ready"}
              </button>
            </section>
          ) : null}

          {/* UI-013: `committed` deliberately dropped from this gate (the
              committed status line above replaces this panel entirely --
              see `isCommittedOrReversed`) and, for a `sharesight_sync`
              batch, the whole panel is hidden regardless of status -- see
              the comment on the readiness panel just above. */}
          {!isSharesightSyncBatch &&
          !isCommittedOrReversed &&
          (review.batch.status === "ready" ||
            review.batch.status === "committing") ? (
            <section
              className="import-commit-panel"
              aria-labelledby="commit-title"
            >
              <p className="eyebrow">Financial commit</p>
              <h3 id="commit-title">Commit this reviewed preview</h3>
              <p>
                This action creates the reviewed ledger effects. The server will
                revalidate preview version <code>{review.previewVersion}</code>
                before changing any financial facts.
              </p>
              <label className="import-confirmation">
                <input
                  type="checkbox"
                  checked={commitConfirmed}
                  onChange={(event) => setCommitConfirmed(event.target.checked)}
                  disabled={
                    commitPending || reviewCommit?.status === "committed"
                  }
                />
                I confirm this exact reviewed preview and its mappings.
              </label>
              <button
                type="button"
                onClick={commitImport}
                disabled={
                  !commitConfirmed ||
                  commitPending ||
                  reviewCommit?.status === "committed"
                }
                aria-busy={commitPending || undefined}
              >
                {commitPending
                  ? "Submitting commit…"
                  : reviewCommit?.status === "committing"
                    ? "Resume commit"
                    : reviewCommit?.status === "committed"
                      ? "Commit complete"
                      : "Commit reviewed import"}
              </button>
              {reviewCommit ? (
                <p
                  className={
                    reviewCommit.status === "committed"
                      ? "import-commit-status complete"
                      : "import-commit-status resumable"
                  }
                  role="status"
                >
                  {reviewCommit.status === "committed"
                    ? `Committed ${reviewCommit.committedRows} row effects; ${reviewCommit.skippedRows} rows were skipped (${reviewCommit.excludedByOwnerRows} excluded by owner).`
                    : `Commit is resumable after physical row ${reviewCommit.highWaterRow}. It is not complete.`}
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="import-issues" aria-labelledby="issues-title">
            <h3 id="issues-title">Row and field issues</h3>
            {review.preview.issues.length === 0 ? (
              <p>No reconciliation issues were found.</p>
            ) : (
              <ul>
                {review.preview.issues.map((issue, index) => {
                  // UI-014 part 3: the row this warning/issue is actually
                  // ABOUT -- server-derived, bounded to rows an issue
                  // references (see `app/import-preview.ts`'s
                  // `rowSummaries`). Absent for a batch-level issue (no
                  // `rowId`) or a pre-UI-014 test fixture omitting the
                  // field; renders nothing extra either way.
                  const summary = issue.rowId
                    ? review.rowSummaries?.[issue.rowId]
                    : undefined;
                  return (
                    <li
                      key={`${issue.rowId ?? "batch"}-${issue.code}-${index}`}
                    >
                      <strong>{issue.code}</strong>
                      <span>
                        {issue.physicalRowNumber
                          ? `Row ${issue.physicalRowNumber}: `
                          : ""}
                        {issue.message}
                      </span>
                      {summary ? (
                        <span className="import-issue-row-facts">
                          {rowFactsText(summary)}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* IMP-008: persisted, row-linked, unresolved error issues (e.g.
              SHARESIGHT_PAYOUT_KEY_COLLISION) -- distinct from the
              reconciliation-computed `preview.issues` above, and the only
              place these are otherwise visible before the batch reaches
              import history. Skipping the row removes it from this list
              (and, once every remaining blocking row/issue is likewise
              excluded, unblocks readiness -- see
              `app/import-row-exclusion-service.ts`). */}
          <section
            className="import-issues"
            aria-labelledby="blocked-rows-title"
          >
            <h3 id="blocked-rows-title">Blocked rows</h3>
            {blockedRowIssues.length === 0 ? (
              <p>No blocking row issues were found.</p>
            ) : (
              <ul>
                {blockedRowIssues.map((issue) => {
                  // UI-014 part 3: see the identical lookup's comment above.
                  const summary = issue.rowId
                    ? review.rowSummaries?.[issue.rowId]
                    : undefined;
                  return (
                    <li key={issue.id}>
                      <strong>{issue.code}</strong>
                      <span>
                        {issue.physicalRowNumber
                          ? `Row ${issue.physicalRowNumber}: `
                          : ""}
                        {issue.message}
                      </span>
                      {summary ? (
                        <span className="import-issue-row-facts">
                          {rowFactsText(summary)}
                        </span>
                      ) : null}
                      {issue.rowId &&
                      isMutableExclusionStatus(review.batch.status) ? (
                        <button
                          type="button"
                          onClick={(event) =>
                            openExclusionDialog(
                              event,
                              "exclude",
                              { kind: "issue", issueId: issue.id },
                              `Skip this row -- it will not be committed. Skipped rows are absent from holdings, gains, and income until you include them again.`,
                            )
                          }
                        >
                          Skip this row
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* IMP-008: rows excluded from this batch's commit visibly listed
              with an un-skip toggle, per the Orchestrator ruling. Review
              finding B2: exclusion stays mutable through `ready` (B1), but
              NOT once commit has actually started or finished (`committing`/
              `committed`/`reversing`/`reversed`/`failed`) -- the include
              button is only offered while mutation could actually succeed,
              and the consequence copy switches from future to past tense
              once the batch has left the pre-commit window, since a
              committed/failed batch's excluded rows genuinely WERE never
              committed, not merely "will not be". */}
          <section
            className="import-issues"
            aria-labelledby="excluded-rows-title"
          >
            <h3 id="excluded-rows-title">
              Excluded rows ({review.excludedRows.length})
            </h3>
            {review.excludedRows.length === 0 ? (
              <p>No rows are currently excluded from this import.</p>
            ) : (
              <ul>
                {review.excludedRows.map((row) => (
                  <li key={row.id}>
                    <span>
                      Row {row.physicalRowNumber}
                      {row.symbol ? ` (${row.symbol})` : ""}{" "}
                      {isMutableExclusionStatus(review.batch.status)
                        ? "will not be committed."
                        : "was not committed."}
                    </span>
                    {isMutableExclusionStatus(review.batch.status) ? (
                      <button
                        type="button"
                        onClick={(event) =>
                          openExclusionDialog(
                            event,
                            "include",
                            { kind: "rowIds", rowIds: [row.id] },
                            `Include row ${row.physicalRowNumber} again -- it will be committed with the rest of this reviewed preview.`,
                          )
                        }
                      >
                        Include this row again
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="import-no-commit" role="note">
            Review only until you confirm the commit above. Review evidence
            remains available after commit, and the preview does not change
            ledger, cash, security, or portfolio totals beforehand.
          </p>

          {pendingExclusion ? (
            <dialog
              ref={exclusionDialogRef}
              className="import-exclusion-dialog"
              aria-labelledby="exclusion-dialog-title"
              onCancel={(event) => {
                event.preventDefault();
                if (exclusionPending) return;
                exclusionDialogRef.current?.close();
              }}
              onClose={() => setPendingExclusion(null)}
            >
              <button
                type="button"
                className="sheet-close"
                onClick={() => {
                  if (exclusionPending) return;
                  exclusionDialogRef.current?.close();
                }}
              >
                Close
              </button>
              <p className="eyebrow" id="exclusion-dialog-title">
                {pendingExclusion.action === "exclude"
                  ? "Skip these rows?"
                  : "Include these rows again?"}
              </p>
              <p>{pendingExclusion.description}</p>
              {exclusionError ? (
                <p role="alert" className="sharesight-sync-error">
                  {exclusionError}
                </p>
              ) : null}
              <div className="dialog-actions">
                <button
                  type="button"
                  onClick={() => exclusionDialogRef.current?.close()}
                  disabled={exclusionPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void submitExclusion()}
                  disabled={exclusionPending}
                >
                  {exclusionPending
                    ? "Saving…"
                    : pendingExclusion.action === "exclude"
                      ? "Skip these rows"
                      : "Include these rows"}
                </button>
              </div>
            </dialog>
          ) : null}

          {pendingAttestation ? (
            <dialog
              ref={attestationDialogRef}
              className="import-exclusion-dialog"
              aria-labelledby="attestation-dialog-title"
              onCancel={(event) => {
                event.preventDefault();
                if (attestationPending) return;
                attestationDialogRef.current?.close();
              }}
              onClose={() => setPendingAttestation(null)}
            >
              <button
                type="button"
                className="sheet-close"
                onClick={() => {
                  if (attestationPending) return;
                  attestationDialogRef.current?.close();
                }}
              >
                Close
              </button>
              <p className="eyebrow" id="attestation-dialog-title">
                Resolve {pendingAttestation.candidate.sourceSymbol} manually?
              </p>
              <p>
                You are taking responsibility for this security&rsquo;s
                identity. No market data -- prices, dividends, or corporate
                actions -- will be fetched or displayed for it until it is later
                verified against the market-data provider. Owner-attested
                identity; market data unavailable until provider-verified.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitAttestation();
                }}
              >
                <label>
                  Display name
                  <input
                    value={pendingAttestation.displayName}
                    onChange={(event) =>
                      setPendingAttestation((current) =>
                        current
                          ? { ...current, displayName: event.target.value }
                          : current,
                      )
                    }
                    required
                    disabled={attestationPending}
                  />
                </label>
                {attestationError ? (
                  <p role="alert" className="sharesight-sync-error">
                    {attestationError}
                  </p>
                ) : null}
                <div className="dialog-actions">
                  <button
                    type="button"
                    onClick={() => attestationDialogRef.current?.close()}
                    disabled={attestationPending}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={attestationPending}>
                    {attestationPending ? "Resolving…" : "Resolve manually"}
                  </button>
                </div>
              </form>
            </dialog>
          ) : null}

          {acceptDialogOpen && review ? (
            <dialog
              ref={acceptDialogRef}
              className="import-exclusion-dialog"
              aria-labelledby="accept-dialog-title"
              onCancel={(event) => {
                event.preventDefault();
                if (acceptPending) return;
                acceptDialogRef.current?.close();
              }}
              onClose={() => setAcceptDialogOpen(false)}
            >
              <button
                type="button"
                className="sheet-close"
                onClick={() => {
                  if (acceptPending) return;
                  acceptDialogRef.current?.close();
                }}
              >
                Close
              </button>
              <p className="eyebrow" id="accept-dialog-title">
                Accept this import?
              </p>
              <p>
                Accepting commits {review.preview.counts.transactionCreates}{" "}
                transaction row
                {review.preview.counts.transactionCreates === 1
                  ? ""
                  : "s"} and {review.preview.counts.dividendCreates} dividend
                row
                {review.preview.counts.dividendCreates === 1
                  ? ""
                  : "s"} into {acceptTargetPortfolioName}. This creates the
                reviewed ledger effects; it cannot be undone from this screen,
                only reversed afterward from import history.
              </p>
              {acceptError ? (
                <p role="alert" className="sharesight-sync-error">
                  {acceptError}
                </p>
              ) : null}
              <div className="dialog-actions">
                <button
                  type="button"
                  onClick={() => acceptDialogRef.current?.close()}
                  disabled={acceptPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void submitAccept()}
                  disabled={acceptPending}
                  aria-busy={acceptPending || undefined}
                >
                  {acceptPending
                    ? acceptProgress
                      ? `Committing… ${acceptProgress.processed} of ${acceptProgress.total} rows`
                      : "Accepting…"
                    : "Accept Import"}
                </button>
              </div>
            </dialog>
          ) : null}
        </section>
      ) : null}

      <section className="import-history" aria-labelledby="history-title">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Private provenance</p>
            <h2 id="history-title">Import history</h2>
          </div>
          <button
            type="button"
            className="history-refresh"
            onClick={() => void loadHistory()}
            disabled={historyPending}
          >
            {historyPending ? "Loading…" : "Refresh history"}
          </button>
        </div>
        {history.length === 0 && !historyPending ? (
          <p>No import batches are recorded for this account.</p>
        ) : (
          <ul className="import-history-list">
            {history.map((batch) => (
              <li key={batch.id}>
                <button
                  type="button"
                  aria-pressed={historyDetail?.batch.id === batch.id}
                  onClick={() => void loadHistoryDetail(batch.id)}
                >
                  <strong>{batch.filename}</strong>
                  <span>
                    {statusLabel(batch.status)} ·{" "}
                    {businessDate(batch.createdAt)} · {batch.totalRows} rows
                  </span>
                </button>
                {isResumableReviewStatus(batch.status) ? (
                  <button
                    type="button"
                    className="history-open-review"
                    onClick={() => resumeReviewFromHistory(batch.id)}
                    disabled={pending}
                  >
                    Open review
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {historyDetail ? (
        <ImportHistoryDetailPanel
          key={`${historyDetail.batch.id}:${historyDetail.batch.version}`}
          detail={historyDetail}
          pending={historyPending || commitPending}
          onLoadMore={() => {
            if (historyDetail.pagination.nextOffset !== null) {
              void loadHistoryDetail(
                historyDetail.batch.id,
                historyDetail.pagination.nextOffset,
              );
            }
          }}
          onResume={() => void resumeHistoryCommit()}
          onResumeReview={(batchId) => resumeReviewFromHistory(batchId)}
          reversal={reversal}
          reversalPending={reversalPending}
          reversalRetryAvailable={reversalKey !== null}
          successorPending={successorPending}
          onReverse={(expectedVersion) =>
            void reverseHistoryImport(expectedVersion)
          }
          onOpenSuccessor={(batchId) => void loadHistoryDetail(batchId)}
          onStageSuccessor={(file) => void stageCorrectedSuccessor(file)}
        />
      ) : null}
    </main>
  );
}
