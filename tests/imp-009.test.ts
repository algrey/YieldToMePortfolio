import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSecurityAttestPost } from "../app/security-attestation-route.ts";
import {
  attestSecurityCandidateWithContext,
  type SecurityAttestActionOptions,
} from "../app/security-attestation-service.ts";
import { verifySecurityCandidateWithContext } from "../app/security-verification-service.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createOwnedSecurityAttestationRepository,
  createSqliteSqlClient,
  listAttestedSecurityIds,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import type {
  MarketDataProvider,
  ProviderCapabilities,
  SecurityCandidate,
} from "../domain/market-data/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";
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

function candidatesProvider(
  candidates: SecurityCandidate[],
): MarketDataProvider {
  return stubProvider(async () => ({ ok: true, value: candidates }));
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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-16', '2026-08-16', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-16', '2026-08-16', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-16', '2026-08-16', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-16', '2026-08-16', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-16', '2026-08-16', 1),
           ('portfolio-a2', 'user-a', 'A2', 'Second', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-16', '2026-08-16', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-16', '2026-08-16', 1);
    -- 'yahoo-compatible' market_data_providers row is shipped by
    -- drizzle/0037_steady_signal.sql (MKT-007) as reference data; the full
    -- migration chain applied above already produced it.
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample.csv', 100, 'file-a', 'parsed',
      '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z', 1);
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
    symbol: overrides.symbol ?? "OLDCO",
    name: "Old Co",
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
  physicalRowNumber = 2,
): void {
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
       ) VALUES (?, 'user-a', ?, ?, 'transaction', '[]', ?, ?, 'valid',
         NULL, 'staged', '2026-08-16', '2026-08-16', 1)`,
    )
    .run(
      rowId,
      batchId,
      physicalRowNumber,
      JSON.stringify(normalized),
      `fingerprint-${rowId}`,
    );
}

// Mirrors the private `loadImportReview` helper
// (app/security-attestation-service.ts) using only exported repository
// functions, returning the full built review so tests can inspect
// `preview.unresolvedCandidates`/`preview.issues`/`attestedSecurityIds`, not
// just the version.
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
  const securityCandidates = candidateRows.map((row) => ({
    id: String(row.id),
    portfolioId: String(row.portfolio_id),
    sourceSymbol: String(row.source_symbol),
    sourceExchangeAlias:
      row.source_exchange_alias === null
        ? null
        : String(row.source_exchange_alias),
    sourceCurrencyCode: String(row.source_currency_code),
    securityId: row.security_id === null ? null : String(row.security_id),
  }));
  const attestedSecurityIds = await listAttestedSecurityIds(
    client,
    securityCandidates
      .map((candidate) => candidate.securityId)
      .filter((id): id is string => id !== null),
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
    securityCandidates,
    attestedSecurityIds,
  });
}

async function attestSymbol(
  client: SqlClient,
  userId: string,
  batchId: string,
  portfolioId: string,
  candidate: {
    sourceSymbol: string;
    sourceExchangeAlias: string | null;
    sourceCurrencyCode: string;
  },
  displayName: string | undefined,
  options: SecurityAttestActionOptions,
) {
  const review = await currentReview(client, userId, batchId);
  return attestSecurityCandidateWithContext(
    { client, userId, requestId: "imp-009-request" },
    batchId,
    {
      portfolioId,
      sourceSymbol: candidate.sourceSymbol,
      sourceExchangeAlias: candidate.sourceExchangeAlias,
      sourceCurrencyCode: candidate.sourceCurrencyCode,
      displayName,
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
    options,
  );
}

test("attest resolves an unresolved candidate from zero securities, unblocks readiness, and commits it as owner-attested (no provider mapping)", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "OLDCO" }));
  const client = createSqliteSqlClient(database);

  const result = await attestSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "OLDCO",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    "Old Co Limited",
    { now: () => "2026-08-16T01:00:00Z" },
  );
  assert.equal(result.ok, true, !result.ok ? result.message : undefined);
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
  assert.equal(security.canonical_name, "Old Co Limited");
  assert.equal(security.status, "active");

  const identifier = database
    .prepare("SELECT scheme, value, source FROM security_identifiers")
    .get() as { scheme: string; value: string; source: string };
  assert.equal(identifier.scheme, "ticker");
  assert.equal(identifier.value, "OLDCO");
  assert.equal(identifier.source, "owner_attested");

  // Provenance honesty: NEVER a `security_provider_mappings` row for an
  // attested security.
  const mappingCount = (
    database
      .prepare("SELECT COUNT(*) AS n FROM security_provider_mappings")
      .get() as { n: number }
  ).n;
  assert.equal(mappingCount, 0);

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

  assert.deepEqual(result.review.attestedSecurityIds, [securityId]);

  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    "batch-a",
    {
      expectedVersion: result.review.batch.version,
      expectedPreviewVersion: result.review.previewVersion,
    },
  );
  assert.equal(ready.ok, true, !ready.ok ? ready.message : undefined);
  if (!ready.ok) return;

  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: ready.review.batch.version,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "imp-009-commit",
    confirmation: true,
    requestId: "imp-009-commit-request",
  };
  let commitResult = await commitRepo.commit("user-a", "batch-a", commitInput);
  for (
    let attempt = 0;
    attempt < 20 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(
      commitResult.ok,
      true,
      !commitResult.ok ? commitResult.reason : undefined,
    );
    commitResult = await commitRepo.commit("user-a", "batch-a", commitInput);
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
  assert.equal(heldCount, 1);
});

test("concurrent attest of the same identity converges on one security row and links both candidates", async () => {
  // node:sqlite's synchronous engine means two `client.batch()` calls
  // cannot truly interleave mid-transaction, but issuing both
  // `attestAndLink` calls before either is awaited still exercises the
  // repository's re-read-after-attempt path exactly as a second request
  // arriving moments after the first would (mirrors IMP-004B's identical
  // "sequential verify requests" drill).
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const repository = createOwnedSecurityAttestationRepository(client);
  const identity = {
    symbol: "RACE",
    currencyCode: "AUD",
    displayName: "Race Co",
  };

  const [first, second] = await Promise.all([
    repository.attestAndLink("user-a", identity, {
      portfolioId: "portfolio-a",
      sourceSymbol: "RACE",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    }),
    repository.attestAndLink("user-a", identity, {
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
  assert.equal(securityCount, 1, "no duplicate canonical security created");
  const identifierCount = (
    database
      .prepare("SELECT COUNT(*) AS n FROM security_identifiers")
      .get() as { n: number }
  ).n;
  assert.equal(identifierCount, 1, "no duplicate attested identifier created");

  const memberships = database
    .prepare(
      "SELECT portfolio_id, security_id FROM portfolio_securities ORDER BY portfolio_id",
    )
    .all() as Array<{ portfolio_id: string; security_id: string }>;
  assert.equal(memberships.length, 2);
  for (const membership of memberships) {
    assert.equal(membership.security_id, first.securityId);
  }
});

test("attesting a symbol that a provider has already verified links to that existing security -- never a duplicate", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-verified', 'Verified Co', 'equity', 'AUD', 'active', '2026-08-16', '2026-08-16');
    INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, source)
    VALUES ('identifier-verified', 'security-verified', 'ticker', 'DUP', '2026-08-16', 'yahoo-compatible');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
    VALUES ('mapping-verified', 'security-verified', 'yahoo-compatible', 'ASX', 'DUP', '2026-08-15', 'verified', 'user-a', '2026-08-15T00:00:00Z');
  `);
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "DUP" }));
  const client = createSqliteSqlClient(database);

  const result = await attestSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "DUP",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    "Should not matter",
    {},
  );
  assert.equal(result.ok, true, !result.ok ? result.message : undefined);
  if (!result.ok) return;

  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
        n: number;
      }
    ).n,
    1,
    "no new canonical security was created",
  );
  const membership = database
    .prepare(
      "SELECT security_id FROM portfolio_securities WHERE portfolio_id = 'portfolio-a'",
    )
    .get() as { security_id: string };
  assert.equal(membership.security_id, "security-verified");
  // Never provider-attested: this security is already genuinely
  // provider-verified, so it must NOT be reported as owner-attested.
  assert.deepEqual(result.review.attestedSecurityIds, []);
});

test("a currency mismatch on attest against an existing identity fails explicitly and never silently links", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-attested', 'Attested Co', 'equity', 'AUD', 'active', '2026-08-16', '2026-08-16');
    INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, source)
    VALUES ('identifier-attested', 'security-attested', 'ticker', 'MISM', '2026-08-16', 'owner_attested');
  `);
  stageRow(
    database,
    "batch-a",
    "row-1",
    normalizedRow({ symbol: "MISM", currency: "USD" }),
  );
  const client = createSqliteSqlClient(database);

  const result = await attestSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "MISM",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "USD",
    },
    undefined,
    {},
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /currency/i);

  assert.equal(
    (
      database
        .prepare(
          "SELECT security_id FROM portfolio_securities WHERE portfolio_id = 'portfolio-a'",
        )
        .get() as { security_id: string | null } | undefined
    )?.security_id,
    undefined,
    "the candidate must stay unresolved on a currency mismatch",
  );
});

test("a later provider verification of an owner-attested identity attaches the mapping to the SAME security row", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "UPGRADE" }));
  const client = createSqliteSqlClient(database);

  const attested = await attestSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "UPGRADE",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    "Upgrade Co (attested)",
    { now: () => "2026-08-16T00:00:00Z" },
  );
  assert.equal(attested.ok, true, !attested.ok ? attested.message : undefined);
  if (!attested.ok) return;
  const attestedSecurityId = (
    database.prepare("SELECT id FROM securities").get() as { id: string }
  ).id;
  assert.deepEqual(attested.review.attestedSecurityIds, [attestedSecurityId]);

  // A SECOND, still-genuinely-unresolved candidate for the exact same
  // ticker text, in a different owned portfolio -- the real scenario a
  // provider verify's upgrade path exists for (the owner attested the
  // identity in one portfolio while the provider was unavailable, and now
  // holds/imports the same security into another portfolio once the
  // provider verify option is available again).
  stageRow(
    database,
    "batch-a",
    "row-2",
    normalizedRow({ symbol: "UPGRADE", portfolio: "Second" }),
    3,
  );
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
      symbol: "UPGRADE",
      exchangeId: "ASX",
      currencyCode: "AUD",
      name: "Upgrade Co (provider name)",
      confidence: "high",
      assetType: "equity",
    },
  ]);
  const review = await currentReview(client, "user-a", "batch-a");
  const verified = await verifySecurityCandidateWithContext(
    { client, userId: "user-a" },
    "batch-a",
    {
      portfolioId: "portfolio-a2",
      sourceSymbol: "UPGRADE",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
    { provider, now: () => "2026-08-16T02:00:00Z" },
  );
  assert.equal(verified.ok, true, !verified.ok ? verified.message : undefined);
  if (!verified.ok) return;

  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
        n: number;
      }
    ).n,
    1,
    "no duplicate canonical security was created by the upgrade",
  );
  const membership = database
    .prepare(
      "SELECT security_id FROM portfolio_securities WHERE portfolio_id = 'portfolio-a2'",
    )
    .get() as { security_id: string };
  assert.equal(
    membership.security_id,
    attestedSecurityId,
    "the mapping must attach to the SAME security the attestation created",
  );
  const mapping = database
    .prepare(
      "SELECT security_id, status FROM security_provider_mappings WHERE security_id = ?",
    )
    .get(attestedSecurityId) as { security_id: string; status: string };
  assert.equal(mapping.status, "verified");

  // The identifier the attestation wrote is untouched -- still
  // `owner_attested` -- but the security no longer reports as attested
  // since it now carries an active verified mapping.
  const identifier = database
    .prepare("SELECT source FROM security_identifiers WHERE security_id = ?")
    .get(attestedSecurityId) as { source: string };
  assert.equal(identifier.source, "owner_attested");
  const stillAttested = await listAttestedSecurityIds(client, [
    attestedSecurityId,
  ]);
  assert.deepEqual(stillAttested, []);
});

test("a currency mismatch on provider-verify-after-attest fails explicitly and never rewrites the attested identity", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "CCYX" }));
  const client = createSqliteSqlClient(database);

  const attested = await attestSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "CCYX",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    "Currency Mismatch Co",
    {},
  );
  assert.equal(attested.ok, true, !attested.ok ? attested.message : undefined);
  if (!attested.ok) return;
  const attestedSecurityId = (
    database.prepare("SELECT id FROM securities").get() as { id: string }
  ).id;

  // A second, genuinely unresolved candidate for the same ticker text but a
  // DIFFERENT currency, in a different owned portfolio.
  stageRow(
    database,
    "batch-a",
    "row-2",
    normalizedRow({ symbol: "CCYX", currency: "USD", portfolio: "Second" }),
    3,
  );
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
      symbol: "CCYX",
      exchangeId: "ASX",
      currencyCode: "USD",
      name: "Currency Mismatch Co (USD)",
      confidence: "high",
      assetType: "equity",
    },
  ]);
  const review = await currentReview(client, "user-a", "batch-a");
  const verified = await verifySecurityCandidateWithContext(
    { client, userId: "user-a" },
    "batch-a",
    {
      portfolioId: "portfolio-a2",
      sourceSymbol: "CCYX",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "USD",
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
    { provider },
  );
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.match(verified.message, /currency/i);

  // The attested identity is untouched: still no provider mapping, still
  // reported as owner-attested, and the second portfolio's candidate stays
  // unresolved rather than being silently linked to a currency-disagreeing
  // security.
  const mappingCount = (
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM security_provider_mappings WHERE security_id = ?",
      )
      .get(attestedSecurityId) as { n: number }
  ).n;
  assert.equal(mappingCount, 0);
  const stillAttested = await listAttestedSecurityIds(client, [
    attestedSecurityId,
  ]);
  assert.deepEqual(stillAttested, [attestedSecurityId]);
  const secondCandidate = database
    .prepare(
      "SELECT security_id FROM portfolio_securities WHERE portfolio_id = 'portfolio-a2'",
    )
    .get() as { security_id: string | null } | undefined;
  assert.equal(secondCandidate?.security_id ?? null, null);
});

test("attest action rejects malformed input, a stale version, and another owner's batch", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "GATE" }));
  const client = createSqliteSqlClient(database);
  const context = { client, userId: "user-a", requestId: "req-gate" };

  assert.deepEqual(
    await attestSecurityCandidateWithContext(context, "batch-a", null),
    {
      ok: false,
      status: 400,
      message: "Complete the labelled attestation fields.",
    },
  );

  const review = await currentReview(client, "user-a", "batch-a");
  const stale = await attestSecurityCandidateWithContext(context, "batch-a", {
    portfolioId: "portfolio-a",
    sourceSymbol: "GATE",
    sourceExchangeAlias: "ASX",
    sourceCurrencyCode: "AUD",
    expectedVersion: 99,
    expectedPreviewVersion: review.previewVersion,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.status, 409);
    assert.match(stale.message, /stale/i);
  }

  const otherOwner = await attestSecurityCandidateWithContext(
    { client, userId: "user-b", requestId: "req-gate-b" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "GATE",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.deepEqual(otherOwner, {
    ok: false,
    status: 404,
    message: "Import batch not found.",
  });

  const wrongCandidate = await attestSecurityCandidateWithContext(
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
  );
  assert.equal(wrongCandidate.ok, false);
  if (!wrongCandidate.ok) assert.equal(wrongCandidate.status, 409);

  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
        n: number;
      }
    ).n,
    0,
    "none of the rejected attempts published anything",
  );
});

test("attest rejects a display name over 120 characters, or one containing a control character, with an explicit 400", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "NAMER" }));
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");

  const tooLong = await attestSecurityCandidateWithContext(
    { client, userId: "user-a", requestId: "req-namer-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "NAMER",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      displayName: "N".repeat(121),
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) {
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.message, /120 characters/);
  }

  const controlChar = await attestSecurityCandidateWithContext(
    { client, userId: "user-a", requestId: "req-namer-2" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "NAMER",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      displayName: "Namer\tCo", // tab in the middle -- .trim() only strips leading/trailing whitespace
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(controlChar.ok, false);
  if (!controlChar.ok) {
    assert.equal(controlChar.status, 400);
    assert.match(controlChar.message, /control characters/);
  }

  // Exactly 120 characters (the boundary) and no control characters is
  // accepted.
  const boundary = await attestSecurityCandidateWithContext(
    { client, userId: "user-a", requestId: "req-namer-3" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "NAMER",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      displayName: "N".repeat(120),
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(boundary.ok, true, !boundary.ok ? boundary.message : undefined);

  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
        n: number;
      }
    ).n,
    1,
    "only the boundary-length, control-character-free attempt published",
  );
});

test("attest normalizes a lower-case currency code to upper case before matching the candidate and publishing", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "LOWER" }));
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");

  const result = await attestSecurityCandidateWithContext(
    { client, userId: "user-a", requestId: "req-lower" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "LOWER",
      sourceExchangeAlias: "ASX",
      // Lower-case where the actually-staged candidate's currency is
      // "AUD" (upper case, per CSV-import normalization) -- must still
      // match and attest successfully.
      sourceCurrencyCode: "aud",
      displayName: "Lower Co",
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(result.ok, true, !result.ok ? result.message : undefined);
  if (!result.ok) return;

  const security = database
    .prepare("SELECT primary_currency_code FROM securities")
    .get() as { primary_currency_code: string };
  assert.equal(
    security.primary_currency_code,
    "AUD",
    "the stored currency is upper-normalized, never the raw lower-case input",
  );
});

test("attest rejects an unrecognized currency code with an honest message before any write is attempted", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");

  const result = await attestSecurityCandidateWithContext(
    { client, userId: "user-a", requestId: "req-unknown-ccy" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "ANYSYM",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "ZZZ",
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.match(result.message, /not a recognized currency code/);

  assert.equal(
    (
      database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test("attest route enforces CSRF before its authenticated action", async () => {
  let calls = 0;
  const rejectedPost = createSecurityAttestPost(async () => {
    calls += 1;
    throw new Error("cross-site request reached the action");
  });
  const rejected = await rejectedPost(
    new Request(
      "https://yield.example/api/import/preview/batch-a/securities/attest",
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
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "CSRF" }));
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");
  const authenticatedPost = createSecurityAttestPost((batchId, value) =>
    attestSecurityCandidateWithContext(
      { client, userId: "user-a", requestId: "req-csrf" },
      batchId,
      value,
    ),
  );
  const response = await authenticatedPost(
    new Request(
      "https://yield.example/api/import/preview/batch-a/securities/attest",
      {
        method: "POST",
        headers: {
          origin: "https://yield.example",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          portfolioId: "portfolio-a",
          sourceSymbol: "CSRF",
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

test("attest records an owner-attributed audit event naming the batch, candidate identity, and created security id", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow({ symbol: "AUDIT" }));
  const client = createSqliteSqlClient(database);

  const result = await attestSymbol(
    client,
    "user-a",
    "batch-a",
    "portfolio-a",
    {
      sourceSymbol: "AUDIT",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
    "Audit Co",
    {},
  );
  assert.equal(result.ok, true, !result.ok ? result.message : undefined);
  if (!result.ok) return;
  const securityId = (
    database.prepare("SELECT id FROM securities").get() as { id: string }
  ).id;

  const events = database
    .prepare(
      `SELECT actor_user_id, target_owner_user_id, action, target_type, target_id, metadata_json
         FROM audit_events WHERE action = 'import.security.attest'`,
    )
    .all() as Array<{
    actor_user_id: string;
    target_owner_user_id: string;
    action: string;
    target_type: string;
    target_id: string;
    metadata_json: string;
  }>;
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.actor_user_id, "user-a");
  assert.equal(event.target_owner_user_id, "user-a");
  assert.equal(event.target_type, "import_batch");
  assert.equal(event.target_id, "batch-a");
  const metadata = JSON.parse(event.metadata_json) as {
    sourceSymbol: string;
    sourceExchangeAlias: string | null;
    sourceCurrencyCode: string;
    displayName: string;
    securityId: string;
    created: boolean;
  };
  // Candidate identity survives `domain/observability/redaction.ts`'s
  // standing metadata redaction filter (only fields whose KEY matches its
  // `SENSITIVE_KEY` pattern -- which includes any `*securityId`/
  // `*portfolioId` variant -- are redacted; plain business fields like
  // `sourceSymbol` are not).
  assert.equal(metadata.sourceSymbol, "AUDIT");
  assert.equal(metadata.sourceExchangeAlias, "ASX");
  assert.equal(metadata.sourceCurrencyCode, "AUD");
  assert.equal(metadata.displayName, "Audit Co");
  assert.equal(metadata.created, true);
  // `securityId` (like every `*Id` field in every audit event across this
  // app -- see IMP-008's identical `rowIds`-only precedent) is redacted at
  // rest by that SAME standing filter; the durable, unredacted answer to
  // "which security" is `portfolio_securities.security_id`, itself already
  // asserted against `securityId` above via the direct DB read.
  assert.equal(metadata.securityId, "[REDACTED]");
  assert.notEqual(securityId, "[REDACTED]");
});

// ---------------------------------------------------------------------------
// UI source assertions (app/components/import-review.tsx)
// ---------------------------------------------------------------------------

test("import review UI wires the 'Resolve manually' card, its confirm dialog, consequence copy, and the owner-attested state label", async () => {
  const source = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );

  // The card: a "Resolve manually" affordance alongside verify/skip, gated
  // on the same `unresolvedCandidate`.
  assert.match(source, /Resolve manually/);
  assert.match(source, /openAttestationDialog/);

  // The dialog: its own ref/state, distinct from the exclusion dialog's.
  assert.match(source, /attestationDialogRef/);
  assert.match(source, /pendingAttestation/);

  // The consequence copy: what attestation means (owner responsibility, no
  // market data until provider-verified).
  assert.match(
    source,
    /You are taking responsibility for this security[\s\S]*?identity/,
  );

  // The owner-attested state label -- literal, per the Orchestrator ruling.
  assert.match(
    source,
    /Owner-attested identity; market data unavailable until provider-verified/,
  );

  // The route this card posts to.
  assert.match(
    source,
    /\/api\/import\/preview\/\$\{review\.batch\.id\}\/securities\/attest/,
  );
});
