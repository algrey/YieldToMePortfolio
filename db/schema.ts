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
