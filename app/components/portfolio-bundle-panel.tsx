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

// Thousands-separated integer for the preview count cells. Deliberately a
// plain digit-grouping replace rather than `Intl`/`toLocaleString`: this is
// a "use client" component and locale-data formatting is not hydration-safe
// (see `app/date-display.ts`'s BUG-003 note).
function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function BundlePreviewSummary({ preview }: { preview: BundlePreview }) {
  return (
    <div className="backup-preview" role="status">
      <p className="backup-preview-headline">
        <strong>{preview.portfolioName}</strong>{" "}
        <span className="backup-portfolio-row-code">
          {preview.portfolioCode}
        </span>{" "}
        <span className="backup-preview-muted">
          will be recreated as a new portfolio.
        </span>
      </p>
      {preview.baseCurrencyMismatch ? (
        <div className="status-banner warning" role="alert">
          <span className="status-symbol">!</span>
          <p>
            This bundle&rsquo;s base currency ({preview.bundleBaseCurrencyCode})
            does not match your account&rsquo;s home currency (
            {preview.ownerHomeCurrencyCode}). Change your home currency in
            Settings before importing, or the import will be rejected.
          </p>
        </div>
      ) : null}
      {preview.idempotent ? (
        <p className="backup-note">
          This exact bundle was already imported (portfolio ID{" "}
          {preview.existingPortfolioId}). Confirming will not create a
          duplicate.
        </p>
      ) : null}
      <div className="count-grid four">
        <div className="count-cell">
          <p className="count-value">
            {formatCount(preview.counts.securities)}
          </p>
          <p className="count-label">security identity records</p>
        </div>
        <div className="count-cell">
          <p className="count-value">
            {formatCount(preview.counts.transactions)}
          </p>
          <p className="count-label">transactions</p>
        </div>
        <div className="count-cell">
          <p className="count-value">
            {formatCount(preview.counts.dividendManualRecords)}
          </p>
          <p className="count-label">dividend records</p>
        </div>
        <div className="count-cell">
          <p className="count-value">
            {formatCount(preview.counts.whatifScenarios)}
          </p>
          <p className="count-label">saved what-if scenarios</p>
        </div>
      </div>
      <dl className="backup-facts">
        <dt>Overrides</dt>
        <dd>
          {preview.counts.dividendSecurityAssumptions} per-security assumptions
          · {preview.counts.dividendFyOverrides} FY overrides ·{" "}
          {preview.counts.dividendEventOverrides} dividend event overrides ·{" "}
          {preview.counts.dividendImportFrankingOverrides} franking overrides
        </dd>
      </dl>
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
      className="backup-card"
      id="portfolio-bundle"
      aria-labelledby="portfolio-bundle-title"
    >
      <div className="backup-card-header">
        <div className="backup-card-title">
          <p className="eyebrow">This portfolio</p>
          <h3 id="portfolio-bundle-title">
            Portfolio bundle (export / restore)
          </h3>
        </div>
        <p className="backup-card-blurb">
          Export this portfolio&rsquo;s transactions, dividend records,
          assumptions, and saved scenarios as one file, or restore a previously
          exported bundle into a new portfolio. Together with a price-history
          backup, this bundle can recreate the portfolio&rsquo;s full
          functionality. Historical prices and anything the app derives (capital
          gains, snapshots, value history) are not included -- see{" "}
          <a href="#historical-data-backup">the price-history backup</a> and the
          docs for what regenerates automatically.
        </p>
      </div>
      <div className="backup-card-split">
        <div className="backup-export">
          <h4>Export this portfolio</h4>
          {/* File-download API route, not a Next.js page -- see
              `HistoricalDataPanel`'s identical export-link comment. */}
          <a
            className="backup-export-button"
            href={`/api/portfolio-bundle/${portfolioId}/export`}
          >
            Export portfolio bundle
          </a>
        </div>
        <div className="backup-restore">
          <h4>Restore from a bundle</h4>
          <p className="backup-copy">
            Restoring always creates a NEW portfolio (never overwrites an
            existing one). Undo a restore by archiving that new portfolio from
            Settings.
          </p>
          <label className="file-drop">
            <span className="visually-hidden">Bundle JSON</span>
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
          <div className="backup-actions">
            <button
              type="button"
              className="backup-secondary-button"
              onClick={() => void preview_()}
              disabled={!file || pending}
              aria-busy={pending || undefined}
            >
              {pending ? "Checking…" : "Preview"}
            </button>
            {preview ? (
              <button
                type="button"
                className="backup-confirm-button"
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
        </div>
      </div>
    </section>
  );
}
