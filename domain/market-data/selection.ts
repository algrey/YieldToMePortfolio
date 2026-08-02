import type {
  FxObservation,
  ManualOverride,
  ObservationInterval,
  ObservationScope,
  PriceObservation,
  ProviderDataQuality,
} from "./contracts.ts";

type Decimal = { coefficient: bigint; scale: number };

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const DEFAULT_MAX_PRIOR_DAYS = 5;
const DEFAULT_MAX_EOD_AGE_DAYS = 2;
const DEFAULT_MAX_DELAYED_AGE_MINUTES = 180;

export type SelectionState = "current" | "fallback" | "stale" | "unavailable";

export type SelectionExplanation = {
  reason: string;
  source: "manual" | "provider" | "identity" | "none";
  providerId: string | null;
  observationAt: string | null;
  marketDate: string | null;
  quality: ProviderDataQuality | "manual" | "identity" | null;
  fallback: boolean;
  overrideId: string | null;
};

export type SelectedPrice = {
  kind: "price";
  source: "manual" | "provider";
  closeDecimal: string;
  currencyCode: string;
  marketDate: string;
  observationAt: string | null;
  interval: ObservationInterval | "manual";
  quality: ProviderDataQuality | "manual";
  providerId: string | null;
  observation: PriceObservation | null;
};

export type PriceSelection = {
  status: SelectionState;
  selected: SelectedPrice | null;
  display: { closeDecimal: string; currencyCode: string } | null;
  explanation: SelectionExplanation;
};

export type SelectedFx = {
  kind: "fx";
  source: "manual" | "provider" | "identity";
  rateDecimal: string;
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  marketDate: string;
  observedAt: string | null;
  interval: ObservationInterval | "manual" | "identity";
  quality: ProviderDataQuality | "manual" | "identity";
  providerId: string | null;
  observation: FxObservation | null;
};

export type FxSelection = {
  status: SelectionState;
  selected: SelectedFx | null;
  display: {
    rateDecimal: string;
    baseCurrencyCode: string;
    quoteCurrencyCode: string;
  } | null;
  explanation: SelectionExplanation;
};

export type SelectionOptions = {
  maxPriorCalendarDays?: number;
  maxEodAgeDays?: number;
  maxDelayedAgeMinutes?: number;
};

export type PriceSelectionInput = SelectionOptions & {
  asOf: string;
  targetKey: string;
  userId?: string;
  scope?: ObservationScope;
  currencyCode?: string;
  observations: readonly PriceObservation[];
  overrides?: readonly ManualOverride[];
  now?: string;
};

export type FxSelectionInput = SelectionOptions & {
  asOf: string;
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  targetKey: string;
  userId?: string;
  scope?: ObservationScope;
  observations: readonly FxObservation[];
  overrides?: readonly ManualOverride[];
};

function parseDecimal(value: string): Decimal | null {
  if (!DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function power(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function normalize(value: Decimal): string {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * power(scale - left.scale) +
      right.coefficient * power(scale - right.scale),
    scale,
  };
}

function isPositive(value: string): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed.coefficient > 0n;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().startsWith(value)
  );
}

function dayAge(asOf: string, marketDate: string): number | null {
  if (!validDate(asOf) || !validDate(marketDate)) return null;
  return Math.floor(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${marketDate}T00:00:00Z`)) /
      86_400_000,
  );
}

function activeOverride(
  overrides: readonly ManualOverride[],
  type: ManualOverride["type"],
  targetKey: string,
  asOf: string,
  userId?: string,
): ManualOverride | null {
  return (
    overrides
      .filter(
        (override) =>
          override.type === type &&
          override.targetKey === targetKey &&
          (!userId || override.userId === userId) &&
          override.status === "active" &&
          override.effectiveFrom <= asOf &&
          (override.effectiveTo === null || override.effectiveTo >= asOf),
      )
      .sort(
        (left, right) =>
          right.effectiveFrom.localeCompare(left.effectiveFrom) ||
          right.createdAt.localeCompare(left.createdAt),
      )[0] ?? null
  );
}

function scopeMatches(
  observation: PriceObservation | FxObservation,
  scope: ObservationScope | undefined,
): boolean {
  if (!scope) return true;
  if (observation.scope.kind !== scope.kind) return false;
  return (
    scope.kind === "deployment" || observation.scope.userId === scope.userId
  );
}

function valueObject(override: ManualOverride): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(override.valueJson);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function providerRank(
  interval: ObservationInterval,
  quality: ProviderDataQuality,
): number {
  const intervalRank = interval === "eod" ? 2 : interval === "delayed" ? 0 : 1;
  const qualityRank =
    quality === "stale_candidate" ? 4 : quality === "indicative" ? 2 : 0;
  return intervalRank + qualityRank;
}

function selectionState(
  observation: PriceObservation | FxObservation,
  age: number,
  options: SelectionOptions,
): SelectionState {
  if (observation.quality === "stale_candidate") return "stale";
  if (
    observation.interval === "eod" &&
    age > (options.maxEodAgeDays ?? DEFAULT_MAX_EOD_AGE_DAYS)
  ) {
    return "stale";
  }
  if (
    observation.interval === "delayed" &&
    observation.delayedMinutes !== null &&
    observation.delayedMinutes >
      (options.maxDelayedAgeMinutes ?? DEFAULT_MAX_DELAYED_AGE_MINUTES)
  ) {
    return "stale";
  }
  if (age > 0) return "fallback";
  return "current";
}

function unavailable(reason: string): SelectionExplanation {
  return {
    reason,
    source: "none",
    providerId: null,
    observationAt: null,
    marketDate: null,
    quality: null,
    fallback: false,
    overrideId: null,
  };
}

export function selectPriceObservation(
  input: PriceSelectionInput,
): PriceSelection {
  const overrides = input.overrides ?? [];
  const override = activeOverride(
    overrides,
    "price",
    input.targetKey,
    input.asOf,
    input.userId,
  );
  if (override) {
    const value = valueObject(override);
    const closeDecimal =
      typeof value?.closeDecimal === "string"
        ? value.closeDecimal
        : typeof value?.close === "string"
          ? value.close
          : null;
    const currencyCode =
      typeof value?.currencyCode === "string"
        ? value.currencyCode
        : (input.currencyCode ?? null);
    if (closeDecimal && isPositive(closeDecimal) && currencyCode) {
      const selected: SelectedPrice = {
        kind: "price",
        source: "manual",
        closeDecimal,
        currencyCode,
        marketDate: input.asOf,
        observationAt: null,
        interval: "manual",
        quality: "manual",
        providerId: null,
        observation: null,
      };
      return {
        status: "current",
        selected,
        display: { closeDecimal, currencyCode },
        explanation: {
          reason: "A user-entered override is effective for this date.",
          source: "manual",
          providerId: null,
          observationAt: null,
          marketDate: input.asOf,
          quality: "manual",
          fallback: false,
          overrideId: override.id ?? null,
        },
      };
    }
  }

  const candidates = input.observations
    .filter((observation) => {
      const age = dayAge(input.asOf, observation.marketDate);
      return (
        age !== null &&
        age >= 0 &&
        age <= (input.maxPriorCalendarDays ?? DEFAULT_MAX_PRIOR_DAYS) &&
        scopeMatches(observation, input.scope) &&
        isPositive(observation.closeDecimal) &&
        (!input.currencyCode || observation.currencyCode === input.currencyCode)
      );
    })
    .sort((left, right) => {
      const ageDifference =
        (dayAge(input.asOf, left.marketDate) ?? Infinity) -
        (dayAge(input.asOf, right.marketDate) ?? Infinity);
      return (
        ageDifference ||
        providerRank(left.interval, left.quality) -
          providerRank(right.interval, right.quality) ||
        right.observationAt.localeCompare(left.observationAt)
      );
    });
  const observation = candidates[0];
  if (!observation) {
    return {
      status: "unavailable",
      selected: null,
      display: null,
      explanation: unavailable(
        "No validated observation exists within the fallback window.",
      ),
    };
  }
  const age = dayAge(input.asOf, observation.marketDate) ?? 0;
  const selected: SelectedPrice = {
    kind: "price",
    source: "provider",
    closeDecimal: observation.closeDecimal,
    currencyCode: observation.currencyCode,
    marketDate: observation.marketDate,
    observationAt: observation.observationAt,
    interval: observation.interval,
    quality: observation.quality,
    providerId: observation.providerId,
    observation,
  };
  return {
    status: selectionState(observation, age, input),
    selected,
    display: {
      closeDecimal: observation.closeDecimal,
      currencyCode: observation.currencyCode,
    },
    explanation: {
      reason:
        age === 0
          ? "The best validated observation for the requested market date was selected."
          : "The latest validated prior-session observation was selected within the fallback window.",
      source: "provider",
      providerId: observation.providerId,
      observationAt: observation.observationAt,
      marketDate: observation.marketDate,
      quality: observation.quality,
      fallback: age > 0,
      overrideId: null,
    },
  };
}

export function selectFxObservation(input: FxSelectionInput): FxSelection {
  if (input.baseCurrencyCode === input.quoteCurrencyCode) {
    const selected: SelectedFx = {
      kind: "fx",
      source: "identity",
      rateDecimal: "1",
      baseCurrencyCode: input.baseCurrencyCode,
      quoteCurrencyCode: input.quoteCurrencyCode,
      marketDate: input.asOf,
      observedAt: null,
      interval: "identity",
      quality: "identity",
      providerId: null,
      observation: null,
    };
    return {
      status: "current",
      selected,
      display: {
        rateDecimal: "1",
        baseCurrencyCode: input.baseCurrencyCode,
        quoteCurrencyCode: input.quoteCurrencyCode,
      },
      explanation: {
        reason: "The currencies match, so exact identity conversion applies.",
        source: "identity",
        providerId: null,
        observationAt: null,
        marketDate: input.asOf,
        quality: "identity",
        fallback: false,
        overrideId: null,
      },
    };
  }
  const override = activeOverride(
    input.overrides ?? [],
    "fx_rate",
    input.targetKey,
    input.asOf,
    input.userId,
  );
  if (override) {
    const value = valueObject(override);
    const rateDecimal =
      typeof value?.rateDecimal === "string" ? value.rateDecimal : null;
    if (
      rateDecimal &&
      isPositive(rateDecimal) &&
      value?.baseCurrencyCode === input.baseCurrencyCode &&
      value?.quoteCurrencyCode === input.quoteCurrencyCode
    ) {
      const selected: SelectedFx = {
        kind: "fx",
        source: "manual",
        rateDecimal,
        baseCurrencyCode: input.baseCurrencyCode,
        quoteCurrencyCode: input.quoteCurrencyCode,
        marketDate: input.asOf,
        observedAt: null,
        interval: "manual",
        quality: "manual",
        providerId: null,
        observation: null,
      };
      return {
        status: "current",
        selected,
        display: {
          rateDecimal,
          baseCurrencyCode: input.baseCurrencyCode,
          quoteCurrencyCode: input.quoteCurrencyCode,
        },
        explanation: {
          reason: "A user-entered FX override is effective for this date.",
          source: "manual",
          providerId: null,
          observationAt: null,
          marketDate: input.asOf,
          quality: "manual",
          fallback: false,
          overrideId: override.id ?? null,
        },
      };
    }
  }
  const candidates = input.observations
    .filter((observation) => {
      const age = dayAge(input.asOf, observation.marketDate);
      return (
        observation.baseCurrencyCode === input.baseCurrencyCode &&
        observation.quoteCurrencyCode === input.quoteCurrencyCode &&
        age !== null &&
        age >= 0 &&
        age <= (input.maxPriorCalendarDays ?? DEFAULT_MAX_PRIOR_DAYS) &&
        scopeMatches(observation, input.scope) &&
        isPositive(observation.rateDecimal)
      );
    })
    .sort((left, right) => {
      const ageDifference =
        (dayAge(input.asOf, left.marketDate) ?? Infinity) -
        (dayAge(input.asOf, right.marketDate) ?? Infinity);
      return (
        ageDifference ||
        providerRank(left.interval, left.quality) -
          providerRank(right.interval, right.quality) ||
        right.observedAt.localeCompare(left.observedAt)
      );
    });
  const observation = candidates[0];
  if (!observation) {
    return {
      status: "unavailable",
      selected: null,
      display: null,
      explanation: unavailable(
        "No validated FX observation exists within the fallback window.",
      ),
    };
  }
  const age = dayAge(input.asOf, observation.marketDate) ?? 0;
  const selected: SelectedFx = {
    kind: "fx",
    source: "provider",
    rateDecimal: observation.rateDecimal,
    baseCurrencyCode: observation.baseCurrencyCode,
    quoteCurrencyCode: observation.quoteCurrencyCode,
    marketDate: observation.marketDate,
    observedAt: observation.observedAt,
    interval: observation.interval,
    quality: observation.quality,
    providerId: observation.providerId,
    observation,
  };
  return {
    status: selectionState(observation, age, input),
    selected,
    display: {
      rateDecimal: observation.rateDecimal,
      baseCurrencyCode: observation.baseCurrencyCode,
      quoteCurrencyCode: observation.quoteCurrencyCode,
    },
    explanation: {
      reason:
        age === 0
          ? "The best validated FX observation for the requested date was selected."
          : "The latest validated prior-session FX observation was selected within the fallback window.",
      source: "provider",
      providerId: observation.providerId,
      observationAt: observation.observedAt,
      marketDate: observation.marketDate,
      quality: observation.quality,
      fallback: age > 0,
      overrideId: null,
    },
  };
}

export type CoverageItem = {
  id: string;
  valueDecimal: string | null;
  basisDecimal?: string | null;
};

export type CoverageResult = {
  status: "complete" | "partial" | "unavailable";
  totalCount: number;
  pricedCount: number;
  basisCoveredCount: number;
  alignedCount: number;
  valueTotalDecimal: string | null;
  basisTotalDecimal: string | null;
  alignedValueTotalDecimal: string | null;
  excludedIds: string[];
  explanation: string;
};

export function composeCoveredTotals(
  items: readonly CoverageItem[],
): CoverageResult {
  let valueTotal: Decimal | null = null;
  let basisTotal: Decimal | null = null;
  let alignedValueTotal: Decimal | null = null;
  let pricedCount = 0;
  let basisCoveredCount = 0;
  let alignedCount = 0;
  const excludedIds: string[] = [];
  for (const item of items) {
    const value = item.valueDecimal && parseDecimal(item.valueDecimal);
    const basis = item.basisDecimal && parseDecimal(item.basisDecimal);
    if (value) {
      pricedCount += 1;
      valueTotal = valueTotal ? add(valueTotal, value) : value;
    }
    if (basis) {
      basisCoveredCount += 1;
      basisTotal = basisTotal ? add(basisTotal, basis) : basis;
    }
    if (value && basis) {
      alignedCount += 1;
      alignedValueTotal = alignedValueTotal
        ? add(alignedValueTotal, value)
        : value;
    } else {
      excludedIds.push(item.id);
    }
  }
  const complete = items.length > 0 && alignedCount === items.length;
  const status = complete
    ? "complete"
    : alignedCount > 0 || pricedCount > 0 || basisCoveredCount > 0
      ? "partial"
      : "unavailable";
  return {
    status,
    totalCount: items.length,
    pricedCount,
    basisCoveredCount,
    alignedCount,
    valueTotalDecimal: valueTotal ? normalize(valueTotal) : null,
    basisTotalDecimal: basisTotal ? normalize(basisTotal) : null,
    alignedValueTotalDecimal: alignedValueTotal
      ? normalize(alignedValueTotal)
      : null,
    excludedIds,
    explanation: complete
      ? "All holdings have aligned price and basis coverage."
      : "The total is partial because at least one holding lacks a validated price or basis; unavailable values were not treated as zero.",
  };
}

export const selectPrice = selectPriceObservation;
export const selectFx = selectFxObservation;
