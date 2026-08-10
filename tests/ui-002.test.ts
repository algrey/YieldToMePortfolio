import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createOverviewData,
  createUnavailableOverviewData,
} from "../app/overview-read-model.ts";
import type { OwnedOverviewPoint } from "../app/components/portfolio-shell.tsx";
import { createHistoricalSnapshotRepository } from "../db/repositories/snapshots.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { subtractCalendarMonths } from "../app/overview-range.ts";
import { sampleOverviewChartPoints } from "../app/overview-chart.ts";
import {
  overviewFormulaTotal,
  overviewStateCopy,
} from "../app/overview-copy.ts";

const snapshot = {
  id: "snapshot-a",
  date: "2026-08-08",
  totalValueDecimal: "1000.25",
  securitiesValueDecimal: "800.25",
  cashValueDecimal: "200",
  costBasisDecimal: "750",
  unrealisedGainDecimal: "50.25",
  realisedGainToDateDecimal: "10",
  dailyMovementDecimal: "5.25",
  completeness: "complete" as const,
  coverage: {
    totalHoldingCount: 1,
    nonZeroHoldingCount: 1,
    pricedHoldingCount: 1,
    convertedHoldingCount: 1,
    basisCoveredHoldingCount: 1,
    zeroHoldingCount: 0,
    totalCashAccountCount: 1,
    nonZeroCashAccountCount: 1,
    convertedCashAccountCount: 1,
    zeroCashAccountCount: 0,
    excludedHoldingIds: [],
    excludedCashAccountIds: [],
    gaps: [],
    marketDataStates: [],
    historyComplete: true,
  },
};

function model(overrides: Record<string, unknown> = {}) {
  return {
    baseCurrencyCode: "AUD",
    calculationVersion: 3,
    current: { ...snapshot, ...overrides },
    history: [snapshot],
    allocation: [
      {
        securityId: "holding-a",
        label: "Example",
        quantityDecimal: "10",
        valueDecimal: "800.25",
        completeness: "complete" as const,
      },
    ],
  } as Parameters<typeof createOverviewData>[0];
}

test("UI-002 read model formats a complete overview without timestamps", () => {
  const overview = createOverviewData(model());
  assert.equal(overview.status, "complete");
  assert.equal(overview.current?.value, "AUD 1,000.25");
  assert.equal(overview.current?.daily, "+AUD 5.25");
  assert.equal(overview.allocation.status, "complete");
  assert.equal(overview.current?.date, "2026-08-08");
  assert.equal("observedAt" in (overview.current ?? {}), false);
});

test("UI-002 preserves validated negative cash and total without signed zero", () => {
  const overview = createOverviewData(
    model({
      totalValueDecimal: "-10",
      cashValueDecimal: "-20",
      dailyMovementDecimal: "0",
    }),
  );
  assert.equal(overview.status, "complete");
  assert.equal(overview.current?.value, "−AUD 10.00");
  assert.equal(overview.current?.cash, "−AUD 20.00");
  assert.equal(overview.current?.daily, "AUD 0.00");
});

test("UI-002 read model distinguishes partial and stale coverage", () => {
  const partial = createOverviewData(
    model({
      completeness: "partial",
      coverage: {
        ...snapshot.coverage,
        gaps: [{ kind: "missing_price", componentId: "holding-a" }],
      },
    }),
  );
  const stale = createOverviewData(
    model({
      completeness: "incomplete",
      coverage: {
        ...snapshot.coverage,
        gaps: [{ kind: "stale_fx", componentId: "cash-a" }],
      },
    }),
  );
  assert.equal(partial.status, "partial");
  assert.equal(
    createOverviewData(
      model({
        completeness: "partial",
        coverage: { ...snapshot.coverage, gaps: [] },
      }),
    ).status,
    "unavailable",
  );
  assert.equal(
    createOverviewData(
      model({
        completeness: "partial",
        coverage: { ...snapshot.coverage, historyComplete: false },
      }),
    ).status,
    "partial",
  );
  assert.equal(stale.status, "stale");
  assert.equal(
    createOverviewData(
      model({
        completeness: "complete",
        coverage: {
          ...snapshot.coverage,
          gaps: [{ kind: "stale_fx", componentId: "cash-a" }],
        },
      }),
    ).status,
    "unavailable",
  );
  assert.equal(
    createOverviewData(
      model({
        completeness: "incomplete",
        totalValueDecimal: null,
        coverage: { ...snapshot.coverage },
      }),
    ).status,
    "unavailable",
  );
  assert.equal(
    createOverviewData(
      model({
        completeness: "complete",
        coverage: { ...snapshot.coverage, pricedHoldingCount: 0 },
      }),
    ).status,
    "unavailable",
  );
});

test("UI-002 read model degrades malformed calculated facts", () => {
  const malformed = createOverviewData(
    model({ totalValueDecimal: "not-a-decimal" }),
  );
  assert.equal(malformed.status, "unavailable");
  assert.equal(malformed.current, null);
  assert.equal(
    createOverviewData(model({ totalValueDecimal: null })).status,
    "unavailable",
  );
  assert.equal(
    createOverviewData(
      model({
        coverage: { ...snapshot.coverage, pricedHoldingCount: "1" },
      }),
    ).status,
    "unavailable",
  );
  assert.equal(
    createOverviewData({ ...model()!, calculationVersion: 0 }).status,
    "unavailable",
  );
  assert.equal(
    createOverviewData(model({ completeness: "not-an-enum" })).status,
    "unavailable",
  );
});

test("UI-002 preserves an incomplete null-total state and discloses non-exclusion gaps", () => {
  const overview = createOverviewData(
    model({
      completeness: "incomplete",
      totalValueDecimal: null,
      coverage: {
        ...snapshot.coverage,
        gaps: [
          { kind: "incomplete_basis", componentId: "holding-a" },
          { kind: "quantity_boundary", componentId: "holding-a" },
          { kind: "incomplete_history", componentId: "ledger" },
        ],
      },
    }),
  );
  assert.equal(overview.status, "incomplete");
  assert.equal(overview.current?.value, null);
  assert.equal(
    overviewFormulaTotal(overview.current!),
    "Total value unavailable.",
  );
  assert.match(
    overviewStateCopy(overview, overview.current!)!,
    /total is unavailable/,
  );
  assert.deepEqual(overview.coverage.issues, [
    { id: "holding-a", reason: "incomplete basis" },
    { id: "holding-a", reason: "quantity boundary" },
    { id: "ledger", reason: "incomplete history" },
  ]);
  assert.equal(
    createOverviewData(
      model({
        completeness: "incomplete",
        totalValueDecimal: null,
        coverage: {
          ...snapshot.coverage,
          gaps: [{ kind: "stale_price", componentId: "holding-a" }],
        },
      }),
    ).status,
    "incomplete",
  );
});

test("UI-002 partial banner copy follows the actual limiting reason", () => {
  const pricePartial = createOverviewData(
    model({
      completeness: "partial",
      coverage: {
        ...snapshot.coverage,
        gaps: [{ kind: "missing_price", componentId: "holding-a" }],
      },
    }),
  );
  const basisPartial = createOverviewData(
    model({
      completeness: "partial",
      coverage: {
        ...snapshot.coverage,
        gaps: [{ kind: "incomplete_basis", componentId: "holding-a" }],
      },
    }),
  );
  const historyPartial = createOverviewData(
    model({
      completeness: "partial",
      coverage: { ...snapshot.coverage, historyComplete: false },
    }),
  );
  assert.match(
    overviewStateCopy(pricePartial, pricePartial.current!)!,
    /excludes components/,
  );
  assert.match(
    overviewStateCopy(basisPartial, basisPartial.current!)!,
    /basis coverage/,
  );
  assert.match(
    overviewStateCopy(historyPartial, historyPartial.current!)!,
    /history coverage/,
  );
  assert.doesNotMatch(
    overviewStateCopy(basisPartial, basisPartial.current!)!,
    /excludes components/,
  );
});

test("UI-002 empty overview has no fabricated totals", () => {
  const overview = createOverviewData(null);
  assert.equal(overview.status, "empty");
  assert.equal(overview.current, null);
  assert.equal(overview.history.length, 0);
});

test("UI-002 range cutoffs clamp month ends and leap days", () => {
  assert.equal(subtractCalendarMonths("2024-03-31", 1), "2024-02-29");
  assert.equal(subtractCalendarMonths("2024-02-29", 12), "2023-02-28");
  assert.equal(subtractCalendarMonths("2023-05-31", 3), "2023-02-28");
});

test("UI-002 chart sampling stays bounded and retains extrema and gaps", () => {
  const points: OwnedOverviewPoint[] = Array.from(
    { length: 200 },
    (_, index) => ({
      date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
      value: index === 100 ? null : `AUD ${index}.00`,
      securities: null,
      cash: null,
      cost: null,
      unrealised: null,
      realised: null,
      daily: null,
      valueDecimal:
        index === 100
          ? null
          : index === 73
            ? "-500"
            : index === 141
              ? "5000"
              : String(index),
      completeness: index === 100 ? "incomplete" : "complete",
      barHeight: "50%",
    }),
  );
  const sampled = sampleOverviewChartPoints(points, 30);
  assert.ok(sampled.length <= 30);
  assert.equal(sampled[0]?.date, "2026-01-01");
  assert.equal(sampled.at(-1)?.date, "2026-01-04");
  assert.ok(sampled.some((point) => point.value === null));
  assert.ok(sampled.some((point) => point.valueDecimal === "-500"));
  assert.ok(sampled.some((point) => point.valueDecimal === "5000"));
});

test("UI-002 chart sampling represents later alternating gaps and extrema", () => {
  const points: OwnedOverviewPoint[] = Array.from(
    { length: 180 },
    (_, index) => {
      const gap = index % 18 === 4 || index % 18 === 5;
      const value =
        index === 157 ? "-9000" : index === 169 ? "9000" : String(index);
      return {
        date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
        value: gap ? null : `AUD ${value}.00`,
        securities: null,
        cash: null,
        cost: null,
        unrealised: null,
        realised: null,
        daily: null,
        valueDecimal: gap ? null : value,
        completeness: gap ? "incomplete" : "complete",
        barHeight: "50%",
      };
    },
  );
  const sampled = sampleOverviewChartPoints(points, 24);
  assert.ok(sampled.length <= 24);
  assert.ok(sampled.some((point) => point.valueDecimal === "-9000"));
  assert.ok(sampled.some((point) => point.valueDecimal === "9000"));
  assert.ok(sampled.some((point) => point.valueDecimal === null));
  assert.ok(sampled.some((point) => point.date === "2026-01-05"));
  assert.ok(sampled.some((point) => point.date === "2026-01-23"));
});

test("UI-002 unavailable is distinct from empty and chart math handles negative, flat, and gaps", () => {
  assert.equal(createUnavailableOverviewData("GBP").status, "unavailable");
  const first = {
    ...snapshot,
    date: "2026-07-08",
    totalValueDecimal: "1000",
    dailyMovementDecimal: null,
  };
  const second = {
    ...snapshot,
    date: "2026-08-08",
    totalValueDecimal: "900",
    dailyMovementDecimal: "-100",
  };
  const chart = createOverviewData({
    baseCurrencyCode: "GBP",
    calculationVersion: 3,
    current: second,
    history: [first, second],
    allocation: [
      {
        securityId: "holding-a",
        label: "Example",
        quantityDecimal: "10",
        valueDecimal: "900",
        completeness: "complete",
      },
    ],
  });
  assert.equal(chart.current?.daily, "−GBP 100.00");
  assert.equal(chart.history[0]?.barHeight, "100.00%");
  assert.equal(chart.history[1]?.barHeight, "20.00%");
});

test("UI-002 allocation uses valued holdings even when basis is incomplete", () => {
  const allocationBase = model({
    completeness: "partial",
    coverage: {
      ...snapshot.coverage,
      totalHoldingCount: 2,
      nonZeroHoldingCount: 2,
      pricedHoldingCount: 1,
      convertedHoldingCount: 1,
      basisCoveredHoldingCount: 0,
      zeroHoldingCount: 0,
      excludedHoldingIds: ["holding-b"],
    },
  });
  const overview = createOverviewData({
    ...allocationBase!,
    allocation: [
      {
        securityId: "holding-a",
        label: "Basis incomplete",
        quantityDecimal: "10",
        valueDecimal: "800",
        completeness: "partial" as const,
      },
      {
        securityId: "holding-b",
        label: "Missing value",
        quantityDecimal: "2",
        valueDecimal: null,
        completeness: "incomplete" as const,
      },
    ],
  });
  assert.equal(overview.allocation.status, "partial");
  assert.equal(overview.allocation.rows[0]?.value, "AUD 800.00");
  assert.equal(overview.allocation.rows[1]?.percent, null);
});

test("UI-002 published snapshot lookup is owner-scoped", async () => {
  const calls: unknown[][] = [];
  let mismatch = false;
  let rangeMismatch = false;
  let allocationMismatch = false;
  const sql: SqlClient = {
    async get<T extends Record<string, unknown>>(_query: string, params = []) {
      calls.push([...params]);
      if (_query.includes("calculation_runs")) {
        if (
          params[0] !== "run-a" ||
          params[1] !== "user-a" ||
          params[2] !== "portfolio-a"
        )
          return undefined;
        return {
          calculation_version: mismatch ? 4 : 3,
          status: "completed",
          ledger_high_water_end: "tx-a",
          range_from: "2026-08-08",
          range_to: rangeMismatch ? "2026-08-09" : "2026-08-08",
        } as unknown as T;
      }
      if (params[0] !== "user-a" || params[1] !== "portfolio-a")
        return undefined;
      return {
        calculation_version: 3,
        calculation_run_id: "run-a",
        ledger_high_water: "tx-a",
        base_currency_code: "AUD",
      } as unknown as T;
    },
    async all<T extends Record<string, unknown>>(_query: string, params = []) {
      calls.push([...params]);
      if (_query.includes("holding_daily_snapshots")) {
        if (allocationMismatch) return [] as T[];
        return [
          {
            portfolio_security_id: "holding-a",
            label: "Example",
            quantity_decimal: "10",
            native_value_decimal: "800",
            base_value_decimal: "800",
            basis_decimal: "750",
            completeness: "complete",
            calculation_version: 3,
            calculation_run_id: "run-a",
          },
        ] as unknown as T[];
      }
      return [
        {
          snapshot_date: "2026-08-08",
          id: "snapshot-a",
          calculation_version: 3,
          calculation_run_id: "run-a",
          ledger_high_water: "tx-a",
          base_currency_code: "AUD",
          total_value_decimal: "1000",
          securities_value_decimal: "800",
          cash_value_decimal: "200",
          cost_basis_decimal: "750",
          unrealised_gain_decimal: "50",
          realised_gain_to_date_decimal: "10",
          daily_movement_decimal: "5",
          completeness: "complete",
          coverage_json: JSON.stringify({
            totalHoldingCount: 1,
            nonZeroHoldingCount: 1,
            pricedHoldingCount: 1,
            convertedHoldingCount: 1,
            basisCoveredHoldingCount: 1,
            zeroHoldingCount: 0,
            totalCashAccountCount: 1,
            nonZeroCashAccountCount: 1,
            convertedCashAccountCount: 1,
            zeroCashAccountCount: 0,
            excludedHoldingIds: [],
            excludedCashAccountIds: [],
            gaps: [],
            marketDataStates: [],
            historyComplete: true,
          }),
        },
      ] as unknown as T[];
    },
    async run() {
      return { changes: 0, lastInsertRowId: 0 };
    },
  };
  const repository = createHistoricalSnapshotRepository(sql);
  assert.equal(
    await repository.loadPublishedOverview("user-b", "portfolio-a"),
    null,
  );
  const result = await repository.loadPublishedOverview(
    "user-a",
    "portfolio-a",
  );
  assert.equal(result?.current.totalValueDecimal, "1000");
  assert.deepEqual(calls[0], ["user-b", "portfolio-a"]);
  assert.deepEqual(calls[2]?.slice(0, 3), ["run-a", "user-a", "portfolio-a"]);
  mismatch = true;
  await assert.rejects(
    repository.loadPublishedOverview("user-a", "portfolio-a"),
    /invalid_snapshot_publication/,
  );
  mismatch = false;
  rangeMismatch = true;
  await assert.rejects(
    repository.loadPublishedOverview("user-a", "portfolio-a"),
    /invalid_snapshot_publication/,
  );
  rangeMismatch = false;
  allocationMismatch = true;
  await assert.rejects(
    repository.loadPublishedOverview("user-a", "portfolio-a"),
    /invalid_snapshot_holding/,
  );
});

test("UI-002 populated Overview exposes semantic drill-down and responsive controls", () => {
  const shell = readFileSync("app/components/portfolio-shell.tsx", "utf8");
  const copy = readFileSync("app/overview-copy.ts", "utf8");
  const styles = readFileSync("app/globals.css", "utf8");
  const root = readFileSync("app/page.tsx", "utf8");
  assert.match(shell, /Coverage and formula details/);
  assert.match(shell, /Value unavailable/);
  assert.match(copy, /Total value unavailable\./);
  assert.match(shell, /Coverage limitations/);
  assert.match(copy, /price, FX, or session coverage/);
  assert.match(copy, /basis coverage is incomplete/);
  assert.match(copy, /history coverage is incomplete/);
  assert.match(shell, /aria-label="History range"/);
  assert.match(shell, /View history as a table/);
  assert.match(shell, /Quotes/);
  assert.match(root, /includeOverview: true/);
  assert.match(styles, /\.range-controls button\s*\{[\s\S]*min-width: 44px/);
  assert.match(
    styles,
    /\.overview-drilldown summary\s*\{[\s\S]*min-height: 44px/,
  );
  assert.match(styles, /\.owned-overview,[\s\S]*min-width: 0/);
});
