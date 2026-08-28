"use client";

// EXP-002 (owner-directed, TASKS.md "### EXP-002"): the import page's
// "Full-system backup (export / restore)" section -- a standalone sibling
// to `HistoricalDataPanel` (MKT-008's price-history backup) and
// `BundlePanel` (EXP-001's per-portfolio bundle), following the SAME
// UI-048 conventions: one heading with Export/Restore sub-headings, the
// shared file-picker recipe, and a preview-then-confirm staged flow.
// Account-level (no `portfolioId` prop -- covers every portfolio of the
// authenticated owner at once). EXP-003 parses the large embedded price CSV
// with the shared browser-safe parser and sends it in bounded parts; the
// server re-validates every received row before writing (IMP-010B authority).
import { useState } from "react";
import {
  DEFAULT_PRICE_BACKUP_LIMITS,
  formatPriceBackupCsv,
  parsePriceBackupCsv,
  type PriceBackupDataRow,
  type PriceBackupExportRow,
  type PriceBackupMalformedReason,
} from "../../domain/market-data/price-backup-csv.ts";
import type { SystemBackupV1 } from "../../domain/exports/system-backup.ts";

const FETCH_TIMEOUT_MS = 30_000;
const PRICE_RESTORE_CHUNK_ROWS = 200;
const CHUNK_PAUSE_MS = 100;

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
    const text = await response.text();
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      return {
        ok: false,
        message: `Cloudflare ended the request (HTTP ${response.status}). Progress from completed chunks is saved; wait and retry the same backup.`,
      };
    }
    const typed = result as
      ({ ok: true } & Record<string, unknown>) | { ok: false; message: string };
    if (!typed.ok) return { ok: false, message: typed.message };
    return { ok: true, value: typed as T };
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

function waitBetweenChunks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CHUNK_PAUSE_MS));
}

function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function backupUploadRow(row: PriceBackupDataRow) {
  return {
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
  };
}

type RestoreProgress = {
  nextChunk: number;
  written: number;
  unresolvedRowCount: number;
  unchangedCount: number;
};

type PreparedBackup = {
  coreBackup: SystemBackupV1;
  priceChunks: ReturnType<typeof backupUploadRow>[][];
  malformedByReason: Partial<Record<PriceBackupMalformedReason, number>>;
  malformedCount: number;
  digest: string;
};

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function progressKey(digest: string): string {
  return `yieldtome-system-restore-v1:${digest}`;
}

function readRestoreProgress(digest: string): RestoreProgress {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(progressKey(digest)) ?? "null",
    ) as Partial<RestoreProgress> | null;
    if (
      parsed &&
      Number.isSafeInteger(parsed.nextChunk) &&
      parsed.nextChunk! >= 0 &&
      Number.isSafeInteger(parsed.written) &&
      parsed.written! >= 0 &&
      Number.isSafeInteger(parsed.unresolvedRowCount) &&
      parsed.unresolvedRowCount! >= 0 &&
      Number.isSafeInteger(parsed.unchangedCount) &&
      parsed.unchangedCount! >= 0
    ) {
      return parsed as RestoreProgress;
    }
  } catch {
    // Storage is an optional resume aid; idempotent server writes remain the
    // source of truth when private browsing disables localStorage.
  }
  return { nextChunk: 0, written: 0, unresolvedRowCount: 0, unchangedCount: 0 };
}

function writeRestoreProgress(digest: string, progress: RestoreProgress): void {
  try {
    localStorage.setItem(progressKey(digest), JSON.stringify(progress));
  } catch {
    // See readRestoreProgress: losing the cursor costs time, never data.
  }
}

function clearRestoreProgress(digest: string): void {
  try {
    localStorage.removeItem(progressKey(digest));
  } catch {
    // Optional browser-only resume metadata.
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
  const [progress, setProgress] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function prepareBackup(): Promise<
    { ok: true; value: PreparedBackup } | { ok: false; message: string }
  > {
    if (!file) return { ok: false, message: "Choose a backup file first." };
    try {
      const bytes = await file.arrayBuffer();
      const parsedJson = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (
        typeof parsedJson !== "object" ||
        parsedJson === null ||
        Array.isArray(parsedJson)
      ) {
        return { ok: false, message: "The backup file is not readable." };
      }
      const record = parsedJson as Record<string, unknown>;
      if (typeof record.priceBackupCsv !== "string") {
        return {
          ok: false,
          message: "The backup's price-history section is invalid.",
        };
      }
      const parsedPrice = parsePriceBackupCsv(
        new TextEncoder().encode(record.priceBackupCsv),
        DEFAULT_PRICE_BACKUP_LIMITS,
      );
      const priceRows = parsedPrice.ok ? parsedPrice.rows : [];
      if (!parsedPrice.ok && record.priceBackupCsv.length > 0) {
        return { ok: false, message: parsedPrice.message };
      }
      const malformedByReason: Partial<
        Record<PriceBackupMalformedReason, number>
      > = {};
      if (parsedPrice.ok) {
        for (const malformed of parsedPrice.malformed) {
          malformedByReason[malformed.reason] =
            (malformedByReason[malformed.reason] ?? 0) + 1;
        }
      }
      const backup = parsedJson as SystemBackupV1;
      return {
        ok: true,
        value: {
          coreBackup: { ...backup, priceBackupCsv: "" },
          priceChunks: chunkRows(
            priceRows.map(backupUploadRow),
            PRICE_RESTORE_CHUNK_ROWS,
          ),
          malformedByReason,
          malformedCount: parsedPrice.ok ? parsedPrice.malformed.length : 0,
          digest: await sha256Hex(bytes),
        },
      };
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
    setProgress("Reading and checking the backup in your browser…");
    const prepared = await prepareBackup();
    if (!prepared.ok) {
      setPending(false);
      setProgress(null);
      setError(prepared.message);
      setPreview(null);
      return;
    }
    const outcome = await postJson<{ preview: SystemBackupPreview }>(
      "/api/system-backup/import/preview",
      { backup: prepared.value.coreBackup, filename: file?.name },
    );
    setPending(false);
    setProgress(null);
    if (!outcome.ok) {
      setError(outcome.message);
      setPreview(null);
      return;
    }
    setPreview({
      ...outcome.value.preview,
      priceBackup: {
        rowCount: prepared.value.priceChunks.reduce(
          (sum, chunk) => sum + chunk.length,
          0,
        ),
        malformedCount: prepared.value.malformedCount,
      },
    });
  }

  async function confirm() {
    setPending(true);
    setError(null);
    setProgress("Preparing the resumable restore…");
    const prepared = await prepareBackup();
    if (!prepared.ok) {
      setPending(false);
      setProgress(null);
      setError(prepared.message);
      return;
    }
    const coreOutcome = await postJson<{ result: SystemBackupCommitResult }>(
      "/api/system-backup/import/commit",
      { backup: prepared.value.coreBackup, filename: file?.name },
    );
    if (!coreOutcome.ok) {
      setPending(false);
      setProgress(null);
      setError(coreOutcome.message);
      return;
    }
    const stored = readRestoreProgress(prepared.value.digest);
    const progressState: RestoreProgress = {
      ...stored,
      nextChunk: Math.min(stored.nextChunk, prepared.value.priceChunks.length),
    };
    for (
      let index = progressState.nextChunk;
      index < prepared.value.priceChunks.length;
      index += 1
    ) {
      const chunk = prepared.value.priceChunks[index]!;
      const firstUnfinishedChunk = progressState.nextChunk === 0;
      setProgress(
        `Restoring price history: part ${index + 1} of ${prepared.value.priceChunks.length} (${index * PRICE_RESTORE_CHUNK_ROWS} of ${prepared.value.priceChunks.reduce((sum, part) => sum + part.length, 0)} rows processed)…`,
      );
      const chunkOutcome = await postJson<{
        written: number;
        unresolvedRowCount: number;
        unchangedCount: number;
      }>("/api/market-data/price-uploads/backup/confirm", {
        rows: chunk,
        malformedByReason: firstUnfinishedChunk
          ? prepared.value.malformedByReason
          : {},
        filename: `${file?.name ?? "system-backup.json"} (price part ${index + 1})`,
      });
      if (!chunkOutcome.ok) {
        writeRestoreProgress(prepared.value.digest, progressState);
        setPending(false);
        setProgress(null);
        setError(
          `Price-history restore paused after ${progressState.nextChunk} of ${prepared.value.priceChunks.length} part(s). Completed work is safe. Re-select this same backup and confirm again to resume; if the D1 daily write allowance was reached, retry after 00:00 UTC. ${chunkOutcome.message}`,
        );
        return;
      }
      progressState.nextChunk = index + 1;
      progressState.written += chunkOutcome.value.written;
      progressState.unresolvedRowCount += chunkOutcome.value.unresolvedRowCount;
      progressState.unchangedCount += chunkOutcome.value.unchangedCount;
      writeRestoreProgress(prepared.value.digest, progressState);
      await waitBetweenChunks();
    }
    clearRestoreProgress(prepared.value.digest);
    setPending(false);
    setProgress(null);
    setResult({
      ...coreOutcome.value.result,
      priceBackup:
        prepared.value.priceChunks.length > 0
          ? {
              written: progressState.written,
              unresolvedRowCount: progressState.unresolvedRowCount,
              malformedCount: prepared.value.malformedCount,
              unchangedCount: progressState.unchangedCount,
              note: null,
            }
          : null,
    });
    setPreview(null);
    setFile(null);
  }

  async function exportInBrowser() {
    setExporting(true);
    setError(null);
    setProgress("Exporting account and portfolio data…");
    const core = await fetchJson<{ backup: SystemBackupV1 }>(
      "/api/system-backup/export?mode=core",
    );
    if (!core.ok) {
      setExporting(false);
      setProgress(null);
      setError(core.message);
      return;
    }
    const priceRows: PriceBackupExportRow[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      setProgress(`Exporting price history (${priceRows.length} rows read)…`);
      const page:
        | {
            ok: true;
            rows: PriceBackupExportRow[];
            nextOffset: number | null;
          }
        | { ok: false; message: string } = await fetchJson<{
        rows: PriceBackupExportRow[];
        nextOffset: number | null;
      }>(`/api/system-backup/export?mode=prices&offset=${offset}`).then(
        (outcome) =>
          outcome.ok
            ? { ok: true as const, ...outcome.value }
            : { ok: false as const, message: outcome.message },
      );
      if (!page.ok) {
        setExporting(false);
        setProgress(null);
        setError(page.message);
        return;
      }
      priceRows.push(...page.rows);
      offset = page.nextOffset;
      if (offset !== null) await waitBetweenChunks();
    }
    const backup: SystemBackupV1 = {
      ...core.value.backup,
      priceBackupCsv: formatPriceBackupCsv(priceRows),
    };
    const blob = new Blob([JSON.stringify(backup)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `yieldtome-system-backup-${backup.exportedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setExporting(false);
    setProgress(null);
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
      <p>
        The browser fetches the backup in small parts and assembles the same
        single JSON file locally.
      </p>
      <button
        type="button"
        onClick={() => void exportInBrowser()}
        disabled={exporting || pending}
        aria-busy={exporting || undefined}
      >
        {exporting ? "Exporting…" : "Export full-system backup"}
      </button>
      <h4>Restore from a full-system backup</h4>
      <p>
        Restoring recreates every portfolio in the backup as a NEW portfolio,
        restores the watchlist and account settings, and restores price history.
        Undo by archiving the restored portfolios from Settings and removing the
        restored price history from the price-history backup section above.
        Large price histories are restored in small, idempotent parts. If the
        Free-plan daily D1 allowance is reached, re-select the same file after
        00:00 UTC and the browser resumes from the last completed part.
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
              setProgress(null);
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
      {progress ? <p role="status">{progress}</p> : null}
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
