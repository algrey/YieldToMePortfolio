// EXP-001 (owner-directed, TASKS.md "### EXP-001"): the single-portfolio
// export/import bundle format. Pure, DB/auth-free domain module -- types and
// structural validation only, mirroring `domain/market-data/
// price-backup-csv.ts`'s split (parsing/validation live here; DB reads and
// writes live in `db/repositories/portfolio-bundle.ts` and
// `app/portfolio-bundle-service.ts`). Server-side validation here is the
// SOLE authority per IMP-010B's browser-parses/server-validates rule -- the
// browser only reads the uploaded file as text and JSON.parses it before
// POSTing; every field below is re-validated from scratch, exactly as if it
// arrived from an untrusted network peer (AGENTS.md: "unknown at external
// boundaries").
//
// Acceptance sentence (owner's own words, TASKS.md EXP-001): "if I export
// the historical prices and the portfolio, I should be able to recreate
// that portfolio with ALL of its functionality (ok if that occurs after a
// chron runs to generate something, but should not need new data)." This
// bundle is the "portfolio" half of that pair; the price-history backup
// (MKT-008/IMP-010A) is the "historical prices" half -- see
// `docs/BACKUP_FORMAT.md` for the full format spec, the owned-table
// classification table, and the collision policy.
//
// INVESTIGATION FINDING (CGT-004): the Cap Gains sub-tab
// (`app/owned-capital-gains.ts`) reads `tax_lots`/`lot_allocations` written
// by the calculation-run pipeline over the PUBLISHED `projection_
// publications` pointer -- both tables are populated by re-running the FIFO
// lot-matching engine over `transactions`, never by anything the owner
// types directly. Capital gains are therefore PURELY DERIVED from the
// transaction ledger (which this bundle already carries in full, including
// reversal/supersession chains): nothing capital-gains-specific is
// exported. Re-running the calculation engine after import (the acceptance
// sentence's "after a chron runs" allowance) reproduces the identical Cap
// Gains tab from the replayed transactions.
//
// INVESTIGATION FINDING (watchlist scope): `watchlist_entries` (see
// `db/schema.ts`'s table) carries `user_id` only -- there is no
// `portfolio_id` column at all, and the WLT-001 header comment on
// `db/repositories/account-lifecycle.ts`'s `OWNED_TABLES` entry confirms
// this is deliberate ("owner-scoped watchlist -- interest only, never a
// position"). The watchlist is ACCOUNT-scoped, not portfolio-scoped, so it
// is excluded from this single-portfolio bundle entirely (noted for
// EXP-002's full-account backup instead).

const HEX_RE = /^[0-9a-f]+$/;
export const PORTFOLIO_BUNDLE_SCHEMA_VERSION = 1;
export const PORTFOLIO_BUNDLE_PARSER_FORMAT = "portfolio-bundle-json";

// A personal-portfolio-scale ceiling, not a platform limit: chosen so a
// genuinely large owner history (thousands of trades/dividends over many
// years) fits comfortably while a malformed/hostile bundle fails fast
// before any DB work. Mirrors `domain/market-data/price-backup-csv.ts`'s
// `DEFAULT_PRICE_BACKUP_LIMITS.maxRows` reasoning (state the count
// honestly rather than derive it from a byte budget). Documented in
// `docs/BACKUP_FORMAT.md`; if a real portfolio ever needs more, the commit
// path would need chunked/resumable writes -- flagged there as a follow-up,
// not silently raised here.
export const MAX_BUNDLE_ENTITIES = 20_000;
// The request-body ceiling the server enforces via `readJsonBody` (see
// `app/portfolio-bundle-request-body.ts`). A bundle is JSON, not CSV, so
// there is no separate client-side file cap to mirror -- this is the one
// number. 32 MiB comfortably covers `MAX_BUNDLE_ENTITIES` worth of the
// widest row shape (a transaction) with JSON field-name overhead, while
// staying well under Cloudflare's platform request-body ceiling.
export const MAX_BUNDLE_REQUEST_BYTES = 32 * 1024 * 1024;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SIGNED_DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function isDateString(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}
export function isIsoString(value: unknown): value is string {
  return typeof value === "string" && ISO_RE.test(value);
}
export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && SIGNED_DECIMAL_RE.test(value);
}
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && CURRENCY_RE.test(value);
}
function isNullableDecimal(value: unknown): value is string | null {
  return value === null || value === undefined || isDecimalString(value);
}
function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === "string";
}
function isRefId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80;
}

export type BundleSecurityIdentity = {
  ref: string;
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
  sourceName: string | null;
  displaySymbol: string | null;
  displayName: string | null;
  status: "held" | "watch" | "hidden" | "unresolved";
  firstRelevantDate: string | null;
  lastRelevantDate: string | null;
  // Resolution facts (AGENTS.md: "a ticker is not a durable security ID") --
  // enough of the shared `securities`/`security_identifiers` master to
  // re-resolve on import via the SAME create-if-absent machinery BRK-009B
  // uses (`db/repositories/security-resolution.ts`'s `resolveAndLink`).
  canonicalName: string | null;
  primaryCurrencyCode: string | null;
  tickerIdentifier: string | null;
  isinIdentifier: string | null;
  sharesightInstrumentId: string | null;
};

export type BundleTransaction = {
  ref: string;
  securityRef: string | null;
  type: string;
  status: "posted" | "reversed" | "superseded";
  tradeAt: string;
  localTradeDate: string;
  settlementDate: string | null;
  quantityDecimal: string | null;
  unitPriceDecimal: string | null;
  currencyCode: string;
  grossAmountDecimal: string | null;
  feeAmountDecimal: string;
  taxAmountDecimal: string;
  fxRateToBaseDecimal: string | null;
  fxRateSource: string | null;
  fxObservedAt: string | null;
  sourceType: string;
  sourceReference: string | null;
  createdAt: string;
  // Chain topology (`ref` of another transaction in THIS bundle, or null) --
  // see `docs/BACKUP_FORMAT.md` for the replay order rule ("ancestors
  // before successors, tie-broken by createdAt").
  reversesRef: string | null;
  supersedesRef: string | null;
};

export type BundleDividendManualRecord = {
  ref: string;
  securityRef: string;
  paymentDate: string;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  totalCashDecimal: string | null;
  totalFrankingDecimal: string | null;
  currencyCode: string | null;
  fxRateToPortfolioDecimal: string | null;
  fxRateSource: string | null;
  sourceReference: string | null;
  wasImported: boolean;
  createdAt: string;
  supersedesRef: string | null;
  // B1 fix (reviewer, tombstone resurrection): true when this row's OWN
  // `superseded_by_record_id` (DIV-016A) pointed at a successor that was
  // later head-deleted (DATA_MODEL "DELETE semantics" -- the successor row
  // no longer exists, but the ancestor stays permanently excluded from
  // evidence; it is never resurrected). Since the deleted successor is
  // never itself exported (it doesn't exist), this boolean is the ONLY
  // signal that survives export -- without it, a tombstoned ancestor would
  // import as a normal live row and its income would wrongly count again.
  supersededByDeletedRecord: boolean;
};

export type BundleDividendSecurityAssumption = {
  securityRef: string;
  dividendYieldPercentDecimal: string | null;
  frankingPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  forceAssumption: boolean | null;
};

export type BundleDividendPortfolioAssumption = {
  valueGrowthPercentDecimal: string | null;
  portfolioDividendGrowthPercentDecimal: string | null;
};

export type BundleDividendFyOverride = {
  financialYearEndingYear: number;
  grossedAmountDecimal: string;
  frankingAmountDecimal: string | null;
};

export type BundleDividendEventOverride = {
  securityRef: string;
  dividendEventId: string;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  exclude: boolean;
};

export type BundleDividendImportFrankingOverride = {
  securityRef: string;
  dividendManualRecordRef: string;
  frankingTotalDecimal: string;
};

export type BundleWhatifScenario = {
  name: string;
  capitalRowsJson: string;
  reinvestDividends: boolean;
  valueGrowthPercentDecimal: string | null;
  dividendGrowthPercentDecimal: string | null;
  createdAt: string;
};

export type PortfolioBundleV1 = {
  schemaVersion: 1;
  exportedAt: string;
  portfolio: {
    name: string;
    code: string;
    baseCurrencyCode: string;
    timezone: string;
    accountingMethod: string;
    historyCompleteFrom: string | null;
    // Informational only -- NOT restored on import (see the header
    // comment's FY-start-month investigation finding: it is a per-USER
    // setting, `user_settings.financial_year_start_month`, with no
    // per-portfolio override; restoring it here would silently rewrite the
    // importing owner's account-wide FY convention for every OTHER
    // portfolio too).
    financialYearStartMonthAtExport: number;
    // EXP-002 review (B2 ruling, 2026-08-27): added post-release-but-
    // pre-ship (this format has never shipped to a real deployment, so
    // `schemaVersion` stays 1 rather than bumping for an additive field --
    // see `docs/BACKUP_FORMAT.md`'s changelog line). OPTIONAL on input --
    // an older/hand-edited bundle without this field is treated as
    // `"active"` (the pre-B2 behaviour) -- but ALWAYS present on a
    // validated bundle's output. Restored via `portfolios.archive()` as the
    // LAST commit step (see `commitPortfolioBundleImport`'s own comment) so
    // an archived portfolio's full history still replays through the SAME
    // ledger/dividend write paths an active one does.
    status: "active" | "archived";
  };
  portfolioSettings: {
    // `portfolio_settings` is a genuinely optional row -- `db/repositories/
    // owned-portfolios.ts`'s `create()` never inserts one, and no read path
    // in this codebase currently consumes this column (grepped clean).
    // Exported/restored for OWNED_TABLES completeness only; `null` means
    // "no row existed at export time", never a fabricated default.
    quoteStalenessPolicy: string | null;
  };
  securities: BundleSecurityIdentity[];
  transactions: BundleTransaction[];
  dividendManualRecords: BundleDividendManualRecord[];
  dividendSecurityAssumptions: BundleDividendSecurityAssumption[];
  dividendPortfolioAssumption: BundleDividendPortfolioAssumption | null;
  dividendFyOverrides: BundleDividendFyOverride[];
  dividendEventOverrides: BundleDividendEventOverride[];
  dividendImportFrankingOverrides: BundleDividendImportFrankingOverride[];
  whatifScenarios: BundleWhatifScenario[];
};

export type BundleValidationFailure = { ok: false; message: string };
export type BundleValidationResult =
  { ok: true; bundle: PortfolioBundleV1 } | BundleValidationFailure;

function fail(message: string): BundleValidationFailure {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSecurity(
  value: unknown,
  refs: Set<string>,
): BundleSecurityIdentity | null {
  if (!isPlainObject(value)) return null;
  if (
    !isRefId(value.ref) ||
    typeof value.sourceSymbol !== "string" ||
    value.sourceSymbol.trim().length === 0 ||
    value.sourceSymbol.length > 40 ||
    !isNullableString(value.sourceExchangeAlias) ||
    !isCurrencyCode(value.sourceCurrencyCode) ||
    !isNullableString(value.sourceName) ||
    !isNullableString(value.displaySymbol) ||
    !isNullableString(value.displayName) ||
    typeof value.status !== "string" ||
    !["held", "watch", "hidden", "unresolved"].includes(value.status) ||
    (value.firstRelevantDate !== null &&
      !isDateString(value.firstRelevantDate)) ||
    (value.lastRelevantDate !== null &&
      !isDateString(value.lastRelevantDate)) ||
    !isNullableString(value.canonicalName) ||
    (value.primaryCurrencyCode !== null &&
      !isCurrencyCode(value.primaryCurrencyCode)) ||
    !isNullableString(value.tickerIdentifier) ||
    !isNullableString(value.isinIdentifier) ||
    !isNullableString(value.sharesightInstrumentId)
  ) {
    return null;
  }
  if (refs.has(value.ref)) return null;
  refs.add(value.ref);
  return {
    ref: value.ref,
    sourceSymbol: value.sourceSymbol,
    sourceExchangeAlias: value.sourceExchangeAlias ?? null,
    sourceCurrencyCode: value.sourceCurrencyCode,
    sourceName: value.sourceName ?? null,
    displaySymbol: value.displaySymbol ?? null,
    displayName: value.displayName ?? null,
    status: value.status as BundleSecurityIdentity["status"],
    firstRelevantDate: (value.firstRelevantDate as string | null) ?? null,
    lastRelevantDate: (value.lastRelevantDate as string | null) ?? null,
    canonicalName: value.canonicalName ?? null,
    primaryCurrencyCode: (value.primaryCurrencyCode as string | null) ?? null,
    tickerIdentifier: value.tickerIdentifier ?? null,
    isinIdentifier: value.isinIdentifier ?? null,
    sharesightInstrumentId: value.sharesightInstrumentId ?? null,
  };
}

// EXP-004: exported so a chunked, resumable replay (a system-backup restore
// part request carrying only a SLICE of one portfolio's transactions/
// dividend records, never the whole bundle) can apply the IDENTICAL
// structural validation each row gets when it arrives as part of a whole
// bundle -- IMP-010B's "server is the sole validation authority" applies
// exactly the same to a part as to a full bundle; a part must never trust
// row shape merely because the browser derived it from an already-validated
// file.
export function validateTransaction(
  value: unknown,
  refs: Set<string>,
  securityRefs: ReadonlySet<string>,
): BundleTransaction | null {
  if (!isPlainObject(value)) return null;
  if (
    !isRefId(value.ref) ||
    (value.securityRef !== null &&
      !securityRefs.has(value.securityRef as string)) ||
    typeof value.type !== "string" ||
    value.type.length === 0 ||
    value.type.length > 40 ||
    typeof value.status !== "string" ||
    !["posted", "reversed", "superseded"].includes(value.status) ||
    !isIsoString(value.tradeAt) ||
    !isDateString(value.localTradeDate) ||
    (value.settlementDate !== null && !isDateString(value.settlementDate)) ||
    !isNullableDecimal(value.quantityDecimal) ||
    !isNullableDecimal(value.unitPriceDecimal) ||
    !isCurrencyCode(value.currencyCode) ||
    !isNullableDecimal(value.grossAmountDecimal) ||
    !isDecimalString(value.feeAmountDecimal) ||
    !isDecimalString(value.taxAmountDecimal) ||
    !isNullableDecimal(value.fxRateToBaseDecimal) ||
    !isNullableString(value.fxRateSource) ||
    (value.fxObservedAt !== null && !isIsoString(value.fxObservedAt)) ||
    typeof value.sourceType !== "string" ||
    value.sourceType.length === 0 ||
    !isNullableString(value.sourceReference) ||
    !isIsoString(value.createdAt) ||
    (value.reversesRef !== null && !isRefId(value.reversesRef)) ||
    (value.supersedesRef !== null && !isRefId(value.supersedesRef))
  ) {
    return null;
  }
  if (refs.has(value.ref)) return null;
  refs.add(value.ref);
  return {
    ref: value.ref,
    securityRef: (value.securityRef as string | null) ?? null,
    type: value.type,
    status: value.status as BundleTransaction["status"],
    tradeAt: value.tradeAt,
    localTradeDate: value.localTradeDate,
    settlementDate: (value.settlementDate as string | null) ?? null,
    quantityDecimal: (value.quantityDecimal as string | null) ?? null,
    unitPriceDecimal: (value.unitPriceDecimal as string | null) ?? null,
    currencyCode: value.currencyCode,
    grossAmountDecimal: (value.grossAmountDecimal as string | null) ?? null,
    feeAmountDecimal: value.feeAmountDecimal,
    taxAmountDecimal: value.taxAmountDecimal,
    fxRateToBaseDecimal: (value.fxRateToBaseDecimal as string | null) ?? null,
    fxRateSource: value.fxRateSource ?? null,
    fxObservedAt: (value.fxObservedAt as string | null) ?? null,
    sourceType: value.sourceType,
    sourceReference: value.sourceReference ?? null,
    createdAt: value.createdAt,
    reversesRef: (value.reversesRef as string | null) ?? null,
    supersedesRef: (value.supersedesRef as string | null) ?? null,
  };
}

// EXP-004: exported for the same reason as `validateTransaction` above.
export function validateDividendManualRecord(
  value: unknown,
  refs: Set<string>,
  securityRefs: ReadonlySet<string>,
): BundleDividendManualRecord | null {
  if (!isPlainObject(value)) return null;
  const totalsMode =
    value.totalCashDecimal !== null && value.totalCashDecimal !== undefined;
  const perShareMode =
    (value.sharesDecimal !== null && value.sharesDecimal !== undefined) ||
    (value.dividendPerShareDecimal !== null &&
      value.dividendPerShareDecimal !== undefined);
  if (
    !isRefId(value.ref) ||
    typeof value.securityRef !== "string" ||
    !securityRefs.has(value.securityRef) ||
    !isDateString(value.paymentDate) ||
    !isNullableDecimal(value.sharesDecimal) ||
    !isNullableDecimal(value.dividendPerShareDecimal) ||
    !isNullableDecimal(value.frankingCreditPerShareDecimal) ||
    !isNullableDecimal(value.totalCashDecimal) ||
    !isNullableDecimal(value.totalFrankingDecimal) ||
    (value.currencyCode !== null && !isCurrencyCode(value.currencyCode)) ||
    !isNullableDecimal(value.fxRateToPortfolioDecimal) ||
    !isNullableString(value.fxRateSource) ||
    !isNullableString(value.sourceReference) ||
    typeof value.wasImported !== "boolean" ||
    !isIsoString(value.createdAt) ||
    (value.supersedesRef !== null && !isRefId(value.supersedesRef)) ||
    typeof value.supersededByDeletedRecord !== "boolean" ||
    totalsMode === perShareMode
  ) {
    return null;
  }
  if (refs.has(value.ref)) return null;
  refs.add(value.ref);
  return {
    ref: value.ref,
    securityRef: value.securityRef,
    paymentDate: value.paymentDate,
    sharesDecimal: (value.sharesDecimal as string | null) ?? null,
    dividendPerShareDecimal:
      (value.dividendPerShareDecimal as string | null) ?? null,
    frankingCreditPerShareDecimal:
      (value.frankingCreditPerShareDecimal as string | null) ?? null,
    totalCashDecimal: (value.totalCashDecimal as string | null) ?? null,
    totalFrankingDecimal: (value.totalFrankingDecimal as string | null) ?? null,
    currencyCode: (value.currencyCode as string | null) ?? null,
    fxRateToPortfolioDecimal:
      (value.fxRateToPortfolioDecimal as string | null) ?? null,
    fxRateSource: value.fxRateSource ?? null,
    sourceReference: value.sourceReference ?? null,
    wasImported: value.wasImported,
    createdAt: value.createdAt,
    supersedesRef: (value.supersedesRef as string | null) ?? null,
    supersededByDeletedRecord: value.supersededByDeletedRecord,
  };
}

// EXP-004: exported so `commitPortfolioBundleFinalize`'s standalone finalize
// request (a system-backup restore part carrying only these small
// supplementary arrays, sent as a SEPARATE HTTP request from the one that
// originally validated the whole bundle) can apply the SAME structural
// validation each row gets inside `validatePortfolioBundle` -- IMP-010B: a
// later request is never trusted merely because an earlier one validated
// similar-looking data.
export function validateDividendSecurityAssumption(
  value: unknown,
  securityRefs: ReadonlySet<string>,
): BundleDividendSecurityAssumption | null {
  if (
    !isPlainObject(value) ||
    typeof value.securityRef !== "string" ||
    !securityRefs.has(value.securityRef) ||
    !isNullableDecimal(value.dividendYieldPercentDecimal) ||
    !isNullableDecimal(value.frankingPercentDecimal) ||
    !isNullableDecimal(value.dividendGrowthPercentDecimal) ||
    (value.forceAssumption !== null &&
      typeof value.forceAssumption !== "boolean")
  ) {
    return null;
  }
  return {
    securityRef: value.securityRef,
    dividendYieldPercentDecimal:
      (value.dividendYieldPercentDecimal as string | null) ?? null,
    frankingPercentDecimal:
      (value.frankingPercentDecimal as string | null) ?? null,
    dividendGrowthPercentDecimal:
      (value.dividendGrowthPercentDecimal as string | null) ?? null,
    forceAssumption: (value.forceAssumption as boolean | null) ?? null,
  };
}

export function validateDividendPortfolioAssumption(
  value: unknown,
): BundleDividendPortfolioAssumption | null {
  if (
    !isPlainObject(value) ||
    !isNullableDecimal(value.valueGrowthPercentDecimal) ||
    !isNullableDecimal(value.portfolioDividendGrowthPercentDecimal)
  ) {
    return null;
  }
  return {
    valueGrowthPercentDecimal:
      (value.valueGrowthPercentDecimal as string | null) ?? null,
    portfolioDividendGrowthPercentDecimal:
      (value.portfolioDividendGrowthPercentDecimal as string | null) ?? null,
  };
}

export function validateDividendFyOverride(
  value: unknown,
): BundleDividendFyOverride | null {
  if (
    !isPlainObject(value) ||
    typeof value.financialYearEndingYear !== "number" ||
    !Number.isInteger(value.financialYearEndingYear) ||
    value.financialYearEndingYear < 1900 ||
    value.financialYearEndingYear > 2999 ||
    !isDecimalString(value.grossedAmountDecimal) ||
    !isNullableDecimal(value.frankingAmountDecimal)
  ) {
    return null;
  }
  return {
    financialYearEndingYear: value.financialYearEndingYear,
    grossedAmountDecimal: value.grossedAmountDecimal,
    frankingAmountDecimal:
      (value.frankingAmountDecimal as string | null) ?? null,
  };
}

export function validateDividendEventOverride(
  value: unknown,
  securityRefs: ReadonlySet<string>,
): BundleDividendEventOverride | null {
  if (
    !isPlainObject(value) ||
    typeof value.securityRef !== "string" ||
    !securityRefs.has(value.securityRef) ||
    typeof value.dividendEventId !== "string" ||
    value.dividendEventId.length === 0 ||
    !isNullableDecimal(value.sharesDecimal) ||
    !isNullableDecimal(value.dividendPerShareDecimal) ||
    !isNullableDecimal(value.frankingCreditPerShareDecimal) ||
    typeof value.exclude !== "boolean"
  ) {
    return null;
  }
  return {
    securityRef: value.securityRef,
    dividendEventId: value.dividendEventId,
    sharesDecimal: (value.sharesDecimal as string | null) ?? null,
    dividendPerShareDecimal:
      (value.dividendPerShareDecimal as string | null) ?? null,
    frankingCreditPerShareDecimal:
      (value.frankingCreditPerShareDecimal as string | null) ?? null,
    exclude: value.exclude,
  };
}

export function validateDividendImportFrankingOverride(
  value: unknown,
  securityRefs: ReadonlySet<string>,
  dividendRefs: ReadonlySet<string>,
): BundleDividendImportFrankingOverride | null {
  if (
    !isPlainObject(value) ||
    typeof value.securityRef !== "string" ||
    !securityRefs.has(value.securityRef) ||
    typeof value.dividendManualRecordRef !== "string" ||
    !dividendRefs.has(value.dividendManualRecordRef) ||
    !isDecimalString(value.frankingTotalDecimal)
  ) {
    return null;
  }
  return {
    securityRef: value.securityRef,
    dividendManualRecordRef: value.dividendManualRecordRef,
    frankingTotalDecimal: value.frankingTotalDecimal,
  };
}

export function validateWhatifScenario(
  value: unknown,
): BundleWhatifScenario | null {
  if (
    !isPlainObject(value) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.capitalRowsJson !== "string" ||
    typeof value.reinvestDividends !== "boolean" ||
    !isNullableDecimal(value.valueGrowthPercentDecimal) ||
    !isNullableDecimal(value.dividendGrowthPercentDecimal) ||
    !isIsoString(value.createdAt)
  ) {
    return null;
  }
  try {
    JSON.parse(value.capitalRowsJson);
  } catch {
    return null;
  }
  return {
    name: value.name,
    capitalRowsJson: value.capitalRowsJson,
    reinvestDividends: value.reinvestDividends,
    valueGrowthPercentDecimal:
      (value.valueGrowthPercentDecimal as string | null) ?? null,
    dividendGrowthPercentDecimal:
      (value.dividendGrowthPercentDecimal as string | null) ?? null,
    createdAt: value.createdAt,
  };
}

/**
 * True when the chain graph described by `dependencyOf` contains a cycle
 * (including a self-reference). An export can never produce one --
 * `supersede()`/`reverse()` only ever target a row that already exists and
 * is not itself superseded -- so a cycle means a corrupted or hand-edited
 * file. It must be rejected HERE, before any DB write: the commit path's
 * per-row "was the ancestor replayed first?" check fails closed for
 * transactions, but a dividend cycle would otherwise commit two rows that
 * supersede EACH OTHER, silently excluding both from evidence while
 * reporting the restore as a success (owner income disappearing with no
 * error is exactly what this codebase's honesty rules forbid).
 */
function hasChainCycle<T extends { ref: string }>(
  items: readonly T[],
  dependencyOf: (item: T) => string | null,
): boolean {
  const byRef = new Map(items.map((item) => [item.ref, item]));
  // Iterative walk per node with a global "known acyclic" memo, so the
  // whole check stays linear even for a long chain.
  const settled = new Set<string>();
  for (const start of items) {
    const path = new Set<string>();
    let current: T | undefined = start;
    while (current && !settled.has(current.ref)) {
      if (path.has(current.ref)) return true;
      path.add(current.ref);
      const dep = dependencyOf(current);
      current = dep === null ? undefined : byRef.get(dep);
    }
    for (const ref of path) settled.add(ref);
  }
  return false;
}

/**
 * Server-side sole validation authority (IMP-010B pattern) -- structural
 * validation ONLY (types, grammar, in-bundle referential integrity). This
 * deliberately does NOT check DB-side facts (does a referenced dividend
 * event still exist? does the owner's home currency match?) -- those are
 * commit-time checks in `app/portfolio-bundle-service.ts`, which needs a
 * `SqlClient`.
 */
export function validatePortfolioBundle(raw: unknown): BundleValidationResult {
  if (!isPlainObject(raw)) return fail("The bundle file is not readable.");
  if (raw.schemaVersion !== PORTFOLIO_BUNDLE_SCHEMA_VERSION) {
    return fail(
      `This bundle's format version (${String(raw.schemaVersion)}) is not supported by this app version. Expected version ${PORTFOLIO_BUNDLE_SCHEMA_VERSION}.`,
    );
  }
  if (!isIsoString(raw.exportedAt))
    return fail("The bundle's export date is invalid.");
  const portfolio = raw.portfolio;
  if (
    !isPlainObject(portfolio) ||
    typeof portfolio.name !== "string" ||
    portfolio.name.trim().length === 0 ||
    portfolio.name.length > 120 ||
    typeof portfolio.code !== "string" ||
    portfolio.code.trim().length === 0 ||
    !isCurrencyCode(portfolio.baseCurrencyCode) ||
    typeof portfolio.timezone !== "string" ||
    portfolio.timezone.trim().length === 0 ||
    typeof portfolio.accountingMethod !== "string" ||
    (portfolio.historyCompleteFrom !== null &&
      !isDateString(portfolio.historyCompleteFrom)) ||
    typeof portfolio.financialYearStartMonthAtExport !== "number" ||
    portfolio.financialYearStartMonthAtExport < 1 ||
    portfolio.financialYearStartMonthAtExport > 12 ||
    (portfolio.status !== undefined &&
      portfolio.status !== "active" &&
      portfolio.status !== "archived")
  ) {
    return fail("The bundle's portfolio identity is invalid.");
  }
  const settings = raw.portfolioSettings;
  if (
    !isPlainObject(settings) ||
    !isNullableString(settings.quoteStalenessPolicy)
  ) {
    return fail("The bundle's portfolio settings are invalid.");
  }
  if (!Array.isArray(raw.securities))
    return fail("The bundle's securities list is invalid.");
  const securityRefs = new Set<string>();
  const securities: BundleSecurityIdentity[] = [];
  for (const item of raw.securities) {
    const security = validateSecurity(item, securityRefs);
    if (!security)
      return fail("The bundle contains an invalid security entry.");
    securities.push(security);
  }
  const securityRefSet: ReadonlySet<string> = securityRefs;

  if (!Array.isArray(raw.transactions))
    return fail("The bundle's transactions list is invalid.");
  const txRefs = new Set<string>();
  const transactions: BundleTransaction[] = [];
  for (const item of raw.transactions) {
    const tx = validateTransaction(item, txRefs, securityRefSet);
    if (!tx) return fail("The bundle contains an invalid transaction entry.");
    transactions.push(tx);
  }
  for (const tx of transactions) {
    if (tx.reversesRef !== null && !txRefs.has(tx.reversesRef)) {
      return fail(
        "A transaction reverses a transaction the bundle does not contain.",
      );
    }
    if (tx.supersedesRef !== null && !txRefs.has(tx.supersedesRef)) {
      return fail(
        "A transaction supersedes a transaction the bundle does not contain.",
      );
    }
    if (tx.reversesRef !== null && tx.supersedesRef !== null) {
      return fail("A transaction cannot both reverse and supersede another.");
    }
  }
  if (hasChainCycle(transactions, (tx) => tx.reversesRef ?? tx.supersedesRef)) {
    return fail(
      "A transaction's reversal/supersession chain refers back to itself. This bundle is corrupt.",
    );
  }

  if (!Array.isArray(raw.dividendManualRecords)) {
    return fail("The bundle's dividend records list is invalid.");
  }
  const divRefs = new Set<string>();
  const dividendManualRecords: BundleDividendManualRecord[] = [];
  for (const item of raw.dividendManualRecords) {
    const record = validateDividendManualRecord(item, divRefs, securityRefSet);
    if (!record)
      return fail("The bundle contains an invalid dividend record entry.");
    dividendManualRecords.push(record);
  }
  for (const record of dividendManualRecords) {
    if (record.supersedesRef !== null && !divRefs.has(record.supersedesRef)) {
      return fail(
        "A dividend record supersedes a dividend record the bundle does not contain.",
      );
    }
  }
  if (hasChainCycle(dividendManualRecords, (record) => record.supersedesRef)) {
    return fail(
      "A dividend record's supersession chain refers back to itself. This bundle is corrupt.",
    );
  }

  if (!Array.isArray(raw.dividendSecurityAssumptions)) {
    return fail("The bundle's per-security assumptions list is invalid.");
  }
  const dividendSecurityAssumptions: BundleDividendSecurityAssumption[] = [];
  for (const item of raw.dividendSecurityAssumptions) {
    const parsed = validateDividendSecurityAssumption(item, securityRefSet);
    if (!parsed) {
      return fail(
        "The bundle contains an invalid per-security assumption entry.",
      );
    }
    dividendSecurityAssumptions.push(parsed);
  }

  let dividendPortfolioAssumption: BundleDividendPortfolioAssumption | null =
    null;
  if (raw.dividendPortfolioAssumption !== null) {
    const parsed = validateDividendPortfolioAssumption(
      raw.dividendPortfolioAssumption,
    );
    if (!parsed) return fail("The bundle's portfolio assumption is invalid.");
    dividendPortfolioAssumption = parsed;
  }

  if (!Array.isArray(raw.dividendFyOverrides)) {
    return fail("The bundle's FY override list is invalid.");
  }
  const dividendFyOverrides: BundleDividendFyOverride[] = [];
  for (const item of raw.dividendFyOverrides) {
    const parsed = validateDividendFyOverride(item);
    if (!parsed)
      return fail("The bundle contains an invalid FY override entry.");
    dividendFyOverrides.push(parsed);
  }

  if (!Array.isArray(raw.dividendEventOverrides)) {
    return fail("The bundle's dividend event override list is invalid.");
  }
  const dividendEventOverrides: BundleDividendEventOverride[] = [];
  for (const item of raw.dividendEventOverrides) {
    const parsed = validateDividendEventOverride(item, securityRefSet);
    if (!parsed) {
      return fail(
        "The bundle contains an invalid dividend event override entry.",
      );
    }
    dividendEventOverrides.push(parsed);
  }

  if (!Array.isArray(raw.dividendImportFrankingOverrides)) {
    return fail("The bundle's franking override list is invalid.");
  }
  const dividendImportFrankingOverrides: BundleDividendImportFrankingOverride[] =
    [];
  for (const item of raw.dividendImportFrankingOverrides) {
    const parsed = validateDividendImportFrankingOverride(
      item,
      securityRefSet,
      divRefs,
    );
    if (!parsed)
      return fail("The bundle contains an invalid franking override entry.");
    dividendImportFrankingOverrides.push(parsed);
  }

  if (!Array.isArray(raw.whatifScenarios)) {
    return fail("The bundle's what-if scenario list is invalid.");
  }
  const whatifScenarios: BundleWhatifScenario[] = [];
  for (const item of raw.whatifScenarios) {
    const parsed = validateWhatifScenario(item);
    if (!parsed)
      return fail("The bundle contains an invalid what-if scenario entry.");
    whatifScenarios.push(parsed);
  }

  const totalEntities =
    securities.length +
    transactions.length +
    dividendManualRecords.length +
    dividendSecurityAssumptions.length +
    dividendFyOverrides.length +
    dividendEventOverrides.length +
    dividendImportFrankingOverrides.length +
    whatifScenarios.length;
  if (totalEntities > MAX_BUNDLE_ENTITIES) {
    // B7 fix (reviewer): there is no merge/split-and-reassemble path for
    // this bundle format (a portfolio's transaction/dividend chains cannot
    // be safely partitioned across separate imports without breaking
    // supersession-chain topology) -- the earlier "split it and re-import
    // in parts" wording prescribed a remedy that does not exist. State the
    // truth instead.
    return fail(
      `The bundle contains ${totalEntities} entries, over the ${MAX_BUNDLE_ENTITIES} supported by this app version. This portfolio is too large to restore from a bundle in this version -- it is not restorable this way until that limit is raised.`,
    );
  }

  return {
    ok: true,
    bundle: {
      schemaVersion: 1,
      exportedAt: raw.exportedAt,
      portfolio: {
        name: portfolio.name,
        code: portfolio.code,
        baseCurrencyCode: portfolio.baseCurrencyCode,
        timezone: portfolio.timezone,
        accountingMethod: portfolio.accountingMethod,
        historyCompleteFrom:
          (portfolio.historyCompleteFrom as string | null) ?? null,
        financialYearStartMonthAtExport:
          portfolio.financialYearStartMonthAtExport,
        status:
          portfolio.status === "archived" ? "archived" : ("active" as const),
      },
      portfolioSettings: {
        quoteStalenessPolicy:
          (settings.quoteStalenessPolicy as string | null) ?? null,
      },
      securities,
      transactions,
      dividendManualRecords,
      dividendSecurityAssumptions,
      dividendPortfolioAssumption,
      dividendFyOverrides,
      dividendEventOverrides,
      dividendImportFrankingOverrides,
      whatifScenarios,
    },
  };
}

/**
 * Canonical bytes for fingerprinting -- `JSON.stringify` with SORTED keys at
 * every level, so two structurally-identical bundles (e.g. the same export
 * downloaded twice, or re-serialized after round-tripping through
 * `validatePortfolioBundle`) hash identically regardless of source key
 * order. Used for BOTH the idempotent-re-import natural key (`import_
 * batches.file_sha256`) and nothing else -- never a substitute for the
 * structural validation above.
 */
export function canonicalBundleJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (!HEX_RE.test(hex)) throw new Error("sha256Hex produced non-hex output");
  return hex;
}
