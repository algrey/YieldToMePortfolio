/** MKT-018B — guided-flow "Download price history" panel on the import
 * page. `docs/MARKET_DATA_STRATEGY.md` section 24's spike verdict is NO-GO
 * for a Worker-side fetch against Intelligent Investor (robots.txt
 * `Disallow`, WAF UA gate) -- this task's own fallback: list zero-coverage
 * held securities with a guide link + expected filename, and report
 * partial-coverage gaps honestly, feeding the EXISTING MKT-008 importer.
 *
 * Review round-1 (2026-08-24, BLOCKING): B1 -- classification originally
 * ignored `lastObservationDate`, so a security whose ENTIRE stored history
 * predates the holding read as "covered" (inference read as observation).
 * Fixed with two rules: (a) history ending before the holding started is
 * `partial`, and (b) a currently-held (non-sold-out) security whose LAST
 * observation is more than `TRAILING_STALENESS_DAYS` before "today" is
 * `partial` too (day-to-day freshness is the live capture pipeline's job;
 * this panel exists for bulk CSV backfill) -- sold-out securities are
 * exempt from (b). B2 -- the `IN (...)` coverage query bound up to 501
 * params against D1's ~100 ceiling, and the `LIMIT 500` identities query
 * could silently truncate; both are fixed with chunking + fail-closed
 * counting in `app/price-history-coverage.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { loadOwnedPriceHistoryCoverage } from "../app/price-history-coverage.ts";
import {
  classifyPriceHistoryCoverage,
  coverageGapSummary,
  iiDownloadFilename,
  iiShareUrl,
  TRAILING_STALENESS_DAYS,
  type PriceHistoryCoverageRow,
} from "../app/price-history-coverage-format.ts";

// `PriceHistoryCoverageZeroList`/`PriceHistoryCoveragePartialList` are
// components in the "use client" `.tsx` panel -- rendered below via
// `renderComponent` (a child process using the `tsx` loader), never
// imported directly here (Node's `--experimental-strip-types` loader
// cannot import JSX, matching every other `.tsx` component test in this
// suite, e.g. `tests/mkt-008.test.ts`'s `PriceUploadList`).

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(createElement(${componentName}, props)),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

/**
 * A thin `SqlClient` wrapper that lets ONE specific query's result be
 * substituted (matched by a literal substring of its SQL text) while every
 * other query still hits the real sqlite-backed client. Used ONLY to pin
 * `loadOwnedPriceHistoryCoverage`'s fail-closed paths CHEAPLY -- without
 * this, proving the `heldCount > MAX_HELD` guard or the
 * count/list-mismatch guard would require inserting hundreds of real rows;
 * substituting just the ONE query each guard reads exercises the exact
 * same code path for a fraction of the fixture cost.
 */
function wrapSqlClient(
  base: SqlClient,
  overrides: {
    get?: (sql: string) => Record<string, unknown> | undefined;
    all?: (sql: string) => Record<string, unknown>[] | undefined;
  },
): SqlClient {
  return {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const override = overrides.all?.(sql);
      if (override !== undefined) return override as T[];
      return base.all<T>(sql, params);
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      const override = overrides.get?.(sql);
      if (override !== undefined) return override as T;
      return base.get<T>(sql, params);
    },
    run: (sql, params) => base.run(sql, params),
    batch: (statements) => base.batch(statements),
  };
}

// ---------------------------------------------------------------------------
// Part 1: pure classification.
// ---------------------------------------------------------------------------

function classifyRow(overrides: {
  observationCount: number;
  firstObservationDate: string | null;
  lastObservationDate: string | null;
  firstTransactionDate: string | null;
  isSoldOut?: boolean;
  today?: string;
}) {
  return classifyPriceHistoryCoverage({
    isSoldOut: false,
    today: "2020-02-01",
    ...overrides,
  });
}

test("MKT-018B: classifyPriceHistoryCoverage -- zero observations is always 'zero'", () => {
  assert.equal(
    classifyRow({
      observationCount: 0,
      firstObservationDate: null,
      lastObservationDate: null,
      firstTransactionDate: "2020-01-01",
    }),
    "zero",
  );
});

test("MKT-018B: classifyPriceHistoryCoverage -- reaching across the holding start, and freshly observed, is 'covered'", () => {
  assert.equal(
    classifyRow({
      observationCount: 10,
      firstObservationDate: "2019-01-01",
      lastObservationDate: "2020-01-15",
      firstTransactionDate: "2020-01-01",
      today: "2020-01-20",
    }),
    "covered",
  );
  // Exactly equal first-observation/first-transaction dates: still covered.
  assert.equal(
    classifyRow({
      observationCount: 1,
      firstObservationDate: "2020-01-01",
      lastObservationDate: "2020-01-01",
      firstTransactionDate: "2020-01-01",
      today: "2020-01-05",
    }),
    "covered",
  );
});

test("MKT-018B: classifyPriceHistoryCoverage -- earliest observation AFTER the first-transaction date is 'partial' (gap at the start)", () => {
  assert.equal(
    classifyRow({
      observationCount: 3,
      firstObservationDate: "2020-06-01",
      lastObservationDate: "2020-06-05",
      firstTransactionDate: "2020-01-01",
      today: "2020-06-10",
    }),
    "partial",
  );
});

test("MKT-018B: classifyPriceHistoryCoverage -- an unresolvable first-transaction date is honestly 'partial', never guessed as 'covered'", () => {
  assert.equal(
    classifyRow({
      observationCount: 5,
      firstObservationDate: "2020-06-01",
      lastObservationDate: "2020-06-05",
      firstTransactionDate: null,
    }),
    "partial",
  );
});

test("MKT-018B review round-1 fix (B1a, BLOCKING): history whose LATEST observation is before the holding started is 'partial', never 'covered' -- it never reaches the holding period at all", () => {
  assert.equal(
    classifyRow({
      observationCount: 4,
      firstObservationDate: "2018-01-01",
      lastObservationDate: "2019-06-01", // entirely before the 2020-01-01 buy
      firstTransactionDate: "2020-01-01",
      today: "2020-06-01",
    }),
    "partial",
  );
});

test("MKT-018B review ruling (B1b, 2026-08-24): a HELD security whose last observation is more than TRAILING_STALENESS_DAYS before today is 'partial' -- bulk-backfill freshness, not day-to-day lag", () => {
  assert.equal(TRAILING_STALENESS_DAYS, 30);
  // Exactly 30 days stale: NOT yet flagged ("more than 30", inclusive floor).
  assert.equal(
    classifyRow({
      observationCount: 2,
      firstObservationDate: "2020-01-01",
      lastObservationDate: "2020-01-02",
      firstTransactionDate: "2020-01-01",
      isSoldOut: false,
      today: "2020-02-01", // dateDayOffset diff from 2020-01-02 is exactly 30
    }),
    "covered",
  );
  // 31 days stale: flagged.
  assert.equal(
    classifyRow({
      observationCount: 1,
      firstObservationDate: "2020-01-01",
      lastObservationDate: "2020-01-01",
      firstTransactionDate: "2020-01-01",
      isSoldOut: false,
      today: "2020-02-01", // diff from 2020-01-01 is 31
    }),
    "partial",
  );
});

test("MKT-018B review ruling (B1b exemption): a SOLD-OUT security with the IDENTICAL stale last-observation date stays 'covered' -- no ongoing freshness need for a position no longer held", () => {
  assert.equal(
    classifyRow({
      observationCount: 1,
      firstObservationDate: "2020-01-01",
      lastObservationDate: "2020-01-01",
      firstTransactionDate: "2020-01-01",
      isSoldOut: true,
      today: "2020-02-01", // 31 days stale, but exempt
    }),
    "covered",
  );
});

// ---------------------------------------------------------------------------
// Part 2: link/filename rendering.
// ---------------------------------------------------------------------------

test("MKT-018B: iiShareUrl follows the guide's exact URL pattern, lower-cased", () => {
  assert.equal(
    iiShareUrl("SHL"),
    "https://www.intelligentinvestor.com.au/shares/asx-shl/",
  );
  assert.equal(
    iiShareUrl("cba"),
    "https://www.intelligentinvestor.com.au/shares/asx-cba/",
  );
});

test("MKT-018B: iiDownloadFilename follows the guide's exact exporting.filename convention, upper-cased", () => {
  assert.equal(iiDownloadFilename("shl"), "ASX-SHL.csv");
  assert.equal(iiDownloadFilename("CBA"), "ASX-CBA.csv");
});

function coverageRow(
  overrides: Partial<PriceHistoryCoverageRow>,
): PriceHistoryCoverageRow {
  return {
    portfolioSecurityId: "ps-1",
    securityId: "sec-1",
    ticker: "SHL",
    name: "Sonic Healthcare",
    observationCount: 0,
    firstObservationDate: null,
    lastObservationDate: null,
    firstTransactionDate: "2020-01-01",
    isSoldOut: false,
    classification: "zero",
    ...overrides,
  };
}

test("MKT-018B: PriceHistoryCoverageZeroList renders the guide link (new tab, noopener/noreferrer, no-referrer) and the expected filename per ticker", () => {
  const rows: PriceHistoryCoverageRow[] = [coverageRow({})];
  const html = renderComponent(
    "PriceHistoryCoverageZeroList",
    "../app/components/historical-data-panel.tsx",
    { rows },
  );
  assert.match(html, /SHL/);
  assert.match(html, /Sonic Healthcare/);
  assert.match(
    html,
    /href="https:\/\/www\.intelligentinvestor\.com\.au\/shares\/asx-shl\/"/,
  );
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerpolicy="no-referrer"/i);
  assert.match(html, /ASX-SHL\.csv/);
});

test("MKT-018B: PriceHistoryCoverageZeroList renders nothing for an empty list", () => {
  const html = renderComponent(
    "PriceHistoryCoverageZeroList",
    "../app/components/historical-data-panel.tsx",
    { rows: [] },
  );
  assert.equal(html.trim(), "");
});

// ---------------------------------------------------------------------------
// Part 3: gap-report honesty (real dates, never fabricated).
// ---------------------------------------------------------------------------

test("MKT-018B: coverageGapSummary states the real observed date range and the real held-since date, with an accurate day count (gap at the start)", () => {
  const summary = coverageGapSummary({
    firstObservationDate: "2020-06-01",
    lastObservationDate: "2020-06-05",
    firstTransactionDate: "2020-01-01",
    isSoldOut: false,
  });
  assert.match(summary, /2020-06-01 to 2020-06-05/);
  assert.match(summary, /Held since 2020-01-01/);
  // 2020-01-01 -> 2020-06-01 is exactly 152 days (2020 is a leap year).
  assert.match(summary, /152 day\(s\)/);
});

test("MKT-018B: coverageGapSummary never fabricates a held-since date it does not have", () => {
  const summary = coverageGapSummary({
    firstObservationDate: "2020-06-01",
    lastObservationDate: "2020-06-05",
    firstTransactionDate: null,
    isSoldOut: false,
  });
  assert.match(summary, /first-transaction date is unavailable/);
  assert.doesNotMatch(summary, /Held since/);
});

test("MKT-018B: coverageGapSummary's defensive final fallback states 'no gap' -- structurally unreachable via the real read (a row passing both structural checks classifies 'covered' when sold-out and is never handed to this function), but never fabricates a claim if it were ever reached", () => {
  const summary = coverageGapSummary({
    firstObservationDate: "2019-01-01",
    lastObservationDate: "2020-06-05",
    firstTransactionDate: "2020-01-01",
    isSoldOut: true,
  });
  assert.match(summary, /no gap before the first observation/);
});

test("MKT-018B review round-1 fix (B1a): coverageGapSummary states a DISTINCT honest sentence when the whole history predates the holding, never claiming 'no gap'", () => {
  const summary = coverageGapSummary({
    firstObservationDate: "2018-01-01",
    lastObservationDate: "2019-06-01",
    firstTransactionDate: "2020-01-01",
    isSoldOut: false,
  });
  assert.match(summary, /entirely from BEFORE the holding started/);
  assert.doesNotMatch(summary, /no gap before the first observation/);
});

test("MKT-018B review ruling (B1b): coverageGapSummary names the real last-observation date for a held, trailing-stale row", () => {
  const summary = coverageGapSummary({
    firstObservationDate: "2020-01-01",
    lastObservationDate: "2020-01-01",
    firstTransactionDate: "2020-01-01",
    isSoldOut: false,
  });
  assert.match(summary, /last observation is 2020-01-01/);
  assert.match(summary, /more than 30 days ago/);
});

test("MKT-018B: PriceHistoryCoveragePartialList renders the honest gap summary per row", () => {
  const rows: PriceHistoryCoverageRow[] = [
    coverageRow({
      portfolioSecurityId: "ps-2",
      securityId: "sec-2",
      ticker: "CBA",
      name: "Commonwealth Bank",
      observationCount: 5,
      firstObservationDate: "2020-06-01",
      lastObservationDate: "2020-06-05",
      firstTransactionDate: "2020-01-01",
      classification: "partial",
    }),
  ];
  const html = renderComponent(
    "PriceHistoryCoveragePartialList",
    "../app/components/historical-data-panel.tsx",
    { rows },
  );
  assert.match(html, /CBA/);
  assert.match(html, /2020-06-01 to 2020-06-05/);
  assert.match(html, /152 day\(s\)/);
});

// ---------------------------------------------------------------------------
// Part 4: `loadOwnedPriceHistoryCoverage` -- DB-backed, real migrated schema.
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

// "Today" for every DB-backed test below: 2026-08-24 16:00 in
// Australia/Sydney (AEST, +10:00) -- 30 days before is 2026-07-25.
const FIXTURE_NOW = new Date("2026-08-24T06:00:00.000Z");
const FRESH_DATE = "2026-08-20"; // within the 30-day staleness floor
const STALE_DATE = "2020-01-10"; // far more than 30 days before FIXTURE_NOW

/**
 * One portfolio (user-a/portfolio-a) exercising every classification path,
 * PLUS a cross-owner fixture (user-b/portfolio-b) for ownership isolation:
 *   - security-zero:        held, no price_observations at all -> zero.
 *   - security-gap-start:   held since 2020-01-01, observations only
 *                           2020-06-01..2020-06-05 -> partial (gap at the
 *                           holding's start).
 *   - security-sparse:      held since 2020-01-01, exactly ONE observation
 *                           (2020-07-01) -> partial, first == last date.
 *   - security-pre-holding: review B1a -- held since 2020-01-01,
 *                           observations ONLY 2018-01-01..2019-06-01
 *                           (entirely BEFORE the holding started) -> partial,
 *                           never 'covered'.
 *   - security-fresh:       held since 2020-01-01, observations from
 *                           2019-01-01 through FRESH_DATE (within the
 *                           30-day floor) -> covered.
 *   - security-stale-held:  review B1b -- held (not sold out) since
 *                           2020-01-01, observations 2019-01-01..STALE_DATE
 *                           (far more than 30 days old) -> partial.
 *   - security-stale-sold:  review B1b exemption -- bought THEN fully sold
 *                           (net quantity 0, but `portfolio_securities.status`
 *                           stays 'held' per this codebase's own convention),
 *                           IDENTICAL stale observation range as
 *                           security-stale-held -> covered (exempt).
 *   - security-sold-gap:    fully bought AND sold, observations only AFTER
 *                           the buy with a genuine structural gap -> still
 *                           'partial' (sold-out never exempts a STRUCTURAL
 *                           gap, only the B1b staleness rule).
 *   - security-watched:     `status = 'watch'`, never appears in either list.
 *   - security-shared:      held by BOTH user-a and user-b (same
 *                           security_id, distinct portfolio_securities
 *                           rows) -- user-b has a user-scoped price row,
 *                           user-a has none -> ownership isolation both
 *                           ways.
 *   - security-wrong-ccy:   fold -- held since 2020-01-01 (AUD identity
 *                           currency), but its only price_observations rows
 *                           are USD -- must not count as coverage (the
 *                           chart would never plot them either) -> zero.
 *   - security-deployment:  fold -- covered ONLY via a `access_scope =
 *                           'deployment'` row (no user-scoped row at all)
 *                           -> pins that predicate branch actually counts.
 */
async function coverageFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1),
           ('user-b', 'active', 'b@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, financial_year_start_month, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', 7, '2026-08-01', '2026-08-01', 1),
           ('user-b', 'AUD', 'Australia/Sydney', 7, '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1),
           ('portfolio-b', 'user-b', 'B', 'B portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);

    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-zero', 'Zero Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-gap-start', 'GapStart Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-sparse', 'Sparse Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-pre-holding', 'PreHolding Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-fresh', 'Fresh Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-stale-held', 'StaleHeld Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-stale-sold', 'StaleSold Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-sold-gap', 'SoldGap Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-watched', 'Watched Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-shared', 'Shared Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-wrong-ccy', 'WrongCcy Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-deployment', 'Deployment Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');

    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('ps-zero', 'user-a', 'portfolio-a', 'security-zero', 'ZRO', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-gap-start', 'user-a', 'portfolio-a', 'security-gap-start', 'PRT', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-sparse', 'user-a', 'portfolio-a', 'security-sparse', 'TDY', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-pre-holding', 'user-a', 'portfolio-a', 'security-pre-holding', 'PRE', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-fresh', 'user-a', 'portfolio-a', 'security-fresh', 'CVR', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-stale-held', 'user-a', 'portfolio-a', 'security-stale-held', 'STL', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-stale-sold', 'user-a', 'portfolio-a', 'security-stale-sold', 'EXM', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-sold-gap', 'user-a', 'portfolio-a', 'security-sold-gap', 'SLD', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-watched', 'user-a', 'portfolio-a', 'security-watched', 'WCH', 'ASX', 'AUD', 'watch', '2026-08-01', '2026-08-01'),
           ('ps-shared-a', 'user-a', 'portfolio-a', 'security-shared', 'SHR', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-shared-b', 'user-b', 'portfolio-b', 'security-shared', 'SHR', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-wrong-ccy', 'user-a', 'portfolio-a', 'security-wrong-ccy', 'FXW', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('ps-deployment', 'user-a', 'portfolio-a', 'security-deployment', 'DEP', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');

    INSERT INTO transactions (id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at, local_trade_date, quantity_decimal, unit_price_decimal, currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal, source_type, created_by_user_id, calculation_version, created_at)
    VALUES ('tx-zero-buy', 'user-a', 'portfolio-a', 'ps-zero', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-gap-start-buy', 'user-a', 'portfolio-a', 'ps-gap-start', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-sparse-buy', 'user-a', 'portfolio-a', 'ps-sparse', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-pre-holding-buy', 'user-a', 'portfolio-a', 'ps-pre-holding', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-fresh-buy', 'user-a', 'portfolio-a', 'ps-fresh', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-stale-held-buy', 'user-a', 'portfolio-a', 'ps-stale-held', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-stale-sold-buy', 'user-a', 'portfolio-a', 'ps-stale-sold', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-stale-sold-sell', 'user-a', 'portfolio-a', 'ps-stale-sold', 'sell', 'posted', '2020-02-01T00:00:00Z', '2020-02-01', '10', '6', 'AUD', '60', '0', '0', 'manual', 'user-a', 1, '2020-02-01'),
           ('tx-sold-gap-buy', 'user-a', 'portfolio-a', 'ps-sold-gap', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-sold-gap-sell', 'user-a', 'portfolio-a', 'ps-sold-gap', 'sell', 'posted', '2020-12-01T00:00:00Z', '2020-12-01', '10', '6', 'AUD', '60', '0', '0', 'manual', 'user-a', 1, '2020-12-01'),
           ('tx-shared-a-buy', 'user-a', 'portfolio-a', 'ps-shared-a', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-shared-b-buy', 'user-b', 'portfolio-b', 'ps-shared-b', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-b', 1, '2020-01-01'),
           ('tx-wrong-ccy-buy', 'user-a', 'portfolio-a', 'ps-wrong-ccy', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-deployment-buy', 'user-a', 'portfolio-a', 'ps-deployment', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01');

    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
    VALUES ('mapping-gap-start', 'security-gap-start', 'owner-import', 'ASX', 'PRT', '2020-01-01', 'verified'),
           ('mapping-sparse', 'security-sparse', 'owner-import', 'ASX', 'TDY', '2020-01-01', 'verified'),
           ('mapping-pre-holding', 'security-pre-holding', 'owner-import', 'ASX', 'PRE', '2020-01-01', 'verified'),
           ('mapping-fresh', 'security-fresh', 'owner-import', 'ASX', 'CVR', '2020-01-01', 'verified'),
           ('mapping-stale-held', 'security-stale-held', 'owner-import', 'ASX', 'STL', '2020-01-01', 'verified'),
           ('mapping-stale-sold', 'security-stale-sold', 'owner-import', 'ASX', 'EXM', '2020-01-01', 'verified'),
           ('mapping-sold-gap', 'security-sold-gap', 'owner-import', 'ASX', 'SLD', '2020-01-01', 'verified'),
           ('mapping-shared-b', 'security-shared', 'owner-import', 'ASX', 'SHR', '2020-01-01', 'verified'),
           ('mapping-wrong-ccy', 'security-wrong-ccy', 'owner-import', 'ASX', 'FXW', '2020-01-01', 'verified'),
           ('mapping-deployment', 'security-deployment', 'owner-import', 'ASX', 'DEP', '2020-01-01', 'verified');

    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES
      -- security-gap-start: 2020-06-01..2020-06-05, a real gap after the
      -- 2020-01-01 holding start.
      ('price-gap-start-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-gap-start', 'security-gap-start', 'eod', '2020-05-31T14:00:00.000Z', '2020-06-01', 'Australia/Sydney', 'AUD', '1.00', 'raw', 'observed', '2020-06-01T00:00:00.000Z'),
      ('price-gap-start-5', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-gap-start', 'security-gap-start', 'eod', '2020-06-04T14:00:00.000Z', '2020-06-05', 'Australia/Sydney', 'AUD', '1.05', 'raw', 'observed', '2020-06-05T00:00:00.000Z'),
      -- security-sparse: exactly ONE observation.
      ('price-sparse-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-sparse', 'security-sparse', 'eod', '2020-06-30T14:00:00.000Z', '2020-07-01', 'Australia/Sydney', 'AUD', '2.00', 'raw', 'observed', '2020-07-01T00:00:00.000Z'),
      -- security-pre-holding (B1a): ENTIRELY before the 2020-01-01 holding start.
      ('price-pre-holding-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-pre-holding', 'security-pre-holding', 'eod', '2017-12-31T14:00:00.000Z', '2018-01-01', 'Australia/Sydney', 'AUD', '2.50', 'raw', 'observed', '2018-01-01T00:00:00.000Z'),
      ('price-pre-holding-2', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-pre-holding', 'security-pre-holding', 'eod', '2019-05-31T14:00:00.000Z', '2019-06-01', 'Australia/Sydney', 'AUD', '2.60', 'raw', 'observed', '2019-06-01T00:00:00.000Z'),
      -- security-fresh: reaches the holding start AND a recent last date -> covered.
      ('price-fresh-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-fresh', 'security-fresh', 'eod', '2018-12-31T14:00:00.000Z', '2019-01-01', 'Australia/Sydney', 'AUD', '3.00', 'raw', 'observed', '2019-01-01T00:00:00.000Z'),
      ('price-fresh-2', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-fresh', 'security-fresh', 'eod', '2026-08-19T14:00:00.000Z', '${FRESH_DATE}', 'Australia/Sydney', 'AUD', '3.10', 'raw', 'observed', '2026-08-20T00:00:00.000Z'),
      -- security-stale-held (B1b): reaches the holding start, but the last
      -- observation is far more than 30 days before FIXTURE_NOW -- still held.
      ('price-stale-held-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-stale-held', 'security-stale-held', 'eod', '2018-12-31T14:00:00.000Z', '2019-01-01', 'Australia/Sydney', 'AUD', '4.00', 'raw', 'observed', '2019-01-01T00:00:00.000Z'),
      ('price-stale-held-2', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-stale-held', 'security-stale-held', 'eod', '2020-01-09T14:00:00.000Z', '${STALE_DATE}', 'Australia/Sydney', 'AUD', '4.10', 'raw', 'observed', '2020-01-10T00:00:00.000Z'),
      -- security-stale-sold (B1b exemption): IDENTICAL stale range, but sold out.
      ('price-stale-sold-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-stale-sold', 'security-stale-sold', 'eod', '2018-12-31T14:00:00.000Z', '2019-01-01', 'Australia/Sydney', 'AUD', '5.00', 'raw', 'observed', '2019-01-01T00:00:00.000Z'),
      ('price-stale-sold-2', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-stale-sold', 'security-stale-sold', 'eod', '2020-01-09T14:00:00.000Z', '${STALE_DATE}', 'Australia/Sydney', 'AUD', '5.10', 'raw', 'observed', '2020-01-10T00:00:00.000Z'),
      -- security-sold-gap: only observations AFTER the buy, a real structural
      -- gap that sold-out status does NOT exempt.
      ('price-sold-gap-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-sold-gap', 'security-sold-gap', 'eod', '2020-06-30T14:00:00.000Z', '2020-07-01', 'Australia/Sydney', 'AUD', '6.00', 'raw', 'observed', '2020-07-01T00:00:00.000Z'),
      -- security-shared: user-B's OWN user-scoped row on the SHARED
      -- security_id -- must never count toward user-a's coverage.
      ('price-shared-b-1', 'owner-import', 'user', 'user-b', 'user-b', 'mapping-shared-b', 'security-shared', 'eod', '2020-01-01T14:00:00.000Z', '2020-01-02', 'Australia/Sydney', 'AUD', '7.00', 'raw', 'observed', '2020-01-02T00:00:00.000Z'),
      -- security-wrong-ccy (fold): USD rows on an AUD-identity security --
      -- must not count as coverage.
      ('price-wrong-ccy-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-wrong-ccy', 'security-wrong-ccy', 'eod', '2018-12-31T14:00:00.000Z', '2019-01-01', 'Australia/Sydney', 'USD', '8.00', 'raw', 'observed', '2019-01-01T00:00:00.000Z'),
      -- security-deployment (fold): DEPLOYMENT-scope only, no user-scoped
      -- row at all -- must still count as coverage for this owner.
      ('price-deployment-1', 'owner-import', 'deployment', NULL, 'deployment', 'mapping-deployment', 'security-deployment', 'eod', '2018-12-31T14:00:00.000Z', '2019-01-01', 'Australia/Sydney', 'AUD', '9.00', 'raw', 'observed', '2019-01-01T00:00:00.000Z'),
      ('price-deployment-2', 'owner-import', 'deployment', NULL, 'deployment', 'mapping-deployment', 'security-deployment', 'eod', '2026-08-19T14:00:00.000Z', '${FRESH_DATE}', 'Australia/Sydney', 'AUD', '9.10', 'raw', 'observed', '2026-08-20T00:00:00.000Z');
  `);
  return db;
}

test("MKT-018B: loadOwnedPriceHistoryCoverage sorts held securities into zero/partial, excludes covered, watched, and another owner's rows", async () => {
  const db = await coverageFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-a",
    "portfolio-a",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const zeroTickers = result.zero.map((row) => row.ticker).sort();
  // security-zero (no rows), security-shared (only user-b's row exists),
  // security-wrong-ccy (fold: USD rows never count for an AUD identity).
  assert.deepEqual(zeroTickers, ["FXW", "SHR", "ZRO"]);

  const partialTickers = result.partial.map((row) => row.ticker).sort();
  assert.deepEqual(partialTickers, ["PRE", "PRT", "SLD", "STL", "TDY"]);

  // Watched (not held), fresh-covered, deployment-covered, and stale-but-
  // sold-out securities never appear in either list.
  const allTickers = [...zeroTickers, ...partialTickers];
  for (const excluded of ["WCH", "CVR", "DEP", "EXM"]) {
    assert.ok(
      !allTickers.includes(excluded),
      `${excluded} should be covered/excluded`,
    );
  }

  const gapStart = result.partial.find((row) => row.ticker === "PRT")!;
  assert.equal(gapStart.observationCount, 2);
  assert.equal(gapStart.firstObservationDate, "2020-06-01");
  assert.equal(gapStart.lastObservationDate, "2020-06-05");
  assert.equal(gapStart.firstTransactionDate, "2020-01-01");
  assert.equal(gapStart.classification, "partial");
  assert.equal(gapStart.isSoldOut, false);

  const sparse = result.partial.find((row) => row.ticker === "TDY")!;
  assert.equal(sparse.observationCount, 1);
  assert.equal(sparse.firstObservationDate, "2020-07-01");
  assert.equal(sparse.lastObservationDate, "2020-07-01");

  const preHolding = result.partial.find((row) => row.ticker === "PRE")!;
  assert.equal(preHolding.firstObservationDate, "2018-01-01");
  assert.equal(preHolding.lastObservationDate, "2019-06-01");
  assert.equal(preHolding.firstTransactionDate, "2020-01-01");

  const staleHeld = result.partial.find((row) => row.ticker === "STL")!;
  assert.equal(staleHeld.lastObservationDate, STALE_DATE);
  assert.equal(staleHeld.isSoldOut, false);

  const soldGap = result.partial.find((row) => row.ticker === "SLD")!;
  assert.equal(soldGap.observationCount, 1);
  assert.equal(soldGap.firstTransactionDate, "2020-01-01"); // the buy, not the sell
  assert.equal(soldGap.isSoldOut, true);
});

test("MKT-018B review ruling (B1b exemption, DB-backed): a sold-out security whose stale history reaches the holding start is reported as covered (isSoldOut resolved from real buy/sell transactions)", async () => {
  const db = await coverageFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-a",
    "portfolio-a",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const allTickers = [
    ...result.zero.map((row) => row.ticker),
    ...result.partial.map((row) => row.ticker),
  ];
  assert.ok(
    !allTickers.includes("EXM"),
    "the sold-out, identically-stale security must be covered (exempt), not partial",
  );
});

test("MKT-018B: loadOwnedPriceHistoryCoverage denies a cross-owner portfolioId", async () => {
  const db = await coverageFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-b",
    "portfolio-a", // belongs to user-a
    FIXTURE_NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test("MKT-018B: loadOwnedPriceHistoryCoverage -- user-b sees the shared security as ZERO despite user-a's own price rows existing (ownership isolation, both directions)", async () => {
  const db = await coverageFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-b",
    "portfolio-b",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // user-b's own row on security-shared makes it non-zero for user-b.
  assert.deepEqual(
    result.zero.map((row) => row.ticker),
    [],
  );
  assert.deepEqual(
    result.partial.map((row) => row.ticker),
    ["SHR"],
  );
});

// ---------------------------------------------------------------------------
// Part 4a-2: review round-2 fix (B3, BLOCKING) -- sold-out resolution is
// split-aware (delegates to `deriveSharesHeldAtDate`, never a parallel
// naive sum), plus cheap pins for the existing fail-closed paths.
// ---------------------------------------------------------------------------

test("MKT-018B review round-2 fix (B3, BLOCKING): the reviewer's exact drill -- buy 100, split 2:1 (-> 200 held), sell 150 (-> 50 STILL held) -- is NOT exempted from trailing staleness (a naive buy-minus-sell sum reads this as -50 and wrongly exempts/drops it)", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-split', 'Split Co', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('ps-split', 'user-a', 'portfolio-a', 'security-split', 'SPL', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    -- Buy 100 on 2020-01-01, split 2:1 on 2020-06-01 (-> 200 held), sell 150
    -- on 2020-07-01 (-> 50 STILL held). A naive buy(100)-sell(150) sum
    -- reads this as -50 (falsely "sold out"); the real split-aware answer
    -- is +50 (still held).
    INSERT INTO transactions (id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at, local_trade_date, quantity_decimal, unit_price_decimal, currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal, source_type, created_by_user_id, calculation_version, created_at)
    VALUES ('tx-split-buy', 'user-a', 'portfolio-a', 'ps-split', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '100', '5', 'AUD', '500', '0', '0', 'manual', 'user-a', 1, '2020-01-01'),
           ('tx-split-ratio', 'user-a', 'portfolio-a', 'ps-split', 'split', 'posted', '2020-06-01T00:00:00Z', '2020-06-01', '2', '1', 'AUD', NULL, '0', '0', 'manual', 'user-a', 1, '2020-06-01'),
           ('tx-split-sell', 'user-a', 'portfolio-a', 'ps-split', 'sell', 'posted', '2020-07-01T00:00:00Z', '2020-07-01', '150', '3', 'AUD', '450', '0', '0', 'manual', 'user-a', 1, '2020-07-01');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
    VALUES ('mapping-split', 'security-split', 'owner-import', 'ASX', 'SPL', '2020-01-01', 'verified');
    -- Reaches the holding start, but the last observation is STALE (far
    -- more than 30 days before FIXTURE_NOW) -- if this security were
    -- (wrongly) treated as sold-out, it would be exempt and read
    -- 'covered'; the CORRECT (still-held) answer is 'partial'.
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-split-1', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-split', 'security-split', 'eod', '2018-12-31T14:00:00.000Z', '2019-01-01', 'Australia/Sydney', 'AUD', '1.00', 'raw', 'observed', '2019-01-01T00:00:00.000Z'),
           ('price-split-2', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-split', 'security-split', 'eod', '2020-01-09T14:00:00.000Z', '${STALE_DATE}', 'Australia/Sydney', 'AUD', '1.10', 'raw', 'observed', '2020-01-10T00:00:00.000Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-a",
    "portfolio-a",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const split = result.partial.find((row) => row.ticker === "SPL");
  assert.ok(
    split,
    "the still-held (post-split) security must be reported PARTIAL (stale, not exempt), never silently dropped as covered/sold-out",
  );
  assert.equal(split!.isSoldOut, false);
  assert.equal(split!.classification, "partial");
});

test("MKT-018B: loadOwnedPriceHistoryCoverage fails closed (503) when held-security count exceeds MAX_HELD -- pinned cheaply via a wrapped count query, no need for 500+ real rows", async () => {
  const db = await coverageFixture();
  const realClient = createSqliteSqlClient(db);
  const client = wrapSqlClient(realClient, {
    get: (sql) =>
      sql.includes("count(*) AS count FROM portfolio_securities")
        ? { count: 999 }
        : undefined,
  });
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-a",
    "portfolio-a",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 503);
  assert.match(result.message, /too many held securities/);
});

test("MKT-018B: loadOwnedPriceHistoryCoverage fails closed (503) when the identities list disagrees with the earlier count (a genuine race) -- pinned cheaply via a wrapped identities query", async () => {
  const db = await coverageFixture();
  const realClient = createSqliteSqlClient(db);
  const client = wrapSqlClient(realClient, {
    all: (sql) => (sql.includes("first_transaction_date") ? [] : undefined),
  });
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-a",
    "portfolio-a",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 503);
  assert.match(result.message, /changed while checking coverage/);
});

test("MKT-018B: loadOwnedPriceHistoryCoverage fails closed (503) when the portfolio's timezone cannot be resolved, never a guessed date", async () => {
  const db = await coverageFixture();
  db.exec(
    `UPDATE portfolios SET timezone = 'Not/AZone' WHERE id = 'portfolio-a';`,
  );
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-a",
    "portfolio-a",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 503);
  assert.match(result.message, /timezone is unavailable/);
});

// ---------------------------------------------------------------------------
// Part 4b: review round-1 fix (B2, BLOCKING) -- chunked IN(...) queries
// merge correctly across a chunk boundary, never silently dropping a
// security in a LATER chunk.
// ---------------------------------------------------------------------------

test("MKT-018B review round-1 fix (B2): coverage for 55 held securities (spanning more than one 50-item query chunk) is correct for securities in BOTH the first and a later chunk", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
  `);
  const securityCount = 55;
  const securityRows: string[] = [];
  const psRows: string[] = [];
  const txRows: string[] = [];
  const mappingRows: string[] = [];
  const priceRows: string[] = [];
  for (let index = 0; index < securityCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const securityId = `chunk-security-${suffix}`;
    const psId = `chunk-ps-${suffix}`;
    const ticker = `T${suffix}`;
    securityRows.push(
      `('${securityId}', 'Chunk Co ${suffix}', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01')`,
    );
    psRows.push(
      `('${psId}', 'user-a', 'portfolio-a', '${securityId}', '${ticker}', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01')`,
    );
    txRows.push(
      `('chunk-tx-${suffix}', 'user-a', 'portfolio-a', '${psId}', 'buy', 'posted', '2020-01-01T00:00:00Z', '2020-01-01', '10', '5', 'AUD', '50', '0', '0', 'manual', 'user-a', 1, '2020-01-01')`,
    );
    // Every 5th security (incl. index 0 in chunk 1 and index 50 in chunk 2)
    // gets TWO observations -- one before the 2020-01-01 holding start, one
    // FRESH -- so it structurally reaches the holding start AND is not
    // trailing-stale, i.e. genuinely 'covered' (excluded from both lists);
    // every other index stays zero-coverage.
    if (index % 5 === 0) {
      mappingRows.push(
        `('chunk-mapping-${suffix}', '${securityId}', 'owner-import', 'ASX', '${ticker}', '2020-01-01', 'verified')`,
      );
      priceRows.push(
        `('chunk-price-${suffix}-early', 'owner-import', 'user', 'user-a', 'user-a', 'chunk-mapping-${suffix}', '${securityId}', 'eod', '2018-12-31T14:00:00.000Z', '2019-01-01', 'Australia/Sydney', 'AUD', '0.90', 'raw', 'observed', '2019-01-01T00:00:00.000Z')`,
        `('chunk-price-${suffix}-fresh', 'owner-import', 'user', 'user-a', 'user-a', 'chunk-mapping-${suffix}', '${securityId}', 'eod', '2026-08-19T14:00:00.000Z', '${FRESH_DATE}', 'Australia/Sydney', 'AUD', '1.00', 'raw', 'observed', '2026-08-20T00:00:00.000Z')`,
      );
    }
  }
  db.exec(
    `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at) VALUES ${securityRows.join(",")};`,
  );
  db.exec(
    `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at) VALUES ${psRows.join(",")};`,
  );
  db.exec(
    `INSERT INTO transactions (id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at, local_trade_date, quantity_decimal, unit_price_decimal, currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal, source_type, created_by_user_id, calculation_version, created_at) VALUES ${txRows.join(",")};`,
  );
  if (mappingRows.length > 0) {
    db.exec(
      `INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status) VALUES ${mappingRows.join(",")};`,
    );
    db.exec(
      `INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at) VALUES ${priceRows.join(",")};`,
    );
  }

  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistoryCoverage(
    client,
    "user-a",
    "portfolio-a",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const zeroTickers = new Set(result.zero.map((row) => row.ticker));
  assert.equal(
    result.zero.length + result.partial.length,
    securityCount - Math.ceil(securityCount / 5),
  );
  // index 0 (first chunk) and index 50 (second chunk, past the 50-item
  // boundary) are both covered (excluded from either list) -- proves the
  // aggregate query's per-chunk results were correctly looked up for
  // securities from BOTH chunks, not just the first.
  assert.ok(!zeroTickers.has("T000"));
  assert.ok(!zeroTickers.has("T050"));
  // index 1 (first chunk) and index 51 (second chunk) never got an
  // observation -- both must still be reported as zero, proving the
  // second chunk's securities are not silently dropped.
  assert.ok(zeroTickers.has("T001"));
  assert.ok(zeroTickers.has("T051"));
});

// ---------------------------------------------------------------------------
// Part 5: the panel renders in the import surface, with the guide-honesty
// sentence, and never fetches without a real portfolio id.
// ---------------------------------------------------------------------------

test("MKT-018B: HistoricalDataPanel renders the 'Download price history' section (as an accessibly-named <section>) with the guide-honesty sentence when given a portfolioId", () => {
  const html = renderComponent(
    "HistoricalDataPanel",
    "../app/components/historical-data-panel.tsx",
    { portfolioId: "portfolio-a" },
  );
  assert.match(html, /Download price history/);
  assert.match(html, /Downloads run in your own browser via the guide/);
  // SSR never runs effects, so the fetch never starts -- an honest
  // "checking" status, never a fabricated result.
  assert.match(html, /Checking price-history coverage/);
  // Review round-1 fix (fold): `aria-labelledby` is inert on a plain <div>
  // -- the coverage panel must be a real sectioning element.
  assert.match(
    html,
    /<section class="historical-data-coverage" aria-labelledby="historical-data-coverage-title">/,
  );
});

test("MKT-018B: ImportReview mounts HistoricalDataPanel with the target portfolio id (source-scan, matches the SharesightSyncPanel wiring precedent)", async () => {
  const source = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<HistoricalDataPanel portfolioId=\{targetPortfolioId\} \/>/,
  );
});

// ---------------------------------------------------------------------------
// Part 6: QA-001A matrix + self-check.
// ---------------------------------------------------------------------------

test("MKT-018B: the QA-001A matrix records the new price-history-coverage route and its owner-scoping", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "price-history-coverage",
    "priceHistoryCoverageAction",
    "loadOwnedPriceHistoryCoverage",
    "tests/mkt-018b.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

test("MKT-018B: every matrix citation naming tests/mkt-018b.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/mkt-018b.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/mkt-018b\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  let titleCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      titleCount += 1;
      const title = quoted.slice(1, -1);
      assert.ok(
        ownSource.includes(title),
        `matrix cites "${title}" in tests/mkt-018b.test.ts, but that title is not a literal substring of the file's source (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount > 0, "expected at least one citation group");
  assert.ok(titleCount > 0, "expected at least one quoted test title");
});
