import {
  compareDecimal,
  parseDecimalResult,
} from "../domain/calculations/index.ts";
import type { OwnedOverviewPoint } from "./components/portfolio-shell";

const DEFAULT_MAX_POINTS = 90;

type GapRun = { start: number; end: number };

function gapRuns(points: readonly OwnedOverviewPoint[]): GapRun[] {
  const runs: GapRun[] = [];
  let start: number | null = null;
  for (let index = 0; index <= points.length; index += 1) {
    const gap = index < points.length && points[index]?.valueDecimal === null;
    if (gap && start === null) start = index;
    if (!gap && start !== null) {
      runs.push({ start, end: index - 1 });
      start = null;
    }
  }
  return runs;
}

/** Select a bounded visual series while the table retains every point. */
export function sampleOverviewChartPoints(
  points: readonly OwnedOverviewPoint[],
  maxPoints = DEFAULT_MAX_POINTS,
): OwnedOverviewPoint[] {
  if (points.length <= maxPoints || maxPoints < 2) return [...points];

  // Four slots are the minimum needed to preserve both endpoints and two
  // distinct extrema; the normal UI budget is 90.
  const target = Math.min(points.length, Math.max(4, maxPoints));
  const selected = new Set<number>([0, points.length - 1]);
  const valued = points
    .map((point, index) => ({ point, index }))
    .filter((entry) => entry.point.valueDecimal !== null);
  try {
    if (valued.length > 0) {
      let minimum = valued[0]!;
      let maximum = valued[0]!;
      for (const entry of valued.slice(1)) {
        const value = parseDecimalResult(entry.point.valueDecimal!);
        if (
          compareDecimal(
            value,
            parseDecimalResult(minimum.point.valueDecimal!),
          ) < 0
        )
          minimum = entry;
        if (
          compareDecimal(
            value,
            parseDecimalResult(maximum.point.valueDecimal!),
          ) > 0
        )
          maximum = entry;
      }
      selected.add(minimum.index);
      selected.add(maximum.index);
    }
  } catch {
    // The read model validates values; if a future transport fails validation,
    // retain only the safe endpoint structure rather than fabricating a bar.
  }

  const runs = gapRuns(points);
  const gapBudget = Math.max(0, target - selected.size);
  if (runs.length > 0 && gapBudget > 0) {
    if (runs.length * 2 <= gapBudget) {
      for (const run of runs) {
        selected.add(run.start);
        selected.add(run.end);
      }
    } else {
      const representativeCount = Math.min(runs.length, gapBudget);
      for (let slot = 0; slot < representativeCount; slot += 1) {
        const runIndex =
          representativeCount === 1
            ? Math.floor((runs.length - 1) / 2)
            : Math.round(
                (slot * (runs.length - 1)) / (representativeCount - 1),
              );
        const run = runs[runIndex]!;
        selected.add(Math.floor((run.start + run.end) / 2));
      }
    }
  }

  for (
    let bucket = 1;
    bucket < target - 1 && selected.size < target;
    bucket += 1
  ) {
    selected.add(Math.round((bucket * (points.length - 1)) / (target - 1)));
  }
  for (
    let index = 0;
    index < points.length && selected.size < target;
    index += 1
  ) {
    selected.add(index);
  }

  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, target)
    .map((index) => points[index]!);
}
