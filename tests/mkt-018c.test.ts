/**
 * MKT-018C — multi-file price-CSV upload (owner directive: "I have all of
 * my current stocks as CSV files now and would be like to be able to
 * upload them all in one go").
 *
 * Covers: `app/multi-file-price-upload.ts` (`runMultiFilePriceUpload` --
 * sequential ordering, per-file error isolation, owner confirm/skip/cancel
 * decisions, progress callbacks) with fake preview/confirm/decide
 * implementations (no fetch, no DOM `File`, no interactive render harness
 * -- this codebase has neither, see `tests/brk-005b.test.ts`'s header
 * note); a real-pipeline idempotent-re-run proof wired to
 * `previewSinglePriceUpload`/`confirmSinglePriceUpload` (`app/
 * price-upload-service.ts`, same functions `tests/mkt-008.test.ts` already
 * covers -- IMP-010A (2026-08-25) changed their second parameter from raw
 * file bytes to a browser-parsed row payload; this file's own
 * `csvPayloadOf` helper below mirrors `mkt-008.test.ts`'s, and
 * `historical-data-panel.tsx`'s `parseSingleCsvFile` in real use); and
 * `app/components/historical-data-panel.tsx`'s `MultiFileRunStatus`
 * presentational component plus source-text pins proving the single-file
 * `previewSingle`/`confirmSingle` functions still call the SAME shared
 * client parser, the SAME endpoints, and report the SAME result message
 * (UX-unchanged, per MKT-018C's own ruling -- the upload PAYLOAD shape is
 * IMP-010A's whole point, not a regression here).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  runMultiFilePriceUpload,
  type MultiFileConfirmResult,
  type MultiFileDecision,
  type MultiFilePreviewResult,
} from "../app/multi-file-price-upload.ts";
import {
  confirmSinglePriceUpload,
  previewSinglePriceUpload,
  type PriceUploadContext,
} from "../app/price-upload-service.ts";
import { parsePriceCsv } from "../domain/market-data/price-csv.ts";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/sql-client.ts";

const PANEL_PATH = "../app/components/historical-data-panel.tsx";

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

// ---------------------------------------------------------------------------
// (1) runMultiFilePriceUpload -- pure sequencing logic, fake deps
// ---------------------------------------------------------------------------

type FakeFile = { name: string };
type FakePreview = { ticker: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("MKT-018C: mixed run -- one malformed file never blocks its siblings; the failure is named against its own filename", async () => {
  const previewCalls: string[] = [];
  const confirmCalls: string[] = [];
  const outcome = await runMultiFilePriceUpload<FakeFile, FakePreview>(
    [{ name: "a.csv" }, { name: "b.csv" }, { name: "c.csv" }],
    {
      filenameOf: (f) => f.name,
      previewFile: async (f): Promise<MultiFilePreviewResult<FakePreview>> => {
        previewCalls.push(f.name);
        if (f.name === "b.csv") {
          return { ok: false, message: "Row 3: invalid price" };
        }
        return { ok: true, preview: { ticker: f.name } };
      },
      confirmFile: async (f): Promise<MultiFileConfirmResult> => {
        confirmCalls.push(f.name);
        return { ok: true, written: 2, insertedRowCount: 2 };
      },
      decide: async () => "confirm",
    },
  );

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.results.length, 3);
  assert.equal(outcome.results[0]!.filename, "a.csv");
  assert.equal(outcome.results[0]!.status, "committed");
  assert.match(
    outcome.results[0]!.message,
    /Imported 2 price observations \(2 newly created, 0 overlaid existing\)\./,
  );
  assert.equal(outcome.results[1]!.filename, "b.csv");
  assert.equal(outcome.results[1]!.status, "error");
  assert.equal(outcome.results[1]!.message, "Failed: Row 3: invalid price");
  assert.equal(outcome.results[2]!.filename, "c.csv");
  assert.equal(outcome.results[2]!.status, "committed");

  // b.csv's preview failure must never reach confirm.
  assert.deepEqual(previewCalls, ["a.csv", "b.csv", "c.csv"]);
  assert.deepEqual(confirmCalls, ["a.csv", "c.csv"]);
});

test("MKT-018C: files are processed strictly in order, one at a time (sequential, not concurrent) -- progress callback fires per file with the correct index/total/filename", async () => {
  const log: string[] = [];
  const progress: Array<[number, number, string]> = [];
  const outcome = await runMultiFilePriceUpload<FakeFile, FakePreview>(
    [{ name: "a.csv" }, { name: "b.csv" }, { name: "c.csv" }],
    {
      filenameOf: (f) => f.name,
      onProgress: (index, total, filename) => {
        progress.push([index, total, filename]);
      },
      previewFile: async (f) => {
        log.push(`preview:${f.name}`);
        await delay(f.name === "a.csv" ? 8 : 1);
        return { ok: true, preview: { ticker: f.name } };
      },
      confirmFile: async (f) => {
        log.push(`confirm:${f.name}`);
        await delay(1);
        return { ok: true, written: 1, insertedRowCount: 1 };
      },
      decide: async () => "confirm",
    },
  );

  assert.equal(outcome.results.length, 3);
  assert.deepEqual(progress, [
    [1, 3, "a.csv"],
    [2, 3, "b.csv"],
    [3, 3, "c.csv"],
  ]);
  // If files ran concurrently, b/c's faster preview calls would interleave
  // before a's slower preview/confirm pair finishes. Strict order proves
  // each file's full preview+confirm cycle completes before the next
  // file's preview even starts.
  assert.deepEqual(log, [
    "preview:a.csv",
    "confirm:a.csv",
    "preview:b.csv",
    "confirm:b.csv",
    "preview:c.csv",
    "confirm:c.csv",
  ]);
});

test("MKT-018C: the owner can skip a file without importing it -- the run continues to the next file", async () => {
  const confirmCalls: string[] = [];
  const outcome = await runMultiFilePriceUpload<FakeFile, FakePreview>(
    [{ name: "a.csv" }, { name: "b.csv" }],
    {
      filenameOf: (f) => f.name,
      previewFile: async (f) => ({ ok: true, preview: { ticker: f.name } }),
      confirmFile: async (f): Promise<MultiFileConfirmResult> => {
        confirmCalls.push(f.name);
        return { ok: true, written: 1, insertedRowCount: 1 };
      },
      decide: async (_preview, index): Promise<MultiFileDecision> =>
        index === 1 ? "skip" : "confirm",
    },
  );

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0]!.status, "skipped");
  assert.equal(outcome.results[0]!.message, "Skipped — not imported.");
  assert.equal(outcome.results[1]!.status, "committed");
  assert.deepEqual(confirmCalls, ["b.csv"]);
});

test("MKT-018C: the owner can cancel mid-run -- files not yet reached are never touched (no error, no skipped entry, just absent)", async () => {
  const previewCalls: string[] = [];
  const outcome = await runMultiFilePriceUpload<FakeFile, FakePreview>(
    [{ name: "a.csv" }, { name: "b.csv" }, { name: "c.csv" }],
    {
      filenameOf: (f) => f.name,
      previewFile: async (f) => {
        previewCalls.push(f.name);
        return { ok: true, preview: { ticker: f.name } };
      },
      confirmFile: async () => ({ ok: true, written: 1, insertedRowCount: 1 }),
      decide: async (_preview, index): Promise<MultiFileDecision> =>
        index === 2 ? "cancel" : "confirm",
    },
  );

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0]!.filename, "a.csv");
  // c.csv is never reached -- its preview is never even requested.
  assert.deepEqual(previewCalls, ["a.csv", "b.csv"]);
});

test("MKT-018C: a confirm-step failure (not just a preview failure) is also isolated to its own file", async () => {
  const outcome = await runMultiFilePriceUpload<FakeFile, FakePreview>(
    [{ name: "a.csv" }, { name: "b.csv" }],
    {
      filenameOf: (f) => f.name,
      previewFile: async (f) => ({ ok: true, preview: { ticker: f.name } }),
      confirmFile: async (f): Promise<MultiFileConfirmResult> =>
        f.name === "a.csv"
          ? { ok: false, message: "The request timed out." }
          : { ok: true, written: 3, insertedRowCount: 1 },
      decide: async () => "confirm",
    },
  );

  assert.equal(outcome.results[0]!.status, "error");
  assert.equal(outcome.results[0]!.message, "Failed: The request timed out.");
  assert.equal(outcome.results[1]!.status, "committed");
  assert.match(
    outcome.results[1]!.message,
    /Imported 3 price observations \(1 newly created, 2 overlaid existing\)\./,
  );
});

// ---------------------------------------------------------------------------
// (2) Idempotent re-run through the REAL, unmodified single-file pipeline
// ---------------------------------------------------------------------------

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** IMP-010A: mirrors `tests/mkt-008.test.ts`'s helper of the same name --
 * runs the SAME shared parser the browser now runs, shaping its output into
 * the JSON payload a real upload posts. */
function csvPayloadOf(text: string): {
  ticker: string;
  rows: Array<{ marketDate: string; priceDecimal: string }>;
  malformedCount: number;
} {
  const parsed = parsePriceCsv(bytesOf(text));
  if (!parsed.ok) {
    throw new Error(`test fixture CSV failed to parse: ${parsed.message}`);
  }
  return {
    ticker: parsed.ticker,
    rows: parsed.rows.map((row) => ({
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
    })),
    malformedCount: parsed.malformed.length,
  };
}

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

/** One owner with a portfolio and TWO held securities (FMG, BHP) -- enough
 * to exercise a genuine multi-file run against the real pipeline. */
async function twoSecurityFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-fmg', 'Fortescue', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-bhp', 'BHP', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-fmg', 'user-a', 'portfolio-a', 'security-fmg', 'FMG', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('membership-bhp', 'user-a', 'portfolio-a', 'security-bhp', 'BHP', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
  `);
  return db;
}

function context(client: SqlClient, userId: string): PriceUploadContext {
  return { client, userId };
}

const FMG_CSV = "DateTime,FMG\n1998-03-12,0.07852\n1998-03-13,0.08\n";
const BHP_CSV = "DateTime,BHP\n2020-01-02,30.00\n2020-01-03,31.50\n";

test("MKT-018C: a multi-file run through the REAL single-file pipeline is idempotent -- re-running the same file set overlays every row instead of duplicating it", async () => {
  const db = await twoSecurityFixture();
  const client = createSqliteSqlClient(db);
  const ctx = context(client, "user-a");
  const files = [
    { filename: "fmg.csv", payload: csvPayloadOf(FMG_CSV) },
    { filename: "bhp.csv", payload: csvPayloadOf(BHP_CSV) },
  ];

  const deps = {
    filenameOf: (f: (typeof files)[number]) => f.filename,
    previewFile: async (f: (typeof files)[number]) => {
      const result = await previewSinglePriceUpload(ctx, f.payload, {
        exchangeAlias: "ASX",
        currencyCode: "AUD",
      });
      if (!result.ok) return { ok: false as const, message: result.message };
      return { ok: true as const, preview: result.preview };
    },
    confirmFile: async (f: (typeof files)[number]) => {
      const result = await confirmSinglePriceUpload(
        ctx,
        f.payload,
        { exchangeAlias: "ASX", currencyCode: "AUD" },
        { filename: f.filename, sourceLabel: "intelligent-investor" },
        () => "2026-08-24T00:00:00.000Z",
      );
      if (!result.ok) return { ok: false as const, message: result.message };
      return {
        ok: true as const,
        written: result.value.written,
        insertedRowCount: result.value.batch.insertedRowCount,
      };
    },
    decide: async () => "confirm" as const,
  };

  const first = await runMultiFilePriceUpload(files, deps);
  assert.equal(first.cancelled, false);
  assert.equal(first.results.length, 2);
  assert.equal(first.results[0]!.status, "committed");
  assert.match(
    first.results[0]!.message,
    /\(2 newly created, 0 overlaid existing\)/,
  );
  assert.equal(first.results[1]!.status, "committed");
  assert.match(
    first.results[1]!.message,
    /\(2 newly created, 0 overlaid existing\)/,
  );

  const countAfterFirst = db
    .prepare(`SELECT COUNT(*) AS n FROM price_observations`)
    .get() as { n: number };
  assert.equal(countAfterFirst.n, 4);

  // Re-run the SAME two files -- every row should overlay, not duplicate.
  const second = await runMultiFilePriceUpload(files, deps);
  assert.equal(second.results.length, 2);
  assert.equal(second.results[0]!.status, "committed");
  assert.match(
    second.results[0]!.message,
    /\(0 newly created, 2 overlaid existing\)/,
  );
  assert.equal(second.results[1]!.status, "committed");
  assert.match(
    second.results[1]!.message,
    /\(0 newly created, 2 overlaid existing\)/,
  );

  const countAfterSecond = db
    .prepare(`SELECT COUNT(*) AS n FROM price_observations`)
    .get() as { n: number };
  assert.equal(countAfterSecond.n, 4);
});

test("MKT-018C: a malformed file in a real multi-file run never blocks its sibling -- the sibling still commits and is queryable afterward", async () => {
  const db = await twoSecurityFixture();
  const client = createSqliteSqlClient(db);
  const ctx = context(client, "user-a");
  const files = [
    { filename: "fmg.csv", payload: csvPayloadOf(FMG_CSV) },
    // Ticker XYZ is not held by user-a -- previewSinglePriceUpload fails
    // this one honestly (404, names the ticker) without touching fmg/bhp.
    {
      filename: "xyz.csv",
      payload: csvPayloadOf("DateTime,XYZ\n1998-03-12,1.00\n"),
    },
    { filename: "bhp.csv", payload: csvPayloadOf(BHP_CSV) },
  ];

  const deps = {
    filenameOf: (f: (typeof files)[number]) => f.filename,
    previewFile: async (f: (typeof files)[number]) => {
      const result = await previewSinglePriceUpload(ctx, f.payload, {
        exchangeAlias: "ASX",
        currencyCode: "AUD",
      });
      if (!result.ok) return { ok: false as const, message: result.message };
      return { ok: true as const, preview: result.preview };
    },
    confirmFile: async (f: (typeof files)[number]) => {
      const result = await confirmSinglePriceUpload(
        ctx,
        f.payload,
        { exchangeAlias: "ASX", currencyCode: "AUD" },
        { filename: f.filename, sourceLabel: "intelligent-investor" },
        () => "2026-08-24T00:00:00.000Z",
      );
      if (!result.ok) return { ok: false as const, message: result.message };
      return {
        ok: true as const,
        written: result.value.written,
        insertedRowCount: result.value.batch.insertedRowCount,
      };
    },
    decide: async () => "confirm" as const,
  };

  const outcome = await runMultiFilePriceUpload(files, deps);
  assert.equal(outcome.results.length, 3);
  assert.equal(outcome.results[0]!.status, "committed");
  assert.equal(outcome.results[1]!.status, "error");
  assert.match(outcome.results[1]!.message, /XYZ/);
  assert.equal(outcome.results[2]!.status, "committed");

  const rows = (
    db
      .prepare(
        `SELECT security_id, COUNT(*) AS n FROM price_observations GROUP BY security_id ORDER BY security_id`,
      )
      .all() as Array<{ security_id: string; n: number }>
  ).map((row) => ({ security_id: row.security_id, n: row.n }));
  assert.deepEqual(rows, [
    { security_id: "security-bhp", n: 2 },
    { security_id: "security-fmg", n: 2 },
  ]);
});

// ---------------------------------------------------------------------------
// (3) HistoricalDataPanel wiring: `multiple` input, single-file byte-
//     unchanged pins, MultiFileRunStatus rendering
// ---------------------------------------------------------------------------

test("MKT-018C: the price-history CSV file input accepts multiple files", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  const inputBlock = source.match(/Price history CSV\s*<input[\s\S]*?\/>/)?.[0];
  assert.ok(inputBlock, "expected to find the price-history CSV file input");
  assert.match(inputBlock!, /\bmultiple\b/);
  assert.match(inputBlock!, /type="file"/);
});

test("MKT-018C review fold: the Exchange, Currency, and Source label inputs are all disabled while a multi-file run is in progress (editing them mid-run would silently diverge provenance from what's displayed)", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  const exchangeBlock = source.match(/Exchange\s*<input[\s\S]*?\/>/)?.[0];
  const currencyBlock = source.match(/Currency\s*<input[\s\S]*?\/>/)?.[0];
  const sourceLabelBlock = source.match(
    /Source label\s*<input[\s\S]*?\/>/,
  )?.[0];
  assert.ok(exchangeBlock, "expected to find the Exchange input");
  assert.ok(currencyBlock, "expected to find the Currency input");
  assert.ok(sourceLabelBlock, "expected to find the Source label input");
  assert.match(exchangeBlock!, /disabled=\{multiRunning\}/);
  assert.match(currencyBlock!, /disabled=\{multiRunning\}/);
  assert.match(sourceLabelBlock!, /disabled=\{multiRunning\}/);
});

// IMP-010A honest flip (2026-08-25): this test used to assert the
// single-file `previewSingle`/`confirmSingle` bodies built literal
// `FormData` fields (`form.set("file", file)`, ...) -- that assertion is
// now FALSE by design: this task moves the CSV parse into the browser and
// uploads structured row JSON instead of the raw file (see
// `app/price-upload-service.ts`'s IMP-010A header note). What MKT-018C's
// own ruling actually requires stays true and is re-pinned below: the
// single-file path still calls `parseSingleCsvFile` (the SAME shared
// parser the multi-file path also uses -- one implementation, not a fork),
// still posts to the exact same `/preview`/`/confirm` endpoints, and still
// reports the identical success message template.
test("MKT-018C / IMP-010A: single-file behaviour is UX-unchanged -- previewSingle/confirmSingle parse via the shared client parser, post to the same endpoints, and report the same result message as before this task", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");

  const previewSingleBody = source.match(
    /async function previewSingle\(\) \{[\s\S]*?\n {2}\}/,
  )?.[0];
  assert.ok(previewSingleBody, "expected to find previewSingle's body");
  assert.match(previewSingleBody!, /parseSingleCsvFile\(file\)/);
  assert.match(previewSingleBody!, /exchangeAlias,\s*currencyCode/);
  assert.doesNotMatch(previewSingleBody!, /sourceLabel/);
  assert.match(
    previewSingleBody!,
    /"\/api\/market-data\/price-uploads\/preview"/,
  );

  const confirmSingleBody = source.match(
    /async function confirmSingle\(\) \{[\s\S]*?\n {2}\}/,
  )?.[0];
  assert.ok(confirmSingleBody, "expected to find confirmSingle's body");
  assert.match(confirmSingleBody!, /parseSingleCsvFile\(file\)/);
  assert.match(confirmSingleBody!, /sourceLabel,/);
  assert.match(
    confirmSingleBody!,
    /"\/api\/market-data\/price-uploads\/confirm"/,
  );
  // The exact single-file success message template, unchanged.
  assert.match(
    confirmSingleBody!,
    /`Imported \$\{result\.value\.written\} price observation\$\{result\.value\.written === 1 \? "" : "s"\} for \$\{singlePreview\.ticker\} \(\$\{result\.value\.batch\.insertedRowCount\} newly created, \$\{result\.value\.written - result\.value\.batch\.insertedRowCount\} overlaid existing\)\.`/,
  );
});

test("MKT-018C: selecting exactly one file (even from the now-multiple picker) takes the original single-file state path, not the multi-file run", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  const onChangeBlock = source.match(
    /onChange=\{\(event\) => \{\s*const selected = Array\.from[\s\S]*?\n {12}\}\}/,
  )?.[0];
  assert.ok(
    onChangeBlock,
    "expected to find the file input's onChange handler",
  );
  assert.match(onChangeBlock!, /if \(selected\.length > 1\)/);
  assert.match(onChangeBlock!, /void startMultiRun\(selected\)/);
  assert.match(onChangeBlock!, /setFile\(selected\[0\] \?\? null\)/);
});

test("MKT-018C: MultiFileRunStatus renders nothing before a run has started (no running run, no results yet)", () => {
  const html = renderComponent("MultiFileRunStatus", PANEL_PATH, {
    running: false,
    phase: null,
    total: 0,
    index: 0,
    currentFilename: null,
    currentPreview: null,
    pending: false,
    results: [],
    cancelled: false,
    onConfirm: () => {},
    onSkip: () => {},
    onCancel: () => {},
  });
  assert.equal(html.trim(), "");
});

test("MKT-018C: MultiFileRunStatus shows an in-progress checking phase with progress text naming the file and position (non-color status)", () => {
  const html = renderComponent("MultiFileRunStatus", PANEL_PATH, {
    running: true,
    phase: "checking",
    total: 5,
    index: 2,
    currentFilename: "bhp.csv",
    currentPreview: null,
    pending: true,
    results: [],
    cancelled: false,
    onConfirm: () => {},
    onSkip: () => {},
    onCancel: () => {},
  });
  assert.match(html, /Checking file 2 of 5: bhp\.csv/);
  assert.match(html, /role="status"/);
});

test("MKT-018C: MultiFileRunStatus shows the current file's preview with Confirm/Skip/Cancel controls while reviewing", () => {
  const html = renderComponent("MultiFileRunStatus", PANEL_PATH, {
    running: true,
    phase: "reviewing",
    total: 2,
    index: 1,
    currentFilename: "fmg.csv",
    currentPreview: {
      ticker: "FMG",
      exchangeAlias: "ASX",
      currencyCode: "AUD",
      matchedSecurityId: "security-fmg",
      matchedName: "Fortescue",
      rowCount: 2,
      malformedCount: 0,
      dateFrom: "1998-03-12",
      dateTo: "1998-03-13",
      sampleFirst: { marketDate: "1998-03-12", priceDecimal: "0.07852" },
      sampleLast: { marketDate: "1998-03-13", priceDecimal: "0.08" },
    },
    pending: false,
    results: [],
    cancelled: false,
    onConfirm: () => {},
    onSkip: () => {},
    onCancel: () => {},
  });
  assert.match(html, /Reviewing file 1 of 2: fmg\.csv/);
  assert.match(html, /Fortescue/);
  assert.match(html, />Confirm import</);
  assert.match(html, />Skip this file</);
  assert.match(html, />Cancel remaining files</);
});

test("MKT-018C: MultiFileRunStatus lists each finished file's honest outcome (committed/skipped/error) after the run ends, and states cancellation explicitly", () => {
  const finished = renderComponent("MultiFileRunStatus", PANEL_PATH, {
    running: false,
    phase: null,
    total: 3,
    index: 3,
    currentFilename: null,
    currentPreview: null,
    pending: false,
    results: [
      {
        filename: "a.csv",
        status: "committed",
        message:
          "Imported 2 price observations (2 newly created, 0 overlaid existing).",
      },
      {
        filename: "b.csv",
        status: "error",
        message: "Failed: Row 3: invalid price",
      },
      {
        filename: "c.csv",
        status: "skipped",
        message: "Skipped — not imported.",
      },
    ],
    cancelled: false,
    onConfirm: () => {},
    onSkip: () => {},
    onCancel: () => {},
  });
  assert.match(finished, /Finished: 3 of 3 file\(s\) processed\./);
  assert.match(finished, /a\.csv: Imported 2 price observations/);
  assert.match(finished, /b\.csv: Failed: Row 3: invalid price/);
  assert.match(finished, /c\.csv: Skipped — not imported\./);

  const cancelledRun = renderComponent("MultiFileRunStatus", PANEL_PATH, {
    running: false,
    phase: null,
    total: 3,
    index: 1,
    currentFilename: null,
    currentPreview: null,
    pending: false,
    results: [
      {
        filename: "a.csv",
        status: "committed",
        message:
          "Imported 2 price observations (2 newly created, 0 overlaid existing).",
      },
    ],
    cancelled: true,
    onConfirm: () => {},
    onSkip: () => {},
    onCancel: () => {},
  });
  assert.match(cancelledRun, /Cancelled — 1 of 3 file\(s\) processed\./);
});

test("MKT-018C: HistoricalDataPanel still renders the retitled import section and its Preview/Confirm controls unchanged with no file selected", () => {
  const html = renderComponent("HistoricalDataPanel", PANEL_PATH, {
    portfolioId: "portfolio-a",
  });
  assert.match(html, /Import security price history/);
  assert.match(
    html,
    /Exchange, Currency, and Source label settings above and below\s*apply to every file in the run/,
  );
  assert.match(html, />Preview</);
  // No file selected yet -> Preview is disabled, Confirm import isn't shown.
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, />Confirm import</);
});
