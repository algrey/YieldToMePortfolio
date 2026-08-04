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
  transactions: readonly SnapshotLedgerTransaction[];
  priceObservations: readonly SnapshotPriceObservation[];
  expectedTradingDates?: readonly string[];
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
};

export type HistoricalHoldingSnapshot = {
  portfolioSecurityId: string;
  quantityDecimal: string;
  nativeValueDecimal: string | null;
  baseValueDecimal: string | null;
  basisDecimal: string | null;
  priceObservationId: string | null;
  fxObservationId: string | null;
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
        | "too_many_cash_entries";
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
): PriceSelection {
  return selectPriceObservation({
    asOf: date,
    targetKey: security.mappingId ?? security.portfolioSecurityId,
    userId: input.userId,
    portfolioTimezone: input.portfolioTimezone,
    scope: input.priceScope,
    currencyCode: security.currencyCode,
    // Ledger replay already applies explicit splits, so adjusted closes would
    // double-adjust historical value. Snapshot valuation uses raw closes only.
    observations: security.priceObservations.filter(
      (observation) => observation.adjustmentState === "raw",
    ),
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
  const price = priceSelection(security, date, input);
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
  const calendarStatus =
    security.expectedTradingDates === undefined
      ? "unknown"
      : !security.expectedTradingDates.includes(date)
        ? "holiday"
        : price.selected !== null && price.selected.marketDate === date
          ? "session"
          : "missing_session";
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
