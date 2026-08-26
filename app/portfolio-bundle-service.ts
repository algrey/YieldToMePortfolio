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
  type PortfolioBundleV1,
} from "../domain/exports/portfolio-bundle.ts";
import { readPortfolioBundle } from "../db/repositories/portfolio-bundle.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
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

type ChainItem = { ref: string; createdAt: string };

/**
 * Orders `items` so every item is placed strictly after the (at most one)
 * other item it depends on -- a real topological (Kahn's-algorithm) order
 * over the chain graph `dependencyOf` describes, NOT a `createdAt` sort.
 *
 * A `createdAt`-only sort (the original implementation) is provably
 * unsafe: `ledger.post`/`reverse`/`supersede` and the dividend-record
 * writers all stamp `created_at` at MILLISECOND resolution, so two rows
 * created in the same millisecond (routine on fast/in-memory writes, and
 * reproduced by this module's own test suite as a real, non-deterministic
 * failure -- "A supersession's original transaction was not replayed
 * first") tie, and the previous ref-based tiebreak (`a.ref.localeCompare`)
 * compares random UUIDs with no relation to dependency order. This
 * function is driven purely by the bundle's own explicit `ref` graph, so
 * it is correct regardless of timestamp resolution or collisions.
 * `createdAt`/`ref` are used only to order otherwise-independent items
 * for readability/determinism, never to decide dependency order.
 */
function chainOrder<T extends ChainItem>(
  items: readonly T[],
  dependencyOf: (item: T) => string | null,
): T[] {
  const byRef = new Map(items.map((item) => [item.ref, item]));
  const stableCompare = (a: T, b: T): number =>
    a.createdAt === b.createdAt
      ? a.ref.localeCompare(b.ref)
      : a.createdAt.localeCompare(b.createdAt);
  const children = new Map<string, T[]>();
  const queue: T[] = [];
  for (const item of items) {
    const dep = dependencyOf(item);
    if (dep === null || !byRef.has(dep)) {
      queue.push(item);
      continue;
    }
    const siblings = children.get(dep);
    if (siblings) siblings.push(item);
    else children.set(dep, [item]);
  }
  queue.sort(stableCompare);
  const ordered: T[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor];
    ordered.push(item);
    const kids = children.get(item.ref);
    if (!kids) continue;
    kids.sort(stableCompare);
    queue.push(...kids);
  }
  // Defensive: a dangling/cyclic dependency should be structurally
  // impossible (`validatePortfolioBundle` checks every `reversesRef`/
  // `supersedesRef`/`supersedesRef` points at a ref the bundle actually
  // contains, and rejects a transaction that is both a reversal and a
  // supersession), but never silently drop a row if one somehow occurs --
  // append it so the per-row dependency check downstream still fails
  // closed with a clear message.
  if (ordered.length < items.length) {
    const placed = new Set(ordered.map((item) => item.ref));
    for (const item of items) if (!placed.has(item.ref)) ordered.push(item);
  }
  return ordered;
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
  return sha256Hex(canonicalBundleJson(bundle));
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

export { MAX_BUNDLE_REQUEST_BYTES };
