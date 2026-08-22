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
  /** The portfolio-local date cutoff used to prevent look-ahead history. */
  portfolioTimezone?: string;
  targetKey: string;
  userId?: string;
  scope?: ObservationScope;
  currencyCode?: string;
  observations: readonly PriceObservation[];
  overrides?: readonly ManualOverride[];
  now?: string;
  /**
   * MKT-009B: an ordered owner preference over `providerId` (e.g.
   * `["sharesight"]` or `["yahoo-compatible"]`). `undefined`/empty is
   * today's exact freshest-wins behaviour -- unchanged. When present, this
   * is a PREFERENCE, not a hard filter: candidates are first narrowed to
   * this list (still ranked freshest-first among themselves); only when
   * NONE of the preferred providers has a single usable candidate does
   * selection fall back, honestly, to the best candidate from ANY provider
   * -- see `docs/CALCULATIONS.md` §2's "MKT-009B: price-source preference
   * deliberately outranks freshness within the existing fallback window"
   * note for the Orchestrator's binding ruling (review round-1 F1) that a
   * configured preference wins OUTRIGHT over a fresher non-preferred
   * observation, not merely on a tie, and for why "preferred has nothing"
   * must never become `Price unavailable` while another source has a
   * valid observation.
   */
  preferredProviderIds?: readonly string[] | null;
};

export type FxSelectionInput = SelectionOptions & {
  asOf: string;
  /** The portfolio-local date cutoff used to prevent look-ahead history. */
  portfolioTimezone?: string;
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

function localDateAt(
  timestamp: string,
  timezone: string | undefined,
): string | null {
  if (!timezone) return null;
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

function availableByPortfolioCutoff(
  observedAt: string,
  asOf: string,
  portfolioTimezone: string | undefined,
): boolean {
  if (!portfolioTimezone) return true;
  const localDate = localDateAt(observedAt, portfolioTimezone);
  return localDate !== null && localDate <= asOf;
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
          userId !== undefined &&
          override.userId === userId &&
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
  // MKT-012 round 2 (Orchestrator ruling, 2026-08-22): a ROUND-1 attempt at
  // this task flipped this generic interval tie-break so `eod` always beat
  // `delayed`. Review found that was the wrong fix: the owner's actual
  // ruling was "CSV uploads should outrank", not "all eod beats all
  // delayed" -- the generic flip (a) never reached the owner's own default
  // configuration, because `preferredProviderIds` narrowing (below) already
  // ran BEFORE this tie-break and excluded the owner-import row whenever a
  // preference was configured, and (b) silently regressed MKT-011A: Yahoo's
  // own same-day PROVISIONAL `eod` bar started beating MKT-011A's honest
  // 16:25 `delayed` rollup capture on the deployment scope (owned-quotes,
  // snapshots), which nobody asked for. This function is REVERTED to its
  // pre-MKT-012 order: `delayed` (rank 0) still outranks `eod` (rank 2) at
  // equal date age for ordinary provider rows. The owner's real "CSV
  // uploads should outrank" intent is instead implemented as the NARROWER
  // `ownerImportRank` precedence below, applied only to
  // `selectPriceObservation`'s price tie-break (never here, and never for
  // FX -- no owner-uploaded FX rows exist).
  const intervalRank = interval === "eod" ? 2 : interval === "delayed" ? 0 : 1;
  const qualityRank =
    quality === "stale_candidate" ? 4 : quality === "indicative" ? 2 : 0;
  return intervalRank + qualityRank;
}

// MKT-012 round 2 (Orchestrator ruling, 2026-08-22): the provider id CSV
// upload/backup-restore write to `price_observations` (`app/price-upload-service.ts`,
// `OWNER_IMPORT_PROVIDER_ID` in `db/repositories/price-uploads.ts`). Exported
// so `app/owned-holdings.ts`'s cross-scope combiner (rule 4 of the ruling)
// can apply the IDENTICAL precedence check rather than drifting from this
// module's own definition. Domain code does not import from `db/repositories`
// (see `price-backup-csv.ts`'s own independent `"owner-import"` literal for
// the established convention this repeats), so this is redeclared here, not
// imported, and MUST be kept byte-identical to that constant.
export const OWNER_IMPORT_PROVIDER_ID = "owner-import";

function ownerImportRank(providerId: string): number {
  return providerId === OWNER_IMPORT_PROVIDER_ID ? 0 : 1;
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

  // MKT-012 round 2: an owner-import row (the owner's own uploaded/backup-
  // restored CSV price history, `providerId === OWNER_IMPORT_PROVIDER_ID`)
  // gets authoritative precedence at the SAME market-date age, ahead of
  // `providerRank`'s ordinary interval/quality tie-break -- this is the
  // narrow, targeted implementation of "CSV uploads should outrank", scoped
  // to PRICE selection only (never FX -- no owner-uploaded FX rows exist).
  // `ageDifference` still runs first, so a genuinely fresher non-owner-import
  // date still wins by age; an owner-import row never beats a strictly newer
  // market date from another source.
  const sortByFreshness = (left: PriceObservation, right: PriceObservation) => {
    const ageDifference =
      (dayAge(input.asOf, left.marketDate) ?? Infinity) -
      (dayAge(input.asOf, right.marketDate) ?? Infinity);
    return (
      ageDifference ||
      ownerImportRank(left.providerId) - ownerImportRank(right.providerId) ||
      providerRank(left.interval, left.quality) -
        providerRank(right.interval, right.quality) ||
      right.observationAt.localeCompare(left.observationAt)
    );
  };
  const validCandidates = input.observations.filter((observation) => {
    const age = dayAge(input.asOf, observation.marketDate);
    return (
      age !== null &&
      age >= 0 &&
      age <= (input.maxPriorCalendarDays ?? DEFAULT_MAX_PRIOR_DAYS) &&
      scopeMatches(observation, input.scope) &&
      isPositive(observation.closeDecimal) &&
      availableByPortfolioCutoff(
        observation.observationAt,
        input.asOf,
        input.portfolioTimezone,
      ) &&
      (!input.currencyCode || observation.currencyCode === input.currencyCode)
    );
  });
  // MKT-009B: narrow to the preferred provider(s) first, but only when that
  // narrowing leaves at least one candidate -- an empty preferred subset
  // falls back, honestly, to the full candidate set below rather than ever
  // reporting `unavailable` merely because the PREFERRED source is silent.
  // MKT-012 round 2 (ruling 3, AMENDED after review F6, 2026-08-22): the
  // owner-import row must be UNIONED into the narrowed set whenever the
  // preferred provider actually has something -- but NEVER unconditionally.
  // An earlier version of this union added owner-import regardless of
  // whether `preferredProviderIds` matched anything, which broke the
  // honest-fallback path above: with a yahoo preference and neither a
  // yahoo row nor a preference match, the narrowed set collapsed to
  // {owner-import} ALONE, permanently excluding a fresher non-preferred
  // (e.g. Sharesight) row from ever competing on `dayAge` at all -- an
  // OLDER owner-import close then beat a FRESHER same-scope quote, a
  // regression from pre-task behaviour. Gating the union on
  // `preferredMatches.length > 0` restores the honest fallback: when the
  // preferred provider is silent, narrowing is skipped entirely and
  // `validCandidates` (owner-import included) competes on `dayAge` first,
  // exactly as before this task -- `ownerImportRank` below still decides a
  // genuine same-date tie within that full fallback set. A yahoo
  // preference must never let an older owner-import row beat a fresher
  // Sharesight quote merely because a preference happens to be configured.
  const preferredMatches =
    input.preferredProviderIds && input.preferredProviderIds.length > 0
      ? validCandidates.filter((observation) =>
          input.preferredProviderIds!.includes(observation.providerId),
        )
      : [];
  const preferredCandidates =
    preferredMatches.length > 0
      ? validCandidates.filter(
          (observation) =>
            input.preferredProviderIds!.includes(observation.providerId) ||
            observation.providerId === OWNER_IMPORT_PROVIDER_ID,
        )
      : [];
  const candidates = (
    preferredCandidates.length > 0 ? preferredCandidates : validCandidates
  ).sort(sortByFreshness);
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
      const direct =
        observation.baseCurrencyCode === input.baseCurrencyCode &&
        observation.quoteCurrencyCode === input.quoteCurrencyCode;
      const inverse =
        observation.baseCurrencyCode === input.quoteCurrencyCode &&
        observation.quoteCurrencyCode === input.baseCurrencyCode;
      return (
        (direct || inverse) &&
        age !== null &&
        age >= 0 &&
        age <= (input.maxPriorCalendarDays ?? DEFAULT_MAX_PRIOR_DAYS) &&
        scopeMatches(observation, input.scope) &&
        isPositive(observation.rateDecimal) &&
        availableByPortfolioCutoff(
          observation.observedAt,
          input.asOf,
          input.portfolioTimezone,
        )
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
