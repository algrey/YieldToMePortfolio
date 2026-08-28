import { randomUUID } from "node:crypto";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  createPriceUploadBatch,
  deletePriceUploadBatch,
  listPriceUploadBatches,
  loadOwnerImportPriceObservationsForSecurity,
  loadOwnerPriceExportRows,
  loadOwnerPriceExportRowsPage,
  PRICE_EXPORT_PAGE_SIZE,
  loadSameUserSecurityEvidenceForTicker,
  updatePriceUploadBatchInsertedCount,
  writePriceUploadObservations,
  OWNER_IMPORT_PROVIDER_ID,
  type PriceUploadBatchRecord,
  type PriceUploadWriteCandidate,
} from "../db/repositories/price-uploads.ts";
import {
  DEFAULT_PRICE_CSV_LIMITS,
  filterRowsAlreadyPresent,
  validateUploadedPriceCsvPayload,
  type PriceCsvDataRow,
  type PriceCsvExistingObservation,
} from "../domain/market-data/price-csv.ts";
import {
  DEFAULT_PRICE_BACKUP_LIMITS,
  formatPriceBackupCsv,
  MAX_SOURCE_LABEL_LENGTH,
  sanitizeUploadedMalformedByReason,
  validateUploadedPriceBackupPayload,
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
import { invalidateStoredValueHistoryForSecurity } from "./historical-portfolio-value.ts";

// MKT-008: this is the ONLY layer that ever writes -- both the preview and
// confirm actions call the SAME parse-and-resolve helpers below, over the
// SAME uploaded row payload. Deliberately STATELESS between preview and
// confirm (no `price_upload_rows` staging table the way the ledger CSV flow
// uses): resolution here is pure/deterministic over the payload's own rows
// plus the owner's ALREADY-existing securities, so a preview is exactly
// "run the same read-only computation confirm is about to run, and show the
// result" -- the client resubmits the identical parsed rows (re-derived from
// the same `File` object still held in the browser, not re-selected) on
// confirm. This avoids a second staging schema for a feature whose "review"
// step has no owner judgment calls to make beyond "does this match what I
// expected" (unlike the ledger CSV flow, which stages ambiguous
// mappings/candidate securities an owner must actively resolve).
//
// IMP-010A (2026-08-25): the CSV TEXT is no longer decoded/split/classified
// here -- that now runs in the BROWSER (`historical-data-panel.tsx` imports
// `parsePriceCsv`/`parsePriceBackupCsv` from `domain/market-data/` directly,
// the SAME pure parsers this file used to call over raw bytes), which
// uploads structured, already-normalized row JSON instead of a file. This
// layer keeps FULL authority unchanged: `validateUploadedPriceCsvPayload`/
// `validateUploadedPriceBackupPayload` re-validate every field of every
// uploaded row with the EXACT SAME grammar the browser's parser enforces
// (client output is untrusted input per AGENTS.md -- a hand-crafted hostile
// payload that skips the real parser is rejected row-by-row, fail-closed,
// exactly as equivalent malformed CSV text used to be). No content-hash
// digest existed for this path before IMP-010A (idempotency here has always
// been the natural-key upsert in `writePriceUploadObservations`, not a
// file-level fingerprint -- see that function's own header comment), so
// there is no digest semantics to preserve: a re-upload of the same rows
// still upserts onto the identical `price_observations` row it always did.

// HIST-002 (the CALC-005 requeue-gap lesson): a price-history-only import
// (MKT-008's single-CSV upload, MKT-020's OHLCV variant which reuses this
// SAME confirm path, and the backup re-import below) can touch PAST dates a
// portfolio's stored value-history already cached -- see
// `app/historical-portfolio-value.ts`'s `invalidateStoredValueHistoryForSecurity`
// doc comment for why a bounded DELETE (never a recompute here) is enough
// to guarantee the next read re-derives those dates honestly, for every
// owner-scoped portfolio that holds the affected security. Grouped by
// securityId so one import touching many dates for the same security costs
// one DELETE pass per (security, portfolio) pair, not one per row.
async function invalidateValueHistoryForCandidates(
  context: PriceUploadContext,
  candidates: readonly PriceUploadWriteCandidate[],
): Promise<void> {
  const datesBySecurity = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const dates =
      datesBySecurity.get(candidate.securityId) ?? new Set<string>();
    dates.add(candidate.marketDate);
    datesBySecurity.set(candidate.securityId, dates);
  }
  for (const [securityId, dates] of datesBySecurity) {
    await invalidateStoredValueHistoryForSecurity(
      context.client,
      context.userId,
      securityId,
      [...dates],
    );
  }
}

export const DEFAULT_SOURCE_LABEL = "intelligent-investor";
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
 * Raw shape of a browser-parsed single-security upload payload -- `unknown`
 * because it arrived as untrusted JSON over the wire (the client's file
 * picker or a hostile hand-crafted request, indistinguishable at this
 * boundary). `malformedCount` is the browser parser's OWN count of rows it
 * already dropped before ever sending them -- purely informational (surfaced
 * on the batch record for the owner's "N malformed rows" disclosure), never
 * trusted for anything write-affecting; the rows that DO arrive are always
 * re-validated below regardless of what this number claims.
 */
export type SinglePriceUploadPayload = Readonly<{
  ticker: unknown;
  rows: unknown;
  malformedCount?: unknown;
}>;

/**
 * Validates `payload` as a browser-parsed single-security price-CSV upload
 * and resolves its ticker against the owner's OWN securities -- shared by
 * preview and confirm (see this file's header comment). Never writes.
 */
async function parseAndResolveSingleUpload(
  context: PriceUploadContext,
  payload: SinglePriceUploadPayload,
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
  const parsed = validateUploadedPriceCsvPayload(
    payload,
    DEFAULT_PRICE_CSV_LIMITS,
  );
  if (!parsed.ok) {
    return fail(400, parsed.message);
  }
  const clientMalformedCount =
    typeof payload.malformedCount === "number" &&
    Number.isInteger(payload.malformedCount) &&
    payload.malformedCount >= 0
      ? payload.malformedCount
      : 0;
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
      // The batch-level malformed count is the browser's own count (rows
      // it already dropped before sending, informational only) PLUS any
      // rows this server-side re-validation additionally rejected (only
      // ever non-zero for a hostile payload that skipped the real
      // browser parser -- an honest upload's `parsed.malformed` is always
      // empty here, since the browser already filtered).
      malformedCount: clientMalformedCount + parsed.malformed.length,
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
  /** EFF-001 (measure 2, "delta-upload"): the matched security's OWN
   * existing owner-import (date, price) observations
   * (`loadOwnerImportPriceObservationsForSecurity`) -- the client uses this
   * to decide which of `rows` are worth SENDING on confirm ("N identical
   * row(s) already present -- skipped"), never as a server-enforced filter
   * (the confirm write path accepts whatever rows arrive regardless).
   * Review B1 fix: carries `closeDecimal`, not just the date, so a
   * CORRECTED price for an already-covered date is never mistaken for a
   * duplicate -- see `domain/market-data/price-csv.ts`'s
   * `filterRowsAlreadyPresent` header comment for the exact-match rule. */
  existingObservations: readonly PriceCsvExistingObservation[];
  /** How many of THIS preview's `rows` are EXACT (date, price) duplicates of
   * an entry in `existingObservations` -- computed here so the client never
   * has to re-derive the same count from the (potentially large)
   * observation list twice. */
  identicalCount: number;
  /** Review B2: the explicit "X row(s) will be written" figure --
   * `rowCount - identicalCount` -- so the owner sees the actual write-budget
   * cost before confirming, not just the pieces it is derived from. */
  rowsToWriteCount: number;
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
  payload: SinglePriceUploadPayload,
  settings: SingleUploadSettings,
): Promise<{ ok: true; preview: SinglePriceUploadPreview } | Failure> {
  const resolved = await parseAndResolveSingleUpload(
    context,
    payload,
    settings,
  );
  if (!resolved.ok) return resolved;
  const { value } = resolved;
  const summary = summarizeRows(value.rows);
  // EFF-001 (measure 2): the security is already resolved at this point --
  // reads this security's OWN existing owner-import (date, price)
  // observations so the client can show "N identical row(s) already present
  // -- skipped" and filter its confirm payload down to only the rows that
  // are not exact duplicates (B1 fix: a corrected price is never dropped).
  const existingObservations =
    await loadOwnerImportPriceObservationsForSecurity(
      context.client,
      context.userId,
      value.securityId,
    );
  const { identicalCount } = filterRowsAlreadyPresent(
    value.rows,
    existingObservations,
  );
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
      existingObservations,
      identicalCount,
      rowsToWriteCount: value.rows.length - identicalCount,
    },
  };
}

export type SinglePriceUploadConfirmResult = Readonly<{
  batch: PriceUploadBatchRecord;
  written: number;
  /** EFF-001 (measure 3): rows this confirm matched but did NOT write
   * because every value column was already identical to the stored row
   * (`writePriceUploadObservations`'s `DO UPDATE ... WHERE` guard). */
  unchangedCount: number;
}>;

export async function confirmSinglePriceUpload(
  context: PriceUploadContext,
  payload: SinglePriceUploadPayload,
  settings: SingleUploadSettings,
  input: Readonly<{ filename: string; sourceLabel: string }>,
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: true; value: SinglePriceUploadConfirmResult } | Failure> {
  const resolved = await parseAndResolveSingleUpload(
    context,
    payload,
    settings,
  );
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
  const { written, insertedCount, unchangedCount } =
    await writePriceUploadObservations(context.client, {
      userId: context.userId,
      uploadBatchId: batchId,
      candidates,
      now: nowIso,
    });
  await updatePriceUploadBatchInsertedCount(
    context.client,
    context.userId,
    batchId,
    insertedCount,
  );
  // HIST-002: invalidate any stored value-history rows this import's dates
  // may have touched -- see `invalidateValueHistoryForCandidates`'s header
  // comment. Runs even when every candidate turned out EFF-001-unchanged
  // (cheap, idempotent DELETEs of rows that may not exist).
  await invalidateValueHistoryForCandidates(context, candidates);
  const batches = await listPriceUploadBatches(context.client, context.userId);
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) return fail(503, "The upload could not be confirmed.");
  return { ok: true, value: { batch, written, unchangedCount } };
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

export async function exportOwnerPriceHistoryPage(
  context: PriceUploadContext,
  offset: number,
): Promise<{
  rows: PriceBackupExportRow[];
  nextOffset: number | null;
}> {
  const rows = await loadOwnerPriceExportRowsPage(
    context.client,
    context.userId,
    offset,
    PRICE_EXPORT_PAGE_SIZE,
  );
  return {
    rows,
    nextOffset:
      rows.length === PRICE_EXPORT_PAGE_SIZE ? offset + rows.length : null,
  };
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

/**
 * Raw shape of a browser-parsed backup-restore upload payload -- `unknown`
 * because it arrived as untrusted JSON over the wire (see
 * `SinglePriceUploadPayload`'s identical rationale above).
 * `malformedByReason` is the browser parser's OWN per-reason breakdown of
 * rows it already dropped before ever sending them -- informational only
 * (`sanitizeUploadedMalformedByReason` strips anything that isn't a
 * recognised reason with a non-negative integer count).
 */
export type BackupPriceUploadPayload = Readonly<{
  rows: unknown;
  malformedByReason?: unknown;
}>;

async function parseAndResolveBackup(
  context: PriceUploadContext,
  payload: BackupPriceUploadPayload,
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
  const parsed = validateUploadedPriceBackupPayload(
    payload,
    DEFAULT_PRICE_BACKUP_LIMITS,
  );
  if (!parsed.ok) return fail(400, parsed.message);
  const groups = groupBackupRows(parsed.rows);
  const resolved = await resolveBackupGroups(context, groups);
  // Follow-up (1): the parser already computes a reason per malformed row --
  // surface the breakdown rather than a single opaque count, so the owner
  // can tell "wrong format version" from "unknown provider" from "bad
  // price" without re-parsing the file themselves. Starts from the
  // browser's own (sanitized, informational) breakdown and adds anything
  // this server-side re-validation ALSO rejected (only ever non-zero for a
  // hostile payload that skipped the real browser parser).
  const malformedByReason: Partial<Record<PriceBackupMalformedReason, number>> =
    sanitizeUploadedMalformedByReason(payload.malformedByReason);
  for (const row of parsed.malformed) {
    malformedByReason[row.reason] = (malformedByReason[row.reason] ?? 0) + 1;
  }
  const parsedMalformedCount = Object.values(malformedByReason).reduce(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  return {
    ok: true,
    value: {
      parsedMalformedCount,
      malformedByReason,
      resolved,
    },
  };
}

export async function previewBackupPriceUpload(
  context: PriceUploadContext,
  payload: BackupPriceUploadPayload,
): Promise<{ ok: true; preview: BackupUploadPreview } | Failure> {
  const result = await parseAndResolveBackup(context, payload);
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
  /** EFF-001 (measure 3): see `SinglePriceUploadConfirmResult.unchangedCount` --
   * the SAME write path, so a backup re-import of already-identical rows
   * gets the same write-avoidance for free. */
  unchangedCount: number;
}>;

export async function confirmBackupPriceUpload(
  context: PriceUploadContext,
  payload: BackupPriceUploadPayload,
  input: Readonly<{ filename: string }>,
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: true; value: BackupConfirmResult } | Failure> {
  const result = await parseAndResolveBackup(context, payload);
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
  const { written, insertedCount, unchangedCount } =
    await writePriceUploadObservations(context.client, {
      userId: context.userId,
      uploadBatchId: batchId,
      candidates,
      now: nowIso,
    });
  await updatePriceUploadBatchInsertedCount(
    context.client,
    context.userId,
    batchId,
    insertedCount,
  );
  // HIST-002: see `confirmSinglePriceUpload`'s identical call.
  await invalidateValueHistoryForCandidates(context, candidates);
  const batches = await listPriceUploadBatches(context.client, context.userId);
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) return fail(503, "The backup import could not be confirmed.");
  return {
    ok: true,
    value: { batch, written, unresolvedRowCount, unchangedCount },
  };
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
