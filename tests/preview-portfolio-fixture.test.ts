import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PREVIEW_SAMPLE_PORTFOLIO_CSV_URL,
  SUPPORTED_IMPORT_PARSER_VERSION,
  createPreviewPortfolioFixtureFromParseResult,
  loadPreviewPortfolioFixture,
  loadPreviewPortfolioFixtureFromCsv,
} from "../app/preview-portfolio-fixture.ts";
import {
  parseStrictVersionedCsvImport,
  SUPPORTED_IMPORT_HEADER,
} from "../domain/imports/index.ts";

async function loadFixtureCsv(): Promise<string> {
  return await readFile(PREVIEW_SAMPLE_PORTFOLIO_CSV_URL, "utf8");
}

test("builds a deterministic sample portfolio projection from the supplied CSV", async () => {
  const result = await loadPreviewPortfolioFixture();
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  const { fixture } = result;
  assert.equal(fixture.parserVersion, SUPPORTED_IMPORT_PARSER_VERSION);
  assert.equal(fixture.summary.totalRows, 244);
  assert.equal(fixture.summary.blankRows, 64);
  assert.equal(fixture.summary.definitionRows, 65);
  assert.equal(fixture.summary.transactionRows, 115);
  assert.equal(fixture.summary.unsupportedRows, 0);
  assert.equal(fixture.summary.cashTransactionRows, 4);
  assert.equal(fixture.summary.duplicateRows, 0);

  assert.deepEqual(fixture.currencies, ["AUD", "USD"]);
  assert.deepEqual(
    fixture.portfolios.map((portfolio) => portfolio.name),
    ["Aus Sold", "Aus Stocks", "Aus Super", "US watch", "USA"],
  );

  const ausStocks = fixture.portfolios.find(
    (portfolio) => portfolio.name === "Aus Stocks",
  );
  assert.ok(ausStocks);
  assert.deepEqual(
    ausStocks?.openHoldings.map((security) => security.symbol),
    [
      ...(ausStocks?.openHoldings.map((security) => security.symbol) ?? []),
    ].sort(),
  );
  const pls = ausStocks?.openHoldings.find(
    (security) => security.symbol === "PLS.AX",
  );
  assert.ok(pls);
  assert.equal(pls?.quantity, "20000");
  assert.deepEqual(pls?.definitionRowNumbers, [140]);
  assert.deepEqual(pls?.transactionRowNumbers, [141, 142, 143]);
  assert.deepEqual(pls?.sourceRowNumbers, [140, 141, 142, 143]);

  const ausSold = fixture.portfolios.find(
    (portfolio) => portfolio.name === "Aus Sold",
  );
  assert.ok(ausSold);
  assert.equal(ausSold?.openHoldings.length, 0);
  assert.deepEqual(
    ausSold?.closedSecurities.map((security) => security.symbol),
    ["CBA.AX", "GDX.AX", "NCK.AX", "SLF.AX"],
  );

  const usWatch = fixture.portfolios.find(
    (portfolio) => portfolio.name === "US watch",
  );
  assert.ok(usWatch);
  assert.equal(usWatch?.referenceSecurities.length, 1);
  assert.equal(usWatch?.referenceSecurities[0]?.symbol, "EPR");
  assert.equal(usWatch?.referenceSecurities[0]?.quantity, null);
  assert.equal(
    usWatch?.referenceSecurities[0]?.displaySymbol,
    "EPR Properties",
  );

  assert.equal(
    fixture.exclusions.filter((row) => row.reason === "blank").length,
    64,
  );
  assert.equal(
    fixture.exclusions.filter((row) => row.reason === "unsupported").length,
    0,
  );
  assert.equal(
    fixture.issues.filter(
      (issue) => issue.code === "FX_ZERO_TREATED_AS_UNKNOWN",
    ).length,
    33,
  );
  assert.equal(
    fixture.issues.filter((issue) => issue.code === "DISPLAY_SYMBOL_OVERRIDE")
      .length,
    1,
  );
});

test("keeps ordering deterministic and preserves row-level traceability", async () => {
  const first = await loadPreviewPortfolioFixtureFromCsv(
    await loadFixtureCsv(),
  );
  const second = await loadPreviewPortfolioFixtureFromCsv(
    await loadFixtureCsv(),
  );

  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) {
    return;
  }

  const portfolio = first.fixture.portfolios.find(
    (item) => item.name === "USA",
  );
  assert.ok(portfolio);
  assert.deepEqual(
    portfolio?.openHoldings.map((security) => security.symbol),
    ["AAPL", "BMY", "GOOG", "GREK", "IGF", "INDY", "RTN", "TMO", "UTG", "VHT"],
  );
  assert.deepEqual(
    portfolio?.transactions.map((transaction) => transaction.rowNumber),
    [216, 219, 222, 223, 226, 229, 232, 235, 238, 241, 244],
  );
  assert.deepEqual(portfolio?.openHoldings[0]?.sourceRowNumbers, [218, 219]);
});

test("reports malformed and unavailable projection states without fabricating zero values", async () => {
  const malformed = await loadPreviewPortfolioFixtureFromCsv("not,a,valid,csv");
  assert.equal(malformed.ok, false);
  if (malformed.ok) {
    return;
  }
  assert.equal(malformed.code, "CSV_PARSE_FAILED");

  const emptyCsv = `${SUPPORTED_IMPORT_HEADER.join(",")}\n`;
  const emptyProjection = await loadPreviewPortfolioFixtureFromCsv(emptyCsv);
  assert.equal(emptyProjection.ok, false);
  if (emptyProjection.ok) {
    return;
  }
  assert.equal(emptyProjection.code, "PROJECTION_EMPTY");
});

test("stays inside the local fixture boundary and avoids network or D1 access", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network access is not allowed");
  };

  try {
    const result = await loadPreviewPortfolioFixture();
    assert.equal(result.ok, true);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const source = await readFile(
    new URL("../app/preview-portfolio-fixture.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\bDatabaseSync\b|\bcreateSqliteSqlClient\b|\bD1Database\b/,
  );
});

test("parses the supplied CSV through the production parser before projection", async () => {
  const csv = await loadFixtureCsv();
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) {
    return;
  }

  const projection = createPreviewPortfolioFixtureFromParseResult(parseResult);
  assert.equal(projection.ok, true);
  if (!projection.ok) {
    return;
  }

  assert.equal(projection.fixture.fileFingerprint, parseResult.fileFingerprint);
  assert.equal(
    projection.fixture.summary.transactionRows,
    parseResult.summary.transactionRows,
  );
});
