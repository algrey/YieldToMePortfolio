import type {
  LedgerPostingInput,
  PreparedLedgerPosting,
} from "../domain/ledger/posting.ts";

export const MANUAL_LEDGER_TYPES = [
  "buy",
  "sell",
  "cash_deposit",
  "cash_withdrawal",
  "fee",
  "tax",
  "split",
] as const;

export type ManualLedgerType = (typeof MANUAL_LEDGER_TYPES)[number];

export type ManualLedgerFormValue = Readonly<{
  type?: unknown;
  portfolioSecurityId?: unknown;
  quantityDecimal?: unknown;
  unitPriceDecimal?: unknown;
  grossAmountDecimal?: unknown;
  feeAmountDecimal?: unknown;
  taxAmountDecimal?: unknown;
  currencyCode?: unknown;
  tradeAt?: unknown;
  localTradeDate?: unknown;
  settlementDate?: unknown;
  fxRateToBaseDecimal?: unknown;
  fxRateSource?: unknown;
  fxObservedAt?: unknown;
  sourceReference?: unknown;
  idempotencyKey?: unknown;
}>;

export type ManualLedgerPreview = Readonly<{
  type: ManualLedgerType;
  businessDate: string;
  currencyCode: string;
  grossAmountDecimal: string | null;
  cashEffectDecimal: string | null;
  cashImpact: "deposit" | "withdrawal" | "none";
  fxStatus: "available" | "unavailable" | "not-required";
}>;

export type ManualLedgerParseResult =
  | { ok: true; input: LedgerPostingInput; type: ManualLedgerType }
  | { ok: false; message: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  const result = text(value);
  return result === "" ? null : result;
}

function manualType(value: unknown): ManualLedgerType | null {
  if (typeof value !== "string") return null;
  return (MANUAL_LEDGER_TYPES as readonly string[]).includes(value)
    ? (value as ManualLedgerType)
    : null;
}

function calendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function dateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return false;
  const canonical = parsed.toISOString();
  return canonical === value || canonical.replace(".000Z", "Z") === value;
}

export function parseManualLedgerForm(
  value: ManualLedgerFormValue,
  portfolioId: string,
  requestId: string,
  idempotencyKey: string,
): ManualLedgerParseResult {
  const type = manualType(value.type);
  const currencyCode = text(value.currencyCode).toUpperCase();
  const localTradeDate = text(value.localTradeDate);
  const tradeAt = text(value.tradeAt);
  if (!type) {
    return {
      ok: false,
      message:
        "Only buy, sell, cash, fee, tax, and split entries are supported. Transfers and dividends are unavailable.",
    };
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    return {
      ok: false,
      message: "A three-letter transaction currency is required.",
    };
  }
  const settlementDate = nullableText(value.settlementDate);
  if (
    !calendarDate(localTradeDate) ||
    !dateTime(tradeAt) ||
    (settlementDate !== null && !calendarDate(settlementDate))
  ) {
    return {
      ok: false,
      message: "A business date and exact trade time are required.",
    };
  }

  const security = nullableText(value.portfolioSecurityId);
  const securityEvent = type === "buy" || type === "sell" || type === "split";
  if (securityEvent && !security) {
    return { ok: false, message: "Select an owned portfolio security." };
  }
  if (!securityEvent && security) {
    return {
      ok: false,
      message: "Cash and charge entries cannot select a security.",
    };
  }

  const input: LedgerPostingInput = {
    portfolioId,
    type,
    portfolioSecurityId: security,
    quantityDecimal: securityEvent ? nullableText(value.quantityDecimal) : null,
    unitPriceDecimal: securityEvent
      ? nullableText(value.unitPriceDecimal)
      : null,
    grossAmountDecimal: securityEvent
      ? type === "split"
        ? null
        : nullableText(value.grossAmountDecimal)
      : nullableText(value.grossAmountDecimal),
    feeAmountDecimal: text(value.feeAmountDecimal) || "0",
    taxAmountDecimal: text(value.taxAmountDecimal) || "0",
    fxRateToBaseDecimal: nullableText(value.fxRateToBaseDecimal),
    sourceType: "manual",
    idempotencyKey,
    tradeAt,
    localTradeDate,
    settlementDate,
    currencyCode,
    fxRateSource: nullableText(value.fxRateSource),
    fxObservedAt: nullableText(value.fxObservedAt),
    sourceReference: nullableText(value.sourceReference),
    requestId,
  };
  if (
    input.fxRateToBaseDecimal !== null &&
    (input.fxRateSource === null || input.fxObservedAt === null)
  ) {
    return {
      ok: false,
      message:
        "An FX source and observation time are required with an FX rate.",
    };
  }
  return { ok: true, input, type };
}

export function previewFromPrepared(
  type: ManualLedgerType,
  input: LedgerPostingInput,
  prepared: PreparedLedgerPosting,
  baseCurrencyCode: string,
): ManualLedgerPreview {
  const cashEffect = prepared.cashEffectDecimal;
  return {
    type,
    businessDate: input.localTradeDate,
    currencyCode: input.currencyCode,
    grossAmountDecimal: prepared.grossAmountDecimal,
    cashEffectDecimal: cashEffect,
    cashImpact:
      cashEffect === null
        ? "none"
        : cashEffect.startsWith("-")
          ? "withdrawal"
          : "deposit",
    fxStatus:
      input.currencyCode === baseCurrencyCode
        ? "not-required"
        : input.fxRateToBaseDecimal === null
          ? "unavailable"
          : "available",
  };
}
