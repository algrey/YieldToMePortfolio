import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessCsvImportUploadStart,
  parseStrictVersionedCsvImport,
  SUPPORTED_IMPORT_HEADER,
} from "../domain/imports/index.ts";

async function loadFixture(): Promise<string> {
  return await readFile(
    new URL("../docs/Example_Portfolio.csv", import.meta.url),
    "utf8",
  );
}

function makeCsv(rows: string[]): string {
  return [SUPPORTED_IMPORT_HEADER.join(","), ...rows].join("\n");
}

test("parses the supplied export into the documented row counts", async () => {
  const result = await parseStrictVersionedCsvImport(await loadFixture());

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepEqual(result.header.normalizedHeaders, SUPPORTED_IMPORT_HEADER);
  assert.equal(result.summary.totalRows, 244);
  assert.equal(result.summary.blankRows, 64);
  assert.equal(result.summary.definitionRows, 65);
  assert.equal(result.summary.transactionRows, 115);
  assert.equal(result.summary.unsupportedRows, 0);
  assert.equal(result.summary.cashTransactionRows, 4);
  assert.equal(result.summary.duplicateRows, 0);

  const cashRows = result.rows.filter(
    (row) => row.normalized.cashEvent !== null,
  );
  assert.equal(cashRows.length, 4);
  assert.deepEqual(cashRows.map((row) => row.normalized.cashEvent).sort(), [
    "cash_deposit",
    "cash_deposit",
    "cash_deposit",
    "cash_withdrawal",
  ]);

  const fxWarnings = result.issues.filter(
    (issue) => issue.code === "FX_ZERO_TREATED_AS_UNKNOWN",
  );
  assert.equal(fxWarnings.length, 33);

  const ixjTrade = result.rows.find(
    (row) => row.normalized.symbol === "IXJ.AX" && row.kind === "transaction",
  );
  assert.ok(ixjTrade);
  assert.equal(ixjTrade?.normalized.sharesOwned, "400");
  assert.equal(ixjTrade?.normalized.costPerShare, "129.81");
  assert.equal(ixjTrade?.normalized.tradeAtUtc, "2025-07-16T04:35:00.000Z");

  const displayOverride = result.rows.find((row) =>
    row.issues.some((issue) => issue.code === "DISPLAY_SYMBOL_OVERRIDE"),
  );
  assert.ok(displayOverride);
});

test("tolerates BOM, CRLF, and padded header whitespace", async () => {
  const fixture = await loadFixture();
  const [header, ...body] = fixture.split("\n");
  const transformed = `\uFEFF  ${header.trimEnd()}  \r\n${body.join("\r\n")}`;

  const result = await parseStrictVersionedCsvImport(transformed);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.summary.totalRows, 244);
  assert.equal(result.summary.definitionRows, 65);
  assert.equal(result.summary.transactionRows, 115);
});

test("handles quoted commas, embedded newlines, and formula-like text without evaluation", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha, Beta",,"ASX","Main","AUD",,,,,,,,,,`,
    `"2","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"line 1\n=HYPERLINK(javascript:alert(1))"`,
  ]);

  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.summary.definitionRows, 1);
  assert.equal(result.summary.transactionRows, 1);
  assert.equal(result.rows[0]?.normalized.name, "Alpha, Beta");
  assert.equal(
    result.rows[1]?.normalized.notes,
    "line 1\n=HYPERLINK(javascript:alert(1))",
  );
});

test("classifies exact cash rows and blocks malformed cash encodings", async () => {
  const exactCash = makeCsv([
    `"1","AUD=CASH",,,"","Aus Super","AUD","150000","1","0","2025-08-01 GMT+1000","09:50:00",,"Buy",,,`,
  ]);
  const exactResult = await parseStrictVersionedCsvImport(exactCash);
  assert.equal(exactResult.ok, true);
  if (!exactResult.ok) {
    return;
  }

  assert.equal(exactResult.rows[0]?.kind, "transaction");
  assert.equal(exactResult.rows[0]?.normalized.cashEvent, "cash_deposit");
  assert.equal(exactResult.rows[0]?.normalized.name, null);
  assert.equal(exactResult.rows[0]?.normalized.exchange, null);

  const malformedCash = makeCsv([
    `"1","AUD=CASH",,,"ASX","Aus Super","AUD","150000","1.01","0","2025-08-01 GMT+1000","09:50:00",,"Buy",,,`,
  ]);
  const malformedResult = await parseStrictVersionedCsvImport(malformedCash);
  assert.equal(malformedResult.ok, true);
  if (!malformedResult.ok) {
    return;
  }

  assert.equal(malformedResult.rows[0]?.kind, "unsupported");
  assert.equal(
    malformedResult.rows[0]?.issues.some(
      (issue) => issue.code === "CASH_ENCODING_INVALID",
    ),
    true,
  );
});

test("flags duplicate normalized rows and preserves row fingerprints", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"first row"`,
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"first row"`,
  ]);

  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.summary.duplicateRows, 1);
  assert.equal(
    result.rows[1]?.issues.some((issue) => issue.code === "DUPLICATE_EXACT"),
    true,
  );
  assert.equal(result.rows[0]?.fingerprint, result.rows[1]?.fingerprint);
});

test("rejects unsupported headers and early free-plan import attempts", async () => {
  const unsupportedHeader = [
    "Id",
    "Symbol",
    "Name",
    "Display Symbol",
    "Exchange",
    "Portfolio",
    "Currency",
    "Shares Owned",
    "Cost Per Share",
    "Commission",
    "Transaction Date",
    "Transaction Time",
    "Purchase Exchange Rate",
    "Type",
    "Accounting",
    "Accounting Execution Ids",
    "Bogus",
  ].join(",");

  const headerResult = await parseStrictVersionedCsvImport(
    `${unsupportedHeader}\n`,
  );
  assert.equal(headerResult.ok, false);
  if (headerResult.ok) {
    return;
  }

  assert.equal(headerResult.code, "HEADER_MISMATCH");
  assert.equal(headerResult.header?.unknownHeaders.includes("Bogus"), true);

  const freePlan = assessCsvImportUploadStart({
    workersPlan: "free",
    contentLength: 100,
    maxBytes: 10 * 1024 * 1024,
    maxRows: 100_000,
  });
  assert.equal(freePlan.ok, false);
  if (freePlan.ok) {
    return;
  }

  assert.equal(freePlan.status, 403);
  assert.equal(freePlan.code, "CSV_IMPORT_DISABLED");

  const tooLarge = assessCsvImportUploadStart({
    workersPlan: "paid",
    contentLength: 10 * 1024 * 1024 + 1,
    maxBytes: 10 * 1024 * 1024,
    maxRows: 100_000,
  });
  assert.equal(tooLarge.ok, false);
  if (tooLarge.ok) {
    return;
  }

  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.code, "CSV_IMPORT_TOO_LARGE");
});

test("enforces row and field bounds with smaller test limits", async () => {
  const rowLimitResult = await parseStrictVersionedCsvImport(
    makeCsv([
      `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,`,
      `"2","ABC","Beta",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,`,
    ]),
    { maxRows: 1 },
  );
  assert.equal(rowLimitResult.ok, false);
  if (rowLimitResult.ok) {
    return;
  }
  assert.equal(rowLimitResult.code, "ROW_LIMIT_EXCEEDED");

  const fieldLimitResult = await parseStrictVersionedCsvImport(
    makeCsv([
      `"1","ABC","${"x".repeat(32)}",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,`,
    ]),
    { maxFieldLength: 8 },
  );
  assert.equal(fieldLimitResult.ok, false);
  if (fieldLimitResult.ok) {
    return;
  }
  assert.equal(fieldLimitResult.code, "FIELD_LIMIT_EXCEEDED");
});
