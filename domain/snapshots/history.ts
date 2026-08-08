import {
  addDecimal,
  compareDecimal,
  formatDecimalExact,
  fromInteger,
  multiplyDecimal,
  parseDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";
import {
  calculateCashConversion,
  calculateDailyMovement,
  calculateNativeHomeHolding,
  type FxEvidence,
} from "../calculations/multi-currency.ts";
import {
  buildLedgerProjections,
  type ProjectionLedgerTransaction,
} from "../ledger/projections.ts";
import {
  selectFxObservation,
  selectPriceObservation,
  type FxSelection,
  type PriceSelection,
} from "../market-data/selection.ts";
import type {
  FxObservation,
  ManualOverride,
  ObservationScope,
  PriceObservation,
} from "../market-data/contracts.ts";

const ZERO = fromInteger(0n);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const HISTORICAL_CALENDAR_LIMITS = Object.freeze({
  maxCalendars: 256,
  maxSessions: 50_000,
  maxEvidenceBytes: 2_000_000,
});

export const HISTORICAL_SNAPSHOT_LIMITS = Object.freeze({
  maxRangeDays: 3_660,
  maxSecurities: 10_000,
  maxTransactions: 100_000,
  maxCashEntries: 100_000,
});

export type SnapshotPriceObservation = PriceObservation & { id: string };
export type SnapshotFxObservation = FxObservation & { id: string };

export type SnapshotLedgerTransaction = ProjectionLedgerTransaction & {
  localDate: string;
};

export type SnapshotCashLedgerEntry = {
  id: string;
  accountId: string;
  localDate: string;
  signedAmountDecimal: string;
  status: "posted" | "reversed";
  reversesEntryId: string | null;
};

export type HistoricalSecurityInput = {
  portfolioSecurityId: string;
  securityId: string | null;
  mappingId: string | null;
  currencyCode: string;
  exchangeId?: string | null;
  exchangeMic?: string | null;
  transactions: readonly SnapshotLedgerTransaction[];
  priceObservations: readonly SnapshotPriceObservation[];
};

export type HistoricalExchangeSession = {
  sessionId: string;
  marketDate: string;
  openAt: string;
  closeAt: string;
};

export type HistoricalExchangeCalendarEvidence = {
  exchangeId?: string | null;
  mic: string;
  calendarCode: string;
  timezone: string;
  validFrom: string;
  validTo: string;
  source: string;
  revision: string;
  sessions: readonly HistoricalExchangeSession[];
};

export type HistoricalCalendarEvidence = {
  version: 2;
  calendars: readonly HistoricalExchangeCalendarEvidence[];
};

export type HistoricalCashAccountInput = {
  id: string;
  currencyCode: string;
  completeness: "complete" | "opening_balance" | "incomplete";
  entries: readonly SnapshotCashLedgerEntry[];
};

export type SnapshotGap = {
  kind:
    | "incomplete_history"
    | "missing_price"
    | "stale_price"
    | "missing_session"
    | "missing_fx"
    | "stale_fx"
    | "incomplete_basis"
    | "invalid_ledger"
    | "cash_incomplete"
    | "quantity_boundary";
  componentId: string;
};

export type SnapshotCoverage = {
  totalHoldingCount: number;
  nonZeroHoldingCount: number;
  pricedHoldingCount: number;
  convertedHoldingCount: number;
  basisCoveredHoldingCount: number;
  zeroHoldingCount: number;
  totalCashAccountCount: number;
  nonZeroCashAccountCount: number;
  convertedCashAccountCount: number;
  zeroCashAccountCount: number;
  excludedHoldingIds: readonly string[];
  excludedCashAccountIds: readonly string[];
  gaps: readonly SnapshotGap[];
  marketDataStates: readonly SnapshotMarketDataState[];
  historyComplete: boolean;
};

export type SnapshotMarketDataState = {
  componentId: string;
  priceState: PriceSelection["status"] | null;
  fxState: FxSelection["status"];
  priceObservationId: string | null;
  fxObservationId: string | null;
  priceMarketDate: string | null;
  fxMarketDate: string | null;
  calendarStatus: "session" | "holiday" | "missing_session" | "unknown";
  exchangeMic?: string | null;
  calendarSessionId?: string | null;
  calendarSessionDate?: string | null;
  calendarSessionCloseAt?: string | null;
};

export type HistoricalHoldingSnapshot = {
  portfolioSecurityId: string;
  quantityDecimal: string;
  nativeValueDecimal: string | null;
  baseValueDecimal: string | null;
  basisDecimal: string | null;
  priceObservationId: string | null;
  fxObservationId: string | null;
  calendarSessionId: string | null;
  calendarSessionDate: string | null;
  calendarSessionCloseAt: string | null;
  calendarEvidenceVersion: number | null;
  dailyMovementDecimal: string | null;
  completeness: "complete" | "partial" | "incomplete";
};

export type HistoricalSnapshotPoint = {
  date: string;
  baseCurrencyCode: string;
  securitiesValueDecimal: string | null;
  cashValueDecimal: string | null;
  totalValueDecimal: string | null;
  costBasisDecimal: string | null;
  unrealisedGainDecimal: string | null;
  realisedGainToDateDecimal: string | null;
  dailyMovementDecimal: string | null;
  coverage: SnapshotCoverage;
  completeness: "complete" | "partial" | "incomplete";
  excludedFromPerformance: boolean;
  holdings: readonly HistoricalHoldingSnapshot[];
};

export type HistoricalSnapshotBuildInput = {
  userId?: string;
  baseCurrencyCode: string;
  portfolioTimezone?: string;
  rangeFrom: string;
  rangeTo: string;
  calculationVersion: number;
  ledgerHistoryCompleteFrom: string | null;
  securities: readonly HistoricalSecurityInput[];
  cashAccounts: readonly HistoricalCashAccountInput[];
  fxObservations: readonly SnapshotFxObservation[];
  overrides?: readonly ManualOverride[];
  priceScope?: ObservationScope;
  fxScope?: ObservationScope;
  maxPriorCalendarDays?: number;
  calendarEvidence?: HistoricalCalendarEvidence;
};

export type HistoricalSnapshotBuildResult =
  | { ok: true; points: readonly HistoricalSnapshotPoint[] }
  | {
      ok: false;
      reason:
        | "invalid_range"
        | "range_too_large"
        | "too_many_securities"
        | "too_many_transactions"
        | "too_many_cash_entries"
        | "invalid_calendar_evidence";
    };

type PreparedHolding = HistoricalHoldingSnapshot & {
  ledgerValid: boolean;
  priceDecimal: string | null;
  fxEvidence: FxEvidence | null;
  fxRateDecimal: string | null;
  priceStatus: PriceSelection["status"];
  fxStatus: FxSelection["status"];
  priceMarketDate: string | null;
  fxMarketDate: string | null;
  calendarStatus: SnapshotMarketDataState["calendarStatus"];
};

type PreparedCash = {
  accountId: string;
  currencyCode: string;
  balanceDecimal: string;
  balanceValid: boolean;
  valueDecimal: string | null;
  fxEvidence: FxEvidence | null;
  fxRateDecimal: string | null;
  fxMarketDate: string | null;
  fxStatus: FxSelection["status"];
  dailyMovementDecimal: string | null;
  completeness: "complete" | "partial" | "incomplete";
};

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function dateRange(from: string, to: string): string[] | null {
  if (!isValidDate(from) || !isValidDate(to) || to < from) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const count = Math.floor((end - start) / DAY_MS) + 1;
  if (count > HISTORICAL_SNAPSHOT_LIMITS.maxRangeDays) return null;
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * DAY_MS).toISOString().slice(0, 10),
  );
}

function parse(value: string): DecimalFraction | null {
  try {
    return parseDecimal(value);
  } catch {
    return null;
  }
}

function localDateAt(timestamp: string, timezone: string): string | null {
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
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
  if (!isValidDate(date)) return null;
  const start = Date.parse(`${date}T00:00:00Z`) - 36 * 60 * 60 * 1000;
  let low = start;
  let high = start + 4 * DAY_MS;
  if (localDateAt(new Date(high).toISOString(), timezone) === null) return null;
  // Find the first instant after the requested local date. This remains
  // correct across the one-hour offset changes at DST boundaries.
  for (let index = 0; index < 52; index += 1) {
    const middle = Math.floor((low + high) / 2);
    const local = localDateAt(new Date(middle).toISOString(), timezone);
    if (local !== null && local <= date) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    value.endsWith("Z")
  );
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function exchangeCalendarsFor(
  security: HistoricalSecurityInput,
  evidence: HistoricalCalendarEvidence | undefined,
): HistoricalExchangeCalendarEvidence[] {
  if (!evidence) return [];
  return evidence.calendars
    .filter(
      (calendar) =>
        (security.exchangeId !== undefined &&
          security.exchangeId !== null &&
          calendar.exchangeId === security.exchangeId) ||
        ((security.exchangeId === undefined || security.exchangeId === null) &&
          security.exchangeMic !== undefined &&
          security.exchangeMic !== null &&
          calendar.mic === security.exchangeMic),
    )
    .slice()
    .sort(
      (left, right) =>
        left.validFrom.localeCompare(right.validFrom) ||
        left.validTo.localeCompare(right.validTo) ||
        left.revision.localeCompare(right.revision),
    );
}

function sessionAtCutoff(
  security: HistoricalSecurityInput,
  date: string,
  input: HistoricalSnapshotBuildInput,
): {
  calendar: HistoricalExchangeCalendarEvidence;
  session: HistoricalExchangeSession | null;
  status: SnapshotMarketDataState["calendarStatus"];
} | null {
  const cutoff = portfolioCutoff(date, input.portfolioTimezone ?? "UTC");
  const candidates = exchangeCalendarsFor(security, input.calendarEvidence);
  if (candidates.length === 0 || cutoff === null) return null;
  const applicable = candidates
    .map((candidate) => ({
      calendar: candidate,
      exchangeDate: localDateAt(
        new Date(cutoff).toISOString(),
        candidate.timezone,
      ),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        calendar: HistoricalExchangeCalendarEvidence;
        exchangeDate: string;
      } =>
        candidate.exchangeDate !== null &&
        candidate.exchangeDate >= candidate.calendar.validFrom &&
        candidate.exchangeDate <= candidate.calendar.validTo,
    );
  if (applicable.length !== 1) {
    return { calendar: candidates[0]!, session: null, status: "unknown" };
  }
  const { calendar, exchangeDate } = applicable[0]!;
  const sessions = candidates
    .flatMap((candidate) =>
      candidate.sessions.map((session) => ({ calendar: candidate, session })),
    )
    .filter(
      ({ session }) => session.closeAt && Date.parse(session.closeAt) <= cutoff,
    )
    .sort(
      (left, right) =>
        Date.parse(right.session.closeAt) - Date.parse(left.session.closeAt) ||
        right.session.sessionId.localeCompare(left.session.sessionId),
    );
  const selected = sessions[0] ?? null;
  const session = selected?.session ?? null;
  const expected = calendar.sessions.find(
    (candidate) => candidate.marketDate === exchangeDate,
  );
  if (!expected) {
    return { calendar, session, status: session ? "holiday" : "unknown" };
  }
  if (
    Date.parse(expected.closeAt) <= cutoff &&
    session?.marketDate !== expected.marketDate
  ) {
    return { calendar, session, status: "missing_session" };
  }
  return { calendar, session, status: "session" };
}

function validCalendarEvidence(
  evidence: HistoricalCalendarEvidence | undefined,
): boolean {
  if (!evidence) return true;
  if (
    evidence.version !== 2 ||
    !Array.isArray(evidence.calendars) ||
    evidence.calendars.length > HISTORICAL_CALENDAR_LIMITS.maxCalendars
  ) {
    return false;
  }
  let sessionCount = 0;
  const calendarsByIdentity = new Map<
    string,
    HistoricalExchangeCalendarEvidence[]
  >();
  for (const calendar of evidence.calendars) {
    if (
      typeof calendar !== "object" ||
      calendar === null ||
      typeof calendar.mic !== "string" ||
      calendar.mic.length === 0 ||
      typeof calendar.calendarCode !== "string" ||
      calendar.calendarCode.length === 0 ||
      !validTimezone(calendar.timezone) ||
      typeof calendar.source !== "string" ||
      calendar.source.length === 0 ||
      typeof calendar.revision !== "string" ||
      calendar.revision.length === 0 ||
      (calendar.exchangeId !== undefined &&
        calendar.exchangeId !== null &&
        (typeof calendar.exchangeId !== "string" ||
          calendar.exchangeId.length === 0)) ||
      !Array.isArray(calendar.sessions) ||
      !isValidDate(calendar.validFrom) ||
      !isValidDate(calendar.validTo) ||
      calendar.validTo < calendar.validFrom
    ) {
      return false;
    }
    const identity = `${calendar.exchangeId ?? ""}/${calendar.mic}`;
    const calendars = calendarsByIdentity.get(identity) ?? [];
    calendars.push(calendar);
    calendarsByIdentity.set(identity, calendars);
    const sessionIds = new Set<string>();
    for (const session of calendar.sessions) {
      sessionCount += 1;
      if (
        typeof session !== "object" ||
        session === null ||
        typeof session.sessionId !== "string" ||
        session.sessionId.length === 0 ||
        sessionIds.has(session.sessionId) ||
        !isValidDate(session.marketDate) ||
        session.marketDate < calendar.validFrom ||
        session.marketDate > calendar.validTo ||
        !validInstant(session.openAt) ||
        !validInstant(session.closeAt) ||
        Date.parse(session.openAt) >= Date.parse(session.closeAt)
      ) {
        return false;
      }
      sessionIds.add(session.sessionId);
    }
  }
  for (const calendars of calendarsByIdentity.values()) {
    calendars.sort(
      (left, right) =>
        left.validFrom.localeCompare(right.validFrom) ||
        left.validTo.localeCompare(right.validTo),
    );
    for (let index = 1; index < calendars.length; index += 1) {
      if (calendars[index - 1]!.validTo >= calendars[index]!.validFrom) {
        return false;
      }
    }
  }
  if (sessionCount > HISTORICAL_CALENDAR_LIMITS.maxSessions) return false;
  try {
    return (
      JSON.stringify(evidence).length <=
      HISTORICAL_CALENDAR_LIMITS.maxEvidenceBytes
    );
  } catch {
    return false;
  }
}

function addValues(values: readonly (string | null)[]): string | null {
  let total = ZERO;
  for (const value of values) {
    if (value === null) return null;
    const parsed = parse(value);
    if (parsed === null) return null;
    total = addDecimal(total, parsed);
  }
  return formatDecimalExact(total);
}

function sumKnown(values: readonly (string | null)[]): string | null {
  let total = ZERO;
  let known = false;
  for (const value of values) {
    if (value === null) continue;
    const parsed = parse(value);
    if (parsed === null) return null;
    total = addDecimal(total, parsed);
    known = true;
  }
  return known ? formatDecimalExact(total) : null;
}

function nonZero(value: string): boolean {
  const parsed = parse(value);
  return parsed !== null && compareDecimal(parsed, ZERO) !== 0;
}

function activeEntries<T extends { status: string }>(
  entries: readonly T[],
): T[] {
  // Cash reversals are compensating entries. Both the immutable original and
  // its negating entry must remain in the balance replay.
  return entries.filter((entry) => entry.status === "posted");
}

function toFxEvidence(selection: FxSelection): FxEvidence | null {
  const selected = selection.selected;
  if (!selected) return null;
  const source: FxEvidence["source"] =
    selected.source === "provider" ? "provider" : selected.source;
  const quality: FxEvidence["quality"] =
    selected.quality === "manual" || selected.quality === "identity"
      ? selected.quality
      : selected.quality;
  return {
    rateDecimal: selected.rateDecimal,
    baseCurrencyCode: selected.baseCurrencyCode,
    quoteCurrencyCode: selected.quoteCurrencyCode,
    marketDate: selected.marketDate,
    observedAt: selected.observedAt,
    source,
    sourceId:
      selected.observation && "id" in selected.observation
        ? String((selected.observation as SnapshotFxObservation).id)
        : selected.providerId,
    selectionState:
      selection.status === "stale"
        ? "stale"
        : selection.status === "fallback"
          ? "fallback"
          : "current",
    quality,
    fallback: selection.explanation.fallback,
    selectionReason: selection.explanation.reason,
  };
}

function priceId(selection: PriceSelection): string | null {
  const observation = selection.selected?.observation;
  return observation && "id" in observation
    ? String((observation as SnapshotPriceObservation).id)
    : null;
}

function fxId(selection: FxSelection): string | null {
  const observation = selection.selected?.observation;
  return observation && "id" in observation
    ? String((observation as SnapshotFxObservation).id)
    : null;
}

function projectionAt(
  security: HistoricalSecurityInput,
  date: string,
):
  | {
      ok: true;
      quantity: string;
      basis: string | null;
      realised: string | null;
    }
  | { ok: false } {
  const transactions = security.transactions
    .filter((transaction) => transaction.localDate <= date)
    .slice()
    .sort(
      (left, right) =>
        left.tradeAt.localeCompare(right.tradeAt) ||
        left.id.localeCompare(right.id),
    )
    .map((transaction) => {
      const projected: ProjectionLedgerTransaction = { ...transaction };
      return projected;
    });
  const result = buildLedgerProjections(transactions);
  if (!result.ok) return { ok: false };
  const holding = result.holdings.find(
    (candidate) =>
      candidate.portfolioSecurityId === security.portfolioSecurityId,
  );
  const allocations = result.allocations.filter(
    (allocation) =>
      allocation.portfolioSecurityId === security.portfolioSecurityId,
  );
  const realised = allocations.map(
    (allocation) => allocation.baseRealisedGainDecimal,
  );
  return {
    ok: true,
    quantity: holding?.quantityDecimal ?? "0",
    basis: holding ? holding.baseOpenBasisDecimal : "0",
    realised: addValues(realised),
  };
}

function priceSelection(
  security: HistoricalSecurityInput,
  date: string,
  input: HistoricalSnapshotBuildInput,
  selectorDate = date,
): PriceSelection {
  const cutoff = input.portfolioTimezone
    ? portfolioCutoff(date, input.portfolioTimezone)
    : null;
  const observations = security.priceObservations.filter((observation) => {
    if (observation.adjustmentState !== "raw") return false;
    if (observation.marketDate > selectorDate) return false;
    if (!input.portfolioTimezone) return true;
    if (cutoff === null) return false;
    const observedAt = Date.parse(observation.observationAt);
    return Number.isFinite(observedAt) && observedAt <= cutoff;
  });
  return selectPriceObservation({
    asOf: selectorDate,
    targetKey: security.mappingId ?? security.portfolioSecurityId,
    userId: input.userId,
    // Availability is filtered against the requested portfolio-local cutoff
    // above. Passing no timezone here avoids applying the selected exchange
    // session date as a second, narrower cutoff.
    portfolioTimezone: cutoff === null ? input.portfolioTimezone : undefined,
    scope: input.priceScope,
    currencyCode: security.currencyCode,
    // Ledger replay already applies explicit splits, so adjusted closes would
    // double-adjust historical value. Snapshot valuation uses raw closes only.
    observations,
    overrides: input.overrides,
    maxPriorCalendarDays: input.maxPriorCalendarDays,
  });
}

function fxSelection(
  currencyCode: string,
  date: string,
  input: HistoricalSnapshotBuildInput,
): FxSelection {
  return selectFxObservation({
    asOf: date,
    targetKey: `${input.baseCurrencyCode}/${currencyCode}`,
    userId: input.userId,
    portfolioTimezone: input.portfolioTimezone,
    scope: input.fxScope,
    baseCurrencyCode: input.baseCurrencyCode,
    quoteCurrencyCode: currencyCode,
    observations: input.fxObservations,
    overrides: input.overrides,
    maxPriorCalendarDays: input.maxPriorCalendarDays,
  });
}

function holdingAt(
  security: HistoricalSecurityInput,
  date: string,
  input: HistoricalSnapshotBuildInput,
): PreparedHolding {
  const projection = projectionAt(security, date);
  if (!projection.ok) {
    return {
      portfolioSecurityId: security.portfolioSecurityId,
      quantityDecimal: "0",
      nativeValueDecimal: null,
      baseValueDecimal: null,
      basisDecimal: null,
      priceObservationId: null,
      fxObservationId: null,
      calendarSessionId: null,
      calendarSessionDate: null,
      calendarSessionCloseAt: null,
      calendarEvidenceVersion: input.calendarEvidence?.version ?? null,
      dailyMovementDecimal: null,
      completeness: "incomplete",
      ledgerValid: false,
      priceDecimal: null,
      fxEvidence: null,
      fxRateDecimal: null,
      priceStatus: "unavailable",
      fxStatus: "unavailable",
      priceMarketDate: null,
      fxMarketDate: null,
      calendarStatus: "unknown",
    };
  }
  if (!nonZero(projection.quantity)) {
    return {
      portfolioSecurityId: security.portfolioSecurityId,
      quantityDecimal: projection.quantity,
      nativeValueDecimal: "0",
      baseValueDecimal: "0",
      basisDecimal: projection.basis,
      priceObservationId: null,
      fxObservationId: null,
      calendarSessionId: null,
      calendarSessionDate: null,
      calendarSessionCloseAt: null,
      calendarEvidenceVersion: input.calendarEvidence?.version ?? null,
      dailyMovementDecimal: null,
      completeness: "complete",
      ledgerValid: true,
      priceDecimal: null,
      fxEvidence: null,
      fxRateDecimal: null,
      priceStatus: "unavailable",
      fxStatus: "unavailable",
      priceMarketDate: null,
      fxMarketDate: null,
      calendarStatus: "unknown",
    };
  }
  const calendar = sessionAtCutoff(security, date, input);
  const sessionDate = calendar?.session?.marketDate ?? date;
  const price = priceSelection(security, date, input, sessionDate);
  const fx = fxSelection(security.currencyCode, date, input);
  const fxEvidence = toFxEvidence(fx);
  const calculation = calculateNativeHomeHolding({
    quantityDecimal: projection.quantity,
    nativePriceDecimal: price.selected?.closeDecimal ?? null,
    nativeCurrencyCode: security.currencyCode,
    homeCurrencyCode: input.baseCurrencyCode,
    valuationFx: fxEvidence,
  });
  const nativeValue =
    calculation.facts.nativeMarketValue.status === "available"
      ? calculation.facts.nativeMarketValue.valueDecimal
      : null;
  const priceUsable = price.selected !== null && price.status !== "stale";
  const fxUsable = fx.selected !== null && fx.status !== "stale";
  let calendarStatus = calendar?.status ?? "unknown";
  if (
    calendar?.status === "session" &&
    calendar.session !== null &&
    price.selected?.marketDate !== calendar.session.marketDate
  ) {
    calendarStatus = "missing_session";
  }
  const baseValue =
    priceUsable &&
    fxUsable &&
    calculation.facts.homeMarketValue.status === "available"
      ? calculation.facts.homeMarketValue.valueDecimal
      : null;
  const completeness =
    baseValue === null || projection.basis === null ? "partial" : "complete";
  return {
    portfolioSecurityId: security.portfolioSecurityId,
    quantityDecimal: projection.quantity,
    nativeValueDecimal: nativeValue,
    baseValueDecimal: baseValue,
    basisDecimal: projection.basis,
    priceObservationId: priceId(price),
    fxObservationId: fxId(fx),
    calendarSessionId: calendar?.session?.sessionId ?? null,
    calendarSessionDate: calendar?.session?.marketDate ?? null,
    calendarSessionCloseAt: calendar?.session?.closeAt ?? null,
    calendarEvidenceVersion: input.calendarEvidence?.version ?? null,
    dailyMovementDecimal: null,
    completeness,
    ledgerValid: true,
    priceDecimal: price.selected?.closeDecimal ?? null,
    fxEvidence,
    fxRateDecimal: fx.selected?.rateDecimal ?? null,
    priceStatus: price.status,
    fxStatus: fx.status,
    priceMarketDate: price.selected?.marketDate ?? null,
    fxMarketDate: fx.selected?.marketDate ?? null,
    calendarStatus,
  };
}

function cashAt(
  account: HistoricalCashAccountInput,
  date: string,
  input: HistoricalSnapshotBuildInput,
): PreparedCash {
  const entries = activeEntries(
    account.entries.filter((entry) => entry.localDate <= date),
  );
  const calculatedBalance = addValues(
    entries.map((entry) => entry.signedAmountDecimal),
  );
  const balance = calculatedBalance ?? "0";
  if (calculatedBalance === null) {
    return {
      accountId: account.id,
      currencyCode: account.currencyCode,
      balanceDecimal: balance,
      balanceValid: false,
      valueDecimal: null,
      fxEvidence: null,
      fxRateDecimal: null,
      fxStatus: "unavailable",
      fxMarketDate: null,
      dailyMovementDecimal: null,
      completeness: "incomplete",
    };
  }
  if (!nonZero(balance)) {
    return {
      accountId: account.id,
      currencyCode: account.currencyCode,
      balanceDecimal: balance,
      balanceValid: true,
      valueDecimal: "0",
      fxEvidence: null,
      fxRateDecimal: null,
      fxStatus: "current",
      fxMarketDate: null,
      dailyMovementDecimal: null,
      completeness: "complete",
    };
  }
  const fx = fxSelection(account.currencyCode, date, input);
  const fxEvidence = toFxEvidence(fx);
  const converted = calculateCashConversion({
    balanceDecimal: balance,
    currencyCode: account.currencyCode,
    homeCurrencyCode: input.baseCurrencyCode,
    valuationFx: fxEvidence,
  });
  const fxUsable = fx.selected !== null && fx.status !== "stale";
  const value =
    fxUsable && converted.compact.homeValue.status === "available"
      ? converted.compact.homeValue.valueDecimal
      : null;
  return {
    accountId: account.id,
    currencyCode: account.currencyCode,
    balanceDecimal: balance,
    balanceValid: true,
    valueDecimal: value,
    fxEvidence,
    fxRateDecimal: fx.selected?.rateDecimal ?? null,
    fxStatus: fx.status,
    fxMarketDate: fx.selected?.marketDate ?? null,
    dailyMovementDecimal: null,
    completeness:
      account.completeness === "incomplete" || value === null
        ? "partial"
        : "complete",
  };
}

function movement(
  quantity: string,
  currentPrice: string | null,
  previousPrice: string | null,
  currencyCode: string,
  baseCurrencyCode: string,
  currentFx: FxEvidence | null,
  previousFx: FxEvidence | null,
  quantityComparable: boolean,
): string | null {
  if (currentPrice === null || previousPrice === null) return null;
  const result = calculateDailyMovement({
    quantityDecimal: quantity,
    currentPriceDecimal: currentPrice,
    previousPriceDecimal: previousPrice,
    nativeCurrencyCode: currencyCode,
    homeCurrencyCode: baseCurrencyCode,
    currentFx,
    previousFx,
    quantityTiming: quantityComparable ? "comparable" : "incomplete",
  });
  return result.compact.homeMovement.status === "available"
    ? result.compact.homeMovement.valueDecimal
    : null;
}

export function buildHistoricalSnapshots(
  input: HistoricalSnapshotBuildInput,
): HistoricalSnapshotBuildResult {
  const dates = dateRange(input.rangeFrom, input.rangeTo);
  if (!dates) {
    const valid =
      isValidDate(input.rangeFrom) &&
      isValidDate(input.rangeTo) &&
      input.rangeTo >= input.rangeFrom;
    return { ok: false, reason: valid ? "range_too_large" : "invalid_range" };
  }
  if (!validCalendarEvidence(input.calendarEvidence)) {
    return { ok: false, reason: "invalid_calendar_evidence" };
  }
  if (input.securities.length > HISTORICAL_SNAPSHOT_LIMITS.maxSecurities) {
    return { ok: false, reason: "too_many_securities" };
  }
  const transactionCount = input.securities.reduce(
    (count, security) => count + security.transactions.length,
    0,
  );
  if (transactionCount > HISTORICAL_SNAPSHOT_LIMITS.maxTransactions) {
    return { ok: false, reason: "too_many_transactions" };
  }
  const cashEntryCount = input.cashAccounts.reduce(
    (count, account) => count + account.entries.length,
    0,
  );
  if (cashEntryCount > HISTORICAL_SNAPSHOT_LIMITS.maxCashEntries) {
    return { ok: false, reason: "too_many_cash_entries" };
  }

  const previousHoldings = new Map<string, PreparedHolding>();
  const previousCash = new Map<string, PreparedCash>();
  const points: HistoricalSnapshotPoint[] = [];
  for (const date of dates) {
    const holdings = input.securities
      .slice()
      .sort((left, right) =>
        left.portfolioSecurityId.localeCompare(right.portfolioSecurityId),
      )
      .map((security) => holdingAt(security, date, input));
    const cash = input.cashAccounts
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((account) => cashAt(account, date, input));
    const gaps: SnapshotGap[] = [];
    const marketDataStates: SnapshotMarketDataState[] = [];
    let valuedHoldingCount = 0;
    let convertedHoldingCount = 0;
    let basisCoveredHoldingCount = 0;
    let zeroHoldingCount = 0;
    for (const holding of holdings) {
      const previous = previousHoldings.get(holding.portfolioSecurityId);
      if (!holding.ledgerValid) {
        gaps.push({
          kind: "invalid_ledger",
          componentId: holding.portfolioSecurityId,
        });
      } else if (nonZero(holding.quantityDecimal)) {
        marketDataStates.push({
          componentId: holding.portfolioSecurityId,
          priceState: holding.priceStatus,
          fxState: holding.fxStatus,
          priceObservationId: holding.priceObservationId,
          fxObservationId: holding.fxObservationId,
          priceMarketDate: holding.priceMarketDate,
          fxMarketDate: holding.fxMarketDate,
          calendarStatus: holding.calendarStatus,
          exchangeMic:
            input.securities.find(
              (security) =>
                security.portfolioSecurityId === holding.portfolioSecurityId,
            )?.exchangeMic ?? null,
          calendarSessionId: holding.calendarSessionId,
          calendarSessionDate: holding.calendarSessionDate,
        });
        if (holding.nativeValueDecimal !== null) valuedHoldingCount += 1;
        if (holding.baseValueDecimal !== null) convertedHoldingCount += 1;
        if (holding.basisDecimal !== null) basisCoveredHoldingCount += 1;
        if (holding.baseValueDecimal === null) {
          const kind =
            holding.priceStatus === "stale"
              ? "stale_price"
              : holding.priceStatus === "unavailable"
                ? "missing_price"
                : holding.fxStatus === "stale"
                  ? "stale_fx"
                  : "missing_fx";
          gaps.push({ kind, componentId: holding.portfolioSecurityId });
        }
        if (holding.calendarStatus === "missing_session") {
          gaps.push({
            kind: "missing_session",
            componentId: holding.portfolioSecurityId,
          });
        }
        if (holding.basisDecimal === null) {
          gaps.push({
            kind: "incomplete_basis",
            componentId: holding.portfolioSecurityId,
          });
        }
      } else {
        zeroHoldingCount += 1;
      }
      const comparable =
        previous !== undefined &&
        previous.quantityDecimal === holding.quantityDecimal &&
        holding.priceStatus !== "stale" &&
        holding.priceStatus !== "unavailable" &&
        previous.priceStatus !== "stale" &&
        previous.priceStatus !== "unavailable" &&
        holding.fxStatus !== "stale" &&
        holding.fxStatus !== "unavailable" &&
        previous.fxStatus !== "stale" &&
        previous.fxStatus !== "unavailable";
      holding.dailyMovementDecimal =
        comparable && previous
          ? movement(
              holding.quantityDecimal,
              holding.priceDecimal,
              previous.priceDecimal,
              input.securities.find(
                (security) =>
                  security.portfolioSecurityId === holding.portfolioSecurityId,
              )?.currencyCode ?? input.baseCurrencyCode,
              input.baseCurrencyCode,
              holding.fxEvidence,
              previous.fxEvidence,
              true,
            )
          : null;
      if (previous && !comparable && nonZero(holding.quantityDecimal)) {
        gaps.push({
          kind: "quantity_boundary",
          componentId: holding.portfolioSecurityId,
        });
      }
    }
    let convertedCashAccountCount = 0;
    let zeroCashAccountCount = 0;
    for (const account of cash) {
      const previous = previousCash.get(account.accountId);
      if (!account.balanceValid) {
        gaps.push({ kind: "cash_incomplete", componentId: account.accountId });
      } else if (nonZero(account.balanceDecimal)) {
        marketDataStates.push({
          componentId: account.accountId,
          priceState: null,
          fxState: account.fxStatus,
          priceObservationId: null,
          fxObservationId: null,
          priceMarketDate: null,
          fxMarketDate: account.fxMarketDate,
          calendarStatus: "unknown",
          exchangeMic: null,
          calendarSessionId: null,
          calendarSessionDate: null,
        });
        if (account.valueDecimal !== null) convertedCashAccountCount += 1;
        if (account.valueDecimal === null) {
          gaps.push({
            kind: account.fxEvidence === null ? "missing_fx" : "stale_fx",
            componentId: account.accountId,
          });
        }
      } else {
        zeroCashAccountCount += 1;
      }
      if (
        account.balanceValid &&
        nonZero(account.balanceDecimal) &&
        account.completeness !== "complete"
      ) {
        gaps.push({ kind: "cash_incomplete", componentId: account.accountId });
      }
      const comparable =
        previous !== undefined &&
        previous.balanceDecimal === account.balanceDecimal &&
        account.fxStatus !== "stale" &&
        account.fxStatus !== "unavailable" &&
        previous.fxStatus !== "stale" &&
        previous.fxStatus !== "unavailable";
      if (comparable && previous) {
        account.dailyMovementDecimal = movement(
          account.balanceDecimal,
          "1",
          "1",
          account.currencyCode,
          input.baseCurrencyCode,
          account.fxEvidence,
          previous.fxEvidence,
          true,
        );
      }
    }
    const securitiesValue = addValues(
      holdings.map((holding) => holding.baseValueDecimal),
    );
    const cashValue = addValues(cash.map((account) => account.valueDecimal));
    const totalValue =
      securitiesValue !== null && cashValue !== null
        ? formatDecimalExact(
            addDecimal(
              parse(securitiesValue) as DecimalFraction,
              parse(cashValue) as DecimalFraction,
            ),
          )
        : null;
    const costBasis = addValues(
      holdings
        .filter((holding) => nonZero(holding.quantityDecimal))
        .map((holding) => holding.basisDecimal),
    );
    const unrealised =
      securitiesValue !== null && costBasis !== null
        ? formatDecimalExact(
            addDecimal(
              parse(securitiesValue) as DecimalFraction,
              multiplyDecimal(
                parse(costBasis) as DecimalFraction,
                fromInteger(-1n),
              ),
            ),
          )
        : null;
    const realised = addValues(
      input.securities.map((security) => {
        const projection = projectionAt(security, date);
        return projection.ok ? projection.realised : null;
      }),
    );
    const dailyMovement = gaps.some((gap) => gap.kind === "quantity_boundary")
      ? null
      : sumKnown([
          ...holdings.map((holding) => holding.dailyMovementDecimal),
          ...cash.map((account) => account.dailyMovementDecimal),
        ]);
    const historyComplete =
      input.ledgerHistoryCompleteFrom !== null &&
      date >= input.ledgerHistoryCompleteFrom;
    if (!historyComplete)
      gaps.push({ kind: "incomplete_history", componentId: input.rangeFrom });
    const excludedHoldingIds = holdings
      .filter(
        (holding) =>
          (!holding.ledgerValid || nonZero(holding.quantityDecimal)) &&
          holding.baseValueDecimal === null,
      )
      .map((holding) => holding.portfolioSecurityId);
    const excludedCashAccountIds = cash
      .filter(
        (account) =>
          (!account.balanceValid || nonZero(account.balanceDecimal)) &&
          account.valueDecimal === null,
      )
      .map((account) => account.accountId);
    const coverage: SnapshotCoverage = {
      totalHoldingCount: holdings.length,
      nonZeroHoldingCount: holdings.length - zeroHoldingCount,
      pricedHoldingCount: valuedHoldingCount,
      convertedHoldingCount,
      basisCoveredHoldingCount,
      zeroHoldingCount,
      totalCashAccountCount: cash.length,
      nonZeroCashAccountCount: cash.length - zeroCashAccountCount,
      convertedCashAccountCount,
      zeroCashAccountCount,
      excludedHoldingIds,
      excludedCashAccountIds,
      gaps,
      marketDataStates,
      historyComplete,
    };
    const completeness: HistoricalSnapshotPoint["completeness"] =
      !historyComplete || (gaps.length > 0 && totalValue === null)
        ? "incomplete"
        : gaps.length > 0
          ? "partial"
          : "complete";
    points.push({
      date,
      baseCurrencyCode: input.baseCurrencyCode,
      securitiesValueDecimal: securitiesValue,
      cashValueDecimal: cashValue,
      totalValueDecimal: totalValue,
      costBasisDecimal: costBasis,
      unrealisedGainDecimal: unrealised,
      realisedGainToDateDecimal: realised,
      dailyMovementDecimal: historyComplete ? dailyMovement : null,
      coverage,
      completeness,
      excludedFromPerformance:
        !historyComplete ||
        gaps.some((gap) => gap.kind !== "quantity_boundary"),
      holdings,
    });
    previousHoldings.clear();
    for (const holding of holdings)
      previousHoldings.set(holding.portfolioSecurityId, { ...holding });
    previousCash.clear();
    for (const account of cash)
      previousCash.set(account.accountId, { ...account });
  }
  return { ok: true, points };
}
