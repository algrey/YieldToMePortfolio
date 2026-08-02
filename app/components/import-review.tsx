"use client";

import { useState } from "react";

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
};

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

  async function saveMapping(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/import/preview/${review.batch.id}/mappings`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: String(form.get("kind")),
            scope: "batch",
            confidence: "user",
            sourceKey: String(form.get("sourceKey")),
            normalizedSourceValue: String(form.get("normalizedSourceValue")),
            targetId: String(form.get("targetId")),
            targetValue: null,
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

  const firstMappingIssue = review?.preview.issues.find(
    (issue) =>
      issue.code === "SECURITY_MAPPING_REQUIRED" ||
      issue.code === "SECURITY_MAPPING_AMBIGUOUS" ||
      issue.code === "PORTFOLIO_MAPPING_REQUIRED",
  );
  const mappingKind = firstMappingIssue?.code.startsWith("PORTFOLIO")
    ? "portfolio"
    : "security";

  return (
    <main className="import-review-page">
      <p className="eyebrow">Import review</p>
      <h1>Preview a CSV import</h1>
      <p className="import-intro">
        Upload, inspect, and resolve issues before any financial facts can be
        created. This screen has no commit action.
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
          {message}
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
            <span>{review.preview.counts.candidateCreates} new candidates</span>
            <span>{review.preview.counts.skips} skipped</span>
            <span>{review.preview.counts.unresolved} unresolved</span>
          </div>

          {firstMappingIssue ? (
            <form className="import-mapping-form" onSubmit={saveMapping}>
              <h3>Resolve a mapping</h3>
              <input type="hidden" name="kind" value={mappingKind} />
              <input
                type="hidden"
                name="sourceKey"
                value={firstMappingIssue.sourceKey ?? ""}
              />
              <input
                type="hidden"
                name="normalizedSourceValue"
                value={firstMappingIssue.sourceKey ?? ""}
              />
              <label>
                Issue source
                <input
                  value={firstMappingIssue.sourceKey ?? "Not provided"}
                  readOnly
                />
              </label>
              <label>
                {mappingKind === "portfolio"
                  ? "Target portfolio"
                  : "Target security candidate"}
                <select name="targetId" required defaultValue="">
                  <option value="" disabled>
                    Choose a private{" "}
                    {mappingKind === "portfolio" ? "portfolio" : "candidate"}
                  </option>
                  {mappingKind === "portfolio"
                    ? portfolios.map((portfolio) => (
                        <option value={portfolio.id} key={portfolio.id}>
                          {portfolio.name} · {portfolio.homeCurrencyCode}
                        </option>
                      ))
                    : review.preview.unresolvedCandidates.map((candidate) => (
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
            Review only. No ledger, cash, security, or portfolio totals are
            changed here.
          </p>
        </section>
      ) : null}
    </main>
  );
}
