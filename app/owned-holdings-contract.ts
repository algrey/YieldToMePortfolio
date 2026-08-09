import type { Tone } from "./prototype-data.ts";

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
    | "incomparable";
  explanation: string;
  sort: {
    ticker: string;
    value: string | null;
    daily: string | null;
    gain: string | null;
  };
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
