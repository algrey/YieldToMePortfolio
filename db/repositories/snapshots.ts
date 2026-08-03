import {
  buildHistoricalSnapshots,
  type HistoricalCashAccountInput,
  type HistoricalSecurityInput,
  type HistoricalSnapshotPoint,
  type SnapshotCashLedgerEntry,
  type SnapshotFxObservation,
  type SnapshotLedgerTransaction,
  type SnapshotPriceObservation,
} from "../../domain/snapshots/history.ts";
import type {
  FxObservation,
  ManualOverride,
  ObservationScope,
  PriceObservation,
} from "../../domain/market-data/contracts.ts";
import {
  createCalculationRunRepository,
  type CalculationRunRecord,
  type RequestCalculationRunInput,
} from "./calculation-runs.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

export type HistoricalSnapshotRequest = RequestCalculationRunInput & {
  ledgerHistoryCompleteFrom?: string | null;
};

export type HistoricalSnapshotRebuildInput = {
  portfolioId: string;
  calculationRunId: string;
  leaseOwner: string;
  currentLedgerHighWater: string;
  now: string;
  marketDataCutoff?: string | null;
};

export type SnapshotRebuildResult =
  | {
      ok: true;
      status: "progress" | "completed";
      run: CalculationRunRecord;
      pointDate: string | null;
    }
  | {
      ok: false;
      reason: "not-owned" | "stale-ledger" | "invalid-run" | "build-failed";
    };

export type HistoricalSeriesPoint = {
  date: string;
  totalValueDecimal: string | null;
  securitiesValueDecimal: string | null;
  cashValueDecimal: string | null;
  dailyMovementDecimal: string | null;
  completeness: "complete" | "partial" | "incomplete";
  excludedFromPerformance: boolean;
  coverage: Record<string, unknown>;
};

export type HistoricalSeriesResponse = {
  baseCurrencyCode: string;
  calculationVersion: number;
  rangeFrom: string;
  rangeTo: string;
  points: readonly HistoricalSeriesPoint[];
  gaps: readonly { date: string; completeness: "partial" | "incomplete" }[];
};

export type SnapshotRepositoryOptions = {
  maxHoldingRowsPerChunk?: number;
  maxFacts?: number;
};

type PortfolioRow = {
  base_currency_code: string;
  history_complete_from: string | null;
};

type SecurityRow = {
  portfolio_security_id: string;
  security_id: string | null;
  currency_code: string;
  mapping_id: string | null;
};

type TransactionRow = Record<string, unknown> & {
  id: string;
  portfolio_security_id: string | null;
  type: string;
  status: string;
  trade_at: string;
  local_trade_date: string;
  quantity_decimal: string | null;
  unit_price_decimal: string | null;
  gross_amount_decimal: string | null;
  fee_amount_decimal: string;
  tax_amount_decimal: string;
  fx_rate_to_base_decimal: string | null;
  reverses_transaction_id: string | null;
};

type CashAccountRow = {
  id: string;
  currency_code: string;
  completeness: "complete" | "opening_balance" | "incomplete";
};

type CashEntryRow = {
  id: string;
  cash_account_id: string;
  local_effective_date: string;
  signed_amount_decimal: string;
  status: "posted" | "reversed";
  reverses_entry_id: string | null;
};

function scope(accessScope: unknown, scopeUserId: unknown): ObservationScope {
  return accessScope === "user"
    ? { kind: "user", userId: String(scopeUserId) }
    : { kind: "deployment", userId: null };
}

function mapPrice(row: Record<string, unknown>): SnapshotPriceObservation {
  return {
    id: String(row.id),
    kind: "price",
    providerId: String(row.provider_id),
    providerRevisionId:
      row.provider_revision_id === null
        ? null
        : String(row.provider_revision_id),
    mappingId: String(row.mapping_id),
    securityId: String(row.security_id),
    scope: scope(row.access_scope, row.scope_user_id),
    interval: String(row.interval) as PriceObservation["interval"],
    observationAt: String(row.observation_at),
    marketDate: String(row.market_date),
    marketTimezone: String(row.market_timezone),
    currencyCode: String(row.currency_code),
    closeDecimal: String(row.close_decimal),
    previousCloseDecimal:
      row.previous_close_decimal === null
        ? null
        : String(row.previous_close_decimal),
    adjustmentState: String(
      row.adjustment_state,
    ) as PriceObservation["adjustmentState"],
    adjustmentFactor: null,
    quality: String(row.quality) as PriceObservation["quality"],
    delayedMinutes:
      row.delayed_minutes === null ? null : Number(row.delayed_minutes),
    ingestedAt: String(row.ingested_at),
    payloadSha256:
      row.payload_sha256 === null ? null : String(row.payload_sha256),
  };
}

function mapFx(row: Record<string, unknown>): SnapshotFxObservation {
  return {
    id: String(row.id),
    kind: "fx",
    providerId: String(row.provider_id),
    providerRevisionId:
      row.provider_revision_id === null
        ? null
        : String(row.provider_revision_id),
    scope: scope(row.access_scope, row.scope_user_id),
    baseCurrencyCode: String(row.base_currency_code),
    quoteCurrencyCode: String(row.quote_currency_code),
    rateDecimal: String(row.rate_decimal),
    interval: String(row.interval) as FxObservation["interval"],
    observedAt: String(row.observed_at),
    marketDate: String(row.market_date),
    quality: String(row.quality) as FxObservation["quality"],
    delayedMinutes:
      row.delayed_minutes === null ? null : Number(row.delayed_minutes),
    ingestedAt: String(row.ingested_at),
    payloadSha256:
      row.payload_sha256 === null ? null : String(row.payload_sha256),
  };
}

function mapOverride(row: Record<string, unknown>): ManualOverride {
  return {
    kind: "manual_override",
    id: String(row.id),
    userId: String(row.user_id),
    portfolioId: row.portfolio_id === null ? null : String(row.portfolio_id),
    securityId: row.security_id === null ? null : String(row.security_id),
    type: String(row.type) as ManualOverride["type"],
    targetKey: String(row.target_key),
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to === null ? null : String(row.effective_to),
    valueJson: String(row.value_json),
    reason: String(row.reason),
    status: String(row.status) as ManualOverride["status"],
    supersedesOverrideId:
      row.supersedes_override_id === null
        ? null
        : String(row.supersedes_override_id),
    createdAt: String(row.created_at),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseCoverage(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function dateRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  return Array.from(
    { length: Math.min(Math.floor((end - start) / 86_400_000) + 1, 3_660) },
    (_, index) =>
      new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

export function createHistoricalSnapshotRepository(
  sql: SqlClient,
  options: SnapshotRepositoryOptions = {},
) {
  const runs = createCalculationRunRepository(sql);
  const maxHoldingRowsPerChunk = Math.max(
    1,
    Math.min(options.maxHoldingRowsPerChunk ?? 64, 256),
  );
  const maxFacts = options.maxFacts ?? 100_000;

  async function loadFacts(
    userId: string,
    run: CalculationRunRecord,
  ): Promise<{
    baseCurrencyCode: string;
    historyCompleteFrom: string | null;
    securities: HistoricalSecurityInput[];
    cashAccounts: HistoricalCashAccountInput[];
    fxObservations: SnapshotFxObservation[];
    overrides: ManualOverride[];
  }> {
    const portfolio = await sql.get<PortfolioRow>(
      `SELECT base_currency_code, history_complete_from FROM portfolios WHERE id = ? AND user_id = ?`,
      [run.portfolioId, userId],
    );
    if (!portfolio) throw new Error("portfolio_not_found");
    const securityRows = await sql.all<SecurityRow>(
      `SELECT ps.id AS portfolio_security_id, ps.security_id, ps.source_currency_code AS currency_code,
         (SELECT m.id FROM security_provider_mappings m
          WHERE m.security_id = ps.security_id AND m.status = 'verified'
            AND m.valid_from <= ? AND (m.valid_to IS NULL OR m.valid_to >= ?)
          ORDER BY m.valid_from DESC, m.id DESC LIMIT 1) AS mapping_id
       FROM portfolio_securities ps
       WHERE ps.user_id = ? AND ps.portfolio_id = ?
       ORDER BY ps.id`,
      [run.rangeTo, run.rangeFrom, userId, run.portfolioId],
    );
    const transactionRows = await sql.all<TransactionRow>(
      `SELECT id, portfolio_security_id, type, status, trade_at, local_trade_date,
         quantity_decimal, unit_price_decimal, gross_amount_decimal,
         fee_amount_decimal, tax_amount_decimal, fx_rate_to_base_decimal,
         reverses_transaction_id
       FROM transactions
       WHERE user_id = ? AND portfolio_id = ? AND local_trade_date <= ?
       ORDER BY local_trade_date, trade_at, id`,
      [userId, run.portfolioId, run.rangeTo],
    );
    const priceRows = await sql.all<Record<string, unknown>>(
      `SELECT po.* FROM price_observations po
       JOIN portfolio_securities ps ON ps.security_id = po.security_id
       WHERE ps.user_id = ? AND ps.portfolio_id = ? AND po.market_date <= ?
       ORDER BY po.security_id, po.market_date, po.observation_at, po.id`,
      [userId, run.portfolioId, run.rangeTo],
    );
    const fxRows = await sql.all<Record<string, unknown>>(
      `SELECT fx.* FROM fx_rate_observations fx
       WHERE fx.base_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
         AND fx.market_date <= ?
       ORDER BY fx.base_currency_code, fx.quote_currency_code, fx.market_date, fx.observed_at, fx.id`,
      [run.portfolioId, userId, run.rangeTo],
    );
    const accountRows = await sql.all<CashAccountRow>(
      `SELECT id, currency_code, completeness FROM cash_accounts WHERE user_id = ? AND portfolio_id = ? ORDER BY id`,
      [userId, run.portfolioId],
    );
    const entryRows = await sql.all<CashEntryRow>(
      `SELECT id, cash_account_id, local_effective_date, signed_amount_decimal, status, reverses_entry_id
       FROM cash_ledger_entries WHERE user_id = ? AND portfolio_id = ? AND local_effective_date <= ?
       ORDER BY local_effective_date, effective_at, id`,
      [userId, run.portfolioId, run.rangeTo],
    );
    const overrideRows = await sql.all<Record<string, unknown>>(
      `SELECT * FROM manual_overrides
       WHERE user_id = ? AND (portfolio_id = ? OR portfolio_id IS NULL)
         AND status = 'active'`,
      [userId, run.portfolioId],
    );
    const factsCount =
      transactionRows.length +
      entryRows.length +
      priceRows.length +
      fxRows.length;
    if (factsCount > maxFacts) throw new Error("snapshot_fact_limit");
    const pricesBySecurity = new Map<string, SnapshotPriceObservation[]>();
    for (const row of priceRows) {
      const mapped = mapPrice(row);
      const existing = pricesBySecurity.get(mapped.securityId) ?? [];
      existing.push(mapped);
      pricesBySecurity.set(mapped.securityId, existing);
    }
    const transactionsBySecurity = new Map<
      string,
      SnapshotLedgerTransaction[]
    >();
    for (const row of transactionRows) {
      if (row.portfolio_security_id === null) continue;
      const existing =
        transactionsBySecurity.get(row.portfolio_security_id) ?? [];
      existing.push({
        id: row.id,
        portfolioSecurityId: row.portfolio_security_id,
        type: row.type,
        status: row.status,
        tradeAt: row.trade_at,
        localDate: row.local_trade_date,
        quantityDecimal: row.quantity_decimal,
        unitPriceDecimal: row.unit_price_decimal,
        grossAmountDecimal: row.gross_amount_decimal,
        feeAmountDecimal: row.fee_amount_decimal,
        taxAmountDecimal: row.tax_amount_decimal,
        fxRateToBaseDecimal: row.fx_rate_to_base_decimal,
        reversesTransactionId: row.reverses_transaction_id,
      });
      transactionsBySecurity.set(row.portfolio_security_id, existing);
    }
    const securities = securityRows.map((row) => ({
      portfolioSecurityId: row.portfolio_security_id,
      securityId: row.security_id,
      mappingId: row.mapping_id,
      currencyCode: row.currency_code,
      transactions: transactionsBySecurity.get(row.portfolio_security_id) ?? [],
      priceObservations: row.security_id
        ? (pricesBySecurity.get(row.security_id) ?? [])
        : [],
    }));
    const entriesByAccount = new Map<string, SnapshotCashLedgerEntry[]>();
    for (const row of entryRows) {
      const existing = entriesByAccount.get(row.cash_account_id) ?? [];
      existing.push({
        id: row.id,
        accountId: row.cash_account_id,
        localDate: row.local_effective_date,
        signedAmountDecimal: row.signed_amount_decimal,
        status: row.status,
        reversesEntryId: row.reverses_entry_id,
      });
      entriesByAccount.set(row.cash_account_id, existing);
    }
    return {
      baseCurrencyCode: portfolio.base_currency_code,
      historyCompleteFrom: portfolio.history_complete_from,
      securities,
      cashAccounts: accountRows.map((row) => ({
        id: row.id,
        currencyCode: row.currency_code,
        completeness: row.completeness,
        entries: entriesByAccount.get(row.id) ?? [],
      })),
      fxObservations: fxRows.map(mapFx),
      overrides: overrideRows.map(mapOverride),
    };
  }

  async function batch(statements: readonly SqlStatement[]): Promise<void> {
    if (sql.batch) {
      await sql.batch(statements);
      return;
    }
    for (const statement of statements)
      await sql.run(statement.sql, statement.params);
  }

  function snapshotStatement(
    userId: string,
    run: CalculationRunRecord,
    point: HistoricalSnapshotPoint,
    marketDataCutoff: string | null,
  ): SqlStatement {
    return {
      sql: `INSERT INTO portfolio_daily_snapshots
        (id, user_id, portfolio_id, snapshot_date, base_currency_code,
         securities_value_decimal, cash_value_decimal, total_value_decimal,
         cost_basis_decimal, unrealised_gain_decimal, realised_gain_to_date_decimal,
         daily_movement_decimal, coverage_json, completeness, status,
         ledger_high_water, market_data_cutoff, calculation_version, rebuilt_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
        ON CONFLICT (portfolio_id, snapshot_date, calculation_version) DO UPDATE SET
          user_id = excluded.user_id, base_currency_code = excluded.base_currency_code,
          securities_value_decimal = excluded.securities_value_decimal,
          cash_value_decimal = excluded.cash_value_decimal,
          total_value_decimal = excluded.total_value_decimal,
          cost_basis_decimal = excluded.cost_basis_decimal,
          unrealised_gain_decimal = excluded.unrealised_gain_decimal,
          realised_gain_to_date_decimal = excluded.realised_gain_to_date_decimal,
          daily_movement_decimal = excluded.daily_movement_decimal,
          coverage_json = excluded.coverage_json, completeness = excluded.completeness,
          status = 'ready', ledger_high_water = excluded.ledger_high_water,
          market_data_cutoff = excluded.market_data_cutoff, rebuilt_at = excluded.rebuilt_at`,
      params: [
        `${run.id}:portfolio:${point.date}`,
        userId,
        run.portfolioId,
        point.date,
        point.baseCurrencyCode,
        point.securitiesValueDecimal,
        point.cashValueDecimal,
        point.totalValueDecimal,
        point.costBasisDecimal,
        point.unrealisedGainDecimal,
        point.realisedGainToDateDecimal,
        point.dailyMovementDecimal,
        stableJson(point.coverage),
        point.completeness,
        run.ledgerHighWaterStart,
        marketDataCutoff,
        run.calculationVersion,
        run.updatedAt,
      ],
    };
  }

  function holdingStatement(
    userId: string,
    run: CalculationRunRecord,
    point: HistoricalSnapshotPoint,
    holding: HistoricalSnapshotPoint["holdings"][number],
  ): SqlStatement {
    return {
      sql: `INSERT INTO holding_daily_snapshots
        (id, user_id, portfolio_id, portfolio_security_id, portfolio_snapshot_id,
         snapshot_date, quantity_decimal, native_value_decimal, base_value_decimal,
         basis_decimal, price_observation_id, fx_observation_id,
         daily_movement_decimal, completeness, status, calculation_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
        ON CONFLICT (portfolio_id, portfolio_security_id, snapshot_date, calculation_version) DO UPDATE SET
          user_id = excluded.user_id, portfolio_snapshot_id = excluded.portfolio_snapshot_id,
          quantity_decimal = excluded.quantity_decimal, native_value_decimal = excluded.native_value_decimal,
          base_value_decimal = excluded.base_value_decimal, basis_decimal = excluded.basis_decimal,
          price_observation_id = excluded.price_observation_id, fx_observation_id = excluded.fx_observation_id,
          daily_movement_decimal = excluded.daily_movement_decimal, completeness = excluded.completeness,
          status = 'ready'`,
      params: [
        `${run.id}:holding:${point.date}:${holding.portfolioSecurityId}`,
        userId,
        run.portfolioId,
        holding.portfolioSecurityId,
        `${run.id}:portfolio:${point.date}`,
        point.date,
        holding.quantityDecimal,
        holding.nativeValueDecimal,
        holding.baseValueDecimal,
        holding.basisDecimal,
        holding.priceObservationId,
        holding.fxObservationId,
        holding.dailyMovementDecimal,
        holding.completeness,
        run.calculationVersion,
      ],
    };
  }

  return {
    async request(
      userId: string,
      input: HistoricalSnapshotRequest,
    ): Promise<CalculationRunRecord> {
      return runs.request(userId, input);
    },

    async claim(
      userId: string,
      portfolioId: string,
      runId: string,
      leaseOwner: string,
      leaseExpiresAt: string,
      now: string,
    ) {
      return runs.claim(
        userId,
        portfolioId,
        runId,
        leaseOwner,
        leaseExpiresAt,
        now,
      );
    },

    async rebuild(
      userId: string,
      input: HistoricalSnapshotRebuildInput,
    ): Promise<SnapshotRebuildResult> {
      const run = await runs.get(
        userId,
        input.portfolioId,
        input.calculationRunId,
      );
      if (
        !run ||
        run.status !== "running" ||
        run.leaseOwner !== input.leaseOwner ||
        (run.leaseExpiresAt !== null && run.leaseExpiresAt <= input.now)
      ) {
        return { ok: false, reason: "not-owned" };
      }
      if (run.ledgerHighWaterStart !== input.currentLedgerHighWater) {
        return { ok: false, reason: "stale-ledger" };
      }
      let facts;
      try {
        facts = await loadFacts(userId, run);
      } catch {
        return { ok: false, reason: "build-failed" };
      }
      const built = buildHistoricalSnapshots({
        userId,
        baseCurrencyCode: facts.baseCurrencyCode,
        rangeFrom: run.rangeFrom,
        rangeTo: run.rangeTo,
        calculationVersion: run.calculationVersion,
        ledgerHistoryCompleteFrom: facts.historyCompleteFrom,
        securities: facts.securities,
        cashAccounts: facts.cashAccounts,
        fxObservations: facts.fxObservations,
        overrides: facts.overrides,
      });
      if (!built.ok) return { ok: false, reason: "build-failed" };
      const point = built.points[run.processedSnapshotCount];
      if (!point) {
        const completed = await runs.complete(
          userId,
          input.portfolioId,
          run.id,
          input.leaseOwner,
          input.currentLedgerHighWater,
          input.now,
          run.processedSnapshotCount,
          run.processedHoldingCount,
        );
        return completed.ok
          ? {
              ok: true,
              status: "completed",
              run: completed.run,
              pointDate: null,
            }
          : {
              ok: false,
              reason:
                completed.reason === "stale-ledger"
                  ? "stale-ledger"
                  : "not-owned",
            };
      }
      const holdingStart = run.processedHoldingCount;
      const holdingEnd = Math.min(
        holdingStart + maxHoldingRowsPerChunk,
        point.holdings.length,
      );
      const statements: SqlStatement[] = [];
      if (holdingStart === 0)
        statements.push(
          snapshotStatement(
            userId,
            run,
            point,
            input.marketDataCutoff ?? input.now,
          ),
        );
      for (const holding of point.holdings.slice(holdingStart, holdingEnd)) {
        statements.push(holdingStatement(userId, run, point, holding));
      }
      const nextHolding = holdingEnd >= point.holdings.length ? 0 : holdingEnd;
      const nextSnapshot =
        nextHolding === 0
          ? run.processedSnapshotCount + 1
          : run.processedSnapshotCount;
      statements.push({
        sql: `UPDATE calculation_runs SET processed_snapshot_count = ?, processed_holding_count = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND portfolio_id = ? AND status = 'running'
            AND lease_owner = ? AND ledger_high_water_start = ?
            AND processed_snapshot_count = ? AND processed_holding_count = ?`,
        params: [
          nextSnapshot,
          nextHolding,
          input.now,
          run.id,
          userId,
          input.portfolioId,
          input.leaseOwner,
          input.currentLedgerHighWater,
          run.processedSnapshotCount,
          run.processedHoldingCount,
        ],
      });
      await batch(statements);
      const after = await runs.get(userId, input.portfolioId, run.id);
      if (!after) return { ok: false, reason: "invalid-run" };
      if (nextSnapshot >= built.points.length && nextHolding === 0) {
        const completed = await runs.complete(
          userId,
          input.portfolioId,
          run.id,
          input.leaseOwner,
          input.currentLedgerHighWater,
          input.now,
          nextSnapshot,
          nextHolding,
        );
        return completed.ok
          ? {
              ok: true,
              status: "completed",
              run: completed.run,
              pointDate: point.date,
            }
          : {
              ok: false,
              reason:
                completed.reason === "stale-ledger"
                  ? "stale-ledger"
                  : "not-owned",
            };
      }
      return {
        ok: true,
        status: "progress",
        run: after,
        pointDate: point.date,
      };
    },

    async invalidateRange(
      userId: string,
      portfolioId: string,
      rangeFrom: string,
      rangeTo: string,
      calculationVersion?: number,
    ): Promise<number> {
      const versionClause =
        calculationVersion === undefined ? "" : " AND calculation_version = ?";
      const params =
        calculationVersion === undefined
          ? [userId, portfolioId, rangeFrom, rangeTo]
          : [userId, portfolioId, rangeFrom, rangeTo, calculationVersion];
      const holding = await sql.run(
        `UPDATE holding_daily_snapshots SET status = 'invalidated' WHERE user_id = ? AND portfolio_id = ? AND snapshot_date BETWEEN ? AND ?${versionClause}`,
        params,
      );
      const portfolio = await sql.run(
        `UPDATE portfolio_daily_snapshots SET status = 'invalidated' WHERE user_id = ? AND portfolio_id = ? AND snapshot_date BETWEEN ? AND ?${versionClause}`,
        params,
      );
      return holding.changes + portfolio.changes;
    },

    async loadSeries(
      userId: string,
      portfolioId: string,
      rangeFrom: string,
      rangeTo: string,
      calculationVersion: number,
    ): Promise<HistoricalSeriesResponse | null> {
      const run = await sql.get<Record<string, unknown>>(
        `SELECT p.base_currency_code, r.ledger_high_water_end, r.range_from, r.range_to, r.calculation_version FROM calculation_runs r
         JOIN portfolios p ON p.id = r.portfolio_id AND p.user_id = r.user_id
         WHERE r.user_id = ? AND r.portfolio_id = ? AND r.calculation_version = ? AND r.status = 'completed'
           AND range_from <= ? AND range_to >= ? ORDER BY r.completed_at DESC, r.id DESC LIMIT 1`,
        [userId, portfolioId, calculationVersion, rangeFrom, rangeTo],
      );
      if (!run) return null;
      const rows = await sql.all<Record<string, unknown>>(
        `SELECT snapshot_date, total_value_decimal, securities_value_decimal, cash_value_decimal,
           daily_movement_decimal, completeness, coverage_json
         FROM portfolio_daily_snapshots
         WHERE user_id = ? AND portfolio_id = ? AND snapshot_date BETWEEN ? AND ?
           AND calculation_version = ? AND ledger_high_water = ? AND status = 'ready' ORDER BY snapshot_date`,
        [
          userId,
          portfolioId,
          rangeFrom,
          rangeTo,
          calculationVersion,
          String(run.ledger_high_water_end),
        ],
      );
      const points = rows.map((row) => {
        const coverage = parseCoverage(row.coverage_json);
        return {
          date: String(row.snapshot_date),
          totalValueDecimal:
            row.total_value_decimal === null
              ? null
              : String(row.total_value_decimal),
          securitiesValueDecimal:
            row.securities_value_decimal === null
              ? null
              : String(row.securities_value_decimal),
          cashValueDecimal:
            row.cash_value_decimal === null
              ? null
              : String(row.cash_value_decimal),
          dailyMovementDecimal:
            row.daily_movement_decimal === null
              ? null
              : String(row.daily_movement_decimal),
          completeness: String(
            row.completeness,
          ) as HistoricalSeriesPoint["completeness"],
          excludedFromPerformance:
            coverage.historyComplete === false ||
            (Array.isArray(coverage.gaps) && coverage.gaps.length > 0),
          coverage,
        } satisfies HistoricalSeriesPoint;
      });
      const pointByDate = new Map(points.map((point) => [point.date, point]));
      const gaps = dateRange(rangeFrom, rangeTo)
        .filter((date) => {
          const point = pointByDate.get(date);
          return point === undefined || point.completeness !== "complete";
        })
        .map((date) => ({
          date,
          completeness: (pointByDate.get(date)?.completeness ??
            "incomplete") as "partial" | "incomplete",
        }));
      return {
        baseCurrencyCode: String(run.base_currency_code),
        calculationVersion,
        rangeFrom,
        rangeTo,
        points,
        gaps,
      };
    },
  };
}
