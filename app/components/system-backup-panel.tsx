"use client";

// EXP-002 (owner-directed, TASKS.md "### EXP-002"): the import page's
// "Full-system backup (export / restore)" section -- a standalone sibling
// to `HistoricalDataPanel` (MKT-008's price-history backup) and
// `BundlePanel` (EXP-001's per-portfolio bundle), following the SAME
// UI-048 conventions: one heading with Export/Restore sub-headings, the
// shared file-picker recipe, and a preview-then-confirm staged flow.
// Account-level (no `portfolioId` prop -- covers every portfolio of the
// authenticated owner at once). The browser only reads the uploaded file as
// text and `JSON.parse`s it -- the server re-validates everything
// (IMP-010B: server is the sole validation authority).
import { useState } from "react";

const FETCH_TIMEOUT_MS = 30_000;

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

type AccountSettingsSnapshot = {
  homeCurrencyCode: string;
  timezone: string;
  defaultHoldingCurrencyView: "native" | "home";
  financialYearStartMonth: number;
  priceSourcePreference: string;
  dailyCaptureSource: string;
  dailyCaptureIntervalMinutes: number;
};

type SystemBackupPreview = {
  account: AccountSettingsSnapshot;
  currentAccount: AccountSettingsSnapshot | null;
  watchlistCounts: { securities: number; currencyPairs: number };
  portfolios: ReadonlyArray<{
    name: string;
    code: string;
    status: "active" | "archived";
    baseCurrencyMismatch: boolean;
    counts: {
      securities: number;
      transactions: number;
      dividendManualRecords: number;
      whatifScenarios: number;
    };
  }>;
  priceBackup: { rowCount: number; malformedCount: number };
  precondition: { fresh: boolean; unrelatedPortfolioCount: number };
};

type SystemBackupCommitResult = {
  portfolios: ReadonlyArray<{
    name: string;
    code: string;
    idempotent: boolean;
    portfolioId: string;
  }>;
  watchlist: {
    securitiesAdded: number;
    securitiesSkipped: number;
    pairsAdded: number;
  };
  priceBackup: {
    written: number;
    unresolvedRowCount: number;
    malformedCount: number;
    unchangedCount: number;
    note: string | null;
  } | null;
};

// S2 fold: the account-settings fields the preview discloses as
// "current -> new" before an unconditional overwrite -- one row per
// mutable `user_settings` column this backup restores.
const SETTINGS_DISCLOSURE_FIELDS: ReadonlyArray<{
  label: string;
  read: (settings: AccountSettingsSnapshot) => string;
}> = [
  { label: "Home currency", read: (s) => s.homeCurrencyCode },
  { label: "Timezone", read: (s) => s.timezone },
  { label: "Holding-currency view", read: (s) => s.defaultHoldingCurrencyView },
  {
    label: "FY start month",
    read: (s) => String(s.financialYearStartMonth),
  },
  { label: "Price-source preference", read: (s) => s.priceSourcePreference },
  { label: "Daily-capture source", read: (s) => s.dailyCaptureSource },
  {
    label: "Daily-capture interval",
    read: (s) => `${s.dailyCaptureIntervalMinutes} min`,
  },
];

export function SystemBackupPreviewSummary({
  preview,
}: {
  preview: SystemBackupPreview;
}) {
  return (
    <div className="historical-data-preview" role="status">
      {!preview.precondition.fresh ? (
        <p role="alert" className="historical-data-error">
          This account already has{" "}
          {preview.precondition.unrelatedPortfolioCount} portfolio(s) unrelated
          to this backup. Full-system restore requires a fresh account --
          archive or remove them first, or restore into a fresh deployment.
        </p>
      ) : null}
      <p>Account settings will be overwritten as follows:</p>
      <ul>
        {SETTINGS_DISCLOSURE_FIELDS.map(({ label, read }) => {
          const next = read(preview.account);
          const current = preview.currentAccount
            ? read(preview.currentAccount)
            : null;
          return (
            <li key={label}>
              {label}: {current ?? "(unknown)"} &rarr; {next}
            </li>
          );
        })}
      </ul>
      <ul>
        <li>
          {preview.watchlistCounts.securities} watched security(ies),{" "}
          {preview.watchlistCounts.currencyPairs} watched currency pair(s)
        </li>
        <li>
          {preview.priceBackup.rowCount} price-history row(s)
          {preview.priceBackup.malformedCount > 0
            ? ` (${preview.priceBackup.malformedCount} malformed, skipped)`
            : ""}
        </li>
      </ul>
      <p>{preview.portfolios.length} portfolio(s) will be recreated:</p>
      <ul>
        {preview.portfolios.map((portfolio) => (
          <li key={`${portfolio.code}-${portfolio.name}`}>
            <strong>{portfolio.name}</strong> ({portfolio.code}
            {portfolio.status === "archived" ? ", archived" : ""}) --{" "}
            {portfolio.counts.transactions} transaction(s),{" "}
            {portfolio.counts.dividendManualRecords} dividend record(s)
            {portfolio.baseCurrencyMismatch ? (
              <span role="alert" className="historical-data-error">
                {" "}
                base currency does not match this backup&rsquo;s account home
                currency -- will be rejected.
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SystemBackupPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SystemBackupPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SystemBackupCommitResult | null>(null);

  async function readBackupText(): Promise<
    { ok: true; text: string } | { ok: false; message: string }
  > {
    if (!file) return { ok: false, message: "Choose a backup file first." };
    try {
      const text = await file.text();
      JSON.parse(text);
      return { ok: true, text };
    } catch {
      return {
        ok: false,
        message: "The backup file could not be read as JSON.",
      };
    }
  }

  async function preview_() {
    setPending(true);
    setError(null);
    setResult(null);
    const read = await readBackupText();
    if (!read.ok) {
      setPending(false);
      setError(read.message);
      setPreview(null);
      return;
    }
    const outcome = await postJson<{ preview: SystemBackupPreview }>(
      "/api/system-backup/import/preview",
      { backup: JSON.parse(read.text), filename: file?.name },
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
    const read = await readBackupText();
    if (!read.ok) {
      setPending(false);
      setError(read.message);
      return;
    }
    const outcome = await postJson<{ result: SystemBackupCommitResult }>(
      "/api/system-backup/import/commit",
      { backup: JSON.parse(read.text), filename: file?.name },
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
      id="system-backup"
      aria-labelledby="system-backup-title"
    >
      <h3 id="system-backup-title">Full-system backup (export / restore)</h3>
      <p>
        Export EVERYTHING needed to recreate this account on a fresh deployment
        in one file -- every portfolio (transactions, dividend records,
        assumptions, saved scenarios), the watchlist, account settings, and
        price history. Restore only works into a FRESH account (no existing
        portfolios outside this backup).
      </p>
      <h4>Export the full system</h4>
      {/* File-download API route, not a Next.js page -- see
          `HistoricalDataPanel`'s identical export-link comment. */}
      <a
        className="historical-data-export-link"
        href="/api/system-backup/export"
      >
        Export full-system backup
      </a>
      <h4>Restore from a full-system backup</h4>
      <p>
        Restoring recreates every portfolio in the backup as a NEW portfolio,
        restores the watchlist and account settings, and restores price history.
        Undo by archiving the restored portfolios from Settings and removing the
        restored price history from the price-history backup section above.
      </p>
      <label>
        System backup JSON
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
          <span className="file-picker-button">Choose backup file…</span>
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
            disabled={pending || !preview.precondition.fresh}
            aria-busy={pending || undefined}
          >
            {pending ? "Restoring…" : "Confirm restore"}
          </button>
        ) : null}
      </div>
      {preview ? <SystemBackupPreviewSummary preview={preview} /> : null}
      {error ? (
        <p role="alert" className="historical-data-error">
          {error}
        </p>
      ) : null}
      {result ? (
        <p role="status" className="historical-data-result">
          Restored {result.portfolios.length} portfolio(s):{" "}
          {result.portfolios.map((portfolio) => portfolio.name).join(", ")}.{" "}
          Watchlist: {result.watchlist.pairsAdded} currency pair(s),{" "}
          {result.watchlist.securitiesAdded} security(ies) added
          {result.watchlist.securitiesSkipped > 0
            ? ` (${result.watchlist.securitiesSkipped} skipped -- could not be resolved)`
            : ""}
          .{" "}
          {result.priceBackup
            ? `Price history: ${result.priceBackup.written} row(s) written` +
              (result.priceBackup.unresolvedRowCount > 0
                ? `, ${result.priceBackup.unresolvedRowCount} unresolved`
                : "") +
              (result.priceBackup.malformedCount > 0
                ? `, ${result.priceBackup.malformedCount} malformed`
                : "") +
              (result.priceBackup.unchangedCount > 0
                ? `, ${result.priceBackup.unchangedCount} unchanged`
                : "") +
              "." +
              (result.priceBackup.note ? ` ${result.priceBackup.note}` : "")
            : "No price history was included in this backup."}{" "}
          Cap Gains and other derived views populate once the calculation engine
          has run.
        </p>
      ) : null}
    </section>
  );
}
