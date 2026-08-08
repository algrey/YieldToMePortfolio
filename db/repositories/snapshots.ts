import {
  buildHistoricalSnapshots,
  type HistoricalCashAccountInput,
  type HistoricalSecurityInput,
  type HistoricalSnapshotPoint,
  type SnapshotCashLedgerEntry,
  type SnapshotFxObservation,
  type SnapshotLedgerTransaction,
  type SnapshotPriceObservation,
  type HistoricalCalendarEvidence,
  type HistoricalExchangeSession,
  HISTORICAL_CALENDAR_LIMITS,
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

export type HistoricalSnapshotRequest = Omit<
  RequestCalculationRunInput,
  "calendarEvidenceJson"
> & {
  ledgerHistoryCompleteFrom?: string | null;
  calendarEvidence?: HistoricalCalendarEvidence;
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
  calendarEvidence?: HistoricalCalendarEvidence;
};

type PortfolioRow = {
  base_currency_code: string;
  timezone: string;
  history_complete_from: string | null;
};

function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function serializeCalendarEvidence(
  evidence: HistoricalCalendarEvidence | undefined,
): string | null {
  if (!evidence) return null;
  if (
    evidence.version !== 2 ||
    !Array.isArray(evidence.calendars) ||
    evidence.calendars.length > HISTORICAL_CALENDAR_LIMITS.maxCalendars
  ) {
    throw new Error("invalid_calendar_evidence");
  }
  const calendars = evidence.calendars
    .map((calendar) => {
      if (
        typeof calendar !== "object" ||
        calendar === null ||
        typeof calendar.mic !== "string" ||
        calendar.mic.length === 0 ||
        typeof calendar.calendarCode !== "string" ||
        calendar.calendarCode.length === 0 ||
        !isValidTimezone(calendar.timezone) ||
        typeof calendar.source !== "string" ||
        calendar.source.length === 0 ||
        typeof calendar.revision !== "string" ||
        calendar.revision.length === 0 ||
        (calendar.exchangeId !== undefined &&
          calendar.exchangeId !== null &&
          (typeof calendar.exchangeId !== "string" ||
            calendar.exchangeId.length === 0)) ||
        !Array.isArray(calendar.sessions) ||
        !isValidCalendarDate(calendar.validFrom) ||
        !isValidCalendarDate(calendar.validTo) ||
        calendar.validTo < calendar.validFrom
      ) {
        throw new Error("invalid_calendar_evidence");
      }
      const sessionIds = new Set<string>();
      const sessions = calendar.sessions
        .map((session: HistoricalExchangeSession) => {
          if (
            typeof session !== "object" ||
            session === null ||
            typeof session.sessionId !== "string" ||
            session.sessionId.length === 0 ||
            sessionIds.has(session.sessionId) ||
            !isValidCalendarDate(session.marketDate) ||
            !isValidInstant(session.openAt) ||
            !isValidInstant(session.closeAt) ||
            session.marketDate < calendar.validFrom ||
            session.marketDate > calendar.validTo ||
            Date.parse(session.openAt) >= Date.parse(session.closeAt)
          ) {
            throw new Error("invalid_calendar_evidence");
          }
          sessionIds.add(session.sessionId);
          return {
            sessionId: session.sessionId,
            marketDate: session.marketDate,
            openAt: session.openAt,
            closeAt: session.closeAt,
          };
        })
        .sort(
          (left: HistoricalExchangeSession, right: HistoricalExchangeSession) =>
            left.marketDate.localeCompare(right.marketDate) ||
            left.closeAt.localeCompare(right.closeAt) ||
            left.sessionId.localeCompare(right.sessionId),
        );
      return {
        exchangeId: calendar.exchangeId ?? null,
        mic: calendar.mic,
        calendarCode: calendar.calendarCode,
        timezone: calendar.timezone,
        validFrom: calendar.validFrom,
        validTo: calendar.validTo,
        source: calendar.source,
        revision: calendar.revision,
        sessions,
      };
    })
    .sort(
      (left, right) =>
        `${left.exchangeId ?? ""}/${left.mic}`.localeCompare(
          `${right.exchangeId ?? ""}/${right.mic}`,
        ) ||
        left.validFrom.localeCompare(right.validFrom) ||
        left.validTo.localeCompare(right.validTo) ||
        left.revision.localeCompare(right.revision),
    );
  for (let index = 1; index < calendars.length; index += 1) {
    const previous = calendars[index - 1]!;
    const current = calendars[index]!;
    if (
      `${previous.exchangeId ?? ""}/${previous.mic}` ===
        `${current.exchangeId ?? ""}/${current.mic}` &&
      previous.validTo >= current.validFrom
    ) {
      throw new Error("invalid_calendar_evidence");
    }
  }
  if (
    calendars.reduce((count, calendar) => count + calendar.sessions.length, 0) >
    HISTORICAL_CALENDAR_LIMITS.maxSessions
  ) {
    throw new Error("invalid_calendar_evidence");
  }
  const result = JSON.stringify({ version: 2, calendars });
  if (result.length > HISTORICAL_CALENDAR_LIMITS.maxEvidenceBytes) {
    throw new Error("invalid_calendar_evidence");
  }
  return result;
}

function parseCalendarEvidence(
  value: string | null,
): HistoricalCalendarEvidence | undefined | null {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as { version?: unknown; calendars?: unknown };
    if (envelope.version !== 2 || !Array.isArray(envelope.calendars))
      return null;
    const calendars =
      envelope.calendars as HistoricalCalendarEvidence["calendars"];
    const evidence = { version: 2 as const, calendars };
    return serializeCalendarEvidence(evidence) === value ? evidence : null;
  } catch {
    return null;
  }
}

function isValidInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    value.endsWith("Z")
  );
}

function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

type SecurityRow = {
  portfolio_security_id: string;
  security_id: string | null;
  currency_code: string;
  mapping_id: string | null;
  exchange_id: string | null;
  exchange_mic: string | null;
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
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value
    );
  };
  if (!validDate(from) || !validDate(to)) return [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  const count = Math.floor((end - start) / 86_400_000) + 1;
  if (count > 3_660) return [];
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

function daysBefore(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return new Date(timestamp - days * 86_400_000).toISOString().slice(0, 10);
}

function daysAfter(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function localDateAt(timestamp: number, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const values = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

function portfolioCutoff(date: string, timezone: string): number | null {
  const start = Date.parse(`${date}T00:00:00Z`) - 36 * 60 * 60 * 1000;
  if (!Number.isFinite(start)) return null;
  let low = start;
  let high = start + 4 * 86_400_000;
  if (localDateAt(high, timezone) === null) return null;
  for (let index = 0; index < 52; index += 1) {
    const middle = Math.floor((low + high) / 2);
    const local = localDateAt(middle, timezone);
    if (local !== null && local <= date) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function marketDateUpperBound(
  asOfDate: string,
  portfolioTimezone: string,
  evidence: HistoricalCalendarEvidence | undefined,
): string {
  if (!evidence) return asOfDate;
  const cutoff = portfolioCutoff(asOfDate, portfolioTimezone);
  if (cutoff === null) return asOfDate;
  const maximumSafeDate = daysAfter(asOfDate, 2);
  let upper = asOfDate;
  for (const calendar of evidence.calendars) {
    for (const session of calendar.sessions) {
      if (
        Date.parse(session.closeAt) <= cutoff &&
        session.marketDate > upper &&
        session.marketDate <= maximumSafeDate
      ) {
        upper = session.marketDate;
      }
    }
  }
  return upper;
}

// A chunk rebuilds the requested date plus the preceding point for daily
// movement, so retain one day beyond the selector's five-day fallback window.
const SNAPSHOT_QUERY_LOOKBACK_DAYS = 6;

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
    asOfDate: string,
  ): Promise<{
    baseCurrencyCode: string;
    historyCompleteFrom: string | null;
    securities: HistoricalSecurityInput[];
    cashAccounts: HistoricalCashAccountInput[];
    fxObservations: SnapshotFxObservation[];
    overrides: ManualOverride[];
    portfolioTimezone: string;
    calendarEvidence: HistoricalCalendarEvidence | undefined;
  }> {
    const portfolio = await sql.get<PortfolioRow>(
      `SELECT base_currency_code, timezone, history_complete_from FROM portfolios WHERE id = ? AND user_id = ?`,
      [run.portfolioId, userId],
    );
    if (!portfolio) throw new Error("portfolio_not_found");
    const calendarEvidence = parseCalendarEvidence(run.calendarEvidenceJson);
    if (calendarEvidence === null) throw new Error("invalid_calendar_evidence");
    const marketDateTo = marketDateUpperBound(
      asOfDate,
      portfolio.timezone,
      calendarEvidence ?? undefined,
    );
    const securityCount = await sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM portfolio_securities WHERE user_id = ? AND portfolio_id = ?`,
      [userId, run.portfolioId],
    );
    const transactionCount = await sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM transactions WHERE user_id = ? AND portfolio_id = ? AND local_trade_date <= ?`,
      [userId, run.portfolioId, asOfDate],
    );
    const priceCount = await sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM price_observations po
       JOIN portfolio_securities ps ON ps.security_id = po.security_id
       WHERE ps.user_id = ? AND ps.portfolio_id = ?
         AND po.market_date BETWEEN ? AND ? AND po.ingested_at <= ?
         AND po.adjustment_state = 'raw'
         AND (po.access_scope = 'deployment' OR (po.access_scope = 'user' AND po.scope_user_id = ?))`,
      [
        userId,
        run.portfolioId,
        daysBefore(asOfDate, SNAPSHOT_QUERY_LOOKBACK_DAYS),
        marketDateTo,
        run.marketDataCutoff ?? run.updatedAt,
        userId,
      ],
    );
    const fxCount = await sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM fx_rate_observations fx
       WHERE fx.market_date BETWEEN ? AND ? AND fx.ingested_at <= ?
         AND (fx.access_scope = 'deployment' OR (fx.access_scope = 'user' AND fx.scope_user_id = ?))
         AND (
           (fx.base_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
             AND fx.quote_currency_code IN (
               SELECT source_currency_code FROM portfolio_securities WHERE user_id = ? AND portfolio_id = ?
               UNION SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ?
             ))
           OR
           (fx.quote_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
             AND fx.base_currency_code IN (
               SELECT source_currency_code FROM portfolio_securities WHERE user_id = ? AND portfolio_id = ?
               UNION SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ?
             ))
         )`,
      [
        daysBefore(asOfDate, SNAPSHOT_QUERY_LOOKBACK_DAYS),
        asOfDate,
        run.marketDataCutoff ?? run.updatedAt,
        userId,
        run.portfolioId,
        userId,
        userId,
        run.portfolioId,
        userId,
        run.portfolioId,
        run.portfolioId,
        userId,
        userId,
        run.portfolioId,
        userId,
        run.portfolioId,
      ],
    );
    const cashCount = await sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM cash_ledger_entries WHERE user_id = ? AND portfolio_id = ? AND local_effective_date <= ?`,
      [userId, run.portfolioId, asOfDate],
    );
    const cashAccountCount = await sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM cash_accounts WHERE user_id = ? AND portfolio_id = ?`,
      [userId, run.portfolioId],
    );
    const overrideCount = await sql.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM manual_overrides
       WHERE user_id = ? AND (portfolio_id = ? OR portfolio_id IS NULL)
         AND status = 'active'`,
      [userId, run.portfolioId],
    );
    const factCount =
      Number(securityCount?.count ?? 0) +
      Number(transactionCount?.count ?? 0) +
      Number(priceCount?.count ?? 0) +
      Number(fxCount?.count ?? 0) +
      Number(cashCount?.count ?? 0) +
      Number(cashAccountCount?.count ?? 0) +
      Number(overrideCount?.count ?? 0);
    if (factCount > maxFacts) throw new Error("snapshot_fact_limit");
    const securityRows = await sql.all<SecurityRow>(
      `SELECT ps.id AS portfolio_security_id, ps.security_id, ps.source_currency_code AS currency_code,
         s.exchange_id, e.mic AS exchange_mic,
         (SELECT m.id FROM security_provider_mappings m
          WHERE m.security_id = ps.security_id AND m.status = 'verified'
            AND m.valid_from <= ? AND (m.valid_to IS NULL OR m.valid_to >= ?)
          ORDER BY m.valid_from DESC, m.id DESC LIMIT 1) AS mapping_id
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       LEFT JOIN exchanges e ON e.id = s.exchange_id
       WHERE ps.user_id = ? AND ps.portfolio_id = ?
       ORDER BY ps.id LIMIT ?`,
      [asOfDate, run.rangeFrom, userId, run.portfolioId, maxFacts],
    );
    const transactionRows = await sql.all<TransactionRow>(
      `SELECT id, portfolio_security_id, type, status, trade_at, local_trade_date,
         quantity_decimal, unit_price_decimal, gross_amount_decimal,
         fee_amount_decimal, tax_amount_decimal, fx_rate_to_base_decimal,
         reverses_transaction_id
       FROM transactions
       WHERE user_id = ? AND portfolio_id = ? AND local_trade_date <= ?
       ORDER BY local_trade_date, trade_at, id LIMIT ?`,
      [userId, run.portfolioId, asOfDate, maxFacts],
    );
    const priceRows = await sql.all<Record<string, unknown>>(
      `SELECT po.* FROM price_observations po
       JOIN portfolio_securities ps ON ps.security_id = po.security_id
       WHERE ps.user_id = ? AND ps.portfolio_id = ?
         AND po.market_date BETWEEN ? AND ? AND po.ingested_at <= ?
         AND po.adjustment_state = 'raw'
         AND (po.access_scope = 'deployment' OR (po.access_scope = 'user' AND po.scope_user_id = ?))
       ORDER BY po.security_id, po.market_date, po.observation_at, po.id LIMIT ?`,
      [
        userId,
        run.portfolioId,
        daysBefore(asOfDate, SNAPSHOT_QUERY_LOOKBACK_DAYS),
        marketDateTo,
        run.marketDataCutoff ?? run.updatedAt,
        userId,
        maxFacts,
      ],
    );
    const fxRows = await sql.all<Record<string, unknown>>(
      `SELECT fx.* FROM fx_rate_observations fx
       WHERE fx.market_date BETWEEN ? AND ? AND fx.ingested_at <= ?
         AND (fx.access_scope = 'deployment' OR (fx.access_scope = 'user' AND fx.scope_user_id = ?))
         AND (
           (fx.base_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
             AND fx.quote_currency_code IN (
               SELECT source_currency_code FROM portfolio_securities WHERE user_id = ? AND portfolio_id = ?
               UNION SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ?
             ))
           OR
           (fx.quote_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
             AND fx.base_currency_code IN (
               SELECT source_currency_code FROM portfolio_securities WHERE user_id = ? AND portfolio_id = ?
               UNION SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ?
             ))
         )
       ORDER BY fx.base_currency_code, fx.quote_currency_code, fx.market_date, fx.observed_at, fx.id LIMIT ?`,
      [
        daysBefore(asOfDate, SNAPSHOT_QUERY_LOOKBACK_DAYS),
        asOfDate,
        run.marketDataCutoff ?? run.updatedAt,
        userId,
        run.portfolioId,
        userId,
        userId,
        run.portfolioId,
        userId,
        run.portfolioId,
        run.portfolioId,
        userId,
        userId,
        run.portfolioId,
        userId,
        run.portfolioId,
        maxFacts,
      ],
    );
    const accountRows = await sql.all<CashAccountRow>(
      `SELECT id, currency_code, completeness FROM cash_accounts WHERE user_id = ? AND portfolio_id = ? ORDER BY id LIMIT ?`,
      [userId, run.portfolioId, maxFacts],
    );
    const entryRows = await sql.all<CashEntryRow>(
      `SELECT id, cash_account_id, local_effective_date, signed_amount_decimal, status, reverses_entry_id
       FROM cash_ledger_entries WHERE user_id = ? AND portfolio_id = ? AND local_effective_date <= ?
       ORDER BY local_effective_date, effective_at, id LIMIT ?`,
      [userId, run.portfolioId, asOfDate, maxFacts],
    );
    const overrideRows = await sql.all<Record<string, unknown>>(
      `SELECT * FROM manual_overrides
       WHERE user_id = ? AND (portfolio_id = ? OR portfolio_id IS NULL)
         AND status = 'active' LIMIT ?`,
      [userId, run.portfolioId, maxFacts],
    );
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
      exchangeId: row.exchange_id,
      exchangeMic: row.exchange_mic,
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
      portfolioTimezone: portfolio.timezone,
      calendarEvidence: calendarEvidence ?? undefined,
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
    now: string,
  ): SqlStatement {
    return {
      sql: `INSERT INTO portfolio_daily_snapshots
        (id, user_id, portfolio_id, snapshot_date, base_currency_code,
         securities_value_decimal, cash_value_decimal, total_value_decimal,
         cost_basis_decimal, unrealised_gain_decimal, realised_gain_to_date_decimal,
         daily_movement_decimal, coverage_json, completeness, status,
         ledger_high_water, market_data_cutoff, calculation_run_id,
         calculation_version, rebuilt_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM calculation_runs
          WHERE id = ? AND user_id = ? AND portfolio_id = ?
            AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
            AND processed_snapshot_count = ? AND processed_holding_count = ?)
        ON CONFLICT (portfolio_id, snapshot_date, calculation_version, calculation_run_id) DO UPDATE SET
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
          market_data_cutoff = excluded.market_data_cutoff,
          calculation_run_id = excluded.calculation_run_id,
          rebuilt_at = excluded.rebuilt_at`,
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
        run.id,
        run.calculationVersion,
        run.updatedAt,
        run.id,
        userId,
        run.portfolioId,
        run.leaseOwner,
        now,
        run.processedSnapshotCount,
        run.processedHoldingCount,
      ],
    };
  }

  function holdingStatement(
    userId: string,
    run: CalculationRunRecord,
    point: HistoricalSnapshotPoint,
    holding: HistoricalSnapshotPoint["holdings"][number],
    now: string,
  ): SqlStatement {
    return {
      sql: `INSERT INTO holding_daily_snapshots
        (id, user_id, portfolio_id, portfolio_security_id, portfolio_snapshot_id,
         snapshot_date, quantity_decimal, native_value_decimal, base_value_decimal,
         basis_decimal, price_observation_id, fx_observation_id,
         calendar_session_id, calendar_session_date, calendar_session_close_at,
         calendar_evidence_version, calculation_run_id, daily_movement_decimal, completeness, status,
         calculation_version)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?
        WHERE EXISTS (SELECT 1 FROM calculation_runs
          WHERE id = ? AND user_id = ? AND portfolio_id = ?
            AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
            AND processed_snapshot_count = ? AND processed_holding_count = ?)
        ON CONFLICT (portfolio_id, portfolio_security_id, snapshot_date, calculation_version, calculation_run_id) DO UPDATE SET
          user_id = excluded.user_id, portfolio_snapshot_id = excluded.portfolio_snapshot_id,
          quantity_decimal = excluded.quantity_decimal, native_value_decimal = excluded.native_value_decimal,
          base_value_decimal = excluded.base_value_decimal, basis_decimal = excluded.basis_decimal,
          price_observation_id = excluded.price_observation_id, fx_observation_id = excluded.fx_observation_id,
          calendar_session_id = excluded.calendar_session_id,
          calendar_session_date = excluded.calendar_session_date,
          calendar_session_close_at = excluded.calendar_session_close_at,
          calendar_evidence_version = excluded.calendar_evidence_version,
          calculation_run_id = excluded.calculation_run_id,
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
        holding.calendarSessionId,
        holding.calendarSessionDate,
        holding.calendarSessionCloseAt,
        holding.calendarEvidenceVersion,
        run.id,
        holding.dailyMovementDecimal,
        holding.completeness,
        run.calculationVersion,
        run.id,
        userId,
        run.portfolioId,
        run.leaseOwner,
        now,
        run.processedSnapshotCount,
        run.processedHoldingCount,
      ],
    };
  }

  async function completeAndPublish(
    userId: string,
    input: HistoricalSnapshotRebuildInput,
    run: CalculationRunRecord,
    processedSnapshotCount: number,
    processedHoldingCount: number,
  ): Promise<SnapshotRebuildResult> {
    const publicationId = `${input.portfolioId}:${run.calculationVersion}`;
    await batch([
      {
        sql: `UPDATE calculation_runs
          SET status = 'completed', ledger_high_water_end = ?,
              processed_snapshot_count = ?, processed_holding_count = ?,
              completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ?
          WHERE user_id = ? AND portfolio_id = ? AND id = ?
            AND status = 'running' AND lease_owner = ?
            AND lease_expires_at > ? AND ledger_high_water_start = ?`,
        params: [
          input.currentLedgerHighWater,
          processedSnapshotCount,
          processedHoldingCount,
          input.now,
          input.now,
          userId,
          input.portfolioId,
          run.id,
          input.leaseOwner,
          input.now,
          input.currentLedgerHighWater,
        ],
      },
      {
        sql: `INSERT INTO snapshot_publications
          (id, user_id, portfolio_id, calculation_version, calculation_run_id,
           ledger_high_water, published_at)
          SELECT ?, ?, ?, ?, id, ledger_high_water_end, ?
          FROM calculation_runs
          WHERE id = ? AND user_id = ? AND portfolio_id = ?
            AND status = 'completed' AND ledger_high_water_end = ?
          ON CONFLICT (user_id, portfolio_id, calculation_version) DO UPDATE SET
            calculation_run_id = excluded.calculation_run_id,
            ledger_high_water = excluded.ledger_high_water,
            published_at = excluded.published_at`,
        params: [
          publicationId,
          userId,
          input.portfolioId,
          run.calculationVersion,
          input.now,
          run.id,
          userId,
          input.portfolioId,
          input.currentLedgerHighWater,
        ],
      },
    ]);
    const completed = await runs.get(userId, input.portfolioId, run.id);
    if (!completed || completed.status !== "completed") {
      return { ok: false, reason: "not-owned" };
    }
    return {
      ok: true,
      status: "completed",
      run: completed,
      pointDate: null,
    };
  }

  return {
    async request(
      userId: string,
      input: HistoricalSnapshotRequest,
    ): Promise<CalculationRunRecord> {
      const calendarEvidenceJson = serializeCalendarEvidence(
        input.calendarEvidence ?? options.calendarEvidence,
      );
      return runs.request(userId, {
        ...input,
        calendarEvidenceJson,
      });
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
      const dates = dateRange(run.rangeFrom, run.rangeTo);
      if (dates.length === 0) {
        return { ok: false, reason: "invalid-run" };
      }
      const pointDate = dates[run.processedSnapshotCount];
      if (!pointDate) {
        return completeAndPublish(
          userId,
          input,
          run,
          run.processedSnapshotCount,
          run.processedHoldingCount,
        );
      }
      let facts;
      const buildFromDate =
        run.processedSnapshotCount > 0
          ? dates[run.processedSnapshotCount - 1]!
          : pointDate;
      try {
        facts = await loadFacts(userId, run, pointDate);
      } catch {
        return { ok: false, reason: "build-failed" };
      }
      const built = buildHistoricalSnapshots({
        userId,
        baseCurrencyCode: facts.baseCurrencyCode,
        portfolioTimezone: facts.portfolioTimezone,
        rangeFrom: buildFromDate,
        rangeTo: pointDate,
        calculationVersion: run.calculationVersion,
        ledgerHistoryCompleteFrom: facts.historyCompleteFrom,
        securities: facts.securities,
        cashAccounts: facts.cashAccounts,
        fxObservations: facts.fxObservations,
        overrides: facts.overrides,
        calendarEvidence: facts.calendarEvidence,
      });
      if (!built.ok) return { ok: false, reason: "build-failed" };
      const point = built.points[built.points.length - 1];
      if (!point) {
        return completeAndPublish(
          userId,
          input,
          run,
          run.processedSnapshotCount,
          run.processedHoldingCount,
        );
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
            run.marketDataCutoff ?? run.updatedAt,
            input.now,
          ),
        );
      for (const holding of point.holdings.slice(holdingStart, holdingEnd)) {
        statements.push(
          holdingStatement(userId, run, point, holding, input.now),
        );
      }
      const nextHolding = holdingEnd >= point.holdings.length ? 0 : holdingEnd;
      const nextSnapshot =
        nextHolding === 0
          ? run.processedSnapshotCount + 1
          : run.processedSnapshotCount;
      statements.push({
        sql: `UPDATE calculation_runs SET processed_snapshot_count = ?, processed_holding_count = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND portfolio_id = ? AND status = 'running'
            AND lease_owner = ? AND lease_expires_at > ?
            AND ledger_high_water_start = ?
            AND processed_snapshot_count = ? AND processed_holding_count = ?`,
        params: [
          nextSnapshot,
          nextHolding,
          input.now,
          run.id,
          userId,
          input.portfolioId,
          input.leaseOwner,
          input.now,
          input.currentLedgerHighWater,
          run.processedSnapshotCount,
          run.processedHoldingCount,
        ],
      });
      await batch(statements);
      const after = await runs.get(userId, input.portfolioId, run.id);
      if (!after) return { ok: false, reason: "invalid-run" };
      if (
        after.processedSnapshotCount !== nextSnapshot ||
        after.processedHoldingCount !== nextHolding
      ) {
        return { ok: false, reason: "not-owned" };
      }
      if (nextSnapshot >= dates.length && nextHolding === 0) {
        const completed = await completeAndPublish(
          userId,
          input,
          run,
          nextSnapshot,
          nextHolding,
        );
        return completed.ok
          ? { ...completed, pointDate: point.date }
          : completed;
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
        `SELECT p.base_currency_code, r.ledger_high_water_end,
           r.range_from, r.range_to, r.calculation_version,
           sp.calculation_run_id
         FROM snapshot_publications sp
         JOIN calculation_runs r
           ON r.id = sp.calculation_run_id AND r.user_id = sp.user_id
          AND r.portfolio_id = sp.portfolio_id
         JOIN portfolios p ON p.id = r.portfolio_id AND p.user_id = r.user_id
         WHERE sp.user_id = ? AND sp.portfolio_id = ?
           AND sp.calculation_version = ? AND r.status = 'completed'
           AND r.range_from <= ? AND r.range_to >= ?
         LIMIT 1`,
        [userId, portfolioId, calculationVersion, rangeFrom, rangeTo],
      );
      if (!run) return null;
      const rows = await sql.all<Record<string, unknown>>(
        `SELECT snapshot_date, total_value_decimal, securities_value_decimal, cash_value_decimal,
           daily_movement_decimal, completeness, coverage_json
         FROM portfolio_daily_snapshots
         WHERE user_id = ? AND portfolio_id = ? AND snapshot_date BETWEEN ? AND ?
           AND calculation_version = ? AND calculation_run_id = ?
           AND ledger_high_water = ? AND status = 'ready' ORDER BY snapshot_date`,
        [
          userId,
          portfolioId,
          rangeFrom,
          rangeTo,
          calculationVersion,
          String(run.calculation_run_id),
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
