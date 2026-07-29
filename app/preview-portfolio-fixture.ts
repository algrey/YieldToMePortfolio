import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseStrictVersionedCsvImport,
  SUPPORTED_IMPORT_PARSER_VERSION,
  type ImportIssue,
  type ImportIssueCode,
  type ImportParseResult,
  type ImportParseSuccess,
  type ImportTransactionKind,
} from "../domain/imports/index.ts";

export const PREVIEW_SAMPLE_PORTFOLIO_CSV_PATH = resolve(
  process.cwd(),
  "docs/Example_Portfolio.csv",
);

export type PreviewSecurityTrace = Readonly<{
  portfolio: string;
  symbol: string;
  name: string;
  displaySymbol: string | null;
  exchange: string | null;
  currency: string | null;
  quantity: string | null;
  definitionRowNumbers: readonly number[];
  transactionRowNumbers: readonly number[];
  sourceRowNumbers: readonly number[];
  issueCodes: readonly ImportIssueCode[];
}>;

export type PreviewCashRow = Readonly<{
  rowNumber: number;
  portfolio: string;
  symbol: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  cashEvent: "cash_deposit" | "cash_withdrawal";
  sharesOwned: string | null;
  tradeAtUtc: string | null;
  localTradeDate: string | null;
  issueCodes: readonly ImportIssueCode[];
}>;

export type PreviewTransactionRow = Readonly<{
  rowNumber: number;
  portfolio: string;
  symbol: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  transactionKind: ImportTransactionKind;
  sharesOwned: string | null;
  costPerShare: string | null;
  commission: string | null;
  tradeAtUtc: string | null;
  localTradeDate: string | null;
  issueCodes: readonly ImportIssueCode[];
}>;

export type PreviewPortfolio = Readonly<{
  name: string;
  currencies: readonly string[];
  openHoldings: readonly PreviewSecurityTrace[];
  closedSecurities: readonly PreviewSecurityTrace[];
  referenceSecurities: readonly PreviewSecurityTrace[];
  transactions: readonly PreviewTransactionRow[];
  cashRows: readonly PreviewCashRow[];
  issueCodes: readonly ImportIssueCode[];
}>;

export type PreviewFixtureExclusion = Readonly<{
  rowNumber: number;
  reason: "blank" | "unsupported";
  portfolio: string | null;
  symbol: string | null;
  issueCodes: readonly ImportIssueCode[];
}>;

export type PreviewPortfolioFixture = Readonly<{
  parserVersion: string;
  fileFingerprint: string;
  summary: ImportParseSuccess["summary"];
  currencies: readonly string[];
  portfolios: readonly PreviewPortfolio[];
  exclusions: readonly PreviewFixtureExclusion[];
  issues: readonly ImportIssue[];
}>;

export type PreviewPortfolioFixtureFailure = Readonly<{
  ok: false;
  code: "SOURCE_READ_FAILED" | "CSV_PARSE_FAILED" | "PROJECTION_EMPTY";
  message: string;
}>;

export type PreviewPortfolioFixtureResult =
  | { ok: true; fixture: PreviewPortfolioFixture }
  | PreviewPortfolioFixtureFailure;

type SecurityBucket = {
  portfolio: string;
  symbol: string;
  name: string | null;
  displaySymbol: string | null;
  exchange: string | null;
  currency: string | null;
  definitionRowNumbers: number[];
  transactionRowNumbers: number[];
  sourceRowNumbers: number[];
  issueCodes: Set<ImportIssueCode>;
  quantity: bigint;
};

type PortfolioBucket = {
  name: string;
  currencyCodes: Set<string>;
  securityBuckets: Map<string, SecurityBucket>;
  transactions: PreviewTransactionRow[];
  cashRows: PreviewCashRow[];
  issueCodes: Set<ImportIssueCode>;
};

function uniqueIssueCodes(
  issueCodes: Iterable<ImportIssueCode>,
): readonly ImportIssueCode[] {
  return [...new Set(issueCodes)].sort();
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function sortNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function createSecurityBucket(
  row: ImportParseSuccess["rows"][number],
): SecurityBucket | null {
  const portfolio = row.normalized.portfolio;
  const symbol = row.normalized.symbol;
  if (portfolio === null || symbol === null) {
    return null;
  }

  return {
    portfolio,
    symbol,
    name: row.normalized.name,
    displaySymbol: row.normalized.displaySymbol,
    exchange: row.normalized.exchange,
    currency: row.normalized.currency,
    definitionRowNumbers: [],
    transactionRowNumbers: [],
    sourceRowNumbers: [],
    issueCodes: new Set(row.issues.map((issue) => issue.code)),
    quantity: 0n,
  };
}

function createPortfolioBucket(name: string): PortfolioBucket {
  return {
    name,
    currencyCodes: new Set(),
    securityBuckets: new Map(),
    transactions: [],
    cashRows: [],
    issueCodes: new Set(),
  };
}

function toSecurityTrace(
  bucket: SecurityBucket,
  quantity: string | null,
): PreviewSecurityTrace {
  return {
    portfolio: bucket.portfolio,
    symbol: bucket.symbol,
    name: bucket.name ?? bucket.symbol,
    displaySymbol: bucket.displaySymbol,
    exchange: bucket.exchange,
    currency: bucket.currency,
    quantity,
    definitionRowNumbers: sortNumbers(bucket.definitionRowNumbers),
    transactionRowNumbers: sortNumbers(bucket.transactionRowNumbers),
    sourceRowNumbers: sortNumbers(bucket.sourceRowNumbers),
    issueCodes: uniqueIssueCodes(bucket.issueCodes),
  };
}

function finalizeSecurityBucket(bucket: SecurityBucket): PreviewSecurityTrace {
  if (bucket.transactionRowNumbers.length === 0) {
    return toSecurityTrace(bucket, null);
  }

  if (bucket.quantity <= 0n) {
    return toSecurityTrace(bucket, null);
  }

  return toSecurityTrace(bucket, bucket.quantity.toString());
}

function buildPreviewFixture(
  parseResult: ImportParseSuccess,
): PreviewPortfolioFixtureResult {
  const portfolioBuckets = new Map<string, PortfolioBucket>();
  const exclusions: PreviewFixtureExclusion[] = [];
  const currencies = new Set<string>();

  for (const row of parseResult.rows) {
    if (row.kind === "blank" || row.kind === "unsupported") {
      exclusions.push({
        rowNumber: row.rowNumber,
        reason: row.kind,
        portfolio: row.normalized.portfolio,
        symbol: row.normalized.symbol,
        issueCodes: uniqueIssueCodes(row.issues.map((issue) => issue.code)),
      });
      continue;
    }

    const portfolioName = row.normalized.portfolio;
    if (portfolioName === null) {
      exclusions.push({
        rowNumber: row.rowNumber,
        reason: "unsupported",
        portfolio: null,
        symbol: row.normalized.symbol,
        issueCodes: uniqueIssueCodes(row.issues.map((issue) => issue.code)),
      });
      continue;
    }

    const portfolioBucket =
      portfolioBuckets.get(portfolioName) ??
      createPortfolioBucket(portfolioName);
    portfolioBuckets.set(portfolioName, portfolioBucket);
    portfolioBucket.issueCodes = new Set([
      ...portfolioBucket.issueCodes,
      ...row.issues.map((issue) => issue.code),
    ]);

    if (row.normalized.currency !== null) {
      currencies.add(row.normalized.currency);
      portfolioBucket.currencyCodes.add(row.normalized.currency);
    }

    if (row.kind === "transaction" && row.normalized.cashEvent !== null) {
      portfolioBucket.cashRows.push({
        rowNumber: row.rowNumber,
        portfolio: portfolioName,
        symbol: row.normalized.symbol ?? "AUD=CASH",
        name: row.normalized.name,
        exchange: row.normalized.exchange,
        currency: row.normalized.currency,
        cashEvent: row.normalized.cashEvent,
        sharesOwned: row.normalized.sharesOwned,
        tradeAtUtc: row.normalized.tradeAtUtc,
        localTradeDate: row.normalized.localTradeDate,
        issueCodes: uniqueIssueCodes(row.issues.map((issue) => issue.code)),
      });
      continue;
    }

    const symbol = row.normalized.symbol;
    if (symbol === null) {
      exclusions.push({
        rowNumber: row.rowNumber,
        reason: "unsupported",
        portfolio: portfolioName,
        symbol: null,
        issueCodes: uniqueIssueCodes(row.issues.map((issue) => issue.code)),
      });
      continue;
    }

    const securityBucket =
      portfolioBucket.securityBuckets.get(symbol) ?? createSecurityBucket(row);
    if (securityBucket === null) {
      exclusions.push({
        rowNumber: row.rowNumber,
        reason: "unsupported",
        portfolio: portfolioName,
        symbol,
        issueCodes: uniqueIssueCodes(row.issues.map((issue) => issue.code)),
      });
      continue;
    }

    portfolioBucket.securityBuckets.set(symbol, securityBucket);
    securityBucket.sourceRowNumbers.push(row.rowNumber);
    securityBucket.issueCodes = new Set([
      ...securityBucket.issueCodes,
      ...row.issues.map((issue) => issue.code),
    ]);

    if (row.normalized.name !== null && securityBucket.name === null) {
      securityBucket.name = row.normalized.name;
    }
    if (
      row.normalized.displaySymbol !== null &&
      securityBucket.displaySymbol === null
    ) {
      securityBucket.displaySymbol = row.normalized.displaySymbol;
    }
    if (row.normalized.exchange !== null && securityBucket.exchange === null) {
      securityBucket.exchange = row.normalized.exchange;
    }
    if (row.normalized.currency !== null && securityBucket.currency === null) {
      securityBucket.currency = row.normalized.currency;
    }

    if (row.kind === "definition") {
      securityBucket.definitionRowNumbers.push(row.rowNumber);
    } else {
      securityBucket.transactionRowNumbers.push(row.rowNumber);
      const shares = BigInt(row.normalized.sharesOwned ?? "0");
      securityBucket.quantity +=
        row.normalized.type === "sell" ? -shares : shares;

      portfolioBucket.transactions.push({
        rowNumber: row.rowNumber,
        portfolio: portfolioName,
        symbol,
        name: row.normalized.name,
        exchange: row.normalized.exchange,
        currency: row.normalized.currency,
        transactionKind: row.normalized.type ?? "buy",
        sharesOwned: row.normalized.sharesOwned,
        costPerShare: row.normalized.costPerShare,
        commission: row.normalized.commission,
        tradeAtUtc: row.normalized.tradeAtUtc,
        localTradeDate: row.normalized.localTradeDate,
        issueCodes: uniqueIssueCodes(row.issues.map((issue) => issue.code)),
      });
    }
  }

  if (portfolioBuckets.size === 0) {
    return {
      ok: false,
      code: "PROJECTION_EMPTY",
      message: "The supplied CSV did not produce any preview portfolios.",
    };
  }

  const portfolios = [...portfolioBuckets.values()]
    .sort((left, right) => compareStrings(left.name, right.name))
    .map<PreviewPortfolio>((bucket) => {
      const securities = [...bucket.securityBuckets.values()]
        .sort((left, right) => {
          const holdingRank = left.transactionRowNumbers.length > 0 ? 0 : 1;
          const otherRank = right.transactionRowNumbers.length > 0 ? 0 : 1;
          const byRank = holdingRank - otherRank;
          return byRank !== 0
            ? byRank
            : compareStrings(left.symbol, right.symbol);
        })
        .map((securityBucket) => finalizeSecurityBucket(securityBucket));

      const openHoldings = securities.filter(
        (security) => security.quantity !== null,
      );
      const closedSecurities = securities.filter(
        (security) =>
          security.quantity === null &&
          security.transactionRowNumbers.length > 0,
      );
      const referenceSecurities = securities.filter(
        (security) => security.transactionRowNumbers.length === 0,
      );

      return {
        name: bucket.name,
        currencies: [...bucket.currencyCodes].sort(compareStrings),
        openHoldings,
        closedSecurities,
        referenceSecurities,
        transactions: [...bucket.transactions].sort(
          (left, right) => left.rowNumber - right.rowNumber,
        ),
        cashRows: [...bucket.cashRows].sort(
          (left, right) => left.rowNumber - right.rowNumber,
        ),
        issueCodes: uniqueIssueCodes(bucket.issueCodes),
      };
    });

  return {
    ok: true,
    fixture: {
      parserVersion: parseResult.parserVersion,
      fileFingerprint: parseResult.fileFingerprint,
      summary: parseResult.summary,
      currencies: [...currencies].sort(compareStrings),
      portfolios,
      exclusions: exclusions.sort(
        (left, right) => left.rowNumber - right.rowNumber,
      ),
      issues: parseResult.issues,
    },
  };
}

export function createPreviewPortfolioFixtureFromParseResult(
  parseResult: ImportParseResult,
): PreviewPortfolioFixtureResult {
  if (!parseResult.ok) {
    return {
      ok: false,
      code: "CSV_PARSE_FAILED",
      message: parseResult.message,
    };
  }

  return buildPreviewFixture(parseResult);
}

export async function loadPreviewPortfolioFixtureFromCsv(
  csv: string | Uint8Array,
): Promise<PreviewPortfolioFixtureResult> {
  const parseResult = await parseStrictVersionedCsvImport(csv);
  return createPreviewPortfolioFixtureFromParseResult(parseResult);
}

export async function loadPreviewPortfolioFixture(): Promise<PreviewPortfolioFixtureResult> {
  try {
    const csv = await readFile(PREVIEW_SAMPLE_PORTFOLIO_CSV_PATH, "utf8");
    return await loadPreviewPortfolioFixtureFromCsv(csv);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The preview CSV fixture could not be read.";
    return {
      ok: false,
      code: "SOURCE_READ_FAILED",
      message,
    };
  }
}

export { SUPPORTED_IMPORT_PARSER_VERSION };
