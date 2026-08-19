/** UI-014 — Review-securities UX: prefilled names, save feedback, issue row
 * context, plus BRK-010 conversion-provenance rendering.
 *
 * Owner-reported (2026-08-19), Review securities screen:
 * 1. A prefilled name (Sharesight already supplied one) still rendered an
 *    editable input + Save, implying every row demands owner action. The
 *    edit affordance now renders ONLY while the name is genuinely missing
 *    (`isSecurityNameMissing`, `app/components/import-review.tsx`) AND
 *    editable -- a fully-prefilled table asks for nothing.
 * 2. A name save showed a spinner then nothing -- the owner could not tell
 *    success from failure. Root cause (see Part 2 below): the previous code
 *    called `setMessage` on error only, never on success, AND the name
 *    `<input>` is uncontrolled (`defaultValue`), so a re-render with the
 *    server's updated name never changed what the input visibly showed --
 *    a successful save was indistinguishable from a silent no-op. Fixed by
 *    (a) Part 1's gate, which now flips a successfully-renamed row to plain
 *    text, and (b) an explicit success confirmation message.
 * 3. Row-linked issues/warnings (blocked rows, and warnings like
 *    FX_RATE_INCOMPLETE/INCOMPLETE_HISTORY) named a row number but never
 *    its business facts. `app/import-preview.ts` now derives a bounded
 *    `rowSummaries` map (server-derived, keyed by rowId, scoped to rows an
 *    issue actually references) via the shared `summarizeRow` (moved,
 *    unchanged, to `domain/imports/row-summary.ts` -- see tests/ui-012.test.ts
 *    for the pre-existing tests re-pointed at its new home), and
 *    `import-review.tsx` renders those facts inline in both issue lists.
 * 4. BRK-010 (folded in): `DerivedDividendRow`'s conversion-provenance
 *    fields (`originalCurrencyCode`/`fxRateToPortfolioDecimal`/
 *    `fxRateSource`) were plumbed but never rendered. The per-security
 *    Dividends tab now shows a compact "converted from" disclosure beneath
 *    a converted row's Cash figure -- text, not colour. Mixed-currency rows
 *    already showed their true currency (verified, unchanged); a
 *    franking-unknown row already rendered "Unknown", never blank
 *    (verified, unchanged) -- there is no separately-plumbed "why" reason
 *    to surface (BRK-010's franking-unverified flag is a local variable in
 *    `domain/dividends/history.ts`, never threaded onto `DerivedDividendRow`),
 *    so none is fabricated here, per this task's "render the already-plumbed
 *    fields, no new derivation" scope.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "../app/import-preview.ts";
import { updateImportSecurityMetadataWithContext } from "../app/import-security-metadata-service.ts";
import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  listAttestedSecurityIds,
  listAutoCreatedSecurityIds,
  listNameEditableSecurityIds,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  SHARESIGHT_SYNC_PARSER_FORMAT,
  SHARESIGHT_SYNC_PARSER_VERSION,
} from "../domain/sharesight-sync/index.ts";
import type {
  DerivedDividendRow,
  FrankingResolution,
} from "../domain/dividends/index.ts";

// ---------------------------------------------------------------------------
// Shared DB fixture helpers (mirrors tests/brk-009c.test.ts's established
// shape for this exact area).
// ---------------------------------------------------------------------------

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-19', '2026-08-19', 1);
  `);
  return database;
}

function insertBatch(
  database: DatabaseSync,
  options: { id: string; userId: string; portfolioId: string },
): void {
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, 'sync.json', 10, ?, 'parsed', '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z', 1)`,
    )
    .run(
      options.id,
      options.userId,
      options.portfolioId,
      SHARESIGHT_SYNC_PARSER_FORMAT,
      SHARESIGHT_SYNC_PARSER_VERSION,
      `sha-${options.id}`,
    );
}

function insertRow(
  database: DatabaseSync,
  options: {
    id: string;
    batchId: string;
    userId: string;
    physicalRowNumber: number;
    symbol: string;
    currency?: string;
    type?: "buy" | "sell";
    sharesOwned?: string | null;
    costPerShare?: string | null;
    localTradeDate?: string;
    instrumentName?: string | null;
  },
): void {
  const normalized = {
    id: `sharesight-${options.id}`,
    symbol: options.symbol,
    name: null,
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: options.currency ?? "AUD",
    sharesOwned: options.sharesOwned === undefined ? "5" : options.sharesOwned,
    costPerShare:
      options.costPerShare === undefined ? "10" : options.costPerShare,
    commission: "0",
    transactionDate: options.localTradeDate ?? "2026-08-01",
    transactionTime: null,
    purchaseExchangeRate: null,
    type: options.type ?? "buy",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `${options.localTradeDate ?? "2026-08-01"}T00:00:00.000Z`,
    localTradeDate: options.localTradeDate ?? "2026-08-01",
    cashEvent: null,
    frankingPerShare: null,
    sharesightInstrumentId: null,
    instrumentName:
      options.instrumentName === undefined ? null : options.instrumentName,
    isin: null,
  };
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status,
         excluded_by_owner_at, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, 'transaction', '[]', ?, ?, 'valid', NULL, 'staged',
         NULL, '2026-08-19', '2026-08-19', 1)`,
    )
    .run(
      options.id,
      options.userId,
      options.batchId,
      options.physicalRowNumber,
      JSON.stringify(normalized),
      `fp-${options.id}`,
    );
}

function insertIssue(
  database: DatabaseSync,
  options: {
    id: string;
    userId: string;
    batchId: string;
    rowId: string;
    physicalRowNumber: number;
    code: string;
    severity?: "error" | "warning" | "info";
  },
): void {
  database
    .prepare(
      `INSERT INTO import_issues (
         id, user_id, batch_id, row_id, physical_row_number, field, severity,
         code, message, suggested_resolution_type, resolved_value,
         resolved_by_user_id, resolved_at, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'issue', NULL, NULL, NULL, NULL, '2026-08-19', '2026-08-19', 1)`,
    )
    .run(
      options.id,
      options.userId,
      options.batchId,
      options.rowId,
      options.physicalRowNumber,
      options.severity ?? "error",
      options.code,
    );
}

function insertSecurity(
  database: DatabaseSync,
  options: {
    id: string;
    symbol: string;
    currency?: string;
    canonicalName?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO securities (
         id, asset_type, exchange_id, primary_currency_code, canonical_name,
         isin, status, first_trade_date, last_trade_date, created_at, updated_at
       ) VALUES (?, 'equity', NULL, ?, ?, NULL, 'active', NULL, NULL, '2026-08-19', '2026-08-19')`,
    )
    .run(
      options.id,
      options.currency ?? "AUD",
      options.canonicalName ?? "Unnamed security",
    );
  database
    .prepare(
      `INSERT INTO security_identifiers (
         id, security_id, scheme, value, exchange_id, valid_from, valid_to, source
       ) VALUES (?, ?, 'ticker', ?, NULL, '2026-08-19', NULL, 'sharesight')`,
    )
    .run(`ident-${options.id}`, options.id, options.symbol);
}

function insertCandidate(
  database: DatabaseSync,
  options: {
    id: string;
    userId: string;
    portfolioId: string;
    symbol: string;
    currency?: string;
    securityId: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO portfolio_securities (
         id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
         source_currency_code, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'ASX', ?, 'held', '2026-08-19', '2026-08-19')`,
    )
    .run(
      options.id,
      options.userId,
      options.portfolioId,
      options.securityId,
      options.symbol,
      options.currency ?? "AUD",
    );
}

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
        `SELECT ps.id, ps.portfolio_id, ps.source_symbol, ps.source_exchange_alias,
        ps.source_currency_code, ps.security_id, s.canonical_name
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       WHERE ps.user_id = ?
       ORDER BY ps.source_symbol ASC, ps.id ASC`,
        [userId],
      ),
    ],
  );
  const securityCandidates = candidateRows.map((r) => ({
    id: String(r.id),
    portfolioId: String(r.portfolio_id),
    sourceSymbol: String(r.source_symbol),
    sourceExchangeAlias:
      r.source_exchange_alias === null ? null : String(r.source_exchange_alias),
    sourceCurrencyCode: String(r.source_currency_code),
    securityId: r.security_id === null ? null : String(r.security_id),
  }));
  const securityNames = new Map<string, string>();
  for (const r of candidateRows) {
    if (r.security_id !== null && r.canonical_name !== null) {
      securityNames.set(String(r.security_id), String(r.canonical_name));
    }
  }
  const linkedSecurityIds = securityCandidates
    .map((c) => c.securityId)
    .filter((id): id is string => id !== null);
  const [attestedSecurityIds, autoCreatedSecurityIds, nameEditableSecurityIds] =
    await Promise.all([
      listAttestedSecurityIds(client, linkedSecurityIds),
      listAutoCreatedSecurityIds(client, linkedSecurityIds),
      listNameEditableSecurityIds(client, userId, linkedSecurityIds),
    ]);
  return buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((p) => ({
      id: p.id,
      name: p.name,
      homeCurrencyCode: p.homeCurrencyCode,
      historyCompleteFrom: p.historyCompleteFrom,
    })),
    securityCandidates,
    attestedSecurityIds,
    securityNames,
    autoCreatedSecurityIds,
    nameEditableSecurityIds,
  });
}

// ---------------------------------------------------------------------------
// Part 1: name-present renders text (no input, no Save); name-missing +
// editable renders input+Save.
// ---------------------------------------------------------------------------

test("UI-014 part 1: the name-edit affordance is gated on isSecurityNameMissing, in addition to the pre-existing nameEditable/isMutableExclusionStatus gate", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /\{isSecurityNameMissing\(entry\.name\) &&\s*\n\s*entry\.nameEditable &&\s*\n\s*isMutableExclusionStatus\(review\.batch\.status\)/,
  );
});

test("UI-014 part 1: isSecurityNameMissing (the real shipped function) treats null/blank/'Unknown'/'Unnamed security' as missing, and a real name as present", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(
    /function isSecurityNameMissing\(name: string \| null\): boolean \{([\s\S]*?)\n\}/,
  );
  assert.ok(match, "expected to find isSecurityNameMissing in the source");
  const isSecurityNameMissing = new Function("name", match![1]!) as (
    name: string | null,
  ) => boolean;

  assert.equal(isSecurityNameMissing(null), true);
  assert.equal(isSecurityNameMissing(""), true);
  assert.equal(isSecurityNameMissing("   "), true);
  assert.equal(isSecurityNameMissing("Unknown"), true);
  assert.equal(isSecurityNameMissing("Unnamed security"), true);
  assert.equal(isSecurityNameMissing("iShares Global Healthcare ETF"), false);
});

// ---------------------------------------------------------------------------
// Part 2: save feedback -- root cause regression + aria-busy/cursor wiring.
// ---------------------------------------------------------------------------

test("UI-014 part 2 (root cause regression): a successful security-metadata save calls setMessage with an explicit confirmation, immediately after setReview", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(
    /async function submitSecurityMetadata\([\s\S]*?\n {2}\}\n/,
  );
  assert.ok(match, "expected to find submitSecurityMetadata in the source");
  const body = match![0]!;
  assert.match(
    body,
    /setReview\(result\.review\);[\s\S]*?setMessage\(`\$\{entry\.sourceSymbol\}'s name was saved\.`\);/,
    "expected an explicit success confirmation, not just a silent state update",
  );
});

test("UI-014 part 2: the Save button carries aria-busy while a save is in flight, and its label changes to 'Saving…'", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /<button\s*\n\s*type="submit"\s*\n\s*disabled=\{pending\}\s*\n\s*aria-busy=\{pending \|\| undefined\}\s*\n\s*>\s*\n\s*\{pending \? "Saving…" : "Save"\}/,
  );
});

test('UI-014 part 2: .import-securities-edit button shows cursor:wait ONLY under [aria-busy="true"], never on a plain disabled state', async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.import-securities-edit button\[aria-busy="true"\]\s*\{[^}]*cursor:\s*wait;/,
  );
  const disabledRule = css.match(
    /\.import-securities-edit button:disabled:not\(\[aria-busy="true"\]\)\s*\{([^}]*)\}/,
  );
  assert.ok(disabledRule, "expected the not-allowed split rule");
  assert.match(disabledRule![1]!, /cursor:\s*not-allowed;/);
  assert.doesNotMatch(disabledRule![1]!, /cursor:\s*wait;/);
});

test("UI-014 part 2 (root cause regression, real DB-backed path): the server DOES return the fresh, updated name on a successful save -- the owner-reported 'spinner then nothing' was never a server-side silent failure", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertBatch(database, {
    id: "batch-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
  });
  insertRow(database, {
    id: "row-1",
    batchId: "batch-a",
    userId: "user-a",
    physicalRowNumber: 2,
    symbol: "IXJ",
  });
  insertSecurity(database, {
    id: "sec-1",
    symbol: "IXJ",
    canonicalName: "Unnamed security",
  });
  insertCandidate(database, {
    id: "cand-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "IXJ",
    securityId: "sec-1",
  });

  const before = await currentReview(client, "user-a", "batch-a");
  const entry = before.securities.find((s) => s.sourceSymbol === "IXJ");
  assert.ok(entry, "expected the auto-created IXJ security to appear");
  assert.equal(entry!.name, "Unnamed security");
  assert.equal(entry!.nameEditable, true);

  const updated = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: entry!.sourceSymbol,
      sourceExchangeAlias: entry!.sourceExchangeAlias,
      sourceCurrencyCode: entry!.sourceCurrencyCode,
      securityId: entry!.securityId,
      name: "iShares Global Healthcare ETF",
      expectedVersion: before.batch.version,
      expectedPreviewVersion: before.previewVersion,
    },
  );
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  const updatedEntry = updated.review.securities.find(
    (s) => s.sourceSymbol === "IXJ",
  );
  assert.equal(updatedEntry!.name, "iShares Global Healthcare ETF");
});

// ---------------------------------------------------------------------------
// Part 3: issue row context -- rowSummaries derivation + JSX wiring.
// ---------------------------------------------------------------------------

test("UI-014 part 3: buildImportReviewPreview derives rowSummaries for a row a PERSISTED issue references, with real business facts and a 'Not recorded' fallback for a genuinely missing quantity", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertBatch(database, {
    id: "batch-b",
    userId: "user-a",
    portfolioId: "portfolio-a",
  });
  insertRow(database, {
    id: "row-blocked",
    batchId: "batch-b",
    userId: "user-a",
    physicalRowNumber: 5,
    symbol: "BETA",
    currency: "USD",
    sharesOwned: null,
    costPerShare: "42.00",
    localTradeDate: "2026-03-05",
  });
  insertIssue(database, {
    id: "issue-1",
    userId: "user-a",
    batchId: "batch-b",
    rowId: "row-blocked",
    physicalRowNumber: 5,
    code: "SHARESIGHT_PAYOUT_FX_RATE_MISSING",
    severity: "error",
  });
  // A second row with NO issue referencing it -- must never appear in
  // rowSummaries (server-derived, bounded to rows an issue actually names).
  // Given a resolved candidate (matching currency AUD == portfolio home) so
  // it raises no SECURITY_MAPPING_REQUIRED/FX issue of its own either --
  // genuinely unreferenced by anything.
  insertRow(database, {
    id: "row-unreferenced",
    batchId: "batch-b",
    userId: "user-a",
    physicalRowNumber: 6,
    symbol: "GAMMA",
  });
  insertSecurity(database, { id: "sec-gamma", symbol: "GAMMA" });
  insertCandidate(database, {
    id: "cand-gamma",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "GAMMA",
    securityId: "sec-gamma",
  });

  const review = await currentReview(client, "user-a", "batch-b");
  const summary = review.rowSummaries["row-blocked"];
  assert.ok(summary, "expected a summary for the blocked row");
  assert.equal(summary!.symbol, "BETA");
  assert.equal(summary!.type, "buy");
  assert.equal(summary!.date, "2026-03-05");
  assert.equal(summary!.quantity, "Not recorded");
  assert.equal(summary!.amount, "42.00");
  assert.equal(summary!.currency, "USD");
  assert.equal(
    review.rowSummaries["row-unreferenced"],
    undefined,
    "a row no issue references must not appear in rowSummaries",
  );
});

test("UI-014 part 3: buildImportReviewPreview derives rowSummaries for a row a COMPUTED (reconciliation) warning references, e.g. FX_RATE_INCOMPLETE", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertBatch(database, {
    id: "batch-c",
    userId: "user-a",
    portfolioId: "portfolio-a",
  });
  // A buy row in USD against an AUD-base portfolio with no purchase
  // exchange rate, RESOLVED to an existing USD-currency security (an
  // unresolved row never reaches the FX check at all -- it short-circuits
  // on SECURITY_MAPPING_REQUIRED instead, see reconciliation.ts's per-row
  // loop) -- domain/imports/reconciliation.ts's FX_RATE_INCOMPLETE warning
  // fires on exactly this shape.
  insertRow(database, {
    id: "row-fx",
    batchId: "batch-c",
    userId: "user-a",
    physicalRowNumber: 3,
    symbol: "USDCO",
    currency: "USD",
    type: "buy",
    sharesOwned: "7",
    costPerShare: "11.25",
    localTradeDate: "2026-04-01",
  });
  insertSecurity(database, {
    id: "sec-usdco",
    symbol: "USDCO",
    currency: "USD",
  });
  insertCandidate(database, {
    id: "cand-usdco",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "USDCO",
    currency: "USD",
    securityId: "sec-usdco",
  });

  const review = await currentReview(client, "user-a", "batch-c");
  const fxIssue = review.preview.issues.find(
    (issue) => issue.code === "FX_RATE_INCOMPLETE",
  );
  assert.ok(fxIssue, "expected the computed FX_RATE_INCOMPLETE warning");
  const summary = review.rowSummaries[fxIssue!.rowId!];
  assert.ok(summary, "expected a summary for the row the warning names");
  assert.equal(summary!.symbol, "USDCO");
  assert.equal(summary!.quantity, "7");
  assert.equal(summary!.amount, "11.25");
  assert.equal(summary!.currency, "USD");
});

test("UI-014 part 3: the 'Row and field issues' and 'Blocked rows' sections both render the row's business facts inline via rowSummaries, with 'Not recorded' fallbacks (never fabricated)", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  // Both issue lists look up review.rowSummaries by the issue's own rowId
  // and render the shared rowFactsText derivation -- never re-deriving the
  // facts client-side.
  const occurrences = component.match(
    /review\.rowSummaries\?\.\[issue\.rowId\]/g,
  );
  assert.ok(occurrences, "expected the rowSummaries lookup in the source");
  assert.equal(
    occurrences!.length,
    2,
    "expected the lookup in both the preview.issues list and the blockedRowIssues list",
  );
  assert.match(component, /className="import-issue-row-facts"/);
  assert.match(component, /\{rowFactsText\(summary\)\}/);
});

// ---------------------------------------------------------------------------
// Part 4: BRK-010 conversion-provenance rendering on the Dividends tab.
// ---------------------------------------------------------------------------

const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
  const routerStub = {
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  };
`;

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
    ${ROUTER_STUB_IMPORT}
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(${componentName}, props),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

function franking(
  source: "override" | "default" | "unknown",
  value: string | null,
): FrankingResolution {
  if (source === "unknown") return { source: "unknown", perShareDecimal: null };
  return { source, perShareDecimal: value as string };
}

function row(overrides: Partial<DerivedDividendRow>): DerivedDividendRow {
  return {
    id: "de1",
    portfolioSecurityId: "psa1",
    dividendEventId: "de1",
    kind: "cash",
    currencyCode: "AUD",
    exDate: "2026-03-01",
    paymentDate: "2026-03-01",
    sharesDecimal: "100",
    dividendPerShareDecimal: "1.50",
    cashDecimal: "150",
    franking: franking("override", "0.30"),
    frankingTotalDecimal: "30",
    grossDecimal: "180",
    grossIncludesFranking: true,
    status: "ex_date_passed",
    source: "edited",
    excluded: false,
    amountUnknown: false,
    providerGrossPerShareDecimal: "1.00",
    dominatedReceipt: null,
    dominatedImported: null,
    additionalReceiptsCount: 0,
    additionalImportedCount: 0,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
    ...overrides,
  };
}

const sampleLifetimeTotals = {
  currencyCode: "AUD",
  status: "ok" as const,
  rowCount: 1,
  excludedCount: 0,
  unknownAmountCount: 0,
  receivedCashDecimal: "150",
  receivedFrankingKnownDecimal: "30",
  receivedFrankingUnknownCount: 0,
  receivedGrossDecimal: "180",
  pendingCashDecimal: null,
  pendingFrankingKnownDecimal: null,
  pendingFrankingUnknownCount: 0,
  pendingGrossDecimal: null,
  pendingCount: 0,
};

function baseTabProps(rows: DerivedDividendRow[]) {
  return {
    portfolioId: "pa",
    portfolioSecurityId: "psa1",
    symbol: "ALPHA",
    currencyCode: "AUD",
    today: "2026-08-19",
    rows,
    filteredArtifactCount: 0,
    lifetimeTotals: sampleLifetimeTotals,
    overridesByEventId: {},
    manualRecordsById: {},
    assumptions: {
      dividendYieldPercentDecimal: null,
      frankingPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
      version: 1,
    },
    portfolioAssumptions: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      version: null,
    },
    holdingsHref: "/portfolio/pa/holdings",
  };
}

test("UI-014 part 4: a converted row (originalCurrencyCode + fxRateToPortfolioDecimal set) renders a compact 'converted from' disclosure beneath the Cash figure, with the rate trimmed for display", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps([
      row({
        id: "imported-1",
        dividendEventId: null,
        kind: "manual",
        exDate: null,
        source: "imported",
        cashDecimal: "31.41",
        grossDecimal: "31.41",
        frankingTotalDecimal: null,
        grossIncludesFranking: false,
        franking: franking("unknown", null),
        dividendPerShareDecimal: null,
        sharesDecimal: null,
        providerGrossPerShareDecimal: null,
        originalCurrencyCode: "USD",
        fxRateToPortfolioDecimal: "1.539583333355785590278105",
        fxRateSource: "sharesight",
      }),
    ]),
  );
  assert.match(html, /class="dividend-fx-provenance"/);
  assert.match(html, />converted from USD @ 1\.539583 \(sharesight\)</);
});

test("UI-014 part 4: a native-currency row (no originalCurrencyCode) renders NO conversion-provenance disclosure", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps([row({})]),
  );
  assert.doesNotMatch(html, /dividend-fx-provenance/);
  assert.doesNotMatch(html, /converted from/);
});

test("UI-014 part 4: a mixed-currency (degraded, unconverted) row already shows its TRUE currency on every money cell, not the security's own currency (verified, unchanged)", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps([
      row({
        id: "imported-2",
        dividendEventId: null,
        kind: "manual",
        exDate: null,
        source: "imported",
        currencyCode: "USD",
        cashDecimal: "20.40",
        grossDecimal: "20.40",
        frankingTotalDecimal: null,
        grossIncludesFranking: false,
        franking: franking("unknown", null),
        dividendPerShareDecimal: null,
        sharesDecimal: null,
        providerGrossPerShareDecimal: null,
        originalCurrencyCode: null,
        fxRateToPortfolioDecimal: null,
        fxRateSource: null,
      }),
    ]),
  );
  assert.match(html, />USD 20\.40</);
  assert.doesNotMatch(html, />AUD 20\.40</);
  // A degraded/unconverted row carries no rate -- must never fabricate one.
  assert.doesNotMatch(html, /dividend-fx-provenance/);
});

test("UI-014 part 4: a franking-unknown row renders the literal text 'Unknown' in the Franking/share cell -- never blank, never a fabricated 0", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    baseTabProps([
      row({
        id: "totals-mode-1",
        dividendEventId: null,
        kind: "manual",
        exDate: null,
        source: "imported",
        dividendPerShareDecimal: null,
        sharesDecimal: null,
        franking: franking("unknown", null),
        frankingTotalDecimal: null,
        cashDecimal: "50",
        grossDecimal: "50",
        grossIncludesFranking: false,
        providerGrossPerShareDecimal: null,
      }),
    ]),
  );
  assert.match(html, />Unknown</);
  assert.doesNotMatch(html, /<td class="numeric"><\/td>/);
});

// ---------------------------------------------------------------------------
// Part 4 (follow-up): the same conversion-provenance disclosure on
// RecordDividendDialog's "superseded by this row" dominated-imported
// evidence line (`app/components/dividend-assumptions-editor.tsx`).
// ---------------------------------------------------------------------------

function renderRecordDialog(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "RecordDividendDialog",
    "../app/components/dividend-assumptions-editor.tsx",
    {
      dialogRef: { current: null },
      portfolioId: "pa",
      securities: [
        { portfolioSecurityId: "psa1", symbol: "ALPHA", currencyCode: "AUD" },
      ],
      maxDate: "2026-08-19",
      initialDividendEventId: "de1",
      initialPaymentDate: "2026-03-01",
      initialSharesDecimal: "100",
      initialDividendPerShareDecimal: "1.50",
      initialExpectedVersion: 1,
      ...overrides,
    },
  );
}

test("UI-014 part 4 (follow-up): a converted dominated-imported record (currencyCode + fxRateToPortfolioDecimal set) renders the same compact 'converted from' disclosure beneath the Imported evidence line", () => {
  const html = renderRecordDialog({
    dominatedImported: {
      sharesDecimal: null,
      dividendPerShareDecimal: null,
      frankingCreditPerShareDecimal: null,
      totalCashDecimal: "42.00",
      totalFrankingDecimal: null,
      paymentDate: "2026-03-09",
      currencyCode: "USD",
      fxRateToPortfolioDecimal: "1.539583333355785590278105",
      fxRateSource: "sharesight",
    },
  });
  assert.match(html, /Imported:/);
  assert.match(html, /class="dividend-fx-provenance"/);
  assert.match(html, />converted from USD @ 1\.539583 \(sharesight\)</);
});

test("UI-014 part 4 (follow-up): a dominated-imported record with no currencyCode/fxRateToPortfolioDecimal renders NO conversion-provenance disclosure", () => {
  const html = renderRecordDialog({
    dominatedImported: {
      sharesDecimal: null,
      dividendPerShareDecimal: null,
      frankingCreditPerShareDecimal: null,
      totalCashDecimal: "42.00",
      totalFrankingDecimal: null,
      paymentDate: "2026-03-09",
      currencyCode: null,
      fxRateToPortfolioDecimal: null,
      fxRateSource: null,
    },
  });
  assert.match(html, /Imported:/);
  assert.doesNotMatch(html, /dividend-fx-provenance/);
  assert.doesNotMatch(html, /converted from/);
});
