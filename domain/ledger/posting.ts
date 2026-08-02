import { randomUUID } from "node:crypto";
import {
  validateCashLedgerEntry,
  validateLedgerTransaction,
  type CashLedgerEntryType,
  type LedgerSourceType,
  type LedgerTransactionInput,
  type LedgerTransactionType,
} from "./event-validation.ts";

type Decimal = { coefficient: bigint; scale: number };

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const SOURCE_TYPES = new Set<LedgerSourceType>([
  "manual",
  "csv_import",
  "broker_sync",
  "provider",
  "system",
]);

export type LedgerPostingInput = LedgerTransactionInput & {
  portfolioId: string;
  idempotencyKey: string;
  tradeAt: string;
  localTradeDate: string;
  settlementDate?: string | null;
  currencyCode: string;
  fxRateSource?: string | null;
  fxObservedAt?: string | null;
  sourceReference?: string | null;
  calculationVersion?: number;
  requestId: string;
};

export type PreparedLedgerPosting = {
  transactionId: string;
  cashEntryId: string | null;
  cashAccountId: string | null;
  cashEffectDecimal: string | null;
  grossAmountDecimal: string | null;
  sourceReference: string;
  calculationVersion: number;
};

export type PostingValidationFailure = {
  ok: false;
  reason:
    | "invalid_input"
    | "invalid_idempotency_key"
    | "invalid_date"
    | "invalid_source"
    | "gross_mismatch"
    | "cash_effect_invalid";
};

export type PostingPreparation =
  { ok: true; posting: PreparedLedgerPosting } | PostingValidationFailure;

function parseDecimal(value: string): Decimal | null {
  if (!DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function power(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function normalize(value: Decimal): string {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * power(scale - left.scale) +
      right.coefficient * power(scale - right.scale),
    scale,
  };
}

function subtract(left: Decimal, right: Decimal): string {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * power(scale - left.scale);
  const rightCoefficient = right.coefficient * power(scale - right.scale);
  if (leftCoefficient >= rightCoefficient) {
    return normalize({
      coefficient: leftCoefficient - rightCoefficient,
      scale,
    });
  }
  return `-${normalize({ coefficient: rightCoefficient - leftCoefficient, scale })}`;
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return {
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  };
}

function equal(left: Decimal, right: Decimal): boolean {
  const scale = Math.max(left.scale, right.scale);
  return (
    left.coefficient * power(scale - left.scale) ===
    right.coefficient * power(scale - right.scale)
  );
}

function positive(value: string | null): Decimal | null {
  const parsed = value === null ? null : parseDecimal(value);
  return parsed && parsed.coefficient > 0n ? parsed : null;
}

function zeroOrPositive(value: string): Decimal | null {
  const parsed = parseDecimal(value);
  return parsed && parsed.coefficient >= 0n ? parsed : null;
}

function isCalendarDate(value: string): boolean {
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

function cashEntryType(
  type: LedgerTransactionType,
): CashLedgerEntryType | null {
  if (type === "buy") return "cash_withdrawal";
  if (type === "sell") return "cash_deposit";
  return type === "split" ? null : type;
}

function cashEffect(
  input: LedgerPostingInput,
  gross: string | null,
): string | null {
  const amount = gross === null ? null : zeroOrPositive(gross);
  const fee = zeroOrPositive(input.feeAmountDecimal);
  const tax = zeroOrPositive(input.taxAmountDecimal);
  if (!amount || !fee || !tax) return null;
  if (input.type === "buy") {
    return `-${normalize(add(add(amount, fee), tax))}`;
  }
  if (input.type === "sell") {
    return subtract(amount, add(fee, tax));
  }
  if (
    input.type === "cash_withdrawal" ||
    input.type === "fee" ||
    input.type === "tax"
  ) {
    return `-${normalize(amount)}`;
  }
  if (input.type === "cash_deposit" || input.type === "opening_balance") {
    return normalize(amount);
  }
  return null;
}

export function prepareLedgerPosting(
  input: LedgerPostingInput,
  transactionId = randomUUID(),
): PostingPreparation {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    return { ok: false, reason: "invalid_idempotency_key" };
  }
  if (!isCalendarDate(input.localTradeDate) || !input.tradeAt) {
    return { ok: false, reason: "invalid_date" };
  }
  if (!SOURCE_TYPES.has(input.sourceType)) {
    return { ok: false, reason: "invalid_source" };
  }
  const validation = validateLedgerTransaction(input);
  if (!validation.ok) return { ok: false, reason: "invalid_input" };

  let grossAmountDecimal = input.grossAmountDecimal;
  if (input.type === "buy" || input.type === "sell") {
    const quantity = positive(input.quantityDecimal);
    const price = positive(input.unitPriceDecimal);
    if (!quantity || !price) return { ok: false, reason: "invalid_input" };
    const calculated = normalize(multiply(quantity, price));
    if (
      grossAmountDecimal !== null &&
      (!parseDecimal(grossAmountDecimal) ||
        !equal(parseDecimal(grossAmountDecimal)!, parseDecimal(calculated)!))
    ) {
      return { ok: false, reason: "gross_mismatch" };
    }
    grossAmountDecimal = calculated;
  }

  const effect = cashEffect(input, grossAmountDecimal);
  const entryType = cashEntryType(input.type);
  if (
    entryType &&
    (!effect ||
      !validateCashLedgerEntry({ type: entryType, signedAmountDecimal: effect })
        .ok)
  ) {
    return { ok: false, reason: "cash_effect_invalid" };
  }

  return {
    ok: true,
    posting: {
      transactionId,
      cashEntryId: effect === null ? null : randomUUID(),
      cashAccountId:
        effect === null
          ? null
          : `cash:${input.portfolioId}:${input.currencyCode}`,
      cashEffectDecimal: effect,
      grossAmountDecimal,
      sourceReference: input.sourceReference ?? input.idempotencyKey,
      calculationVersion: input.calculationVersion ?? 1,
    },
  };
}
