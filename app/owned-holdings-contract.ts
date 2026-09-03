import type { Tone } from "./prototype-data.ts";
import type {
  PortfolioDailyMovementResult,
  PortfolioTotalsResult,
} from "../domain/calculations/index.ts";

export type OwnedHoldingValue = {
  status: "available" | "unavailable";
  currencyCode: string;
  value: string | null;
  reason: string | null;
};
export type OwnedCashSummary = {
  currencyCode: string;
  securitiesSubtotal: string | null;
  cashSubtotal: string | null;
  /** BUG-002: has no production consumer any more (a repo-wide grep found
   * exactly one, `app/owned-income-projection.ts`'s
   * `currentPortfolioValueDecimal`, which now reads `securitiesSubtotal`
   * instead -- see `docs/ARCHITECTURE.md` §9.1's BUG-002 extension entry).
   * Deliberately KEPT, not deleted in a dead-code sweep: the owner's
   * ruling was to narrow what the "portfolio value" figure reads, not to
   * remove the cash ledger or its computed totals ("don't destroy the
   * ledger, could be useful in future"). Still securities + cash, still
   * computed correctly. */
  knownTotal: string | null;
  status: "complete" | "partial" | "unavailable";
  explanation: string;
  coverage: {
    total: number;
    nonZero: number;
    zero: number;
    converted: number;
  };
};
export type OwnedHoldingRow = {
  id: string;
  securityId: string;
  symbol: string;
  name: string;
  exchange: string;
  currencyCode: string;
  quantity: string;
  averageNativeCost: string | null;
  nativeBasis: OwnedHoldingValue;
  homeBasis: OwnedHoldingValue;
  nativePrice: string | null;
  nativeValue: OwnedHoldingValue;
  homePrice: OwnedHoldingValue;
  homeValue: OwnedHoldingValue;
  dailyMovement: OwnedHoldingValue;
  dailyPercent: OwnedHoldingValue;
  unrealisedGain: OwnedHoldingValue;
  unrealisedPercent: OwnedHoldingValue;
  dailyTone: Tone;
  gainTone: Tone;
  priceState: "current" | "fallback" | "stale" | "unavailable";
  actionStatus:
    | "none"
    | "stale"
    | "missing_price"
    | "missing_fx"
    | "missing_previous"
    | "incomparable"
    // MKT-009B (review round-1 fix, B2): the `yahoo_authenticated`
    // price-source preference is not currently satisfied -- see
    // `app/owned-holdings.ts`'s `yahooAuthActionStatus` for the exact
    // not-configured-vs-expired distinction (F2).
    | "yahoo_auth_not_configured"
    | "yahoo_auth_expired";
  explanation: string;
  sort: {
    ticker: string;
    value: string | null;
    daily: string | null;
    gain: string | null;
  };
};
// UI-031: the holdings summary row's first two lines (market value / daily
// movement / unrealised gain / cost basis / daily percent / total percent)
// -- computed server-side, in `loadOwnedHoldings`, from the SAME `rows`
// this type's siblings render (no second data path that could disagree
// with the visible rows). `value` (market value / basis / gain) and
// `daily` (movement / percent) are deliberately two independent portfolio
// aggregates -- see `domain/calculations/multi-currency.ts`'s
// `composePortfolioDailyMovementTotal` header comment for why a holding can
// be excluded from one without being excluded from the other (e.g. known
// price+basis but an incomparable daily movement).
export type OwnedHoldingsUnrealisedSummary = {
  value: PortfolioTotalsResult;
  daily: PortfolioDailyMovementResult;
};
export type OwnedHoldingCoverage = {
  total: number;
  nonZero: number;
  zero: number;
  priced: number;
  converted: number;
  basis: number;
};
export type OwnedHoldingSort = "ticker" | "value" | "daily" | "gain";
export type OwnedHoldingDirection = "ascending" | "descending";

// BUG-017: read-time signal that the projection publication currently
// being served may not reflect the ledger's latest state -- the
// publication itself can be internally self-consistent (a real completed
// run, version-matched, high-water-matched) while a NEWER calculation run
// for the same portfolio is queued/running/terminally-failed and nothing
// has advanced it into a fresh publication yet (post-commit budget
// exhausted, a `failed` run, cron down). `pending: false` means the
// current publication is confirmed up to date (no such newer run found,
// or a same-request self-heal attempt caught it up). `reason: "queued" |
// "running"` means a newer run IS in flight -- the caller already ran one
// bounded read-time self-heal attempt (`advanceCalculationRuns`) this
// request and it either made no progress or is still working; the
// EXISTING publication is still served, just flagged. `reason: "failed"`
// is a DISTINCT, more serious honesty state: the newest run for this
// portfolio/pipeline failed with a failure_category other than
// `superseded_by_newer_run` (a genuinely poisoned computation) -- per
// `app/calculation-executor-service.ts`'s `advanceOneRun`, nothing
// retries a terminally `failed` run automatically; only a fresh ledger
// mutation queues a new one. Self-heal is never attempted for this
// reason (there is nothing claimable to advance). See
// `app/owned-holdings.ts`'s `PUBLICATION_SQL` and
// `app/owned-capital-gains.ts`'s equivalent query for the read, and
// `docs/ARCHITECTURE.md`'s CALC-003 entry (BUG-017 addendum) for the
// full design.
export type ProjectionPendingState =
  | { pending: false }
  | { pending: true; reason: "queued" | "running" | "failed" };

export function sortOwnedHoldings(
  rows: readonly OwnedHoldingRow[],
  key: OwnedHoldingSort,
  direction: OwnedHoldingDirection,
): OwnedHoldingRow[] {
  const canonical = (
    value: string,
  ): { negative: boolean; whole: string; fraction: string } | null => {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [rawWhole, rawFraction = ""] = unsigned.split(".");
    const whole = rawWhole.replace(/^0+(?=\d)/, "") || "0";
    const fraction = rawFraction.replace(/0+$/, "");
    return {
      negative: negative && (whole !== "0" || fraction.length > 0),
      whole,
      fraction,
    };
  };
  const compare = (left: string | null, right: string | null) => {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    const a = canonical(left);
    const b = canonical(right);
    if (!a || !b)
      return direction === "ascending"
        ? left.localeCompare(right)
        : right.localeCompare(left);
    if (a.negative !== b.negative) {
      const result = a.negative ? -1 : 1;
      return direction === "ascending" ? result : -result;
    }
    const wholeMagnitude =
      a.whole.length === b.whole.length
        ? a.whole.localeCompare(b.whole)
        : a.whole.length - b.whole.length;
    const scale = Math.max(a.fraction.length, b.fraction.length);
    const ad = a.fraction.padEnd(scale, "0");
    const bd = b.fraction.padEnd(scale, "0");
    const magnitude = wholeMagnitude || ad.localeCompare(bd);
    const result = a.negative ? -magnitude : magnitude;
    return direction === "ascending" ? result : -result;
  };
  return [...rows].sort((left, right) => {
    if (key === "ticker") {
      const result = left.symbol.localeCompare(right.symbol);
      return direction === "ascending" ? result : -result;
    }
    return compare(left.sort[key], right.sort[key]);
  });
}
