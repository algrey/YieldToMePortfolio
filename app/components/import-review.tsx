"use client";

import { useState } from "react";
import { useEffect } from "react";
import type { ImportHistoryDetail } from "../import-history-service.ts";
import type { ImportReversalActionResult } from "../import-reversal-service.ts";
import { ImportHistoryDetailPanel } from "./import-history-detail.tsx";

type PortfolioOption = { id: string; name: string; homeCurrencyCode: string };
type Review = {
  batch: {
    id: string;
    filename: string;
    status: string;
    version: number;
    targetPortfolioId: string | null;
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
  rebuildJobId: string | null;
};

function businessDate(value: string): string {
  return value.slice(0, 10);
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
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
}: {
  portfolios: PortfolioOption[];
}) {
  const [targetPortfolioId, setTargetPortfolioId] = useState(
    portfolios[0]?.id ?? "",
  );
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

  useEffect(() => {
    void loadHistory();
  }, []);

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

  return (
    <main className="import-review-page">
      <p className="eyebrow">Import review</p>
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
        >
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Server-issued preview</p>
              <h2 id="review-title">{review.batch.filename}</h2>
            </div>
            <span
              className={
                review.preview.ready ? "status-ready" : "status-blocked"
              }
            >
              {review.preview.ready ? "Ready to review" : "Needs resolution"}
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
          </div>

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
                // candidate that is already resolved (linked to a verified
                // security) is one valid target -- committing against an
                // unresolved candidate is never allowed (AGENTS.md: a
                // ticker is not a durable security ID). A brand-new symbol
                // that matches no existing resolved candidate cannot be
                // published as a canonical security from a user decision
                // here (`securities` is a shared master writable only
                // through the server-verified path in
                // `security-verification-service.ts`); instead this offers
                // a request for that server-side verification against the
                // configured market-data provider (IMP-004B).
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

          {review.batch.status === "parsed" ||
          review.batch.status === "needs_mapping" ? (
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
              >
                {readyPending ? "Marking ready…" : "Mark import ready"}
              </button>
            </section>
          ) : null}

          {review.batch.status === "ready" ||
          review.batch.status === "committing" ||
          review.batch.status === "committed" ? (
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
                  disabled={commitPending || commit?.status === "committed"}
                />
                I confirm this exact reviewed preview and its mappings.
              </label>
              <button
                type="button"
                onClick={commitImport}
                disabled={
                  !commitConfirmed ||
                  commitPending ||
                  commit?.status === "committed"
                }
              >
                {commitPending
                  ? "Submitting commit…"
                  : commit?.status === "committing"
                    ? "Resume commit"
                    : commit?.status === "committed"
                      ? "Commit complete"
                      : "Commit reviewed import"}
              </button>
              {commit ? (
                <p
                  className={
                    commit.status === "committed"
                      ? "import-commit-status complete"
                      : "import-commit-status resumable"
                  }
                  role="status"
                >
                  {commit.status === "committed"
                    ? `Committed ${commit.committedRows} row effects; ${commit.skippedRows} rows were skipped.`
                    : `Commit is resumable after physical row ${commit.highWaterRow}. It is not complete.`}
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
                {review.preview.issues.map((issue, index) => (
                  <li key={`${issue.rowId ?? "batch"}-${issue.code}-${index}`}>
                    <strong>{issue.code}</strong>
                    <span>
                      {issue.physicalRowNumber
                        ? `Row ${issue.physicalRowNumber}: `
                        : ""}
                      {issue.message}
                    </span>
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
