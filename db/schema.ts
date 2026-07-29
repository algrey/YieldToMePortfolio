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
