"use client";

// MKT-008: the import page's "Historical Data" section -- owner-uploaded
// price-history CSV import (Intelligent Investor per-security exports),
// full backup export, and backup re-import. A standalone, self-contained
// component (mirrors `SharesightSyncPanel`'s established shape: its own
// fetch calls, its own pending/result state, mounted as a sibling section
// in `ImportReview` rather than folded into that already-large file) so
// `import-review.tsx` stays lean, per this task's own instruction.
//
// Review B2 fix (2026-08-21): the preview blocks, past-uploads list, and
// delete-confirmation copy are extracted into small presentational
// components/pure functions (`SinglePreviewSummary`, `BackupPreviewSummary`,
// `PriceUploadList`, `deleteConsequenceCopy`) so `tests/mkt-008.test.ts` can
// render each state directly with explicit props via the
// `brk-005b.test.ts` `renderComponent` pattern, exactly like
// `SharesightSyncPanel` takes `link` as a controlled prop rather than
// internal fetched state -- `HistoricalDataPanel` itself still owns the
// fetch/pending orchestration, but every RENDERED state is independently
// testable without needing a live effect to run.
//
// MKT-018B (guided flow, 2026-08-24): adds a "Download price history"
// coverage panel ABOVE the import controls below -- `docs/
// MARKET_DATA_STRATEGY.md` section 24's spike verdict is NO-GO for a
// Worker-side fetch against Intelligent Investor (robots.txt `Disallow` on
// the exact chart-data endpoint, WAF UA gate), so this panel stays
// read-only/link-only: it lists the active portfolio's zero/partial
// price-history securities (server read: `app/price-history-coverage.ts`,
// one batched owner-scoped query, fetched over HTTP below -- never imported
// directly, see `app/price-history-coverage-format.ts`'s header comment for
// why) with a guide link per ticker, and feeds the SAME existing
// single-security importer below (never a forked pipeline).
import { useEffect, useRef, useState } from "react";
import {
  coverageGapSummary,
  iiDownloadFilename,
  iiShareUrl,
  type PriceHistoryCoverageRow as ServerPriceHistoryCoverageRow,
} from "../price-history-coverage-format.ts";

const FETCH_TIMEOUT_MS = 20_000;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export type SinglePreview = {
  ticker: string;
  exchangeAlias: string;
  currencyCode: string;
  matchedSecurityId: string;
  matchedName: string;
  rowCount: number;
  malformedCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  sampleFirst: { marketDate: string; priceDecimal: string } | null;
  sampleLast: { marketDate: string; priceDecimal: string } | null;
};

const MALFORMED_REASON_LABELS: Record<string, string> = {
  wrong_column_count: "wrong column count",
  unsupported_format_version: "unsupported format version",
  unknown_provider: "unknown provider",
  invalid_symbol_or_exchange: "invalid symbol/exchange",
  invalid_currency: "invalid currency",
  invalid_date: "invalid date",
  invalid_price: "invalid price",
  invalid_observation_at: "invalid observation time",
  invalid_quote_metadata: "invalid quote metadata",
};

export type BackupPreview = {
  rowCount: number;
  malformedCount: number;
  malformedByReason: Record<string, number>;
  unresolvedRowCount: number;
  perProvider: Array<{
    providerId: string;
    securityCount: number;
    rowCount: number;
  }>;
  unresolvedSymbols: string[];
  ambiguousSymbols: string[];
  exchangeMismatchSymbols: string[];
};

export type UploadBatch = {
  id: string;
  sourceLabel: string;
  format: "single" | "backup";
  filename: string;
  rowCount: number;
  insertedRowCount: number;
  malformedRowCount: number;
  createdAt: string;
};

// MKT-018B (guided flow): `iiShareUrl`, `iiDownloadFilename`, and
// `coverageGapSummary` live in `app/price-history-coverage-format.ts` (a
// plain, DB-free `.ts` module, not this "use client" `.tsx` one, and NOT
// `app/price-history-coverage.ts` -- that file's dynamic
// `import("./portfolio-actions.ts")` would drag `cloudflare:workers` into
// the client bundle) so `tests/mkt-018b.test.ts` can import them directly
// under Node's `--experimental-strip-types` loader, which cannot import
// JSX -- mirrors `app/price-history-chart-geometry.ts`'s split from the
// UI-018 chart component. Re-exported here under the SAME name the server
// read uses so
// callers of this panel never see two divergent shapes.
export type PriceHistoryCoverageRow = ServerPriceHistoryCoverageRow;

export function PriceHistoryCoverageZeroList({
  rows,
}: {
  rows: PriceHistoryCoverageRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="historical-data-coverage-group">
      <h4>No price history yet</h4>
      <ul className="historical-data-coverage-list">
        {rows.map((row) => (
          <li key={row.portfolioSecurityId}>
            <span className="historical-data-coverage-name">
              <strong>{row.ticker}</strong> — {row.name}
            </span>
            <a
              className="historical-data-coverage-link"
              href={iiShareUrl(row.ticker)}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              Open {row.ticker} on Intelligent Investor
            </a>
            <span className="historical-data-coverage-filename">
              Expected download filename: {iiDownloadFilename(row.ticker)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PriceHistoryCoveragePartialList({
  rows,
}: {
  rows: PriceHistoryCoverageRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="historical-data-coverage-group">
      <h4>Partial price history</h4>
      <ul className="historical-data-coverage-list">
        {rows.map((row) => (
          <li key={row.portfolioSecurityId}>
            <span className="historical-data-coverage-name">
              <strong>{row.ticker}</strong> — {row.name}
            </span>
            <span>{coverageGapSummary(row)}</span>
            <a
              className="historical-data-coverage-link"
              href={iiShareUrl(row.ticker)}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              Open {row.ticker} on Intelligent Investor
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function fetchJson<T>(
  input: string,
  init?: RequestInit,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
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

export function SinglePreviewSummary({ preview }: { preview: SinglePreview }) {
  return (
    <div className="historical-data-preview" role="status">
      <p>
        Ticker <strong>{preview.ticker}</strong> matched{" "}
        <strong>{preview.matchedName}</strong> ({preview.exchangeAlias}/
        {preview.currencyCode}).
      </p>
      <p>
        {preview.rowCount} valid row(s)
        {preview.malformedCount > 0
          ? `, ${preview.malformedCount} malformed row(s) will be skipped`
          : ""}
        {preview.dateFrom && preview.dateTo
          ? ` covering ${preview.dateFrom} to ${preview.dateTo}.`
          : "."}
      </p>
      {preview.sampleFirst ? (
        <p>
          First: {preview.sampleFirst.marketDate} @{" "}
          {preview.sampleFirst.priceDecimal}. Last:{" "}
          {preview.sampleLast?.marketDate} @ {preview.sampleLast?.priceDecimal}.
        </p>
      ) : null}
      <p>
        Confirming will write these observations for {preview.matchedName},
        overwriting the price on any date already imported for this security.
      </p>
    </div>
  );
}

export function BackupPreviewSummary({ preview }: { preview: BackupPreview }) {
  const malformedReasonEntries = Object.entries(preview.malformedByReason);
  return (
    <div className="historical-data-preview" role="status">
      <p>
        {preview.rowCount} row(s) ready to restore
        {preview.malformedCount > 0
          ? `, ${preview.malformedCount} malformed row(s) will be skipped`
          : ""}
        .
      </p>
      {malformedReasonEntries.length > 0 ? (
        <ul className="historical-data-malformed-breakdown">
          {malformedReasonEntries.map(([reason, count]) => (
            <li key={reason}>
              {count} {MALFORMED_REASON_LABELS[reason] ?? reason}
            </li>
          ))}
        </ul>
      ) : null}
      <ul>
        {preview.perProvider.map((entry) => (
          <li key={entry.providerId}>
            {entry.providerId}: {entry.securityCount} security(ies),{" "}
            {entry.rowCount} row(s)
          </li>
        ))}
      </ul>
      {preview.unresolvedSymbols.length > 0 ? (
        <p>
          Not matched to a security you hold:{" "}
          {preview.unresolvedSymbols.join(", ")}
        </p>
      ) : null}
      {preview.exchangeMismatchSymbols.length > 0 ? (
        <p>{preview.exchangeMismatchSymbols.join("; ")}</p>
      ) : null}
      {preview.ambiguousSymbols.length > 0 ? (
        <p>
          Matches more than one security you hold:{" "}
          {preview.ambiguousSymbols.join(", ")}
        </p>
      ) : null}
      <p>
        Confirming will overwrite any existing observation on the same date,
        provider, and security, and preserves each row&apos;s original source.
      </p>
    </div>
  );
}

/**
 * "Row_count" (every valid row the upload contained) and "inserted_row_count"
 * (the subset it actually CREATED) can legitimately differ once an upload
 * overlays rows another upload -- or Sharesight's accretion -- already
 * created (B1). Naming both, only when they differ, keeps the list honest
 * about what a later delete of this row would actually remove.
 */
export function uploadRowCountLabel(
  batch: Pick<UploadBatch, "rowCount" | "insertedRowCount">,
): string {
  if (batch.insertedRowCount === batch.rowCount) {
    return `${batch.rowCount} row(s)`;
  }
  return `${batch.rowCount} row(s) (${batch.insertedRowCount} created, ${
    batch.rowCount - batch.insertedRowCount
  } overlaid existing rows)`;
}

/**
 * The delete dialog's content (heading + consequence copy), extracted so
 * `tests/mkt-008.test.ts` can render exactly this with an explicit `batch`
 * prop -- the interactive `<dialog>` shell (refs, showModal, cancel/confirm
 * handlers) stays in `HistoricalDataPanel` below since it depends on live
 * component state a static render cannot exercise.
 */
export function DeleteUploadDialogBody({ batch }: { batch: UploadBatch }) {
  return (
    <>
      <p className="eyebrow" id="historical-data-delete-title">
        Delete this upload
      </p>
      <p>{deleteConsequenceCopy(batch)}</p>
    </>
  );
}

/**
 * B1 fix: the delete dialog's consequence sentence. `upload_batch_id` is
 * stamped on INSERT only (never reassigned by a later overlay), so a delete
 * removes EXACTLY `insertedRowCount` observations -- values this upload
 * merely changed on rows some OTHER upload (or Sharesight) created are left
 * as this upload wrote them, never reverted (no versioned-override history
 * for market-data facts). This is the ONLY place this consequence is
 * stated, quoted verbatim rather than paraphrased at the call site so it
 * can never drift from what the write path actually does.
 */
export function deleteConsequenceCopy(
  batch: Pick<UploadBatch, "insertedRowCount">,
): string {
  const n = batch.insertedRowCount;
  return `Removes the ${n} observation${n === 1 ? "" : "s"} this upload created. Prices it changed on rows created elsewhere are not reverted.`;
}

export function PriceUploadList({
  batches,
  batchesError,
  deletePending,
  onDeleteClick,
}: {
  batches: UploadBatch[] | null;
  batchesError: string | null;
  deletePending: string | null;
  onDeleteClick: (batchId: string) => void;
}) {
  return (
    <div className="historical-data-uploads">
      <h3>Past uploads</h3>
      {batchesError ? (
        <p role="alert" className="historical-data-error">
          {batchesError}
        </p>
      ) : null}
      {batches === null ? (
        <p role="status">Loading past uploads…</p>
      ) : batches.length === 0 ? (
        <p>No uploads yet.</p>
      ) : (
        <ul className="historical-data-upload-list">
          {batches.map((batch) => (
            <li key={batch.id}>
              <span>
                {batch.filename} ({batch.format}, {batch.sourceLabel}) —{" "}
                {uploadRowCountLabel(batch)}
                {batch.malformedRowCount > 0
                  ? `, ${batch.malformedRowCount} skipped`
                  : ""}{" "}
                · {batch.createdAt}
              </span>
              <button
                type="button"
                onClick={() => onDeleteClick(batch.id)}
                disabled={deletePending === batch.id}
                aria-busy={deletePending === batch.id || undefined}
              >
                {deletePending === batch.id ? "Deleting…" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HistoricalDataPanel({ portfolioId }: { portfolioId: string }) {
  const [exchangeAlias, setExchangeAlias] = useState("ASX");
  const [currencyCode, setCurrencyCode] = useState("AUD");
  const [file, setFile] = useState<File | null>(null);
  const [sourceLabel, setSourceLabel] = useState("intelligent-investor");
  const [singlePreview, setSinglePreview] = useState<SinglePreview | null>(
    null,
  );
  const [singleError, setSingleError] = useState<string | null>(null);
  const [singlePending, setSinglePending] = useState(false);
  const [singleResult, setSingleResult] = useState<string | null>(null);

  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(
    null,
  );
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupPending, setBackupPending] = useState(false);
  const [backupResult, setBackupResult] = useState<string | null>(null);

  const [batches, setBatches] = useState<UploadBatch[] | null>(null);
  const [batchesError, setBatchesError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [coverage, setCoverage] = useState<{
    zero: PriceHistoryCoverageRow[];
    partial: PriceHistoryCoverageRow[];
  } | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  // React's own "adjusting state when a prop changes" recipe
  // (react.dev/learn/you-might-not-need-an-effect) -- calling setState
  // synchronously INSIDE an effect body triggers an extra cascading render
  // (and this codebase's lint config enforces that rule); resetting during
  // render instead, guarded by comparing against the last portfolioId this
  // panel fetched for, avoids it while still clearing stale coverage the
  // instant the owner switches the "Target portfolio" dropdown.
  const [coveragePortfolioId, setCoveragePortfolioId] = useState(portfolioId);
  if (portfolioId !== coveragePortfolioId) {
    setCoveragePortfolioId(portfolioId);
    setCoverage(null);
    setCoverageError(null);
  }

  // MKT-018B (guided flow): re-fetches whenever the owner switches the
  // import page's "Target portfolio" -- `portfolioId` here is exactly that
  // dropdown's current selection (`ImportReview`'s `targetPortfolioId`,
  // itself defaulted to `portfolios[0].id`, i.e. the owner's "active"
  // portfolio), mirroring `SharesightSyncPanel`'s per-portfolio scoping.
  useEffect(() => {
    if (!portfolioId) return;
    let cancelled = false;
    fetch(
      `/api/portfolios/${encodeURIComponent(portfolioId)}/price-history-coverage`,
      { cache: "no-store" },
    )
      .then((response) => response.json())
      .then((raw: unknown) => {
        const result = raw as
          | {
              ok: true;
              zero: PriceHistoryCoverageRow[];
              partial: PriceHistoryCoverageRow[];
            }
          | { ok: false; message: string };
        if (cancelled) return;
        if (!result.ok) {
          setCoverageError(result.message);
          return;
        }
        setCoverage({ zero: result.zero, partial: result.partial });
      })
      .catch(() => {
        if (!cancelled) {
          setCoverageError(
            "The request failed. Check your connection and retry.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [portfolioId]);

  async function loadBatches() {
    const result = await fetchJson<{ batches: UploadBatch[] }>(
      "/api/market-data/price-uploads",
      { cache: "no-store" },
    );
    if (!result.ok) {
      setBatchesError(result.message);
      return;
    }
    setBatchesError(null);
    setBatches(result.value.batches);
  }

  // Mount fetch: a `.then()` chain (not a synchronously-invoked local async
  // function) so state only ever updates from an async callback, matching
  // `account-lifecycle-controls.tsx`'s established mount-fetch shape rather
  // than calling `loadBatches()` directly (event handlers below call it
  // directly instead, which is fine -- they are not effect bodies).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/market-data/price-uploads", { cache: "no-store" })
      .then((response) => response.json())
      .then((raw: unknown) => {
        const result = raw as
          { ok: true; batches: UploadBatch[] } | { ok: false; message: string };
        if (cancelled) return;
        if (!result.ok) {
          setBatchesError(result.message);
          return;
        }
        setBatchesError(null);
        setBatches(result.batches);
      })
      .catch(() => {
        if (!cancelled) {
          setBatchesError(
            "The request failed. Check your connection and retry.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (confirmDeleteId && dialog && !dialog.open) dialog.showModal();
    if (!confirmDeleteId && dialog?.open) dialog.close();
  }, [confirmDeleteId]);

  async function previewSingle() {
    if (!file) return;
    setSinglePending(true);
    setSingleError(null);
    setSingleResult(null);
    const form = new FormData();
    form.set("file", file);
    form.set("exchangeAlias", exchangeAlias);
    form.set("currencyCode", currencyCode);
    const result = await fetchJson<{ preview: SinglePreview }>(
      "/api/market-data/price-uploads/preview",
      { method: "POST", body: form },
    );
    setSinglePending(false);
    if (!result.ok) {
      setSingleError(result.message);
      setSinglePreview(null);
      return;
    }
    setSinglePreview(result.value.preview);
  }

  async function confirmSingle() {
    if (!file || !singlePreview) return;
    setSinglePending(true);
    setSingleError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("exchangeAlias", exchangeAlias);
    form.set("currencyCode", currencyCode);
    form.set("sourceLabel", sourceLabel);
    const result = await fetchJson<{ batch: UploadBatch; written: number }>(
      "/api/market-data/price-uploads/confirm",
      { method: "POST", body: form },
    );
    setSinglePending(false);
    if (!result.ok) {
      setSingleError(result.message);
      return;
    }
    setSingleResult(
      `Imported ${result.value.written} price observation${result.value.written === 1 ? "" : "s"} for ${singlePreview.ticker} (${result.value.batch.insertedRowCount} newly created, ${result.value.written - result.value.batch.insertedRowCount} overlaid existing).`,
    );
    setSinglePreview(null);
    setFile(null);
    void loadBatches();
  }

  async function previewBackup() {
    if (!backupFile) return;
    setBackupPending(true);
    setBackupError(null);
    setBackupResult(null);
    const form = new FormData();
    form.set("file", backupFile);
    const result = await fetchJson<{ preview: BackupPreview }>(
      "/api/market-data/price-uploads/backup/preview",
      { method: "POST", body: form },
    );
    setBackupPending(false);
    if (!result.ok) {
      setBackupError(result.message);
      setBackupPreview(null);
      return;
    }
    setBackupPreview(result.value.preview);
  }

  async function confirmBackup() {
    if (!backupFile || !backupPreview) return;
    setBackupPending(true);
    setBackupError(null);
    const form = new FormData();
    form.set("file", backupFile);
    const result = await fetchJson<{
      batch: UploadBatch;
      written: number;
      unresolvedRowCount: number;
    }>("/api/market-data/price-uploads/backup/confirm", {
      method: "POST",
      body: form,
    });
    setBackupPending(false);
    if (!result.ok) {
      setBackupError(result.message);
      return;
    }
    setBackupResult(
      `Restored ${result.value.written} price observation${result.value.written === 1 ? "" : "s"} (${result.value.batch.insertedRowCount} newly created, ${result.value.written - result.value.batch.insertedRowCount} overlaid existing).` +
        (result.value.unresolvedRowCount > 0
          ? ` ${result.value.unresolvedRowCount} row(s) could not be matched to a security you hold.`
          : ""),
    );
    setBackupPreview(null);
    setBackupFile(null);
    void loadBatches();
  }

  async function deleteBatch(batchId: string) {
    setDeletePending(batchId);
    const result = await fetchJson<{ deletedObservations: number }>(
      `/api/market-data/price-uploads/${batchId}`,
      { method: "DELETE" },
    );
    setDeletePending(null);
    setConfirmDeleteId(null);
    if (!result.ok) {
      setBatchesError(result.message);
      return;
    }
    void loadBatches();
  }

  const confirmDeleteBatch =
    confirmDeleteId !== null
      ? (batches?.find((batch) => batch.id === confirmDeleteId) ?? null)
      : null;

  return (
    <section
      className="historical-data-panel"
      aria-labelledby="historical-data-title"
    >
      <p className="eyebrow">Historical Data</p>
      <h2 id="historical-data-title">Price history import</h2>
      <p>
        Import a per-security price-history CSV (Intelligent Investor export),
        export a full backup of your imported price history, or restore from a
        previously exported backup.
      </p>

      <section
        className="historical-data-coverage"
        aria-labelledby="historical-data-coverage-title"
      >
        <h3 id="historical-data-coverage-title">Download price history</h3>
        <p>
          Downloads run in your own browser via the guide — this app never
          fetches Intelligent Investor&apos;s data directly.
        </p>
        {coverageError ? (
          <p role="alert" className="historical-data-error">
            {coverageError}
          </p>
        ) : null}
        {!coverageError && coverage === null ? (
          <p role="status">Checking price-history coverage…</p>
        ) : null}
        {coverage &&
        coverage.zero.length === 0 &&
        coverage.partial.length === 0 ? (
          <p>Every held security has recorded price history.</p>
        ) : null}
        {coverage ? (
          <>
            <PriceHistoryCoverageZeroList rows={coverage.zero} />
            <PriceHistoryCoveragePartialList rows={coverage.partial} />
          </>
        ) : null}
        {coverage &&
        (coverage.zero.length > 0 || coverage.partial.length > 0) ? (
          <p>
            Download each CSV above, then{" "}
            <a href="#historical-data-single-upload">import it below</a>.
          </p>
        ) : null}
      </section>

      <div className="historical-data-settings">
        <label>
          Exchange
          <input
            value={exchangeAlias}
            onChange={(event) => setExchangeAlias(event.target.value)}
          />
        </label>
        <label>
          Currency
          <input
            value={currencyCode}
            onChange={(event) => setCurrencyCode(event.target.value)}
          />
        </label>
      </div>

      <div
        className="historical-data-import"
        id="historical-data-single-upload"
      >
        <h3>Import single security</h3>
        <label>
          Price history CSV
          <input
            type="file"
            accept=".csv,text/csv,text/tab-separated-values"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setSinglePreview(null);
              setSingleError(null);
              setSingleResult(null);
            }}
          />
        </label>
        <label>
          Source label
          <input
            value={sourceLabel}
            onChange={(event) => setSourceLabel(event.target.value)}
          />
        </label>
        <div className="historical-data-actions">
          <button
            type="button"
            onClick={() => void previewSingle()}
            disabled={!file || singlePending}
            aria-busy={singlePending || undefined}
          >
            {singlePending ? "Checking…" : "Preview"}
          </button>
          {singlePreview ? (
            <button
              type="button"
              onClick={() => void confirmSingle()}
              disabled={singlePending}
              aria-busy={singlePending || undefined}
            >
              {singlePending ? "Importing…" : "Confirm import"}
            </button>
          ) : null}
        </div>
        {singlePreview ? (
          <SinglePreviewSummary preview={singlePreview} />
        ) : null}
        {singleError ? (
          <p role="alert" className="historical-data-error">
            {singleError}
          </p>
        ) : null}
        {singleResult ? (
          <p role="status" className="historical-data-result">
            {singleResult}
          </p>
        ) : null}
      </div>

      <div className="historical-data-import">
        <h3>Import backup</h3>
        <label>
          Backup CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              setBackupFile(event.target.files?.[0] ?? null);
              setBackupPreview(null);
              setBackupError(null);
              setBackupResult(null);
            }}
          />
        </label>
        <div className="historical-data-actions">
          <button
            type="button"
            onClick={() => void previewBackup()}
            disabled={!backupFile || backupPending}
            aria-busy={backupPending || undefined}
          >
            {backupPending ? "Checking…" : "Preview"}
          </button>
          {backupPreview ? (
            <button
              type="button"
              onClick={() => void confirmBackup()}
              disabled={backupPending}
              aria-busy={backupPending || undefined}
            >
              {backupPending ? "Restoring…" : "Confirm restore"}
            </button>
          ) : null}
        </div>
        {backupPreview ? (
          <BackupPreviewSummary preview={backupPreview} />
        ) : null}
        {backupError ? (
          <p role="alert" className="historical-data-error">
            {backupError}
          </p>
        ) : null}
        {backupResult ? (
          <p role="status" className="historical-data-result">
            {backupResult}
          </p>
        ) : null}
      </div>

      <div className="historical-data-import">
        <h3>Export</h3>
        <p>
          Download a full, re-importable backup of your imported price history.
        </p>
        {/* This targets a file-download API route (text/csv,
            content-disposition: attachment), not a Next.js page -- a plain
            anchor triggers the browser's normal download handling; `next/link`
            would instead try to client-navigate/prefetch it as an app route. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          className="historical-data-export-link"
          href="/api/market-data/price-uploads/export"
        >
          Export price history
        </a>
      </div>

      <PriceUploadList
        batches={batches}
        batchesError={batchesError}
        deletePending={deletePending}
        onDeleteClick={(batchId) => setConfirmDeleteId(batchId)}
      />

      {confirmDeleteId && confirmDeleteBatch ? (
        <dialog
          ref={dialogRef}
          className="historical-data-dialog"
          aria-labelledby="historical-data-delete-title"
          onCancel={(event) => {
            event.preventDefault();
            if (deletePending) return;
            setConfirmDeleteId(null);
          }}
          onClose={() => setConfirmDeleteId(null)}
        >
          <DeleteUploadDialogBody batch={confirmDeleteBatch} />
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() => setConfirmDeleteId(null)}
              disabled={deletePending !== null}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() =>
                confirmDeleteId && void deleteBatch(confirmDeleteId)
              }
              disabled={deletePending !== null}
              aria-busy={deletePending !== null || undefined}
            >
              {deletePending ? "Deleting…" : "Delete upload"}
            </button>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
