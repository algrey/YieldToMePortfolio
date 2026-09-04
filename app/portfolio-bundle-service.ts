// EXP-001: the single-portfolio bundle import's staged/previewed/validated/
// idempotent/batch-attributable/reversible orchestration (AGENTS.md's CSV
// non-negotiables, applied to a JSON bundle instead of CSV rows). Server is
// the SOLE validation authority (IMP-010B) -- `validatePortfolioBundle`
// (domain, structural) runs first, then every DB-dependent fact (currency
// precondition, referenced dividend events, security resolution) is
// re-checked here against the live database, never trusted from the file.
//
// SCOPE DECISIONS made during implementation (see the Worker report and
// `docs/BACKUP_FORMAT.md`'s "Design decisions" section for the full
// reasoning -- flagged to the Orchestrator, not silently assumed):
//  - Import always creates a NEW portfolio from the bundle's own identity;
//    it never targets an existing portfolio. A brand-new portfolio is
//    trivially "empty", which satisfies the collision policy's simplest
//    honest form without needing general pre-existing-row collision
//    detection.
//  - The new portfolio inherits the CURRENT owner's home currency (the only
//    currency `createOwnedPortfolioRepository.create()` supports); if that
//    disagrees with the bundle's own recorded base currency, commit is
//    REJECTED with an actionable message rather than silently misreporting
//    FX-dependent figures.
//  - Reversal is PORTFOLIO-LEVEL: undo a bundle import by archiving the
//    portfolio it created (the pre-existing `archivePortfolioAction`) --
//    since the import always creates a fresh portfolio, archiving it
//    removes 100% of what the import wrote using already-tested machinery,
//    rather than a bespoke per-row reversal.
//  - Reviewer fix (B3): a row that was ORIGINALLY manual (`import_batch_id
//    IS NULL` in the source) is replayed via `createDividendManualRecordRepository().create()`
//    (never the import-insert builder), keeping it dialog-editable after
//    restore -- matching its source portfolio's own affordance. This is
//    provably lossless: `create()`/`supersede()` never write the BRK-010
//    foreign-currency fields (`currencyCode`/`fxRateToPortfolioDecimal`/
//    `fxRateSource`) at all, so a manual row can never have carried them in
//    the first place -- routing it through the import builder bought no
//    fidelity, only cost editability + the "manual" evidence-source label.
//    A row that WAS originally imported (`import_batch_id IS NOT NULL`) is
//    replayed via the import-insert builder (`buildDividendManualRecordImportInsertStatements`,
//    the only path that preserves those fields and sets batch attribution),
//    matching its own original non-editable status. The `superseded_by_
//    record_id` link-up pass runs identically afterward regardless of which
//    path created either end of a chain link (mixed chains -- e.g. a manual
//    ancestor later reconciled by an imported successor, DIV-016 part C --
//    replay correctly either way).
import { randomUUID } from "node:crypto";
import {
  canonicalBundleJson,
  MAX_BUNDLE_ENTITIES,
  MAX_BUNDLE_REQUEST_BYTES,
  PORTFOLIO_BUNDLE_PARSER_FORMAT,
  PORTFOLIO_BUNDLE_SCHEMA_VERSION,
  sha256Hex,
  validatePortfolioBundle,
  validateTransaction,
  validateDividendManualRecord,
  validateDividendSecurityAssumption,
  validateDividendPortfolioAssumption,
  validateDividendFyOverride,
  validateDividendEventOverride,
  validateDividendImportFrankingOverride,
  validateWhatifScenario,
  type BundleTransaction,
  type BundleDividendManualRecord,
  type BundleDividendSecurityAssumption,
  type BundleDividendPortfolioAssumption,
  type BundleDividendFyOverride,
  type BundleDividendEventOverride,
  type BundleDividendImportFrankingOverride,
  type BundleWhatifScenario,
  type PortfolioBundleV1,
} from "../domain/exports/portfolio-bundle.ts";
import { chainOrder } from "../domain/exports/chain-order.ts";
import { chunkRows } from "../domain/exports/chunk-rows.ts";
import { readPortfolioBundle } from "../db/repositories/portfolio-bundle.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  buildPortfolioCreationStatements,
  createOwnedPortfolioRepository,
  createOwnedUserSettingsRepository,
} from "../db/repositories/owned-portfolios.ts";
import { createOwnedSecurityResolutionRepository } from "../db/repositories/security-resolution.ts";
import { createOwnedLedgerRepository } from "../db/repositories/ledger.ts";
import {
  buildDividendManualRecordImportInsertStatements,
  createDividendAssumptionsRepository,
  createDividendEventOverrideRepository,
  createDividendFyOverrideRepository,
  createDividendImportFrankingOverrideRepository,
  createDividendManualRecordRepository,
} from "../db/repositories/dividends.ts";
import { createIncomeScenarioRepository } from "../db/repositories/income-scenarios.ts";
import { isValidCapitalEventInputRow } from "./income-whatif.ts";
import type { CapitalEventInput } from "../domain/dividends/projection.ts";
import type {
  LedgerSourceType,
  LedgerTransactionType,
} from "../domain/ledger/event-validation.ts";

const LEDGER_TRANSACTION_TYPES: readonly LedgerTransactionType[] = [
  "buy",
  "sell",
  "cash_deposit",
  "cash_withdrawal",
  "fee",
  "tax",
  "split",
  "opening_balance",
];
const LEDGER_SOURCE_TYPES: readonly LedgerSourceType[] = [
  "manual",
  "csv_import",
  "broker_sync",
  "provider",
  "system",
];
function asLedgerTransactionType(value: string): LedgerTransactionType | null {
  return (LEDGER_TRANSACTION_TYPES as readonly string[]).includes(value)
    ? (value as LedgerTransactionType)
    : null;
}
function asLedgerSourceType(value: string): LedgerSourceType | null {
  return (LEDGER_SOURCE_TYPES as readonly string[]).includes(value)
    ? (value as LedgerSourceType)
    : null;
}

export type BundleServiceContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

export type BundleServiceFailure = {
  ok: false;
  status: 400 | 404 | 409 | 413;
  message: string;
};

export type BundlePreview = {
  idempotent: boolean;
  existingPortfolioId: string | null;
  portfolioName: string;
  portfolioCode: string;
  baseCurrencyMismatch: boolean;
  ownerHomeCurrencyCode: string;
  bundleBaseCurrencyCode: string;
  counts: {
    securities: number;
    transactions: number;
    dividendManualRecords: number;
    dividendSecurityAssumptions: number;
    dividendFyOverrides: number;
    dividendEventOverrides: number;
    dividendImportFrankingOverrides: number;
    whatifScenarios: number;
  };
};

export type BundleCommitResult = {
  idempotent: boolean;
  portfolioId: string;
  portfolioName: string;
  counts: BundlePreview["counts"];
  securitiesCreated: number;
  securitiesMatched: number;
  skippedDividendEventOverrides: number;
};

function totalCounts(bundle: PortfolioBundleV1): BundlePreview["counts"] {
  return {
    securities: bundle.securities.length,
    transactions: bundle.transactions.length,
    dividendManualRecords: bundle.dividendManualRecords.length,
    dividendSecurityAssumptions: bundle.dividendSecurityAssumptions.length,
    dividendFyOverrides: bundle.dividendFyOverrides.length,
    dividendEventOverrides: bundle.dividendEventOverrides.length,
    dividendImportFrankingOverrides:
      bundle.dividendImportFrankingOverrides.length,
    whatifScenarios: bundle.whatifScenarios.length,
  };
}

/** Mirrors `validatePortfolioBundle`'s own entity sum exactly (the
 * `securities` count matches too -- the import-side check counts every
 * entity kind it validates; the export-side check below applies the SAME
 * sum so an owner learns at EXPORT time, not only on a later failed
 * import, that a portfolio is too large for this bundle format. Fold-in
 * follow-up from the reviewer's B7 finding. */
function totalEntityCount(bundle: PortfolioBundleV1): number {
  const counts = totalCounts(bundle);
  return (
    counts.securities +
    counts.transactions +
    counts.dividendManualRecords +
    counts.dividendSecurityAssumptions +
    counts.dividendFyOverrides +
    counts.dividendEventOverrides +
    counts.dividendImportFrankingOverrides +
    counts.whatifScenarios
  );
}

async function findExistingBatch(
  client: SqlClient,
  userId: string,
  fileSha256: string,
): Promise<
  { id: string; status: string; targetPortfolioId: string | null } | undefined
> {
  const row = await client.get<Record<string, unknown>>(
    `SELECT id, status, target_portfolio_id FROM import_batches
     WHERE user_id = ? AND file_sha256 = ? AND parser_format = ? AND parser_version = ?
     LIMIT 1`,
    [
      userId,
      fileSha256,
      PORTFOLIO_BUNDLE_PARSER_FORMAT,
      String(PORTFOLIO_BUNDLE_SCHEMA_VERSION),
    ],
  );
  return row
    ? {
        id: String(row.id),
        status: String(row.status),
        targetPortfolioId:
          row.target_portfolio_id === null
            ? null
            : String(row.target_portfolio_id),
      }
    : undefined;
}

/** Exported for `tests/exp-001.test.ts` -- computes the same fingerprint
 * used for idempotent-re-import detection, over the SAME canonical bytes
 * both directions use. */
export async function fingerprintBundle(bundle: unknown): Promise<string> {
  return (await fingerprintBundleWithByteLength(bundle)).fingerprint;
}

/**
 * EXP-004 correction: the fingerprint AND the bundle's serialized byte size
 * (`import_batches.byte_size`) from ONE canonicalisation pass, so a caller
 * needing both stops serialising the same bundle twice per request.
 *
 * `byteLength` is UNCHANGED in meaning: `canonicalBundleJson`'s `sortKeysDeep`
 * only REORDERS object keys -- it adds, drops and rewrites nothing -- so the
 * canonical form's UTF-8 length is byte-for-byte the same number
 * `new TextEncoder().encode(JSON.stringify(bundle)).length` produced before
 * (pinned by `tests/exp-004.test.ts`'s byte-length equality test). The
 * FINGERPRINT is likewise unchanged: it is still `sha256Hex` over exactly
 * `canonicalBundleJson(bundle)`, the frozen input every existing
 * `bundle:<fingerprint>:<ref>` idempotency key in a live account was derived
 * from.
 */
export async function fingerprintBundleWithByteLength(
  bundle: unknown,
): Promise<{ fingerprint: string; byteLength: number }> {
  const canonical = canonicalBundleJson(bundle);
  return {
    fingerprint: await sha256Hex(canonical),
    byteLength: new TextEncoder().encode(canonical).length,
  };
}

export async function exportPortfolioBundle(
  ctx: BundleServiceContext,
  portfolioId: string,
): Promise<{ ok: true; bundle: PortfolioBundleV1 } | BundleServiceFailure> {
  const ownedRow = await ctx.client.get<{ id: string }>(
    "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
    [portfolioId, ctx.userId],
  );
  if (!ownedRow)
    return { ok: false, status: 404, message: "Portfolio was not found." };
  const bundle = await readPortfolioBundle(
    ctx.client,
    ctx.userId,
    portfolioId,
    new Date().toISOString(),
  );
  if (totalEntityCount(bundle) > MAX_BUNDLE_ENTITIES) {
    // B7 fold-in follow-up (reviewer): warn/fail honestly at EXPORT time
    // too, using the same cap and the same honest ("not restorable this
    // way", no fabricated merge/split remedy) wording `validatePortfolioBundle`
    // uses on the import side -- an owner should learn this before
    // downloading a file that can never be restored, not only after.
    return {
      ok: false,
      status: 413,
      message: `This portfolio has ${totalEntityCount(bundle)} bundle entries, over the ${MAX_BUNDLE_ENTITIES} this app version can restore from a bundle. Export succeeded in reading the data, but the resulting file would not be restorable.`,
    };
  }
  return { ok: true, bundle };
}

export async function previewPortfolioBundleImport(
  ctx: BundleServiceContext,
  raw: unknown,
): Promise<{ ok: true; preview: BundlePreview } | BundleServiceFailure> {
  const validation = validatePortfolioBundle(raw);
  if (!validation.ok)
    return { ok: false, status: 400, message: validation.message };
  const bundle = validation.bundle;
  const fingerprint = await fingerprintBundle(bundle);
  const existing = await findExistingBatch(ctx.client, ctx.userId, fingerprint);
  const settings = await createOwnedUserSettingsRepository(ctx.client).get(
    ctx.userId,
  );
  if (!settings) {
    return {
      ok: false,
      status: 404,
      message: "Account settings were not found.",
    };
  }
  return {
    ok: true,
    preview: {
      idempotent: existing?.status === "committed",
      existingPortfolioId:
        existing?.status === "committed" ? existing.targetPortfolioId : null,
      portfolioName: bundle.portfolio.name,
      portfolioCode: bundle.portfolio.code,
      baseCurrencyMismatch:
        settings.homeCurrencyCode !== bundle.portfolio.baseCurrencyCode,
      ownerHomeCurrencyCode: settings.homeCurrencyCode,
      bundleBaseCurrencyCode: bundle.portfolio.baseCurrencyCode,
      counts: totalCounts(bundle),
    },
  };
}

export async function commitPortfolioBundleImport(
  ctx: BundleServiceContext,
  raw: unknown,
  filename: string,
  bundleByteLength: number,
): Promise<{ ok: true; result: BundleCommitResult } | BundleServiceFailure> {
  const validation = validatePortfolioBundle(raw);
  if (!validation.ok)
    return { ok: false, status: 400, message: validation.message };
  const bundle = validation.bundle;
  const fingerprint = await fingerprintBundle(bundle);

  const settings = await createOwnedUserSettingsRepository(ctx.client).get(
    ctx.userId,
  );
  if (!settings) {
    return {
      ok: false,
      status: 404,
      message: "Account settings were not found.",
    };
  }
  if (settings.homeCurrencyCode !== bundle.portfolio.baseCurrencyCode) {
    return {
      ok: false,
      status: 409,
      message:
        `This bundle's portfolio is in ${bundle.portfolio.baseCurrencyCode}, but your account's home currency is ` +
        `${settings.homeCurrencyCode}. Change your home currency to ${bundle.portfolio.baseCurrencyCode} in Settings, ` +
        `then re-import.`,
    };
  }

  const existing = await findExistingBatch(ctx.client, ctx.userId, fingerprint);
  if (
    existing &&
    existing.status === "committed" &&
    existing.targetPortfolioId
  ) {
    const portfolioRow = await ctx.client.get<{ name: string }>(
      "SELECT name FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
      [existing.targetPortfolioId, ctx.userId],
    );
    return {
      ok: true,
      result: {
        idempotent: true,
        portfolioId: existing.targetPortfolioId,
        portfolioName: portfolioRow?.name ?? bundle.portfolio.name,
        counts: totalCounts(bundle),
        securitiesCreated: 0,
        securitiesMatched: 0,
        skippedDividendEventOverrides: 0,
      },
    };
  }
  const now = new Date().toISOString();
  let batchId: string;
  if (existing && existing.status !== "committed") {
    // B2 fix (reviewer): a failed/still-committing batch previously 409'd
    // EVERY retry forever -- the `(user_id, file_sha256, parser_format,
    // parser_version)` unique index makes a fresh `INSERT` for the same
    // bundle fingerprint impossible, so the old "archive the partial
    // portfolio and re-import" remedy could never actually run (the retry
    // never got past this check). Reuse and reset the existing row instead:
    // a fresh `target_portfolio_id` (the new attempt creates its OWN
    // destination portfolio below; any portfolio the failed attempt already
    // created is simply orphaned, left for the owner to archive manually)
    // and `status` back to `committing`. This is safe because every
    // transaction/dividend idempotency key this module derives is scoped to
    // the (freshly created) target `portfolio_id` (`ledger.post`'s
    // `getByIdempotency` filters on `portfolio_id`; `dividend_manual_
    // records`' natural keys are portfolio-scoped too) -- replaying into a
    // brand-new portfolio on retry can never collide with anything the
    // failed attempt already wrote.
    batchId = existing.id;
    await ctx.client.run(
      `UPDATE import_batches SET status = 'committing', target_portfolio_id = NULL,
        filename = ?, byte_size = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [filename.slice(0, 255), bundleByteLength, now, batchId, ctx.userId],
    );
  } else {
    batchId = randomUUID();
    try {
      await ctx.client.run(
        `INSERT INTO import_batches (
          id, user_id, parser_format, parser_version, filename, byte_size,
          file_sha256, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'committing', ?, ?)`,
        [
          batchId,
          ctx.userId,
          PORTFOLIO_BUNDLE_PARSER_FORMAT,
          String(PORTFOLIO_BUNDLE_SCHEMA_VERSION),
          filename.slice(0, 255),
          bundleByteLength,
          fingerprint,
          now,
          now,
        ],
      );
    } catch {
      // A genuine race: two concurrent commit calls for the same NEW
      // bundle. Never reachable for a failed/committing retry any more
      // (handled by the branch above), so this stays a real conflict.
      return {
        ok: false,
        status: 409,
        message: "This bundle is already being imported. Try again shortly.",
      };
    }
  }

  // Create the destination portfolio, retrying on a `code` collision (the
  // exported code may already be taken by another of this owner's
  // portfolios) -- mirrors `createPortfolioAction`'s own error handling.
  const portfolios = createOwnedPortfolioRepository(ctx.client, undefined, {
    requestId: ctx.requestId,
  });
  let portfolio = null;
  let code = bundle.portfolio.code;
  for (let attempt = 0; attempt < 5 && !portfolio; attempt += 1) {
    try {
      portfolio = await portfolios.create(ctx.userId, {
        code,
        name: bundle.portfolio.name,
        timezone: bundle.portfolio.timezone,
        accountingMethod:
          bundle.portfolio.accountingMethod === "fifo" ? "fifo" : undefined,
        historyCompleteFrom: bundle.portfolio.historyCompleteFrom,
      });
    } catch {
      code = `${bundle.portfolio.code}-restored${attempt > 0 ? `-${attempt + 1}` : ""}`;
    }
  }
  if (!portfolio) {
    await ctx.client.run(
      "UPDATE import_batches SET status = 'failed', updated_at = ? WHERE id = ? AND user_id = ?",
      [now, batchId, ctx.userId],
    );
    return {
      ok: false,
      status: 409,
      message: "A destination portfolio could not be created for this bundle.",
    };
  }
  const portfolioId = portfolio.id;
  await ctx.client.run(
    "UPDATE import_batches SET target_portfolio_id = ? WHERE id = ? AND user_id = ?",
    [portfolioId, batchId, ctx.userId],
  );

  if (bundle.portfolioSettings.quoteStalenessPolicy !== null) {
    await ctx.client.run(
      `INSERT INTO portfolio_settings (
        portfolio_id, user_id, quote_staleness_policy, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, 1)`,
      [
        portfolioId,
        ctx.userId,
        bundle.portfolioSettings.quoteStalenessPolicy,
        now,
        now,
      ],
    );
  }

  // --- Securities: resolve-or-create via the SAME create-if-absent
  // machinery BRK-009B's Sharesight auto-resolution uses.
  const securityResolution = createOwnedSecurityResolutionRepository(
    ctx.client,
  );
  const securityRefToId = new Map<string, string>();
  let securitiesCreated = 0;
  let securitiesMatched = 0;
  for (const security of bundle.securities) {
    const result = await securityResolution.resolveAndLink(
      ctx.userId,
      {
        symbol: security.tickerIdentifier ?? security.sourceSymbol,
        exchangeAlias: security.sourceExchangeAlias,
        currencyCode: security.sourceCurrencyCode,
        sharesightInstrumentId: security.sharesightInstrumentId,
        isin: security.isinIdentifier,
        instrumentName:
          security.canonicalName ??
          security.sourceName ??
          security.sourceSymbol,
      },
      {
        portfolioId,
        sourceSymbol: security.sourceSymbol,
        sourceExchangeAlias: security.sourceExchangeAlias,
        sourceCurrencyCode: security.sourceCurrencyCode,
      },
    );
    if (!result.ok) {
      await ctx.client.run(
        "UPDATE import_batches SET status = 'failed', updated_at = ? WHERE id = ? AND user_id = ?",
        [new Date().toISOString(), batchId, ctx.userId],
      );
      return {
        ok: false,
        status: 409,
        message: `Security "${security.sourceSymbol}" could not be resolved (${result.reason}).`,
      };
    }
    securityRefToId.set(security.ref, result.portfolioSecurityId);
    if (result.created) securitiesCreated += 1;
    else securitiesMatched += 1;

    // B5 fix (reviewer): `resolveAndLink` always inserts a fresh
    // `portfolio_securities` row with `status = 'held'` and every display/
    // relevant-date column NULL -- restoring the bundle's own exported
    // values here is what makes a hidden/watch-only security, or a
    // display-name override, or a first/last-relevant-date bound, actually
    // survive a restore rather than silently reverting to defaults (e.g. a
    // hidden security wrongly reappearing in Holdings). `status` is the one
    // exception: `'unresolved'` requires `security_id IS NULL`
    // (`portfolio_securities_resolution_check`), which `resolveAndLink`'s
    // result structurally can never produce (it always resolves/creates a
    // real `security_id`) -- an originally-`unresolved` row is left at
    // whatever status the fresh link naturally has (`held`), documented in
    // `docs/BACKUP_FORMAT.md`, since restoring the literal value would
    // violate that CHECK constraint.
    await ctx.client.run(
      `UPDATE portfolio_securities
       SET status = ?, display_symbol = ?, display_name = ?,
           first_relevant_date = ?, last_relevant_date = ?
       WHERE id = ? AND user_id = ? AND portfolio_id = ?`,
      [
        security.status === "unresolved" ? "held" : security.status,
        security.displaySymbol,
        security.displayName,
        security.firstRelevantDate,
        security.lastRelevantDate,
        result.portfolioSecurityId,
        ctx.userId,
        portfolioId,
      ],
    );
  }

  // --- Transactions: replay in chain-safe order (ancestors strictly
  // before successors -- see `chainOrder`'s header comment for why a plain
  // `createdAt` sort is unsafe).
  const ledger = createOwnedLedgerRepository(ctx.client);
  const txRefToId = new Map<string, string>();
  const orderedTransactions = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  );
  for (const tx of orderedTransactions) {
    const securityId = tx.securityRef
      ? (securityRefToId.get(tx.securityRef) ?? null)
      : null;
    if (tx.securityRef && !securityId) {
      return commitFailure(
        ctx,
        batchId,
        `Transaction references a security that failed to resolve.`,
      );
    }
    const derivedKey = `bundle:${fingerprint}:${tx.ref}`;
    const transactionType = asLedgerTransactionType(tx.type);
    if (!transactionType) {
      return commitFailure(
        ctx,
        batchId,
        `Transaction has an unsupported type "${tx.type}".`,
      );
    }
    if (tx.reversesRef !== null) {
      const targetId = txRefToId.get(tx.reversesRef);
      if (!targetId) {
        return commitFailure(
          ctx,
          batchId,
          "A reversal's original transaction was not replayed first.",
        );
      }
      const result = await ledger.reverse(
        ctx.userId,
        portfolioId,
        targetId,
        derivedKey,
        ctx.requestId,
      );
      if (!result.ok) {
        return commitFailure(
          ctx,
          batchId,
          `A transaction reversal could not be replayed (${result.reason}).`,
        );
      }
      txRefToId.set(tx.ref, result.transaction.id);
      continue;
    }
    if (tx.supersedesRef !== null) {
      const targetId = txRefToId.get(tx.supersedesRef);
      if (!targetId) {
        return commitFailure(
          ctx,
          batchId,
          "A supersession's original transaction was not replayed first.",
        );
      }
      const result = await ledger.supersede(ctx.userId, portfolioId, targetId, {
        portfolioId,
        type: transactionType,
        portfolioSecurityId: securityId,
        quantityDecimal: tx.quantityDecimal,
        unitPriceDecimal: tx.unitPriceDecimal,
        grossAmountDecimal: tx.grossAmountDecimal,
        feeAmountDecimal: tx.feeAmountDecimal,
        taxAmountDecimal: tx.taxAmountDecimal,
        fxRateToBaseDecimal: tx.fxRateToBaseDecimal,
        // B4 fix (reviewer): a supersession successor is a real owner
        // correction with its own meaningful source (e.g. `manual`,
        // user-visible in the app's Source labels) -- unlike a REVERSAL
        // (always a system-generated mirror, hardcoded `system` by
        // `ledger.reverse()` itself), a supersession must preserve the
        // bundle's own recorded truth rather than overwrite it.
        sourceType: asLedgerSourceType(tx.sourceType) ?? "system",
        sourceReference: tx.sourceReference,
        idempotencyKey: derivedKey,
        tradeAt: tx.tradeAt,
        localTradeDate: tx.localTradeDate,
        settlementDate: tx.settlementDate,
        currencyCode: tx.currencyCode,
        fxRateSource: tx.fxRateSource,
        fxObservedAt: tx.fxObservedAt,
        requestId: ctx.requestId,
      });
      if (!result.ok) {
        return commitFailure(
          ctx,
          batchId,
          `A transaction supersession could not be replayed (${result.reason}).`,
        );
      }
      txRefToId.set(tx.ref, result.transaction.id);
      continue;
    }
    const sourceType = asLedgerSourceType(tx.sourceType);
    if (!sourceType) {
      return commitFailure(
        ctx,
        batchId,
        `Transaction has an unsupported source type "${tx.sourceType}".`,
      );
    }
    const result = await ledger.post(ctx.userId, {
      portfolioId,
      type: transactionType,
      portfolioSecurityId: securityId,
      quantityDecimal: tx.quantityDecimal,
      unitPriceDecimal: tx.unitPriceDecimal,
      grossAmountDecimal: tx.grossAmountDecimal,
      feeAmountDecimal: tx.feeAmountDecimal,
      taxAmountDecimal: tx.taxAmountDecimal,
      fxRateToBaseDecimal: tx.fxRateToBaseDecimal,
      sourceType,
      sourceReference: tx.sourceReference,
      idempotencyKey: derivedKey,
      tradeAt: tx.tradeAt,
      localTradeDate: tx.localTradeDate,
      settlementDate: tx.settlementDate,
      currencyCode: tx.currencyCode,
      fxRateSource: tx.fxRateSource,
      fxObservedAt: tx.fxObservedAt,
      requestId: ctx.requestId,
    });
    if (!result.ok) {
      return commitFailure(
        ctx,
        batchId,
        `A transaction could not be replayed (${result.reason}).`,
      );
    }
    txRefToId.set(tx.ref, result.transaction.id);
  }

  // --- Dividend manual records: full chains. B3 fix (reviewer): a row that
  // was ORIGINALLY manual (`wasImported === false`) replays via the SAME
  // owner-dialog `create()` repository the manual-entry UI itself uses
  // (`import_batch_id` stays NULL, keeping the row editable exactly like
  // its source); a row that was ORIGINALLY imported replays via the
  // import-insert builder (batch-attributed, matching its own original
  // non-editable status). `create()`/`supersede()` never write the BRK-010
  // foreign-currency fields, so a manual row can never have carried them --
  // this loses no fidelity. `superseded_by_record_id` is wired with a
  // follow-up UPDATE once both ends of a chain link have been created,
  // regardless of which path created either end (mixed chains replay
  // correctly).
  const manualRecords = createDividendManualRecordRepository(ctx.client);
  const divRefToId = new Map<string, string>();
  const orderedDividends = chainOrder(
    bundle.dividendManualRecords,
    (record) => record.supersedesRef,
  );
  for (const record of orderedDividends) {
    const securityId = securityRefToId.get(record.securityRef);
    if (!securityId) {
      return commitFailure(
        ctx,
        batchId,
        "A dividend record references a security that failed to resolve.",
      );
    }
    const id = randomUUID();
    if (record.wasImported) {
      const insert = buildDividendManualRecordImportInsertStatements({
        id,
        userId: ctx.userId,
        portfolioId,
        portfolioSecurityId: securityId,
        paymentDate: record.paymentDate,
        sharesDecimal: record.sharesDecimal,
        dividendPerShareDecimal: record.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
        totalCashDecimal: record.totalCashDecimal,
        totalFrankingDecimal: record.totalFrankingDecimal,
        currencyCode: record.currencyCode,
        fxRateToPortfolioDecimal: record.fxRateToPortfolioDecimal,
        fxRateSource: record.fxRateSource,
        importBatchId: batchId,
        sourceReference:
          record.sourceReference ?? `bundle:${fingerprint}:${record.ref}`,
        requestId: ctx.requestId,
        now: new Date().toISOString(),
      });
      if (!insert.ok) {
        return commitFailure(
          ctx,
          batchId,
          "A dividend record could not be replayed (invalid amounts).",
        );
      }
      await ctx.client.batch(insert.statements);
      divRefToId.set(record.ref, insert.id);
    } else {
      const saved = await manualRecords.create(ctx.userId, portfolioId, {
        id,
        portfolioSecurityId: securityId,
        paymentDate: record.paymentDate,
        sharesDecimal: record.sharesDecimal,
        dividendPerShareDecimal: record.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
        totalCashDecimal: record.totalCashDecimal,
        totalFrankingDecimal: record.totalFrankingDecimal,
        requestId: ctx.requestId,
      });
      if (!saved.ok) {
        return commitFailure(
          ctx,
          batchId,
          "A dividend record could not be replayed (invalid amounts).",
        );
      }
      divRefToId.set(record.ref, saved.record.id);
    }
  }
  for (const record of orderedDividends) {
    if (record.supersedesRef === null) continue;
    const oldId = divRefToId.get(record.supersedesRef);
    const newId = divRefToId.get(record.ref);
    if (!oldId || !newId) {
      return commitFailure(
        ctx,
        batchId,
        "A dividend record's supersession chain could not be linked.",
      );
    }
    await ctx.client.run(
      `UPDATE dividend_manual_records SET superseded_by_record_id = ?
       WHERE id = ? AND user_id = ? AND portfolio_id = ?`,
      [newId, oldId, ctx.userId, portfolioId],
    );
  }
  // B1 fix (reviewer, tombstone resurrection): a row whose original
  // successor was head-deleted (`supersededByDeletedRecord`, see
  // `db/repositories/portfolio-bundle.ts`'s export-side comment) must stay
  // permanently excluded from evidence on import too -- recreate that
  // exclusion by pointing `superseded_by_record_id` at a fresh, genuinely
  // non-existent id (the column carries no FK constraint -- see
  // `db/schema.ts`'s `dividendManualRecords` header comment -- so this is
  // exactly the same "dangling pointer, permanently excluded, never
  // resurrected" shape the original tombstone had). Never zero, never
  // silently live: a real financial exclusion the source portfolio made.
  for (const record of orderedDividends) {
    if (!record.supersededByDeletedRecord) continue;
    const ownId = divRefToId.get(record.ref);
    if (!ownId) {
      return commitFailure(
        ctx,
        batchId,
        "A dividend record's tombstone exclusion could not be replayed.",
      );
    }
    await ctx.client.run(
      `UPDATE dividend_manual_records SET superseded_by_record_id = ?
       WHERE id = ? AND user_id = ? AND portfolio_id = ?`,
      [randomUUID(), ownId, ctx.userId, portfolioId],
    );
  }

  // --- Per-security assumptions (+ force flags).
  const assumptions = createDividendAssumptionsRepository(ctx.client);
  for (const item of bundle.dividendSecurityAssumptions) {
    const securityId = securityRefToId.get(item.securityRef);
    if (!securityId) continue;
    const saved = await assumptions.saveSecurityAssumptions(
      ctx.userId,
      portfolioId,
      securityId,
      {
        dividendYieldPercentDecimal: item.dividendYieldPercentDecimal,
        frankingPercentDecimal: item.frankingPercentDecimal,
        dividendGrowthPercentDecimal: item.dividendGrowthPercentDecimal,
        forceAssumption: item.forceAssumption ?? false,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        batchId,
        "A per-security assumption could not be replayed.",
      );
    }
  }
  if (bundle.dividendPortfolioAssumption) {
    const saved = await assumptions.savePortfolioAssumptions(
      ctx.userId,
      portfolioId,
      {
        valueGrowthPercentDecimal:
          bundle.dividendPortfolioAssumption.valueGrowthPercentDecimal,
        portfolioDividendGrowthPercentDecimal:
          bundle.dividendPortfolioAssumption
            .portfolioDividendGrowthPercentDecimal,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        batchId,
        "The portfolio-level assumption could not be replayed.",
      );
    }
  }

  // --- FY overrides.
  const fyOverrides = createDividendFyOverrideRepository(ctx.client);
  for (const item of bundle.dividendFyOverrides) {
    const saved = await fyOverrides.save(
      ctx.userId,
      portfolioId,
      item.financialYearEndingYear,
      {
        grossedAmountDecimal: item.grossedAmountDecimal,
        frankingAmountDecimal: item.frankingAmountDecimal,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        batchId,
        "An FY override could not be replayed.",
      );
    }
  }

  // --- Dividend event overrides (tied to the SHARED `dividend_events`
  // table -- verified to still exist before replay; a bundle imported on a
  // different deployment, or long after the provider event aged out, may
  // legitimately no longer find it, in which case the override is honestly
  // skipped and counted, never silently fabricated against a different
  // event).
  const eventOverrides = createDividendEventOverrideRepository(ctx.client);
  let skippedDividendEventOverrides = 0;
  for (const item of bundle.dividendEventOverrides) {
    const securityId = securityRefToId.get(item.securityRef);
    if (!securityId) continue;
    const eventRow = await ctx.client.get<{ id: string }>(
      "SELECT id FROM dividend_events WHERE id = ? LIMIT 1",
      [item.dividendEventId],
    );
    if (!eventRow) {
      skippedDividendEventOverrides += 1;
      continue;
    }
    const saved = await eventOverrides.save(
      ctx.userId,
      portfolioId,
      securityId,
      item.dividendEventId,
      {
        sharesDecimal: item.sharesDecimal,
        dividendPerShareDecimal: item.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: item.frankingCreditPerShareDecimal,
        exclude: item.exclude,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        batchId,
        "A dividend event override could not be replayed.",
      );
    }
  }

  // --- BRK-011 franking overrides (tied to this bundle's own replayed
  // dividend records).
  const frankingOverrides = createDividendImportFrankingOverrideRepository(
    ctx.client,
  );
  for (const item of bundle.dividendImportFrankingOverrides) {
    const securityId = securityRefToId.get(item.securityRef);
    const recordId = divRefToId.get(item.dividendManualRecordRef);
    if (!securityId || !recordId) {
      return commitFailure(
        ctx,
        batchId,
        "A franking override references a record that failed to replay.",
      );
    }
    const saved = await frankingOverrides.save(
      ctx.userId,
      portfolioId,
      securityId,
      recordId,
      {
        frankingTotalDecimal: item.frankingTotalDecimal,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        batchId,
        "A franking override could not be replayed.",
      );
    }
  }

  // --- Saved what-if scenarios.
  const scenarios = createIncomeScenarioRepository(ctx.client);
  for (const scenario of bundle.whatifScenarios) {
    let rows: CapitalEventInput[];
    try {
      const parsed: unknown = JSON.parse(scenario.capitalRowsJson);
      rows = Array.isArray(parsed)
        ? parsed.filter((row): row is CapitalEventInput =>
            isValidCapitalEventInputRow(row),
          )
        : [];
    } catch {
      rows = [];
    }
    const saved = await scenarios.save(ctx.userId, portfolioId, {
      name: scenario.name,
      rows,
      reinvestDividends: scenario.reinvestDividends,
      valueGrowthPercentDecimal: scenario.valueGrowthPercentDecimal,
      dividendGrowthPercentDecimal: scenario.dividendGrowthPercentDecimal,
      requestId: ctx.requestId,
    });
    if (!saved.ok) {
      return commitFailure(
        ctx,
        batchId,
        "A saved what-if scenario could not be replayed.",
      );
    }
  }

  // EXP-002 review (B2 ruling): an ARCHIVED source portfolio is restored
  // archived too -- LAST, after every other write, so the full ledger/
  // dividend/assumption/scenario replay above runs through the exact same
  // write paths an active restore uses (nothing in this codebase's
  // repositories checks portfolio status before writing). `resolveAndLink`/
  // `ledger.post`/etc. never touch `portfolios.version`, so a fresh read
  // immediately before archiving is the current value regardless of how
  // many rows were replayed above.
  if (bundle.portfolio.status === "archived") {
    const currentPortfolio = await ctx.client.get<{ version: number }>(
      "SELECT version FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
      [portfolioId, ctx.userId],
    );
    if (!currentPortfolio) {
      return commitFailure(
        ctx,
        batchId,
        "The restored portfolio could not be found to archive it.",
      );
    }
    const archived = await portfolios.archive(ctx.userId, portfolioId, {
      expectedVersion: currentPortfolio.version,
    });
    if (!archived.ok) {
      return commitFailure(
        ctx,
        batchId,
        "The restored portfolio could not be archived to match its exported status.",
      );
    }
  }

  await ctx.client.run(
    `UPDATE import_batches SET status = 'committed', committed_at = ?, updated_at = ?,
      total_rows = ?, transaction_rows = ?
     WHERE id = ? AND user_id = ?`,
    [
      new Date().toISOString(),
      new Date().toISOString(),
      bundle.transactions.length + bundle.dividendManualRecords.length,
      bundle.transactions.length,
      batchId,
      ctx.userId,
    ],
  );

  return {
    ok: true,
    result: {
      idempotent: false,
      portfolioId,
      portfolioName: portfolio.name,
      counts: totalCounts(bundle),
      securitiesCreated,
      securitiesMatched,
      skippedDividendEventOverrides,
    },
  };
}

async function commitFailure(
  ctx: BundleServiceContext,
  batchId: string,
  message: string,
): Promise<BundleServiceFailure> {
  await ctx.client.run(
    "UPDATE import_batches SET status = 'failed', updated_at = ? WHERE id = ? AND user_id = ?",
    [new Date().toISOString(), batchId, ctx.userId],
  );
  return { ok: false, status: 409, message };
}

// ---------------------------------------------------------------------------
// EXP-004: a RESUMABLE, CHUNKED alternative to `commitPortfolioBundleImport`
// above, used ONLY by the system-backup restore's core phase
// (`app/system-backup-service.ts`). `commitPortfolioBundleImport` itself is
// UNCHANGED and stays the single-shot path for EXP-001's own standalone
// per-portfolio bundle import UI (`app/portfolio-bundle-actions.ts`), which
// has no CPU-budget problem at its own (much smaller, one-portfolio-at-a-
// time, interactively-triggered) scale.
//
// The production incident this exists to fix: a Cloudflare Workers Free
// plan's 10ms-CPU-per-request budget was exhausted PARTWAY through
// `commitSystemBackupImport`'s single request for one portfolio with 107
// transactions + 119 dividend records, at transaction #63 -- an HTTP 500
// with real partial rows already committed and no way to resume other than
// starting the whole portfolio over.
//
// KEY DESIGN DIFFERENCE from `commitPortfolioBundleImport`'s own retry
// handling: that function treats ANY non-`committed` `import_batches` row as
// an ABANDONED attempt (resets `target_portfolio_id` to NULL and creates a
// FRESH destination portfolio on retry -- safe there because a single-shot
// commit can never leave real transaction/dividend progress on a
// `committing` batch). Here, `committing` is the NORMAL state BETWEEN parts,
// by design -- real rows legitimately exist on the current target portfolio
// between requests. So `commitPortfolioBundleScaffold` below REUSES an
// existing `target_portfolio_id` whenever one is recorded (never resets it),
// and every part identifies rows purely by a deterministic, DB-derivable key
// (`bundle:<fingerprint>:<ref>`) rather than an in-process ref->id `Map` --
// no such map could survive a Worker request boundary anyway. This is also
// exactly why this module never accumulates a "leftover portfolio" the way
// the single-shot path's B1 archival logic does: there is no discarded
// attempt to archive, because a resume always continues the SAME portfolio.
//
// RESUME EVIDENCE (corrected 2026-09-03, OPS-005 rounds 1-2 -- this
// paragraph originally described a count/slice protocol as the resume
// mechanism and claimed it could "never skip real, unwritten rows"; that
// claim was disproven by BUG-018 round 3 and OPS-005 round 1, where a chain-
// order change across a deploy made a stale client-side re-slice skip real
// rows. It is replaced below with the ref-membership mechanism that fixed
// it.): `commitPortfolioBundleScaffold` computes `missingTransactionRefs`/
// `missingDividendRefs` server-side, in the bundle's CURRENT chain order, by
// checking which `bundle:<fingerprint>:<ref>` idempotency keys do not yet
// exist under this bundle's own namespace -- never a client-claimed cursor
// or count. The caller (browser) sends back exactly those refs, in that
// order; it never re-derives or slices an order of its own. At finalize,
// this module cross-checks the CALLER-supplied ref list against the sorted-
// ref digests and counts persisted on `import_batches` at scaffold time
// (migration `0061`) and separately probes existence for every ref named in
// the request, failing closed (409) on any mismatch or missing row -- so a
// short, stale, or reordered client ref list can never be silently accepted
// as complete. `committedTransactionCount`/`committedDividendCount` remain
// live counts, kept only as an informational/diagnostic figure now that the
// refs above are the actual resume mechanism.
// ---------------------------------------------------------------------------

export type BundleScaffoldSecurity = {
  ref: string;
  portfolioSecurityId: string;
};

export type BundleScaffoldResult = {
  /** true only when this EXACT bundle (by fingerprint) was already fully
   * committed by an earlier attempt -- the caller must skip every
   * transactions/dividends/finalize part entirely for this portfolio. */
  idempotent: boolean;
  batchId: string;
  fingerprint: string;
  portfolioId: string;
  portfolioName: string;
  code: string;
  /** Empty when `idempotent` is true (nothing left for the caller to map). */
  securities: BundleScaffoldSecurity[];
  securitiesCreated: number;
  securitiesMatched: number;
  /** Live, server-derived resume evidence -- see this section's header
   * comment. When `idempotent` is true these equal the bundle's own full
   * counts. Kept as an informational/diagnostic figure; OPS-005 moved the
   * ACTUAL resume mechanism to `missingTransactionRefs` below, which is
   * immune to a chain-order change across a deploy (see that field's own
   * comment). */
  committedTransactionCount: number;
  committedDividendCount: number;
  /**
   * OPS-005: every transaction ref this bundle still needs written, in the
   * CURRENT (server-computed, always-live) chain order -- never a count to
   * be sliced against a client-side re-derivation of that order. Empty when
   * `idempotent` is true or when nothing remains. The caller (browser) maps
   * each ref back to its own copy of the bundle's transaction object and
   * sends exactly this list, in this order, to the transactions part(s) --
   * see `docs/BACKUP_FORMAT.md`'s "Resume evidence" section.
   */
  missingTransactionRefs: readonly string[];
  /**
   * OPS-005 round 2: the SAME mechanism as `missingTransactionRefs`, applied
   * to the dividend phase (`dividend_manual_records`'s own bundle
   * idempotency keys). Round 1 fixed only the transactions phase, leaving
   * the dividend phase resuming by `chainOrder(...).slice(committedDividendCount)`
   * -- a stale count sliced against whichever chain order the CURRENT
   * request happens to recompute, exactly the hazard round 1 closed for
   * transactions. `system-backup-panel.tsx` sends exactly this list, in this
   * order, to the dividend part(s).
   */
  missingDividendRefs: readonly string[];
};

/**
 * EXP-004 correction (production incident, 2026-08-31): the half-open byte
 * range covering exactly the keys one bundle replay writes,
 * `bundle:<fingerprint>:<ref>`.
 *
 * This MUST NOT be expressed as `idempotency_key LIKE 'bundle:<fp>:%'`.
 * SQLite caps a LIKE/GLOB pattern at `SQLITE_LIMIT_LIKE_PATTERN_LENGTH`, and
 * production D1 enforces the library DEFAULT of 50 bytes. This prefix is
 * `"bundle:"` (7) + a 64-hex-character sha256 digest + `":%"` (2) = 73 bytes,
 * so every such query fails on D1 with
 * `D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR` -- which is
 * exactly how the full-system restore's scaffold phase 500'd on every
 * production attempt. It is invisible to this repository's own test suite:
 * `node:sqlite` raises that same limit to 50,000, so the identical query
 * passes locally forever. Range comparison has no pattern limit at all.
 *
 * `;` is `:` + 1 in byte order (0x3B follows 0x3A), so
 * `>= "bundle:<fp>:"` AND `< "bundle:<fp>;"` matches every key beginning
 * with the prefix and nothing else -- including a SIBLING fingerprint that
 * shares the `bundle:` prefix, which the upper bound excludes. No
 * `idempotency_key` column declares a `COLLATE`, so SQLite's default BINARY
 * collation applies and the comparison is a true byte-order range; that also
 * makes it index-friendly on
 * `transactions_owner_portfolio_idempotency_unique`
 * (`user_id`, `portfolio_id`, `idempotency_key`).
 *
 * The switch is behaviour-preserving for real data: SQLite's LIKE is
 * ASCII-case-INSENSITIVE by default, while this range is case-sensitive, but
 * every key is written from this same lower-case template with a lower-case
 * hex digest (`sha256Hex` enforces `^[0-9a-f]+$`), so no key that LIKE
 * matched can fall outside the range.
 */
export function bundleKeyPrefixRange(fingerprint: string): {
  start: string;
  endExclusive: string;
} {
  return {
    start: `bundle:${fingerprint}:`,
    endExclusive: `bundle:${fingerprint};`,
  };
}

/**
 * OPS-005: the resume mechanism's core primitive -- a bounded, chunked,
 * owner-scoped existence probe over a bundle's own transaction/dividend
 * refs. Replaces the old "slice the chain-ordered array at a server-reported
 * COUNT" resume strategy, which silently dropped rows whenever the chain
 * order used to WRITE part 1 differed from the chain order used to compute
 * the resume slice (an ordering change straddling a deploy -- exactly what
 * BUG-018 round 2 did, and what round 3's doc correction flagged as an
 * unresolved hazard). A count is meaningful only against the specific order
 * that produced it; ref membership is not -- it depends only on what is
 * actually, durably written in the database right now.
 *
 * Returns the SUBSET of `refs` whose derived idempotency key
 * (`bundle:<fingerprint>:<ref>`) has NOT yet been written for this owner's
 * portfolio under this bundle's fingerprint namespace. Chunks the existence
 * lookup at <=50 keys per query -- an `IN (...)` list of 50 placeholders
 * plus the two scoping params is comfortably under SQLite/D1's default
 * bound-variable ceiling, and mirrors the 50-row dividend part size already
 * used elsewhere in this module.
 *
 * Generic apart from `table`: `dividend_manual_records`' unique index is
 * additionally scoped by `portfolio_security_id`
 * (`dividend_manual_records_security_idempotency_unique`), but a bundle's
 * refs are unique within the whole portfolio regardless of security, so a
 * plain `(user_id, portfolio_id, idempotency_key)` lookup -- identical in
 * shape to the transactions probe -- is exact here too; no per-security
 * scoping is needed for existence.
 */
async function listMissingRefsByIdempotencyKey(
  client: SqlClient,
  table: "transactions" | "dividend_manual_records",
  userId: string,
  portfolioId: string,
  fingerprint: string,
  refs: readonly string[],
): Promise<Set<string>> {
  const missing = new Set<string>(refs);
  const prefix = `bundle:${fingerprint}:`;
  for (const chunk of chunkRows(refs, 50)) {
    if (chunk.length === 0) continue;
    const keys = chunk.map((ref) => `${prefix}${ref}`);
    const placeholders = keys.map(() => "?").join(", ");
    const rows = await client.all<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM ${table}
       WHERE user_id = ? AND portfolio_id = ? AND idempotency_key IN (${placeholders})`,
      [userId, portfolioId, ...keys],
    );
    for (const row of rows) {
      missing.delete(row.idempotency_key.slice(prefix.length));
    }
  }
  return missing;
}

function listMissingTransactionRefs(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  fingerprint: string,
  refs: readonly string[],
): Promise<Set<string>> {
  return listMissingRefsByIdempotencyKey(
    client,
    "transactions",
    userId,
    portfolioId,
    fingerprint,
    refs,
  );
}

function listMissingDividendRefs(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  fingerprint: string,
  refs: readonly string[],
): Promise<Set<string>> {
  return listMissingRefsByIdempotencyKey(
    client,
    "dividend_manual_records",
    userId,
    portfolioId,
    fingerprint,
    refs,
  );
}

async function findTransactionIdByRef(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  fingerprint: string,
  ref: string,
): Promise<string | null> {
  const row = await client.get<{ id: string }>(
    `SELECT id FROM transactions WHERE user_id = ? AND portfolio_id = ? AND idempotency_key = ? LIMIT 1`,
    [userId, portfolioId, `bundle:${fingerprint}:${ref}`],
  );
  return row?.id ?? null;
}

/**
 * EXP-004: a transactions/dividends PART's `securities` field is browser-
 * supplied (echoed back from an earlier `commitPortfolioBundleScaffold`
 * response, held client-side across requests) -- unlike
 * `commitPortfolioBundleImport`'s own in-process `securityRefToId`, which is
 * always freshly derived from THIS SAME call's own server-side resolution
 * and therefore inherently trustworthy, a part's id list must be
 * independently re-verified before use (IMP-010B: a part is never allowed
 * lesser validation authority than the whole-bundle path). Returns only the
 * ids that genuinely belong to `(userId, portfolioId)`; the caller rejects
 * the whole part if any supplied id is missing from this set.
 */
async function verifyOwnedPortfolioSecurityIds(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await client.all<{ id: string }>(
    `SELECT id FROM portfolio_securities WHERE user_id = ? AND portfolio_id = ? AND id IN (${placeholders})`,
    [userId, portfolioId, ...ids],
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * EXP-004 correction: every phase after `scaffold` carries a browser-held
 * `batchId`/`fingerprint`/`portfolioId` triple. The FINGERPRINT half of that
 * triple was previously trusted verbatim, even though every idempotency key
 * the part goes on to write (`bundle:<fingerprint>:<ref>`) is derived from
 * it -- so a wrong value would not fail, it would silently start a SECOND,
 * unresumable copy of the owner's ledger alongside the first. The server
 * already stores the authoritative fingerprint for the batch
 * (`import_batches.file_sha256`, written by the scaffold), so one indexed,
 * owner-scoped lookup re-derives it rather than trusting the wire.
 *
 * Returns the batch's own status so `commitPortfolioBundleFinalize` can make
 * its already-committed decision from this same read instead of a second one.
 */
async function requireOwnedRestoreBatch(
  ctx: BundleServiceContext,
  input: { batchId: string; fingerprint: string; portfolioId: string },
): Promise<{ ok: true; status: string } | BundleServiceFailure> {
  const row = await ctx.client.get<{
    status: string;
    file_sha256: string;
    target_portfolio_id: string | null;
  }>(
    `SELECT status, file_sha256, target_portfolio_id FROM import_batches
     WHERE id = ? AND user_id = ? LIMIT 1`,
    [input.batchId, ctx.userId],
  );
  if (!row) {
    return {
      ok: false,
      status: 404,
      message: "This restore batch was not found.",
    };
  }
  if (String(row.file_sha256) !== input.fingerprint) {
    return {
      ok: false,
      status: 409,
      message:
        "This restore part does not match the backup its batch was started for. Re-select the same backup file and confirm again to restart from a fresh scaffold.",
    };
  }
  if (
    row.target_portfolio_id !== null &&
    String(row.target_portfolio_id) !== input.portfolioId
  ) {
    return {
      ok: false,
      status: 409,
      message:
        "This restore part targets a different portfolio than its batch. Re-select the same backup file and confirm again to restart from a fresh scaffold.",
    };
  }
  return { ok: true, status: String(row.status) };
}

/**
 * The whole-bundle entry point (EXP-001's own standalone import): validates
 * the raw bundle, derives its fingerprint, then runs the scaffold below.
 */
export async function commitPortfolioBundleScaffold(
  ctx: BundleServiceContext,
  raw: unknown,
  filename: string,
  bundleByteLength: number,
): Promise<{ ok: true; result: BundleScaffoldResult } | BundleServiceFailure> {
  const validation = validatePortfolioBundle(raw);
  if (!validation.ok)
    return { ok: false, status: 400, message: validation.message };
  const bundle = validation.bundle;
  const fingerprint = await fingerprintBundle(bundle);
  return commitValidatedPortfolioBundleScaffold(
    ctx,
    bundle,
    fingerprint,
    filename,
    bundleByteLength,
  );
}

/**
 * EXP-004 correction: the scaffold's actual work, taking a bundle its caller
 * has ALREADY validated with `validatePortfolioBundle` and fingerprinted.
 *
 * This exists because a system restore's scaffold request used to validate
 * and fingerprint every nested bundle TWICE -- once in
 * `commitSystemBackupCoreScaffold` (which needs the fingerprints for the
 * fresh-account precondition) and again here -- plus a third full
 * serialisation for `byte_size`. Validation authority is NOT reduced by
 * this split: `validatePortfolioBundle` is idempotent, so the second pass
 * could only ever confirm what the first already established, and the
 * caller passes the OUTPUT of that validation (never the raw wire value).
 * `commitPortfolioBundleScaffold` above keeps the validate-then-scaffold
 * shape for callers holding an unvalidated bundle.
 */
export async function commitValidatedPortfolioBundleScaffold(
  ctx: BundleServiceContext,
  bundle: PortfolioBundleV1,
  fingerprint: string,
  filename: string,
  bundleByteLength: number,
): Promise<{ ok: true; result: BundleScaffoldResult } | BundleServiceFailure> {
  const settings = await createOwnedUserSettingsRepository(ctx.client).get(
    ctx.userId,
  );
  if (!settings) {
    return {
      ok: false,
      status: 404,
      message: "Account settings were not found.",
    };
  }
  if (settings.homeCurrencyCode !== bundle.portfolio.baseCurrencyCode) {
    return {
      ok: false,
      status: 409,
      message:
        `This bundle's portfolio is in ${bundle.portfolio.baseCurrencyCode}, but your account's home currency is ` +
        `${settings.homeCurrencyCode}. Change your home currency to ${bundle.portfolio.baseCurrencyCode} in Settings, ` +
        `then re-import.`,
    };
  }

  const existing = await findExistingBatch(ctx.client, ctx.userId, fingerprint);
  if (
    existing &&
    existing.status === "committed" &&
    existing.targetPortfolioId
  ) {
    const portfolioRow = await ctx.client.get<{ name: string; code: string }>(
      "SELECT name, code FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
      [existing.targetPortfolioId, ctx.userId],
    );
    return {
      ok: true,
      result: {
        idempotent: true,
        batchId: existing.id,
        fingerprint,
        portfolioId: existing.targetPortfolioId,
        portfolioName: portfolioRow?.name ?? bundle.portfolio.name,
        code: portfolioRow?.code ?? bundle.portfolio.code,
        securities: [],
        securitiesCreated: 0,
        securitiesMatched: 0,
        committedTransactionCount: bundle.transactions.length,
        committedDividendCount: bundle.dividendManualRecords.length,
        missingTransactionRefs: [],
        missingDividendRefs: [],
      },
    };
  }

  const now = new Date().toISOString();
  let batchId: string;
  let portfolioId: string | null = existing?.targetPortfolioId ?? null;
  if (existing) {
    batchId = existing.id;
    if (existing.status !== "committing") {
      await ctx.client.run(
        `UPDATE import_batches SET status = 'committing', filename = ?, byte_size = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
        [filename.slice(0, 255), bundleByteLength, now, batchId, ctx.userId],
      );
    }
  } else {
    batchId = randomUUID();
    try {
      await ctx.client.run(
        `INSERT INTO import_batches (
          id, user_id, parser_format, parser_version, filename, byte_size,
          file_sha256, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'committing', ?, ?)`,
        [
          batchId,
          ctx.userId,
          PORTFOLIO_BUNDLE_PARSER_FORMAT,
          String(PORTFOLIO_BUNDLE_SCHEMA_VERSION),
          filename.slice(0, 255),
          bundleByteLength,
          fingerprint,
          now,
          now,
        ],
      );
    } catch {
      // A genuine race: two concurrent scaffold calls for the same NEW
      // bundle.
      return {
        ok: false,
        status: 409,
        message: "This bundle is already being imported. Try again shortly.",
      };
    }
  }

  let portfolioName: string;
  let code: string;
  if (portfolioId) {
    // Resuming into an already-created destination -- read its ACTUAL
    // persisted name/code (may carry a `-restored` suffix from the earlier
    // attempt's own collision handling) rather than re-deriving them.
    const row = await ctx.client.get<{ name: string; code: string }>(
      "SELECT name, code FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
      [portfolioId, ctx.userId],
    );
    if (!row) {
      return commitFailure(
        ctx,
        batchId,
        "The portfolio this restore was writing to no longer exists -- it may have been manually deleted. This bundle cannot be resumed; archive/clean up any remaining data for it and start a fresh restore.",
      );
    }
    portfolioName = row.name;
    code = row.code;
  } else {
    code = bundle.portfolio.code;
    let created: string | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const creation = buildPortfolioCreationStatements(
        ctx.userId,
        {
          code,
          name: bundle.portfolio.name,
          timezone: bundle.portfolio.timezone,
          accountingMethod:
            bundle.portfolio.accountingMethod === "fifo" ? "fifo" : undefined,
          historyCompleteFrom: bundle.portfolio.historyCompleteFrom,
        },
        ctx.requestId,
        now,
      );
      try {
        // BUG-019: the portfolio row, its creation-audit row, and the
        // `import_batches.target_portfolio_id` link that attributes the
        // new portfolio to THIS batch all land in ONE atomic
        // `client.batch()` call. Previously the portfolio was created
        // (via `portfolios.create()`, its own separate batch) and the
        // link was a further standalone `client.run()` -- a crash between
        // the two left a portfolio row that existed but was attributable
        // to no batch. A retry then found `target_portfolio_id` still
        // NULL, took this same branch, and created a SECOND portfolio
        // under `<code>-restored`, permanently orphaning the first (it
        // has no batch pointing at it, so nothing archives or resumes
        // it, and `countUnrelatedPortfolios` counts it against every
        // later system-restore's fresh-account precondition). Folding all
        // three writes into one D1 batch means a failure anywhere in it
        // rolls back the entire thing, so a retry always starts from
        // "nothing created yet" -- never "half created".
        const rows = await ctx.client.batch([
          ...creation.statements,
          {
            sql: "UPDATE import_batches SET target_portfolio_id = ? WHERE id = ? AND user_id = ?",
            params: [creation.portfolioId, batchId, ctx.userId],
          },
        ]);
        if (rows[0]?.results[0]) {
          created = creation.portfolioId;
        }
      } catch {
        code = `${bundle.portfolio.code}-restored${attempt > 0 ? `-${attempt + 1}` : ""}`;
      }
    }
    if (!created) {
      return commitFailure(
        ctx,
        batchId,
        "A destination portfolio could not be created for this bundle.",
      );
    }
    portfolioId = created;
    portfolioName = bundle.portfolio.name;

    if (bundle.portfolioSettings.quoteStalenessPolicy !== null) {
      await ctx.client.run(
        `INSERT INTO portfolio_settings (
          portfolio_id, user_id, quote_staleness_policy, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, 1)`,
        [
          portfolioId,
          ctx.userId,
          bundle.portfolioSettings.quoteStalenessPolicy,
          now,
          now,
        ],
      );
    }
  }

  // Securities: resolve-or-create -- ALWAYS safe to re-run whether this is a
  // fresh scaffold or a resume. `resolveAndLink` is idempotent by natural
  // key (`db/repositories/security-resolution.ts`'s `existingCandidateRow`
  // check runs first), and the following UPDATE is a plain by-id UPDATE, so
  // replaying this loop after a PRIOR scaffold call died partway through it
  // converges on the exact same result. Bounded by security count, not
  // transaction count -- cheap relative to the CPU budget this task exists
  // to protect.
  const securityResolution = createOwnedSecurityResolutionRepository(
    ctx.client,
  );
  const securities: BundleScaffoldSecurity[] = [];
  let securitiesCreated = 0;
  let securitiesMatched = 0;
  for (const security of bundle.securities) {
    const result = await securityResolution.resolveAndLink(
      ctx.userId,
      {
        symbol: security.tickerIdentifier ?? security.sourceSymbol,
        exchangeAlias: security.sourceExchangeAlias,
        currencyCode: security.sourceCurrencyCode,
        sharesightInstrumentId: security.sharesightInstrumentId,
        isin: security.isinIdentifier,
        instrumentName:
          security.canonicalName ??
          security.sourceName ??
          security.sourceSymbol,
      },
      {
        portfolioId,
        sourceSymbol: security.sourceSymbol,
        sourceExchangeAlias: security.sourceExchangeAlias,
        sourceCurrencyCode: security.sourceCurrencyCode,
      },
    );
    if (!result.ok) {
      return commitFailure(
        ctx,
        batchId,
        `Security "${security.sourceSymbol}" could not be resolved (${result.reason}).`,
      );
    }
    securities.push({
      ref: security.ref,
      portfolioSecurityId: result.portfolioSecurityId,
    });
    if (result.created) securitiesCreated += 1;
    else securitiesMatched += 1;

    await ctx.client.run(
      `UPDATE portfolio_securities
       SET status = ?, display_symbol = ?, display_name = ?,
           first_relevant_date = ?, last_relevant_date = ?
       WHERE id = ? AND user_id = ? AND portfolio_id = ?`,
      [
        security.status === "unresolved" ? "held" : security.status,
        security.displaySymbol,
        security.displayName,
        security.firstRelevantDate,
        security.lastRelevantDate,
        result.portfolioSecurityId,
        ctx.userId,
        portfolioId,
      ],
    );
  }

  // OPS-005: the resume-evidence probe. Chain order is recomputed HERE,
  // fresh, from the server's own current `chainOrder` module on every
  // scaffold call -- never carried over from a prior request or trusted
  // from the wire -- so a chain-order change deployed between two parts of
  // the SAME resume can never desynchronise the count against the order the
  // way the old `slice(committedTransactionCount)` strategy could (see
  // `missingTransactionRefs`'s own doc comment and
  // `docs/BACKUP_FORMAT.md`'s "Resume evidence" section).
  const orderedTransactionRefs = chainOrder(
    bundle.transactions,
    (tx) => tx.reversesRef ?? tx.supersedesRef,
  ).map((tx) => tx.ref);
  const missingRefsSet = await listMissingTransactionRefs(
    ctx.client,
    ctx.userId,
    portfolioId,
    fingerprint,
    orderedTransactionRefs,
  );
  const missingTransactionRefs = orderedTransactionRefs.filter((ref) =>
    missingRefsSet.has(ref),
  );
  // `committedTransactionCount` is now purely informational/diagnostic --
  // derived from the SAME probe rather than a second `COUNT(*)` query, so
  // it can never disagree with `missingTransactionRefs`.
  const committedTransactionCount =
    orderedTransactionRefs.length - missingTransactionRefs.length;

  // OPS-005 round 2: the same probe, applied to the dividend phase.
  // `chainOrder`'s ordering matters for the dividend phase for the identical
  // reason it matters for transactions -- a supersession record must never
  // be sent before the record it supersedes -- so it is recomputed fresh
  // here too, never carried over from a prior request.
  const orderedDividendRefs = chainOrder(
    bundle.dividendManualRecords,
    (record) => record.supersedesRef,
  ).map((record) => record.ref);
  const missingDividendRefsSet = await listMissingDividendRefs(
    ctx.client,
    ctx.userId,
    portfolioId,
    fingerprint,
    orderedDividendRefs,
  );
  const missingDividendRefs = orderedDividendRefs.filter((ref) =>
    missingDividendRefsSet.has(ref),
  );
  // `committedDividendCount` is now purely informational/diagnostic, derived
  // from the SAME probe as `missingDividendRefs`, mirroring
  // `committedTransactionCount` above -- it can never disagree with
  // `missingDividendRefs`.
  const committedDividendCount =
    orderedDividendRefs.length - missingDividendRefs.length;

  // OPS-005 round 2 (F1): persist the bundle's OWN expected ref set -- a
  // sha256 digest and count over every transaction/dividend ref, sorted so
  // the digest is order-independent -- so finalize can compare the client's
  // supplied lists against something the SERVER derived, not merely
  // re-verify existence of whatever list the client happens to send (a
  // client sending a SHORTER list previously passed finalize's existence
  // probe trivially -- see `docs/BACKUP_FORMAT.md`'s "Resume evidence"
  // section). Recomputed and rewritten on EVERY scaffold call, fresh from
  // this same fingerprinted bundle -- deterministic and idempotent, exactly
  // like the security-resolution loop above, so a resume can never disagree
  // with an earlier scaffold's own write.
  const transactionRefsDigest = await sha256Hex(
    [...orderedTransactionRefs].sort().join("\n"),
  );
  const dividendRefsDigest = await sha256Hex(
    [...orderedDividendRefs].sort().join("\n"),
  );
  await ctx.client.run(
    `UPDATE import_batches SET
       bundle_transaction_refs_digest = ?, bundle_transaction_refs_count = ?,
       bundle_dividend_refs_digest = ?, bundle_dividend_refs_count = ?
     WHERE id = ? AND user_id = ?`,
    [
      transactionRefsDigest,
      orderedTransactionRefs.length,
      dividendRefsDigest,
      orderedDividendRefs.length,
      batchId,
      ctx.userId,
    ],
  );

  return {
    ok: true,
    result: {
      idempotent: false,
      batchId,
      fingerprint,
      portfolioId,
      portfolioName,
      code,
      securities,
      securitiesCreated,
      securitiesMatched,
      committedTransactionCount,
      committedDividendCount,
      missingTransactionRefs,
      missingDividendRefs,
    },
  };
}

export type BundleTransactionsPartInput = {
  portfolioId: string;
  batchId: string;
  fingerprint: string;
  securities: readonly BundleScaffoldSecurity[];
  /** Unvalidated on the wire -- re-validated here exactly as a full bundle's
   * transactions would be (IMP-010B: server is the sole validation
   * authority for every part, not only the whole-file upload). Must already
   * be in this portfolio's own chain order (`domain/exports/chain-order.ts`)
   * -- the browser computes the SAME order this module would. */
  transactions: readonly unknown[];
};

export type BundleTransactionsPartResult = { committedCount: number };

export async function commitPortfolioBundleTransactionsPart(
  ctx: BundleServiceContext,
  input: BundleTransactionsPartInput,
): Promise<
  { ok: true; result: BundleTransactionsPartResult } | BundleServiceFailure
> {
  const batch = await requireOwnedRestoreBatch(ctx, input);
  if (!batch.ok) return batch;
  const portfolioRow = await ctx.client.get<{ id: string }>(
    "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
    [input.portfolioId, ctx.userId],
  );
  if (!portfolioRow) {
    return { ok: false, status: 404, message: "Portfolio was not found." };
  }
  const ownedSecurityIds = await verifyOwnedPortfolioSecurityIds(
    ctx.client,
    ctx.userId,
    input.portfolioId,
    input.securities.map((s) => s.portfolioSecurityId),
  );
  if (
    input.securities.some((s) => !ownedSecurityIds.has(s.portfolioSecurityId))
  ) {
    return {
      ok: false,
      status: 404,
      message: "A referenced security does not belong to this portfolio.",
    };
  }
  const securityRefs = new Set(input.securities.map((s) => s.ref));
  const securityRefToId = new Map(
    input.securities.map((s) => [s.ref, s.portfolioSecurityId]),
  );
  const seenRefs = new Set<string>();
  const transactions: BundleTransaction[] = [];
  for (const raw of input.transactions) {
    const tx = validateTransaction(raw, seenRefs, securityRefs);
    if (!tx) {
      return {
        ok: false,
        status: 400,
        message: "A transaction in this part is malformed.",
      };
    }
    transactions.push(tx);
  }

  const ledger = createOwnedLedgerRepository(ctx.client);
  let committedCount = 0;
  for (const tx of transactions) {
    const securityId = tx.securityRef
      ? (securityRefToId.get(tx.securityRef) ?? null)
      : null;
    if (tx.securityRef && !securityId) {
      return commitFailure(
        ctx,
        input.batchId,
        "Transaction references a security that failed to resolve.",
      );
    }
    const derivedKey = `bundle:${input.fingerprint}:${tx.ref}`;
    const transactionType = asLedgerTransactionType(tx.type);
    if (!transactionType) {
      return commitFailure(
        ctx,
        input.batchId,
        `Transaction has an unsupported type "${tx.type}".`,
      );
    }
    if (tx.reversesRef !== null) {
      const targetId = await findTransactionIdByRef(
        ctx.client,
        ctx.userId,
        input.portfolioId,
        input.fingerprint,
        tx.reversesRef,
      );
      if (!targetId) {
        return commitFailure(
          ctx,
          input.batchId,
          "A reversal's original transaction was not replayed first.",
        );
      }
      const result = await ledger.reverse(
        ctx.userId,
        input.portfolioId,
        targetId,
        derivedKey,
        ctx.requestId,
      );
      if (!result.ok) {
        return commitFailure(
          ctx,
          input.batchId,
          `A transaction reversal could not be replayed (${result.reason}).`,
        );
      }
      committedCount += 1;
      continue;
    }
    if (tx.supersedesRef !== null) {
      const targetId = await findTransactionIdByRef(
        ctx.client,
        ctx.userId,
        input.portfolioId,
        input.fingerprint,
        tx.supersedesRef,
      );
      if (!targetId) {
        return commitFailure(
          ctx,
          input.batchId,
          "A supersession's original transaction was not replayed first.",
        );
      }
      const result = await ledger.supersede(
        ctx.userId,
        input.portfolioId,
        targetId,
        {
          portfolioId: input.portfolioId,
          type: transactionType,
          portfolioSecurityId: securityId,
          quantityDecimal: tx.quantityDecimal,
          unitPriceDecimal: tx.unitPriceDecimal,
          grossAmountDecimal: tx.grossAmountDecimal,
          feeAmountDecimal: tx.feeAmountDecimal,
          taxAmountDecimal: tx.taxAmountDecimal,
          fxRateToBaseDecimal: tx.fxRateToBaseDecimal,
          sourceType: asLedgerSourceType(tx.sourceType) ?? "system",
          sourceReference: tx.sourceReference,
          idempotencyKey: derivedKey,
          tradeAt: tx.tradeAt,
          localTradeDate: tx.localTradeDate,
          settlementDate: tx.settlementDate,
          currencyCode: tx.currencyCode,
          fxRateSource: tx.fxRateSource,
          fxObservedAt: tx.fxObservedAt,
          requestId: ctx.requestId,
        },
      );
      if (!result.ok) {
        return commitFailure(
          ctx,
          input.batchId,
          `A transaction supersession could not be replayed (${result.reason}).`,
        );
      }
      committedCount += 1;
      continue;
    }
    const sourceType = asLedgerSourceType(tx.sourceType);
    if (!sourceType) {
      return commitFailure(
        ctx,
        input.batchId,
        `Transaction has an unsupported source type "${tx.sourceType}".`,
      );
    }
    const result = await ledger.post(ctx.userId, {
      portfolioId: input.portfolioId,
      type: transactionType,
      portfolioSecurityId: securityId,
      quantityDecimal: tx.quantityDecimal,
      unitPriceDecimal: tx.unitPriceDecimal,
      grossAmountDecimal: tx.grossAmountDecimal,
      feeAmountDecimal: tx.feeAmountDecimal,
      taxAmountDecimal: tx.taxAmountDecimal,
      fxRateToBaseDecimal: tx.fxRateToBaseDecimal,
      sourceType,
      sourceReference: tx.sourceReference,
      idempotencyKey: derivedKey,
      tradeAt: tx.tradeAt,
      localTradeDate: tx.localTradeDate,
      settlementDate: tx.settlementDate,
      currencyCode: tx.currencyCode,
      fxRateSource: tx.fxRateSource,
      fxObservedAt: tx.fxObservedAt,
      requestId: ctx.requestId,
    });
    if (!result.ok) {
      return commitFailure(
        ctx,
        input.batchId,
        `A transaction could not be replayed (${result.reason}).`,
      );
    }
    committedCount += 1;
  }
  return { ok: true, result: { committedCount } };
}

export type BundleDividendsPartInput = {
  portfolioId: string;
  batchId: string;
  fingerprint: string;
  securities: readonly BundleScaffoldSecurity[];
  /** Unvalidated on the wire -- see `BundleTransactionsPartInput`'s comment. */
  records: readonly unknown[];
};

export type BundleDividendsPartResult = { committedCount: number };

export async function commitPortfolioBundleDividendsPart(
  ctx: BundleServiceContext,
  input: BundleDividendsPartInput,
): Promise<
  { ok: true; result: BundleDividendsPartResult } | BundleServiceFailure
> {
  const batch = await requireOwnedRestoreBatch(ctx, input);
  if (!batch.ok) return batch;
  const portfolioRow = await ctx.client.get<{ id: string }>(
    "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
    [input.portfolioId, ctx.userId],
  );
  if (!portfolioRow) {
    return { ok: false, status: 404, message: "Portfolio was not found." };
  }
  const ownedSecurityIds = await verifyOwnedPortfolioSecurityIds(
    ctx.client,
    ctx.userId,
    input.portfolioId,
    input.securities.map((s) => s.portfolioSecurityId),
  );
  if (
    input.securities.some((s) => !ownedSecurityIds.has(s.portfolioSecurityId))
  ) {
    return {
      ok: false,
      status: 404,
      message: "A referenced security does not belong to this portfolio.",
    };
  }
  const securityRefs = new Set(input.securities.map((s) => s.ref));
  const securityRefToId = new Map(
    input.securities.map((s) => [s.ref, s.portfolioSecurityId]),
  );
  const seenRefs = new Set<string>();
  const records: BundleDividendManualRecord[] = [];
  for (const raw of input.records) {
    const record = validateDividendManualRecord(raw, seenRefs, securityRefs);
    if (!record) {
      return {
        ok: false,
        status: 400,
        message: "A dividend record in this part is malformed.",
      };
    }
    records.push(record);
  }

  const manualRecords = createDividendManualRecordRepository(ctx.client);
  let committedCount = 0;
  for (const record of records) {
    const securityId = securityRefToId.get(record.securityRef);
    if (!securityId) {
      return commitFailure(
        ctx,
        input.batchId,
        "A dividend record references a security that failed to resolve.",
      );
    }
    const idempotencyKey = `bundle:${input.fingerprint}:${record.ref}`;
    if (record.wasImported) {
      const insert = buildDividendManualRecordImportInsertStatements({
        userId: ctx.userId,
        portfolioId: input.portfolioId,
        portfolioSecurityId: securityId,
        paymentDate: record.paymentDate,
        sharesDecimal: record.sharesDecimal,
        dividendPerShareDecimal: record.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
        totalCashDecimal: record.totalCashDecimal,
        totalFrankingDecimal: record.totalFrankingDecimal,
        currencyCode: record.currencyCode,
        fxRateToPortfolioDecimal: record.fxRateToPortfolioDecimal,
        fxRateSource: record.fxRateSource,
        importBatchId: input.batchId,
        sourceReference: record.sourceReference ?? idempotencyKey,
        idempotencyKey,
        requestId: ctx.requestId,
        now: new Date().toISOString(),
      });
      if (!insert.ok) {
        return commitFailure(
          ctx,
          input.batchId,
          "A dividend record could not be replayed (invalid amounts).",
        );
      }
      try {
        await ctx.client.batch(insert.statements);
      } catch {
        // EXP-004: a resumed/retried part can legitimately re-send a row
        // this exact call already wrote (see this module's resumable-
        // scaffold header comment) -- dedupe by the SAME idempotency key
        // rather than treating the resulting unique-index hit as fatal.
        const already = await manualRecords.getByIdempotencyKey(
          ctx.userId,
          input.portfolioId,
          securityId,
          idempotencyKey,
        );
        if (!already) {
          return commitFailure(
            ctx,
            input.batchId,
            "A dividend record could not be replayed (a conflicting row already exists).",
          );
        }
      }
    } else {
      const saved = await manualRecords.create(ctx.userId, input.portfolioId, {
        portfolioSecurityId: securityId,
        paymentDate: record.paymentDate,
        sharesDecimal: record.sharesDecimal,
        dividendPerShareDecimal: record.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
        totalCashDecimal: record.totalCashDecimal,
        totalFrankingDecimal: record.totalFrankingDecimal,
        idempotencyKey,
        requestId: ctx.requestId,
      });
      if (!saved.ok) {
        return commitFailure(
          ctx,
          input.batchId,
          "A dividend record could not be replayed (invalid amounts).",
        );
      }
    }
    committedCount += 1;
  }
  return { ok: true, result: { committedCount } };
}

export type BundleDividendLinkageItem = {
  ref: string;
  securityRef: string;
  supersedesRef: string | null;
  supersededByDeletedRecord: boolean;
};

/** EXP-004: validates one wire `dividendLinkage` entry (IMP-010B -- the
 * finalize request is a SEPARATE later request from the one that originally
 * structurally validated the whole bundle, so it must be re-validated on its
 * own terms, never trusted merely because an earlier request looked valid). */
export function validateDividendLinkageItem(
  value: unknown,
  securityRefs: ReadonlySet<string>,
): BundleDividendLinkageItem | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).ref !== "string" ||
    ((value as Record<string, unknown>).ref as string).length === 0 ||
    typeof (value as Record<string, unknown>).securityRef !== "string" ||
    !securityRefs.has(
      (value as Record<string, unknown>).securityRef as string,
    ) ||
    ((value as Record<string, unknown>).supersedesRef !== null &&
      typeof (value as Record<string, unknown>).supersedesRef !== "string") ||
    typeof (value as Record<string, unknown>).supersededByDeletedRecord !==
      "boolean"
  ) {
    return null;
  }
  const item = value as Record<string, unknown>;
  return {
    ref: item.ref as string,
    securityRef: item.securityRef as string,
    supersedesRef: (item.supersedesRef as string | null) ?? null,
    supersededByDeletedRecord: item.supersededByDeletedRecord as boolean,
  };
}

export type BundleFinalizeInput = {
  portfolioId: string;
  batchId: string;
  fingerprint: string;
  securities: readonly BundleScaffoldSecurity[];
  /** Slim metadata for EVERY dividend record in the bundle (not the
   * financial amounts -- those were already written by the dividends parts)
   * -- enough to re-derive `divRefToId` via each row's own idempotency key
   * and replay the supersession-link-up / tombstone-exclusion passes. */
  dividendLinkage: readonly BundleDividendLinkageItem[];
  dividendSecurityAssumptions: readonly BundleDividendSecurityAssumption[];
  dividendPortfolioAssumption: BundleDividendPortfolioAssumption | null;
  dividendFyOverrides: readonly BundleDividendFyOverride[];
  dividendEventOverrides: readonly BundleDividendEventOverride[];
  dividendImportFrankingOverrides: readonly BundleDividendImportFrankingOverride[];
  whatifScenarios: readonly BundleWhatifScenario[];
  portfolioStatus: "active" | "archived";
  transactionsCount: number;
  dividendRecordsCount: number;
  /**
   * OPS-005 (defence in depth): every transaction ref the bundle carries --
   * mirrors `dividendLinkage`'s role for dividends. Finalize re-derives each
   * ref's idempotency key and verifies it was actually written before doing
   * anything else, exactly as the dividend-linkage pass below already
   * re-looks-up every dividend ref and fails closed. Without this, a
   * transactions part silently skipped (a browser bug, a manual/curl replay
   * of the finalize request alone, or a row deleted between parts) could
   * reach `committed` status having never posted every transaction.
   */
  transactionRefs: readonly string[];
};

/** EXP-004: the RAW wire shape a finalize HTTP request carries -- every
 * sub-array/field is `unknown` because it arrives as a SEPARATE request from
 * the one that originally validated the whole bundle (IMP-010B: never
 * trusted merely because an earlier request looked valid). */
export type BundleFinalizeWireInput = {
  portfolioId: string;
  batchId: string;
  fingerprint: string;
  securities: readonly BundleScaffoldSecurity[];
  dividendLinkage: unknown;
  dividendSecurityAssumptions: unknown;
  dividendPortfolioAssumption: unknown;
  dividendFyOverrides: unknown;
  dividendEventOverrides: unknown;
  dividendImportFrankingOverrides: unknown;
  whatifScenarios: unknown;
  portfolioStatus: unknown;
  transactionsCount: unknown;
  dividendRecordsCount: unknown;
  transactionRefs: unknown;
};

/** Structurally validates a finalize request's wire fields into a typed
 * `BundleFinalizeInput`, reusing the SAME per-row validators
 * `validatePortfolioBundle` itself uses for every one of these entity kinds. */
export function parseBundleFinalizeWireInput(
  raw: BundleFinalizeWireInput,
): { ok: true; value: BundleFinalizeInput } | { ok: false; message: string } {
  const securityRefs = new Set(raw.securities.map((s) => s.ref));

  if (!Array.isArray(raw.dividendLinkage)) {
    return { ok: false, message: "The dividend linkage list is malformed." };
  }
  const dividendLinkage: BundleDividendLinkageItem[] = [];
  for (const item of raw.dividendLinkage) {
    const parsed = validateDividendLinkageItem(item, securityRefs);
    if (!parsed) {
      return { ok: false, message: "The dividend linkage list is malformed." };
    }
    dividendLinkage.push(parsed);
  }
  const dividendRefs = new Set(dividendLinkage.map((item) => item.ref));

  if (!Array.isArray(raw.dividendSecurityAssumptions)) {
    return {
      ok: false,
      message: "The per-security assumptions list is malformed.",
    };
  }
  const dividendSecurityAssumptions: BundleDividendSecurityAssumption[] = [];
  for (const item of raw.dividendSecurityAssumptions) {
    const parsed = validateDividendSecurityAssumption(item, securityRefs);
    if (!parsed) {
      return {
        ok: false,
        message: "A per-security assumption entry is malformed.",
      };
    }
    dividendSecurityAssumptions.push(parsed);
  }

  let dividendPortfolioAssumption: BundleDividendPortfolioAssumption | null =
    null;
  if (
    raw.dividendPortfolioAssumption !== null &&
    raw.dividendPortfolioAssumption !== undefined
  ) {
    const parsed = validateDividendPortfolioAssumption(
      raw.dividendPortfolioAssumption,
    );
    if (!parsed) {
      return {
        ok: false,
        message: "The portfolio-level assumption is malformed.",
      };
    }
    dividendPortfolioAssumption = parsed;
  }

  if (!Array.isArray(raw.dividendFyOverrides)) {
    return { ok: false, message: "The FY override list is malformed." };
  }
  const dividendFyOverrides: BundleDividendFyOverride[] = [];
  for (const item of raw.dividendFyOverrides) {
    const parsed = validateDividendFyOverride(item);
    if (!parsed)
      return { ok: false, message: "An FY override entry is malformed." };
    dividendFyOverrides.push(parsed);
  }

  if (!Array.isArray(raw.dividendEventOverrides)) {
    return {
      ok: false,
      message: "The dividend event override list is malformed.",
    };
  }
  const dividendEventOverrides: BundleDividendEventOverride[] = [];
  for (const item of raw.dividendEventOverrides) {
    const parsed = validateDividendEventOverride(item, securityRefs);
    if (!parsed) {
      return {
        ok: false,
        message: "A dividend event override entry is malformed.",
      };
    }
    dividendEventOverrides.push(parsed);
  }

  if (!Array.isArray(raw.dividendImportFrankingOverrides)) {
    return { ok: false, message: "The franking override list is malformed." };
  }
  const dividendImportFrankingOverrides: BundleDividendImportFrankingOverride[] =
    [];
  for (const item of raw.dividendImportFrankingOverrides) {
    const parsed = validateDividendImportFrankingOverride(
      item,
      securityRefs,
      dividendRefs,
    );
    if (!parsed) {
      return { ok: false, message: "A franking override entry is malformed." };
    }
    dividendImportFrankingOverrides.push(parsed);
  }

  if (!Array.isArray(raw.whatifScenarios)) {
    return { ok: false, message: "The what-if scenario list is malformed." };
  }
  const whatifScenarios: BundleWhatifScenario[] = [];
  for (const item of raw.whatifScenarios) {
    const parsed = validateWhatifScenario(item);
    if (!parsed)
      return { ok: false, message: "A what-if scenario entry is malformed." };
    whatifScenarios.push(parsed);
  }

  if (raw.portfolioStatus !== "active" && raw.portfolioStatus !== "archived") {
    return { ok: false, message: "The portfolio status is malformed." };
  }
  if (
    !Number.isSafeInteger(raw.transactionsCount) ||
    (raw.transactionsCount as number) < 0 ||
    !Number.isSafeInteger(raw.dividendRecordsCount) ||
    (raw.dividendRecordsCount as number) < 0
  ) {
    return { ok: false, message: "The restore counts are malformed." };
  }

  if (
    !Array.isArray(raw.transactionRefs) ||
    raw.transactionRefs.some(
      (ref) => typeof ref !== "string" || ref.length === 0,
    )
  ) {
    return { ok: false, message: "The transaction ref list is malformed." };
  }
  const transactionRefs = raw.transactionRefs as string[];

  return {
    ok: true,
    value: {
      portfolioId: raw.portfolioId,
      batchId: raw.batchId,
      fingerprint: raw.fingerprint,
      securities: raw.securities,
      dividendLinkage,
      dividendSecurityAssumptions,
      dividendPortfolioAssumption,
      dividendFyOverrides,
      dividendEventOverrides,
      dividendImportFrankingOverrides,
      whatifScenarios,
      portfolioStatus: raw.portfolioStatus,
      transactionsCount: raw.transactionsCount as number,
      dividendRecordsCount: raw.dividendRecordsCount as number,
      transactionRefs,
    },
  };
}

export type BundleFinalizeResult = { skippedDividendEventOverrides: number };

export async function commitPortfolioBundleFinalize(
  ctx: BundleServiceContext,
  input: BundleFinalizeInput,
): Promise<{ ok: true; result: BundleFinalizeResult } | BundleServiceFailure> {
  const batch = await requireOwnedRestoreBatch(ctx, input);
  if (!batch.ok) return batch;
  // EXP-004: a whole-finalize retry (the browser never saw this call's own
  // earlier success, e.g. a dropped response) is a total no-op once the
  // batch already reads `committed` -- every write below this point that has
  // no natural-key identity (most notably `whatifScenarios`, which is
  // deliberately CREATE-ONLY -- see `income-scenarios.ts`'s own `save()`
  // comment) would otherwise duplicate on a second pass. This does not cover
  // a crash PARTWAY through this function's own body before the final status
  // flip -- documented as a narrow, accepted residual gap in
  // `docs/BACKUP_FORMAT.md` (non-ledger planning data only; never a
  // transaction/dividend/holding figure).
  if (batch.status === "committed") {
    return { ok: true, result: { skippedDividendEventOverrides: 0 } };
  }
  const portfolioRow = await ctx.client.get<{ id: string }>(
    "SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
    [input.portfolioId, ctx.userId],
  );
  if (!portfolioRow) {
    return { ok: false, status: 404, message: "Portfolio was not found." };
  }
  const ownedSecurityIds = await verifyOwnedPortfolioSecurityIds(
    ctx.client,
    ctx.userId,
    input.portfolioId,
    input.securities.map((s) => s.portfolioSecurityId),
  );
  if (
    input.securities.some((s) => !ownedSecurityIds.has(s.portfolioSecurityId))
  ) {
    return {
      ok: false,
      status: 404,
      message: "A referenced security does not belong to this portfolio.",
    };
  }
  const securityRefToId = new Map(
    input.securities.map((s) => [s.ref, s.portfolioSecurityId]),
  );

  // OPS-005 round 2 (F1): compare the client-supplied ref lists against the
  // SERVER's own persisted record of what this bundle was scaffolded with
  // (written by `commitPortfolioBundleScaffold`, never client-supplied).
  // The existence probe just below this only proves that every ref the
  // client CLAIMS it sent was actually written -- a client sending a
  // SHORTER list than the bundle actually contains passes that probe
  // trivially, since the omitted rows are simply never checked. Comparing
  // against a persisted, independently-derived digest+count closes that
  // gap. NULL on a legacy batch scaffolded before this column existed --
  // skipped rather than failing closed on a batch this code cannot verify
  // (see the migration's own comment, `drizzle/0061_*.sql`).
  const persistedRefSet = await ctx.client.get<{
    bundle_transaction_refs_digest: string | null;
    bundle_transaction_refs_count: number | null;
    bundle_dividend_refs_digest: string | null;
    bundle_dividend_refs_count: number | null;
  }>(
    `SELECT bundle_transaction_refs_digest, bundle_transaction_refs_count,
            bundle_dividend_refs_digest, bundle_dividend_refs_count
     FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1`,
    [input.batchId, ctx.userId],
  );
  if (persistedRefSet?.bundle_transaction_refs_digest != null) {
    const sortedTransactionRefs = [...input.transactionRefs].sort();
    const clientTransactionRefsDigest = await sha256Hex(
      sortedTransactionRefs.join("\n"),
    );
    if (
      clientTransactionRefsDigest !==
        persistedRefSet.bundle_transaction_refs_digest ||
      sortedTransactionRefs.length !==
        persistedRefSet.bundle_transaction_refs_count
    ) {
      return commitFailure(
        ctx,
        input.batchId,
        `This restore expected ${persistedRefSet.bundle_transaction_refs_count} transaction ref(s) but finalize received ${sortedTransactionRefs.length} -- restore every transactions part before finalizing.`,
      );
    }
  }
  if (persistedRefSet?.bundle_dividend_refs_digest != null) {
    const sortedDividendRefs = input.dividendLinkage
      .map((item) => item.ref)
      .sort();
    const clientDividendRefsDigest = await sha256Hex(
      sortedDividendRefs.join("\n"),
    );
    if (
      clientDividendRefsDigest !==
        persistedRefSet.bundle_dividend_refs_digest ||
      sortedDividendRefs.length !== persistedRefSet.bundle_dividend_refs_count
    ) {
      return commitFailure(
        ctx,
        input.batchId,
        `This restore expected ${persistedRefSet.bundle_dividend_refs_count} dividend record ref(s) but finalize received ${sortedDividendRefs.length} -- restore every dividends part before finalizing.`,
      );
    }
  }

  // OPS-005 (defence in depth): re-verify every transaction ref was
  // actually written before doing anything else, mirroring the dividend-
  // linkage re-lookup immediately below. Fails closed and visibly -- a
  // transactions part silently skipped, replayed out of order, or a row
  // removed between parts must never let this portfolio reach `committed`.
  const missingTransactionRefs = await listMissingTransactionRefs(
    ctx.client,
    ctx.userId,
    input.portfolioId,
    input.fingerprint,
    input.transactionRefs,
  );
  if (missingTransactionRefs.size > 0) {
    return commitFailure(
      ctx,
      input.batchId,
      `${missingTransactionRefs.size} transaction(s) were not found during finalize -- restore every transactions part before finalizing.`,
    );
  }

  const manualRecords = createDividendManualRecordRepository(ctx.client);
  const divRefToId = new Map<string, string>();
  for (const item of input.dividendLinkage) {
    const securityId = securityRefToId.get(item.securityRef);
    if (!securityId) {
      return commitFailure(
        ctx,
        input.batchId,
        "A dividend record's security could not be resolved during finalize.",
      );
    }
    const idempotencyKey = `bundle:${input.fingerprint}:${item.ref}`;
    const record = await manualRecords.getByIdempotencyKey(
      ctx.userId,
      input.portfolioId,
      securityId,
      idempotencyKey,
    );
    if (!record) {
      return commitFailure(
        ctx,
        input.batchId,
        "A dividend record was not found during finalize -- restore its part before finalizing.",
      );
    }
    divRefToId.set(item.ref, record.id);
  }
  for (const item of input.dividendLinkage) {
    if (item.supersedesRef === null) continue;
    const oldId = divRefToId.get(item.supersedesRef);
    const newId = divRefToId.get(item.ref);
    if (!oldId || !newId) {
      return commitFailure(
        ctx,
        input.batchId,
        "A dividend record's supersession chain could not be linked.",
      );
    }
    await ctx.client.run(
      `UPDATE dividend_manual_records SET superseded_by_record_id = ?
       WHERE id = ? AND user_id = ? AND portfolio_id = ?`,
      [newId, oldId, ctx.userId, input.portfolioId],
    );
  }
  for (const item of input.dividendLinkage) {
    if (!item.supersededByDeletedRecord) continue;
    const ownId = divRefToId.get(item.ref);
    if (!ownId) {
      return commitFailure(
        ctx,
        input.batchId,
        "A dividend record's tombstone exclusion could not be replayed.",
      );
    }
    await ctx.client.run(
      `UPDATE dividend_manual_records SET superseded_by_record_id = ?
       WHERE id = ? AND user_id = ? AND portfolio_id = ?`,
      [randomUUID(), ownId, ctx.userId, input.portfolioId],
    );
  }

  const assumptions = createDividendAssumptionsRepository(ctx.client);
  for (const item of input.dividendSecurityAssumptions) {
    const securityId = securityRefToId.get(item.securityRef);
    if (!securityId) continue;
    const saved = await assumptions.saveSecurityAssumptions(
      ctx.userId,
      input.portfolioId,
      securityId,
      {
        dividendYieldPercentDecimal: item.dividendYieldPercentDecimal,
        frankingPercentDecimal: item.frankingPercentDecimal,
        dividendGrowthPercentDecimal: item.dividendGrowthPercentDecimal,
        forceAssumption: item.forceAssumption ?? false,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        input.batchId,
        "A per-security assumption could not be replayed.",
      );
    }
  }
  if (input.dividendPortfolioAssumption) {
    const saved = await assumptions.savePortfolioAssumptions(
      ctx.userId,
      input.portfolioId,
      {
        valueGrowthPercentDecimal:
          input.dividendPortfolioAssumption.valueGrowthPercentDecimal,
        portfolioDividendGrowthPercentDecimal:
          input.dividendPortfolioAssumption
            .portfolioDividendGrowthPercentDecimal,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        input.batchId,
        "The portfolio-level assumption could not be replayed.",
      );
    }
  }

  const fyOverrides = createDividendFyOverrideRepository(ctx.client);
  for (const item of input.dividendFyOverrides) {
    const saved = await fyOverrides.save(
      ctx.userId,
      input.portfolioId,
      item.financialYearEndingYear,
      {
        grossedAmountDecimal: item.grossedAmountDecimal,
        frankingAmountDecimal: item.frankingAmountDecimal,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        input.batchId,
        "An FY override could not be replayed.",
      );
    }
  }

  const eventOverrides = createDividendEventOverrideRepository(ctx.client);
  let skippedDividendEventOverrides = 0;
  for (const item of input.dividendEventOverrides) {
    const securityId = securityRefToId.get(item.securityRef);
    if (!securityId) continue;
    const eventRow = await ctx.client.get<{ id: string }>(
      "SELECT id FROM dividend_events WHERE id = ? LIMIT 1",
      [item.dividendEventId],
    );
    if (!eventRow) {
      skippedDividendEventOverrides += 1;
      continue;
    }
    const saved = await eventOverrides.save(
      ctx.userId,
      input.portfolioId,
      securityId,
      item.dividendEventId,
      {
        sharesDecimal: item.sharesDecimal,
        dividendPerShareDecimal: item.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: item.frankingCreditPerShareDecimal,
        exclude: item.exclude,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        input.batchId,
        "A dividend event override could not be replayed.",
      );
    }
  }

  const frankingOverrides = createDividendImportFrankingOverrideRepository(
    ctx.client,
  );
  for (const item of input.dividendImportFrankingOverrides) {
    const securityId = securityRefToId.get(item.securityRef);
    const recordId = divRefToId.get(item.dividendManualRecordRef);
    if (!securityId || !recordId) {
      return commitFailure(
        ctx,
        input.batchId,
        "A franking override references a record that failed to replay.",
      );
    }
    const saved = await frankingOverrides.save(
      ctx.userId,
      input.portfolioId,
      securityId,
      recordId,
      {
        frankingTotalDecimal: item.frankingTotalDecimal,
        expectedVersion: null,
        requestId: ctx.requestId,
      },
    );
    if (!saved.ok) {
      return commitFailure(
        ctx,
        input.batchId,
        "A franking override could not be replayed.",
      );
    }
  }

  const scenarios = createIncomeScenarioRepository(ctx.client);
  for (const scenario of input.whatifScenarios) {
    let rows: CapitalEventInput[];
    try {
      const parsed: unknown = JSON.parse(scenario.capitalRowsJson);
      rows = Array.isArray(parsed)
        ? parsed.filter((row): row is CapitalEventInput =>
            isValidCapitalEventInputRow(row),
          )
        : [];
    } catch {
      rows = [];
    }
    const saved = await scenarios.save(ctx.userId, input.portfolioId, {
      name: scenario.name,
      rows,
      reinvestDividends: scenario.reinvestDividends,
      valueGrowthPercentDecimal: scenario.valueGrowthPercentDecimal,
      dividendGrowthPercentDecimal: scenario.dividendGrowthPercentDecimal,
      requestId: ctx.requestId,
    });
    if (!saved.ok) {
      return commitFailure(
        ctx,
        input.batchId,
        "A saved what-if scenario could not be replayed.",
      );
    }
  }

  if (input.portfolioStatus === "archived") {
    const currentPortfolio = await ctx.client.get<{
      version: number;
      status: string;
    }>(
      "SELECT version, status FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1",
      [input.portfolioId, ctx.userId],
    );
    if (!currentPortfolio) {
      return commitFailure(
        ctx,
        input.batchId,
        "The restored portfolio could not be found to archive it.",
      );
    }
    if (currentPortfolio.status !== "archived") {
      const portfolios = createOwnedPortfolioRepository(ctx.client, undefined, {
        requestId: ctx.requestId,
      });
      const archived = await portfolios.archive(ctx.userId, input.portfolioId, {
        expectedVersion: currentPortfolio.version,
      });
      if (!archived.ok) {
        return commitFailure(
          ctx,
          input.batchId,
          "The restored portfolio could not be archived to match its exported status.",
        );
      }
    }
  }

  await ctx.client.run(
    `UPDATE import_batches SET status = 'committed', committed_at = ?, updated_at = ?,
      total_rows = ?, transaction_rows = ?
     WHERE id = ? AND user_id = ?`,
    [
      new Date().toISOString(),
      new Date().toISOString(),
      input.transactionsCount + input.dividendRecordsCount,
      input.transactionsCount,
      input.batchId,
      ctx.userId,
    ],
  );

  return { ok: true, result: { skippedDividendEventOverrides } };
}

export { MAX_BUNDLE_REQUEST_BYTES };
