import { randomUUID } from "node:crypto";
import {
  buildLedgerPostingStatements,
  type LedgerPostingPersistenceInput,
} from "./ledger.ts";
import { createAuditInsertStatement } from "./audit.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import { prepareLedgerPosting } from "../../domain/ledger/posting.ts";
import {
  SUPPORTED_IMPORT_PARSER_VERSIONS,
  buildImportReview,
  type ImportPreviewSecurityCandidate,
  type NormalizedImportRow,
} from "../../domain/imports/index.ts";
import { createOwnedImportStagingRepository } from "./import-staging.ts";
import { createOwnedImportMappingDecisionRepository } from "./import-mapping-decisions.ts";
import { createOwnedPortfolioRepository } from "./owned-portfolios.ts";
import { buildDividendManualRecordImportInsertStatements } from "./dividends.ts";
import {
  SHARESIGHT_SYNC_PARSER_FORMAT,
  SHARESIGHT_SYNC_PARSER_VERSION,
} from "../../domain/sharesight-sync/index.ts";

// BRK-005: mirrors `app/import-ready-service.ts`'s identical widening of the
// CSV parser's `(parserFormat, parserVersion)` allowlist by exactly one
// additional pair -- see that module's `isSupportedImportBatchFormat` for
// the full rationale. Everything else in commit's own revalidation
// (persisted issue/row/mapping state) is untouched and applies identically.
function isSupportedImportBatchFormat(
  parserFormat: string,
  parserVersion: string,
): boolean {
  if (parserFormat === "strict-versioned-csv") {
    return SUPPORTED_IMPORT_PARSER_VERSIONS.includes(parserVersion);
  }
  if (parserFormat === SHARESIGHT_SYNC_PARSER_FORMAT) {
    return parserVersion === SHARESIGHT_SYNC_PARSER_VERSION;
  }
  return false;
}

const DEFAULT_CHUNK_SIZE = 2;
const MAX_CHUNK_SIZE = 2;
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

export const IMPORT_COMMIT_LIMITS = {
  maxChunkSize: MAX_CHUNK_SIZE,
  maxStatementsPerChunk: 50,
  maxParametersPerStatement: 100,
  maxQueriesPerInvocation: 50,
  maxChunksPerInvocation: 1,
  maxAffectedPortfolios: 25,
} as const;

export type ImportCommitInput = {
  expectedVersion: number;
  expectedPreviewVersion: string;
  idempotencyKey: string;
  confirmation: boolean;
  requestId: string;
};

export type ImportCommitOptions = {
  chunkSize?: number;
  now?: () => string;
  failAtChunk?: number;
};

export type ImportCommitSuccess = {
  ok: true;
  batchId: string;
  status: "committing" | "committed";
  resumed: boolean;
  idempotent: boolean;
  highWaterRow: number;
  committedRows: number;
  skippedRows: number;
  // IMP-008: the subset of `skippedRows` that were skipped because the
  // OWNER excluded them pre-commit (as opposed to a duplicate/blank/
  // unsupported-row skip) -- "N rows excluded by owner" in commit metadata
  // and batch history, per the Orchestrator ruling.
  excludedByOwnerRows: number;
  rebuildJobId: string | null;
  rebuildJobIds: string[];
};

export type ImportCommitFailure = {
  ok: false;
  reason:
    | "not_found"
    | "confirmation_required"
    | "invalid_idempotency_key"
    | "stale_preview"
    | "revalidation_failed"
    | "not_ready"
    | "conflict"
    | "mapping_incomplete"
    | "atomic_failure"
    | "injected_failure";
  resumable?: boolean;
};

export type ImportCommitResult = ImportCommitSuccess | ImportCommitFailure;

type BatchState = {
  id: string;
  targetPortfolioId: string | null;
  status: string;
  version: number;
  commitIdempotencyKey: string | null;
  commitHighWaterRow: number;
};

type StagedRow = {
  id: string;
  batchId: string;
  physicalRowNumber: number;
  rowClass: string;
  normalizedFieldsJson: string | null;
  normalizedFingerprint: string | null;
  validationStatus: string;
  targetPortfolioId: string | null;
  targetPortfolioSecurityId: string | null;
  commitStatus: string;
  excludedByOwnerAt: string | null;
};

function nowIso(now: () => string): string {
  return now();
}

function parseNormalized(value: string | null): NormalizedImportRow | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as NormalizedImportRow)
      : null;
  } catch {
    return null;
  }
}

function multiplyDecimal(left: string, right: string): string | null {
  if (!DECIMAL.test(left) || !DECIMAL.test(right)) return null;
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  let coefficient =
    BigInt(`${leftWhole}${leftFraction}`) *
    BigInt(`${rightWhole}${rightFraction}`);
  let scale = leftFraction.length + rightFraction.length;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function invertDecimal(value: string): string | null {
  if (!DECIMAL.test(value) || value === "0") return null;
  const [whole, fraction = ""] = value.split(".");
  const denominator = BigInt(`${whole}${fraction}`);
  const scale = 18;
  const numerator = 10n ** BigInt(scale + fraction.length);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  const digits = rounded.toString().padStart(scale + 1, "0");
  let result = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  result = result.replace(/0+$/, "").replace(/\.$/, "");
  return result || "0";
}

function mapRows(rows: Record<string, unknown>[]): StagedRow[] {
  return rows.map((row) => ({
    id: String(row.id),
    batchId: String(row.batch_id),
    physicalRowNumber: Number(row.physical_row_number),
    rowClass: String(row.row_class),
    normalizedFieldsJson:
      row.normalized_fields_json === null
        ? null
        : String(row.normalized_fields_json),
    normalizedFingerprint:
      row.normalized_fingerprint === null
        ? null
        : String(row.normalized_fingerprint),
    validationStatus: String(row.validation_status),
    targetPortfolioId:
      row.target_portfolio_id === null ? null : String(row.target_portfolio_id),
    targetPortfolioSecurityId:
      row.target_portfolio_security_id === null
        ? null
        : String(row.target_portfolio_security_id),
    commitStatus: String(row.commit_status),
    excludedByOwnerAt:
      row.excluded_by_owner_at === null
        ? null
        : String(row.excluded_by_owner_at),
  }));
}

function batchFromRow(row: Record<string, unknown>): BatchState {
  return {
    id: String(row.id),
    targetPortfolioId:
      row.target_portfolio_id === null ? null : String(row.target_portfolio_id),
    status: String(row.status),
    version: Number(row.version),
    commitIdempotencyKey:
      row.commit_idempotency_key === null
        ? null
        : String(row.commit_idempotency_key),
    commitHighWaterRow: Number(row.commit_high_water_row),
  };
}

function isValidCommitKey(value: string): boolean {
  return value.length > 0 && value.length <= 120 && !/[\u0000\r\n]/.test(value);
}

function isBoundedAtomicUnit(statements: readonly SqlStatement[]): boolean {
  return (
    statements.length <= IMPORT_COMMIT_LIMITS.maxStatementsPerChunk &&
    statements.every(
      (statement) =>
        (statement.params?.length ?? 0) <=
        IMPORT_COMMIT_LIMITS.maxParametersPerStatement,
    )
  );
}

export function createOwnedImportCommitRepository(
  client: SqlClient,
  options: ImportCommitOptions = {},
) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const now = options.now ?? (() => new Date().toISOString());
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > MAX_CHUNK_SIZE
  ) {
    throw new Error("invalid_import_commit_chunk_size");
  }

  async function loadBatch(
    userId: string,
    batchId: string,
  ): Promise<BatchState | null> {
    const row = await client.get<Record<string, unknown>>(
      `SELECT id, target_portfolio_id, status, version, commit_idempotency_key,
              commit_high_water_row
       FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1`,
      [batchId, userId],
    );
    return row ? batchFromRow(row) : null;
  }

  async function revalidate(
    userId: string,
    batchId: string,
  ): Promise<
    | {
        ok: true;
        previewVersion: string;
        targets: Readonly<
          Record<
            string,
            {
              portfolioId: string;
              portfolioSecurityId: string | null;
              fxDirection: "native_to_home" | "home_to_native" | null;
            }
          >
        >;
        skippedRowIds: ReadonlySet<string>;
        state: {
          rowCount: number;
          rowVersionTotal: number;
          issueCount: number;
          issueVersionTotal: number;
          mappingCount: number;
          mappingVersionTotal: number;
        };
      }
    | { ok: false; reason: "not_found" | "revalidation_failed" }
  > {
    const staging = createOwnedImportStagingRepository(client);
    const ownedBatch = await staging.get(userId, batchId);
    if (!ownedBatch) return { ok: false, reason: "not_found" };
    const [rows, issues, mappings, portfolios, candidateRows] =
      await Promise.all([
        staging.listRows(userId, batchId),
        staging.listIssues(userId, batchId),
        createOwnedImportMappingDecisionRepository(client).list(
          userId,
          batchId,
        ),
        createOwnedPortfolioRepository(client).list(userId),
        client.all<Record<string, unknown>>(
          `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
                  source_currency_code, security_id
           FROM portfolio_securities
           WHERE user_id = ?
           ORDER BY source_symbol ASC, id ASC`,
          [userId],
        ),
      ]);
    const securityCandidates: ImportPreviewSecurityCandidate[] =
      candidateRows.map((row) => ({
        id: String(row.id),
        portfolioId: String(row.portfolio_id),
        sourceSymbol: String(row.source_symbol),
        sourceExchangeAlias:
          row.source_exchange_alias === null
            ? null
            : String(row.source_exchange_alias),
        sourceCurrencyCode: String(row.source_currency_code),
        securityId: row.security_id === null ? null : String(row.security_id),
      }));
    const built = buildImportReview({
      batch: ownedBatch,
      rows,
      issues,
      mappings,
      portfolios: portfolios.map((portfolio) => ({
        id: portfolio.id,
        name: portfolio.name,
        homeCurrencyCode: portfolio.homeCurrencyCode,
        historyCompleteFrom: portfolio.historyCompleteFrom,
      })),
      securityCandidates,
    });
    // IMP-008: rows the owner excluded pre-commit never block revalidation
    // -- their own persisted validation state and any error-severity issue
    // linked to them (e.g. SHARESIGHT_PAYOUT_KEY_COLLISION) are excluded
    // from every check below. A batch-level issue (`rowId === null`) is
    // untouched by row exclusion, per the Orchestrator ruling; a row-linked
    // issue only stops blocking once ITS OWN row is excluded (both rows of
    // a colliding pair carry independent copies of the issue -- see
    // `domain/sharesight-sync/transform.ts` -- so excluding only one leaves
    // the other's copy still blocking, exactly as intended).
    const excludedRowIds = new Set(
      rows.filter((row) => row.excludedByOwnerAt !== null).map((row) => row.id),
    );
    const hasBlockingPersistedState =
      !isSupportedImportBatchFormat(
        ownedBatch.parserFormat,
        ownedBatch.parserVersion,
      ) ||
      issues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.resolvedAt === null &&
          (issue.rowId === null || !excludedRowIds.has(issue.rowId)),
      ) ||
      rows.some(
        (row) =>
          row.excludedByOwnerAt === null &&
          (row.validationStatus === "invalid" ||
            row.errorCount > 0 ||
            (row.rowClass === "transaction" &&
              built.preview.resolvedTargets[row.id] === undefined &&
              !built.preview.issues.some(
                (issue) =>
                  issue.rowId === row.id && issue.code === "DUPLICATE_ROW",
              ))),
      );
    if (!built.preview.ready || hasBlockingPersistedState) {
      return { ok: false, reason: "revalidation_failed" };
    }
    return {
      ok: true,
      previewVersion: built.previewVersion,
      targets: built.preview.resolvedTargets,
      skippedRowIds: new Set(
        built.preview.issues
          .filter((issue) => issue.code === "DUPLICATE_ROW")
          .flatMap((issue) => (issue.rowId ? [issue.rowId] : [])),
      ),
      state: {
        rowCount: rows.length,
        rowVersionTotal: rows.reduce((total, row) => total + row.version, 0),
        issueCount: issues.length,
        issueVersionTotal: issues.reduce(
          (total, issue) => total + issue.version,
          0,
        ),
        mappingCount: mappings.length,
        mappingVersionTotal: mappings.reduce(
          (total, mapping) => total + mapping.version,
          0,
        ),
      },
    };
  }

  async function summary(
    userId: string,
    batchId: string,
    batch: BatchState,
    resumed: boolean,
    idempotent: boolean,
  ): Promise<ImportCommitSuccess> {
    const counts = await client.get<Record<string, unknown>>(
      `SELECT
         SUM(CASE WHEN commit_status = 'committed' THEN 1 ELSE 0 END) AS committed_rows,
         SUM(CASE WHEN commit_status = 'skipped' THEN 1 ELSE 0 END) AS skipped_rows,
         SUM(CASE WHEN commit_status = 'skipped' AND excluded_by_owner_at IS NOT NULL
              THEN 1 ELSE 0 END) AS excluded_by_owner_rows
       FROM import_rows WHERE user_id = ? AND batch_id = ?`,
      [userId, batchId],
    );
    const jobs = await client.all<{ id: string }>(
      `SELECT id FROM calculation_runs
       WHERE user_id = ? AND reason = 'import_commit' AND invalidation_source = ?
       ORDER BY portfolio_id ASC, id ASC`,
      [userId, batchId],
    );
    const rebuildJobIds = jobs.map((job) => String(job.id));
    return {
      ok: true,
      batchId,
      status: batch.status === "committed" ? "committed" : "committing",
      resumed,
      idempotent,
      highWaterRow: batch.commitHighWaterRow,
      committedRows: Number(counts?.committed_rows ?? 0),
      skippedRows: Number(counts?.skipped_rows ?? 0),
      excludedByOwnerRows: Number(counts?.excluded_by_owner_rows ?? 0),
      rebuildJobId: rebuildJobIds[0] ?? null,
      rebuildJobIds,
    };
  }

  async function resolveInput(
    userId: string,
    batch: BatchState,
    row: StagedRow,
    commitKey: string,
    requestId: string,
    target: {
      portfolioId: string;
      portfolioSecurityId: string | null;
      fxDirection: "native_to_home" | "home_to_native" | null;
    },
  ): Promise<
    | {
        ok: true;
        kind: "ledger";
        input: LedgerPostingPersistenceInput;
        sourceReference: string;
      }
    | {
        ok: true;
        kind: "dividend";
        recordId: string;
        statements: SqlStatement[];
        sourceReference: string;
      }
    | { ok: false; reason: "mapping_incomplete" }
  > {
    const normalized = parseNormalized(row.normalizedFieldsJson);
    if (!normalized || !normalized.tradeAtUtc || !normalized.localTradeDate) {
      return { ok: false, reason: "mapping_incomplete" };
    }
    const portfolioId = target.portfolioId;
    if (!portfolioId || !normalized.currency) {
      return { ok: false, reason: "mapping_incomplete" };
    }
    const portfolio = await client.get<{ base_currency_code: string }>(
      `SELECT base_currency_code FROM portfolios
       WHERE id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
      [portfolioId, userId],
    );
    if (!portfolio) return { ok: false, reason: "mapping_incomplete" };
    const isCash = normalized.cashEvent !== null;
    if (!isCash && !target.portfolioSecurityId) {
      return { ok: false, reason: "mapping_incomplete" };
    }
    if (!isCash) {
      const membership = await client.get<{ id: string }>(
        `SELECT id FROM portfolio_securities
         WHERE id = ? AND user_id = ? AND portfolio_id = ?
           AND status <> 'unresolved' AND security_id IS NOT NULL LIMIT 1`,
        [target.portfolioSecurityId, userId, portfolioId],
      );
      if (!membership) return { ok: false, reason: "mapping_incomplete" };
    }

    const sourceReference = `import-fingerprint:${row.normalizedFingerprint ?? row.id}`;

    // Dividend rows never post through the ledger: they create a
    // `dividend_manual_records` row (see `buildDividendManualRecordImportInsertStatements`
    // for why not `dividend_receipts`), never touch cost basis/lots/cash,
    // and skip FX resolution entirely (the row stores native per-share OR
    // native totals amounts only). Built as statements, not executed here,
    // so the caller can fold them into the same atomic chunk as the
    // `import_rows` update.
    if (normalized.type === "dividend") {
      if (!target.portfolioSecurityId) {
        return { ok: false, reason: "mapping_incomplete" };
      }
      // BRK-005: a totals-only Sharesight payout row carries
      // `normalized.totalCashDecimal` and never a per-share amount (see
      // `NormalizedImportRow`'s header note); every CSV-imported dividend
      // row is the reverse. The two modes are mutually exclusive by
      // construction (the transform/parser that built this row's
      // `normalized` fields never sets both), so this signal alone decides
      // which insert shape to build -- never guessing/deriving one from the
      // other.
      const built =
        (normalized.totalCashDecimal ?? null) !== null
          ? buildDividendManualRecordImportInsertStatements({
              userId,
              portfolioId,
              portfolioSecurityId: target.portfolioSecurityId,
              paymentDate: normalized.localTradeDate,
              totalCashDecimal: normalized.totalCashDecimal ?? null,
              totalFrankingDecimal: normalized.totalFrankingDecimal ?? null,
              importBatchId: batch.id,
              sourceReference,
              requestId,
              now: nowIso(now),
            })
          : buildDividendManualRecordImportInsertStatements({
              userId,
              portfolioId,
              portfolioSecurityId: target.portfolioSecurityId,
              paymentDate: normalized.localTradeDate,
              sharesDecimal: normalized.sharesOwned ?? "",
              dividendPerShareDecimal: normalized.costPerShare ?? "",
              frankingCreditPerShareDecimal:
                normalized.frankingPerShare ?? null,
              importBatchId: batch.id,
              sourceReference,
              requestId,
              now: nowIso(now),
            });
      if (!built.ok) return { ok: false, reason: "mapping_incomplete" };
      return {
        ok: true,
        kind: "dividend",
        recordId: built.id,
        statements: built.statements,
        sourceReference,
      };
    }

    let fxRate: string | null = null;
    let fxRateSource: string | null = null;
    if (
      normalized.purchaseExchangeRate !== null &&
      normalized.currency !== portfolio.base_currency_code
    ) {
      if (
        target.fxDirection !== "native_to_home" &&
        target.fxDirection !== "home_to_native"
      ) {
        return { ok: false, reason: "mapping_incomplete" };
      }
      fxRate =
        target.fxDirection === "native_to_home"
          ? normalized.purchaseExchangeRate
          : invertDecimal(normalized.purchaseExchangeRate);
      if (!fxRate) return { ok: false, reason: "mapping_incomplete" };
      fxRateSource = "csv_import";
    } else if (normalized.currency !== portfolio.base_currency_code) {
      fxRateSource = null;
    }
    const type = normalized.cashEvent ?? normalized.type;
    if (!type) return { ok: false, reason: "mapping_incomplete" };
    const gross =
      normalized.cashEvent !== null
        ? multiplyDecimal(
            normalized.sharesOwned ?? "",
            normalized.costPerShare ?? "",
          )
        : null;
    if (normalized.cashEvent !== null && !gross) {
      return { ok: false, reason: "mapping_incomplete" };
    }
    return {
      ok: true,
      kind: "ledger",
      sourceReference,
      input: {
        portfolioId,
        type,
        portfolioSecurityId: isCash ? null : target.portfolioSecurityId,
        quantityDecimal: isCash ? null : normalized.sharesOwned,
        unitPriceDecimal: isCash ? null : normalized.costPerShare,
        grossAmountDecimal: gross,
        feeAmountDecimal: normalized.commission ?? "0",
        taxAmountDecimal: "0",
        fxRateToBaseDecimal: fxRate,
        fxRateSource,
        fxObservedAt: fxRate === null ? null : normalized.tradeAtUtc,
        sourceType: "csv_import",
        idempotencyKey: `import:${batch.id}:${commitKey}:${row.id}`,
        tradeAt: normalized.tradeAtUtc,
        localTradeDate: normalized.localTradeDate,
        currencyCode: normalized.currency,
        sourceReference,
        importRowId: row.id,
        requestId,
        calculationVersion: 1,
      },
    };
  }

  async function finalize(
    userId: string,
    batch: BatchState,
    commitKey: string,
    nowAt: string,
    requestId: string,
  ): Promise<ImportCommitResult> {
    const affected = await client.all<Record<string, unknown>>(
      `SELECT t.portfolio_id, MIN(t.local_trade_date) AS range_from,
              MAX(t.local_trade_date) AS range_to, COUNT(*) AS committed_count,
              (SELECT latest.id FROM transactions latest
               WHERE latest.user_id = ? AND latest.portfolio_id = t.portfolio_id
                 AND latest.status IN ('posted', 'reversed')
               ORDER BY latest.trade_at DESC, latest.id DESC LIMIT 1) AS ledger_high_water
       FROM import_rows r
       JOIN transactions t ON t.id = r.commit_transaction_id
         AND t.user_id = r.user_id
       WHERE r.user_id = ? AND r.batch_id = ? AND r.commit_status = 'committed'
       GROUP BY t.portfolio_id
       ORDER BY t.portfolio_id ASC
       LIMIT ?`,
      [
        userId,
        userId,
        batch.id,
        IMPORT_COMMIT_LIMITS.maxAffectedPortfolios + 1,
      ],
    );
    if (affected.length > IMPORT_COMMIT_LIMITS.maxAffectedPortfolios) {
      return { ok: false, reason: "revalidation_failed" };
    }
    const committedRowCount = affected.reduce(
      (total, row) => total + Number(row.committed_count),
      0,
    );
    const statements: SqlStatement[] = affected.map((row) => {
      const portfolioId = String(row.portfolio_id);
      const ledgerHighWater = String(row.ledger_high_water);
      const rebuildJobId = `import-rebuild:${batch.id}:${portfolioId}:${commitKey}`;
      return {
        sql: `INSERT INTO calculation_runs (
          id, user_id, portfolio_id, range_from, range_to, calculation_version,
          reason, invalidation_source, status, attempt, ledger_high_water_start,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'import_commit', ?, 'queued', 0, ?, ?, ?, ?)
        ON CONFLICT (user_id, portfolio_id, calculation_version, idempotency_key) DO NOTHING`,
        params: [
          rebuildJobId,
          userId,
          portfolioId,
          String(row.range_from),
          String(row.range_to),
          batch.id,
          ledgerHighWater,
          rebuildJobId,
          nowAt,
          nowAt,
        ],
      };
    });
    statements.push(
      createAuditInsertStatement(
        {
          actorUserId: userId,
          targetOwnerUserId: userId,
          action: "import.commit",
          targetType: "import_batch",
          targetId: batch.id,
          requestId,
          result: "success",
          metadata: {
            committedRowCount,
            affectedPortfolioCount: affected.length,
          },
          occurredAt: nowAt,
        },
        () => nowAt,
      ),
      {
        sql: `UPDATE import_batches
          SET status = 'committed', committed_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND status = 'committing'
            AND commit_idempotency_key = ?
            AND NOT EXISTS (
              SELECT 1 FROM import_rows
              WHERE batch_id = ? AND user_id = ? AND row_class = 'transaction'
                AND commit_status = 'staged'
            )`,
        params: [nowAt, nowAt, batch.id, userId, commitKey, batch.id, userId],
      },
    );
    if (!isBoundedAtomicUnit(statements)) {
      return { ok: false, reason: "atomic_failure", resumable: true };
    }
    try {
      await client.batch(statements);
    } catch {
      return { ok: false, reason: "atomic_failure", resumable: true };
    }
    const completed = await loadBatch(userId, batch.id);
    if (!completed || completed.status !== "committed") {
      return { ok: false, reason: "atomic_failure", resumable: true };
    }
    return summary(userId, batch.id, completed, true, false);
  }

  return {
    async validate(
      userId: string,
      batchId: string,
    ): Promise<
      | { ok: true; previewVersion: string }
      | { ok: false; reason: "not_found" | "revalidation_failed" }
    > {
      const validation = await revalidate(userId, batchId);
      return validation.ok
        ? { ok: true, previewVersion: validation.previewVersion }
        : validation;
    },
    async commit(
      userId: string,
      batchId: string,
      input: ImportCommitInput,
    ): Promise<ImportCommitResult> {
      if (!input.confirmation)
        return { ok: false, reason: "confirmation_required" };
      if (!isValidCommitKey(input.idempotencyKey))
        return { ok: false, reason: "invalid_idempotency_key" };
      const initialBatch = await loadBatch(userId, batchId);
      if (!initialBatch) return { ok: false, reason: "not_found" };
      let batch: BatchState = initialBatch;
      if (batch.status === "committed") {
        return batch.commitIdempotencyKey === input.idempotencyKey
          ? summary(userId, batch.id, batch, true, true)
          : { ok: false, reason: "conflict" };
      }
      if (batch.status !== "ready" && batch.status !== "committing") {
        return { ok: false, reason: "not_ready" };
      }
      const validation = await revalidate(userId, batch.id);
      if (!validation.ok) return validation;
      if (batch.status === "ready") {
        if (
          batch.version !== input.expectedVersion ||
          input.expectedPreviewVersion !== validation.previewVersion
        ) {
          return { ok: false, reason: "stale_preview" };
        }
        const changed = await client.run(
          `UPDATE import_batches SET status = 'committing', commit_idempotency_key = ?,
             updated_at = ?, version = version + 1
           WHERE id = ? AND user_id = ? AND status = 'ready' AND version = ?
             AND commit_idempotency_key IS NULL
             AND (SELECT COUNT(*) FROM import_rows
                  WHERE batch_id = ? AND user_id = ?) = ?
             AND (SELECT COALESCE(SUM(version), 0) FROM import_rows
                  WHERE batch_id = ? AND user_id = ?) = ?
             AND (SELECT COUNT(*) FROM import_issues
                  WHERE batch_id = ? AND user_id = ?) = ?
             AND (SELECT COALESCE(SUM(version), 0) FROM import_issues
                  WHERE batch_id = ? AND user_id = ?) = ?
             AND (SELECT COUNT(*) FROM import_mapping_decisions
                  WHERE batch_id = ? AND user_id = ?) = ?
             AND (SELECT COALESCE(SUM(version), 0) FROM import_mapping_decisions
                  WHERE batch_id = ? AND user_id = ?) = ?`,
          [
            input.idempotencyKey,
            nowIso(now),
            batch.id,
            userId,
            input.expectedVersion,
            batch.id,
            userId,
            validation.state.rowCount,
            batch.id,
            userId,
            validation.state.rowVersionTotal,
            batch.id,
            userId,
            validation.state.issueCount,
            batch.id,
            userId,
            validation.state.issueVersionTotal,
            batch.id,
            userId,
            validation.state.mappingCount,
            batch.id,
            userId,
            validation.state.mappingVersionTotal,
          ],
        );
        if (changed.changes !== 1)
          return { ok: false, reason: "stale_preview" };
        batch = (await loadBatch(userId, batchId)) as BatchState;
      } else if (batch.commitIdempotencyKey !== input.idempotencyKey) {
        return { ok: false, reason: "conflict" };
      }

      const pending = mapRows(
        await client.all<Record<string, unknown>>(
          `SELECT id, batch_id, physical_row_number, row_class, normalized_fields_json,
                  normalized_fingerprint, validation_status, target_portfolio_id,
                  target_portfolio_security_id, commit_status, excluded_by_owner_at
           FROM import_rows WHERE user_id = ? AND batch_id = ?
             AND physical_row_number > ? AND commit_status = 'staged'
           ORDER BY physical_row_number ASC, id ASC LIMIT ?`,
          [userId, batch.id, batch.commitHighWaterRow, chunkSize],
        ),
      );
      let chunkIndex = Number(
        (
          await client.get<{ count: number }>(
            `SELECT count(*) AS count FROM import_commit_chunks WHERE user_id = ? AND batch_id = ?`,
            [userId, batch.id],
          )
        )?.count ?? 0,
      );
      const seenSourceReferences = new Set<string>();
      for (let offset = 0; offset < pending.length; offset += chunkSize) {
        const chunk = pending.slice(offset, offset + chunkSize);
        if (options.failAtChunk === chunkIndex)
          return { ok: false, reason: "injected_failure", resumable: true };
        const statements: SqlStatement[] = [];
        let committedRowCount = 0;
        for (const row of chunk) {
          // IMP-008: an owner-excluded row is NEVER eligible to commit --
          // it is marked 'skipped' with no ledger/dividend effect and no
          // `resolveInput`/`target` lookup at all (which would otherwise
          // fail closed below since `validation.targets` never contains an
          // excluded row -- `revalidate()`'s `buildImportReview` call omits
          // excluded rows from reconciliation entirely). Checked first, the
          // same way blank/unsupported rows and duplicate-skip rows are.
          if (row.excludedByOwnerAt !== null) {
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'skipped', updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [nowIso(now), row.id, userId, batch.id],
            });
            continue;
          }
          if (row.rowClass !== "transaction") {
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'skipped', updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [nowIso(now), row.id, userId, batch.id],
            });
            continue;
          }
          if (validation.skippedRowIds.has(row.id)) {
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'skipped', updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [nowIso(now), row.id, userId, batch.id],
            });
            continue;
          }
          const target = validation.targets[row.id];
          if (!target) return { ok: false, reason: "revalidation_failed" };
          statements.push({
            sql: `UPDATE import_rows SET target_portfolio_id = ?,
                    target_portfolio_security_id = ?, updated_at = ?, version = version + 1
                  WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
            params: [
              target.portfolioId,
              target.portfolioSecurityId,
              nowIso(now),
              row.id,
              userId,
              batch.id,
            ],
          });
          const resolved = await resolveInput(
            userId,
            batch,
            row,
            input.idempotencyKey,
            input.requestId,
            target,
          );
          if (!resolved.ok) return resolved;
          if (seenSourceReferences.has(resolved.sourceReference)) {
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'skipped', updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [nowIso(now), row.id, userId, batch.id],
            });
            continue;
          }
          seenSourceReferences.add(resolved.sourceReference);
          if (resolved.kind === "dividend") {
            // Cross-batch/resume idempotency for dividend rows: the same
            // natural key (`import-fingerprint:<row fingerprint>`, scoped by
            // portfolio) trades use via `transactions.source_reference`,
            // looked up against `dividend_manual_records.source_reference`
            // instead (see `buildDividendManualRecordImportInsertStatements`).
            const existingRecord = await client.get<{ id: string }>(
              `SELECT id FROM dividend_manual_records
               WHERE user_id = ? AND portfolio_id = ? AND source_reference = ? LIMIT 1`,
              [userId, target.portfolioId, resolved.sourceReference],
            );
            if (existingRecord) {
              statements.push({
                sql: `UPDATE import_rows SET commit_status = 'skipped', commit_transaction_id = ?, updated_at = ?, version = version + 1
                  WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
                params: [
                  existingRecord.id,
                  nowIso(now),
                  row.id,
                  userId,
                  batch.id,
                ],
              });
              continue;
            }
            statements.push(...resolved.statements);
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'committed', commit_transaction_id = ?, updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [
                resolved.recordId,
                nowIso(now),
                row.id,
                userId,
                batch.id,
              ],
            });
            committedRowCount += 1;
            continue;
          }
          const existing = await client.get<{
            id: string;
            idempotency_key: string | null;
          }>(
            `SELECT id, idempotency_key FROM transactions
             WHERE user_id = ? AND portfolio_id = ? AND source_type = 'csv_import'
               AND source_reference = ? LIMIT 1`,
            [userId, resolved.input.portfolioId, resolved.sourceReference],
          );
          if (existing) {
            statements.push({
              sql: `UPDATE import_rows SET commit_status = 'skipped', commit_transaction_id = ?, updated_at = ?, version = version + 1
                WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
              params: [existing.id, nowIso(now), row.id, userId, batch.id],
            });
            continue;
          }
          const preparation = prepareLedgerPosting(
            resolved.input,
            randomUUID(),
          );
          if (!preparation.ok)
            return { ok: false, reason: "mapping_incomplete" };
          const built = await buildLedgerPostingStatements(
            client,
            userId,
            resolved.input,
            preparation.posting,
            "import.commit.transaction",
            () => nowIso(now),
          );
          statements.push(...built.statements);
          statements.push({
            sql: `UPDATE import_rows SET commit_status = 'committed', commit_transaction_id = ?, updated_at = ?, version = version + 1
              WHERE id = ? AND user_id = ? AND batch_id = ? AND commit_status = 'staged'`,
            params: [
              built.transactionId,
              nowIso(now),
              row.id,
              userId,
              batch.id,
            ],
          });
          committedRowCount += 1;
        }
        const firstPhysicalRow =
          chunk[0]?.physicalRowNumber ?? batch.commitHighWaterRow;
        const lastPhysicalRow =
          chunk.at(-1)?.physicalRowNumber ?? firstPhysicalRow;
        statements.push({
          sql: `INSERT INTO import_commit_chunks (
            id, user_id, batch_id, commit_idempotency_key, chunk_index,
            first_physical_row, last_physical_row, committed_row_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            randomUUID(),
            userId,
            batch.id,
            input.idempotencyKey,
            chunkIndex,
            firstPhysicalRow,
            lastPhysicalRow,
            committedRowCount,
            nowIso(now),
          ],
        });
        statements.push(
          createAuditInsertStatement(
            {
              actorUserId: userId,
              targetOwnerUserId: userId,
              action: "import.commit.chunk",
              targetType: "import_batch",
              targetId: batch.id,
              requestId: input.requestId,
              result: "success",
              metadata: { chunkIndex, firstPhysicalRow, lastPhysicalRow },
              occurredAt: nowIso(now),
            },
            () => nowIso(now),
          ),
        );
        statements.push({
          sql: `UPDATE import_batches SET commit_high_water_row = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND user_id = ? AND status = 'committing'
              AND commit_idempotency_key = ? AND commit_high_water_row = ?`,
          params: [
            lastPhysicalRow,
            nowIso(now),
            batch.id,
            userId,
            input.idempotencyKey,
            batch.commitHighWaterRow,
          ],
        });
        if (!isBoundedAtomicUnit(statements)) {
          return { ok: false, reason: "atomic_failure", resumable: true };
        }
        try {
          await client.batch(statements);
        } catch {
          return { ok: false, reason: "atomic_failure", resumable: true };
        }
        batch = (await loadBatch(userId, batch.id)) as BatchState;
        chunkIndex += 1;
      }
      if (pending.length === chunkSize) {
        const remaining = await client.get<{ id: string }>(
          `SELECT id FROM import_rows
           WHERE user_id = ? AND batch_id = ? AND physical_row_number > ?
             AND commit_status = 'staged' LIMIT 1`,
          [userId, batch.id, batch.commitHighWaterRow],
        );
        if (remaining) {
          return summary(userId, batch.id, batch, true, false);
        }
      }
      return finalize(
        userId,
        batch,
        input.idempotencyKey,
        nowIso(now),
        input.requestId,
      );
    },
  };
}
