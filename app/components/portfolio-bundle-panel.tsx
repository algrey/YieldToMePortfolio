"use client";

// EXP-001 (owner-directed, TASKS.md "### EXP-001"): the import page's
// "Portfolio bundle (export / restore)" section -- a standalone sibling to
// `HistoricalDataPanel` (MKT-008's price-history backup section), following
// the SAME UI-048 conventions: one heading with Export/Restore sub-headings,
// the shared file-picker recipe (visually-hidden input + `.file-picker-button`
// sibling), and a preview-then-confirm staged flow. The browser only reads
// the uploaded file as text and `JSON.parse`s it -- the server re-validates
// everything (IMP-010B: server is the sole validation authority).
import { useState } from "react";

const FETCH_TIMEOUT_MS = 20_000;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchJson<T>(
  input: string,
  init?: RequestInit,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const result = (await response.json()) as
      ({ ok: true } & Record<string, unknown>) | { ok: false; message: string };
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, value: result as T };
  } catch (error) {
    return {
      ok: false,
      message: isAbortError(error)
        ? "The request timed out. Check your connection and retry."
        : "The request failed. Check your connection and retry.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function postJson<T>(
  input: string,
  payload: unknown,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  return fetchJson<T>(input, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

type BundlePreview = {
  idempotent: boolean;
  existingPortfolioId: string | null;
  portfolioName: string;
  portfolioCode: string;
  baseCurrencyMismatch: boolean;
  ownerHomeCurrencyCode: string;
  bundleBaseCurrencyCode: string;
  counts: {
    securities: number;
    transactions: number;
    dividendManualRecords: number;
    dividendSecurityAssumptions: number;
    dividendFyOverrides: number;
    dividendEventOverrides: number;
    dividendImportFrankingOverrides: number;
    whatifScenarios: number;
  };
};

type BundleCommitResult = {
  idempotent: boolean;
  portfolioId: string;
  portfolioName: string;
  counts: BundlePreview["counts"];
  securitiesCreated: number;
  securitiesMatched: number;
  skippedDividendEventOverrides: number;
};

export function BundlePreviewSummary({ preview }: { preview: BundlePreview }) {
  return (
    <div className="historical-data-preview" role="status">
      <p>
        <strong>{preview.portfolioName}</strong> ({preview.portfolioCode}) will
        be recreated as a new portfolio.
      </p>
      {preview.baseCurrencyMismatch ? (
        <p role="alert" className="historical-data-error">
          This bundle&rsquo;s base currency ({preview.bundleBaseCurrencyCode})
          does not match your account&rsquo;s home currency (
          {preview.ownerHomeCurrencyCode}). Change your home currency in
          Settings before importing, or the import will be rejected.
        </p>
      ) : null}
      {preview.idempotent ? (
        <p>
          This exact bundle was already imported (portfolio ID{" "}
          {preview.existingPortfolioId}). Confirming will not create a
          duplicate.
        </p>
      ) : null}
      <ul>
        <li>{preview.counts.securities} security identity record(s)</li>
        <li>{preview.counts.transactions} transaction(s)</li>
        <li>{preview.counts.dividendManualRecords} dividend record(s)</li>
        <li>
          {preview.counts.dividendSecurityAssumptions} per-security
          assumption(s)
        </li>
        <li>{preview.counts.dividendFyOverrides} FY override(s)</li>
        <li>
          {preview.counts.dividendEventOverrides} dividend event override(s)
        </li>
        <li>
          {preview.counts.dividendImportFrankingOverrides} franking override(s)
        </li>
        <li>{preview.counts.whatifScenarios} saved what-if scenario(s)</li>
      </ul>
    </div>
  );
}

export function BundlePanel({ portfolioId }: { portfolioId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BundleCommitResult | null>(null);

  async function readBundleText(): Promise<
    { ok: true; text: string } | { ok: false; message: string }
  > {
    if (!file) return { ok: false, message: "Choose a bundle file first." };
    try {
      const text = await file.text();
      JSON.parse(text);
      return { ok: true, text };
    } catch {
      return {
        ok: false,
        message: "The bundle file could not be read as JSON.",
      };
    }
  }

  async function preview_() {
    setPending(true);
    setError(null);
    setResult(null);
    const read = await readBundleText();
    if (!read.ok) {
      setPending(false);
      setError(read.message);
      setPreview(null);
      return;
    }
    const outcome = await postJson<{ preview: BundlePreview }>(
      "/api/portfolio-bundle/import/preview",
      { bundle: JSON.parse(read.text), filename: file?.name },
    );
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      setPreview(null);
      return;
    }
    setPreview(outcome.value.preview);
  }

  async function confirm() {
    setPending(true);
    setError(null);
    const read = await readBundleText();
    if (!read.ok) {
      setPending(false);
      setError(read.message);
      return;
    }
    const outcome = await postJson<{ result: BundleCommitResult }>(
      "/api/portfolio-bundle/import/commit",
      { bundle: JSON.parse(read.text), filename: file?.name },
    );
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setResult(outcome.value.result);
    setPreview(null);
    setFile(null);
  }

  return (
    <section
      className="historical-data-import"
      id="portfolio-bundle"
      aria-labelledby="portfolio-bundle-title"
    >
      <h3 id="portfolio-bundle-title">Portfolio bundle (export / restore)</h3>
      <p>
        Export this portfolio&rsquo;s transactions, dividend records,
        assumptions, and saved scenarios as one file, or restore a previously
        exported bundle into a new portfolio. Together with a price-history
        backup, this bundle can recreate the portfolio&rsquo;s full
        functionality. Historical prices and anything the app derives (capital
        gains, snapshots, value history) are not included -- see{" "}
        <a href="#historical-data-backup">the price-history backup</a> and the
        docs for what regenerates automatically.
      </p>
      <h4>Export this portfolio</h4>
      {/* File-download API route, not a Next.js page -- see
          `HistoricalDataPanel`'s identical export-link comment. */}
      <a
        className="historical-data-export-link"
        href={`/api/portfolio-bundle/${portfolioId}/export`}
      >
        Export portfolio bundle
      </a>
      <h4>Restore from a bundle</h4>
      <p>
        Restoring always creates a NEW portfolio (never overwrites an existing
        one). Undo a restore by archiving that new portfolio from Settings.
      </p>
      <label>
        Bundle JSON
        <span className="file-picker">
          <input
            type="file"
            accept=".json,application/json"
            className="file-picker-input"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setError(null);
              setResult(null);
            }}
          />
          <span className="file-picker-button">Choose bundle file…</span>
          <span className="file-picker-filename">
            {file ? file.name : "No file selected"}
          </span>
        </span>
      </label>
      <div className="historical-data-actions">
        <button
          type="button"
          onClick={() => void preview_()}
          disabled={!file || pending}
          aria-busy={pending || undefined}
        >
          {pending ? "Checking…" : "Preview"}
        </button>
        {preview ? (
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={pending || preview.baseCurrencyMismatch}
            aria-busy={pending || undefined}
          >
            {pending ? "Restoring…" : "Confirm restore"}
          </button>
        ) : null}
      </div>
      {preview ? <BundlePreviewSummary preview={preview} /> : null}
      {error ? (
        <p role="alert" className="historical-data-error">
          {error}
        </p>
      ) : null}
      {result ? (
        <p role="status" className="historical-data-result">
          {result.idempotent
            ? `This bundle was already imported as "${result.portfolioName}".`
            : `Restored "${result.portfolioName}" (${result.securitiesCreated} security identity record(s) created, ${result.securitiesMatched} matched to existing ones${result.skippedDividendEventOverrides > 0 ? `; ${result.skippedDividendEventOverrides} dividend event override(s) skipped -- the provider event no longer exists` : ""}). Cap Gains and other derived views populate once the calculation engine has run.`}
        </p>
      ) : null}
    </section>
  );
}
