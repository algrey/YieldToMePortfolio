import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createD1SqlClient } from "../db/d1-sql-client.ts";
import { createSecurityVerifyPost } from "../app/security-verification-route.ts";
import {
  verifySecurityCandidateWithContext,
  type SecurityVerifyActionOptions,
} from "../app/security-verification-service.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createOwnedSecurityVerificationRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  createDisabledMarketDataProvider,
  type MarketDataProvider,
  type MarketDataResult,
  type ProviderCapabilities,
  type SecurityCandidate,
} from "../domain/market-data/index.ts";
import {
  SUPPORTED_IMPORT_PARSER_VERSION,
  parseStrictVersionedCsvImport,
} from "../domain/imports/index.ts";
import type { ImportReviewPreview } from "../app/import-preview.ts";

const NO_CAPABILITIES: ProviderCapabilities = {
  exchanges: [],
  intervals: [],
  supportsRawPrices: false,
  supportsAdjustedPrices: false,
  supportsFx: false,
  supportsDividends: false,
  supportsSplits: false,
  supportsFundamentals: false,
};

function stubProvider(
  searchSecurities: MarketDataProvider["searchSecurities"],
): MarketDataProvider {
  return {
    capabilities: () => NO_CAPABILITIES,
    searchSecurities,
    getDailyPrices: async () => ({ ok: true, value: [] }),
    getLatestObservation: async () => ({ ok: true, value: null }),
    getFxRates: async () => ({ ok: true, value: [] }),
    getDividendEvents: async () => ({ ok: true, value: [] }),
    getSplitEvents: async () => ({ ok: true, value: [] }),
  };
}

/** Always answers with exactly one candidate matching the request. */
function echoingFixtureProvider(): MarketDataProvider {
  return stubProvider(async (query) => ({
    ok: true,
    value: [
      {
        securityId: null,
        mappingId: null,
        symbol: query.text,
        exchangeId: query.exchangeId ?? null,
        currencyCode: query.currencyCode ?? null,
        name: `${query.text} (fixture)`,
        confidence: "high",
        assetType: "equity",
      },
    ],
  }));
}

function candidatesProvider(
  candidates: SecurityCandidate[],
): MarketDataProvider {
  return stubProvider(async () => ({ ok: true, value: candidates }));
}

function errorProvider(
  result: MarketDataResult<SecurityCandidate[]>,
): MarketDataProvider {
  return stubProvider(async () => result);
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-11', '2026-08-11', 1),
           ('portfolio-a2', 'user-a', 'A2', 'Second', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-11', '2026-08-11', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-11', '2026-08-11', 1);
    -- market_data_providers' 'yahoo-compatible' row is no longer seeded
    -- here: MKT-007's drizzle/0037_steady_signal.sql migration now ships it
    -- as reference data, so the full migration chain applied above already
    -- produced it.
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample.csv', 100, 'file-a', 'parsed',
      '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z', 1);
  `);
  return database;
}

function normalizedRow(
  overrides: Partial<{
    portfolio: string;
    symbol: string;
    exchange: string | null;
    currency: string;
  }> = {},
) {
  return {
    id: "source-2",
    symbol: overrides.symbol ?? "NEW",
    name: "New Co",
    displaySymbol: null,
    exchange: overrides.exchange === undefined ? "ASX" : overrides.exchange,
    portfolio: overrides.portfolio ?? "Main",
    currency: overrides.currency ?? "AUD",
    sharesOwned: "5",
    costPerShare: "10",
    commission: "0",
    transactionDate: "2026-08-01 GMT+1000",
    transactionTime: "10:00:00",
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-08-01T00:00:00.000Z",
    localTradeDate: "2026-08-01",
    cashEvent: null,
  };
}

function stageRow(
  database: DatabaseSync,
  batchId: string,
  rowId: string,
  normalized: ReturnType<typeof normalizedRow>,
): void {
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
       ) VALUES (?, 'user-a', ?, 2, 'transaction', '[]', ?, ?, 'valid',
         NULL, 'staged', '2026-08-11', '2026-08-11', 1)`,
    )
    .run(rowId, batchId, JSON.stringify(normalized), `fingerprint-${rowId}`);
}

// Mirrors the private `loadReview` helper (app/import-actions.ts /
// app/security-verification-service.ts) using only exported repository
// functions, returning the full built review so tests can inspect
// `preview.unresolvedCandidates`/`preview.issues`, not just the version.
async function currentReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows(userId, batchId),
      staging.listIssues(userId, batchId),
      createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
      createOwnedPortfolioRepository(client).list(userId),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
                source_currency_code, security_id
           FROM portfolio_securities WHERE user_id = ?
          ORDER BY source_symbol ASC, id ASC`,
        [userId],
      ),
    ],
  );
  return buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates: candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    })),
  });
}

async function verifyNewSymbol(
  client: SqlClient,
  userId: string,
  batchId: string,
  portfolioId: string,
  candidate: {
    sourceSymbol: string;
    sourceExchangeAlias: string | null;
    sourceCurrencyCode: string;
  },
  options: SecurityVerifyActionOptions,
) {
  const review = await currentReview(client, userId, batchId);
  return verifySecurityCandidateWithContext(
    { client, userId },
    batchId,
    {
      portfolioId,
      sourceSymbol: candidate.sourceSymbol,
      sourceExchangeAlias: candidate.sourceExchangeAlias,
      sourceCurrencyCode: candidate.sourceCurrencyCode,
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
    options,
  );
}

test("verify success publishes a canonical security with provenance and links the candidate", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);
  const provider = candidatesProvider([
    {
      securityId: null,
      mappingId: null,
      symbol: "NEW",
      exchangeId: "ASX",
      currencyCode: "AUD",
      name: "New Co Limited",
      confidence: "high",
      assetType: "equity",
    },
  ]);

  const result = await verifyNewSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    { provider, now: () => "2026-08-11T01:00:00Z" },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.review.preview.ready, true);

  const security = database
    .prepare(
      "SELECT asset_type, primary_currency_code, canonical_name, status FROM securities",
    )
    .get() as {
    asset_type: string;
    primary_currency_code: string;
    canonical_name: string;
    status: string;
  };
  assert.equal(security.asset_type, "equity");
  assert.equal(security.primary_currency_code, "AUD");
  assert.equal(security.canonical_name, "New Co Limited");
  assert.equal(security.status, "active");

  const identifier = database
    .prepare("SELECT scheme, value FROM security_identifiers")
    .get() as { scheme: string; value: string };
  assert.equal(identifier.scheme, "ticker");
  assert.equal(identifier.value, "NEW");

  const mapping = database
    .prepare(
      `SELECT provider_id, provider_exchange, provider_symbol, status,
              verified_by_user_id, verified_at
         FROM security_provider_mappings`,
    )
    .get() as {
    provider_id: string;
    provider_exchange: string;
    provider_symbol: string;
    status: string;
    verified_by_user_id: string;
    verified_at: string;
  };
  assert.equal(mapping.provider_id, "yahoo-compatible");
  assert.equal(mapping.provider_exchange, "ASX");
  assert.equal(mapping.provider_symbol, "NEW");
  assert.equal(mapping.status, "verified");
  assert.equal(mapping.verified_by_user_id, "user-a");
  assert.equal(mapping.verified_at, "2026-08-11T01:00:00Z");

  const securityId = (
    database.prepare("SELECT id FROM securities").get() as { id: string }
  ).id;
  const membership = database
    .prepare(
      "SELECT security_id, status FROM portfolio_securities WHERE portfolio_id = 'portfolio-a'",
    )
    .get() as { security_id: string; status: string };
  assert.equal(membership.status, "held");
  assert.equal(membership.security_id, securityId);
});

test("dedupe-link: verifying a second candidate for the same provider identity links the existing canonical security", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-existing', 'Existing Co', 'equity', 'AUD', 'active', '2026-08-11', '2026-08-11');
    INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, source)
    VALUES ('identifier-existing', 'security-existing', 'ticker', 'DUP', '2026-08-11', 'yahoo-compatible');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
    VALUES ('mapping-existing', 'security-existing', 'yahoo-compatible', 'ASX', 'DUP', '2026-08-10', 'verified', 'user-a', '2026-08-10T00:00:00Z');
  `);
  stageRow(
    database,
    "batch-a",
    "row-1",
    normalizedRow({ portfolio: "Second", symbol: "DUP" }),
  );
  const client = createSqliteSqlClient(database);
  // Every staged row's `target_portfolio_id` starts NULL and falls back to
  // the batch's single upload-time target (see the acceptance-drill test's
  // comment) unless a portfolio mapping decision routes this row's source
  // portfolio name to a different owned portfolio -- exactly like the
  // resolution workflow IMP-004A's UI already offers. Routing this row to
  // "Second" (portfolio-a2) lets this test verify the same provider
  // identity from a different portfolio than the one seeded above.
  await createOwnedImportMappingDecisionRepository(client).save("user-a", {
    batchId: "batch-a",
    kind: "portfolio",
    sourceKey: "Second",
    normalizedSourceValue: "Second",
    targetId: "portfolio-a2",
    targetValue: null,
    scope: "batch",
    confidence: "user",
    source: "user",
  });
  const provider = candidatesProvider([
    {
      securityId: null,
      mappingId: null,
      symbol: "DUP",
      exchangeId: "ASX",
      currencyCode: "AUD",
      name: "Existing Co",
      confidence: "high",
      assetType: "equity",
    },
  ]);

  const result = await verifyNewSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a2",
    {
      sourceSymbol: "DUP",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    { provider },
  );
  assert.equal(result.ok, true);

  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1, "no new canonical security was created");
  const mappingCount = (
    database
      .prepare("SELECT COUNT(*) AS n FROM security_provider_mappings")
      .get() as { n: number }
  ).n;
  assert.equal(mappingCount, 1, "no duplicate provider mapping was created");

  const membership = database
    .prepare(
      "SELECT security_id FROM portfolio_securities WHERE portfolio_id = 'portfolio-a2'",
    )
    .get() as { security_id: string };
  assert.equal(membership.security_id, "security-existing");
});

test("sequential verify requests for the same brand-new identity do not create duplicate canonical rows", async () => {
  // node:sqlite's synchronous engine means two `client.batch()` calls
  // cannot truly interleave mid-transaction, but issuing both
  // `publishAndLink` calls before either is awaited still exercises the
  // repository's re-read-after-attempt path exactly as a second request
  // arriving moments after the first would: the second call's own initial
  // `existingMapping` read happens only once the first call's atomic batch
  // has already committed, so it must find and link to the winner instead
  // of attempting (and losing) a second publish.
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const repository = createOwnedSecurityVerificationRepository(client);
  const identity = {
    providerSymbol: "RACE",
    providerExchange: "ASX",
    currencyCode: "AUD",
    name: "Race Co",
    assetType: "equity" as const,
  };

  const [first, second] = await Promise.all([
    repository.publishAndLink("user-a", "yahoo-compatible", identity, {
      portfolioId: "portfolio-a",
      sourceSymbol: "RACE",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    }),
    repository.publishAndLink("user-a", "yahoo-compatible", identity, {
      portfolioId: "portfolio-a2",
      sourceSymbol: "RACE",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.securityId, second.securityId);

  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1);
  const mappingCount = (
    database
      .prepare("SELECT COUNT(*) AS n FROM security_provider_mappings")
      .get() as { n: number }
  ).n;
  assert.equal(mappingCount, 1);
});

test("provider mismatch, ambiguity, and not-found are explicit failures that leave the candidate unresolved and private", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);

  const notFound = await verifyNewSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    { provider: candidatesProvider([]) },
  );
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.equal(notFound.status, 502);

  const mismatched = await verifyNewSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    {
      provider: candidatesProvider([
        {
          securityId: null,
          mappingId: null,
          symbol: "NEW",
          exchangeId: "ASX",
          currencyCode: "USD",
          name: "Wrong Currency Co",
          confidence: "medium",
          assetType: "equity",
        },
      ]),
    },
  );
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.status, 502);

  const ambiguous = await verifyNewSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    {
      provider: candidatesProvider([
        {
          securityId: null,
          mappingId: null,
          symbol: "NEW",
          exchangeId: "ASX",
          currencyCode: "AUD",
          name: "New Co A",
          confidence: "medium",
          assetType: "equity",
        },
        {
          securityId: null,
          mappingId: null,
          symbol: "NEW",
          exchangeId: "ASX",
          currencyCode: "AUD",
          name: "New Co B",
          confidence: "medium",
          assetType: "equity",
        },
      ]),
    },
  );
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.status, 502);

  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
        n: number;
      }
    ).n,
    0,
  );
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS n FROM portfolio_securities")
        .get() as { n: number }
    ).n,
    0,
  );
});

test("provider errors (rate limit, timeout) map to explicit failures", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);
  const rateLimited = await verifyNewSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    {
      provider: errorProvider({
        ok: false,
        error: {
          kind: "rate_limit",
          message: "too many requests",
          retryable: true,
        },
      }),
    },
  );
  assert.equal(rateLimited.ok, false);
  if (!rateLimited.ok) assert.equal(rateLimited.status, 502);
});

test("provider disabled (no enabled market_data_providers row) is an explicit failure and the candidate stays unresolved", async () => {
  const database = await migratedDatabase();
  database.exec("UPDATE market_data_providers SET status = 'disabled'");
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);
  const result = await verifyNewSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    { provider: createDisabledMarketDataProvider() },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 503);
    assert.match(result.message, /not available/i);
  }
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS n FROM portfolio_securities")
        .get() as { n: number }
    ).n,
    0,
  );
});

test("verify action rejects malformed input, a stale version, and another owner's batch", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);
  const context = { client, userId: "user-a" };
  const provider = echoingFixtureProvider();

  assert.deepEqual(
    await verifySecurityCandidateWithContext(context, "batch-a", null, {
      provider,
    }),
    {
      ok: false,
      status: 400,
      message: "Complete the labelled verification fields.",
    },
  );

  const review = await currentReview(client, "user-a", "batch-a");
  const stale = await verifySecurityCandidateWithContext(
    context,
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      expectedVersion: 99,
      expectedPreviewVersion: review.previewVersion,
    },
    { provider },
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.status, 409);
    assert.match(stale.message, /stale/i);
  }

  const otherOwner = await verifySecurityCandidateWithContext(
    { client, userId: "user-b" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "NEW",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
    { provider },
  );
  assert.deepEqual(otherOwner, {
    ok: false,
    status: 404,
    message: "Import batch not found.",
  });

  // A candidate that is not a currently unresolved import candidate (wrong
  // symbol) must also be rejected -- the server re-derives eligibility from
  // its own database state, never trusting the client's fields alone.
  const wrongCandidate = await verifySecurityCandidateWithContext(
    context,
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "NOT-STAGED",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
    { provider },
  );
  assert.equal(wrongCandidate.ok, false);
  if (!wrongCandidate.ok) assert.equal(wrongCandidate.status, 409);
});

test("verify route enforces CSRF before its authenticated action", async () => {
  let calls = 0;
  const rejectedPost = createSecurityVerifyPost(async () => {
    calls += 1;
    throw new Error("cross-site request reached the action");
  });
  const rejected = await rejectedPost(
    new Request(
      "https://yield.example/api/import/preview/batch-a/securities/verify",
      {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: "{}",
      },
    ),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);

  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");
  const provider = echoingFixtureProvider();
  const authenticatedPost = createSecurityVerifyPost((batchId, value) =>
    verifySecurityCandidateWithContext(
      { client, userId: "user-a" },
      batchId,
      value,
      { provider },
    ),
  );
  const response = await authenticatedPost(
    new Request(
      "https://yield.example/api/import/preview/batch-a/securities/verify",
      {
        method: "POST",
        headers: {
          origin: "https://yield.example",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          portfolioId: "portfolio-a",
          sourceSymbol: "NEW",
          sourceExchangeAlias: "ASX",
          sourceCurrencyCode: "AUD",
          expectedVersion: review.batch.version,
          expectedPreviewVersion: review.previewVersion,
        }),
      },
    ),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("acceptance drill: docs/Example_Portfolio.csv reaches committed holdings on an empty account via verify-driven resolution", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  // An "empty account": only the owner's single target portfolio and the
  // enabled provider row exist. No securities, identifiers, provider
  // mappings, or portfolio_securities rows are seeded: every security in
  // the file is brand new. The source file's own "Portfolio" column names
  // five distinct portfolios, but every staged row's `target_portfolio_id`
  // starts NULL and (per `domain/imports/review.ts`'s
  // `row.targetPortfolioId ?? evidence.batch.targetPortfolioId`) falls back
  // to this single upload-time target unless the owner separately saves a
  // per-source-name portfolio mapping decision -- that per-source-portfolio
  // routing is IMP-004A/IMP-002B territory, not this task's; verifying that
  // brand-new symbols resolve and commit end-to-end does not depend on it.
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('p-super', 'user-a', 'SUP', 'Aus Super', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-11', '2026-08-11', 1);
    -- market_data_providers' 'yahoo-compatible' row is no longer seeded
    -- here: MKT-007's drizzle/0037_steady_signal.sql migration now ships it
    -- as reference data, so the full migration chain applied above already
    -- produced it.
  `);
  const client = createSqliteSqlClient(database);
  const context = { client, userId: "user-a" };
  const provider = echoingFixtureProvider();

  const csv = await readFile(
    new URL("../docs/Example_Portfolio.csv", import.meta.url),
    "utf8",
  );
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) return;
  assert.ok(parseResult.rows.length > 200);

  const staging = createOwnedImportStagingRepository(
    client,
    () => "2026-08-11T00:00:00Z",
  );
  const started = await staging.startUpload("user-a", {
    targetPortfolioId: "p-super",
    parserFormat: "strict-versioned-csv",
    parserVersion: parseResult.parserVersion,
    filename: "Example_Portfolio.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const batchId = started.batch.id;
  const recorded = await staging.recordParseResult("user-a", batchId, {
    expectedVersion: started.batch.version,
    parseResult,
  });
  assert.equal(recorded.ok, true);

  // Iteratively resolve every blocking issue -- brand-new securities via
  // verify, FX direction via a mapping decision -- until the preview is
  // ready, bounded so a genuine regression fails loudly instead of hanging.
  let review = await currentReview(client, "user-a", batchId);
  for (let round = 0; round < 250 && !review.preview.ready; round += 1) {
    const blocking = review.preview.issues.filter(
      (issue) => issue.severity === "error",
    );
    const securityIssue = blocking.find(
      (issue) => issue.code === "SECURITY_MAPPING_REQUIRED",
    );
    if (securityIssue) {
      const [portfolioId] = (securityIssue.sourceKey ?? "").split("|");
      const candidate = review.preview.unresolvedCandidates.find(
        (entry) =>
          entry.portfolioId === portfolioId &&
          entry.securityId === null &&
          [
            entry.portfolioId,
            entry.sourceSymbol.trim().toLowerCase(),
            (entry.sourceExchangeAlias ?? "").trim().toLowerCase(),
            entry.sourceCurrencyCode.trim().toLowerCase(),
          ].join("|") === securityIssue.sourceKey,
      );
      assert.ok(
        candidate,
        `expected an unresolved candidate for ${securityIssue.sourceKey}`,
      );
      const result = await verifySecurityCandidateWithContext(
        context,
        batchId,
        {
          portfolioId: candidate!.portfolioId,
          sourceSymbol: candidate!.sourceSymbol,
          sourceExchangeAlias: candidate!.sourceExchangeAlias,
          sourceCurrencyCode: candidate!.sourceCurrencyCode,
          expectedVersion: review.batch.version,
          expectedPreviewVersion: review.previewVersion,
        },
        { provider },
      );
      assert.equal(
        result.ok,
        true,
        !result.ok ? result.message : "verify failed",
      );
    } else {
      const fxIssue = blocking.find(
        (issue) => issue.code === "FX_DIRECTION_REQUIRED",
      );
      if (fxIssue) {
        await createOwnedImportMappingDecisionRepository(client).save(
          "user-a",
          {
            batchId,
            kind: "fx",
            sourceKey: fxIssue.sourceKey ?? "",
            normalizedSourceValue: fxIssue.sourceKey ?? "",
            targetId: null,
            targetValue: "native_to_home",
            scope: "batch",
            confidence: "user",
            source: "user",
          },
        );
      } else {
        assert.fail(
          `unexpected blocking issue(s): ${blocking.map((issue) => issue.code).join(", ")}`,
        );
      }
    }
    review = await currentReview(client, "user-a", batchId);
  }
  assert.equal(review.preview.ready, true);

  const ready = await markImportReadyWithContext(context, batchId, {
    expectedVersion: review.batch.version,
    expectedPreviewVersion: review.previewVersion,
  });
  assert.equal(ready.ok, true);
  if (!ready.ok) return;

  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: ready.review.batch.version,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "imp-004b-commit",
    confirmation: true,
    requestId: "imp-004b-commit-request",
  };
  let commitResult = await commitRepo.commit("user-a", batchId, commitInput);
  for (
    let attempt = 0;
    // Commits chunk at most 2 rows per invocation (import-commit.ts's
    // `MAX_CHUNK_SIZE`); ~115 transaction rows need dozens of resumptions.
    attempt < 200 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepo.commit("user-a", batchId, commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (!commitResult.ok) return;
  assert.equal(commitResult.status, "committed");
  assert.ok(commitResult.committedRows > 0);

  const heldCount = (
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM portfolio_securities WHERE user_id = 'user-a' AND status = 'held'",
      )
      .get() as { n: number }
  ).n;
  assert.ok(heldCount > 0, "expected committed holdings on the empty account");
  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    securityCount,
    heldCount,
    "every held security was published exactly once by the verify flow",
  );
});

// IMP-004B D1 drill: `createOwnedSecurityVerificationRepository`'s
// `publishAndLink` folds the owner's `portfolio_securities` link into the
// SAME atomic `batch()` call as the canonical `securities`/
// `security_identifiers`/`security_provider_mappings` publish (see the
// review fix on `db/repositories/security-verification.ts` and
// `docs/DATA_MODEL.md`'s securities-master write-path section). The
// `node:sqlite` test client tolerates SQL transaction control D1 rejects
// outright and cannot exercise D1's real `batch()` atomicity, so this drill
// runs the same repository against a real Miniflare/workerd D1 database,
// mirroring `tests/qa-003.test.ts`'s established pattern.
//
// Requires a loopback Miniflare binding, which some sandboxes block; run
// with IMP004B_D1_DRILL=1 where a listening socket is permitted.

function drizzleMigrationStatements(migrationSql: string): string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function freshRebuildSourceTable(statement: string): string | null {
  const match = statement.match(
    /\bINSERT INTO `__new_[A-Za-z0-9_]+`[\s\S]+ FROM `([A-Za-z0-9_]+)`;?\s*$/,
  );
  return match?.[1] ?? null;
}

async function applyDrizzleMigrationToD1(
  database: D1Database,
  migrationSql: string,
): Promise<void> {
  for (const statement of drizzleMigrationStatements(migrationSql)) {
    const rebuildSource = freshRebuildSourceTable(statement);
    if (rebuildSource) {
      const source = await database
        .prepare(`SELECT COUNT(*) AS count FROM "${rebuildSource}"`)
        .first<{ count: number }>();
      if (Number(source?.count ?? -1) !== 0) {
        throw new Error(`d1_drill_rebuild_source_not_empty:${rebuildSource}`);
      }
      continue;
    }
    await database.prepare(statement).run();
  }
}

async function migrateD1(database: D1Database): Promise<void> {
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await applyDrizzleMigrationToD1(
      database,
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
}

async function seedD1Fixture(database: D1Database): Promise<void> {
  const statements = [
    `INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
     VALUES ('AUD', 36, 'Australian dollar', 2, 1)`,
    `INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
     VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-12', '2026-08-12', 1)`,
    `INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
     VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-12', '2026-08-12', 1)`,
    `INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
     VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-12', '2026-08-12', 1)`,
    // market_data_providers' 'yahoo-compatible' row is no longer seeded
    // here: MKT-007's drizzle/0037_steady_signal.sql migration now ships it
    // as reference data, so migrateD1's full migration chain already
    // produced it.
  ];
  for (const sql of statements) {
    await database.prepare(sql).run();
  }
}

test("IMP-004B D1 drill: verify-success publish writes the canonical security, identifiers, a validity-dated verified mapping, and links the candidate -- all in one batch against real D1", async (context) => {
  if (process.env.IMP004B_D1_DRILL !== "1") {
    context.skip(
      "set IMP004B_D1_DRILL=1 where loopback Miniflare is permitted",
    );
    return;
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "imp-004b-drill-success" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    await seedD1Fixture(d1);
    const client: SqlClient = createD1SqlClient(d1);
    const repository = createOwnedSecurityVerificationRepository(
      client,
      () => "2026-08-12T01:00:00Z",
    );

    const result = await repository.publishAndLink(
      "user-a",
      "yahoo-compatible",
      {
        providerSymbol: "NEWD1",
        providerExchange: "ASX",
        currencyCode: "AUD",
        name: "New D1 Co",
        assetType: "equity",
      },
      {
        portfolioId: "portfolio-a",
        sourceSymbol: "NEWD1",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.created, true);

    const security = await d1
      .prepare(
        "SELECT asset_type, exchange_id, primary_currency_code, canonical_name, status FROM securities WHERE id = ?",
      )
      .bind(result.securityId)
      .first<{
        asset_type: string;
        exchange_id: string | null;
        primary_currency_code: string;
        canonical_name: string;
        status: string;
      }>();
    assert.ok(security);
    assert.equal(security!.asset_type, "equity");
    assert.equal(security!.exchange_id, null);
    assert.equal(security!.primary_currency_code, "AUD");
    assert.equal(security!.canonical_name, "New D1 Co");
    assert.equal(security!.status, "active");

    const identifier = await d1
      .prepare(
        "SELECT scheme, value FROM security_identifiers WHERE security_id = ?",
      )
      .bind(result.securityId)
      .first<{ scheme: string; value: string }>();
    assert.ok(identifier);
    assert.equal(identifier!.scheme, "ticker");
    assert.equal(identifier!.value, "NEWD1");

    const mapping = await d1
      .prepare(
        `SELECT provider_id, provider_exchange, provider_symbol, status, valid_to, verified_by_user_id, verified_at
           FROM security_provider_mappings WHERE security_id = ?`,
      )
      .bind(result.securityId)
      .first<{
        provider_id: string;
        provider_exchange: string;
        provider_symbol: string;
        status: string;
        valid_to: string | null;
        verified_by_user_id: string;
        verified_at: string;
      }>();
    assert.ok(mapping);
    assert.equal(mapping!.provider_id, "yahoo-compatible");
    assert.equal(mapping!.provider_exchange, "ASX");
    assert.equal(mapping!.provider_symbol, "NEWD1");
    assert.equal(mapping!.status, "verified");
    assert.equal(mapping!.valid_to, null);
    assert.equal(mapping!.verified_by_user_id, "user-a");
    assert.equal(mapping!.verified_at, "2026-08-12T01:00:00Z");

    const membership = await d1
      .prepare(
        "SELECT security_id, status FROM portfolio_securities WHERE portfolio_id = 'portfolio-a'",
      )
      .first<{ security_id: string; status: string }>();
    assert.ok(membership);
    assert.equal(membership!.status, "held");
    assert.equal(membership!.security_id, result.securityId);
  } finally {
    await miniflare.dispose();
  }
});

test("IMP-004B D1 drill: dedupe-link -- verifying a second candidate for the same provider identity links the existing canonical security against real D1", async (context) => {
  if (process.env.IMP004B_D1_DRILL !== "1") {
    context.skip(
      "set IMP004B_D1_DRILL=1 where loopback Miniflare is permitted",
    );
    return;
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "imp-004b-drill-dedupe" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    await seedD1Fixture(d1);
    await d1
      .prepare(
        `INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
         VALUES ('portfolio-a2', 'user-a', 'A2', 'Second', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-12', '2026-08-12', 1)`,
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
         VALUES ('security-existing', 'Existing D1 Co', 'equity', 'AUD', 'active', '2026-08-11', '2026-08-11')`,
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, source)
         VALUES ('identifier-existing', 'security-existing', 'ticker', 'DUPD1', '2026-08-11', 'yahoo-compatible')`,
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
         VALUES ('mapping-existing', 'security-existing', 'yahoo-compatible', 'ASX', 'DUPD1', '2026-08-10', 'verified', 'user-a', '2026-08-10T00:00:00Z')`,
      )
      .run();

    const client: SqlClient = createD1SqlClient(d1);
    const repository = createOwnedSecurityVerificationRepository(
      client,
      () => "2026-08-12T01:00:00Z",
    );

    const result = await repository.publishAndLink(
      "user-a",
      "yahoo-compatible",
      {
        providerSymbol: "DUPD1",
        providerExchange: "ASX",
        currencyCode: "AUD",
        name: "Existing D1 Co",
        assetType: "equity",
      },
      {
        portfolioId: "portfolio-a2",
        sourceSymbol: "DUPD1",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // `created` reflects whether a new `portfolio_securities` LINK row was
    // inserted, not whether the canonical security is new -- this candidate
    // has never been staged before, so a new link row is created even
    // though it dedupes onto the pre-existing canonical security.
    assert.equal(result.created, true);
    assert.equal(result.securityId, "security-existing");

    const securityCount = await d1
      .prepare("SELECT COUNT(*) AS n FROM securities")
      .first<{ n: number }>();
    assert.equal(
      Number(securityCount?.n),
      1,
      "no new canonical security was created",
    );
    const mappingCount = await d1
      .prepare("SELECT COUNT(*) AS n FROM security_provider_mappings")
      .first<{ n: number }>();
    assert.equal(
      Number(mappingCount?.n),
      1,
      "no duplicate provider mapping was created",
    );

    const membership = await d1
      .prepare(
        "SELECT security_id FROM portfolio_securities WHERE portfolio_id = 'portfolio-a2'",
      )
      .first<{ security_id: string }>();
    assert.equal(membership?.security_id, "security-existing");
  } finally {
    await miniflare.dispose();
  }
});

test("IMP-004B D1 drill: rollback-on-duplicate-mapping -- a mid-batch security_provider_mappings_provider_symbol_from_unique collision rolls back the whole publish (no orphan canonical rows), and the re-read/dedupe path then links a fresh request correctly against real D1", async (context) => {
  if (process.env.IMP004B_D1_DRILL !== "1") {
    context.skip(
      "set IMP004B_D1_DRILL=1 where loopback Miniflare is permitted",
    );
    return;
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "imp-004b-drill-rollback" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    await seedD1Fixture(d1);
    const baseClient: SqlClient = createD1SqlClient(d1);

    // The repository's own `WHERE NOT EXISTS (SELECT 1 FROM
    // security_provider_mappings WHERE ...)` guard is race-safe against any
    // row that is already committed by the time it evaluates: it simply
    // no-ops. A genuine `security_provider_mappings_provider_symbol_from_unique`
    // THROW therefore can only be produced deterministically (from a single
    // sequential test, without real concurrent requests racing workerd) by
    // colliding within the SAME `batch()` call -- mirroring
    // `tests/qa-003.test.ts`'s own "mid-batch statement failure" technique
    // of appending one extra, guaranteed-to-fail statement to the exact
    // batch call under test. Here the injected statement unconditionally
    // (no guard) inserts a second `security_provider_mappings` row for the
    // identical (provider_id, provider_exchange, provider_symbol,
    // valid_from) that the repository's own guarded insert (the third
    // statement in its batch) just placed moments earlier in the SAME
    // transaction, so the unique index fires against a row this very call
    // wrote, not a foreign one.
    const injectingClient: SqlClient = {
      ...baseClient,
      async batch(statements) {
        const isCreateBatch = statements.some((statement) =>
          statement.sql.includes("INSERT INTO securities"),
        );
        if (!isCreateBatch) return baseClient.batch(statements);
        return baseClient.batch([
          ...statements,
          {
            sql: `INSERT INTO security_provider_mappings (
                    id, security_id, provider_id, provider_exchange, provider_symbol,
                    valid_from, valid_to, status, verified_by_user_id, verified_at
                  ) VALUES ('mid-batch-injected-duplicate', 'security-a', 'yahoo-compatible', 'ASX', 'RACEDUP', ?, NULL, 'verified', 'user-a', ?)`,
            params: ["2026-08-12", "2026-08-12T01:00:00Z"],
          },
        ]);
      },
    };

    // The injected statement's own FK on `security_id` requires a real
    // `securities` row; seed one unrelated to this identity so only the
    // targeted unique index is what fails.
    await d1
      .prepare(
        `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
         VALUES ('security-a', 'Unrelated Co', 'equity', 'AUD', 'active', '2026-08-12', '2026-08-12')`,
      )
      .run();

    const repository = createOwnedSecurityVerificationRepository(
      injectingClient,
      () => "2026-08-12T01:00:00Z",
    );
    const result = await repository.publishAndLink(
      "user-a",
      "yahoo-compatible",
      {
        providerSymbol: "RACEDUP",
        providerExchange: "ASX",
        currencyCode: "AUD",
        name: "Race Dup Co",
        assetType: "equity",
      },
      {
        portfolioId: "portfolio-a",
        sourceSymbol: "RACEDUP",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
    );
    assert.equal(result.ok, false);

    const orphanSecurities = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM securities WHERE canonical_name = 'Race Dup Co'",
      )
      .first<{ n: number }>();
    assert.equal(
      Number(orphanSecurities?.n),
      0,
      "no orphan securities row survives the rollback",
    );
    const orphanIdentifiers = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM security_identifiers WHERE value = 'RACEDUP'",
      )
      .first<{ n: number }>();
    assert.equal(
      Number(orphanIdentifiers?.n),
      0,
      "no orphan security_identifiers row survives the rollback",
    );
    const survivingMappings = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM security_provider_mappings WHERE provider_symbol = 'RACEDUP'",
      )
      .first<{ n: number }>();
    assert.equal(
      Number(survivingMappings?.n),
      0,
      "the guarded mapping insert rolled back too -- nothing published even once",
    );
    const orphanLinks = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM portfolio_securities WHERE source_symbol = 'RACEDUP'",
      )
      .first<{ n: number }>();
    assert.equal(
      Number(orphanLinks?.n),
      0,
      "no orphan portfolio_securities link survives the rollback",
    );

    // Now exercise the other half of the same race documented on
    // `publishAndLink`: a concurrent writer's publish actually commits
    // first. Seed a real, separately-committed competing security +
    // mapping for a fresh identity, then confirm an ordinary (uninjected)
    // request finds it via the dedupe path and links to it instead of
    // duplicating it.
    await d1
      .prepare(
        `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
         VALUES ('security-race-winner', 'Race Winner Co', 'equity', 'AUD', 'active', '2026-08-12', '2026-08-12')`,
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, source)
         VALUES ('identifier-race-winner', 'security-race-winner', 'ticker', 'RACEWIN', '2026-08-12', 'yahoo-compatible')`,
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
         VALUES ('mapping-race-winner', 'security-race-winner', 'yahoo-compatible', 'ASX', 'RACEWIN', '2026-08-11', 'verified', 'user-a', '2026-08-11T00:00:00Z')`,
      )
      .run();

    const repositoryClean = createOwnedSecurityVerificationRepository(
      baseClient,
      () => "2026-08-12T02:00:00Z",
    );
    const winnerResult = await repositoryClean.publishAndLink(
      "user-a",
      "yahoo-compatible",
      {
        providerSymbol: "RACEWIN",
        providerExchange: "ASX",
        currencyCode: "AUD",
        name: "Race Winner Co",
        assetType: "equity",
      },
      {
        portfolioId: "portfolio-a",
        sourceSymbol: "RACEWIN",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
    );
    assert.equal(winnerResult.ok, true);
    if (!winnerResult.ok) return;
    assert.equal(winnerResult.securityId, "security-race-winner");
    // As above: this candidate is new, so its `portfolio_securities` link
    // row is newly created even though it links to a pre-existing security.
    assert.equal(winnerResult.created, true);

    const securityCount = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM securities WHERE canonical_name = 'Race Winner Co'",
      )
      .first<{ n: number }>();
    assert.equal(
      Number(securityCount?.n),
      1,
      "the dedupe path did not create a duplicate canonical security",
    );
    const membership = await d1
      .prepare(
        "SELECT security_id, status FROM portfolio_securities WHERE portfolio_id = 'portfolio-a' AND source_symbol = 'RACEWIN'",
      )
      .first<{ security_id: string; status: string }>();
    assert.ok(membership);
    assert.equal(membership!.security_id, "security-race-winner");
    assert.equal(membership!.status, "held");
  } finally {
    await miniflare.dispose();
  }
});
