/**
 * HIST-001: READ-TIME derivation of portfolio value at past dates, from the
 * now-present price history (MKT-008's owner-import CSVs) -- deliberately a
 * DIFFERENT strategy from this sibling module's `buildHistoricalSnapshots`
 * (the CALC-003/CALC-004 persisted `portfolio_daily_snapshots` pipeline).
 *
 * Architecture decision (see `docs/ARCHITECTURE.md`'s HIST-001 entry for the
 * full record): the persisted pipeline requires a `calculation_runs` row to
 * advance through a resumable, budgeted, multi-invocation rebuild before
 * `snapshot_publications` ever gets a row a reader can consume -- correct
 * for its own purpose (a durable, gap-audited, coverage-typed daily series)
 * but NOT a fit for "show a chart" or "populate ten Multi-Year cells", which
 * need an answer within ONE request. This module instead derives a value
 * straight from `price_observations`/ledger facts on every read, for a
 * CALLER-BOUNDED set of dates, and writes nothing at all -- no
 * `calculation_runs` row, no snapshot table row, so the D1 free-plan
 * 100k-rows/day WRITE budget is never touched by a view. Reads are bounded
 * by the caller's SQL (`app/historical-portfolio-value.ts`), not by this
 * module (pure, DB-free).
 *
 * Provider scope (review B2a, BLOCKING correction): valuation uses the SAME
 * observation classes `app/owned-holdings.ts`'s CURRENT-value read uses --
 * every owner-visible provider via `selectPriceObservation`'s established
 * selection semantics (freshest-wins tie-break, owner-import precedence at
 * equal age), NOT an owner-import-only/`provider_id <> 'sharesight'`
 * restriction. An earlier version of this module borrowed the sibling
 * persisted-pipeline's BRK-012C EOD-only exclusion, which produced up-to-
 * $48k phantom step-downs on dates a Sharesight-only quote existed and a
 * ~$47k disagreement against the CURRENT-value figure on the same screen --
 * exactly the kind of two-conventions-disagree bug this module exists to
 * avoid. One scope, no parallel scope; the caller's SQL predicate
 * (`app/historical-portfolio-value.ts`) matches `owned-holdings.ts`'s own.
 *
 * Valuation rule (documented -- see `docs/CALCULATIONS.md` for the
 * normative statement): for each requested date, a security contributes to
 * that date's total ONLY when (a) `deriveSharesHeldAtDate` returns a
 * non-zero quantity as of that date, AND (b) a price observation exists for
 * it on that date OR within `priceToleranceDays` calendar days BEFORE it
 * (`selectPriceObservation`'s own age-ranked selection over a candidate set
 * narrowed to that window -- never a value from AFTER the target date).
 * `priceToleranceDays` is a CALLER choice, not a fixed constant: the
 * Overview graph passes `0` (exact-date only -- owner directive: sparse
 * monthly pre-2018 history must show honestly as sparse, never smoothed);
 * Multi-Year's FY-end lookups pass `7` (review B3 ruling -- covers a
 * weekend/holiday landing exactly on an FY-end date; beyond that window the
 * date stays an honest gap, never a stale carried-forward figure). A
 * held-but-unpriced-within-tolerance security is EXCLUDED from that date's
 * total, never interpolated and never silently treated as zero -- the
 * point's `completeness` flips to `"partial"` and the exclusion is counted
 * (`heldSecurityCount` vs `pricedSecurityCount`), mirroring
 * `app/owned-holdings.ts`'s own known-total-is-never-null-just-because-
 * something's-missing convention.
 *
 * BUG-002 owner ruling (2026-08-25, verbatim: "How is cash handled. First
 * step is to make it work for the stocks, give the value of the stock
 * portfolio. No magic negative cash or anything."): this derivation is
 * SECURITIES-ONLY -- cash is deliberately NOT reconstructed or summed here,
 * for either the Overview graph or Multi-Year's FY-end lookups. An earlier
 * version of this module replayed `cash_ledger_entries` the same way it
 * replays share transactions, which surfaced a real data-quality problem on
 * investigation: the owner's actual cash ledger has no reliable opening
 * balance (every account observed is flagged `cash_accounts.completeness =
 * 'incomplete'`), so the replayed "balance" was really a since-import-start
 * NET FLOW -- a large, growing, and fundamentally not-a-balance negative
 * number (over $800k negative on the real account) that dragged every
 * historical total down to a misleadingly small, or even negative, figure
 * with no honest way to label it as anything other than wrong. Cash
 * valuation returns to this derivation later, once real deposit/opening-
 * balance data exists to reconstruct a trustworthy balance from -- see
 * `docs/CALCULATIONS.md`'s HIST-001 subsection and `docs/ARCHITECTURE.md`
 * §9.1 for the full record. `completeness`/point availability here is
 * therefore driven ONLY by price/FX coverage on the held securities -- see
 * the field's own doc comment below. This is independent of the CURRENT-
 * value read (`app/owned-holdings.ts`'s `loadCash`), which still sums cash
 * for TODAY's headline figure and is unaffected by this decision; the two
 * screens can disagree on scope (securities-only history vs
 * securities-plus-cash today) until cash history returns here.
 *
 * Performance (review B1, BLOCKING): observations are indexed by exact
 * `marketDate` ONCE per security/FX-pair (`indexByMarketDate`, O(rows)),
 * not re-scanned per requested date. Each date's lookup then costs
 * O(priceToleranceDays) bucket lookups (1 for the graph's exact-date rule,
 * up to 8 for Multi-Year's 7-day tolerance) instead of a linear scan of
 * that security's ENTIRE observation history -- the fix for a measured
 * ~35s-CPU-class cost at realistic scale (1,500 dates x 18 securities x a
 * multi-thousand-row-per-security history) that would never complete
 * within a Worker's CPU budget. `computeHistoricalPortfolioValueSeries`
 * builds the indices once and reuses them across every date;
 * `computeHistoricalPortfolioValueAtDate` (the single-date entry point
 * Multi-Year's ~10 FY-end lookups use) builds them fresh per call, which is
 * fine at that call count. tests/hist-001.test.ts pins a realistic-scale
 * compute-bound fixture.
 *
 * Deliberately OUT of scope (documented, not a hidden gap): manual price/FX
 * overrides are not consulted here (`overrides: []` throughout) -- overrides
 * exist to correct a CURRENT quote the owner is looking at today, and a
 * point-in-time override effective years in the past is not a case this
 * feature has evidence for; if that need arises, thread `overrides` through
 * the same call sites `selectPriceObservation`/`selectFxObservation` already
 * accept it on.
 */
import {
  addDecimal,
  formatDecimalExact,
  fromInteger,
  isZero,
  parseDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";
import {
  calculateNativeHomeHolding,
  type FxEvidence,
} from "../calculations/multi-currency.ts";
import {
  deriveSharesHeldAtDate,
  type LedgerQuantityFact,
} from "../dividends/shares-held.ts";
import {
  selectFxObservation,
  selectPriceObservation,
  type FxSelection,
} from "../market-data/selection.ts";
import type {
  FxObservation,
  PriceObservation,
} from "../market-data/contracts.ts";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** One held (or once-held) security's ledger + price facts, already bounded
 * and owner-visible-scoped by the caller (`app/historical-portfolio-value.ts`). */
export type HistoricalValueSecurityFact = {
  portfolioSecurityId: string;
  currencyCode: string;
  transactions: readonly LedgerQuantityFact[];
  priceObservations: readonly PriceObservation[];
};

export type HistoricalPortfolioValuePoint = {
  date: string;
  /** The portfolio's SECURITIES-ONLY total value on this date in the base
   * currency (BUG-002 owner ruling: cash is deliberately excluded -- see
   * this module's header), or `null` when NOTHING priceable existed within
   * tolerance of this date (a genuine gap -- never a fabricated zero). */
  valueDecimal: string | null;
  /** `"complete"` only when every currently-nonzero-held security resolved
   * a price/FX within tolerance of this date; `"partial"` whenever
   * `valueDecimal` is a real but understated sum (some held security
   * excluded). Mirrors `portfolio_daily_snapshots.completeness`'s
   * two-value shape, minus `"incomplete"` -- this derivation never persists
   * a placeholder row, so there is no third "queued but not yet computed"
   * state to represent. */
  completeness: "complete" | "partial";
  heldSecurityCount: number;
  pricedSecurityCount: number;
};

function toFxEvidence(selection: FxSelection): FxEvidence | null {
  const selected = selection.selected;
  if (!selected) return null;
  return {
    rateDecimal: selected.rateDecimal,
    baseCurrencyCode: selected.baseCurrencyCode,
    quoteCurrencyCode: selected.quoteCurrencyCode,
    marketDate: selected.marketDate,
    observedAt: selected.observedAt,
    source:
      selection.explanation.source === "manual"
        ? "manual"
        : selection.explanation.source === "identity"
          ? "identity"
          : "provider",
    sourceId: selection.explanation.providerId,
    selectionState: selection.status as FxEvidence["selectionState"],
    quality: selected.quality === "identity" ? "identity" : selected.quality,
    fallback: selection.explanation.fallback,
    selectionReason: selection.explanation.reason,
  };
}

/** Whole-day calendar-date subtraction on a `YYYY-MM-DD` string -- pure UTC
 * arithmetic, matching `app/price-history-chart-geometry.ts`'s
 * `dateDayOffset` convention (calendar distance only, never displayed).
 * Malformed input passes through unchanged rather than throwing -- the
 * caller's dates are already validated at the external boundary
 * (`app/historical-portfolio-value.ts`); this is pure/defensive. */
function subtractCalendarDays(date: string, days: number): string {
  if (days <= 0) return date;
  const match = DATE_RE.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  const ms =
    Date.UTC(Number(year), Number(month) - 1, Number(day)) - days * 86_400_000;
  const result = new Date(ms);
  return `${String(result.getUTCFullYear()).padStart(4, "0")}-${String(
    result.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}

/** Groups rows by exact `marketDate` ONCE (O(rows)) -- the review B1 fix.
 * Every per-date lookup below is then a bounded number of Map lookups
 * instead of a re-scan of the whole array. */
function indexByMarketDate<T extends { marketDate: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.marketDate);
    if (bucket) bucket.push(row);
    else map.set(row.marketDate, [row]);
  }
  return map;
}

/** Gathers candidates from `date` and up to `toleranceDays` calendar days
 * BEFORE it (never after -- no look-ahead) via O(toleranceDays) bucket
 * lookups against a pre-built `indexByMarketDate` map. `toleranceDays: 0`
 * (the graph's exact-date rule) costs exactly one lookup. */
function candidatesWithinTolerance<T extends { marketDate: string }>(
  byDate: ReadonlyMap<string, readonly T[]>,
  date: string,
  toleranceDays: number,
): T[] {
  const candidates: T[] = [];
  for (let offset = 0; offset <= toleranceDays; offset += 1) {
    const candidateDate =
      offset === 0 ? date : subtractCalendarDays(date, offset);
    const bucket = byDate.get(candidateDate);
    if (bucket) candidates.push(...bucket);
  }
  return candidates;
}

type IndexedSecurity = {
  portfolioSecurityId: string;
  currencyCode: string;
  transactions: readonly LedgerQuantityFact[];
  priceByDate: ReadonlyMap<string, readonly PriceObservation[]>;
};

export type ComputeHistoricalPortfolioValueInput = {
  baseCurrencyCode: string;
  portfolioTimezone: string;
  /** Present instant (ISO). Used ONLY as a coarse, defensive guard against
   * valuing a date after "now" (`date > now`'s UTC calendar day short-
   * circuits to an honest unavailable point) -- NOT consulted by
   * `selectPriceObservation`'s own look-ahead guard, which is keyed on
   * `asOf`/`portfolioTimezone` (the per-observation `observationAt` cutoff
   * check), independent of this field. An earlier version of this comment
   * claimed `now` fed that guard directly; it does not -- corrected
   * (review fold). */
  now: string;
  /** Ascending, caller-deduped candidate dates to value. Each is valued
   * independently; this module never fills a date in because a neighbour
   * has one. */
  dates: readonly string[];
  securities: readonly HistoricalValueSecurityFact[];
  /** Owner-visible-scoped FX observations already bounded by the caller
   * (needed for a foreign-currency SECURITY -- cash is out of scope, see
   * this module's header). */
  fxObservations: readonly FxObservation[];
  /** How many calendar days BEFORE the target date a price/FX observation
   * may still count (0 = exact-date only). Review B3 ruling: the Overview
   * graph passes 0; Multi-Year's FY-end lookups pass 7. Defaults to 0 so
   * every pre-existing caller/fixture keeps the exact-date-only behaviour
   * unless it opts in. */
  priceToleranceDays?: number;
};

function isFutureDate(date: string, now: string): boolean {
  const nowDate = DATE_RE.test(now.slice(0, 10)) ? now.slice(0, 10) : null;
  return nowDate !== null && date > nowDate;
}

function valuePointAtDate(
  date: string,
  toleranceDays: number,
  baseCurrencyCode: string,
  portfolioTimezone: string,
  securities: readonly IndexedSecurity[],
  fxByDate: ReadonlyMap<string, readonly FxObservation[]>,
): HistoricalPortfolioValuePoint {
  let total: DecimalFraction = fromInteger(0n);
  let heldSecurityCount = 0;
  let pricedSecurityCount = 0;
  let anyComponentKnown = false;
  let anyComponentMissing = false;

  const resolveFx = (quoteCurrencyCode: string): FxSelection => {
    const candidates = candidatesWithinTolerance(fxByDate, date, toleranceDays);
    return selectFxObservation({
      asOf: date,
      portfolioTimezone,
      baseCurrencyCode,
      quoteCurrencyCode,
      targetKey: `historical-fx:${quoteCurrencyCode}`,
      observations: candidates,
      overrides: [],
      maxPriorCalendarDays: toleranceDays,
    });
  };

  for (const security of securities) {
    let quantity: string;
    try {
      quantity = deriveSharesHeldAtDate(security.transactions, date);
    } catch {
      // Review fold (BLOCKING): a throw here is a real data-integrity
      // problem, not "nothing held" -- must not silently report this
      // point as fully "complete".
      anyComponentMissing = true;
      continue;
    }
    let parsedQuantity: DecimalFraction;
    try {
      parsedQuantity = parseDecimal(quantity);
    } catch {
      anyComponentMissing = true;
      continue;
    }
    if (isZero(parsedQuantity)) continue; // not held on this date: not counted, not partial
    heldSecurityCount += 1;

    const priceCandidates = candidatesWithinTolerance(
      security.priceByDate,
      date,
      toleranceDays,
    );
    const priceSelection = selectPriceObservation({
      asOf: date,
      portfolioTimezone,
      targetKey: `historical-value:${security.portfolioSecurityId}`,
      currencyCode: security.currencyCode,
      observations: priceCandidates,
      overrides: [],
      maxPriorCalendarDays: toleranceDays,
    });
    if (!priceSelection.selected) {
      anyComponentMissing = true;
      continue;
    }

    let fxSelection: FxSelection | null = null;
    if (security.currencyCode !== baseCurrencyCode) {
      fxSelection = resolveFx(security.currencyCode);
      if (!fxSelection.selected) {
        anyComponentMissing = true;
        continue;
      }
    }

    const holding = calculateNativeHomeHolding({
      quantityDecimal: quantity,
      nativePriceDecimal: priceSelection.selected.closeDecimal,
      nativeCurrencyCode: security.currencyCode,
      homeCurrencyCode: baseCurrencyCode,
      valuationFx: fxSelection ? toFxEvidence(fxSelection) : null,
    });
    if (holding.facts.homeMarketValue.status !== "available") {
      anyComponentMissing = true;
      continue;
    }
    try {
      total = addDecimal(
        total,
        parseDecimal(holding.facts.homeMarketValue.valueDecimal),
      );
    } catch {
      anyComponentMissing = true;
      continue;
    }
    pricedSecurityCount += 1;
    anyComponentKnown = true;
  }

  const valueDecimal = anyComponentKnown ? formatDecimalExact(total) : null;
  const completeness: "complete" | "partial" = anyComponentMissing
    ? "partial"
    : "complete";

  return {
    date,
    valueDecimal,
    completeness,
    heldSecurityCount,
    pricedSecurityCount,
  };
}

/** Values ONE date -- exported so `app/historical-portfolio-value.ts` can
 * target a small set of specific dates (e.g. Multi-Year's ~10 FY-end dates)
 * without paying for a whole series. Builds its own indices per call --
 * fine at the call count this entry point actually sees (see the module
 * header's Performance note). */
export function computeHistoricalPortfolioValueAtDate(
  input: Omit<ComputeHistoricalPortfolioValueInput, "dates"> & {
    date: string;
  },
): HistoricalPortfolioValuePoint {
  const toleranceDays = Math.max(0, input.priceToleranceDays ?? 0);
  if (isFutureDate(input.date, input.now)) {
    return {
      date: input.date,
      valueDecimal: null,
      completeness: "partial",
      heldSecurityCount: 0,
      pricedSecurityCount: 0,
    };
  }
  const indexedSecurities: IndexedSecurity[] = input.securities.map(
    (security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      currencyCode: security.currencyCode,
      transactions: security.transactions,
      priceByDate: indexByMarketDate(security.priceObservations),
    }),
  );
  const fxByDate = indexByMarketDate(input.fxObservations);
  return valuePointAtDate(
    input.date,
    toleranceDays,
    input.baseCurrencyCode,
    input.portfolioTimezone,
    indexedSecurities,
    fxByDate,
  );
}

/** Values every date in `input.dates`, ascending. Pure/DB-free -- the
 * caller (`app/historical-portfolio-value.ts`) is responsible for bounding
 * both `dates` and the observation/ledger arrays before calling this.
 * Indices are built ONCE (review B1 fix) and reused across every date. */
export function computeHistoricalPortfolioValueSeries(
  input: ComputeHistoricalPortfolioValueInput,
): HistoricalPortfolioValuePoint[] {
  const toleranceDays = Math.max(0, input.priceToleranceDays ?? 0);
  const indexedSecurities: IndexedSecurity[] = input.securities.map(
    (security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      currencyCode: security.currencyCode,
      transactions: security.transactions,
      priceByDate: indexByMarketDate(security.priceObservations),
    }),
  );
  const fxByDate = indexByMarketDate(input.fxObservations);
  return input.dates.map((date) =>
    isFutureDate(date, input.now)
      ? {
          date,
          valueDecimal: null,
          completeness: "partial" as const,
          heldSecurityCount: 0,
          pricedSecurityCount: 0,
        }
      : valuePointAtDate(
          date,
          toleranceDays,
          input.baseCurrencyCode,
          input.portfolioTimezone,
          indexedSecurities,
          fxByDate,
        ),
  );
}
