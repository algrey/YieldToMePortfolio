// EXP-002 (owner-directed, TASKS.md "### EXP-002"): the full-system backup
// artifact -- ONE JSON file covering every portfolio of the authenticated
// owner PLUS the account-level facts EXP-001's single-portfolio bundle
// deliberately excluded (watchlist, account settings, price-history
// observations). Pure, DB/auth-free domain module -- types and structural
// validation only, mirroring `domain/exports/portfolio-bundle.ts`'s own
// split (parsing/validation live here; DB reads/writes live in
// `db/repositories/system-backup.ts` and `app/system-backup-service.ts`).
// Server-side validation here is the SOLE authority per IMP-010B, exactly
// like the per-portfolio bundle this module nests.
//
// DELIBERATE REUSE, not a parallel format: each entry of `portfolios` below
// is validated with `validatePortfolioBundle` UNCHANGED -- the exact same
// per-portfolio schema/validator EXP-001 ships, never a second, drifting
// definition. The price-history section is the pre-existing MKT-008 backup
// CSV TEXT verbatim (`priceBackupCsv`, produced by `formatPriceBackupCsv`
// and consumed by the pre-existing `parsePriceBackupCsv`/
// `confirmBackupPriceUpload`) -- this module does not parse or validate its
// rows at all; that stays MKT-008's own job, called from
// `app/system-backup-service.ts`. See `docs/BACKUP_FORMAT.md` for the full
// format spec, coverage table, precondition, and reversal story.
import {
  isCurrencyCode,
  isIsoString,
  validatePortfolioBundle,
  type PortfolioBundleV1,
} from "./portfolio-bundle.ts";

export const SYSTEM_BACKUP_SCHEMA_VERSION = 1;

// A personal-account-scale ceiling on the NUMBER of nested portfolio
// bundles, not a platform limit -- mirrors `portfolio-bundle.ts`'s
// `MAX_BUNDLE_ENTITIES` reasoning (state the count honestly). Each nested
// bundle is independently capped at `MAX_BUNDLE_ENTITIES` already; this
// bounds the outer array so a hostile/malformed file with an enormous
// `portfolios` array fails fast before any per-item validation work.
export const MAX_SYSTEM_BACKUP_PORTFOLIOS = 200;

// Reuses `app/price-upload-request-body.ts`'s `MAX_BACKUP_REQUEST_BYTES`
// rationale verbatim: the embedded price-history CSV text dominates this
// artifact's size (the owner's real backup is a ~141 KB portfolio bundle
// plus several MB of price history), and MKT-008's own backup-restore path
// already accepts up to 64 MiB for the SAME reason (20 MiB client-side CSV
// cap, ~2.30x measured JSON-row expansion, comfortably under Cloudflare's
// platform request-body ceiling). A system-backup request additionally
// carries the portfolio bundles + account settings + watchlist, but those
// are small relative to price history (EXP-001's own 32 MiB
// `MAX_BUNDLE_REQUEST_BYTES` is PER PORTFOLIO already) -- reusing the same
// 64 MiB number rather than deriving a new one keeps this consistent with
// the one other place this codebase already accepts a price-history-shaped
// payload of this scale.
export const MAX_SYSTEM_BACKUP_REQUEST_BYTES = 64 * 1024 * 1024;

const PRICE_SOURCE_PREFERENCES = new Set([
  "yahoo_authenticated",
  "yahoo_anonymous",
  "sharesight_delayed",
]);
const DAILY_CAPTURE_SOURCES = new Set([
  "sharesight",
  "yahoo_anonymous",
  "yahoo_authenticated",
]);
const DAILY_CAPTURE_INTERVALS = new Set([30, 60]);
const HOLDING_CURRENCY_VIEWS = new Set(["native", "home"]);

export type SystemBackupAccountSettings = {
  homeCurrencyCode: string;
  timezone: string;
  defaultHoldingCurrencyView: "native" | "home";
  financialYearStartMonth: number;
  priceSourcePreference:
    "yahoo_authenticated" | "yahoo_anonymous" | "sharesight_delayed";
  dailyCaptureSource: "sharesight" | "yahoo_anonymous" | "yahoo_authenticated";
  dailyCaptureIntervalMinutes: 30 | 60;
};

export type SystemBackupWatchlistSecurityEntry = {
  kind: "security";
  tickerIdentifier: string | null;
  isinIdentifier: string | null;
  sharesightInstrumentId: string | null;
  currencyCode: string;
  canonicalName: string | null;
};

export type SystemBackupWatchlistPairEntry = {
  kind: "currency_pair";
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
};

export type SystemBackupWatchlistEntry =
  SystemBackupWatchlistSecurityEntry | SystemBackupWatchlistPairEntry;

export type SystemBackupV1 = {
  schemaVersion: 1;
  exportedAt: string;
  account: SystemBackupAccountSettings;
  watchlistEntries: SystemBackupWatchlistEntry[];
  portfolios: PortfolioBundleV1[];
  // Verbatim MKT-008 backup-CSV text (`formatPriceBackupCsv`'s own output --
  // empty string when the owner has no price history at all). Never parsed
  // here; see this module's header comment.
  priceBackupCsv: string;
};

export type SystemBackupValidationFailure = { ok: false; message: string };
export type SystemBackupValidationResult =
  { ok: true; backup: SystemBackupV1 } | SystemBackupValidationFailure;

function fail(message: string): SystemBackupValidationFailure {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAccountSettings(
  value: unknown,
): SystemBackupAccountSettings | null {
  if (!isPlainObject(value)) return null;
  if (
    !isCurrencyCode(value.homeCurrencyCode) ||
    typeof value.timezone !== "string" ||
    value.timezone.trim().length === 0 ||
    typeof value.defaultHoldingCurrencyView !== "string" ||
    !HOLDING_CURRENCY_VIEWS.has(value.defaultHoldingCurrencyView) ||
    typeof value.financialYearStartMonth !== "number" ||
    !Number.isInteger(value.financialYearStartMonth) ||
    value.financialYearStartMonth < 1 ||
    value.financialYearStartMonth > 12 ||
    typeof value.priceSourcePreference !== "string" ||
    !PRICE_SOURCE_PREFERENCES.has(value.priceSourcePreference) ||
    typeof value.dailyCaptureSource !== "string" ||
    !DAILY_CAPTURE_SOURCES.has(value.dailyCaptureSource) ||
    typeof value.dailyCaptureIntervalMinutes !== "number" ||
    !DAILY_CAPTURE_INTERVALS.has(value.dailyCaptureIntervalMinutes)
  ) {
    return null;
  }
  return {
    homeCurrencyCode: value.homeCurrencyCode,
    timezone: value.timezone,
    defaultHoldingCurrencyView: value.defaultHoldingCurrencyView as
      "native" | "home",
    financialYearStartMonth: value.financialYearStartMonth,
    priceSourcePreference:
      value.priceSourcePreference as SystemBackupAccountSettings["priceSourcePreference"],
    dailyCaptureSource:
      value.dailyCaptureSource as SystemBackupAccountSettings["dailyCaptureSource"],
    dailyCaptureIntervalMinutes: value.dailyCaptureIntervalMinutes as 30 | 60,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === "string";
}

function validateWatchlistEntry(
  value: unknown,
): SystemBackupWatchlistEntry | null {
  if (!isPlainObject(value)) return null;
  if (value.kind === "security") {
    if (
      !isNullableString(value.tickerIdentifier) ||
      !isNullableString(value.isinIdentifier) ||
      !isNullableString(value.sharesightInstrumentId) ||
      !isCurrencyCode(value.currencyCode) ||
      !isNullableString(value.canonicalName) ||
      // At least one durable identity fact must survive export -- a ticker
      // is never treated as sufficient alone elsewhere in this codebase,
      // but here it is at minimum ONE of ticker/ISIN/Sharesight-instrument
      // that must be present, or restore has nothing to resolve against.
      (((value.tickerIdentifier as string | null | undefined) ?? null) ===
        null &&
        ((value.isinIdentifier as string | null | undefined) ?? null) ===
          null &&
        ((value.sharesightInstrumentId as string | null | undefined) ??
          null) === null)
    ) {
      return null;
    }
    return {
      kind: "security",
      tickerIdentifier: (value.tickerIdentifier as string | null) ?? null,
      isinIdentifier: (value.isinIdentifier as string | null) ?? null,
      sharesightInstrumentId:
        (value.sharesightInstrumentId as string | null) ?? null,
      currencyCode: value.currencyCode,
      canonicalName: (value.canonicalName as string | null) ?? null,
    };
  }
  if (value.kind === "currency_pair") {
    if (
      !isCurrencyCode(value.baseCurrencyCode) ||
      !isCurrencyCode(value.quoteCurrencyCode) ||
      value.baseCurrencyCode === value.quoteCurrencyCode
    ) {
      return null;
    }
    return {
      kind: "currency_pair",
      baseCurrencyCode: value.baseCurrencyCode,
      quoteCurrencyCode: value.quoteCurrencyCode,
    };
  }
  return null;
}

/**
 * Server-side sole validation authority (IMP-010B pattern), mirroring
 * `validatePortfolioBundle`'s own shape exactly. Every nested portfolio
 * bundle is validated with the UNCHANGED `validatePortfolioBundle` -- never
 * a second definition of that schema. This deliberately does NOT check
 * DB-side facts (does the account already have unrelated portfolios? does
 * the embedded price-history CSV parse?) -- those are commit-time checks in
 * `app/system-backup-service.ts`, which needs a `SqlClient`.
 */
export function validateSystemBackup(
  raw: unknown,
): SystemBackupValidationResult {
  if (!isPlainObject(raw)) return fail("The backup file is not readable.");
  if (raw.schemaVersion !== SYSTEM_BACKUP_SCHEMA_VERSION) {
    return fail(
      `This backup's format version (${String(raw.schemaVersion)}) is not supported by this app version. Expected version ${SYSTEM_BACKUP_SCHEMA_VERSION}.`,
    );
  }
  if (!isIsoString(raw.exportedAt))
    return fail("The backup's export date is invalid.");

  const account = validateAccountSettings(raw.account);
  if (!account) return fail("The backup's account settings are invalid.");

  if (!Array.isArray(raw.watchlistEntries)) {
    return fail("The backup's watchlist list is invalid.");
  }
  const watchlistEntries: SystemBackupWatchlistEntry[] = [];
  for (const item of raw.watchlistEntries) {
    const entry = validateWatchlistEntry(item);
    if (!entry) return fail("The backup contains an invalid watchlist entry.");
    watchlistEntries.push(entry);
  }

  if (!Array.isArray(raw.portfolios)) {
    return fail("The backup's portfolios list is invalid.");
  }
  if (raw.portfolios.length > MAX_SYSTEM_BACKUP_PORTFOLIOS) {
    return fail(
      `This backup contains ${raw.portfolios.length} portfolios, over the ${MAX_SYSTEM_BACKUP_PORTFOLIOS} supported by this app version.`,
    );
  }
  const portfolios: PortfolioBundleV1[] = [];
  for (const [index, item] of raw.portfolios.entries()) {
    const result = validatePortfolioBundle(item);
    if (!result.ok) {
      return fail(
        `Portfolio #${index + 1} in this backup is invalid: ${result.message}`,
      );
    }
    portfolios.push(result.bundle);
  }

  if (typeof raw.priceBackupCsv !== "string") {
    return fail("The backup's price-history section is invalid.");
  }

  return {
    ok: true,
    backup: {
      schemaVersion: 1,
      exportedAt: raw.exportedAt,
      account,
      watchlistEntries,
      portfolios,
      priceBackupCsv: raw.priceBackupCsv,
    },
  };
}
