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
    uniqueIndex("transactions_portfolio_source_reference_unique").on(
      table.portfolioId,
      table.sourceType,
      table.sourceReference,
    ),
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
    index("price_observations_security_date_idx").on(
      table.securityId,
      table.adjustmentState,
      table.marketDate,
    ),
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
    status: text("status").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
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
