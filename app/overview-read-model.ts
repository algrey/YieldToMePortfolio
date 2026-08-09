import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  formatDecimalFixed,
  multiplyDecimal,
  parseDecimalResult,
  subtractDecimal,
} from "../domain/calculations/index.ts";
import type {
  PublishedOverviewReadModel,
  PublishedOverviewSnapshot,
} from "../db/repositories/snapshots.ts";
import type {
  OwnedOverviewData,
  OwnedOverviewPoint,
} from "./components/portfolio-shell";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validResult(value: string | null, allowNegative = true): boolean {
  if (value === null) return true;
  try {
    const parsed = parseDecimalResult(value);
    return (
      allowNegative || compareDecimal(parsed, parseDecimalResult("0")) >= 0
    );
  } catch {
    return false;
  }
}

function validCoverage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const countKeys = [
    "totalHoldingCount",
    "nonZeroHoldingCount",
    "pricedHoldingCount",
    "convertedHoldingCount",
    "basisCoveredHoldingCount",
    "zeroHoldingCount",
    "totalCashAccountCount",
    "nonZeroCashAccountCount",
    "convertedCashAccountCount",
    "zeroCashAccountCount",
  ] as const;
  if (
    countKeys.some(
      (key) =>
        typeof value[key] !== "number" ||
        !Number.isSafeInteger(value[key]) ||
        value[key] < 0,
    )
  )
    return false;
  const count = (key: (typeof countKeys)[number]) => {
    const candidate = value[key];
    if (typeof candidate !== "number") return -1;
    return candidate;
  };
  if (
    count("nonZeroHoldingCount") + count("zeroHoldingCount") !==
      count("totalHoldingCount") ||
    count("pricedHoldingCount") > count("nonZeroHoldingCount") ||
    count("convertedHoldingCount") > count("pricedHoldingCount") ||
    count("basisCoveredHoldingCount") > count("nonZeroHoldingCount") ||
    count("nonZeroCashAccountCount") + count("zeroCashAccountCount") !==
      count("totalCashAccountCount") ||
    count("convertedCashAccountCount") > count("nonZeroCashAccountCount") ||
    typeof value.historyComplete !== "boolean" ||
    !Array.isArray(value.excludedHoldingIds) ||
    value.excludedHoldingIds.some(
      (id) => typeof id !== "string" || id.length === 0,
    ) ||
    !Array.isArray(value.excludedCashAccountIds) ||
    value.excludedCashAccountIds.some(
      (id) => typeof id !== "string" || id.length === 0,
    ) ||
    !Array.isArray(value.gaps) ||
    value.gaps.some(
      (gap) =>
        !isRecord(gap) ||
        typeof gap.componentId !== "string" ||
        typeof gap.kind !== "string",
    ) ||
    !Array.isArray(value.marketDataStates) ||
    value.marketDataStates.some((state) => {
      if (!isRecord(state) || typeof state.componentId !== "string") {
        return true;
      }
      const validState = (candidate: unknown) =>
        candidate === null ||
        candidate === "current" ||
        candidate === "fallback" ||
        candidate === "stale" ||
        candidate === "unavailable";
      return (
        !validState(state.priceState) ||
        !validState(state.fxState) ||
        (state.calendarStatus !== "session" &&
          state.calendarStatus !== "holiday" &&
          state.calendarStatus !== "missing_session" &&
          state.calendarStatus !== "unknown")
      );
    })
  )
    return false;
  return true;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function hasUnusableMarketData(value: Record<string, unknown>): boolean {
  const states = value.marketDataStates;
  if (!Array.isArray(states)) return true;
  return states.some((state: unknown) => {
    if (!isRecord(state)) return true;
    return (
      state.priceState === "stale" ||
      state.priceState === "unavailable" ||
      state.fxState === "stale" ||
      state.fxState === "unavailable"
    );
  });
}

function validSnapshot(point: PublishedOverviewSnapshot): boolean {
  const coverage = point.coverage;
  const hasIncompleteEvidence =
    isRecord(coverage) &&
    ((Array.isArray(coverage.gaps) && coverage.gaps.length > 0) ||
      (Array.isArray(coverage.excludedHoldingIds) &&
        coverage.excludedHoldingIds.length > 0) ||
      (Array.isArray(coverage.excludedCashAccountIds) &&
        coverage.excludedCashAccountIds.length > 0) ||
      coverage.historyComplete === false);
  return (
    typeof point.id === "string" &&
    point.id.length > 0 &&
    validDate(point.date) &&
    (point.completeness === "complete" ||
      point.completeness === "partial" ||
      point.completeness === "incomplete") &&
    validResult(point.totalValueDecimal) &&
    validResult(point.securitiesValueDecimal, false) &&
    validResult(point.cashValueDecimal) &&
    validResult(point.costBasisDecimal, false) &&
    validResult(point.unrealisedGainDecimal) &&
    validResult(point.realisedGainToDateDecimal) &&
    validResult(point.dailyMovementDecimal) &&
    (point.completeness === "complete" || hasIncompleteEvidence) &&
    (point.completeness !== "partial" || point.totalValueDecimal !== null) &&
    (point.completeness !== "complete" ||
      (isRecord(point.coverage) &&
        point.coverage.historyComplete === true &&
        Array.isArray(point.coverage.gaps) &&
        point.coverage.gaps.length === 0 &&
        Array.isArray(point.coverage.excludedHoldingIds) &&
        point.coverage.excludedHoldingIds.length === 0 &&
        Array.isArray(point.coverage.excludedCashAccountIds) &&
        point.coverage.excludedCashAccountIds.length === 0 &&
        point.coverage.pricedHoldingCount ===
          point.coverage.nonZeroHoldingCount &&
        point.coverage.convertedHoldingCount ===
          point.coverage.nonZeroHoldingCount &&
        point.coverage.basisCoveredHoldingCount ===
          point.coverage.nonZeroHoldingCount &&
        point.coverage.convertedCashAccountCount ===
          point.coverage.nonZeroCashAccountCount &&
        !hasUnusableMarketData(point.coverage) &&
        point.totalValueDecimal !== null &&
        point.securitiesValueDecimal !== null &&
        point.cashValueDecimal !== null &&
        point.costBasisDecimal !== null &&
        point.unrealisedGainDecimal !== null &&
        point.realisedGainToDateDecimal !== null)) &&
    validCoverage(point.coverage)
  );
}

function formatMoney(
  value: string | null,
  currencyCode: string,
  signed = false,
) {
  if (value === null) return null;
  try {
    const parsedValue = parseDecimalResult(value);
    const isZero = compareDecimal(parsedValue, parseDecimalResult("0")) === 0;
    const negative = !isZero && value.startsWith("-");
    const absolute = negative ? value.slice(1) : value;
    const parsed = parseDecimalResult(absolute);
    const sign = negative
      ? "−"
      : signed && compareDecimal(parsedValue, parseDecimalResult("0")) > 0
        ? "+"
        : "";
    return `${sign}${currencyCode} ${formatDecimalFixed(parsed, 2)}`;
  } catch {
    return null;
  }
}

function overviewPoint(
  point: PublishedOverviewSnapshot,
  currencyCode: string,
): OwnedOverviewPoint {
  return {
    date: point.date,
    value: formatMoney(point.totalValueDecimal, currencyCode),
    securities: formatMoney(point.securitiesValueDecimal, currencyCode),
    cash: formatMoney(point.cashValueDecimal, currencyCode),
    cost: formatMoney(point.costBasisDecimal, currencyCode),
    unrealised: formatMoney(point.unrealisedGainDecimal, currencyCode, true),
    realised: formatMoney(point.realisedGainToDateDecimal, currencyCode, true),
    daily: formatMoney(point.dailyMovementDecimal, currencyCode, true),
    valueDecimal: point.totalValueDecimal,
    completeness: point.completeness,
    barHeight: "0%",
  };
}

function addChartHeights(points: OwnedOverviewPoint[]): OwnedOverviewPoint[] {
  const values = points
    .map((point) => point.valueDecimal)
    .filter((value): value is string => value !== null);
  if (values.length === 0) return points;
  try {
    const parsed = values.map((value) => parseDecimalResult(value));
    let minimum = parsed[0]!;
    let maximum = parsed[0]!;
    for (const value of parsed.slice(1)) {
      if (compareDecimal(value, minimum) < 0) minimum = value;
      if (compareDecimal(value, maximum) > 0) maximum = value;
    }
    const spread = subtractDecimal(maximum, minimum);
    return points.map((point) => {
      if (point.valueDecimal === null) return point;
      const numeric = parseDecimalResult(point.valueDecimal);
      const ratio =
        compareDecimal(spread, parseDecimalResult("0")) === 0
          ? parseDecimalResult("0.5")
          : divideDecimal(subtractDecimal(numeric, minimum), spread);
      return {
        ...point,
        barHeight: `${formatDecimalFixed(
          addDecimal(
            parseDecimalResult("20"),
            multiplyDecimal(ratio, parseDecimalResult("80")),
          ),
          2,
        )}%`,
      };
    });
  } catch {
    return points;
  }
}

export function createOverviewData(
  model: PublishedOverviewReadModel | null,
): OwnedOverviewData {
  if (!model) {
    return {
      status: "empty",
      currencyCode: "AUD",
      current: null,
      history: [],
      coverage: {
        pricedHoldingCount: null,
        nonZeroHoldingCount: null,
        convertedCashAccountCount: null,
        nonZeroCashAccountCount: null,
        totalHoldingCount: null,
        excluded: [],
        issues: [],
        marketDataStates: [],
      },
      allocation: { status: "unavailable", rows: [] },
    };
  }
  if (
    !/^[A-Z]{3}$/.test(model.baseCurrencyCode) ||
    !Number.isSafeInteger(model.calculationVersion) ||
    model.calculationVersion < 1 ||
    !validSnapshot(model.current) ||
    model.history.some((point) => !validSnapshot(point))
  ) {
    return createUnavailableOverviewData(model.baseCurrencyCode);
  }
  const allocationIds = new Set<string>();
  if (
    model.allocation.some((row) => {
      if (
        typeof row.securityId !== "string" ||
        row.securityId.length === 0 ||
        allocationIds.has(row.securityId) ||
        typeof row.label !== "string" ||
        row.label.length === 0 ||
        (row.completeness !== "complete" &&
          row.completeness !== "partial" &&
          row.completeness !== "incomplete") ||
        !validResult(row.quantityDecimal, false) ||
        !validResult(row.valueDecimal, false)
      ) {
        return true;
      }
      allocationIds.add(row.securityId);
      return false;
    })
  ) {
    return createUnavailableOverviewData(model.baseCurrencyCode);
  }
  const current = overviewPoint(model.current, model.baseCurrencyCode);
  const gaps = model.current.coverage.gaps;
  const stale =
    Array.isArray(gaps) &&
    gaps.some(
      (gap) =>
        isRecord(gap) &&
        (gap.kind === "stale_price" || gap.kind === "stale_fx"),
    );
  const status =
    current.completeness === "complete"
      ? "complete"
      : stale && current.value !== null
        ? "stale"
        : current.completeness === "incomplete"
          ? "incomplete"
          : "partial";
  const numberCoverage = (key: string) => {
    const value = model.current.coverage[key];
    return typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : null;
  };
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const excludedIds = [
    ...stringArray(model.current.coverage.excludedHoldingIds),
    ...stringArray(model.current.coverage.excludedCashAccountIds),
  ];
  const gapReasons = new Map<string, string>();
  const issues = new Map<string, { id: string; reason: string }>();
  const addIssue = (id: string, reason: string) => {
    const key = `${id}\u0000${reason}`;
    if (!issues.has(key)) issues.set(key, { id, reason });
  };
  if (Array.isArray(model.current.coverage.gaps)) {
    for (const gap of model.current.coverage.gaps) {
      if (
        isRecord(gap) &&
        typeof gap.componentId === "string" &&
        typeof gap.kind === "string"
      ) {
        const reason = gap.kind.replaceAll("_", " ");
        gapReasons.set(gap.componentId, reason);
        addIssue(gap.componentId, reason);
      }
    }
  }
  if (model.current.coverage.historyComplete === false) {
    addIssue("history", "incomplete history");
  }
  for (const id of excludedIds) {
    addIssue(id, gapReasons.get(id) ?? "value unavailable");
  }
  const marketDataStates = Array.isArray(
    model.current.coverage.marketDataStates,
  )
    ? model.current.coverage.marketDataStates.flatMap((state) => {
        if (!isRecord(state) || typeof state.componentId !== "string") {
          return [];
        }
        const stateLabel = (value: unknown) =>
          typeof value === "string" ? value : "unavailable";
        if (
          state.priceState === "stale" ||
          state.priceState === "unavailable"
        ) {
          addIssue(state.componentId, `${state.priceState} price`);
        }
        if (state.fxState === "stale" || state.fxState === "unavailable") {
          addIssue(state.componentId, `${state.fxState} FX`);
        }
        if (
          state.calendarStatus === "missing_session" ||
          state.calendarStatus === "unknown"
        ) {
          addIssue(
            state.componentId,
            `${state.calendarStatus.replaceAll("_", " ")} calendar`,
          );
        }
        return [
          {
            id: state.componentId,
            price: stateLabel(state.priceState),
            fx: stateLabel(state.fxState),
            calendar: stateLabel(state.calendarStatus),
          },
        ];
      })
    : [];
  const history = model.history.map((point) =>
    overviewPoint(point, model.baseCurrencyCode),
  );
  const knownAllocation = model.allocation.filter((row) => {
    try {
      return (
        compareDecimal(
          parseDecimalResult(row.quantityDecimal),
          parseDecimalResult("0"),
        ) > 0 && row.valueDecimal !== null
      );
    } catch {
      return false;
    }
  });
  const materialAllocation = model.allocation.filter((row) => {
    try {
      return (
        compareDecimal(
          parseDecimalResult(row.quantityDecimal),
          parseDecimalResult("0"),
        ) > 0
      );
    } catch {
      return false;
    }
  });
  const totalHoldingCount = model.current.coverage.totalHoldingCount;
  const nonZeroHoldingCount = model.current.coverage.nonZeroHoldingCount;
  const zeroHoldingCount = model.current.coverage.zeroHoldingCount;
  const convertedHoldingCount = model.current.coverage.convertedHoldingCount;
  const allocationCounts = model.allocation.reduce(
    (counts, row) => {
      try {
        if (
          compareDecimal(
            parseDecimalResult(row.quantityDecimal),
            parseDecimalResult("0"),
          ) > 0
        ) {
          counts.nonZero += 1;
          if (row.valueDecimal !== null) counts.converted += 1;
        } else {
          counts.zero += 1;
        }
      } catch {
        counts.invalid = true;
      }
      return counts;
    },
    { nonZero: 0, zero: 0, converted: 0, invalid: false },
  );
  if (
    typeof totalHoldingCount !== "number" ||
    typeof nonZeroHoldingCount !== "number" ||
    typeof zeroHoldingCount !== "number" ||
    typeof convertedHoldingCount !== "number" ||
    allocationCounts.invalid ||
    model.allocation.length !== totalHoldingCount ||
    allocationCounts.nonZero !== nonZeroHoldingCount ||
    allocationCounts.zero !== zeroHoldingCount ||
    allocationCounts.converted !== convertedHoldingCount
  ) {
    return createUnavailableOverviewData(model.baseCurrencyCode);
  }
  const excludedHoldingIdsValue = model.current.coverage.excludedHoldingIds;
  if (
    !Array.isArray(excludedHoldingIdsValue) ||
    excludedHoldingIdsValue.some((id) => typeof id !== "string")
  ) {
    return createUnavailableOverviewData(model.baseCurrencyCode);
  }
  const excludedHoldingIds = new Set(
    excludedHoldingIdsValue.filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const allocationById = new Map(
    model.allocation.map((row) => [row.securityId, row]),
  );
  if (
    [...excludedHoldingIds].some((id) => !allocationById.has(id)) ||
    model.allocation.some((row) => {
      let nonZero = false;
      try {
        nonZero =
          compareDecimal(
            parseDecimalResult(row.quantityDecimal),
            parseDecimalResult("0"),
          ) > 0;
      } catch {
        return true;
      }
      return (
        nonZero &&
        ((row.valueDecimal === null &&
          !excludedHoldingIds.has(row.securityId)) ||
          (row.valueDecimal !== null && excludedHoldingIds.has(row.securityId)))
      );
    })
  ) {
    return createUnavailableOverviewData(model.baseCurrencyCode);
  }
  let allocationRows: OwnedOverviewData["allocation"]["rows"] = [];
  let allocationStatus: OwnedOverviewData["allocation"]["status"] =
    "unavailable";
  try {
    const total = knownAllocation.reduce(
      (sum, row) => addDecimal(sum, parseDecimalResult(row.valueDecimal!)),
      parseDecimalResult("0"),
    );
    if (compareDecimal(total, parseDecimalResult("0")) > 0) {
      allocationRows = materialAllocation.map((row) => {
        if (row.valueDecimal === null) {
          return {
            id: row.securityId,
            label: row.label,
            value: null,
            percent: null,
          };
        }
        const percent = multiplyDecimal(
          divideDecimal(parseDecimalResult(row.valueDecimal), total),
          parseDecimalResult("100"),
        );
        return {
          id: row.securityId,
          label: row.label,
          value: formatMoney(row.valueDecimal, model.baseCurrencyCode),
          percent: `${formatDecimalFixed(percent, 2)}%`,
        };
      });
      allocationStatus =
        knownAllocation.length === materialAllocation.length
          ? "complete"
          : "partial";
    }
  } catch {
    allocationStatus = "unavailable";
  }
  return {
    status,
    currencyCode: model.baseCurrencyCode,
    current,
    history: addChartHeights(history),
    coverage: {
      pricedHoldingCount: numberCoverage("pricedHoldingCount"),
      nonZeroHoldingCount: numberCoverage("nonZeroHoldingCount"),
      convertedCashAccountCount: numberCoverage("convertedCashAccountCount"),
      nonZeroCashAccountCount: numberCoverage("nonZeroCashAccountCount"),
      totalHoldingCount: numberCoverage("totalHoldingCount"),
      excluded: excludedIds.map((id) => ({
        id,
        reason: gapReasons.get(id) ?? "value unavailable",
      })),
      issues: [...issues.values()],
      marketDataStates,
    },
    allocation: { status: allocationStatus, rows: allocationRows },
  };
}

export function createUnavailableOverviewData(
  currencyCode: string,
): OwnedOverviewData {
  return {
    status: "unavailable",
    currencyCode,
    current: null,
    history: [],
    coverage: {
      pricedHoldingCount: null,
      nonZeroHoldingCount: null,
      convertedCashAccountCount: null,
      nonZeroCashAccountCount: null,
      totalHoldingCount: null,
      excluded: [],
      issues: [],
      marketDataStates: [],
    },
    allocation: { status: "unavailable", rows: [] },
  };
}
