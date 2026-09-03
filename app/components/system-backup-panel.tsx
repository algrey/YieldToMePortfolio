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
import { chunkRows } from "../../domain/exports/chunk-rows.ts";
import {
  EMPTY_RESTORE_PROGRESS,
  isResumeCursorValid,
  parseStoredRestoreProgress,
  restoreProgressStorageKey,
  type RestoreProgress,
} from "../system-backup-restore-progress.ts";

const FETCH_TIMEOUT_MS = 30_000;
const PRICE_RESTORE_CHUNK_ROWS = 200;
// EXP-004: the core restore's own part sizes. Deliberately smaller than the
// price chunk above -- each transaction/dividend write does real ledger/
// dividend-repository work (inventory validation, decimal parsing, audit
// inserts), unlike a price row's batched upsert, so the same CPU budget
// affords far fewer rows per request.
//
// EXP-004 correction (measured, not estimated -- see docs/BACKUP_FORMAT.md's
// "Per-request work census"): ONE `ledger.post` replay costs ~13 D1 client
// calls / ~21 SQL statements, so the original 100-row part issued ~1,302
// calls / ~2,102 statements -- MORE database work than the single old-code
// request Cloudflare already killed in production (~992 calls / ~1,534
// statements: a scaffold pass plus 63 transaction replays). The part size
// was the defect, not a tuning preference. 20 rows keeps a transactions part
// at ~262 calls / ~422 statements, roughly a quarter of that known-fatal
// request and in line with the price chunk EXP-003 already proved. A
// dividend replay costs ~4 calls / ~5 statements, so 50 rows sits at ~202
// calls / ~252 statements.
const TRANSACTIONS_RESTORE_CHUNK_ROWS = 20;
const DIVIDENDS_RESTORE_CHUNK_ROWS = 50;
// Human-visible marker for the restore client generation, shown in progress
// and failure copy so a stale cached browser bundle is instantly
// distinguishable from the current one. Bump whenever the wire protocol or
// part sizes change ("r3" = the 20/50-row parts).
const RESTORE_PROTOCOL = "r3";
const CHUNK_PAUSE_MS = 100;

function defaultNonJsonMessage(httpStatus: number): string {
  return `Cloudflare ended the request (HTTP ${httpStatus}). Progress from completed chunks is saved; wait and retry the same backup.`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchJson<T>(
  input: string,
  init?: RequestInit,
  // EXP-004 (follow-up (g) from EXP-003's own recorded follow-ups): the
  // generic "progress from completed chunks is saved" copy is only honest
  // for a call site that is ACTUALLY chunked/resumable that way -- callers
  // whose failure means something different (e.g. account-settings/
  // watchlist scaffold-time work, which is idempotent to re-run but is not
  // itself split into "chunks") pass their own accurate wording instead of
  // inheriting this default.
  nonJsonMessage?: (httpStatus: number) => string,
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
        message: (nonJsonMessage ?? defaultNonJsonMessage)(response.status),
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

function readRestoreProgress(digest: string): RestoreProgress {
  try {
    return parseStoredRestoreProgress(
      localStorage.getItem(restoreProgressStorageKey(digest)),
    );
  } catch {
    // Storage is an optional resume aid; idempotent server writes remain the
    // source of truth when private browsing disables localStorage.
    return { ...EMPTY_RESTORE_PROGRESS };
  }
}

function writeRestoreProgress(digest: string, progress: RestoreProgress): void {
  try {
    localStorage.setItem(
      restoreProgressStorageKey(digest),
      JSON.stringify(progress),
    );
  } catch {
    // See readRestoreProgress: losing the cursor costs time, never data.
  }
}

function clearRestoreProgress(digest: string): void {
  try {
    localStorage.removeItem(restoreProgressStorageKey(digest));
  } catch {
    // Optional browser-only resume metadata.
  }
}

/**
 * Review B3 fix (BLOCKING, 2026-08-28): the impure half of
 * `isResumeCursorValid` (`system-backup-restore-progress.ts`, unit-tested
 * directly) -- fetches the cheap owner-scoped probe (`GET
 * /api/market-data/price-uploads`, the SAME list the "Historical Data" panel
 * already reads) and feeds its ids into that pure decision. The probe
 * request itself failing is treated the same as a missing batch: any doubt
 * discards the cursor rather than trusting it.
 */
async function verifyResumeCursorBatches(
  batchIds: readonly string[],
): Promise<boolean> {
  if (batchIds.length === 0) return true;
  const outcome = await fetchJson<{
    batches: ReadonlyArray<{ id: string }>;
  }>("/api/market-data/price-uploads");
  if (!outcome.ok) return false;
  return isResumeCursorValid(
    batchIds,
    new Set(outcome.value.batches.map((batch) => batch.id)),
  );
}

function postJson<T>(
  input: string,
  payload: unknown,
  nonJsonMessage?: (httpStatus: number) => string,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  return fetchJson<T>(
    input,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    nonJsonMessage,
  );
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

// EXP-004: mirrors `app/system-backup-service.ts`'s `SystemBackupScaffoldResult`/
// `SystemBackupScaffoldPortfolio` -- redeclared here rather than imported,
// matching this file's existing convention of never importing server-only
// modules into a "use client" component (see `SystemBackupCommitResult`/
// `SystemBackupPreview` below, which do the same for the pre-existing
// server types).
type ScaffoldSecurity = { ref: string; portfolioSecurityId: string };
type ScaffoldPortfolio = {
  idempotent: boolean;
  batchId: string;
  fingerprint: string;
  portfolioId: string;
  portfolioName: string;
  code: string;
  securities: ScaffoldSecurity[];
  committedTransactionCount: number;
  committedDividendCount: number;
  // OPS-005: the resume mechanism itself -- every transaction ref still
  // needing a write, in the server's own current chain order. Replaces
  // deriving a slice index from `committedTransactionCount` against this
  // browser's own (possibly stale-cached-bundle) chain-order computation,
  // which a chain-order change straddling a deploy could desynchronise
  // silently (BUG-018 round 3's documented, now-closed hazard). See
  // `docs/BACKUP_FORMAT.md`'s "Resume evidence" section.
  missingTransactionRefs: string[];
  // OPS-005 round 2: the same mechanism, applied to the dividend phase --
  // see `missingTransactionRefs`'s comment above and
  // `BundleScaffoldResult.missingDividendRefs`'s own doc comment
  // (`app/portfolio-bundle-service.ts`).
  missingDividendRefs: string[];
};
type ScaffoldResult = {
  watchlist: {
    securitiesAdded: number;
    securitiesSkipped: number;
    pairsAdded: number;
  };
  portfolios: ScaffoldPortfolio[];
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
    // EXP-004: the CORE restore itself is now resumable/chunked, mirroring
    // the price loop below -- ONE bounded scaffold request (account
    // settings, every portfolio's own destination/settings/securities, and
    // the watchlist), then each portfolio's transactions/dividends in
    // bounded parts, then a small finalize request per portfolio. Resume
    // evidence (`committedTransactionCount`/`committedDividendCount`) comes
    // straight from the scaffold response's LIVE server-side counts, never
    // from anything stored in this browser -- calling scaffold again after
    // an interruption (even one that reloaded this page) is always safe and
    // always picks up exactly where the account's own data actually is. See
    // `commitPortfolioBundleScaffold`'s header comment
    // (`app/portfolio-bundle-service.ts`) for the full design rationale.
    // The protocol marker (r3 = the 20/50-row part sizes) is deliberately
    // surfaced in this phase's progress AND failure copy: it lets the owner
    // (and support) tell at a glance whether the browser is running the
    // current restore client or a stale cached one.
    setProgress(
      `Preparing account settings, portfolios, and watchlist… (restore protocol ${RESTORE_PROTOCOL}, step 1)`,
    );
    const scaffoldOutcome = await postJson<{ result: ScaffoldResult }>(
      "/api/system-backup/import/commit",
      {
        phase: "scaffold",
        backup: prepared.value.coreBackup,
        filename: file?.name,
      },
      (status) =>
        `Cloudflare ended the request (HTTP ${status}) at restore step 1 (protocol ${RESTORE_PROTOCOL}: prepare account settings, portfolios, and watchlist). Nothing here is lost -- any portfolio already prepared stays prepared; re-select this same backup and confirm again to retry.`,
    );
    if (!scaffoldOutcome.ok) {
      setPending(false);
      setProgress(null);
      setError(scaffoldOutcome.message);
      return;
    }

    const portfolioResults: Array<
      SystemBackupCommitResult["portfolios"][number]
    > = [];
    for (const [
      index,
      portfolioScaffold,
    ] of scaffoldOutcome.value.result.portfolios.entries()) {
      const bundle = prepared.value.coreBackup.portfolios[index]!;
      if (!portfolioScaffold.idempotent) {
        // OPS-005: the scaffold response's `missingTransactionRefs` IS the
        // resume mechanism -- a server-derived, always-live list of exactly
        // the refs not yet written, already in the server's own current
        // chain order. This browser never re-derives "how much is left"
        // from a count/slice; it only maps each ref back to the full
        // transaction object this bundle already carries and preserves the
        // order the server gave.
        const transactionsByRef = new Map(
          bundle.transactions.map((tx) => [tx.ref, tx]),
        );
        // A ref absent from this map (impossible for a bundle unmodified
        // since scaffold, since the server computed `missingTransactionRefs`
        // from this SAME bundle's own refs) is silently dropped here rather
        // than aborting the restore -- safe only because finalize
        // independently re-probes every one of `bundle.transactions`' own
        // refs against what is actually durably written (OPS-005 defence in
        // depth below) and fails closed on any gap, so an omission here can
        // never reach `committed` unnoticed.
        const remainingTransactions = portfolioScaffold.missingTransactionRefs
          .map((ref) => transactionsByRef.get(ref))
          .filter(
            (tx): tx is (typeof bundle.transactions)[number] =>
              tx !== undefined,
          );
        const transactionParts = chunkRows(
          remainingTransactions,
          TRANSACTIONS_RESTORE_CHUNK_ROWS,
        );
        for (const [partIndex, part] of transactionParts.entries()) {
          setProgress(
            `Restoring "${portfolioScaffold.portfolioName}": transactions part ${partIndex + 1} of ${transactionParts.length}…`,
          );
          const partOutcome = await postJson<{
            result: { committedCount: number };
          }>(
            "/api/system-backup/import/commit",
            {
              phase: "transactions",
              portfolioId: portfolioScaffold.portfolioId,
              batchId: portfolioScaffold.batchId,
              fingerprint: portfolioScaffold.fingerprint,
              securities: portfolioScaffold.securities,
              transactions: part,
            },
            (status) =>
              `Cloudflare ended the request (HTTP ${status}) while restoring "${portfolioScaffold.portfolioName}"'s transactions. Every transaction written so far is safe; re-select this same backup and confirm again to resume.`,
          );
          if (!partOutcome.ok) {
            setPending(false);
            setProgress(null);
            setError(
              `Restore paused while restoring "${portfolioScaffold.portfolioName}"'s transactions (part ${partIndex + 1} of ${transactionParts.length}). Completed work is safe. Re-select this same backup and confirm again to resume; if the D1 daily write allowance was reached, retry after 00:00 UTC. ${partOutcome.message}`,
            );
            return;
          }
          await waitBetweenChunks();
        }

        // OPS-005 round 2: the SAME ref-membership mechanism as
        // `missingTransactionRefs` above, now applied to the dividend
        // phase -- `missingDividendRefs` is a server-derived, always-live
        // list of exactly the refs not yet written, already in the
        // server's own current chain order. This browser no longer derives
        // "how much is left" from `chainOrder(...).slice(committedDividendCount)`
        // against its own locally recomputed chain order, which was only
        // skip-proof when both requests agreed on ordering (the same hazard
        // round 1 closed for transactions -- see
        // `docs/BACKUP_FORMAT.md`'s "Resume evidence" section).
        const dividendsByRef = new Map(
          bundle.dividendManualRecords.map((record) => [record.ref, record]),
        );
        // See the transactions-side comment above: an absent ref is dropped
        // here but caught by finalize's own dividend-linkage re-lookup,
        // which fails closed on any record not actually written.
        const remainingDividends = portfolioScaffold.missingDividendRefs
          .map((ref) => dividendsByRef.get(ref))
          .filter(
            (record): record is (typeof bundle.dividendManualRecords)[number] =>
              record !== undefined,
          );
        const dividendParts = chunkRows(
          remainingDividends,
          DIVIDENDS_RESTORE_CHUNK_ROWS,
        );
        for (const [partIndex, part] of dividendParts.entries()) {
          setProgress(
            `Restoring "${portfolioScaffold.portfolioName}": dividend records part ${partIndex + 1} of ${dividendParts.length}…`,
          );
          const partOutcome = await postJson<{
            result: { committedCount: number };
          }>(
            "/api/system-backup/import/commit",
            {
              phase: "dividends",
              portfolioId: portfolioScaffold.portfolioId,
              batchId: portfolioScaffold.batchId,
              fingerprint: portfolioScaffold.fingerprint,
              securities: portfolioScaffold.securities,
              records: part,
            },
            (status) =>
              `Cloudflare ended the request (HTTP ${status}) while restoring "${portfolioScaffold.portfolioName}"'s dividend records. Every record written so far is safe; re-select this same backup and confirm again to resume.`,
          );
          if (!partOutcome.ok) {
            setPending(false);
            setProgress(null);
            setError(
              `Restore paused while restoring "${portfolioScaffold.portfolioName}"'s dividend records (part ${partIndex + 1} of ${dividendParts.length}). Completed work is safe. Re-select this same backup and confirm again to resume; if the D1 daily write allowance was reached, retry after 00:00 UTC. ${partOutcome.message}`,
            );
            return;
          }
          await waitBetweenChunks();
        }

        setProgress(`Finishing "${portfolioScaffold.portfolioName}"…`);
        const finalizeOutcome = await postJson<{
          result: { skippedDividendEventOverrides: number };
        }>(
          "/api/system-backup/import/commit",
          {
            phase: "finalize",
            portfolioId: portfolioScaffold.portfolioId,
            batchId: portfolioScaffold.batchId,
            fingerprint: portfolioScaffold.fingerprint,
            securities: portfolioScaffold.securities,
            dividendLinkage: bundle.dividendManualRecords.map((record) => ({
              ref: record.ref,
              securityRef: record.securityRef,
              supersedesRef: record.supersedesRef,
              supersededByDeletedRecord: record.supersededByDeletedRecord,
            })),
            dividendSecurityAssumptions: bundle.dividendSecurityAssumptions,
            dividendPortfolioAssumption: bundle.dividendPortfolioAssumption,
            dividendFyOverrides: bundle.dividendFyOverrides,
            dividendEventOverrides: bundle.dividendEventOverrides,
            dividendImportFrankingOverrides:
              bundle.dividendImportFrankingOverrides,
            whatifScenarios: bundle.whatifScenarios,
            portfolioStatus: bundle.portfolio.status,
            transactionsCount: bundle.transactions.length,
            dividendRecordsCount: bundle.dividendManualRecords.length,
            // OPS-005 (defence in depth): every transaction ref, so
            // finalize can verify each one was actually written before
            // marking this portfolio committed.
            transactionRefs: bundle.transactions.map((tx) => tx.ref),
          },
          (status) =>
            `Cloudflare ended the request (HTTP ${status}) while finishing "${portfolioScaffold.portfolioName}". Its transactions and dividend records are already safely restored; re-select this same backup and confirm again to finish.`,
        );
        if (!finalizeOutcome.ok) {
          setPending(false);
          setProgress(null);
          setError(
            `Restore paused while finishing "${portfolioScaffold.portfolioName}". Its transactions and dividend records are already safely restored -- only account-level annotations (assumptions, overrides, saved scenarios) and its final status remain. Re-select this same backup and confirm again to resume. ${finalizeOutcome.message}`,
          );
          return;
        }
      }
      portfolioResults.push({
        name: portfolioScaffold.portfolioName,
        code: portfolioScaffold.code,
        idempotent: portfolioScaffold.idempotent,
        portfolioId: portfolioScaffold.portfolioId,
      });
    }
    const coreResult: SystemBackupCommitResult = {
      portfolios: portfolioResults,
      watchlist: scaffoldOutcome.value.result.watchlist,
      priceBackup: null,
    };
    const stored = readRestoreProgress(prepared.value.digest);
    // Review B3 fix (BLOCKING, 2026-08-28): a stored cursor is a RESUME
    // CLAIM, not a fact -- honor it only once the batches it claims to have
    // written are confirmed to still exist for this owner on the CURRENT
    // server. `nextChunk === 0` (no resume in play) skips the round trip.
    const cursorValid =
      stored.nextChunk === 0 ||
      (await verifyResumeCursorBatches(stored.batchIds));
    if (!cursorValid) clearRestoreProgress(prepared.value.digest);
    const progressState: RestoreProgress = cursorValid
      ? {
          ...stored,
          nextChunk: Math.min(
            stored.nextChunk,
            prepared.value.priceChunks.length,
          ),
        }
      : { ...EMPTY_RESTORE_PROGRESS };
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
        batch: { id: string };
        written: number;
        unresolvedRowCount: number;
        unchangedCount: number;
      }>("/api/market-data/price-uploads/backup/confirm", {
        rows: chunk,
        malformedByReason: firstUnfinishedChunk
          ? prepared.value.malformedByReason
          : {},
        filename: `${file?.name ?? "system-backup.json"} (price part ${index + 1})`,
        // Review B2 fix (BLOCKING, 2026-08-28): tells the server this is one
        // bounded part of a larger resumable restore, so a part where every
        // row happens to be unresolvable (consecutive rows for one unknown
        // symbol) advances with `written: 0` instead of hard-failing the
        // whole restore -- see `confirmBackupPriceUpload`'s
        // `tolerateAllUnresolved` doc comment.
        chunked: true,
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
      progressState.batchIds = [
        ...progressState.batchIds,
        chunkOutcome.value.batch.id,
      ];
      writeRestoreProgress(prepared.value.digest, progressState);
      await waitBetweenChunks();
    }
    clearRestoreProgress(prepared.value.digest);
    setPending(false);
    setProgress(null);
    setResult({
      ...coreResult,
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
        Large portfolios (many transactions or dividend records) and large price
        histories are both restored in small, idempotent parts. If the Free-plan
        daily D1 allowance is reached, or the restore is otherwise interrupted,
        re-select the same file after 00:00 UTC and the browser resumes from
        exactly where the account&rsquo;s own data actually is.
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
