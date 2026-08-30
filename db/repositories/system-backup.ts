// EXP-002: owner-scoped DB reads/writes for the full-system backup that
// EXP-001's per-portfolio bundle deliberately excludes -- account settings
// (`user_settings`) and the watchlist (`watchlist_entries`). Every query
// below is scoped by `user_id` (AGENTS.md: "constrain every portfolio-scoped
// query by authenticated internal user_id"); `userId` always comes from
// `getAuthenticatedSqlContext`. Portfolio-scoped data itself is read/written
// entirely by EXP-001's OWN `db/repositories/portfolio-bundle.ts` /
// `app/portfolio-bundle-service.ts` -- this module never duplicates that.
import { normalizeToken } from "../../domain/securities/verify-identity.ts";
import {
  resolveGlobalTickerCurrencyCandidate,
  type SameUserSecurityEvidenceRow,
} from "../../domain/securities/resolve-security-candidate.ts";
import type {
  SystemBackupAccountSettings,
  SystemBackupWatchlistEntry,
} from "../../domain/exports/system-backup.ts";
import { createConditionalAuditInsertStatement } from "./audit.ts";
import { createOwnedUserSettingsRepository } from "./owned-portfolios.ts";
import { createOwnedWatchlistRepository } from "./watchlist.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";

type Row = Record<string, unknown>;

export async function readAccountSettingsForBackup(
  client: SqlClient,
  userId: string,
): Promise<SystemBackupAccountSettings | null> {
  const settings = await createOwnedUserSettingsRepository(client).get(userId);
  if (!settings) return null;
  return {
    homeCurrencyCode: settings.homeCurrencyCode,
    timezone: settings.timezone,
    defaultHoldingCurrencyView: settings.defaultHoldingCurrencyView,
    financialYearStartMonth: settings.financialYearStartMonth,
    priceSourcePreference: settings.priceSourcePreference,
    dailyCaptureSource: settings.dailyCaptureSource,
    dailyCaptureIntervalMinutes: settings.dailyCaptureIntervalMinutes,
  };
}

/**
 * Directly overwrites `user_settings` with the backup's recorded values --
 * NEVER the owner-facing `requestHomeCurrencyRebase` workflow (that exists
 * to rebase EXISTING portfolios' FX-dependent figures onto a NEW home
 * currency; restore's own precondition -- see `app/system-backup-service.ts`
 * -- guarantees no unrelated portfolio exists yet, so there is nothing to
 * rebase). Always overwrites, every commit call (first-time or an idempotent
 * retry of the identical backup) -- see `docs/BACKUP_FORMAT.md`'s
 * "Restore (import)" section for why this is honest rather than a silent
 * merge: the precondition means a populated, disagreeing account can never
 * reach this write.
 */
export async function restoreAccountSettings(
  client: SqlClient,
  userId: string,
  account: SystemBackupAccountSettings,
  requestId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "conflict" }> {
  const current = await client.get<{ version: number }>(
    "SELECT version FROM user_settings WHERE user_id = ? LIMIT 1",
    [userId],
  );
  if (!current) return { ok: false, reason: "not_found" };
  const occurredAt = now();
  const statements: SqlStatement[] = [
    createConditionalAuditInsertStatement(
      {
        actorUserId: userId,
        targetOwnerUserId: userId,
        action: "settings.restored_from_backup",
        targetType: "user_settings",
        targetId: userId,
        requestId,
        result: "success",
        occurredAt,
      },
      "EXISTS (SELECT 1 FROM user_settings WHERE user_id = ? AND version = ?)",
      [userId, current.version],
      now,
    ),
    {
      sql: `UPDATE user_settings
            SET home_currency_code = ?, timezone = ?, default_holding_currency_view = ?,
                financial_year_start_month = ?, price_source_preference = ?,
                daily_capture_source = ?, daily_capture_interval_minutes = ?,
                updated_at = ?, version = version + 1
            WHERE user_id = ? AND version = ?`,
      params: [
        account.homeCurrencyCode,
        account.timezone,
        account.defaultHoldingCurrencyView,
        account.financialYearStartMonth,
        account.priceSourcePreference,
        account.dailyCaptureSource,
        account.dailyCaptureIntervalMinutes,
        occurredAt,
        userId,
        current.version,
      ],
    },
  ];
  try {
    await client.batch(statements);
  } catch {
    return { ok: false, reason: "conflict" };
  }
  const after = await client.get<{ version: number }>(
    "SELECT version FROM user_settings WHERE user_id = ? LIMIT 1",
    [userId],
  );
  if (!after || after.version !== current.version + 1) {
    return { ok: false, reason: "conflict" };
  }
  return { ok: true };
}

export async function readWatchlistForBackup(
  client: SqlClient,
  userId: string,
): Promise<SystemBackupWatchlistEntry[]> {
  const securityRows = await client.all<Row>(
    `SELECT s.primary_currency_code AS currency_code, s.canonical_name,
            (SELECT si.value FROM security_identifiers si
              WHERE si.security_id = we.security_id AND si.scheme = 'ticker'
                AND si.valid_to IS NULL LIMIT 1) AS ticker_identifier,
            (SELECT si.value FROM security_identifiers si
              WHERE si.security_id = we.security_id AND si.scheme = 'isin'
                AND si.valid_to IS NULL LIMIT 1) AS isin_identifier,
            (SELECT si.value FROM security_identifiers si
              WHERE si.security_id = we.security_id AND si.scheme = 'sharesight_instrument'
                AND si.valid_to IS NULL LIMIT 1) AS sharesight_instrument_id
     FROM watchlist_entries we
     JOIN securities s ON s.id = we.security_id
     WHERE we.user_id = ? AND we.kind = 'security'
     ORDER BY we.display_order ASC, we.created_at ASC, we.id ASC`,
    [userId],
  );
  const pairRows = await client.all<Row>(
    `SELECT base_currency_code, quote_currency_code FROM watchlist_entries
     WHERE user_id = ? AND kind = 'currency_pair'
     ORDER BY display_order ASC, created_at ASC, id ASC`,
    [userId],
  );
  const securities: SystemBackupWatchlistEntry[] = securityRows.map((row) => ({
    kind: "security",
    tickerIdentifier:
      row.ticker_identifier === null ? null : String(row.ticker_identifier),
    isinIdentifier:
      row.isin_identifier === null ? null : String(row.isin_identifier),
    sharesightInstrumentId:
      row.sharesight_instrument_id === null
        ? null
        : String(row.sharesight_instrument_id),
    currencyCode: String(row.currency_code),
    canonicalName:
      row.canonical_name === null ? null : String(row.canonical_name),
  }));
  const pairs: SystemBackupWatchlistEntry[] = pairRows.map((row) => ({
    kind: "currency_pair",
    baseCurrencyCode: String(row.base_currency_code),
    quoteCurrencyCode: String(row.quote_currency_code),
  }));
  return [...securities, ...pairs];
}

/**
 * Resolves a watch-only security entry against the SHARED `securities`
 * master WITHOUT creating anything -- unlike `portfolio_securities`
 * resolution (`security-resolution.ts`'s `resolveAndLink`), a watchlist
 * entry has no portfolio-linked candidate to create-if-absent FROM, and this
 * codebase's only security-CREATION paths either require a
 * `portfolio_securities` link or a LIVE provider re-verification
 * (`security-verification.ts`'s `publishOnly`, which stamps a
 * `security_provider_mappings` row claiming provider-verified evidence --
 * fabricating that on restore would be a false provenance claim). So this
 * only ever MATCHES an already-existing security (most commonly one this
 * SAME system restore's own portfolio bundles just created/resolved) --
 * never creates one. A watch-only security never held in any portfolio,
 * anywhere, has no restorable identity in this v1; the caller counts it as
 * skipped rather than silently dropping it. See `docs/BACKUP_FORMAT.md`.
 */
export async function resolveWatchlistSecurityId(
  client: SqlClient,
  entry: Extract<SystemBackupWatchlistEntry, { kind: "security" }>,
): Promise<string | null> {
  if (entry.tickerIdentifier) {
    const normalizedSymbol = normalizeToken(entry.tickerIdentifier);
    const normalizedCurrency = normalizeToken(entry.currencyCode);
    const securityRows = await client.all<Row>(
      `SELECT DISTINCT si.security_id AS security_id
       FROM security_identifiers si
       JOIN securities s ON s.id = si.security_id
       WHERE si.scheme = 'ticker' AND UPPER(si.value) = ? AND si.valid_to IS NULL
         AND UPPER(s.primary_currency_code) = ?`,
      [normalizedSymbol, normalizedCurrency],
    );
    const securityIds = securityRows.map((row) => String(row.security_id));
    if (securityIds.length > 0) {
      const placeholders = securityIds.map(() => "?").join(", ");
      const exchangeRows = await client.all<Row>(
        `SELECT security_id, provider_exchange AS exchange_alias
           FROM security_provider_mappings
          WHERE security_id IN (${placeholders}) AND valid_to IS NULL`,
        securityIds,
      );
      const evidence: SameUserSecurityEvidenceRow[] = securityIds.map((id) => ({
        securityId: id,
        exchangeAlias: null,
      }));
      for (const row of exchangeRows) {
        evidence.push({
          securityId: String(row.security_id),
          exchangeAlias:
            row.exchange_alias === null ? null : String(row.exchange_alias),
        });
      }
      const outcome = resolveGlobalTickerCurrencyCandidate(null, evidence);
      if (outcome.outcome === "matched") return outcome.securityId;
    }
  }
  // ISIN and Sharesight-instrument-id matches are never ambiguous by
  // construction: `db/schema.ts`'s `security_identifiers_isin_scheme_unique`
  // / `security_identifiers_sharesight_instrument_unique` DB-enforce at
  // most one live (`valid_to IS NULL`) row per value across the whole
  // shared master -- unlike the ticker tier above (deliberately NOT
  // globally unique, hence the exchange-evidence conflict check), a second
  // match here would mean a data-integrity violation elsewhere, not a
  // legitimate ambiguity this function needs to detect.
  if (entry.isinIdentifier) {
    const row = await client.get<{ security_id: string }>(
      `SELECT security_id FROM security_identifiers
       WHERE scheme = 'isin' AND value = ? AND valid_to IS NULL LIMIT 1`,
      [entry.isinIdentifier],
    );
    if (row) return row.security_id;
  }
  if (entry.sharesightInstrumentId) {
    const row = await client.get<{ security_id: string }>(
      `SELECT security_id FROM security_identifiers
       WHERE scheme = 'sharesight_instrument' AND value = ? AND valid_to IS NULL LIMIT 1`,
      [entry.sharesightInstrumentId],
    );
    if (row) return row.security_id;
  }
  return null;
}

export type WatchlistRestoreCounts = {
  securitiesAdded: number;
  securitiesSkipped: number;
  pairsAdded: number;
};

export async function restoreWatchlist(
  client: SqlClient,
  userId: string,
  entries: readonly SystemBackupWatchlistEntry[],
  requestId: string,
): Promise<WatchlistRestoreCounts> {
  const watchlist = createOwnedWatchlistRepository(client);
  let securitiesAdded = 0;
  let securitiesSkipped = 0;
  let pairsAdded = 0;
  for (const entry of entries) {
    if (entry.kind === "currency_pair") {
      const result = await watchlist.addCurrencyPair(
        userId,
        entry.baseCurrencyCode,
        entry.quoteCurrencyCode,
        requestId,
      );
      if (result.ok) pairsAdded += 1;
      continue;
    }
    const securityId = await resolveWatchlistSecurityId(client, entry);
    if (!securityId) {
      securitiesSkipped += 1;
      continue;
    }
    const result = await watchlist.addSecurity(userId, securityId, requestId);
    if (result.ok) securitiesAdded += 1;
    else securitiesSkipped += 1;
  }
  return { securitiesAdded, securitiesSkipped, pairsAdded };
}

/**
 * Restore's own fresh-account precondition (`docs/BACKUP_FORMAT.md`'s
 * "Restore (import)" section): every portfolio this owner currently has
 * must be traceable to ONE of `nestedFingerprints` via an `import_batches`
 * row of ANY status (`committed`, `committing`, or `failed`) -- i.e. either
 * the account is genuinely empty, or every existing portfolio is the
 * product of a PRIOR attempt (successful OR interrupted/failed) at this
 * exact system backup. Any other existing portfolio makes the account "not
 * fresh" and restore is rejected -- never a silent merge into populated
 * data.
 *
 * B1 ruling (reviewer, 2026-08-27): status is deliberately NOT restricted to
 * `committed` -- the realistic migration failure mode is an INTERRUPTED
 * restore (a partially-replayed portfolio from a `failed`/still-`committing`
 * batch), and "start over with a fresh account" is not an acceptable
 * remedy for that. Treating only `committed` batches as "related" would
 * make the precondition itself reject the very retry it exists to allow --
 * an interrupted restore's own leftover portfolio would count as
 * "unrelated" and permanently block every subsequent retry. Reuses
 * `import_batches` (EXP-001's own per-portfolio attribution table) rather
 * than a new system-level batch table -- no migration needed.
 *
 * Only ACTIVE portfolios are checked against `nestedFingerprints` -- an
 * ARCHIVED one is never "in the way": it is either the owner's own
 * pre-existing archived portfolio (already set aside, not a live conflict
 * with a fresh restore -- `commitPortfolioBundleScaffold`'s own code-
 * collision retry handles a colliding `code` regardless of the other
 * portfolio's status), or a portfolio the backup's OWN bundle recorded as
 * archived and this restore itself archived to match (EXP-002's B2 ruling).
 *
 * EXP-004 note: earlier revisions of this restore ARCHIVED a leftover
 * partial-replay portfolio before every retry (a single-shot commit could
 * only ever leave an abandoned attempt behind). `commitPortfolioBundleScaffold`
 * (`app/portfolio-bundle-service.ts`) now RESUMES a `committing`/`failed`
 * batch's existing `target_portfolio_id` in place instead -- a chunked
 * restore leaves real, wanted progress on that batch between requests, not
 * an abandoned attempt -- so this precondition no longer needs to special-
 * case an archived leftover at all; every existing portfolio is either
 * genuinely unrelated or still traceable, live, to its own bundle.
 */
export async function countUnrelatedPortfolios(
  client: SqlClient,
  userId: string,
  nestedFingerprints: readonly string[],
): Promise<number> {
  const allRows = await client.all<{ id: string }>(
    "SELECT id FROM portfolios WHERE user_id = ? AND status = 'active'",
    [userId],
  );
  if (allRows.length === 0) return 0;
  if (nestedFingerprints.length === 0) return allRows.length;
  const accounted = await accountedPortfolioIds(
    client,
    userId,
    nestedFingerprints,
  );
  return allRows.filter((row) => !accounted.has(row.id)).length;
}

async function accountedPortfolioIds(
  client: SqlClient,
  userId: string,
  nestedFingerprints: readonly string[],
): Promise<Set<string>> {
  if (nestedFingerprints.length === 0) return new Set();
  const placeholders = nestedFingerprints.map(() => "?").join(", ");
  const accountedRows = await client.all<{ target_portfolio_id: string }>(
    `SELECT target_portfolio_id FROM import_batches
     WHERE user_id = ? AND parser_format = 'portfolio-bundle-json'
       AND file_sha256 IN (${placeholders})`,
    [userId, ...nestedFingerprints],
  );
  return new Set(
    accountedRows
      .map((row) => row.target_portfolio_id)
      .filter((id): id is string => id !== null && id !== undefined),
  );
}
