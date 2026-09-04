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
import {
  runMultiFilePriceUpload,
  type MultiFileConfirmResult,
  type MultiFileDecision,
  type MultiFilePreviewResult,
  type MultiFileStepResult,
} from "../multi-file-price-upload.ts";
// IMP-010A: the SAME pure parsers `app/price-upload-service.ts` used to run
// server-side over raw upload bytes now run HERE, in the browser -- moving
// the CPU-heavy text decode/split/row-classify work off the Worker (see
// that file's IMP-010A header note and `docs/ARCHITECTURE.md`'s decision
// entry). Both modules import only `./text-encoding.ts` (no server/DB/
// Node-only dependency), so they are safe in this "use client" bundle.
// This is the ONLY place either parser is now invoked from a real (not
// hostile-payload) upload -- the server re-validates every field of every
// row it receives regardless (`validateUploadedPriceCsvPayload`/
// `validateUploadedPriceBackupPayload`), never trusting client output.
import {
  DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR,
  DEFAULT_PRICE_CSV_LIMITS,
  downsamplePriceCsvRows,
  filterRowsAlreadyPresent,
  parsePriceCsv,
  type PriceCsvExistingObservation,
} from "../../domain/market-data/price-csv.ts";
import {
  DEFAULT_PRICE_BACKUP_LIMITS,
  parsePriceBackupCsv,
} from "../../domain/market-data/price-backup-csv.ts";

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
  // EFF-001 (measure 2): the server's own read of this security's existing
  // owner-import (date, price) observations, plus how many of THIS file's
  // rows are EXACT (date, price) duplicates of one of those --
  // `existingObservations` is also what `confirmSingle`/`multiConfirmFile`
  // filter the upload payload against before sending. Review B1 fix:
  // comparing VALUE (not just date) means a CORRECTED price for an
  // already-covered date is never silently dropped.
  existingObservations: PriceCsvExistingObservation[];
  identicalCount: number;
  /** Review B2: the explicit "X row(s) will be written" figure. */
  rowsToWriteCount: number;
  // EFF-001 (measures 4/5): LOCAL-only stats the browser computed during
  // parsing -- never round-tripped through the server (it never sees the
  // rows these counts describe, since they are dropped before upload).
  noDataOmittedCount: number;
  downsampleApplied: boolean;
  downsampleBoundaryYear: number;
  preDownsampleRowCount: number;
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
            <div className="coverage-row">
              <strong className="coverage-ticker">{row.ticker}</strong>
              <span className="historical-data-coverage-name">{row.name}</span>
              <span className="coverage-status coverage-status-missing">
                no history
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
            </div>
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
            <div className="coverage-row">
              <strong className="coverage-ticker">{row.ticker}</strong>
              <span className="historical-data-coverage-name">{row.name}</span>
              <a
                className="historical-data-coverage-link"
                href={iiShareUrl(row.ticker)}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                Open {row.ticker} on Intelligent Investor
              </a>
            </div>
            <span className="coverage-status">{coverageGapSummary(row)}</span>
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

type ClientSingleUploadPayload = {
  ticker: string;
  rows: { marketDate: string; priceDecimal: string }[];
  malformedCount: number;
};

type ClientBackupUploadPayload = {
  rows: Array<{
    providerId: string;
    sourceLabel: string;
    providerSymbol: string;
    providerExchange: string;
    currencyCode: string;
    marketDate: string;
    priceDecimal: string;
    observationAt: string;
    marketTimezone: string;
    interval: string;
    quality: string;
    adjustmentState: string;
    delayedMinutes: number | null;
  }>;
  malformedByReason: Record<string, number>;
};

export type DownsampleSettings = { enabled: boolean; boundaryYear: number };

/**
 * IMP-010A: runs the shared `parsePriceCsv` (imported above) on `file`
 * directly in the browser -- the CPU-heavy decode/split/row-classify work
 * this module's header note describes. A parse failure (bad encoding,
 * missing header, invalid ticker, over the 2 MiB/20k-row budget) is
 * reported with the SAME message text the server used to return for the
 * identical failure, just without a network round trip.
 *
 * EFF-001 (measures 4/5): the parser's own `malformed` list already
 * separates `"no_data"` (blank/zero price cells) from genuine malformed
 * reasons -- `noDataOmittedCount` is that count, kept OUT of the
 * `malformedCount` sent to the server so that field's meaning (rows that
 * failed grammar validation) stays unchanged. `downsamplePriceCsvRows` then
 * reduces pre-boundary rows to one per calendar month when `downsample.enabled`.
 * Both are LOCAL-only reductions -- the server never sees the dropped rows
 * and never re-derives or enforces either choice (see that function's own
 * header comment).
 */
async function parseSingleCsvFile(
  file: File,
  downsample: DownsampleSettings,
): Promise<
  | {
      ok: true;
      payload: ClientSingleUploadPayload;
      noDataOmittedCount: number;
      preDownsampleRowCount: number;
      downsampleApplied: boolean;
    }
  | { ok: false; message: string }
> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // MKT-020: `file.name` is passed through for the OHLCV variant's
  // filename-derived ticker (`ASX-<TICKER>.csv`) -- inert for the original
  // format, whose ticker still comes from the CSV header.
  const parsed = parsePriceCsv(bytes, DEFAULT_PRICE_CSV_LIMITS, file.name);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const noDataOmittedCount = parsed.malformed.filter(
    (row) => row.reason === "no_data",
  ).length;
  const trueMalformedCount = parsed.malformed.length - noDataOmittedCount;
  const preDownsampleRowCount = parsed.rows.length;
  const downsampled = downsample.enabled
    ? downsamplePriceCsvRows(parsed.rows, {
        boundaryYear: downsample.boundaryYear,
      })
    : { rows: parsed.rows, droppedCount: 0 };
  return {
    ok: true,
    payload: {
      ticker: parsed.ticker,
      rows: downsampled.rows.map((row) => ({
        marketDate: row.marketDate,
        priceDecimal: row.priceDecimal,
      })),
      malformedCount: trueMalformedCount,
    },
    noDataOmittedCount,
    preDownsampleRowCount,
    downsampleApplied: downsample.enabled && downsampled.droppedCount > 0,
  };
}

/** IMP-010A: the backup-restore format's equivalent of `parseSingleCsvFile`
 * above, using the shared `parsePriceBackupCsv`. */
async function parseBackupCsvFile(
  file: File,
): Promise<
  | { ok: true; payload: ClientBackupUploadPayload }
  | { ok: false; message: string }
> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parsePriceBackupCsv(bytes, DEFAULT_PRICE_BACKUP_LIMITS);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const malformedByReason: Record<string, number> = {};
  for (const row of parsed.malformed) {
    malformedByReason[row.reason] = (malformedByReason[row.reason] ?? 0) + 1;
  }
  return {
    ok: true,
    payload: {
      rows: parsed.rows.map((row) => ({
        providerId: row.providerId,
        sourceLabel: row.sourceLabel,
        providerSymbol: row.providerSymbol,
        providerExchange: row.providerExchange,
        currencyCode: row.currencyCode,
        marketDate: row.marketDate,
        priceDecimal: row.priceDecimal,
        observationAt: row.observationAt,
        marketTimezone: row.marketTimezone,
        interval: row.interval,
        quality: row.quality,
        adjustmentState: row.adjustmentState,
        delayedMinutes: row.delayedMinutes,
      })),
      malformedByReason,
    },
  };
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
      {/* EFF-001 (measure 4): a blank/zero price cell is an honest absence
          of a trade, disclosed separately from genuine malformed rows. */}
      {preview.noDataOmittedCount > 0 ? (
        <p>
          {preview.noDataOmittedCount} no-data row(s) omitted (blank or zero
          price).
        </p>
      ) : null}
      {/* EFF-001 (measure 5): states exactly what will be stored, and the
          write-budget saving, before the owner confirms. */}
      {preview.downsampleApplied ? (
        <p>
          Daily from {preview.downsampleBoundaryYear}-01-01; monthly (last
          trading day of the month) before -- {preview.rowCount} row(s) instead
          of {preview.preDownsampleRowCount}.
        </p>
      ) : null}
      {/* EFF-001 (measure 2, review B1 fix): write-avoidance -- these rows
          are never even sent on confirm, since they are EXACT duplicates of
          what this security already has (date AND price both match). A
          corrected price for an already-covered date is never counted
          here -- it uploads normally, per the sentence below. */}
      {preview.identicalCount > 0 ? (
        <p>
          {preview.identicalCount} identical row(s) already present -- skipped.
        </p>
      ) : null}
      {/* Review B2: the explicit write-budget figure, stated before the
          owner confirms. */}
      <p>{preview.rowsToWriteCount} row(s) will be written.</p>
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
    <div className="step-grid historical-data-uploads">
      <div className="step-label">
        <h3>Past uploads</h3>
        <p>Deleting an upload removes only the rows it created.</p>
      </div>
      <div className="step-body">
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
    </div>
  );
}

/**
 * MKT-018C: renders the sequential multi-file run's live status -- extracted
 * as a pure, explicit-props presentational component (matching
 * `SinglePreviewSummary`/`PriceUploadList` above) so `tests/mkt-018c.test.ts`
 * can render every phase directly without a live effect or interactive DOM
 * harness (this codebase has neither, see `tests/brk-005b.test.ts`'s header
 * note). Status text names the phase explicitly (never color-only) per
 * QA-001B; the results list is append-only and never removes an earlier
 * file's outcome, so a scroll-back always shows every file's fate.
 */
export function MultiFileRunStatus({
  running,
  phase,
  total,
  index,
  currentFilename,
  currentPreview,
  pending,
  results,
  cancelled,
  onConfirm,
  onSkip,
  onCancel,
}: {
  running: boolean;
  phase: "checking" | "reviewing" | "importing" | null;
  total: number;
  index: number;
  currentFilename: string | null;
  currentPreview: SinglePreview | null;
  pending: boolean;
  results: MultiFileStepResult[];
  cancelled: boolean;
  onConfirm: () => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  if (!running && results.length === 0) return null;
  const statusText = running
    ? phase === "reviewing"
      ? `Reviewing file ${index} of ${total}: ${currentFilename}.`
      : phase === "importing"
        ? `Importing file ${index} of ${total}: ${currentFilename}…`
        : `Checking file ${index} of ${total}: ${currentFilename}…`
    : cancelled
      ? `Cancelled — ${results.length} of ${total} file(s) processed.`
      : `Finished: ${results.length} of ${total} file(s) processed.`;
  return (
    <div className="historical-data-multi-run">
      <p role="status" aria-busy={running || undefined}>
        {statusText}
      </p>
      {currentPreview ? (
        <>
          <SinglePreviewSummary preview={currentPreview} />
          <div className="historical-data-actions">
            <button
              type="button"
              onClick={onConfirm}
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending ? "Importing…" : "Confirm import"}
            </button>
            <button type="button" onClick={onSkip} disabled={pending}>
              Skip this file
            </button>
            <button type="button" onClick={onCancel} disabled={pending}>
              Cancel remaining files
            </button>
          </div>
        </>
      ) : null}
      {results.length > 0 ? (
        <div className="historical-data-uploads">
          <h4>Multi-file import results</h4>
          <ul className="historical-data-upload-list">
            {results.map((result, resultIndex) => (
              <li key={`${result.filename}-${resultIndex}`}>
                <span>
                  {result.filename}: {result.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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

  // EFF-001 (measure 5): DEFAULT ON (owner ruling), boundary year adjustable
  // per import -- applies to every file in a multi-file run, mirroring the
  // exchange/currency settings above. `boundaryYearText` is the raw input
  // string (so the owner can freely edit/clear the field); `boundaryYear`
  // below derives the effective number, falling back to the default for
  // anything not a plain 4-digit year rather than silently using `NaN`.
  const [downsampleEnabled, setDownsampleEnabled] = useState(true);
  const [boundaryYearText, setBoundaryYearText] = useState(
    String(DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR),
  );
  const parsedBoundaryYear = Number(boundaryYearText);
  const boundaryYear =
    Number.isInteger(parsedBoundaryYear) &&
    parsedBoundaryYear > 1900 &&
    parsedBoundaryYear < 2200
      ? parsedBoundaryYear
      : DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR;
  const downsampleSettings: DownsampleSettings = {
    enabled: downsampleEnabled,
    boundaryYear,
  };
  // EFF-001 (measure 2): `multiConfirmFile` runs strictly AFTER the SAME
  // file's `multiPreviewFile` resolved and the owner confirmed (
  // `runMultiFilePriceUpload` processes one file at a time, never
  // concurrently) -- this ref carries that preview's `existingObservations`
  // across to the confirm call for the SAME file, since `confirmFile`'s
  // shared interface (`multi-file-price-upload.ts`) takes only the file.
  const multiExistingDatesRef = useRef<PriceCsvExistingObservation[]>([]);

  // MKT-018C: selecting MORE THAN ONE file switches into this sequential
  // run -- each file still goes through the exact same preview/confirm
  // endpoints as the single-file path above (`multiPreviewFile`/
  // `multiConfirmFile` below build the identical FormData), just walked one
  // file at a time via `runMultiFilePriceUpload`. Selecting exactly one
  // file (including via the `multiple` picker) takes the ORIGINAL
  // `file`/`singlePreview`/... state path above, byte-for-byte unchanged,
  // so a single-file upload behaves exactly as it did before this task.
  const [multiRunning, setMultiRunning] = useState(false);
  // Review fold: the file-picker's readback (below) shows the real
  // selected-file count from the onChange's own already-parsed list,
  // rather than only a generic "Multiple files selected" gated on
  // `multiRunning` (which can lag the selection by a tick).
  const [multiFileCount, setMultiFileCount] = useState<number | null>(null);
  const [multiTotal, setMultiTotal] = useState(0);
  const [multiIndex, setMultiIndex] = useState(0);
  const [multiCurrentFilename, setMultiCurrentFilename] = useState<
    string | null
  >(null);
  const [multiCurrentPreview, setMultiCurrentPreview] =
    useState<SinglePreview | null>(null);
  const [multiPending, setMultiPending] = useState(false);
  const [multiPhase, setMultiPhase] = useState<
    "checking" | "reviewing" | "importing" | null
  >(null);
  const [multiResults, setMultiResults] = useState<MultiFileStepResult[]>([]);
  const [multiCancelled, setMultiCancelled] = useState(false);
  // Resolves the Promise `runMultiFilePriceUpload`'s `decide` callback is
  // awaiting on -- set while a file's preview is on screen awaiting the
  // owner's Confirm/Skip/Cancel click, cleared once one of those buttons
  // resolves it. Never auto-resolved: the owner reviews every file.
  const multiDecisionRef = useRef<
    ((decision: MultiFileDecision) => void) | null
  >(null);

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
  //
  // MKT-018C: the fetch itself is extracted to `fetchCoverage` (below) so a
  // finished multi-file upload run can re-request coverage directly --
  // freshly-covered tickers must drop off the zero-history list once the
  // run commits their price history, and this panel never unmounts between
  // files, so nothing else would trigger that refresh.
  useEffect(() => {
    if (!portfolioId) return;
    let cancelled = false;
    fetchCoverage(portfolioId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setCoverageError(result.message);
        return;
      }
      setCoverageError(null);
      setCoverage({ zero: result.zero, partial: result.partial });
    });
    return () => {
      cancelled = true;
    };
  }, [portfolioId]);

  async function fetchCoverage(forPortfolioId: string): Promise<
    | {
        ok: true;
        zero: PriceHistoryCoverageRow[];
        partial: PriceHistoryCoverageRow[];
      }
    | { ok: false; message: string }
  > {
    try {
      const response = await fetch(
        `/api/portfolios/${encodeURIComponent(forPortfolioId)}/price-history-coverage`,
        { cache: "no-store" },
      );
      return (await response.json()) as
        | {
            ok: true;
            zero: PriceHistoryCoverageRow[];
            partial: PriceHistoryCoverageRow[];
          }
        | { ok: false; message: string };
    } catch {
      return {
        ok: false,
        message: "The request failed. Check your connection and retry.",
      };
    }
  }

  async function refreshCoverage() {
    if (!portfolioId) return;
    const result = await fetchCoverage(portfolioId);
    if (!result.ok) {
      setCoverageError(result.message);
      return;
    }
    setCoverageError(null);
    setCoverage({ zero: result.zero, partial: result.partial });
  }

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
    const parsed = await parseSingleCsvFile(file, downsampleSettings);
    if (!parsed.ok) {
      setSinglePending(false);
      setSingleError(parsed.message);
      setSinglePreview(null);
      return;
    }
    const result = await postJson<{ preview: SinglePreview }>(
      "/api/market-data/price-uploads/preview",
      { ...parsed.payload, exchangeAlias, currencyCode },
    );
    setSinglePending(false);
    if (!result.ok) {
      setSingleError(result.message);
      setSinglePreview(null);
      return;
    }
    setSinglePreview({
      ...result.value.preview,
      noDataOmittedCount: parsed.noDataOmittedCount,
      preDownsampleRowCount: parsed.preDownsampleRowCount,
      downsampleApplied: parsed.downsampleApplied,
      downsampleBoundaryYear: boundaryYear,
    });
  }

  async function confirmSingle() {
    if (!file || !singlePreview) return;
    setSinglePending(true);
    setSingleError(null);
    const parsed = await parseSingleCsvFile(file, downsampleSettings);
    if (!parsed.ok) {
      setSinglePending(false);
      setSingleError(parsed.message);
      return;
    }
    // EFF-001 (measure 2, review B1 fix): sends only rows that are NOT
    // exact (date, price) duplicates of an existing owner-import
    // observation for this security -- write-avoidance only, the server's
    // upsert handles whatever arrives regardless (never a correctness
    // dependency on this filter running or being up to date). A row whose
    // date is covered but whose price DIFFERS (a correction) is never
    // filtered out here.
    const { rows: rowsToUpload } = filterRowsAlreadyPresent(
      parsed.payload.rows,
      singlePreview.existingObservations,
    );
    if (rowsToUpload.length === 0 && parsed.payload.rows.length > 0) {
      setSinglePending(false);
      setSingleResult(
        `All ${parsed.payload.rows.length} row(s) were already present (identical) for ${singlePreview.ticker} -- nothing new to import.`,
      );
      setSinglePreview(null);
      setFile(null);
      return;
    }
    const result = await postJson<{
      batch: UploadBatch;
      written: number;
      unchangedCount: number;
    }>("/api/market-data/price-uploads/confirm", {
      ...parsed.payload,
      rows: rowsToUpload,
      exchangeAlias,
      currencyCode,
      sourceLabel,
      filename: file.name,
    });
    setSinglePending(false);
    if (!result.ok) {
      setSingleError(result.message);
      return;
    }
    const overlaid = result.value.written - result.value.batch.insertedRowCount;
    // EFF-001 (measure 3): discloses the write-avoidance saving honestly
    // rather than letting `written` silently undercount the rows this
    // confirm actually matched.
    const unchangedNote =
      result.value.unchangedCount > 0
        ? `, ${result.value.unchangedCount} unchanged -- no write needed`
        : "";
    setSingleResult(
      `Imported ${result.value.written} price observation${result.value.written === 1 ? "" : "s"} for ${singlePreview.ticker} (${result.value.batch.insertedRowCount} newly created, ${overlaid} overlaid existing${unchangedNote}).`,
    );
    setSinglePreview(null);
    setFile(null);
    void loadBatches();
  }

  // MKT-018C: the multi-file preview/confirm calls below build the SAME
  // JSON payload (browser-parsed `ticker`/`rows`/`malformedCount`, plus
  // `exchangeAlias`/`currencyCode`, and -- confirm only -- `sourceLabel`/
  // `filename`) against the SAME two endpoints `previewSingle`/
  // `confirmSingle` call above; only the file object and which state
  // setters run differ. Exchange/currency settings apply to every file in
  // the run, exactly like the single-file section's shared fields above --
  // Intelligent Investor exports for one portfolio are all the same
  // exchange/currency in practice, and this reuses the existing controls
  // rather than asking per-file.
  async function multiPreviewFile(
    uploadFile: File,
  ): Promise<MultiFilePreviewResult<SinglePreview>> {
    const parsed = await parseSingleCsvFile(uploadFile, downsampleSettings);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const result = await postJson<{ preview: SinglePreview }>(
      "/api/market-data/price-uploads/preview",
      { ...parsed.payload, exchangeAlias, currencyCode },
    );
    if (!result.ok) return { ok: false, message: result.message };
    // EFF-001 (measure 2): stashed for the SAME file's `multiConfirmFile`
    // call below -- see `multiExistingDatesRef`'s own doc comment for why a
    // ref, not a parameter, carries this across.
    multiExistingDatesRef.current = result.value.preview.existingObservations;
    return {
      ok: true,
      preview: {
        ...result.value.preview,
        noDataOmittedCount: parsed.noDataOmittedCount,
        preDownsampleRowCount: parsed.preDownsampleRowCount,
        downsampleApplied: parsed.downsampleApplied,
        downsampleBoundaryYear: boundaryYear,
      },
    };
  }

  async function multiConfirmFile(
    uploadFile: File,
  ): Promise<MultiFileConfirmResult> {
    const parsed = await parseSingleCsvFile(uploadFile, downsampleSettings);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const { rows: rowsToUpload } = filterRowsAlreadyPresent(
      parsed.payload.rows,
      multiExistingDatesRef.current,
    );
    // EFF-001 (measure 2, review fold): everything was already present
    // (identical) for this security -- nothing to send. Mirrors
    // `confirmSingle`'s short-circuit (a true "0 written" rather than
    // sending an empty row array the server would otherwise reject as a
    // malformed/empty file) AND now gives the same honest "already present"
    // message the single-file path shows, via `MultiFileConfirmResult`'s
    // optional `message` override, rather than the generic
    // "0 newly created, 0 overlaid existing" template.
    if (rowsToUpload.length === 0 && parsed.payload.rows.length > 0) {
      return {
        ok: true,
        written: 0,
        insertedRowCount: 0,
        message: `All ${parsed.payload.rows.length} row(s) were already present (identical) -- nothing new to import.`,
      };
    }
    const result = await postJson<{ batch: UploadBatch; written: number }>(
      "/api/market-data/price-uploads/confirm",
      {
        ...parsed.payload,
        rows: rowsToUpload,
        exchangeAlias,
        currencyCode,
        sourceLabel,
        filename: uploadFile.name,
      },
    );
    if (!result.ok) return { ok: false, message: result.message };
    return {
      ok: true,
      written: result.value.written,
      insertedRowCount: result.value.batch.insertedRowCount,
    };
  }

  /** Resolves the pending `decide` Promise `runMultiFilePriceUpload` is
   * awaiting -- called by the Confirm/Skip/Cancel buttons rendered under
   * the current file's preview. */
  function respondMultiDecision(decision: MultiFileDecision) {
    const resolve = multiDecisionRef.current;
    if (!resolve) return;
    multiDecisionRef.current = null;
    setMultiCurrentPreview(null);
    if (decision === "confirm") {
      setMultiPending(true);
      setMultiPhase("importing");
    }
    resolve(decision);
  }

  async function startMultiRun(selected: File[]) {
    setMultiRunning(true);
    setMultiCancelled(false);
    setMultiResults([]);
    setMultiTotal(selected.length);
    setMultiIndex(0);
    setMultiCurrentFilename(null);
    setMultiCurrentPreview(null);
    setMultiPending(false);
    setMultiPhase(null);

    const { results, cancelled } = await runMultiFilePriceUpload(selected, {
      previewFile: multiPreviewFile,
      confirmFile: multiConfirmFile,
      filenameOf: (uploadFile) => uploadFile.name,
      onProgress: (index, total, filename) => {
        setMultiIndex(index);
        setMultiTotal(total);
        setMultiCurrentFilename(filename);
        setMultiCurrentPreview(null);
        setMultiPending(true);
        setMultiPhase("checking");
      },
      decide: (preview) =>
        new Promise((resolve) => {
          setMultiPending(false);
          setMultiPhase("reviewing");
          setMultiCurrentPreview(preview);
          multiDecisionRef.current = resolve;
        }),
    });

    setMultiResults(results);
    setMultiCancelled(cancelled);
    setMultiRunning(false);
    setMultiPending(false);
    setMultiPhase(null);
    setMultiCurrentPreview(null);
    setMultiCurrentFilename(null);
    void loadBatches();
    // MKT-018B's coverage panel must refresh after the run so any
    // now-covered tickers drop off the zero-history list -- see the
    // `refreshCoverage` note above.
    void refreshCoverage();
  }

  async function previewBackup() {
    if (!backupFile) return;
    setBackupPending(true);
    setBackupError(null);
    setBackupResult(null);
    const parsed = await parseBackupCsvFile(backupFile);
    if (!parsed.ok) {
      setBackupPending(false);
      setBackupError(parsed.message);
      setBackupPreview(null);
      return;
    }
    const result = await postJson<{ preview: BackupPreview }>(
      "/api/market-data/price-uploads/backup/preview",
      parsed.payload,
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
    const parsed = await parseBackupCsvFile(backupFile);
    if (!parsed.ok) {
      setBackupPending(false);
      setBackupError(parsed.message);
      return;
    }
    const result = await postJson<{
      batch: UploadBatch;
      written: number;
      unresolvedRowCount: number;
    }>("/api/market-data/price-uploads/backup/confirm", {
      ...parsed.payload,
      filename: backupFile.name,
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
      className="backup-card historical-data-panel"
      aria-labelledby="historical-data-title"
    >
      <div className="backup-card-header">
        <div className="backup-card-title">
          <p className="eyebrow">Historical Data</p>
          <h2 id="historical-data-title">Price history import</h2>
        </div>
        <p className="backup-card-blurb">
          Import a per-security price-history CSV (Intelligent Investor export),
          export a full backup of your imported price history, or restore from a
          previously exported backup.
        </p>
      </div>

      <section
        className="historical-data-coverage"
        aria-labelledby="historical-data-coverage-title"
      >
        <div className="step-grid">
          <div className="step-label">
            <h3 id="historical-data-coverage-title">
              <span className="step-number">1 ·</span> Download price history
            </h3>
            <p>
              Downloads run in your own browser via the guide — this app never
              fetches Intelligent Investor&apos;s data directly.
            </p>
          </div>
          <div className="step-body">
            {coverageError ? (
              <p role="alert" className="historical-data-error">
                {coverageError}
              </p>
            ) : null}
            {!coverageError && coverage === null ? (
              <p role="status" className="backup-progress">
                Checking price-history coverage…
              </p>
            ) : null}
            {coverage &&
            coverage.zero.length === 0 &&
            coverage.partial.length === 0 ? (
              <p className="backup-copy">
                Every held security has recorded price history.
              </p>
            ) : null}
            {coverage ? (
              <>
                <PriceHistoryCoverageZeroList rows={coverage.zero} />
                <PriceHistoryCoveragePartialList rows={coverage.partial} />
              </>
            ) : null}
            {coverage &&
            (coverage.zero.length > 0 || coverage.partial.length > 0) ? (
              <p className="backup-preview-note">
                Download each CSV above, then{" "}
                <a href="#historical-data-single-upload">import it below</a>.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <div className="step-grid" id="historical-data-single-upload">
        <div className="step-label">
          <h3>
            <span className="step-number">2 ·</span> Per-ticker price history
            (CSV files)
          </h3>
          <p>
            Select one file to import it directly below, or select several at
            once to import them one at a time, in order.
          </p>
          <p>
            The Exchange, Currency, and Source label settings above and below
            apply to every file in the run -- they cannot be changed per file.
          </p>
        </div>
        <div className="step-body">
          <div className="step-form-row">
            <label>
              Exchange
              <input
                value={exchangeAlias}
                disabled={multiRunning}
                onChange={(event) => setExchangeAlias(event.target.value)}
              />
            </label>
            <label>
              Currency
              <input
                value={currencyCode}
                disabled={multiRunning}
                onChange={(event) => setCurrencyCode(event.target.value)}
              />
            </label>
            <label>
              Source label
              <input
                value={sourceLabel}
                disabled={multiRunning}
                onChange={(event) => setSourceLabel(event.target.value)}
              />
            </label>
          </div>
          {/* EFF-001 (measure 5): DEFAULT ON, boundary year adjustable per
              import -- applies to every file in a multi-file run, same as
              Exchange/Currency above. Full daily history stays the default
              data model everywhere else; this only thins what a NEW CSV
              import writes for dates before the boundary. */}
          <div className="step-inline-row">
            <label className="step-checkbox">
              <input
                type="checkbox"
                checked={downsampleEnabled}
                disabled={multiRunning}
                onChange={(event) => setDownsampleEnabled(event.target.checked)}
              />{" "}
              Downsample history before the boundary year to monthly
            </label>
            <label className="step-year">
              Boundary year
              <input
                type="number"
                inputMode="numeric"
                value={boundaryYearText}
                disabled={multiRunning || !downsampleEnabled}
                onChange={(event) => setBoundaryYearText(event.target.value)}
              />
            </label>
          </div>
          <label className="file-drop">
            <span className="visually-hidden">Price history CSV</span>
            <span className="file-picker">
              <input
                type="file"
                accept=".csv,text/csv,text/tab-separated-values"
                multiple
                disabled={multiRunning}
                className="file-picker-input"
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []);
                  // MKT-018C: exactly one file (including one chosen from a
                  // multi-select picker) takes the ORIGINAL single-file state
                  // path below, unchanged -- only picking more than one file
                  // switches into the sequential multi-file run.
                  if (selected.length > 1) {
                    setFile(null);
                    setSinglePreview(null);
                    setSingleError(null);
                    setSingleResult(null);
                    setMultiFileCount(selected.length);
                    void startMultiRun(selected);
                    return;
                  }
                  setFile(selected[0] ?? null);
                  setMultiFileCount(null);
                  setSinglePreview(null);
                  setSingleError(null);
                  setSingleResult(null);
                  setMultiResults([]);
                  setMultiCancelled(false);
                  setMultiPhase(null);
                  setMultiCurrentPreview(null);
                }}
              />
              <span className="file-picker-button">Choose file(s)…</span>
              <span className="file-picker-filename">
                {file
                  ? file.name
                  : multiFileCount
                    ? `${multiFileCount} files selected`
                    : "No file selected"}
              </span>
            </span>
          </label>
          <div className="backup-actions">
            <button
              type="button"
              className="backup-secondary-button"
              onClick={() => void previewSingle()}
              disabled={!file || singlePending}
              aria-busy={singlePending || undefined}
            >
              {singlePending ? "Checking…" : "Preview"}
            </button>
            {singlePreview ? (
              <button
                type="button"
                className="backup-confirm-button"
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
          <MultiFileRunStatus
            running={multiRunning}
            phase={multiPhase}
            total={multiTotal}
            index={multiIndex}
            currentFilename={multiCurrentFilename}
            currentPreview={multiCurrentPreview}
            pending={multiPending}
            results={multiResults}
            cancelled={multiCancelled}
            onConfirm={() => respondMultiDecision("confirm")}
            onSkip={() => respondMultiDecision("skip")}
            onCancel={() => respondMultiDecision("cancel")}
          />
        </div>
      </div>

      {/* UI-048 (owner-reported): export and restore used to be two
          separately-headed sections ("Import backup" / "Export") that read
          as unrelated, generic upload areas -- the owner never found the
          restore section at all. One heading, both actions co-located, so
          "where's the restore" has a single place to look. */}
      <section
        className="step-grid"
        id="historical-data-backup"
        aria-labelledby="historical-data-backup-title"
      >
        <div className="step-label">
          <h3 id="historical-data-backup-title">
            <span className="step-number">3 ·</span> Price-history backup
            (export / restore)
          </h3>
          <p>
            Export a full, re-importable backup of your imported price history,
            or restore a previously exported backup file.
          </p>
        </div>
        <div className="step-body">
          <h4>Export backup</h4>
          {/* This targets a file-download API route (text/csv,
              content-disposition: attachment), not a Next.js page -- a plain
              anchor triggers the browser's normal download handling; `next/link`
              would instead try to client-navigate/prefetch it as an app route. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            className="backup-export-button"
            href="/api/market-data/price-uploads/export"
          >
            Export price history
          </a>
          <h4>Restore from backup</h4>
          <label className="file-drop">
            <span className="visually-hidden">Backup CSV</span>
            <span className="file-picker">
              <input
                type="file"
                accept=".csv,text/csv"
                className="file-picker-input"
                onChange={(event) => {
                  setBackupFile(event.target.files?.[0] ?? null);
                  setBackupPreview(null);
                  setBackupError(null);
                  setBackupResult(null);
                }}
              />
              <span className="file-picker-button">Choose backup file…</span>
              <span className="file-picker-filename">
                {backupFile ? backupFile.name : "No file selected"}
              </span>
            </span>
          </label>
          <div className="backup-actions">
            <button
              type="button"
              className="backup-secondary-button"
              onClick={() => void previewBackup()}
              disabled={!backupFile || backupPending}
              aria-busy={backupPending || undefined}
            >
              {backupPending ? "Checking…" : "Preview"}
            </button>
            {backupPreview ? (
              <button
                type="button"
                className="backup-confirm-button"
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
      </section>

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
