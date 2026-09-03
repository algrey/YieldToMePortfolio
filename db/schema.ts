import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const currencies = sqliteTable(
  "currencies",
  {
    code: text("code").primaryKey(),
    numericCode: integer("numeric_code").notNull(),
    name: text("name").notNull(),
    minorUnitDigits: integer("minor_unit_digits").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    check(
      "currencies_minor_unit_digits_check",
      sql`${table.minorUnitDigits} BETWEEN 0 AND 8`,
    ),
    check("currencies_is_active_check", sql`${table.isActive} IN (0, 1)`),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("pending"),
    displayName: text("display_name"),
    primaryEmail: text("primary_email").notNull(),
    locale: text("locale").notNull().default("en-AU"),
    timezone: text("timezone").notNull(),
    termsAcceptedAt: text("terms_accepted_at"),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "users_status_check",
      sql`${table.status} IN ('pending', 'active', 'disabled', 'deletion_pending', 'purged')`,
    ),
    index("users_status_idx").on(table.status),
  ],
);

export const userSettings = sqliteTable(
  "user_settings",
  {
    userId: text("user_id").primaryKey(),
    homeCurrencyCode: text("home_currency_code").notNull(),
    timezone: text("timezone").notNull(),
    defaultHoldingCurrencyView: text("default_holding_currency_view")
      .notNull()
      .default("native"),
    // Configurable financial-year start month (1-12, day is always the 1st).
    // Defaults to 7 (July) for the Australian financial year. This is a
    // per-user setting only; there is no per-portfolio override.
    financialYearStartMonth: integer("financial_year_start_month")
      .notNull()
      .default(7),
    // MKT-009B: which quote source the owner-facing read paths PREFER --
    // `yahoo_authenticated` (Yahoo, only counted as authenticated when the
    // configured login cookies actually produced a `session:authenticated`
    // observation -- see `domain/market-data/yahoo-compatible.ts`),
    // `yahoo_anonymous` (Yahoo regardless of session state), or
    // `sharesight_delayed` (BRK-012C's delayed-price cache/gate pipeline).
    // This is a PREFERENCE, not a hard filter: `app/owned-holdings.ts`'s
    // selection still falls back HONESTLY to whatever observation is
    // actually usable when the preferred source has none (never
    // `Price unavailable` merely because the preferred source is silent
    // while another source has a valid observation). Defaults to
    // `sharesight_delayed`: for an owner with no Sharesight link this is a
    // no-op (Sharesight never writes a row, so selection falls straight
    // through to Yahoo, matching today's behaviour byte-for-byte); for an
    // owner WITH a link it matches BRK-012C's existing intent (a
    // <=10-minute-fresh delayed price) rather than silently regressing an
    // existing user's price freshness the day this column is introduced.
    priceSourcePreference: text("price_source_preference")
      .notNull()
      .default("sharesight_delayed"),
    // MKT-011A: which source the daily intraday-capture sweep uses for THIS
    // owner (`sharesight` | `yahoo_anonymous` | `yahoo_authenticated`) --
    // separate from `priceSourcePreference` above (that is a READ-path
    // preference among already-written observations; this is a WRITE-path
    // choice of which provider `app/daily-price-capture-service.ts` fetches
    // from for this owner's intraday sweep/rollup). Defaults to `sharesight`
    // per the owner's ruling (TASKS.md MKT-011A).
    //
    // Deliberately a plain nullable-free ADD COLUMN with NO `CHECK`
    // constraint, unlike `priceSourcePreference` immediately above --
    // `priceSourcePreference`'s own CHECK forced drizzle-kit into a full
    // table REBUILD (0048_mkt_009b_price_source_preference.sql), which in
    // turn required hand-recreating this table's
    // `account_purge_lock_user_settings_*` triggers (see that migration's
    // own disclosure comment). MKT-011A's owner/orchestrator ruling
    // explicitly prefers a plain `ADD COLUMN` here to avoid repeating that
    // rebuild for two more columns: the enum is validated at the request
    // boundary instead (`app/portfolio-action-contract.ts`'s
    // `validateDailyCaptureSource`), same trust boundary discipline as every
    // other request-shaped input, just enforced in code rather than SQL.
    // Trade-off, honestly stated: a direct SQL write that bypasses the
    // action layer (a hand-run migration, a future admin tool) is NOT
    // rejected by the database itself the way `priceSourcePreference` is --
    // only the application boundary enforces the enum here.
    dailyCaptureSource: text("daily_capture_source")
      .notNull()
      .default("sharesight"),
    // MKT-011A: sweep cadence for this owner's intraday capture -- 30 or 60
    // minutes (default 60, owner ruling). Same ADD-COLUMN/no-CHECK
    // trade-off as `dailyCaptureSource` immediately above; validated at the
    // boundary via `validateDailyCaptureIntervalMinutes`.
    dailyCaptureIntervalMinutes: integer("daily_capture_interval_minutes")
      .notNull()
      .default(60),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "user_settings_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "user_settings_home_currency_code_currencies_code_fk",
      columns: [table.homeCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "user_settings_default_holding_currency_view_check",
      sql`${table.defaultHoldingCurrencyView} IN ('native', 'home')`,
    ),
    check(
      "user_settings_financial_year_start_month_check",
      sql`${table.financialYearStartMonth} BETWEEN 1 AND 12`,
    ),
    check(
      "user_settings_price_source_preference_check",
      sql`${table.priceSourcePreference} IN ('yahoo_authenticated', 'yahoo_anonymous', 'sharesight_delayed')`,
    ),
    uniqueIndex("user_settings_user_home_currency_unique").on(
      table.userId,
      table.homeCurrencyCode,
    ),
  ],
);

export const portfolios = sqliteTable(
  "portfolios",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    baseCurrencyCode: text("base_currency_code").notNull(),
    timezone: text("timezone").notNull(),
    accountingMethod: text("accounting_method").notNull().default("fifo"),
    historyCompleteFrom: text("history_complete_from"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
    // PRF-010: the hourly cron backfill's own bookkeeping (never read or
    // written by any user-facing edit path) -- the instant, and a compact
    // `"<row count>:<min value_date>:<max value_date>"` fingerprint of
    // `portfolio_value_history`, of the last FULL `loadCandidateDates` check
    // that PROVED zero candidate dates were missing for this portfolio. See
    // `app/historical-portfolio-value.ts`'s `backfillStoredValueHistoryForPortfolio`
    // for how this short-circuits the expensive per-tick DISTINCT scan, and
    // why re-deriving the fingerprint from `portfolio_value_history` itself
    // (rather than a flag some other write path must remember to clear)
    // means it is invalidated for free by every existing invalidation path:
    // any DELETE those paths issue changes the row count and/or the
    // min/max date this fingerprint captures. Both columns are NULL until
    // the first full check confirms convergence, and both are irrelevant to
    // -- never read by -- the read-time derivation or any user-facing view.
    valueHistoryBackfillVerifiedAt: text("value_history_backfill_verified_at"),
    valueHistoryBackfillVerifiedFingerprint: text(
      "value_history_backfill_verified_fingerprint",
    ),
  },
  (table) => [
    foreignKey({
      name: "portfolios_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "portfolios_base_currency_code_currencies_code_fk",
      columns: [table.baseCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "portfolios_accounting_method_check",
      sql`${table.accountingMethod} = 'fifo'`,
    ),
    check(
      "portfolios_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    uniqueIndex("portfolios_id_user_id_unique").on(table.id, table.userId),
    uniqueIndex("portfolios_user_id_code_unique").on(table.userId, table.code),
    index("portfolios_owner_status_updated_at_idx").on(
      table.userId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull().default("cloudflare_access"),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    emailAtLink: text("email_at_link"),
    status: text("status").notNull().default("active"),
    lastAuthenticatedAt: text("last_authenticated_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "user_identities_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "user_identities_provider_check",
      sql`${table.provider} = 'cloudflare_access'`,
    ),
    check(
      "user_identities_status_check",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
    uniqueIndex("user_identities_provider_issuer_subject_unique").on(
      table.provider,
      table.issuer,
      table.subject,
    ),
    index("user_identities_user_status_idx").on(table.userId, table.status),
  ],
);

export const portfolioSettings = sqliteTable(
  "portfolio_settings",
  {
    portfolioId: text("portfolio_id").primaryKey(),
    userId: text("user_id").notNull(),
    quoteStalenessPolicy: text("quote_staleness_policy").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "portfolio_settings_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    uniqueIndex("portfolio_settings_portfolio_user_unique").on(
      table.portfolioId,
      table.userId,
    ),
  ],
);

export const exchanges = sqliteTable(
  "exchanges",
  {
    id: text("id").primaryKey(),
    mic: text("mic"),
    name: text("name").notNull(),
    countryCode: text("country_code").notNull(),
    timezone: text("timezone").notNull(),
    defaultCurrencyCode: text("default_currency_code"),
    calendarCode: text("calendar_code").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    foreignKey({
      name: "exchanges_default_currency_code_currencies_code_fk",
      columns: [table.defaultCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check("exchanges_is_active_check", sql`${table.isActive} IN (0, 1)`),
    uniqueIndex("exchanges_mic_unique").on(table.mic),
  ],
);

export const securities = sqliteTable(
  "securities",
  {
    id: text("id").primaryKey(),
    assetType: text("asset_type").notNull(),
    exchangeId: text("exchange_id"),
    primaryCurrencyCode: text("primary_currency_code").notNull(),
    canonicalName: text("canonical_name").notNull(),
    isin: text("isin"),
    status: text("status").notNull().default("active"),
    firstTradeDate: text("first_trade_date"),
    lastTradeDate: text("last_trade_date"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "securities_exchange_id_exchanges_id_fk",
      columns: [table.exchangeId],
      foreignColumns: [exchanges.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "securities_primary_currency_code_currencies_code_fk",
      columns: [table.primaryCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "securities_asset_type_check",
      sql`${table.assetType} IN ('equity', 'etf', 'fund')`,
    ),
    check(
      "securities_status_check",
      sql`${table.status} IN ('active', 'delisted')`,
    ),
    check(
      "securities_trade_dates_check",
      sql`${table.lastTradeDate} IS NULL OR ${table.firstTradeDate} IS NULL OR ${table.lastTradeDate} >= ${table.firstTradeDate}`,
    ),
    uniqueIndex("securities_isin_unique").on(table.isin),
  ],
);

export const securityIdentifiers = sqliteTable(
  "security_identifiers",
  {
    id: text("id").primaryKey(),
    securityId: text("security_id").notNull(),
    scheme: text("scheme").notNull(),
    value: text("value").notNull(),
    exchangeId: text("exchange_id"),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
    source: text("source").notNull(),
  },
  (table) => [
    foreignKey({
      name: "security_identifiers_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "security_identifiers_exchange_id_exchanges_id_fk",
      columns: [table.exchangeId],
      foreignColumns: [exchanges.id],
    }).onDelete("restrict"),
    check(
      "security_identifiers_validity_check",
      sql`${table.validTo} IS NULL OR ${table.validTo} >= ${table.validFrom}`,
    ),
    index("security_identifiers_lookup_idx").on(
      table.scheme,
      table.value,
      table.exchangeId,
      table.validFrom,
      table.validTo,
    ),
    // IMP-009: the convergence/dedupe key for owner-attested securities
    // (`db/repositories/security-attestation.ts`). Scoped to
    // `source = 'owner_attested'` so it constrains ONLY rows this codebase's
    // attestation path itself creates -- it must never collide with the
    // pre-existing provider-verified path (`security-verification.ts`),
    // which can legitimately insert several `scheme = 'ticker'` identifier
    // rows sharing the same `value` (ticker text) across different
    // exchanges, since it always writes `exchange_id = NULL` and
    // distinguishes those rows by `provider_exchange` on
    // `security_provider_mappings` instead -- a table this constraint does
    // not touch. Within the owner-attested namespace, an attestation has no
    // provider/exchange evidence at all, so `(scheme, value)` (case-folded
    // to upper case before storage/lookup, see `normalizeToken` in
    // `domain/securities/verify-identity.ts`) is the most precise key the
    // schema can express without a new exchange-alias-carrying column; two
    // concurrent attestations of the same ticker text converge on one row
    // via this index (mirroring `security_provider_mappings_provider_symbol_from_unique`'s
    // throw-and-reread technique), and currency agreement is still checked
    // explicitly (never silently) at link time, exactly like the
    // provider-verified dedupe-link path already does. `WHERE valid_to IS
    // NULL` scopes uniqueness to the currently-active identifier only, so a
    // superseded attested identifier does not block a later one. See
    // `docs/DATA_MODEL.md`'s `security_identifiers` entry for the accepted
    // limitation this implies (two genuinely different securities sharing
    // the same ticker text can only be told apart, even under attestation,
    // once one of them is later provider-verified).
    uniqueIndex("security_identifiers_owner_attested_ticker_unique")
      .on(table.scheme, table.value)
      .where(
        sql`${table.source} = 'owner_attested' AND ${table.validTo} IS NULL`,
      ),
    // BRK-009A (2026-08-18): three new identifier-scheme VALUES, additive to
    // this already-existing table -- `scheme` has no CHECK constraint (kept
    // free-text, see the table's own header comment), so the closed set this
    // task defines (`ticker`, `sharesight_instrument`, `isin`, `figi`) is
    // documented here and in `docs/DATA_MODEL.md`, not enforced by a DB
    // constraint. Each new scheme gets its own partial unique index on
    // `(scheme, value) WHERE scheme = '<value>' AND valid_to IS NULL` --
    // exactly the `security_identifiers_owner_attested_ticker_unique`
    // pattern above, scoped by `scheme` instead of `source` since these
    // value-spaces (a Sharesight instrument id, an ISIN, a FIGI) are each
    // globally unique identifiers with no legitimate reason for two
    // DIFFERENT securities to share one active value -- unlike `ticker`,
    // which can legitimately repeat across exchanges. `WHERE valid_to IS
    // NULL` scopes uniqueness to the currently-active row only, so a
    // superseded identifier never blocks a later one; this mirrors the
    // `domain/securities/resolve-security.ts` resolver's own "durable-id
    // tiers only ever match the active row" rule, keeping the schema's
    // constraint and the resolver's read-time assumption in lockstep. Index
    // (not column/rebuild) migration -- trigger-hazard checked (this table
    // carries no `account_purge_lock_*` triggers to preserve; see
    // `tests/db-schema.test.ts`).
    uniqueIndex("security_identifiers_sharesight_instrument_unique")
      .on(table.scheme, table.value)
      .where(
        sql`${table.scheme} = 'sharesight_instrument' AND ${table.validTo} IS NULL`,
      ),
    uniqueIndex("security_identifiers_isin_scheme_unique")
      .on(table.scheme, table.value)
      .where(sql`${table.scheme} = 'isin' AND ${table.validTo} IS NULL`),
    uniqueIndex("security_identifiers_figi_scheme_unique")
      .on(table.scheme, table.value)
      .where(sql`${table.scheme} = 'figi' AND ${table.validTo} IS NULL`),
  ],
);

export const marketDataProviders = sqliteTable(
  "market_data_providers",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("disabled"),
    capabilitiesJson: text("capabilities_json").notNull(),
    rateLimitJson: text("rate_limit_json").notNull(),
    technicallyReviewedAt: text("technically_reviewed_at"),
    operatorNotesReference: text("operator_notes_reference"),
  },
  (table) => [
    check(
      "market_data_providers_status_check",
      sql`${table.status} IN ('disabled', 'enabled', 'suspended')`,
    ),
    uniqueIndex("market_data_providers_code_unique").on(table.code),
  ],
);

export const securityProviderMappings = sqliteTable(
  "security_provider_mappings",
  {
    id: text("id").primaryKey(),
    securityId: text("security_id").notNull(),
    providerId: text("provider_id").notNull(),
    providerExchange: text("provider_exchange").notNull(),
    providerSymbol: text("provider_symbol").notNull(),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
    status: text("status").notNull().default("candidate"),
    verifiedByUserId: text("verified_by_user_id"),
    verifiedAt: text("verified_at"),
  },
  (table) => [
    foreignKey({
      name: "security_provider_mappings_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "security_provider_mappings_provider_id_market_data_providers_id_fk",
      columns: [table.providerId],
      foreignColumns: [marketDataProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "security_provider_mappings_verified_by_user_id_users_id_fk",
      columns: [table.verifiedByUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "security_provider_mappings_status_check",
      sql`${table.status} IN ('candidate', 'verified', 'rejected', 'expired')`,
    ),
    check(
      "security_provider_mappings_validity_check",
      sql`${table.validTo} IS NULL OR ${table.validTo} >= ${table.validFrom}`,
    ),
    uniqueIndex("security_provider_mappings_provider_symbol_from_unique").on(
      table.providerId,
      table.providerExchange,
      table.providerSymbol,
      table.validFrom,
    ),
    uniqueIndex("security_provider_mappings_id_provider_unique").on(
      table.id,
      table.providerId,
    ),
    uniqueIndex("security_provider_mappings_id_provider_security_unique").on(
      table.id,
      table.providerId,
      table.securityId,
    ),
    index("security_provider_mappings_security_provider_valid_to_idx").on(
      table.securityId,
      table.providerId,
      table.validTo,
    ),
  ],
);

export const portfolioSecurities = sqliteTable(
  "portfolio_securities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    securityId: text("security_id"),
    sourceSymbol: text("source_symbol").notNull(),
    sourceExchangeAlias: text("source_exchange_alias"),
    sourceCurrencyCode: text("source_currency_code").notNull(),
    sourceName: text("source_name"),
    displaySymbol: text("display_symbol"),
    displayName: text("display_name"),
    status: text("status").notNull().default("unresolved"),
    firstRelevantDate: text("first_relevant_date"),
    lastRelevantDate: text("last_relevant_date"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "portfolio_securities_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "portfolio_securities_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "portfolio_securities_source_currency_code_currencies_code_fk",
      columns: [table.sourceCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "portfolio_securities_status_check",
      sql`${table.status} IN ('held', 'watch', 'hidden', 'unresolved')`,
    ),
    check(
      "portfolio_securities_resolution_check",
      sql`(${table.status} = 'unresolved' AND ${table.securityId} IS NULL) OR (${table.status} <> 'unresolved' AND ${table.securityId} IS NOT NULL)`,
    ),
    check(
      "portfolio_securities_relevant_dates_check",
      sql`${table.lastRelevantDate} IS NULL OR ${table.firstRelevantDate} IS NULL OR ${table.lastRelevantDate} >= ${table.firstRelevantDate}`,
    ),
    uniqueIndex("portfolio_securities_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("portfolio_securities_resolved_unique")
      .on(table.portfolioId, table.securityId)
      .where(sql`${table.securityId} IS NOT NULL`),
    index("portfolio_securities_owner_portfolio_status_idx").on(
      table.userId,
      table.portfolioId,
      table.status,
    ),
  ],
);

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    targetPortfolioId: text("target_portfolio_id"),
    parserFormat: text("parser_format").notNull(),
    parserVersion: text("parser_version").notNull(),
    filename: text("filename").notNull(),
    byteSize: integer("byte_size").notNull(),
    fileSha256: text("file_sha256").notNull(),
    status: text("status").notNull().default("uploaded"),
    totalRows: integer("total_rows").notNull().default(0),
    blankRows: integer("blank_rows").notNull().default(0),
    definitionRows: integer("definition_rows").notNull().default(0),
    transactionRows: integer("transaction_rows").notNull().default(0),
    unsupportedRows: integer("unsupported_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    infoCount: integer("info_count").notNull().default(0),
    commitIdempotencyKey: text("commit_idempotency_key"),
    reversalIdempotencyKey: text("reversal_idempotency_key"),
    supersedesBatchId: text("supersedes_batch_id"),
    failureCategory: text("failure_category"),
    failureDetail: text("failure_detail"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    parsedAt: text("parsed_at"),
    committedAt: text("committed_at"),
    reversedAt: text("reversed_at"),
    commitHighWaterRow: integer("commit_high_water_row").notNull().default(1),
    version: integer("version").notNull().default(1),
    /**
     * OPS-005 round 2 (F1): the server's OWN record of a portfolio-bundle
     * restore's expected ref set, written by `commitPortfolioBundleScaffold`
     * on every scaffold call (idempotent -- recomputed fresh each time from
     * the same fingerprinted bundle, never client-supplied). NULL for every
     * batch that is not a bundle restore (ordinary CSV imports never set
     * these) and for a bundle-restore batch scaffolded before this column
     * existed.
     *
     * Exists because `commitPortfolioBundleFinalize`'s pre-existing
     * existence probe only checks that every ref the CLIENT claims to have
     * sent was actually written -- a client sending a SHORTER list than the
     * bundle actually contains passes that probe trivially (the rows it
     * omitted were simply never checked) and the batch reaches `committed`
     * with silently fewer rows than the backup file described. Comparing the
     * client's list against this persisted, server-derived set at finalize
     * closes that gap: `bundle_transaction_refs_digest`/`_count` are a
     * sha256 hex digest and count over every transaction ref (sorted, joined
     * by `\n`) the bundle was scaffolded with; `bundle_dividend_refs_digest`/
     * `_count` are the same shape for dividend refs. See
     * `docs/BACKUP_FORMAT.md`'s "Resume evidence" section.
     */
    bundleTransactionRefsDigest: text("bundle_transaction_refs_digest"),
    bundleTransactionRefsCount: integer("bundle_transaction_refs_count"),
    bundleDividendRefsDigest: text("bundle_dividend_refs_digest"),
    bundleDividendRefsCount: integer("bundle_dividend_refs_count"),
  },
  (table) => [
    foreignKey({
      name: "import_batches_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "import_batches_target_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.targetPortfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "import_batches_supersedes_batch_id_user_id_import_batches_id_user_id_fk",
      columns: [table.supersedesBatchId, table.userId],
      foreignColumns: [table.id, table.userId],
    }).onDelete("restrict"),
    check(
      "import_batches_status_check",
      sql`${table.status} IN ('uploaded', 'parsed', 'needs_mapping', 'invalid', 'ready', 'committing', 'committed', 'reversing', 'reversed', 'failed')`,
    ),
    check("import_batches_byte_size_check", sql`${table.byteSize} >= 0`),
    check("import_batches_total_rows_check", sql`${table.totalRows} >= 0`),
    check("import_batches_blank_rows_check", sql`${table.blankRows} >= 0`),
    check(
      "import_batches_definition_rows_check",
      sql`${table.definitionRows} >= 0`,
    ),
    check(
      "import_batches_transaction_rows_check",
      sql`${table.transactionRows} >= 0`,
    ),
    check(
      "import_batches_unsupported_rows_check",
      sql`${table.unsupportedRows} >= 0`,
    ),
    check(
      "import_batches_duplicate_rows_check",
      sql`${table.duplicateRows} >= 0`,
    ),
    check("import_batches_error_count_check", sql`${table.errorCount} >= 0`),
    check(
      "import_batches_warning_count_check",
      sql`${table.warningCount} >= 0`,
    ),
    check("import_batches_info_count_check", sql`${table.infoCount} >= 0`),
    uniqueIndex("import_batches_user_file_parser_unique").on(
      table.userId,
      table.fileSha256,
      table.parserFormat,
      table.parserVersion,
    ),
    uniqueIndex("import_batches_id_user_unique").on(table.id, table.userId),
    uniqueIndex("import_batches_commit_idempotency_unique")
      .on(table.userId, table.commitIdempotencyKey)
      .where(sql`${table.commitIdempotencyKey} IS NOT NULL`),
    index("import_batches_owner_status_updated_at_idx").on(
      table.userId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const importCommitChunks = sqliteTable(
  "import_commit_chunks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    batchId: text("batch_id").notNull(),
    commitIdempotencyKey: text("commit_idempotency_key").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    firstPhysicalRow: integer("first_physical_row").notNull(),
    lastPhysicalRow: integer("last_physical_row").notNull(),
    committedRowCount: integer("committed_row_count").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "import_commit_chunks_batch_id_user_id_import_batches_id_user_id_fk",
      columns: [table.batchId, table.userId],
      foreignColumns: [importBatches.id, importBatches.userId],
    }).onDelete("restrict"),
    check(
      "import_commit_chunks_chunk_index_check",
      sql`${table.chunkIndex} >= 0`,
    ),
    check(
      "import_commit_chunks_row_range_check",
      sql`${table.lastPhysicalRow} >= ${table.firstPhysicalRow}`,
    ),
    check(
      "import_commit_chunks_committed_row_count_check",
      sql`${table.committedRowCount} >= 0`,
    ),
    uniqueIndex("import_commit_chunks_batch_key_index_unique").on(
      table.batchId,
      table.userId,
      table.commitIdempotencyKey,
      table.chunkIndex,
    ),
    index("import_commit_chunks_owner_batch_idx").on(
      table.userId,
      table.batchId,
      table.chunkIndex,
    ),
  ],
);

export const importRows = sqliteTable(
  "import_rows",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    batchId: text("batch_id").notNull(),
    physicalRowNumber: integer("physical_row_number").notNull(),
    rowClass: text("row_class").notNull(),
    originalFieldsJson: text("original_fields_json").notNull(),
    normalizedFieldsJson: text("normalized_fields_json"),
    normalizedFingerprint: text("normalized_fingerprint"),
    validationStatus: text("validation_status").notNull().default("staged"),
    targetPortfolioId: text("target_portfolio_id"),
    targetPortfolioSecurityId: text("target_portfolio_security_id"),
    commitStatus: text("commit_status").notNull().default("staged"),
    commitTransactionId: text("commit_transaction_id"),
    // IMP-008: NULL = not excluded. A non-null ISO timestamp records that
    // the OWNER (never the system) explicitly excluded this row from
    // commit, pre-commit and reversibly (un-skip clears it back to NULL).
    // Deliberately a dedicated column rather than an overload of
    // `commit_status` (which describes what COMMIT did to a row, not a
    // pre-commit owner decision) -- see docs/CSV_IMPORT_SPEC.md for the
    // full exclusion/readiness/commit semantics this column drives.
    excludedByOwnerAt: text("excluded_by_owner_at"),
    errorCount: integer("error_count").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    infoCount: integer("info_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "import_rows_batch_id_user_id_import_batches_id_user_id_fk",
      columns: [table.batchId, table.userId],
      foreignColumns: [importBatches.id, importBatches.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "import_rows_target_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.targetPortfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "import_rows_target_portfolio_security_id_user_id_portfolio_id_portfolio_securities_id_user_id_portfolio_id_fk",
      columns: [
        table.targetPortfolioSecurityId,
        table.userId,
        table.targetPortfolioId,
      ],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    check(
      "import_rows_physical_row_number_check",
      sql`${table.physicalRowNumber} > 1`,
    ),
    check(
      "import_rows_row_class_check",
      sql`${table.rowClass} IN ('portfolio_security_definition', 'transaction', 'blank', 'unsupported')`,
    ),
    check(
      "import_rows_validation_status_check",
      sql`${table.validationStatus} IN ('staged', 'valid', 'needs_mapping', 'invalid')`,
    ),
    check(
      "import_rows_commit_status_check",
      sql`${table.commitStatus} IN ('staged', 'committed', 'skipped', 'reversed', 'failed')`,
    ),
    check("import_rows_error_count_check", sql`${table.errorCount} >= 0`),
    check("import_rows_warning_count_check", sql`${table.warningCount} >= 0`),
    check("import_rows_info_count_check", sql`${table.infoCount} >= 0`),
    uniqueIndex("import_rows_batch_physical_row_unique").on(
      table.batchId,
      table.physicalRowNumber,
    ),
    uniqueIndex("import_rows_id_user_unique").on(table.id, table.userId),
    uniqueIndex("import_rows_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.targetPortfolioId,
    ),
    index("import_rows_review_idx").on(
      table.batchId,
      table.validationStatus,
      table.physicalRowNumber,
    ),
    index("import_rows_user_normalized_fingerprint_idx").on(
      table.userId,
      table.normalizedFingerprint,
    ),
  ],
);

export const importIssues = sqliteTable(
  "import_issues",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    batchId: text("batch_id").notNull(),
    rowId: text("row_id"),
    physicalRowNumber: integer("physical_row_number"),
    field: text("field"),
    severity: text("severity").notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    suggestedResolutionType: text("suggested_resolution_type"),
    resolvedValue: text("resolved_value"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "import_issues_batch_id_user_id_import_batches_id_user_id_fk",
      columns: [table.batchId, table.userId],
      foreignColumns: [importBatches.id, importBatches.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "import_issues_row_id_user_id_import_rows_id_user_id_fk",
      columns: [table.rowId, table.userId],
      foreignColumns: [importRows.id, importRows.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "import_issues_resolved_by_user_id_users_id_fk",
      columns: [table.resolvedByUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "import_issues_severity_check",
      sql`${table.severity} IN ('error', 'warning', 'info')`,
    ),
    uniqueIndex("import_issues_id_user_unique").on(table.id, table.userId),
    index("import_issues_batch_row_idx").on(
      table.batchId,
      table.rowId,
      table.physicalRowNumber,
    ),
  ],
);

export const importMappingDecisions = sqliteTable(
  "import_mapping_decisions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    batchId: text("batch_id").notNull(),
    kind: text("kind").notNull(),
    sourceKey: text("source_key").notNull(),
    normalizedSourceValue: text("normalized_source_value").notNull(),
    targetId: text("target_id"),
    targetValue: text("target_value"),
    scope: text("scope").notNull(),
    confidence: text("confidence").notNull(),
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "import_mapping_decisions_batch_id_user_id_import_batches_id_user_id_fk",
      columns: [table.batchId, table.userId],
      foreignColumns: [importBatches.id, importBatches.userId],
    }).onDelete("restrict"),
    check(
      "import_mapping_decisions_kind_check",
      sql`${table.kind} IN ('portfolio', 'security', 'currency', 'transaction_type', 'fx')`,
    ),
    check(
      "import_mapping_decisions_scope_check",
      sql`${table.scope} IN ('row', 'batch', 'user_future')`,
    ),
    check(
      "import_mapping_decisions_confidence_check",
      sql`${table.confidence} IN ('user', 'exact_identifier', 'system_candidate')`,
    ),
    check(
      "import_mapping_decisions_source_check",
      sql`${table.source} IN ('user', 'exact_identifier', 'system_candidate')`,
    ),
    uniqueIndex("import_mapping_decisions_id_user_unique").on(
      table.id,
      table.userId,
    ),
    uniqueIndex("import_mapping_decisions_lookup_unique").on(
      table.batchId,
      table.userId,
      table.kind,
      table.sourceKey,
      table.scope,
    ),
    index("import_mapping_decisions_owner_batch_idx").on(
      table.userId,
      table.batchId,
      table.kind,
    ),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id"),
    type: text("type").notNull(),
    status: text("status").notNull(),
    tradeAt: text("trade_at").notNull(),
    localTradeDate: text("local_trade_date").notNull(),
    settlementDate: text("settlement_date"),
    quantityDecimal: text("quantity_decimal"),
    unitPriceDecimal: text("unit_price_decimal"),
    currencyCode: text("currency_code").notNull(),
    grossAmountDecimal: text("gross_amount_decimal"),
    feeAmountDecimal: text("fee_amount_decimal").notNull().default("0"),
    taxAmountDecimal: text("tax_amount_decimal").notNull().default("0"),
    fxRateToBaseDecimal: text("fx_rate_to_base_decimal"),
    fxRateSource: text("fx_rate_source"),
    fxObservedAt: text("fx_observed_at"),
    sourceType: text("source_type").notNull(),
    sourceReference: text("source_reference"),
    idempotencyKey: text("idempotency_key"),
    importRowId: text("import_row_id"),
    reversesTransactionId: text("reverses_transaction_id"),
    supersedesTransactionId: text("supersedes_transaction_id"),
    createdByUserId: text("created_by_user_id").notNull(),
    calculationVersion: integer("calculation_version").notNull(),
    createdAt: text("created_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "transactions_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_portfolio_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_currency_code_currencies_code_fk",
      columns: [table.currencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_import_row_id_user_id_portfolio_id_fk",
      columns: [table.importRowId, table.userId, table.portfolioId],
      foreignColumns: [
        importRows.id,
        importRows.userId,
        importRows.targetPortfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_reverses_transaction_id_user_id_portfolio_id_fk",
      columns: [table.reversesTransactionId, table.userId, table.portfolioId],
      foreignColumns: [table.id, table.userId, table.portfolioId],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_supersedes_transaction_id_user_id_portfolio_id_fk",
      columns: [table.supersedesTransactionId, table.userId, table.portfolioId],
      foreignColumns: [table.id, table.userId, table.portfolioId],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_created_by_user_id_users_id_fk",
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "transactions_type_check",
      sql`${table.type} IN ('buy', 'sell', 'cash_deposit', 'cash_withdrawal', 'fee', 'tax', 'split', 'opening_balance')`,
    ),
    check(
      "transactions_status_check",
      sql`${table.status} IN ('posted', 'reversed', 'superseded', 'void_pending')`,
    ),
    check(
      "transactions_source_type_check",
      sql`${table.sourceType} IN ('manual', 'csv_import', 'broker_sync', 'provider', 'system')`,
    ),
    check(
      "transactions_fee_amount_check",
      sql`${table.feeAmountDecimal} IS NOT NULL`,
    ),
    check(
      "transactions_tax_amount_check",
      sql`${table.taxAmountDecimal} IS NOT NULL`,
    ),
    check(
      "transactions_created_by_owner_check",
      sql`${table.createdByUserId} = ${table.userId}`,
    ),
    uniqueIndex("transactions_id_user_unique").on(table.id, table.userId),
    uniqueIndex("transactions_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("transactions_id_user_portfolio_security_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
      table.portfolioSecurityId,
    ),
    // BUG-018: this index used to be a FULL unique index, so
    // `ledger.reverse()` flipping a transaction to `status = 'reversed'`
    // (its `source_reference` is never cleared -- see `ledger.ts`'s
    // `reverse()`) permanently occupied the key: a reverse-then-re-import of
    // the SAME trade found the reversed row already sitting on the identity
    // and skipped forever, with no new ledger fact. Ledger facts are
    // immutable (AGENTS.md) -- the reversed row must never be rewritten or
    // deleted to free the slot -- so the constraint itself is narrowed to a
    // PARTIAL unique index that only governs NON-reversed rows, mirroring
    // `security_identifiers_sharesight_instrument_unique`'s and
    // `import_batches_commit_idempotency_unique`'s partial-index precedent.
    // A genuine re-import after a reversal is therefore a normal INSERT of a
    // brand-new posted row REUSING the same `source_reference` -- the
    // reversed original and its reversal mirror are untouched. No `ON
    // CONFLICT` clause in this codebase targets
    // `(portfolio_id, source_type, source_reference)` (grepped before this
    // change), so the narrowing needs no matching `ON CONFLICT ... WHERE`
    // update. `db/repositories/import-commit.ts`'s cross-batch trade lookup
    // and `app/import-actions.ts`'s `existingTradeSourceReferences`
    // suppression query gained the matching `status <> 'reversed'` predicate
    // in the same change so the commit skip set, the index, and the
    // advisory suppression set all agree on what counts as "occupying" the
    // key.
    uniqueIndex("transactions_portfolio_source_reference_unique")
      .on(table.portfolioId, table.sourceType, table.sourceReference)
      .where(sql`${table.status} <> 'reversed'`),
    uniqueIndex("transactions_owner_portfolio_idempotency_unique").on(
      table.userId,
      table.portfolioId,
      table.idempotencyKey,
    ),
    uniqueIndex("transactions_one_reversal_unique").on(
      table.reversesTransactionId,
    ),
    uniqueIndex("transactions_one_supersession_unique").on(
      table.supersedesTransactionId,
    ),
    index("transactions_owner_ledger_idx").on(
      table.userId,
      table.portfolioId,
      table.localTradeDate,
      table.id,
    ),
    index("transactions_security_trade_idx").on(
      table.portfolioId,
      table.portfolioSecurityId,
      table.tradeAt,
    ),
  ],
);

export const ledgerMutationGuards = sqliteTable(
  "ledger_mutation_guards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    valid: integer("valid").notNull(),
  },
  (table) => [
    foreignKey({
      name: "ledger_mutation_guards_security_owner_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    check("ledger_mutation_guards_valid_check", sql`${table.valid} = 1`),
  ],
);

export const manualLedgerMutationKeys = sqliteTable(
  "manual_ledger_mutation_keys",
  {
    key: text("key").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    purpose: text("purpose").notNull(),
    targetTransactionId: text("target_transaction_id"),
    resultTransactionId: text("result_transaction_id"),
    status: text("status").notNull().default("issued"),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [
    foreignKey({
      name: "manual_ledger_mutation_keys_portfolio_owner_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "manual_ledger_mutation_keys_target_owner_fk",
      columns: [table.targetTransactionId, table.userId, table.portfolioId],
      foreignColumns: [
        transactions.id,
        transactions.userId,
        transactions.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "manual_ledger_mutation_keys_result_owner_fk",
      columns: [table.resultTransactionId, table.userId, table.portfolioId],
      foreignColumns: [
        transactions.id,
        transactions.userId,
        transactions.portfolioId,
      ],
    }).onDelete("restrict"),
    check(
      "manual_ledger_mutation_keys_purpose_check",
      sql`${table.purpose} IN ('create', 'reverse', 'supersede')`,
    ),
    check(
      "manual_ledger_mutation_keys_status_check",
      sql`${table.status} IN ('issued', 'used')`,
    ),
    check(
      "manual_ledger_mutation_keys_target_check",
      sql`(${table.purpose} = 'create' AND ${table.targetTransactionId} IS NULL) OR (${table.purpose} IN ('reverse', 'supersede') AND ${table.targetTransactionId} IS NOT NULL)`,
    ),
    index("manual_ledger_mutation_keys_owner_portfolio_idx").on(
      table.userId,
      table.portfolioId,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const cashAccounts = sqliteTable(
  "cash_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    currencyCode: text("currency_code").notNull(),
    completeness: text("completeness").notNull(),
    status: text("status").notNull(),
  },
  (table) => [
    foreignKey({
      name: "cash_accounts_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "cash_accounts_currency_code_currencies_code_fk",
      columns: [table.currencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "cash_accounts_completeness_check",
      sql`${table.completeness} IN ('complete', 'opening_balance', 'incomplete')`,
    ),
    check(
      "cash_accounts_status_check",
      sql`${table.status} IN ('active', 'closed')`,
    ),
    uniqueIndex("cash_accounts_id_user_unique").on(table.id, table.userId),
    uniqueIndex("cash_accounts_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("cash_accounts_portfolio_currency_unique").on(
      table.portfolioId,
      table.currencyCode,
    ),
  ],
);

export const cashLedgerEntries = sqliteTable(
  "cash_ledger_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    cashAccountId: text("cash_account_id").notNull(),
    transactionId: text("transaction_id"),
    effectiveAt: text("effective_at").notNull(),
    localEffectiveDate: text("local_effective_date").notNull(),
    type: text("type").notNull(),
    signedAmountDecimal: text("signed_amount_decimal").notNull(),
    status: text("status").notNull(),
    reversesEntryId: text("reverses_entry_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "cash_entries_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "cash_entries_cash_account_id_user_id_portfolio_id_fk",
      columns: [table.cashAccountId, table.userId, table.portfolioId],
      foreignColumns: [
        cashAccounts.id,
        cashAccounts.userId,
        cashAccounts.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "cash_entries_transaction_id_user_id_portfolio_id_fk",
      columns: [table.transactionId, table.userId, table.portfolioId],
      foreignColumns: [
        transactions.id,
        transactions.userId,
        transactions.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "cash_entries_reverses_entry_id_user_id_portfolio_id_fk",
      columns: [table.reversesEntryId, table.userId, table.portfolioId],
      foreignColumns: [table.id, table.userId, table.portfolioId],
    }).onDelete("restrict"),
    check(
      "cash_entries_status_check",
      sql`${table.status} IN ('posted', 'reversed')`,
    ),
    check(
      "cash_entries_type_check",
      sql`${table.type} IN ('cash_deposit', 'cash_withdrawal', 'fee', 'tax', 'opening_balance', 'split')`,
    ),
    uniqueIndex("cash_entries_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("cash_entries_transaction_type_unique").on(
      table.transactionId,
      table.type,
    ),
    index("cash_entries_balance_idx").on(
      table.cashAccountId,
      table.effectiveAt,
      table.id,
    ),
  ],
);

export const priceObservations = sqliteTable(
  "price_observations",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    accessScope: text("access_scope").notNull(),
    scopeUserId: text("scope_user_id"),
    scopeKey: text("scope_key").notNull(),
    mappingId: text("mapping_id").notNull(),
    securityId: text("security_id").notNull(),
    interval: text("interval").notNull(),
    observationAt: text("observation_at").notNull(),
    marketDate: text("market_date").notNull(),
    marketTimezone: text("market_timezone").notNull(),
    currencyCode: text("currency_code").notNull(),
    closeDecimal: text("close_decimal").notNull(),
    previousCloseDecimal: text("previous_close_decimal"),
    adjustmentState: text("adjustment_state").notNull(),
    quality: text("quality").notNull(),
    delayedMinutes: integer("delayed_minutes"),
    ingestedAt: text("ingested_at").notNull(),
    providerRevisionId: text("provider_revision_id"),
    payloadSha256: text("payload_sha256"),
    // MKT-008: attribution to the owner-upload batch that CREATED this row
    // (review B1 fix, 2026-08-21: stamped on INSERT only -- an overlay/
    // conflict never reassigns it, see `price_upload_batches`' own header
    // comment for why), NULL for every row no such upload ever created
    // (Yahoo/Sharesight writes, and any row from before this column
    // existed). Deliberately a plain nullable ADD COLUMN with NO
    // table-level FK to `price_upload_batches` -- adding a real FK
    // constraint to this already-large, heavily-triggered table would
    // require a full REBUILD (see `sharesightSyncState`'s identical
    // disclosure a few tables below for why drizzle-kit cannot express a
    // new FK via plain `ALTER TABLE ADD COLUMN`), which would drop and
    // require hand-recreating this table's
    // `account_purge_lock_price_observations_*` triggers -- a much bigger
    // risk than this task's ADD COLUMN precedent (BRK-012B's
    // `lastPriceRefreshAt` trio) accepts.
    //
    // Review finding (2026-08-21): an earlier version of this comment
    // claimed the referential invariant was enforced by a same-`batch()`
    // guard/subquery mirroring `mapping_id`'s technique -- that was FALSE.
    // `db/repositories/price-uploads.ts` writes the batch row via its OWN separate
    // `run()`/`INSERT`, NOT inside the same atomic `batch()` call as the
    // chunked `price_observations` writes that reference it. What actually
    // prevents an orphaned reference is ORDERING, not shared-transaction
    // atomicity: `app/price-upload-service.ts`'s confirm flow creates the
    // `price_upload_batches` row FIRST (before any `price_observations`
    // chunk that could reference its id) and only UPDATEs that row's
    // `inserted_row_count` afterward -- so a crash before the batch row
    // exists writes no observations at all, and a crash partway through
    // the chunked writes simply leaves a batch row with fewer attributed
    // rows than its file contained, never a `price_observations` row
    // pointing at a batch id that was never created.
    uploadBatchId: text("upload_batch_id"),
  },
  (table) => [
    foreignKey({
      name: "price_observations_provider_id_market_data_providers_id_fk",
      columns: [table.providerId],
      foreignColumns: [marketDataProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_observations_scope_user_id_users_id_fk",
      columns: [table.scopeUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_observations_mapping_provider_security_fk",
      columns: [table.mappingId, table.providerId, table.securityId],
      foreignColumns: [
        securityProviderMappings.id,
        securityProviderMappings.providerId,
        securityProviderMappings.securityId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_observations_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "price_observations_currency_code_currencies_code_fk",
      columns: [table.currencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "price_observations_access_scope_check",
      sql`${table.accessScope} IN ('deployment', 'user')`,
    ),
    check(
      "price_observations_scope_check",
      sql`(${table.accessScope} = 'deployment' AND ${table.scopeUserId} IS NULL AND ${table.scopeKey} = 'deployment') OR (${table.accessScope} = 'user' AND ${table.scopeUserId} IS NOT NULL AND ${table.scopeKey} = ${table.scopeUserId})`,
    ),
    check(
      "price_observations_interval_check",
      sql`${table.interval} IN ('eod', 'delayed', 'intraday')`,
    ),
    check(
      "price_observations_adjustment_state_check",
      sql`${table.adjustmentState} IN ('raw', 'split_adjusted', 'total_return_adjusted')`,
    ),
    check(
      "price_observations_quality_check",
      sql`${table.quality} IN ('observed', 'corrected', 'indicative', 'stale_candidate')`,
    ),
    check(
      "price_observations_delayed_minutes_check",
      sql`${table.delayedMinutes} IS NULL OR ${table.delayedMinutes} >= 0`,
    ),
    uniqueIndex("price_observations_provider_scope_mapping_unique").on(
      table.providerId,
      table.scopeKey,
      table.mappingId,
      table.interval,
      table.observationAt,
      table.adjustmentState,
    ),
    // BRK-012B: a SECOND unique index, index-only (no rebuild, no
    // trigger-hazard -- `CREATE UNIQUE INDEX` never drops the table's
    // `account_purge_lock_price_observations_*` triggers). The unique index
    // above is keyed on the exact `observation_at` TIMESTAMP -- correct for
    // the EXISTING eod/corrections model (`market-data-refresh.ts`'s
    // upserts, `tests/calc-002-repository.test.ts`'s same-day "correction
    // received later" fixture), where TWO rows for the SAME `market_date`
    // but a DIFFERENT `observation_at` are a legitimate, intentional
    // same-day correction (selection picks the best one at read time; see
    // `domain/market-data/selection.ts`) -- a plain, unscoped
    // `market_date`-keyed unique index would make that pattern impossible
    // for EVERY provider, not just Sharesight (confirmed the hard way: an
    // earlier unscoped version of this index broke
    // `tests/calc-002-repository.test.ts`'s correction fixture with a real
    // UNIQUE constraint violation). Sharesight's accretion-forward model
    // (TASKS.md's BRK-012B RESCOPE) is different: it writes potentially
    // several observations across ONE trading day (each hourly refresh's
    // `current_price_updated_at`), and EVERY later write within the SAME
    // `market_date` must OVERWRITE the earlier one (converging toward the
    // close), never accumulate as a same-day "correction" row. This index
    // is therefore a PARTIAL unique index, scoped to `provider_id =
    // 'sharesight'` only -- every other provider's rows (including a future
    // one) are completely unaffected, and `db/repositories/sharesight-
    // price-refresh.ts`'s `ON CONFLICT (provider_id, scope_key, mapping_id,
    // interval, market_date, adjustment_state)` targets it precisely.
    uniqueIndex("price_observations_provider_scope_mapping_date_unique")
      .on(
        table.providerId,
        table.scopeKey,
        table.mappingId,
        table.interval,
        table.marketDate,
        table.adjustmentState,
      )
      .where(sql`${table.providerId} = 'sharesight'`),
    // MKT-011A review round 2 (2026-08-22, B2 REVERSAL): a THIRD unique
    // index, same index-only/no-rebuild/no-trigger-hazard shape as the
    // `sharesight` partial index immediately above. The Orchestrator's
    // original MKT-011A ruling assumed a pre-existing multi-row-per-day
    // `yahoo-compatible` `delayed` writer (the ordinary hourly refresh) that
    // an application-level "insert only if newer" check would need to
    // coexist with; the reviewer traced the actual write path and
    // disproved that premise -- the hourly refresh
    // (`domain/market-data/ingestion.ts`) calls ONLY `getDailyPrices`,
    // whose observations are hardcoded `interval = 'eod'`
    // (`yahoo-compatible.ts`'s `getDailyPrices` call site). `getLatestObservation`
    // is the ONLY producer of a `yahoo-compatible` `delayed` row, and its
    // sole call site in this codebase is MKT-011A's own sweep
    // (`app/daily-price-capture-service.ts`). There is therefore no
    // legitimate multi-row-per-day `delayed` pattern to protect for this
    // provider (unlike Sharesight's own accretion history, and unlike this
    // SAME provider's `eod` rows -- see the correction pattern documented
    // on the index above), so the one-row-per-day invariant can and should
    // be enforced STRUCTURALLY here too, exactly like the `sharesight`
    // index does.
    //
    // Scoped `WHERE provider_id = 'yahoo-compatible' AND interval =
    // 'delayed'` -- narrower than the `sharesight` index above (which only
    // needs `provider_id`, since Sharesight never writes `eod` rows at
    // all). The extra `interval = 'delayed'` predicate is REQUIRED here: a
    // `yahoo-compatible` `eod` row (from `getDailyPrices`) can legitimately
    // receive a same-day correction at a later `observation_at` (the exact
    // pattern the comment on the FIRST unique index above documents) --
    // without this predicate, this new index would ALSO constrain `eod`
    // rows to one-per-`market_date`, silently breaking that pre-existing,
    // unrelated correction capability for this provider's `eod` history.
    // Scoping to `interval = 'delayed'` leaves every `eod` row, for every
    // provider, completely untouched by this index (verified reasoning,
    // not merely asserted -- see `tests/mkt-011a.test.ts`'s
    // "eod rows ... coexist untouched" pin).
    //
    // Safe to add against existing data (verified reasoning): this index
    // can only ever reject a SECOND `yahoo-compatible`/`delayed` row for
    // the same (scope_key, mapping_id, market_date, adjustment_state) --
    // per the trace above, no such row has ever been written by any
    // deployed code path (MKT-011A's rollup, the only writer, is
    // uncommitted at the time this migration is authored), so no existing
    // row can violate it.
    uniqueIndex("price_observations_yahoo_scope_mapping_date_unique")
      .on(
        table.providerId,
        table.scopeKey,
        table.mappingId,
        table.interval,
        table.marketDate,
        table.adjustmentState,
      )
      .where(
        sql`${table.providerId} = 'yahoo-compatible' AND ${table.interval} = 'delayed'`,
      ),
    index("price_observations_security_date_idx").on(
      table.securityId,
      table.adjustmentState,
      table.marketDate,
    ),
    // MKT-008: delete-by-upload (the "undo this import" affordance) scans
    // by `upload_batch_id` alone -- this index keeps that bounded instead of
    // a full table scan. Index-only, no rebuild, no trigger hazard.
    index("price_observations_upload_batch_idx").on(table.uploadBatchId),
  ],
);

export const fxRateObservations = sqliteTable(
  "fx_rate_observations",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    accessScope: text("access_scope").notNull(),
    scopeUserId: text("scope_user_id"),
    scopeKey: text("scope_key").notNull(),
    baseCurrencyCode: text("base_currency_code").notNull(),
    quoteCurrencyCode: text("quote_currency_code").notNull(),
    rateDecimal: text("rate_decimal").notNull(),
    interval: text("interval").notNull(),
    observedAt: text("observed_at").notNull(),
    marketDate: text("market_date").notNull(),
    quality: text("quality").notNull(),
    ingestedAt: text("ingested_at").notNull(),
    payloadSha256: text("payload_sha256"),
  },
  (table) => [
    foreignKey({
      name: "fx_rate_observations_provider_id_market_data_providers_id_fk",
      columns: [table.providerId],
      foreignColumns: [marketDataProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fx_rate_observations_scope_user_id_users_id_fk",
      columns: [table.scopeUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fx_rate_observations_base_currency_code_currencies_code_fk",
      columns: [table.baseCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    foreignKey({
      name: "fx_rate_observations_quote_currency_code_currencies_code_fk",
      columns: [table.quoteCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "fx_rate_observations_access_scope_check",
      sql`${table.accessScope} IN ('deployment', 'user')`,
    ),
    check(
      "fx_rate_observations_scope_check",
      sql`(${table.accessScope} = 'deployment' AND ${table.scopeUserId} IS NULL AND ${table.scopeKey} = 'deployment') OR (${table.accessScope} = 'user' AND ${table.scopeUserId} IS NOT NULL AND ${table.scopeKey} = ${table.scopeUserId})`,
    ),
    check(
      "fx_rate_observations_pair_check",
      sql`${table.baseCurrencyCode} <> ${table.quoteCurrencyCode}`,
    ),
    check(
      "fx_rate_observations_interval_check",
      sql`${table.interval} IN ('eod', 'delayed', 'intraday')`,
    ),
    check(
      "fx_rate_observations_quality_check",
      sql`${table.quality} IN ('observed', 'corrected', 'indicative', 'stale_candidate')`,
    ),
    uniqueIndex("fx_rate_observations_provider_scope_pair_unique").on(
      table.providerId,
      table.scopeKey,
      table.baseCurrencyCode,
      table.quoteCurrencyCode,
      table.interval,
      table.observedAt,
    ),
    index("fx_rate_observations_pair_date_idx").on(
      table.baseCurrencyCode,
      table.quoteCurrencyCode,
      table.marketDate,
    ),
  ],
);

export const marketDataRefreshJobs = sqliteTable(
  "market_data_refresh_jobs",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    targetKind: text("target_kind").notNull(),
    targetKey: text("target_key").notNull(),
    mappingId: text("mapping_id"),
    securityId: text("security_id"),
    baseCurrencyCode: text("base_currency_code"),
    quoteCurrencyCode: text("quote_currency_code"),
    accessScope: text("access_scope").notNull(),
    scopeUserId: text("scope_user_id"),
    scopeKey: text("scope_key").notNull(),
    rangeFrom: text("range_from").notNull(),
    rangeTo: text("range_to").notNull(),
    highWaterDate: text("high_water_date"),
    chunkDays: integer("chunk_days").notNull().default(5),
    status: text("status").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    nextAttemptAt: text("next_attempt_at").notNull(),
    providerRequestCount: integer("provider_request_count")
      .notNull()
      .default(0),
    observationCount: integer("observation_count").notNull().default(0),
    correctionCount: integer("correction_count").notNull().default(0),
    lastErrorKind: text("last_error_kind"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "market_data_refresh_jobs_provider_id_fk",
      columns: [table.providerId],
      foreignColumns: [marketDataProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "market_data_refresh_jobs_scope_user_id_fk",
      columns: [table.scopeUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "market_data_refresh_jobs_mapping_provider_security_fk",
      columns: [table.mappingId, table.providerId, table.securityId],
      foreignColumns: [
        securityProviderMappings.id,
        securityProviderMappings.providerId,
        securityProviderMappings.securityId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "market_data_refresh_jobs_base_currency_fk",
      columns: [table.baseCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    foreignKey({
      name: "market_data_refresh_jobs_quote_currency_fk",
      columns: [table.quoteCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "market_data_refresh_jobs_target_kind_check",
      sql`${table.targetKind} IN ('price', 'fx')`,
    ),
    check(
      "market_data_refresh_jobs_target_shape_check",
      sql`(${table.targetKind} = 'price' AND ${table.mappingId} IS NOT NULL AND ${table.securityId} IS NOT NULL AND ${table.baseCurrencyCode} IS NULL AND ${table.quoteCurrencyCode} IS NULL) OR (${table.targetKind} = 'fx' AND ${table.mappingId} IS NULL AND ${table.securityId} IS NULL AND ${table.baseCurrencyCode} IS NOT NULL AND ${table.quoteCurrencyCode} IS NOT NULL AND ${table.baseCurrencyCode} <> ${table.quoteCurrencyCode})`,
    ),
    check(
      "market_data_refresh_jobs_access_scope_check",
      sql`${table.accessScope} IN ('deployment', 'user')`,
    ),
    check(
      "market_data_refresh_jobs_scope_check",
      sql`(${table.accessScope} = 'deployment' AND ${table.scopeUserId} IS NULL AND ${table.scopeKey} = 'deployment') OR (${table.accessScope} = 'user' AND ${table.scopeUserId} IS NOT NULL AND ${table.scopeKey} = ${table.scopeUserId})`,
    ),
    check(
      "market_data_refresh_jobs_range_check",
      sql`${table.rangeTo} >= ${table.rangeFrom}`,
    ),
    check(
      "market_data_refresh_jobs_high_water_check",
      sql`${table.highWaterDate} IS NULL OR (${table.highWaterDate} >= ${table.rangeFrom} AND ${table.highWaterDate} <= ${table.rangeTo})`,
    ),
    check(
      "market_data_refresh_jobs_chunk_days_check",
      sql`${table.chunkDays} BETWEEN 1 AND 5`,
    ),
    check(
      "market_data_refresh_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed')`,
    ),
    check("market_data_refresh_jobs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "market_data_refresh_jobs_provider_request_count_check",
      sql`${table.providerRequestCount} >= 0`,
    ),
    check(
      "market_data_refresh_jobs_observation_count_check",
      sql`${table.observationCount} >= 0`,
    ),
    check(
      "market_data_refresh_jobs_correction_count_check",
      sql`${table.correctionCount} >= 0`,
    ),
    uniqueIndex("market_data_refresh_jobs_idempotency_unique").on(
      table.providerId,
      table.scopeKey,
      table.targetKind,
      table.targetKey,
      table.idempotencyKey,
    ),
    uniqueIndex("market_data_refresh_jobs_one_active_target_unique")
      .on(table.providerId, table.scopeKey, table.targetKind, table.targetKey)
      .where(sql`${table.status} IN ('queued', 'running')`),
    index("market_data_refresh_jobs_claim_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
    index("market_data_refresh_jobs_target_idx").on(
      table.providerId,
      table.scopeKey,
      table.targetKind,
      table.targetKey,
      table.status,
    ),
  ],
);

export const manualOverrides = sqliteTable(
  "manual_overrides",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id"),
    securityId: text("security_id"),
    type: text("type").notNull(),
    targetKey: text("target_key").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to"),
    valueJson: text("value_json").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    supersedesOverrideId: text("supersedes_override_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "manual_overrides_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "manual_overrides_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "manual_overrides_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "manual_overrides_supersedes_override_id_fk",
      columns: [table.supersedesOverrideId, table.userId],
      foreignColumns: [table.id, table.userId],
    }).onDelete("restrict"),
    check(
      "manual_overrides_type_check",
      sql`${table.type} IN ('price', 'fx_rate', 'security_mapping', 'transaction_fx')`,
    ),
    check(
      "manual_overrides_status_check",
      sql`${table.status} IN ('active', 'superseded', 'revoked')`,
    ),
    check(
      "manual_overrides_effective_interval_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    index("manual_overrides_active_idx").on(
      table.userId,
      table.type,
      table.targetKey,
      table.status,
      table.effectiveFrom,
    ),
    uniqueIndex("manual_overrides_id_user_unique").on(table.id, table.userId),
  ],
);

export const portfolioDailySnapshots = sqliteTable(
  "portfolio_daily_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    baseCurrencyCode: text("base_currency_code").notNull(),
    securitiesValueDecimal: text("securities_value_decimal"),
    cashValueDecimal: text("cash_value_decimal"),
    totalValueDecimal: text("total_value_decimal"),
    costBasisDecimal: text("cost_basis_decimal"),
    unrealisedGainDecimal: text("unrealised_gain_decimal"),
    realisedGainToDateDecimal: text("realised_gain_to_date_decimal"),
    dailyMovementDecimal: text("daily_movement_decimal"),
    coverageJson: text("coverage_json").notNull(),
    completeness: text("completeness").notNull(),
    status: text("status").notNull().default("ready"),
    ledgerHighWater: text("ledger_high_water").notNull(),
    marketDataCutoff: text("market_data_cutoff"),
    calculationRunId: text("calculation_run_id"),
    calculationVersion: integer("calculation_version").notNull(),
    rebuiltAt: text("rebuilt_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "portfolio_snapshots_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "portfolio_snapshots_base_currency_code_currencies_code_fk",
      columns: [table.baseCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "portfolio_snapshots_completeness_check",
      sql`${table.completeness} IN ('complete', 'partial', 'incomplete')`,
    ),
    check(
      "portfolio_snapshots_status_check",
      sql`${table.status} IN ('ready', 'invalidated')`,
    ),
    uniqueIndex("portfolio_snapshots_id_user_portfolio_date_version_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
      table.snapshotDate,
      table.calculationVersion,
    ),
    uniqueIndex("portfolio_snapshots_portfolio_date_version_unique").on(
      table.portfolioId,
      table.snapshotDate,
      table.calculationVersion,
      table.calculationRunId,
    ),
    index("portfolio_snapshots_chart_idx").on(
      table.portfolioId,
      table.snapshotDate,
    ),
  ],
);

export const holdingDailySnapshots = sqliteTable(
  "holding_daily_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    portfolioSnapshotId: text("portfolio_snapshot_id").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    quantityDecimal: text("quantity_decimal").notNull(),
    nativeValueDecimal: text("native_value_decimal"),
    baseValueDecimal: text("base_value_decimal"),
    basisDecimal: text("basis_decimal"),
    priceObservationId: text("price_observation_id"),
    fxObservationId: text("fx_observation_id"),
    calendarSessionId: text("calendar_session_id"),
    calendarSessionDate: text("calendar_session_date"),
    calendarSessionCloseAt: text("calendar_session_close_at"),
    calendarEvidenceVersion: integer("calendar_evidence_version"),
    calculationRunId: text("calculation_run_id"),
    dailyMovementDecimal: text("daily_movement_decimal"),
    completeness: text("completeness").notNull(),
    status: text("status").notNull().default("ready"),
    calculationVersion: integer("calculation_version").notNull(),
  },
  (table) => [
    foreignKey({
      name: "holding_snapshots_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "holding_snapshots_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "holding_snapshots_snapshot_id_user_portfolio_date_version_fk",
      columns: [
        table.portfolioSnapshotId,
        table.userId,
        table.portfolioId,
        table.snapshotDate,
        table.calculationVersion,
      ],
      foreignColumns: [
        portfolioDailySnapshots.id,
        portfolioDailySnapshots.userId,
        portfolioDailySnapshots.portfolioId,
        portfolioDailySnapshots.snapshotDate,
        portfolioDailySnapshots.calculationVersion,
      ],
    }).onDelete("restrict"),
    check(
      "holding_snapshots_completeness_check",
      sql`${table.completeness} IN ('complete', 'partial', 'incomplete')`,
    ),
    check(
      "holding_snapshots_status_check",
      sql`${table.status} IN ('ready', 'invalidated')`,
    ),
    uniqueIndex("holding_snapshots_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("holding_snapshots_security_date_version_unique").on(
      table.portfolioId,
      table.portfolioSecurityId,
      table.snapshotDate,
      table.calculationVersion,
      table.calculationRunId,
    ),
    index("holding_snapshots_chart_idx").on(
      table.portfolioId,
      table.portfolioSecurityId,
      table.snapshotDate,
    ),
  ],
);

export const calculationRuns = sqliteTable(
  "calculation_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    rangeFrom: text("range_from").notNull(),
    rangeTo: text("range_to").notNull(),
    calculationVersion: integer("calculation_version").notNull(),
    reason: text("reason").notNull(),
    invalidationSource: text("invalidation_source"),
    // CALC-004: discriminates the two independent resumable pipelines that
    // share this row shape -- `projection` (holdings/lots/allocations,
    // `db/repositories/projections.ts`) and `snapshot` (the Overview daily
    // history chart, `db/repositories/snapshots.ts`). `claim`/`complete`
    // are one-shot terminal transitions on a run, so the two pipelines
    // cannot share one row without one completing foreclosing the other;
    // every queueing site now inserts ONE row per pipeline per triggering
    // event, and the executor's coalescing queries (`nextClaimable`,
    // `hasNewerRun`, `supersedeStaleQueuedRuns`, `listClaimablePortfolios`)
    // are scoped by this column so a newer run in one pipeline never
    // supersedes an in-progress run in the other. Defaults to `projection`
    // so every pre-existing raw INSERT (`ledger.ts`, `import-commit.ts`,
    // `market-data.ts`) that does not yet name this column keeps its
    // existing (correct) pipeline identity unchanged.
    pipeline: text("pipeline").notNull().default("projection"),
    status: text("status").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    // CALC-004 review-round B1 fix: `attempt` increments on EVERY claim,
    // including ordinary budget-exhaustion re-claims that make real
    // forward progress (a multi-year snapshot range can legitimately need
    // 100+ claims at a small read-time budget) -- it cannot distinguish a
    // healthy, slowly-progressing run from a genuinely poisoned one that
    // never advances. `stall_count`/`stall_checkpoint` track that instead:
    // at each claim, `app/calculation-executor-service.ts` compares the
    // run's current checkpoint columns (a fingerprint of
    // `processed_snapshot_count`/`processed_holding_count`/
    // `processed_ledger_count`/`projection_output_offset`/
    // `projection_cursor_security_id`/`projection_active_security_id` --
    // every column either pipeline's rebuild can advance) against the
    // fingerprint recorded at the PREVIOUS claim; unchanged increments
    // `stall_count`, any movement resets it to 0. Only `stall_count`
    // reaching the executor's threshold terminates a run -- never
    // `attempt` alone.
    stallCount: integer("stall_count").notNull().default(0),
    stallCheckpoint: text("stall_checkpoint"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    ledgerHighWaterStart: text("ledger_high_water_start").notNull(),
    ledgerHighWaterEnd: text("ledger_high_water_end"),
    marketDataCutoff: text("market_data_cutoff"),
    calendarEvidenceJson: text("calendar_evidence_json"),
    processedSnapshotCount: integer("processed_snapshot_count")
      .notNull()
      .default(0),
    processedHoldingCount: integer("processed_holding_count")
      .notNull()
      .default(0),
    processedLedgerCount: integer("processed_ledger_count")
      .notNull()
      .default(0),
    projectionCursorSecurityId: text("projection_cursor_security_id"),
    projectionActiveSecurityId: text("projection_active_security_id"),
    projectionOutputOffset: integer("projection_output_offset")
      .notNull()
      .default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    failureCategory: text("failure_category"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "calculation_runs_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    check(
      "calculation_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'abandoned')`,
    ),
    check(
      "calculation_runs_pipeline_check",
      sql`${table.pipeline} IN ('projection', 'snapshot')`,
    ),
    check(
      "calculation_runs_range_check",
      sql`${table.rangeTo} >= ${table.rangeFrom}`,
    ),
    check("calculation_runs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "calculation_runs_snapshot_count_check",
      sql`${table.processedSnapshotCount} >= 0`,
    ),
    check(
      "calculation_runs_holding_count_check",
      sql`${table.processedHoldingCount} >= 0`,
    ),
    check(
      "calculation_runs_ledger_count_check",
      sql`${table.processedLedgerCount} >= 0`,
    ),
    check(
      "calculation_runs_projection_output_offset_check",
      sql`${table.projectionOutputOffset} >= 0`,
    ),
    uniqueIndex("calculation_runs_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("calculation_runs_idempotency_unique").on(
      table.userId,
      table.portfolioId,
      table.calculationVersion,
      table.idempotencyKey,
    ),
    index("calculation_runs_lease_idx").on(table.status, table.leaseExpiresAt),
    index("calculation_runs_portfolio_status_idx").on(
      table.userId,
      table.portfolioId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const snapshotPublications = sqliteTable(
  "snapshot_publications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    calculationVersion: integer("calculation_version").notNull(),
    calculationRunId: text("calculation_run_id").notNull(),
    ledgerHighWater: text("ledger_high_water").notNull(),
    publishedAt: text("published_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "snapshot_publications_portfolio_owner_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "snapshot_publications_run_owner_portfolio_fk",
      columns: [table.calculationRunId, table.userId, table.portfolioId],
      foreignColumns: [
        calculationRuns.id,
        calculationRuns.userId,
        calculationRuns.portfolioId,
      ],
    }).onDelete("restrict"),
    uniqueIndex("snapshot_publications_owner_version_unique").on(
      table.userId,
      table.portfolioId,
      table.calculationVersion,
    ),
    index("snapshot_publications_owner_portfolio_idx").on(
      table.userId,
      table.portfolioId,
      table.publishedAt,
    ),
  ],
);

export const projectionPublications = sqliteTable(
  "projection_publications",
  {
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").primaryKey(),
    calculationRunId: text("calculation_run_id").notNull(),
    calculationVersion: integer("calculation_version").notNull(),
    ledgerHighWater: text("ledger_high_water").notNull(),
    publishedAt: text("published_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "projection_publications_portfolio_owner_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "projection_publications_run_owner_portfolio_fk",
      columns: [table.calculationRunId, table.userId, table.portfolioId],
      foreignColumns: [
        calculationRuns.id,
        calculationRuns.userId,
        calculationRuns.portfolioId,
      ],
    }).onDelete("restrict"),
    uniqueIndex("projection_publications_owner_portfolio_unique").on(
      table.userId,
      table.portfolioId,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    targetOwnerUserId: text("target_owner_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    requestId: text("request_id").notNull(),
    result: text("result").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "audit_events_actor_user_id_users_id_fk",
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "audit_events_target_owner_user_id_users_id_fk",
      columns: [table.targetOwnerUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "audit_events_result_check",
      sql`${table.result} IN ('success', 'failure', 'denied')`,
    ),
    index("audit_events_owner_time_idx").on(
      table.targetOwnerUserId,
      table.occurredAt,
    ),
  ],
);

export const accountLifecycleRequests = sqliteTable(
  "account_lifecycle_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    actorUserId: text("actor_user_id"),
    requestType: text("request_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("completed"),
    includeExport: integer("include_export", { mode: "boolean" })
      .notNull()
      .default(false),
    exportJobId: text("export_job_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "account_lifecycle_requests_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "account_lifecycle_requests_actor_user_id_users_id_fk",
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "account_lifecycle_requests_type_check",
      sql`${table.requestType} IN ('disable', 'deletion', 'export')`,
    ),
    check(
      "account_lifecycle_requests_status_check",
      sql`${table.status} IN ('completed')`,
    ),
    check(
      "account_lifecycle_requests_include_export_check",
      sql`${table.includeExport} IN (0, 1)`,
    ),
    uniqueIndex("account_lifecycle_requests_owner_type_key_unique").on(
      table.userId,
      table.requestType,
      table.idempotencyKey,
    ),
    uniqueIndex("account_lifecycle_requests_id_owner_unique").on(
      table.id,
      table.userId,
    ),
    index("account_lifecycle_requests_owner_type_created_idx").on(
      table.userId,
      table.requestType,
      table.createdAt,
    ),
  ],
);

export const accountExportJobs = sqliteTable(
  "account_export_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    lifecycleRequestId: text("lifecycle_request_id").notNull(),
    phase: text("phase").notNull().default("capture"),
    status: text("status").notNull().default("queued"),
    tableIndex: integer("table_index").notNull().default(0),
    rowCursor: integer("row_cursor").notNull().default(0),
    reconcileTableIndex: integer("reconcile_table_index").notNull().default(0),
    reconcileRowCursor: integer("reconcile_row_cursor").notNull().default(0),
    reconcileDigest: text("reconcile_digest").notNull().default("0"),
    reconcileRowCount: integer("reconcile_row_count").notNull().default(0),
    captureFragmentOffset: integer("capture_fragment_offset")
      .notNull()
      .default(0),
    finalizeTableName: text("finalize_table_name").notNull().default(""),
    finalizeChunkIndex: integer("finalize_chunk_index").notNull().default(-1),
    finalizeDigest: text("finalize_digest").notNull().default("0"),
    operationalAuditHighWater: integer("operational_audit_high_water")
      .notNull()
      .default(0),
    rowCount: integer("row_count").notNull().default(0),
    objectCount: integer("object_count").notNull().default(0),
    version: integer("version").notNull().default(1),
    manifestDigest: text("manifest_digest"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "account_export_jobs_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "account_export_jobs_request_owner_fk",
      columns: [table.lifecycleRequestId, table.userId],
      foreignColumns: [
        accountLifecycleRequests.id,
        accountLifecycleRequests.userId,
      ],
    }).onDelete("restrict"),
    check(
      "account_export_jobs_phase_check",
      sql`${table.phase} IN ('capture', 'reconcile', 'finalize')`,
    ),
    check(
      "account_export_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'expired')`,
    ),
    check(
      "account_export_jobs_cursor_check",
      sql`${table.tableIndex} >= 0 AND ${table.rowCursor} >= 0`,
    ),
    check(
      "account_export_jobs_reconcile_cursor_check",
      sql`${table.reconcileTableIndex} >= 0 AND ${table.reconcileRowCursor} >= 0`,
    ),
    check(
      "account_export_jobs_count_check",
      sql`${table.rowCount} >= 0 AND ${table.objectCount} >= 0 AND ${table.reconcileRowCount} >= 0 AND ${table.captureFragmentOffset} >= 0 AND ${table.finalizeChunkIndex} >= -1 AND ${table.operationalAuditHighWater} >= 0`,
    ),
    uniqueIndex("account_export_jobs_request_unique").on(
      table.lifecycleRequestId,
    ),
    uniqueIndex("account_export_jobs_id_owner_unique").on(
      table.id,
      table.userId,
    ),
    index("account_export_jobs_owner_status_idx").on(
      table.userId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const accountExportCheckpointGuards = sqliteTable(
  "account_export_checkpoint_guards",
  {
    id: text("id").primaryKey(),
    exportJobId: text("export_job_id").notNull(),
    userId: text("user_id").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    valid: integer("valid").notNull(),
  },
  (table) => [
    foreignKey({
      name: "account_export_checkpoint_guards_job_owner_fk",
      columns: [table.exportJobId, table.userId],
      foreignColumns: [accountExportJobs.id, accountExportJobs.userId],
    }).onDelete("restrict"),
    check(
      "account_export_checkpoint_guards_valid_check",
      sql`${table.valid} = 1`,
    ),
    index("account_export_checkpoint_guards_owner_job_idx").on(
      table.userId,
      table.exportJobId,
    ),
  ],
);

export const accountExportManifest = sqliteTable(
  "account_export_manifest",
  {
    id: text("id").primaryKey(),
    exportJobId: text("export_job_id").notNull(),
    userId: text("user_id").notNull(),
    tableName: text("table_name").notNull(),
    classification: text("classification").notNull(),
    retention: text("retention").notNull(),
    reason: text("reason").notNull(),
    sourceRowCount: integer("source_row_count").notNull().default(0),
    capturedRowCount: integer("captured_row_count").notNull().default(0),
    objectCount: integer("object_count").notNull().default(0),
    digest: text("digest").notNull().default("0"),
    cutoffCursor: text("cutoff_cursor"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "account_export_manifest_job_owner_fk",
      columns: [table.exportJobId, table.userId],
      foreignColumns: [accountExportJobs.id, accountExportJobs.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "account_export_manifest_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    uniqueIndex("account_export_manifest_job_table_unique").on(
      table.exportJobId,
      table.tableName,
    ),
    index("account_export_manifest_owner_job_idx").on(
      table.userId,
      table.exportJobId,
    ),
  ],
);

export const accountExportChunks = sqliteTable(
  "account_export_chunks",
  {
    id: text("id").primaryKey(),
    exportJobId: text("export_job_id").notNull(),
    userId: text("user_id").notNull(),
    tableName: text("table_name").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    payloadJson: text("payload_json").notNull(),
    rowCount: integer("row_count").notNull(),
    digest: text("digest").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "account_export_chunks_job_owner_fk",
      columns: [table.exportJobId, table.userId],
      foreignColumns: [accountExportJobs.id, accountExportJobs.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "account_export_chunks_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "account_export_chunks_index_check",
      sql`${table.chunkIndex} >= 0 AND ${table.rowCount} BETWEEN 1 AND 8`,
    ),
    uniqueIndex("account_export_chunks_job_table_index_unique").on(
      table.exportJobId,
      table.tableName,
      table.chunkIndex,
    ),
    index("account_export_chunks_owner_job_idx").on(
      table.userId,
      table.exportJobId,
      table.chunkIndex,
    ),
  ],
);

/**
 * Durable, owner-scoped deletion state. The job deliberately has no foreign
 * keys to user/export rows: its redacted completion proof must remain after
 * those rows and artifacts have been purged.
 */
export const accountPurgeJobs = sqliteTable(
  "account_purge_jobs",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    deletionRequestId: text("deletion_request_id").notNull(),
    deletionKeyDigest: text("deletion_key_digest").notNull(),
    exportJobId: text("export_job_id").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    status: text("status").notNull().default("queued"),
    phase: text("phase").notNull().default("validate_source"),
    targetIndex: integer("target_index").notNull().default(0),
    rowCursor: integer("row_cursor").notNull().default(0),
    rollingDigest: text("rolling_digest").notNull().default("0"),
    rollingCount: integer("rolling_count").notNull().default(0),
    chunkTableName: text("chunk_table_name").notNull().default(""),
    chunkIndex: integer("chunk_index").notNull().default(-1),
    version: integer("version").notNull().default(1),
    deletedCountsJson: text("deleted_counts_json").notNull().default("{}"),
    failureCode: text("failure_code"),
    eligibleAt: text("eligible_at").notNull(),
    confirmedAt: text("confirmed_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "account_purge_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed')`,
    ),
    check(
      "account_purge_jobs_phase_check",
      sql`${table.phase} IN ('validate_source', 'validate_chunks', 'purge', 'verify', 'cleanup', 'complete')`,
    ),
    check(
      "account_purge_jobs_cursor_check",
      sql`${table.targetIndex} >= 0 AND ${table.rowCursor} >= 0 AND ${table.rollingCount} >= 0 AND ${table.chunkIndex} >= -1`,
    ),
    uniqueIndex("account_purge_jobs_deletion_request_unique").on(
      table.deletionRequestId,
    ),
    uniqueIndex("account_purge_jobs_owner_export_unique").on(
      table.ownerUserId,
      table.exportJobId,
    ),
    index("account_purge_jobs_owner_status_idx").on(
      table.ownerUserId,
      table.status,
      table.updatedAt,
    ),
  ],
);

/** Transaction-local capability consumed only by the audit delete trigger. */
export const accountPurgeAuditGuards = sqliteTable(
  "account_purge_audit_guards",
  {
    ownerUserId: text("owner_user_id").primaryKey(),
    purgeJobId: text("purge_job_id").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    valid: integer("valid").notNull(),
  },
  (table) => [
    check("account_purge_audit_guards_valid_check", sql`${table.valid} = 1`),
  ],
);

export const taxLots = sqliteTable(
  "tax_lots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    openingTransactionId: text("opening_transaction_id").notNull(),
    acquiredAt: text("acquired_at").notNull(),
    originalQuantityDecimal: text("original_quantity_decimal").notNull(),
    openQuantityDecimal: text("open_quantity_decimal").notNull(),
    nativeBasisDecimal: text("native_basis_decimal"),
    baseBasisDecimal: text("base_basis_decimal"),
    basisStatus: text("basis_status").notNull(),
    status: text("status").notNull(),
    calculationRunId: text("calculation_run_id").notNull(),
    calculationVersion: integer("calculation_version").notNull(),
    rebuiltAt: text("rebuilt_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "tax_lots_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "tax_lots_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "tax_lots_opening_transaction_owner_security_fk",
      columns: [
        table.openingTransactionId,
        table.userId,
        table.portfolioId,
        table.portfolioSecurityId,
      ],
      foreignColumns: [
        transactions.id,
        transactions.userId,
        transactions.portfolioId,
        transactions.portfolioSecurityId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "tax_lots_calculation_run_owner_portfolio_fk",
      columns: [table.calculationRunId, table.userId, table.portfolioId],
      foreignColumns: [
        calculationRuns.id,
        calculationRuns.userId,
        calculationRuns.portfolioId,
      ],
    }).onDelete("restrict"),
    check(
      "tax_lots_basis_status_check",
      sql`${table.basisStatus} IN ('complete', 'incomplete_fx', 'incomplete_basis')`,
    ),
    check(
      "tax_lots_status_check",
      sql`${table.status} IN ('open', 'closed', 'incomplete')`,
    ),
    uniqueIndex("tax_lots_id_user_unique").on(table.id, table.userId),
    uniqueIndex("tax_lots_id_user_portfolio_security_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
      table.portfolioSecurityId,
    ),
    uniqueIndex("tax_lots_opening_transaction_run_unique").on(
      table.openingTransactionId,
      table.calculationRunId,
    ),
    index("tax_lots_fifo_idx").on(
      table.portfolioId,
      table.portfolioSecurityId,
      table.acquiredAt,
      table.id,
    ),
  ],
);

export const lotAllocations = sqliteTable(
  "lot_allocations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    sellTransactionId: text("sell_transaction_id").notNull(),
    taxLotId: text("tax_lot_id").notNull(),
    allocationSequence: integer("allocation_sequence").notNull(),
    matchedQuantityDecimal: text("matched_quantity_decimal").notNull(),
    allocatedBaseBasisDecimal: text("allocated_base_basis_decimal"),
    baseNetProceedsDecimal: text("base_net_proceeds_decimal"),
    feeBaseDecimal: text("fee_base_decimal"),
    taxBaseDecimal: text("tax_base_decimal"),
    baseRealisedGainDecimal: text("base_realised_gain_decimal"),
    basisStatus: text("basis_status").notNull(),
    calculationRunId: text("calculation_run_id").notNull(),
    calculationVersion: integer("calculation_version").notNull(),
  },
  (table) => [
    foreignKey({
      name: "lot_allocations_sell_transaction_owner_security_fk",
      columns: [
        table.sellTransactionId,
        table.userId,
        table.portfolioId,
        table.portfolioSecurityId,
      ],
      foreignColumns: [
        transactions.id,
        transactions.userId,
        transactions.portfolioId,
        transactions.portfolioSecurityId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "lot_allocations_lot_owner_portfolio_security_fk",
      columns: [
        table.taxLotId,
        table.userId,
        table.portfolioId,
        table.portfolioSecurityId,
      ],
      foreignColumns: [
        taxLots.id,
        taxLots.userId,
        taxLots.portfolioId,
        taxLots.portfolioSecurityId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "lot_allocations_calculation_run_owner_portfolio_fk",
      columns: [table.calculationRunId, table.userId, table.portfolioId],
      foreignColumns: [
        calculationRuns.id,
        calculationRuns.userId,
        calculationRuns.portfolioId,
      ],
    }).onDelete("restrict"),
    check(
      "lot_allocations_basis_status_check",
      sql`${table.basisStatus} IN ('complete', 'incomplete_fx', 'incomplete_basis')`,
    ),
    uniqueIndex("lot_allocations_sell_lot_sequence_unique").on(
      table.sellTransactionId,
      table.taxLotId,
      table.allocationSequence,
      table.calculationRunId,
    ),
    index("lot_allocations_owner_sell_idx").on(
      table.userId,
      table.portfolioId,
      table.sellTransactionId,
    ),
  ],
);

export const holdingProjections = sqliteTable(
  "holding_projections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    quantityDecimal: text("quantity_decimal").notNull(),
    nativeOpenBasisDecimal: text("native_open_basis_decimal"),
    baseOpenBasisDecimal: text("base_open_basis_decimal"),
    averageBaseCostDecimal: text("average_base_cost_decimal"),
    completeness: text("completeness").notNull(),
    status: text("status").notNull().default("ready"),
    lastLedgerHighWater: text("last_ledger_high_water").notNull(),
    calculationRunId: text("calculation_run_id").notNull(),
    calculationVersion: integer("calculation_version").notNull(),
    rebuiltAt: text("rebuilt_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "holding_projections_portfolio_id_user_id_portfolios_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "holding_projections_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "holding_projections_calculation_run_owner_portfolio_fk",
      columns: [table.calculationRunId, table.userId, table.portfolioId],
      foreignColumns: [
        calculationRuns.id,
        calculationRuns.userId,
        calculationRuns.portfolioId,
      ],
    }).onDelete("restrict"),
    check(
      "holding_projections_completeness_check",
      sql`${table.completeness} IN ('complete', 'partial', 'incomplete')`,
    ),
    check(
      "holding_projections_status_check",
      sql`${table.status} IN ('ready', 'invalidated')`,
    ),
    uniqueIndex("holding_projections_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("holding_projections_portfolio_security_unique").on(
      table.portfolioId,
      table.portfolioSecurityId,
      table.calculationRunId,
    ),
    index("holding_projections_owner_portfolio_idx").on(
      table.userId,
      table.portfolioId,
      table.status,
    ),
  ],
);

/**
 * DB-005: security-keyed provider facts, shared across owners exactly like
 * `securities` -- not owner data, so excluded from account export/purge
 * (`ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS` in `account-lifecycle.ts`) and not
 * covered by any `account_purge_lock_*` trigger. Corrections never rewrite a
 * published row in place: a corrected/cancelled observation is inserted as a
 * new row with `supersedesEventId` pointing at the prior row, and the prior
 * row's `status` moves to `superseded` in the same write -- the same
 * supersession shape `manual_overrides` uses for owner data.
 */
export const dividendEvents = sqliteTable(
  "dividend_events",
  {
    id: text("id").primaryKey(),
    securityId: text("security_id").notNull(),
    providerId: text("provider_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    exDate: text("ex_date"),
    recordDate: text("record_date"),
    paymentDate: text("payment_date"),
    declarationDate: text("declaration_date"),
    currencyCode: text("currency_code").notNull(),
    grossPerShareDecimal: text("gross_per_share_decimal"),
    // Franking is not auto-sourced by any current provider (MKT-005): these
    // columns are a typed seam left present-but-unpopulated (NULL = unknown,
    // never a silent zero) until a franking source exists.
    frankingPercentDecimal: text("franking_percent_decimal"),
    frankingCreditPerShareDecimal: text("franking_credit_per_share_decimal"),
    observedAt: text("observed_at").notNull(),
    ingestedAt: text("ingested_at").notNull(),
    estimateMethod: text("estimate_method"),
    estimateAsOf: text("estimate_as_of"),
    supersedesEventId: text("supersedes_event_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "dividend_events_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_events_provider_id_market_data_providers_id_fk",
      columns: [table.providerId],
      foreignColumns: [marketDataProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_events_currency_code_currencies_code_fk",
      columns: [table.currencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_events_supersedes_event_id_fk",
      columns: [table.supersedesEventId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    check(
      "dividend_events_kind_check",
      sql`${table.kind} IN ('cash', 'special', 'capital_return')`,
    ),
    check(
      "dividend_events_status_check",
      sql`${table.status} IN ('estimated', 'declared', 'paid', 'cancelled', 'superseded')`,
    ),
    check(
      "dividend_events_amount_check",
      sql`${table.status} NOT IN ('declared', 'paid') OR ${table.grossPerShareDecimal} IS NOT NULL`,
    ),
    index("dividend_events_security_status_idx").on(
      table.securityId,
      table.status,
      table.exDate,
    ),
    // MKT-005 review fix: prevents two concurrent ingestion attempts (the
    // IMP-004B verify trigger and the periodic Cron sweep can race) from
    // both creating an active row for the same security/provider/ex-date.
    // Superseded rows are exempt so the supersession history itself is
    // never blocked by this constraint.
    uniqueIndex("dividend_events_active_natural_key_unique")
      .on(table.securityId, table.providerId, table.exDate)
      .where(sql`${table.status} <> 'superseded'`),
  ],
);

/** DB-005: shared provider facts, same non-owner-data treatment as above. */
export const splitEvents = sqliteTable(
  "split_events",
  {
    id: text("id").primaryKey(),
    securityId: text("security_id").notNull(),
    providerId: text("provider_id").notNull(),
    exDate: text("ex_date").notNull(),
    effectiveDate: text("effective_date").notNull(),
    numeratorDecimal: text("numerator_decimal").notNull(),
    denominatorDecimal: text("denominator_decimal").notNull(),
    status: text("status").notNull(),
    observedAt: text("observed_at").notNull(),
    ingestedAt: text("ingested_at").notNull(),
    supersedesEventId: text("supersedes_event_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "split_events_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "split_events_provider_id_market_data_providers_id_fk",
      columns: [table.providerId],
      foreignColumns: [marketDataProviders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "split_events_supersedes_event_id_fk",
      columns: [table.supersedesEventId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    check(
      "split_events_status_check",
      sql`${table.status} IN ('declared', 'effective', 'cancelled', 'superseded')`,
    ),
    index("split_events_security_status_idx").on(
      table.securityId,
      table.status,
      table.exDate,
    ),
    // MKT-005 review fix: same concurrent-ingestion protection as
    // `dividend_events_active_natural_key_unique` above, keyed on
    // `effective_date` since that is this table's natural key.
    uniqueIndex("split_events_active_natural_key_unique")
      .on(table.securityId, table.providerId, table.effectiveDate)
      .where(sql`${table.status} <> 'superseded'`),
  ],
);

/**
 * MKT-005 review fix: shared provider OPERATIONAL state (not owner data, not
 * a financial fact) tracking when each security's corporate-action history
 * was last attempted, so the periodic refresh sweep
 * (`runDueCorporateActionRefresh`) can rank securities oldest-attempt-first
 * and rotate through the full set instead of re-selecting the same security
 * forever (a non-paying/unchanged security never advances `ingested_at` on
 * its events tables, which is what the original ranking query used). One row
 * per security, upserted on every ingestion attempt -- success, failure, or
 * no-op -- by `ingestSecurityCorporateActionHistory`, regardless of which of
 * the three ingestion triggers invoked it. Classified `excluded` in
 * `ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS` (account-lifecycle.ts) exactly like
 * `securities` -- no purge-lock trigger, not user data.
 */
export const corporateActionRefreshState = sqliteTable(
  "corporate_action_refresh_state",
  {
    securityId: text("security_id").primaryKey(),
    lastAttemptedAt: text("last_attempted_at").notNull(),
    lastStatus: text("last_status"),
  },
  (table) => [
    foreignKey({
      name: "corporate_action_refresh_state_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    check(
      "corporate_action_refresh_state_status_check",
      sql`${table.lastStatus} IS NULL OR ${table.lastStatus} IN ('ok', 'failed')`,
    ),
  ],
);

/**
 * DB-005 original scope: owner-scoped actual receipts, per-share model.
 * `dividendEventId` is required -- this table is the future ledger-linked
 * capability the "later, posting an actual dividend receipt and its cash
 * entry" bullet in `docs/DATA_MODEL.md` §11 describes; `transactionId` stays
 * NULL until a later task wires actual cash posting. DIV-001's v1
 * read-derived income model (owner overrides + manual records, no ledger
 * posting) is served by `dividendEventOverrides`/`dividendManualRecords`
 * below instead. `status` is fixed to `'actual'` so an estimate can never be
 * persisted as a receipt.
 */
export const dividendReceipts = sqliteTable(
  "dividend_receipts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    dividendEventId: text("dividend_event_id").notNull(),
    transactionId: text("transaction_id"),
    sharesDecimal: text("shares_decimal").notNull(),
    dividendPerShareDecimal: text("dividend_per_share_decimal").notNull(),
    frankingPerShareDecimal: text("franking_per_share_decimal"),
    currencyCode: text("currency_code").notNull(),
    paymentDate: text("payment_date").notNull(),
    status: text("status").notNull().default("actual"),
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "dividend_receipts_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_receipts_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_receipts_dividend_event_id_fk",
      columns: [table.dividendEventId],
      foreignColumns: [dividendEvents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_receipts_transaction_id_user_id_portfolio_id_fk",
      columns: [table.transactionId, table.userId, table.portfolioId],
      foreignColumns: [
        transactions.id,
        transactions.userId,
        transactions.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_receipts_currency_code_currencies_code_fk",
      columns: [table.currencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check("dividend_receipts_status_check", sql`${table.status} = 'actual'`),
    check(
      "dividend_receipts_source_check",
      sql`${table.source} IN ('manual', 'csv_import', 'broker_sync')`,
    ),
    uniqueIndex("dividend_receipts_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    index("dividend_receipts_owner_portfolio_security_idx").on(
      table.userId,
      table.portfolioId,
      table.portfolioSecurityId,
    ),
  ],
);

/**
 * DB-005 extension (a): portfolio-scoped per-security dividend assumption
 * overrides. NULL means "fall back to provider-derived values" (DIV-003),
 * never an implicit zero. `frankingPercentDecimal` doubles as the holding's
 * "franking if not known" default consumed by DIV-001's per-dividend
 * franking resolution chain. Versioned like `user_settings` for optimistic
 * concurrency; never affects ledger facts.
 */
export const dividendSecurityAssumptions = sqliteTable(
  "dividend_security_assumptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    dividendYieldPercentDecimal: text("dividend_yield_percent_decimal"),
    frankingPercentDecimal: text("franking_percent_decimal"),
    dividendGrowthPercentDecimal: text("dividend_growth_percent_decimal"),
    /**
     * DIV-016 part B (owner-approved "override-as-bridge" ruling, recorded
     * in TASKS.md DIV-016): the yield/franking override above wins ONLY
     * while this security has LESS THAN 12 months of real dividend
     * evidence (`domain/dividends/forecast.ts`'s
     * `hasFullYearHistoryEvidence`) -- once a full trailing year of
     * evidence exists, history takes over automatically and this override
     * becomes DORMANT (kept, visible, excluded from the computation).
     * `forceAssumption = true` restores override-wins regardless of
     * evidence, a deliberate owner action. `NULL`/`0` (the default) means
     * "not forced" -- never implicitly true.
     */
    forceAssumption: integer("force_assumption", { mode: "boolean" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "dividend_security_assumptions_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_security_assumptions_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    uniqueIndex("dividend_security_assumptions_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("dividend_security_assumptions_portfolio_security_unique").on(
      table.portfolioSecurityId,
    ),
    index("dividend_security_assumptions_owner_portfolio_idx").on(
      table.userId,
      table.portfolioId,
    ),
  ],
);

/**
 * DB-005 extension (a): portfolio-level dividend/value growth assumptions,
 * one row per portfolio -- same single-row-per-owner-key shape as
 * `portfolio_settings`. Versioned; never affects ledger facts.
 */
export const dividendPortfolioAssumptions = sqliteTable(
  "dividend_portfolio_assumptions",
  {
    portfolioId: text("portfolio_id").primaryKey(),
    userId: text("user_id").notNull(),
    valueGrowthPercentDecimal: text("value_growth_percent_decimal"),
    portfolioDividendGrowthPercentDecimal: text(
      "portfolio_dividend_growth_percent_decimal",
    ),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "dividend_portfolio_assumptions_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    uniqueIndex("dividend_portfolio_assumptions_portfolio_user_unique").on(
      table.portfolioId,
      table.userId,
    ),
  ],
);

/**
 * DB-005 extension (b): portfolio-scoped financial-year actual-income
 * override, distinct from receipts. Financial years are keyed by their
 * ending year, matching FY-001A's "named by its ending year" convention
 * (Jul 2025-Jun 2026 = "FY26" = 2026). Amounts are in the portfolio's base
 * currency. Versioned.
 */
export const dividendFyOverrides = sqliteTable(
  "dividend_fy_overrides",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    financialYearEndingYear: integer("financial_year_ending_year").notNull(),
    grossedAmountDecimal: text("grossed_amount_decimal").notNull(),
    frankingAmountDecimal: text("franking_amount_decimal"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "dividend_fy_overrides_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    check(
      "dividend_fy_overrides_year_check",
      sql`${table.financialYearEndingYear} BETWEEN 1900 AND 2999`,
    ),
    uniqueIndex("dividend_fy_overrides_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("dividend_fy_overrides_portfolio_year_unique").on(
      table.portfolioId,
      table.financialYearEndingYear,
    ),
  ],
);

/**
 * DB-005 extension (c): sparse per-dividend override, keyed to a specific
 * provider event so overriding an old dividend never blocks new events from
 * flowing through (DIV-001). Every field is nullable -- a NULL column falls
 * back to the read-time auto-derivation; `exclude` removes the event from
 * derived history/totals entirely. At most one override row per
 * owner/portfolio/holding/event.
 */
export const dividendEventOverrides = sqliteTable(
  "dividend_event_overrides",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    dividendEventId: text("dividend_event_id").notNull(),
    sharesDecimal: text("shares_decimal"),
    dividendPerShareDecimal: text("dividend_per_share_decimal"),
    frankingCreditPerShareDecimal: text("franking_credit_per_share_decimal"),
    exclude: integer("exclude", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "dividend_event_overrides_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_event_overrides_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_event_overrides_dividend_event_id_fk",
      columns: [table.dividendEventId],
      foreignColumns: [dividendEvents.id],
    }).onDelete("restrict"),
    check(
      "dividend_event_overrides_exclude_check",
      sql`${table.exclude} IN (0, 1)`,
    ),
    uniqueIndex("dividend_event_overrides_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("dividend_event_overrides_target_unique").on(
      table.userId,
      table.portfolioId,
      table.portfolioSecurityId,
      table.dividendEventId,
    ),
  ],
);

/**
 * DB-005 extension (d): manual dividend record for a security/payment the
 * provider never surfaced as an event -- no `dividendEventId` link. Covered
 * by DIV-001's double-count guard (manual/override > imported >
 * auto-derived) at the domain layer, not here.
 *
 * IMP-006 addition: `importBatchId`/`sourceReference` are nullable,
 * FK-less text columns (mirroring `import_rows.commit_transaction_id` and
 * `transactions.source_reference`, neither of which carry a table-level FK
 * either) so this stays a CREATE-only-safe `ALTER TABLE ADD COLUMN`
 * migration rather than a SQLite table rebuild (FY-001A hazard). NULL means
 * "entered directly, not via CSV import" -- the vast majority of existing
 * and future manual-entry rows. `sourceReference` reuses the same
 * `import-fingerprint:<row fingerprint>` scheme as `transactions` for
 * cross-batch duplicate detection (see `db/repositories/import-commit.ts`);
 * `importBatchId` lets reversal find and remove exactly the rows a batch
 * created (see `db/repositories/import-reversal.ts`).
 *
 * UI-009 addition: `idempotencyKey` guards the standalone owner-facing
 * CREATE path (`app/dividend-assumptions-actions.ts`) against a
 * slow-but-successful save followed by a client retry after a timeout
 * (which otherwise reads as a genuine failure client-side and would
 * double-post the same dividend). It is a SEPARATE mechanism from
 * `sourceReference` above deliberately: `sourceReference` is IMP-006's own
 * CSV-import fingerprinting scheme, read/written by
 * `db/repositories/import-commit.ts` and `import-reversal.ts`'s
 * batch-scoped reversal accounting -- reusing it for an unrelated
 * client-generated dialog-session key would conflate two independent
 * dedupe concerns and risk import reversal counting an owner-typed row as
 * import-owned (or vice versa). `idempotencyKey` is nullable and, like
 * `sourceReference`, this stays a CREATE-only-safe `ALTER TABLE ADD COLUMN`
 * migration (FY-001A hazard) rather than a table rebuild. NULL means "no
 * client-supplied idempotency key" -- every pre-UI-009 row and any future
 * caller that doesn't supply one. The uniqueness below only needs
 * (portfolioSecurityId, idempotencyKey), not a full owner scope, because
 * `portfolioSecurityId` already uniquely identifies a single user+portfolio
 * (see the FK below) and SQLite's default UNIQUE semantics already treat
 * NULL as never equal to another NULL, so unkeyed rows never collide --
 * the same property `dividend_manual_records_portfolio_source_reference_unique`
 * above already relies on without a partial index.
 *
 * BRK-005 addition: Sharesight payouts report TOTAL cash/franking amounts
 * for a distribution, never a share count or a per-share amount -- fields
 * `docs/CSV_IMPORT_SPEC.md`'s per-share `Dividend` row shape has no
 * equivalent for. Fabricating a per-share figure by guessing/deriving a
 * share count would violate AGENTS.md's "never fabricated" rule, so
 * `sharesDecimal`/`dividendPerShareDecimal` become NULLABLE (a genuine
 * SQLite table rebuild, not an `ADD COLUMN` -- the trigger/index hazard
 * this rebuild carries is handled by hand-recreating the three
 * `account_purge_lock_dividend_manual_records_*` triggers and every index
 * byte-identically in the same migration; `tests/db-schema.test.ts` and
 * `tests/brk-005.test.ts` both re-probe purge-lock enforcement after this
 * migration) and two new nullable columns, `totalCashDecimal`/
 * `totalFrankingDecimal`, carry the totals-only shape instead. A row is
 * either PER-SHARE (`sharesDecimal`+`dividendPerShareDecimal` set,
 * `totalCashDecimal`+`totalFrankingDecimal` both NULL -- every pre-BRK-005
 * row, and every future owner-typed/CSV-imported per-share row) or TOTALS
 * (`sharesDecimal`+`dividendPerShareDecimal`+`frankingCreditPerShareDecimal`
 * all NULL, `totalCashDecimal` set -- a Sharesight payout row only); never
 * both, never neither. `dividend_manual_records_amount_mode_check` enforces
 * this invariant at the database layer as well as in
 * `db/repositories/dividends.ts`'s `buildDividendManualRecordImportInsertStatements`.
 * `domain/dividends/history.ts`'s derivation reads a NULL
 * `dividendPerShareDecimal` fact as "shares/per-share genuinely unknown"
 * (rendered as such, matching the pre-existing convention the row-level
 * `DerivedDividendRow.dividendPerShareDecimal`/`amountUnknown` fields
 * already used for a provider event with no known amount) while still
 * using the real `totalCashDecimal`/`totalFrankingDecimal` for the row's
 * cash/franking totals -- see that module's `computeCashGrossOrTotals`.
 *
 * BRK-010 addition (migration 0042 -- a GENUINE TABLE REBUILD, not a plain
 * `ADD COLUMN`: this migration also adds two new CHECK constraints, which
 * SQLite cannot add via `ALTER TABLE`. Same trigger hazard as 0035's own
 * rebuild before it -- the three `account_purge_lock_dividend_manual_records_*`
 * triggers are hand-recreated byte-identically after the rename in the
 * migration file itself; `tests/db-schema.test.ts` checks the three
 * trigger NAMES survive the rebuild, it does NOT re-probe actual
 * enforcement -- see `tests/db-005.test.ts`'s purge-lock drills for the
 * enforcement coverage this schema relies on): a security can legitimately
 * trade in one currency and pay a dividend in another (an ASX-listed
 * security trading in AUD that pays a USD dividend -- the owner-reported
 * RMD case, `sharesight_instrument` 2964). Three new NULLABLE columns carry
 * that honestly: `currencyCode` (FK `currencies`), `fxRateToPortfolioDecimal`,
 * and `fxRateSource`.
 *
 * NULL `currencyCode` means "this row's amounts are already in the
 * SECURITY's own currency" -- every pre-BRK-010 row (NULL by construction)
 * and every row whose payout currency already equals its security's own
 * `securities.primary_currency_code` reads this way; `domain/dividends/history.ts`
 * treats this as "no conversion needed," matching this module's
 * established per-security-native-currency scope. A NON-NULL `currencyCode`
 * is set when the row's cash total is denominated in a currency other than
 * its OWN SECURITY's currency (`db/repositories/import-commit.ts`'s
 * dividend branch, using the REAL `securities.primary_currency_code`, not
 * the portfolio's base currency -- a security can differ from its
 * portfolio's base too).
 *
 * BRK-010 REVIEW FINDING B4 CORRECTION: `fxRateToPortfolioDecimal`/
 * `fxRateSource` are NOT always set together with `currencyCode` --
 * `dividend_manual_records_fx_provenance_check` enforces a NARROWER
 * invariant than the column's first-shipped version did: `fxRateToPortfolioDecimal`
 * and `fxRateSource` are still paired (all-or-neither, and never present
 * without `currencyCode` also being set), but `currencyCode` MAY stand
 * alone with both rate columns NULL. This is a genuine, expected state:
 * Sharesight's own rate always converts record-currency -> PORTFOLIO BASE,
 * never into an arbitrary security's own currency, so when a payout's
 * security differs from BOTH the payout's own currency AND the portfolio's
 * base currency, no rate this codebase could ever be given would let it
 * honestly convert into that security's currency -- the row still needs
 * `currencyCode` recorded (so it is never silently mislabelled as being in
 * its security's currency) but a MISSING rate in that shape is never a
 * commit-time failure, only a read-time `mixed_currency` degradation (see
 * `domain/dividends/history.ts`'s derivation, B4). `fxRateSource` is
 * currently only ever `'sharesight'` (Sharesight's own payout
 * `exchange_rate`, live-confirmed BRK-008 §8.2, direction CONFIRMED and
 * corrected by a live spike -- review finding B1, see
 * `domain/sharesight/contracts.ts`'s `SharesightPayout.exchangeRateDecimal`
 * doc comment for the evidence) -- the CHECK constraint keeps the value set
 * closed rather than accepting arbitrary free text, matching this schema's
 * established enum-via-CHECK convention (e.g. `dividend_receipts_source_check`).
 * Fail-closed ONLY when a rate is genuinely achievable and missing: a
 * foreign-to-security payout whose security currency equals the portfolio's
 * base currency, with no rate, never reaches this table -- it stages with a
 * blocking, excludable `SHARESIGHT_PAYOUT_FX_RATE_MISSING` issue instead
 * (see `domain/sharesight-sync/transform.ts`); a payout whose security
 * currency differs from BOTH is never blocked (see the case-C reasoning
 * above).
 *
 * DIV-016 part A addition: `supersededByRecordId` is this table's
 * ledger-immutability correction mechanism, mirroring `transactions`'
 * `supersedesTransactionId`/`status='superseded'` convention (AGENTS.md:
 * "Ledger facts are immutable; corrections use reversal/supersession...
 * never silent history rewrites") but adapted to a SINGLE nullable
 * self-referencing pointer rather than a separate `status` enum column --
 * this table has no `status` field to reuse and adding one with a CHECK
 * constraint would force a genuine table rebuild (the FY-001A hazard this
 * table's own header note already documents repeatedly). Set ONLY on the
 * OLD (superseded) row, pointing FORWARD to the NEW row that replaced it --
 * `db/repositories/dividends.ts`'s `supersede()` sets it via a single
 * guarded `UPDATE ... WHERE version = ? AND superseded_by_record_id IS
 * NULL` (the optimistic-concurrency CAS) in the SAME atomic batch as the
 * new row's conditional `INSERT ... SELECT ... WHERE EXISTS (...)`, so
 * either both the mark and the new row are written or neither is -- no
 * window where an original reads "superseded" with no successor. NULL means
 * "this is the current head of its own lineage" (every pre-DIV-016 row, and
 * the most recent row in every lineage going forward) -- `list()` filters
 * `WHERE superseded_by_record_id IS NULL` so every evidence/aggregation
 * consumer (forecast TTM, UI-046 rows, the per-security Dividends tab) sees
 * exactly the winning row of each lineage, never a superseded ancestor,
 * without each consumer re-implementing the exclusion itself. The full
 * lineage stays reconstructable by walking this single column: forward from
 * any row via its own `supersededByRecordId` to find the current head,
 * backward from any row via `WHERE superseded_by_record_id = <that row's
 * id>` to find what it replaced. Deliberately no FK constraint (plain `ADD
 * COLUMN`, no rebuild, matching `importBatchId`/`sourceReference`/
 * `idempotencyKey` above, none of which carry one either) -- validated in
 * application code instead. An imported row (`importBatchId IS NOT NULL`)
 * can never be superseded through this mechanism -- `supersede()` rejects
 * it exactly like `update()`/`remove()` already did, preserving IMP-006's
 * reversal-only correction path for that tier.
 *
 * DIV-016 part C (imported-successor case): the SUCCESSOR side of this
 * pointer is NOT restricted to a manual correction -- Sharesight
 * reconciliation (`db/repositories/import-commit.ts`'s commit loop) sets an
 * existing MANUAL row's `superseded_by_record_id` to point at a NEWLY
 * IMPORTED row for the same distribution, so the manual fact and the later
 * Sharesight fact are never both counted (owner ruling: "if I later synced
 * with sharesight it should not double count"; "sharesight should take
 * precedence from there forward"). Only the ORIGINAL row being pointed FROM
 * must be manual (`importBatchId IS NULL`, matching `supersede()`'s own
 * guard) -- the row pointed TO may be either kind, so this column always
 * means exactly "what replaced me," never "what kind replaced me." Reversing
 * the import batch that created that successor row RESTORES the manual
 * ancestor (`db/repositories/import-reversal.ts`'s `finalize()` nulls
 * `superseded_by_record_id` back out for every manual row pointing at one of
 * the batch's own rows, in the SAME atomic statement set as the DELETE that
 * removes them) -- the manual row becomes the head of its lineage again,
 * never silently lost.
 *
 * DELETE semantics and the tombstone case (review follow-up): `remove()`
 * refuses to delete a row that is ITSELF an ancestor
 * (`superseded_by_record_id IS NOT NULL`) -- deleting one would destroy the
 * only record of what it was eventually corrected TO, breaking the
 * backward audit walk. `remove()` does NOT refuse to delete a CURRENT HEAD
 * that has its own ancestor pointing at it (a correction, then "Exclude
 * this dividend" on the corrected row -- an ordinary, intentional flow).
 * That case leaves the ancestor's `superseded_by_record_id` naming a row
 * that no longer exists -- a TOMBSTONE reference, not a bug: the ancestor
 * was already, correctly, excluded from every evidence path (its column is
 * non-NULL regardless of whether the named row still exists), and deleting
 * a row is supposed to make its content genuinely gone. The only
 * consequence is that a forward lineage walk starting from the ancestor
 * terminates at a dangling id instead of a live row -- callers doing that
 * walk must resolve each hop with `get()` and stop honestly (never throw,
 * never fabricate) the moment a hop returns null. This is never resurrected
 * as "this ancestor is head again" -- the ancestor's own
 * `superseded_by_record_id` is never nulled back out, so it stays excluded
 * from `list()` forever, exactly as if the correction had never been
 * un-done (which it hasn't -- the correction itself was simply deleted
 * afterward, a separate, later, deliberate act).
 */
export const dividendManualRecords = sqliteTable(
  "dividend_manual_records",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    paymentDate: text("payment_date").notNull(),
    sharesDecimal: text("shares_decimal"),
    dividendPerShareDecimal: text("dividend_per_share_decimal"),
    frankingCreditPerShareDecimal: text("franking_credit_per_share_decimal"),
    importBatchId: text("import_batch_id"),
    sourceReference: text("source_reference"),
    idempotencyKey: text("idempotency_key"),
    // BRK-005: totals-only Sharesight payout shape -- see the header note.
    totalCashDecimal: text("total_cash_decimal"),
    totalFrankingDecimal: text("total_franking_decimal"),
    // BRK-010: foreign-currency payout provenance -- see the header note.
    currencyCode: text("currency_code"),
    fxRateToPortfolioDecimal: text("fx_rate_to_portfolio_decimal"),
    fxRateSource: text("fx_rate_source"),
    // DIV-016 part A: supersession lineage pointer -- see the header note.
    supersededByRecordId: text("superseded_by_record_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "dividend_manual_records_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_manual_records_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_manual_records_currency_code_currencies_code_fk",
      columns: [table.currencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    uniqueIndex("dividend_manual_records_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    index("dividend_manual_records_owner_portfolio_security_idx").on(
      table.userId,
      table.portfolioId,
      table.portfolioSecurityId,
      table.paymentDate,
    ),
    index("dividend_manual_records_import_batch_idx").on(
      table.userId,
      table.importBatchId,
    ),
    uniqueIndex("dividend_manual_records_portfolio_source_reference_unique").on(
      table.portfolioId,
      table.sourceReference,
    ),
    uniqueIndex("dividend_manual_records_security_idempotency_unique").on(
      table.portfolioSecurityId,
      table.idempotencyKey,
    ),
    // DIV-016 part A: supports both directions of lineage traversal --
    // `list()`'s `WHERE superseded_by_record_id IS NULL` exclusion filter,
    // and `supersede()`'s reverse "what did this row replace" lookup.
    index("dividend_manual_records_superseded_by_idx").on(
      table.supersededByRecordId,
    ),
    check(
      "dividend_manual_records_amount_mode_check",
      sql`
        (
          ${table.sharesDecimal} IS NOT NULL
          AND ${table.dividendPerShareDecimal} IS NOT NULL
          AND ${table.totalCashDecimal} IS NULL
          AND ${table.totalFrankingDecimal} IS NULL
        )
        OR
        (
          ${table.sharesDecimal} IS NULL
          AND ${table.dividendPerShareDecimal} IS NULL
          AND ${table.frankingCreditPerShareDecimal} IS NULL
          AND ${table.totalCashDecimal} IS NOT NULL
        )
      `,
    ),
    // BRK-010 review finding B4: `fxRateToPortfolioDecimal`/`fxRateSource`
    // are paired (all-or-neither) and never appear without `currencyCode`
    // also being set (a rate/source with no currency to name what it
    // converts FROM would be meaningless) -- but `currencyCode` MAY stand
    // alone with both rate columns NULL: a payout foreign to its OWN
    // SECURITY whose security also differs from the portfolio's base
    // currency has no achievable Sharesight rate at all (see the table's
    // header note's case-C reasoning), yet the row's true currency must
    // still be recorded, never silently defaulted to its security's own
    // currency. See the table's header note for the full three-case model.
    check(
      "dividend_manual_records_fx_provenance_check",
      sql`
        (${table.fxRateToPortfolioDecimal} IS NULL) = (${table.fxRateSource} IS NULL)
        AND (
          ${table.fxRateToPortfolioDecimal} IS NULL
          OR ${table.currencyCode} IS NOT NULL
        )
      `,
    ),
    check(
      "dividend_manual_records_fx_rate_source_check",
      sql`${table.fxRateSource} IS NULL OR ${table.fxRateSource} IN ('sharesight')`,
    ),
  ],
);

/**
 * BRK-011: sparse, one-row-per-imported-record owner override for a
 * FOREIGN-CURRENCY Sharesight payout's franking credit total, mirroring
 * `dividend_event_overrides`' sparse-override shape (DB-005 extension c)
 * but keyed to a `dividend_manual_records` row instead of a
 * `dividend_events` row -- an imported totals-mode payout has no event id
 * of its own to key against for a franking-only figure the OWNER, not
 * Sharesight, supplies (see this table's own header note's tier-1/tier-2
 * evidence: tier 1 -- a Sharesight-supplied AUD-converted franking figure
 * -- is UNCONFIRMED, not disproven: the owner's data has no franked FOREIGN
 * payout to test, and a live 2026-08-21 check (`scripts/sharesight-franking-fx-spike.mjs`,
 * routed through the sealed client) found the documented `tax_credit` field
 * absent from all 10 (unfranked) foreign payouts AND all 61 franked native
 * (AUD) payouts -- evidence the field never populates on this account's
 * wire, but the untested foreign+franked combination stops short of proof.
 * Tier 2 (automatic FX conversion) is separately INCONCLUSIVE for the same
 * no-franked-foreign-payout reason. See `docs/ARCHITECTURE.md` §8.2.
 *
 * Ledger-immutability (AGENTS.md): `dividend_manual_records` itself is
 * NEVER mutated by this table -- `db/repositories/dividends.ts`'s
 * `dividendManualRecords.update()` already structurally rejects any
 * imported row (`import_batch_id IS NOT NULL`). This table is a pure
 * OVERLAY: `domain/dividends/history.ts`'s read-time derivation applies its
 * `frankingTotalDecimal` on top of (never in place of) the immutable
 * imported fact, with `frankingCurrencySource: "owner_manual"` provenance
 * so the row is never confused with a Sharesight-reported figure. The
 * underlying Sharesight-sourced (possibly absent, possibly guard-nulled)
 * franking total is preserved exactly as received, unaffected by this
 * table's existence.
 *
 * At most one override row per (owner, portfolio, imported record) --
 * `dividend_import_franking_overrides_target_unique` below. `frankingTotalDecimal`
 * is REQUIRED (unlike `dividend_event_overrides`' sparse nullable columns):
 * this table's only purpose is recording a known conversion, so a row with
 * nothing to say has no reason to exist -- clearing an override means
 * deleting the row, not writing a null one.
 */
export const dividendImportFrankingOverrides = sqliteTable(
  "dividend_import_franking_overrides",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    portfolioSecurityId: text("portfolio_security_id").notNull(),
    dividendManualRecordId: text("dividend_manual_record_id").notNull(),
    frankingTotalDecimal: text("franking_total_decimal").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "dividend_import_franking_overrides_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    foreignKey({
      name: "dividend_import_franking_overrides_security_id_user_id_portfolio_id_fk",
      columns: [table.portfolioSecurityId, table.userId, table.portfolioId],
      foreignColumns: [
        portfolioSecurities.id,
        portfolioSecurities.userId,
        portfolioSecurities.portfolioId,
      ],
    }).onDelete("restrict"),
    // `dividend_manual_records_id_user_portfolio_unique` (that table's own
    // composite unique index) is what this FK targets -- an override can
    // only ever reference a manual record the SAME owner/portfolio already
    // owns, never another owner's row.
    foreignKey({
      name: "dividend_import_franking_overrides_record_id_user_id_portfolio_id_fk",
      columns: [table.dividendManualRecordId, table.userId, table.portfolioId],
      foreignColumns: [
        dividendManualRecords.id,
        dividendManualRecords.userId,
        dividendManualRecords.portfolioId,
      ],
    }).onDelete("restrict"),
    uniqueIndex(
      "dividend_import_franking_overrides_id_user_portfolio_unique",
    ).on(table.id, table.userId, table.portfolioId),
    uniqueIndex("dividend_import_franking_overrides_target_unique").on(
      table.userId,
      table.portfolioId,
      table.dividendManualRecordId,
    ),
    index("dividend_import_franking_overrides_owner_portfolio_security_idx").on(
      table.userId,
      table.portfolioId,
      table.portfolioSecurityId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// BRK-004: Sharesight sync-cursor schema.
//
// The BRK-003/BRK-008 Sharesight client uses OAuth `client_credentials` only
// in the real Worker wiring (no `authorization_code`/`refresh_token`
// custody -- BRK-008's other two grants remain spike-only) -- there is
// therefore no token table: client id/secret live as Worker secrets (see
// `worker/sharesight-config.ts`) and the negotiated access token is held
// in-memory for the lifetime of a single `SharesightTokenProvider`, never
// persisted. The only durable state this task adds is a per-connection SYNC
// CURSOR, one row per (user, portfolio, sharesight_portfolio_id) --
// `BRK-005` (blocked on this task) reads/extends `last_synced_at`/
// `last_trade_watermark` to drive its resumable ingest; this task only
// reserves the shape and keeps it minimal. `sharesight_portfolio_id` is
// Sharesight's OWN portfolio identifier (an opaque broker-side id, not a
// foreign key into any local table -- mirrors `external_record_mappings`'
// deferred design in docs/DATA_MODEL.md §8), stored as a decimal string per
// this repo's numeric-id normalization convention
// (`domain/sharesight/parse.ts`'s `requiredIntegerIdDecimalString`).
// `enabled` is the field a user action mutates directly
// (connect/disconnect); `last_synced_at`/`last_trade_watermark` are
// sync-process bookkeeping BRK-005 writes. The whole row is still
// version-guarded uniformly, matching every other owner-scoped
// single-row-per-key table in this schema (e.g.
// `dividend_portfolio_assumptions`) rather than special-casing which field
// changed.
// ---------------------------------------------------------------------------
export const sharesightSyncState = sqliteTable(
  "sharesight_sync_state",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    sharesightPortfolioId: text("sharesight_portfolio_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastSyncedAt: text("last_synced_at"),
    lastTradeWatermark: text("last_trade_watermark"),
    // BRK-012B: the price-refresh watermark, ADD COLUMN (column-only, no
    // rebuild -- see this comment's trigger-hazard note below). Reuses this
    // existing per-(user, portfolio, sharesightPortfolioId) sync-state row
    // rather than a new table (AGENTS.md scope discipline -- "reuse/extend
    // an existing state table if one fits"): the hourly refresh calls
    // `listUserInstruments` ONCE per Sharesight account and then updates
    // the watermark on every ENABLED row belonging to that owner, so each
    // linked portfolio's sync state honestly reflects the last attempt
    // regardless of how many local portfolios share one Sharesight account.
    // `lastPriceRefreshStatus` is nullable (no attempt yet) and NEVER
    // partial-silent -- a failed fetch/parse still writes `'failed'` plus
    // `lastPriceRefreshErrorKind`, mirroring `corporate_action_refresh_state`'s
    // `last_status` convention. Deliberately NO new DB CHECK constraint here
    // (`db/repositories/sharesight-price-refresh.ts` validates the status
    // value in application code instead): a table-level CHECK cannot be
    // added via SQLite's `ALTER TABLE ADD COLUMN` at all -- drizzle-kit's
    // only way to add one is a genuine table REBUILD (verified by running
    // `drizzle-kit generate` against an earlier draft of this change: it
    // emitted a `__new_sharesight_sync_state`/DROP/RENAME sequence), which
    // would DROP this table's three `account_purge_lock_*` triggers and
    // require hand-recreating them (the exact hazard 0035/0042's disclosure
    // comments document for `dividend_manual_records`). Three plain ADD
    // COLUMN statements avoid that rebuild entirely and leave the existing
    // triggers untouched.
    lastPriceRefreshAt: text("last_price_refresh_at"),
    lastPriceRefreshStatus: text("last_price_refresh_status"),
    lastPriceRefreshErrorKind: text("last_price_refresh_error_kind"),
    // BRK-012C: single-flight lease for the 10-minute delayed-price read
    // gate (`app/sharesight-price-gate-service.ts`). Reuses this existing
    // per-(user, portfolio, sharesightPortfolioId) row rather than a new
    // lease table -- the same "adapt an existing owner-scoped row" pattern
    // BRK-012B's `lastPriceRefreshAt` trio already established on this same
    // table. The gate claims the lease on the owner's FIRST enabled row
    // (deterministic `ORDER BY id ASC LIMIT 1`, mirroring
    // `recordSharesightPriceRefreshWatermark`'s "one attempt, broadcast to
    // every enabled row" model) via the SAME conditional-UPDATE CAS pattern
    // `calculation_runs.claim()` uses (`db/repositories/calculation-runs.ts`)
    // -- `changes = 1` means this invocation won the race; any concurrent
    // loader that loses the race serves the (possibly still-stale-by-a-hair)
    // cache rather than double-fetching. Plain ADD COLUMN, no rebuild, no
    // trigger-hazard (same disclosure as the trio above).
    priceRefreshLeaseOwner: text("price_refresh_lease_owner"),
    priceRefreshLeaseExpiresAt: text("price_refresh_lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "sharesight_sync_state_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    check(
      "sharesight_sync_state_enabled_check",
      sql`${table.enabled} IN (0, 1)`,
    ),
    uniqueIndex("sharesight_sync_state_id_user_portfolio_unique").on(
      table.id,
      table.userId,
      table.portfolioId,
    ),
    uniqueIndex("sharesight_sync_state_target_unique").on(
      table.userId,
      table.portfolioId,
      table.sharesightPortfolioId,
    ),
    index("sharesight_sync_state_owner_portfolio_idx").on(
      table.userId,
      table.portfolioId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// BRK-012C: the delayed-price CACHE + 10-minute read-gate store, one row per
// (user, security) -- the latest Sharesight `current_price` this owner's
// account has observed, plus WHEN it was fetched (`fetched_at`, ingestion
// time). This is deliberately NOT `price_observations`: that table already
// receives the SAME data via BRK-012B's accretion path (one row per
// security per TRADING DAY, converging toward the close); this table is a
// single-row-per-security freshness/audit store the read gate
// (`app/sharesight-price-gate-service.ts`) can check with ONE cheap query
// ("is any held security's row missing or `fetched_at` > 10 minutes old?")
// without scanning `price_observations`' potentially-multi-row-per-day
// history. Freshness is unambiguous from the row alone, per the ruling:
// `fetched_at` is this cache row's own ingestion time, independent of
// `quote_at` (Sharesight's own `current_price_updated_at`, which can stay
// unchanged across several fetches when the market hasn't moved -- that is
// not staleness, it is an honest unchanged quote).
//
// Display: holdings/overview do NOT read this table directly for current
// value -- see `app/owned-holdings.ts`'s BRK-012C comment on the lifted
// `provider_id <> 'sharesight'` predicate. The read gate's refresh call
// piggybacks the SAME accretion write BRK-012B's hourly cron already makes
// (`domain/sharesight/price-accretion.ts` +
// `db/repositories/sharesight-price-refresh.ts`'s
// `upsertSharesightPriceObservations`), so `price_observations` -- which
// DOES feed the existing selection machinery
// (`domain/market-data/selection.ts`) -- is refreshed as a side effect of
// this table's own gate-triggered fetch. This table's SOLE job is the
// freshness gate and an honest "latest quote" record a future surface could
// read directly; it is not itself a valuation input. See
// `docs/MARKET_DATA_STRATEGY.md` and `docs/ARCHITECTURE.md` §8.2 for the
// full design note.
export const sharesightDelayedPrices = sqliteTable(
  "sharesight_delayed_prices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    securityId: text("security_id").notNull(),
    priceDecimal: text("price_decimal").notNull(),
    currencyCode: text("currency_code").notNull(),
    // Sharesight's own `current_price_updated_at`, normalized to UTC `...Z`
    // -- same discipline as `price-accretion.ts`'s `normalizeTimestampToUtcIso`
    // (BRK-012B). Nullable: "when supplied" per the ruling -- Sharesight's
    // wire shape has never been observed to omit it (BRK-012A/B evidence),
    // but this cache never fabricates a quote timestamp it wasn't given.
    quoteAt: text("quote_at"),
    // MKT-015 (migration 0052, review round 2026-08-22, BLOCKING fix):
    // the SAME `market_date`/`market_timezone` a `SharesightPriceAccretionCandidate`
    // carries, captured VERBATIM at cache-write time -- i.e. derived from
    // Sharesight's ORIGINAL offset-preserving timestamp
    // (`deriveMarketDateFromTimestamp`/`extractOffsetSuffix`), never
    // re-derived later from `quoteAt` above (which is already UTC-converted
    // -- re-slicing IT for a date is exactly the bug
    // `deriveMarketDateFromTimestamp`'s own doc comment forbids: an
    // AEDT/+11:00 morning quote can UTC-convert onto the PREVIOUS calendar
    // date). `domain/sharesight/price-accretion.ts`'s
    // `buildSharesightPriceGateBackfillCandidates` reads these two columns
    // verbatim to recover a still-cached prior trading day -- see that
    // function's doc comment. ADD COLUMN, nullable, no backfill of
    // historical rows: a cache row written before this migration has both
    // NULL, and the backfill mechanism SKIPS a NULL-market-date row
    // honestly (never guesses) -- the very next ordinary refresh
    // repopulates both columns together, so the gap self-heals within one
    // refresh cycle.
    marketDate: text("market_date"),
    marketTimezone: text("market_timezone"),
    // Ingestion time -- THIS is the column the 10-minute gate compares
    // against, never `quoteAt` (see this table's header comment).
    fetchedAt: text("fetched_at").notNull(),
    // Source metadata. Fixed to 'sharesight' today (the only delayed-price
    // source this codebase has); kept as a real column rather than an
    // assumed constant so a future second delayed-price source does not
    // require a schema rebuild.
    providerId: text("provider_id").notNull().default("sharesight"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "sharesight_delayed_prices_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sharesight_delayed_prices_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sharesight_delayed_prices_currency_code_currencies_code_fk",
      columns: [table.currencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "sharesight_delayed_prices_provider_check",
      sql`${table.providerId} = 'sharesight'`,
    ),
    uniqueIndex("sharesight_delayed_prices_user_security_unique").on(
      table.userId,
      table.securityId,
    ),
    index("sharesight_delayed_prices_user_idx").on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// MKT-011A: the daily-price-capture INTRADAY cache -- owner-scoped, one row
// per (user, security, provider, observed_at) captured tick, gathered by the
// `25,55 * * * *` sweep (`app/daily-price-capture-service.ts`) across each
// security's own market-timezone 10:25-16:25 local-wall-clock window. THIS
// is where the multi-point-per-day series `MKT-011B`'s "today" graph reads
// from -- deliberately NOT `price_observations` (Orchestrator ruling): that
// table's job is ONE durable, honestly-labelled closing observation per
// (security, market_date, provider), never a same-day intraday tick series.
// Every row here is provisional/ephemeral by design -- the end-of-day rollup
// (the SAME service, `rollupAndPurgeDailyCapture`) promotes exactly the
// day's LAST captured point per security into `price_observations` (never
// labelled an official close -- honest "last delayed observation of the
// day"), then PURGES every row for that (user, security, provider,
// market_date) -- retention is "today only", per the owner's ruling. A
// crashed/missed 16:25 tick is not lost: the SAME rollup function runs on
// every sweep tick regardless of the current window state, so the first
// sweep of a LATER day still finds and promotes the previous day's
// abandoned points before purging them (see that function's own comment).
//
// No FK to `security_provider_mappings`/`mapping_id` here (unlike
// `price_observations`): resolving the mapping only matters at ROLLUP time,
// and by construction a row can only exist here if a usable mapping already
// existed at CAPTURE time (Yahoo: the capture query itself requires an
// existing verified `security_provider_mappings` row to build the request;
// Sharesight: the capture step performs the SAME guarded
// `security_provider_mappings` insert BRK-012B's accretion write does,
// before writing this row -- see `db/repositories/intraday-price-capture.ts`).
export const intradayPricePoints = sqliteTable(
  "intraday_price_points",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    securityId: text("security_id").notNull(),
    providerId: text("provider_id").notNull(),
    priceDecimal: text("price_decimal").notNull(),
    currencyCode: text("currency_code").notNull(),
    // The trading day this observation belongs to, per the SOURCE's own
    // reported date (never re-derived from a UTC conversion -- same
    // discipline as `domain/sharesight/price-accretion.ts`'s
    // `deriveMarketDateFromTimestamp`). The capture step only ever inserts a
    // row when this equals TODAY in the security's own market timezone
    // (honest "today" data only -- a stale prior-close observation returned
    // outside a trading day is never captured as an intraday point).
    marketDate: text("market_date").notNull(),
    // Whatever timezone identifier the SOURCE itself reported for this
    // observation (Yahoo: an IANA zone name; Sharesight: a UTC offset
    // suffix, mirroring `price_observations.market_timezone`'s existing
    // per-provider convention) -- provenance only. The capture/rollup
    // WINDOW-GATING decision itself uses this app's OWN stored
    // `exchanges.timezone` for the security (joined via
    // `securities.exchange_id`), never this column -- see
    // `domain/market-data/daily-capture-window.ts`.
    marketTimezone: text("market_timezone").notNull(),
    // The source's own observation instant, UTC `...Z` ISO. Paired with
    // (user_id, security_id, provider_id) in this table's unique index below
    // so a re-captured, UNCHANGED tick (the source had nothing new to say)
    // is a harmless no-op insert, never a duplicate row.
    observedAt: text("observed_at").notNull(),
    // Ingestion time -- when THIS sweep tick wrote this row. Distinct from
    // `observedAt` exactly like every other provenance pair in this schema
    // (e.g. `sharesightDelayedPrices.fetchedAt` vs `.quoteAt`).
    capturedAt: text("captured_at").notNull(),
    // Mirrors `price_observations.delayed_minutes`/`.quality` -- carried
    // through from the source adapter's own observation (Yahoo:
    // `exchangeDataDelayedBy`; Sharesight never supplies a delay figure, so
    // this is NULL for sharesight-sourced rows, never fabricated).
    delayedMinutes: integer("delayed_minutes"),
    quality: text("quality").notNull().default("observed"),
    // Carried through verbatim from the capturing observation's OWN
    // `PriceObservation.providerRevisionId` -- for `yahoo-compatible` this is
    // MKT-009B's `session:authenticated`/`session:anonymous`/`null` tag
    // (`domain/market-data/yahoo-compatible.ts`), which
    // `app/owned-holdings.ts`'s `yahooAuthPreferenceUnmet`/
    // `yahooAuthActionStatus` logic reads to decide whether to show the
    // owner an "Action required: re-export cookies" banner. A rollup write
    // that dropped this tag would make a perfectly-authenticated capture
    // read back as "not configured" -- so the end-of-day rollup
    // (`db/repositories/intraday-price-capture.ts`) copies this column's
    // value verbatim into `price_observations.provider_revision_id`, never
    // re-deriving or discarding it. Always NULL for `sharesight` captures
    // (that provider never sets this field -- BRK-012B precedent).
    providerRevisionId: text("provider_revision_id"),
  },
  (table) => [
    foreignKey({
      name: "intraday_price_points_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "intraday_price_points_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "intraday_price_points_currency_code_currencies_code_fk",
      columns: [table.currencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    foreignKey({
      name: "intraday_price_points_provider_id_market_data_providers_id_fk",
      columns: [table.providerId],
      foreignColumns: [marketDataProviders.id],
    }).onDelete("restrict"),
    check(
      "intraday_price_points_provider_check",
      sql`${table.providerId} IN ('sharesight', 'yahoo-compatible')`,
    ),
    check(
      "intraday_price_points_quality_check",
      sql`${table.quality} IN ('observed', 'corrected', 'indicative', 'stale_candidate')`,
    ),
    check(
      "intraday_price_points_delayed_minutes_check",
      sql`${table.delayedMinutes} IS NULL OR ${table.delayedMinutes} >= 0`,
    ),
    uniqueIndex(
      "intraday_price_points_user_security_provider_observed_unique",
    ).on(table.userId, table.securityId, table.providerId, table.observedAt),
    // Rollup/purge query shape: "every (security, market_date) this owner
    // has cached for this provider" -- see
    // `db/repositories/intraday-price-capture.ts`'s
    // `resolveDailyCaptureRollupCandidates`.
    index("intraday_price_points_user_provider_date_idx").on(
      table.userId,
      table.providerId,
      table.marketDate,
      table.securityId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// MKT-008: owner-uploaded price-history batches -- the "Historical Data"
// section's own attribution record, one row per upload (a single-security
// Intelligent-Investor-style CSV, or a full backup re-import). Mirrors
// `import_batches`' role for the ledger CSV flow, but deliberately much
// smaller: this feature never STAGES rows for review (parsing is
// deterministic and a preview is computed on demand from the same bytes the
// owner is about to confirm -- see `app/price-upload-actions.ts`'s header
// comment for why no `price_upload_rows` staging table exists), so this
// table only needs to record WHO uploaded WHAT and the resulting counts, for
// the delete/undo affordance and the past-uploads list.
//
// `source_label` is free text (e.g. "intelligent-investor", or a backup
// re-import's own label) -- the SOURCE DETAIL lives here, not as a second
// `market_data_providers` row, per this task's ruling: every row this
// feature writes carries `provider_id = 'owner-import'` (single-CSV
// imports) or whatever provider a backup row originally carried (backup
// re-imports preserve it, never relabel), so a future second owner-upload
// source (a different broker's CSV shape, say) fits by choosing a new
// `source_label` value, never a new provider row or a schema change.
//
// Review B1 fix (BLOCKING, 2026-08-21): `upload_batch_id` on
// `price_observations` is now stamped on INSERT ONLY -- an overlay (a
// natural-key conflict) updates price/quote fields but NEVER reassigns
// attribution, so an upload never takes ownership of a row it merely
// overwrote (the reviewer's drill: overlay-then-delete was destroying data
// the deleted upload never created, including an un-refetchable Sharesight
// row). `row_count`/`inserted_row_count` can therefore now legitimately
// differ: `row_count` is every valid row this upload's file/backup
// contained (matched + written, whether inserted or merely overlaid an
// existing row), `inserted_row_count` is the subset THIS upload actually
// CREATED -- exactly the rows a delete of this batch will remove. The UI
// states both when they differ (never implies a delete reverts overlaid
// values on rows it did not create).
//
// IMP-010A provenance note (2026-08-25): since CSV parsing moved into the
// BROWSER, `malformed_row_count` is CLIENT-CLAIMED on this path -- it is
// the browser parser's own count of rows it dropped before ever sending
// them, PLUS any additional rows this deployment's own server-side
// re-validation independently rejected among what it actually received
// (`app/price-upload-service.ts`'s IMP-010A header note). The server can
// only verify the second part; the first part is informational/display
// only (the owner's "N malformed rows" text) and is never trusted for
// anything write-affecting -- `row_count`/`inserted_row_count` above stay
// server-computed from what was actually written, unaffected.
export const priceUploadBatches = sqliteTable(
  "price_upload_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    sourceLabel: text("source_label").notNull(),
    format: text("format").notNull(),
    filename: text("filename").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    insertedRowCount: integer("inserted_row_count").notNull().default(0),
    malformedRowCount: integer("malformed_row_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "price_upload_batches_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check(
      "price_upload_batches_format_check",
      sql`${table.format} IN ('single', 'backup')`,
    ),
    check("price_upload_batches_row_count_check", sql`${table.rowCount} >= 0`),
    check(
      "price_upload_batches_inserted_row_count_check",
      sql`${table.insertedRowCount} >= 0 AND ${table.insertedRowCount} <= ${table.rowCount}`,
    ),
    check(
      "price_upload_batches_malformed_row_count_check",
      sql`${table.malformedRowCount} >= 0`,
    ),
    index("price_upload_batches_owner_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// WLT-001: the owner's watchlist -- INTEREST only, never a position. One row
// per (user, target), where target is either a security or an ISO currency
// pair. User-scoped (keyed directly by `user_id`, not `portfolio_id`): the
// watchlist exists independently of any portfolio, so a brand-new owner with
// zero portfolios can still build one (owner ruling, 2026-08-22, "The
// Quotes tab is a watch list ... it does not record a position, just an
// interest"). No quantity/position column exists on this table, and none
// ever should -- quote data itself is never stored here either: reads join
// through the SAME `price_observations` (`selectPriceObservation`, MKT-009B
// preference + MKT-012 owner-import tier) and `fx_rate_observations`
// selection every other quote surface in this codebase already uses (see
// `app/owned-watchlist.ts` -- the owned-mode Quotes-tab loader this table
// backs; the earlier `app/owned-quotes.ts` it replaced no longer exists)
// -- this table only records WHAT the owner is watching and its display
// order.
export const watchlistEntries = sqliteTable(
  "watchlist_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    // Exactly one of `securityId` / (`baseCurrencyCode`, `quoteCurrencyCode`)
    // is set, enforced by the shape CHECK below -- never both, never neither.
    securityId: text("security_id"),
    baseCurrencyCode: text("base_currency_code"),
    quoteCurrencyCode: text("quote_currency_code"),
    // Owner-controlled row order (drag/move affordance) -- a plain integer,
    // unique only in intent (not DB-enforced; a duplicate/gap is harmless,
    // the read path just orders by this then `created_at` for a stable tie
    // break).
    displayOrder: integer("display_order").notNull(),
    createdAt: text("created_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "watchlist_entries_user_id_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "watchlist_entries_security_id_securities_id_fk",
      columns: [table.securityId],
      foreignColumns: [securities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "watchlist_entries_base_currency_code_currencies_code_fk",
      columns: [table.baseCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    foreignKey({
      name: "watchlist_entries_quote_currency_code_currencies_code_fk",
      columns: [table.quoteCurrencyCode],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check(
      "watchlist_entries_kind_check",
      sql`${table.kind} IN ('security', 'currency_pair')`,
    ),
    check(
      "watchlist_entries_shape_check",
      sql`(${table.kind} = 'security' AND ${table.securityId} IS NOT NULL AND ${table.baseCurrencyCode} IS NULL AND ${table.quoteCurrencyCode} IS NULL)
          OR (${table.kind} = 'currency_pair' AND ${table.securityId} IS NULL AND ${table.baseCurrencyCode} IS NOT NULL AND ${table.quoteCurrencyCode} IS NOT NULL AND ${table.baseCurrencyCode} <> ${table.quoteCurrencyCode})`,
    ),
    // One watch entry per (owner, security) and per (owner, currency pair)
    // -- partial unique indexes scoped by `kind`, so a security row and a
    // currency-pair row never collide with each other's NULL columns.
    uniqueIndex("watchlist_entries_user_security_unique")
      .on(table.userId, table.securityId)
      .where(sql`${table.kind} = 'security'`),
    uniqueIndex("watchlist_entries_user_pair_unique")
      .on(table.userId, table.baseCurrencyCode, table.quoteCurrencyCode)
      .where(sql`${table.kind} = 'currency_pair'`),
    index("watchlist_entries_user_order_idx").on(
      table.userId,
      table.displayOrder,
    ),
  ],
);

// ---------------------------------------------------------------------------
// DIV-014 (owner directive, 2026-08-24): saved multi-year income what-if
// scenarios -- durable, portfolio-scoped, owner-named. Stores ONLY the
// scenario's INPUTS, never any computed projection output: the
// "Add/Remove Capital" parcel rows (`domain/dividends/projection.ts`'s own
// `CapitalEventInput[]` shape, JSON-encoded verbatim, including each
// parcel's own `null` blank-follows-portfolio growth flags), the
// reinvest-dividends toggle, and the two top-level what-if growth axes.
// Each growth axis is stored EITHER as a concrete decimal string (the owner
// explicitly edited that axis away from its seed before saving) OR `NULL`
// (the axis was left untouched) -- `NULL` means a LOADED scenario still
// LIVE-follows whatever the portfolio's own growth assumption resolves to
// at load time, never a frozen copy of what it happened to be at save time
// (see `app/income-whatif.ts`'s `resolveLoadedScenarioGrowthField`, the one
// place a stored value is turned back into the component's touched/input
// state). Composite FK to `(portfolios.id, portfolios.userId)` mirrors
// `dividendFyOverrides`'s identical owner-scoped, portfolio-scoped pattern
// immediately below it in this file (defense in depth: a caller can never
// pass a `portfolioId` that belongs to a different `userId` than the one
// making the request).
export const incomeWhatifScenarios = sqliteTable(
  "income_whatif_scenarios",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    name: text("name").notNull(),
    // `CapitalEventInput[]` JSON-encoded verbatim -- see the header comment.
    capitalRowsJson: text("capital_rows_json").notNull(),
    reinvestDividends: integer("reinvest_dividends").notNull(),
    // `NULL` = this axis was left untouched at save time (live-follows the
    // portfolio assumption on every future load); a decimal string = the
    // owner's own edited input, frozen exactly as saved.
    valueGrowthPercentDecimal: text("value_growth_percent_decimal"),
    dividendGrowthPercentDecimal: text("dividend_growth_percent_decimal"),
    createdAt: text("created_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: "income_whatif_scenarios_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    check(
      "income_whatif_scenarios_name_check",
      sql`length(trim(${table.name})) > 0`,
    ),
    check(
      "income_whatif_scenarios_reinvest_dividends_check",
      sql`${table.reinvestDividends} IN (0, 1)`,
    ),
    index("income_whatif_scenarios_portfolio_user_idx").on(
      table.portfolioId,
      table.userId,
      table.createdAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// HIST-002 (owner ruling, 2026-08-25: "go" on the persist-once +
// incremental read path -- see TASKS.md's HIST-002 entry): a durable cache
// of `domain/snapshots/historical-portfolio-value.ts`'s EXACT-DATE
// (`priceToleranceDays: 0`) read-time derivation, one row per (portfolio,
// candidate date) the derivation actually resolved a value for. This is NOT
// a second formula -- every stored row's `value_decimal`/`completeness`/
// `held_security_count`/`priced_security_count` is that module's own output,
// copied verbatim; the read-time derivation remains the SOLE source of
// truth and the fallback/verifier whenever a row is missing (see the
// bounded backfill-on-read logic inline in
// `app/historical-portfolio-value.ts`'s `loadHistoricalPortfolioValueSeries`
// -- this table's only write path besides invalidation).
// SECURITIES-ONLY per the BUG-002 owner ruling, matching the derivation it
// caches -- no cash columns, ever.
//
// Honesty invariant: a date with NO usable value is simply ABSENT here --
// never a NULL-valued placeholder row (mirrors
// `HistoricalPortfolioValuePoint`'s own "not a candidate date" convention;
// a `completeness = 'partial'` row DOES still get a row, because the
// derivation resolved a real, if partial, non-null total for it -- only a
// fully-unresolved date has no row at all).
//
// Natural key `(portfolio_id, value_date)`; `id` stays a surrogate per this
// codebase's universal PK convention. Composite FK to
// `(portfolios.id, portfolios.userId)` mirrors `incomeWhatifScenarios`
// immediately above (defense in depth against a cross-owner `portfolioId`).
export const portfolioValueHistory = sqliteTable(
  "portfolio_value_history",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    valueDate: text("value_date").notNull(),
    valueDecimal: text("value_decimal").notNull(),
    completeness: text("completeness").notNull(),
    heldSecurityCount: integer("held_security_count").notNull(),
    pricedSecurityCount: integer("priced_security_count").notNull(),
    // Provenance: when this row was last (re)computed -- never displayed,
    // audit/debugging only (matches this codebase's convention of recording
    // computation/ingestion instants even on derived/cache rows).
    computedAt: text("computed_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "portfolio_value_history_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    check(
      "portfolio_value_history_completeness_check",
      sql`${table.completeness} IN ('complete', 'partial')`,
    ),
    check(
      "portfolio_value_history_held_count_check",
      sql`${table.heldSecurityCount} >= 0`,
    ),
    check(
      "portfolio_value_history_priced_count_check",
      sql`${table.pricedSecurityCount} >= 0 AND ${table.pricedSecurityCount} <= ${table.heldSecurityCount}`,
    ),
    uniqueIndex("portfolio_value_history_portfolio_date_unique").on(
      table.portfolioId,
      table.valueDate,
    ),
    index("portfolio_value_history_user_portfolio_idx").on(
      table.userId,
      table.portfolioId,
      table.valueDate,
    ),
  ],
);

// ---------------------------------------------------------------------------
// BUG-012 (2026-09-03, follow-up to BUG-010/PRF-010): a candidate date the
// read-time derivation genuinely CANNOT resolve (no shares held that day, or
// every held security missing a price/FX within tolerance) was never stored
// in `portfolioValueHistory` above -- the table's own honesty invariant, see
// its header comment. That meant such a date stayed "missing" forever and
// was re-attempted on EVERY read/cron tick; a contiguous unresolvable run at
// least as long as one call's `MAX_DERIVE_DATES_PER_READ`/
// `CRON_MAX_BACKFILL_DATES_PER_TICK` bound pins that call's slice in place
// permanently and starves every date behind it (docs/ARCHITECTURE.md §9.4's
// BUG-010 entry recorded this as a known, deliberately-unfixed hazard).
//
// Orchestrator schema ruling: persist "attempted, genuinely unresolvable" as
// a fact SIBLING to `portfolioValueHistory`, not as nullable columns on it.
// `portfolioValueHistory.valueDecimal`/`completeness`/`heldSecurityCount`/
// `pricedSecurityCount` are all `NOT NULL` with CHECK constraints tying
// `pricedSecurityCount` to `heldSecurityCount` -- relaxing any of them to
// nullable is a column-type change SQLite cannot do via `ALTER TABLE`
// without a full table rebuild (drop + recreate + copy), which this
// codebase avoids for a routine additive change (see `historyCompleteFrom`/
// `value_history_backfill_verified_*`'s own nullable-`ADD COLUMN`
// precedent, which only works because THEIR host columns start out
// nullable). A sibling table with the SAME owner-scoped unique key
// (`portfolio_id`, `value_date`) needs no rebuild and keeps
// `portfolioValueHistory` itself exactly what its header promises: every
// row there is a REAL, non-null derived value, never a placeholder.
//
// `reason` records WHY the derivation could not resolve a value (see
// `domain/snapshots/historical-portfolio-value.ts`'s `valuePointAtDate`):
// `'no_holdings'` when `heldSecurityCount` was 0 (nothing held that day --
// e.g. a candidate date before this portfolio's first trade in a held
// security), `'no_priceable_security'` when securities were held but NONE
// resolved a price/FX within tolerance. Either can still change later: a
// back-dated ledger correction can turn 0 shares into a non-zero holding, a
// price/FX import can supply the missing observation -- so this is a
// CACHED "not resolvable as of the last attempt" fact, never a permanent
// write-off. `fingerprint` is a diagnostic-only snapshot of the facts that
// produced this determination (`held=<n>;priced=<n>`), for a human
// investigating why a date is marked -- unlike PRF-010's convergence
// fingerprint, nothing in this codebase compares it for equality.
//
// Load-bearing correctness property: every write path that already
// invalidates `portfolioValueHistory` for a date range (ledger mutations,
// import-commit `finalize`, price-history uploads, the Yahoo-compatible/
// Sharesight-price rollups, MKT-011A intraday capture) MUST ALSO clear the
// matching rows here in the SAME atomic batch/call -- otherwise a date that
// becomes newly resolvable stays permanently written off. See
// `db/repositories/portfolio-value-history.ts`'s invalidation section for
// the paired clear alongside each existing invalidation shape.
//
// The candidate-date query (`app/historical-portfolio-value.ts`'s
// `resolveValueHistorySeries`) treats a date with a row here (and no
// `portfolioValueHistory` row) as "already attempted, skip" -- excluded
// from `missingDates`, so it can never pin a bounded slice again. A read
// still renders it honestly absent (no fabricated/interpolated value,
// mirroring every other "not derived this call" gap already rendered).
//
// PRF-010 fold: the convergence-marker fingerprint
// (`ValueHistoryConvergenceFingerprint`) now folds in this table's row
// count and `MAX(attempted_at)` for the portfolio -- a write path that
// clears a mark here (a newly-resolvable date) changes that snapshot, so a
// stale marker cannot claim "converged" over a portfolio whose unresolvable
// set just shrank. Every existing invalidation path already mutates this
// table per the paragraph above, so -- exactly like the stored-side
// fingerprint -- there is no fifth call site to remember for the
// fingerprint's sake specifically.
export const portfolioValueHistoryUnresolvable = sqliteTable(
  "portfolio_value_history_unresolvable",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    valueDate: text("value_date").notNull(),
    reason: text("reason").notNull(),
    attemptedAt: text("attempted_at").notNull(),
    // Diagnostic-only; see this section's header comment.
    fingerprint: text("fingerprint"),
  },
  (table) => [
    foreignKey({
      name: "portfolio_value_history_unresolvable_portfolio_id_user_id_fk",
      columns: [table.portfolioId, table.userId],
      foreignColumns: [portfolios.id, portfolios.userId],
    }).onDelete("restrict"),
    check(
      "portfolio_value_history_unresolvable_reason_check",
      sql`${table.reason} IN ('no_holdings', 'no_priceable_security')`,
    ),
    uniqueIndex(
      "portfolio_value_history_unresolvable_portfolio_date_unique",
    ).on(table.portfolioId, table.valueDate),
    index("portfolio_value_history_unresolvable_user_portfolio_idx").on(
      table.userId,
      table.portfolioId,
      table.valueDate,
    ),
  ],
);
