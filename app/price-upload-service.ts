import { randomUUID } from "node:crypto";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  createPriceUploadBatch,
  deletePriceUploadBatch,
  listPriceUploadBatches,
  loadOwnerPriceExportRows,
  loadSameUserSecurityEvidenceForTicker,
  updatePriceUploadBatchInsertedCount,
  writePriceUploadObservations,
  OWNER_IMPORT_PROVIDER_ID,
  type PriceUploadBatchRecord,
  type PriceUploadWriteCandidate,
} from "../db/repositories/price-uploads.ts";
import {
  DEFAULT_PRICE_CSV_LIMITS,
  parsePriceCsv,
  type PriceCsvDataRow,
} from "../domain/market-data/price-csv.ts";
import {
  DEFAULT_PRICE_BACKUP_LIMITS,
  formatPriceBackupCsv,
  parsePriceBackupCsv,
  type PriceBackupDataRow,
  type PriceBackupExportRow,
  type PriceBackupMalformedReason,
} from "../domain/market-data/price-backup-csv.ts";
import {
  deriveMidnightObservationAtUtc,
  resolveExchangeTimezone,
} from "../domain/market-data/exchange-timezone.ts";
import {
  resolvePriceUploadSecurity,
  type PriceUploadSecurityEvidenceRow,
} from "../domain/market-data/resolve-price-upload-security.ts";

// MKT-008: this is the ONLY layer that ever writes -- both the preview and
// confirm actions call the SAME parse-and-resolve helpers below, over the
// SAME uploaded bytes. Deliberately STATELESS between preview and confirm
// (no `price_upload_rows` staging table the way the ledger CSV flow uses):
// parsing and resolution here are pure/deterministic over the file's own
// bytes plus the owner's ALREADY-existing securities, so a preview is
// exactly "run the same read-only computation confirm is about to run, and
// show the result" -- the client resubmits the identical `File` object
// (still held in the browser, not re-selected) on confirm. This avoids a
// second staging schema for a feature whose "review" step has no owner
// judgment calls to make beyond "does this match what I expected" (unlike
// the ledger CSV flow, which stages ambiguous mappings/candidate securities
// an owner must actively resolve).

export const DEFAULT_SOURCE_LABEL = "intelligent-investor";
const MAX_SOURCE_LABEL_LENGTH = 60;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/g;

export type PriceUploadContext = Readonly<{
  client: SqlClient;
  userId: string;
}>;

type Failure = Readonly<{
  ok: false;
  status: 400 | 404 | 409 | 503;
  message: string;
}>;

function fail(status: Failure["status"], message: string): Failure {
  return { ok: false, status, message };
}

function sanitizeSourceLabel(value: string): string {
  const stripped = value.replace(CONTROL_CHARACTER_PATTERN, "").trim();
  const safe = stripped.length > 0 ? stripped : DEFAULT_SOURCE_LABEL;
  return safe.slice(0, MAX_SOURCE_LABEL_LENGTH);
}

async function validateCurrency(
  client: SqlClient,
  currencyCode: string,
): Promise<string | null> {
  const normalized = currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return null;
  const row = await client.get<{ code: string }>(
    `SELECT code FROM currencies WHERE code = ? AND is_active = 1 LIMIT 1`,
    [normalized],
  );
  return row ? normalized : null;
}

export type SingleUploadSettings = Readonly<{
  exchangeAlias: string;
  currencyCode: string;
}>;

type ResolvedSingleUpload = Readonly<{
  ticker: string;
  timezone: string;
  currencyCode: string;
  exchangeAlias: string;
  securityId: string;
  matchedName: string;
  rows: readonly PriceCsvDataRow[];
  malformedCount: number;
}>;

/**
 * Parses `bytes` as a single-security price CSV and resolves its ticker
 * against the owner's OWN securities -- shared by preview and confirm (see
 * this file's header comment). Never writes.
 */
async function parseAndResolveSingleUpload(
  context: PriceUploadContext,
  bytes: Uint8Array,
  settings: SingleUploadSettings,
): Promise<{ ok: true; value: ResolvedSingleUpload } | Failure> {
  const exchangeAlias = settings.exchangeAlias.trim().toUpperCase();
  const timezone = resolveExchangeTimezone(exchangeAlias);
  if (!timezone) {
    return fail(
      400,
      `Exchange "${settings.exchangeAlias}" is not supported for price history import.`,
    );
  }
  const currencyCode = await validateCurrency(
    context.client,
    settings.currencyCode,
  );
  if (!currencyCode) {
    return fail(400, "The currency is invalid or inactive.");
  }
  const parsed = parsePriceCsv(bytes, DEFAULT_PRICE_CSV_LIMITS);
  if (!parsed.ok) {
    return fail(
      parsed.code === "BYTE_LIMIT_EXCEEDED" ||
        parsed.code === "ROW_LIMIT_EXCEEDED"
        ? 400
        : 400,
      parsed.message,
    );
  }
  const evidence: PriceUploadSecurityEvidenceRow[] =
    await loadSameUserSecurityEvidenceForTicker(
      context.client,
      context.userId,
      parsed.ticker,
      currencyCode,
    );
  const resolution = resolvePriceUploadSecurity(exchangeAlias, evidence);
  if (resolution.outcome === "no_match") {
    return fail(
      404,
      `No security matching ticker "${parsed.ticker}" (${exchangeAlias}, ${currencyCode}) was found in your portfolios. Add or resolve this security before importing its price history.`,
    );
  }
  // B3: a single candidate that disagrees on exchange gets a specific,
  // correctable message (almost always the wrong exchange in the settings
  // form) -- distinct from genuine multi-candidate ambiguity below, which
  // has no single correction to suggest.
  if (resolution.outcome === "exchange_mismatch") {
    return fail(
      409,
      `Ticker "${parsed.ticker}" is held on ${resolution.heldExchangeAlias}, not ${exchangeAlias} -- check the exchange setting.`,
    );
  }
  if (resolution.outcome === "ambiguous") {
    const names = resolution.candidates
      .map((candidate) => candidate.canonicalName)
      .join(", ");
    return fail(
      409,
      `Ticker "${parsed.ticker}" matches more than one security you hold (${names}). Resolve the ambiguity before importing.`,
    );
  }
  return {
    ok: true,
    value: {
      ticker: parsed.ticker,
      timezone,
      currencyCode,
      exchangeAlias,
      securityId: resolution.securityId,
      matchedName: resolution.canonicalName,
      rows: parsed.rows,
      malformedCount: parsed.malformed.length,
    },
  };
}

export type SinglePriceUploadPreview = Readonly<{
  ticker: string;
  exchangeAlias: string;
  currencyCode: string;
  matchedSecurityId: string;
  matchedName: string;
  rowCount: number;
  malformedCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  sampleFirst: Readonly<{ marketDate: string; priceDecimal: string }> | null;
  sampleLast: Readonly<{ marketDate: string; priceDecimal: string }> | null;
}>;

function summarizeRows(rows: readonly PriceCsvDataRow[]): {
  dateFrom: string | null;
  dateTo: string | null;
  sampleFirst: SinglePriceUploadPreview["sampleFirst"];
  sampleLast: SinglePriceUploadPreview["sampleLast"];
} {
  if (rows.length === 0) {
    return {
      dateFrom: null,
      dateTo: null,
      sampleFirst: null,
      sampleLast: null,
    };
  }
  let first = rows[0]!;
  let last = rows[0]!;
  for (const row of rows) {
    if (row.marketDate < first.marketDate) first = row;
    if (row.marketDate > last.marketDate) last = row;
  }
  return {
    dateFrom: first.marketDate,
    dateTo: last.marketDate,
    sampleFirst: {
      marketDate: first.marketDate,
      priceDecimal: first.priceDecimal,
    },
    sampleLast: {
      marketDate: last.marketDate,
      priceDecimal: last.priceDecimal,
    },
  };
}

export async function previewSinglePriceUpload(
  context: PriceUploadContext,
  bytes: Uint8Array,
  settings: SingleUploadSettings,
): Promise<{ ok: true; preview: SinglePriceUploadPreview } | Failure> {
  const resolved = await parseAndResolveSingleUpload(context, bytes, settings);
  if (!resolved.ok) return resolved;
  const { value } = resolved;
  const summary = summarizeRows(value.rows);
  return {
    ok: true,
    preview: {
      ticker: value.ticker,
      exchangeAlias: value.exchangeAlias,
      currencyCode: value.currencyCode,
      matchedSecurityId: value.securityId,
      matchedName: value.matchedName,
      rowCount: value.rows.length,
      malformedCount: value.malformedCount,
      ...summary,
    },
  };
}

export type SinglePriceUploadConfirmResult = Readonly<{
  batch: PriceUploadBatchRecord;
  written: number;
}>;

export async function confirmSinglePriceUpload(
  context: PriceUploadContext,
  bytes: Uint8Array,
  settings: SingleUploadSettings,
  input: Readonly<{ filename: string; sourceLabel: string }>,
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: true; value: SinglePriceUploadConfirmResult } | Failure> {
  const resolved = await parseAndResolveSingleUpload(context, bytes, settings);
  if (!resolved.ok) return resolved;
  const { value } = resolved;
  if (value.rows.length === 0) {
    return fail(400, "No valid price rows were found in the file.");
  }
  const nowIso = now();
  const candidates: PriceUploadWriteCandidate[] = [];
  for (const row of value.rows) {
    const observationAt = deriveMidnightObservationAtUtc(
      row.marketDate,
      value.timezone,
    );
    if (!observationAt) {
      return fail(
        400,
        `Could not derive an observation time for ${row.marketDate}.`,
      );
    }
    candidates.push({
      providerId: OWNER_IMPORT_PROVIDER_ID,
      securityId: value.securityId,
      providerExchange: value.exchangeAlias,
      providerSymbol: value.ticker,
      currencyCode: value.currencyCode,
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
      observationAt,
      marketTimezone: value.timezone,
      interval: "eod",
      quality: "observed",
      adjustmentState: "raw",
      delayedMinutes: null,
    });
  }
  const batchId = randomUUID();
  await createPriceUploadBatch(context.client, {
    id: batchId,
    userId: context.userId,
    sourceLabel: sanitizeSourceLabel(input.sourceLabel),
    format: "single",
    filename: input.filename,
    rowCount: value.rows.length,
    malformedRowCount: value.malformedCount,
    now: nowIso,
  });
  const { written, insertedCount } = await writePriceUploadObservations(
    context.client,
    {
      userId: context.userId,
      uploadBatchId: batchId,
      candidates,
      now: nowIso,
    },
  );
  await updatePriceUploadBatchInsertedCount(
    context.client,
    context.userId,
    batchId,
    insertedCount,
  );
  const batches = await listPriceUploadBatches(context.client, context.userId);
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) return fail(503, "The upload could not be confirmed.");
  return { ok: true, value: { batch, written } };
}

// ---------------------------------------------------------------------------
// Backup export / re-import.
// ---------------------------------------------------------------------------

export async function exportOwnerPriceHistoryCsv(
  context: PriceUploadContext,
): Promise<string> {
  const rows = await loadOwnerPriceExportRows(context.client, context.userId);
  const exportRows: PriceBackupExportRow[] = rows.map((row) => ({
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
  }));
  return formatPriceBackupCsv(exportRows);
}

export type BackupUploadPreview = Readonly<{
  rowCount: number;
  malformedCount: number;
  /** Follow-up (1): per-reason breakdown of malformed rows (the parser
   * already classifies each one -- see `PriceBackupMalformedReason`). */
  malformedByReason: Partial<Record<PriceBackupMalformedReason, number>>;
  unresolvedRowCount: number;
  perProvider: ReadonlyArray<
    Readonly<{ providerId: string; securityCount: number; rowCount: number }>
  >;
  unresolvedSymbols: readonly string[];
  ambiguousSymbols: readonly string[];
  /** B3: single-candidate exchange disagreements, reported separately from
   * genuine multi-candidate `ambiguousSymbols` -- each entry names the
   * actually-held exchange. */
  exchangeMismatchSymbols: readonly string[];
}>;

type GroupedBackupRow = Readonly<{
  key: string;
  providerId: string;
  providerSymbol: string;
  providerExchange: string;
  currencyCode: string;
  rows: PriceBackupDataRow[];
}>;

function groupBackupRows(
  rows: readonly PriceBackupDataRow[],
): GroupedBackupRow[] {
  const groups = new Map<string, GroupedBackupRow>();
  for (const row of rows) {
    const key = `${row.providerId}|${row.providerSymbol.toUpperCase()}|${row.providerExchange.toUpperCase()}|${row.currencyCode.toUpperCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, {
        key,
        providerId: row.providerId,
        providerSymbol: row.providerSymbol,
        providerExchange: row.providerExchange,
        currencyCode: row.currencyCode,
        rows: [row],
      });
    }
  }
  return [...groups.values()];
}

type ResolvedBackupGroup = Readonly<{
  group: GroupedBackupRow;
  outcome: "matched" | "no_match" | "ambiguous" | "exchange_mismatch";
  securityId: string | null;
  /** Only set for `exchange_mismatch` -- the owner's actual held exchange,
   * for the same B3 specific-correction messaging `parseAndResolveSingleUpload`
   * uses. */
  heldExchangeAlias: string | null;
}>;

async function resolveBackupGroups(
  context: PriceUploadContext,
  groups: readonly GroupedBackupRow[],
): Promise<ResolvedBackupGroup[]> {
  const results: ResolvedBackupGroup[] = [];
  for (const group of groups) {
    const evidence = await loadSameUserSecurityEvidenceForTicker(
      context.client,
      context.userId,
      group.providerSymbol,
      group.currencyCode,
    );
    const resolution = resolvePriceUploadSecurity(
      group.providerExchange,
      evidence,
    );
    results.push({
      group,
      outcome: resolution.outcome,
      securityId:
        resolution.outcome === "matched" ? resolution.securityId : null,
      heldExchangeAlias:
        resolution.outcome === "exchange_mismatch"
          ? resolution.heldExchangeAlias
          : null,
    });
  }
  return results;
}

async function parseAndResolveBackup(
  context: PriceUploadContext,
  bytes: Uint8Array,
): Promise<
  | {
      ok: true;
      value: {
        parsedMalformedCount: number;
        malformedByReason: Partial<Record<PriceBackupMalformedReason, number>>;
        resolved: ResolvedBackupGroup[];
      };
    }
  | Failure
> {
  const parsed = parsePriceBackupCsv(bytes, DEFAULT_PRICE_BACKUP_LIMITS);
  if (!parsed.ok) return fail(400, parsed.message);
  const groups = groupBackupRows(parsed.rows);
  const resolved = await resolveBackupGroups(context, groups);
  // Follow-up (1): the parser already computes a reason per malformed row --
  // surface the breakdown rather than a single opaque count, so the owner
  // can tell "wrong format version" from "unknown provider" from "bad
  // price" without re-parsing the file themselves.
  const malformedByReason: Partial<Record<PriceBackupMalformedReason, number>> =
    {};
  for (const row of parsed.malformed) {
    malformedByReason[row.reason] = (malformedByReason[row.reason] ?? 0) + 1;
  }
  return {
    ok: true,
    value: {
      parsedMalformedCount: parsed.malformed.length,
      malformedByReason,
      resolved,
    },
  };
}

export async function previewBackupPriceUpload(
  context: PriceUploadContext,
  bytes: Uint8Array,
): Promise<{ ok: true; preview: BackupUploadPreview } | Failure> {
  const result = await parseAndResolveBackup(context, bytes);
  if (!result.ok) return result;
  const { parsedMalformedCount, malformedByReason, resolved } = result.value;
  const perProviderMap = new Map<
    string,
    { securityIds: Set<string>; rowCount: number }
  >();
  const unresolvedSymbols: string[] = [];
  const ambiguousSymbols: string[] = [];
  const exchangeMismatchSymbols: string[] = [];
  let unresolvedRowCount = 0;
  let rowCount = 0;
  for (const entry of resolved) {
    if (entry.outcome === "no_match") {
      unresolvedSymbols.push(
        `${entry.group.providerSymbol} (${entry.group.providerExchange})`,
      );
      unresolvedRowCount += entry.group.rows.length;
      continue;
    }
    if (entry.outcome === "exchange_mismatch") {
      exchangeMismatchSymbols.push(
        `${entry.group.providerSymbol}: held on ${entry.heldExchangeAlias}, not ${entry.group.providerExchange}`,
      );
      unresolvedRowCount += entry.group.rows.length;
      continue;
    }
    if (entry.outcome === "ambiguous") {
      ambiguousSymbols.push(
        `${entry.group.providerSymbol} (${entry.group.providerExchange})`,
      );
      unresolvedRowCount += entry.group.rows.length;
      continue;
    }
    rowCount += entry.group.rows.length;
    const bucket = perProviderMap.get(entry.group.providerId) ?? {
      securityIds: new Set<string>(),
      rowCount: 0,
    };
    bucket.securityIds.add(entry.securityId!);
    bucket.rowCount += entry.group.rows.length;
    perProviderMap.set(entry.group.providerId, bucket);
  }
  return {
    ok: true,
    preview: {
      rowCount,
      malformedCount: parsedMalformedCount,
      malformedByReason,
      unresolvedRowCount,
      perProvider: [...perProviderMap.entries()].map(
        ([providerId, bucket]) => ({
          providerId,
          securityCount: bucket.securityIds.size,
          rowCount: bucket.rowCount,
        }),
      ),
      unresolvedSymbols,
      ambiguousSymbols,
      exchangeMismatchSymbols,
    },
  };
}

export type BackupConfirmResult = Readonly<{
  batch: PriceUploadBatchRecord;
  written: number;
  unresolvedRowCount: number;
}>;

export async function confirmBackupPriceUpload(
  context: PriceUploadContext,
  bytes: Uint8Array,
  input: Readonly<{ filename: string }>,
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: true; value: BackupConfirmResult } | Failure> {
  const result = await parseAndResolveBackup(context, bytes);
  if (!result.ok) return result;
  const { parsedMalformedCount, resolved } = result.value;
  // exchange_mismatch groups fall through to the `unresolvedRowCount`
  // bucket below alongside no_match/ambiguous (only "matched" proceeds to
  // write) -- B3 only changes the PREVIEW message, not confirm's write
  // eligibility.
  const candidates: PriceUploadWriteCandidate[] = [];
  let unresolvedRowCount = 0;
  for (const entry of resolved) {
    if (entry.outcome !== "matched" || entry.securityId === null) {
      unresolvedRowCount += entry.group.rows.length;
      continue;
    }
    for (const row of entry.group.rows) {
      candidates.push({
        providerId: row.providerId,
        securityId: entry.securityId,
        providerExchange: row.providerExchange,
        providerSymbol: row.providerSymbol,
        currencyCode: row.currencyCode,
        marketDate: row.marketDate,
        priceDecimal: row.priceDecimal,
        observationAt: row.observationAt,
        marketTimezone: row.marketTimezone,
        interval: row.interval,
        quality: row.quality,
        adjustmentState: row.adjustmentState,
        delayedMinutes: row.delayedMinutes,
      });
    }
  }
  if (candidates.length === 0) {
    return fail(400, "No rows could be resolved to a security you hold.");
  }
  const nowIso = now();
  const batchId = randomUUID();
  await createPriceUploadBatch(context.client, {
    id: batchId,
    userId: context.userId,
    sourceLabel: "backup-reimport",
    format: "backup",
    filename: input.filename,
    rowCount: candidates.length,
    malformedRowCount: parsedMalformedCount + unresolvedRowCount,
    now: nowIso,
  });
  const { written, insertedCount } = await writePriceUploadObservations(
    context.client,
    {
      userId: context.userId,
      uploadBatchId: batchId,
      candidates,
      now: nowIso,
    },
  );
  await updatePriceUploadBatchInsertedCount(
    context.client,
    context.userId,
    batchId,
    insertedCount,
  );
  const batches = await listPriceUploadBatches(context.client, context.userId);
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) return fail(503, "The backup import could not be confirmed.");
  return { ok: true, value: { batch, written, unresolvedRowCount } };
}

export async function listOwnedPriceUploads(
  context: PriceUploadContext,
): Promise<PriceUploadBatchRecord[]> {
  return listPriceUploadBatches(context.client, context.userId);
}

export async function deleteOwnedPriceUpload(
  context: PriceUploadContext,
  batchId: string,
): Promise<{ ok: true; deletedObservations: number } | Failure> {
  const result = await deletePriceUploadBatch(
    context.client,
    context.userId,
    batchId,
  );
  if (!result.ok) return fail(404, "The upload was not found.");
  return { ok: true, deletedObservations: result.deletedObservations };
}
