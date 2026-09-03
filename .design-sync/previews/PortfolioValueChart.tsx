import { PortfolioValueChart } from "yieldtome-ui";

type History = Parameters<typeof PortfolioValueChart>[0]["history"];
type Point = History["points"][number];

const NOW = "2026-09-04T01:15:00Z";
const TZ = "Australia/Sydney";
const FY_START = 7;

/** Deterministic pseudo-random walk so the sheet is stable across captures. */
function walk(seed: number, start: number, steps: number, drift: number, vol: number): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < steps; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const r = s / 4294967296 - 0.5;
    v = Math.max(1, v * (1 + drift + r * vol));
    out.push(v);
  }
  return out;
}

function isoFromOffset(base: string, days: number): string {
  const [y, m, d] = base.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Monthly observations 2015-2018 (owner-import era), then weekly through
 * 2026 -- the density change is the real series' documented shape. */
function buildSeries(): Point[] {
  const points: Point[] = [];
  const monthly = walk(11, 184_250, 36, 0.006, 0.05);
  for (let i = 0; i < 36; i += 1) {
    const year = 2015 + Math.floor(i / 12);
    const month = (i % 12) + 1;
    points.push({
      date: `${year}-${String(month).padStart(2, "0")}-28`,
      valueDecimal: monthly[i]!.toFixed(2),
      completeness: "complete",
      heldSecurityCount: 6,
      pricedSecurityCount: 6,
    });
  }
  const weekly = walk(23, monthly[35]!, 400, 0.0022, 0.03);
  for (let i = 0; i < 400; i += 1) {
    const date = isoFromOffset("2018-01-05", i * 7);
    if (date > "2026-09-04") break;
    // A short unpriced stretch (a genuine gap, never interpolated) in 2020.
    const gap = date >= "2020-03-13" && date <= "2020-04-03";
    const partial = date >= "2024-11-01" && date <= "2024-12-13";
    points.push({
      date,
      valueDecimal: gap ? null : weekly[i]!.toFixed(2),
      completeness: partial ? "partial" : "complete",
      heldSecurityCount: 9,
      pricedSecurityCount: partial ? 8 : 9,
    });
  }
  return points;
}

const SERIES = buildSeries();

const okHistory: History = {
  status: "ok",
  baseCurrencyCode: "AUD",
  points: SERIES,
  datesTruncated: false,
  backfillPending: false,
};

/** Canonical: populated AUD series, default 12M range, with a partial run
 * (Nov-Dec 2024) that only shows when a longer range is selected. */
export function PortfolioValueChartPopulated() {
  return (
    <PortfolioValueChart
      history={okHistory}
      financialYearStartMonth={FY_START}
      timezone={TZ}
      nowInstant={NOW}
    />
  );
}

/** Populated series whose loader disclosed BOTH bounded-read caveats:
 * oldest dates trimmed, and the value-history cache still catching up. */
export function PortfolioValueChartTruncatedAndCatchingUp() {
  return (
    <PortfolioValueChart
      history={{ ...okHistory, datesTruncated: true, backfillPending: true }}
      financialYearStartMonth={FY_START}
      timezone={TZ}
      nowInstant={NOW}
    />
  );
}

/** Sparse series: only a handful of monthly owner-import points, with the
 * partial-completeness dash pattern visible inside the default range. */
export function PortfolioValueChartSparsePartial() {
  const points: Point[] = SERIES.slice(-14).map((point, index) => ({
    ...point,
    valueDecimal: point.valueDecimal ?? "201455.10",
    completeness: index >= 9 ? "partial" : "complete",
    pricedSecurityCount: index >= 9 ? 7 : 9,
  }));
  return (
    <PortfolioValueChart
      history={{ ...okHistory, points }}
      financialYearStartMonth={FY_START}
      timezone={TZ}
      nowInstant={NOW}
    />
  );
}

/** Empty: the portfolio has no priced holding dates yet. */
export function PortfolioValueChartEmpty() {
  return (
    <PortfolioValueChart
      history={{ ...okHistory, status: "empty", points: [] }}
      financialYearStartMonth={FY_START}
      timezone={TZ}
      nowInstant={NOW}
    />
  );
}

/** Unavailable: the read-time derivation failed (the shell's fallback). */
export function PortfolioValueChartUnavailable() {
  return (
    <PortfolioValueChart
      history={{ ...okHistory, status: "unavailable", points: [] }}
      financialYearStartMonth={FY_START}
      timezone={TZ}
      nowInstant={NOW}
    />
  );
}
