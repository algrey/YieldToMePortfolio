export type LedgerTransactionType =
  | "buy"
  | "sell"
  | "cash_deposit"
  | "cash_withdrawal"
  | "fee"
  | "tax"
  | "split"
  | "opening_balance";

export type LedgerSourceType =
  "manual" | "csv_import" | "broker_sync" | "provider" | "system";

export type CashLedgerEntryType =
  | "cash_deposit"
  | "cash_withdrawal"
  | "fee"
  | "tax"
  | "opening_balance"
  | "split";

export type LedgerTransactionInput = {
  type: LedgerTransactionType;
  portfolioSecurityId: string | null;
  quantityDecimal: string | null;
  unitPriceDecimal: string | null;
  grossAmountDecimal: string | null;
  feeAmountDecimal: string;
  taxAmountDecimal: string;
  fxRateToBaseDecimal: string | null;
  sourceType: LedgerSourceType;
};

export type LedgerValidationIssueCode =
  | "invalid-decimal"
  | "missing-security"
  | "missing-quantity"
  | "non-positive-quantity"
  | "missing-unit-price"
  | "non-positive-unit-price"
  | "missing-amount"
  | "missing-fx-rate"
  | "non-positive-fx-rate"
  | "unexpected-security";

export type LedgerValidationIssue = {
  field: keyof LedgerTransactionInput;
  code: LedgerValidationIssueCode;
};

export type LedgerValidationResult =
  { ok: true } | { ok: false; issues: LedgerValidationIssue[] };

export type CashLedgerEntryInput = {
  type: CashLedgerEntryType;
  signedAmountDecimal: string;
};

export type CashLedgerValidationResult =
  | { ok: true }
  | { ok: false; reason: "invalid-decimal" | "zero-amount" | "wrong-sign" };

const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function isCanonicalDecimal(value: string): boolean {
  return CANONICAL_DECIMAL.test(value) && !value.endsWith(".");
}

function isPositiveDecimal(value: string | null): boolean {
  return value !== null && isCanonicalDecimal(value) && value !== "0";
}

function addDecimalIssue(
  issues: LedgerValidationIssue[],
  field: keyof LedgerTransactionInput,
  value: string | null,
): void {
  if (value !== null && !isCanonicalDecimal(value)) {
    issues.push({ field, code: "invalid-decimal" });
  }
}

function addNonNegativeDecimalIssue(
  issues: LedgerValidationIssue[],
  field: keyof LedgerTransactionInput,
  value: string,
): void {
  if (!isCanonicalDecimal(value)) {
    issues.push({ field, code: "invalid-decimal" });
  }
}

export function validateLedgerTransaction(
  input: LedgerTransactionInput,
): LedgerValidationResult {
  const issues: LedgerValidationIssue[] = [];

  addDecimalIssue(issues, "quantityDecimal", input.quantityDecimal);
  addDecimalIssue(issues, "unitPriceDecimal", input.unitPriceDecimal);
  addDecimalIssue(issues, "grossAmountDecimal", input.grossAmountDecimal);
  addNonNegativeDecimalIssue(
    issues,
    "feeAmountDecimal",
    input.feeAmountDecimal,
  );
  addNonNegativeDecimalIssue(
    issues,
    "taxAmountDecimal",
    input.taxAmountDecimal,
  );
  addDecimalIssue(issues, "fxRateToBaseDecimal", input.fxRateToBaseDecimal);

  const securityEvent =
    input.type === "buy" || input.type === "sell" || input.type === "split";
  if (securityEvent && input.portfolioSecurityId === null) {
    issues.push({ field: "portfolioSecurityId", code: "missing-security" });
  }
  if (!securityEvent && input.portfolioSecurityId !== null) {
    issues.push({ field: "portfolioSecurityId", code: "unexpected-security" });
  }

  if (input.type === "buy" || input.type === "sell") {
    if (input.quantityDecimal === null) {
      issues.push({ field: "quantityDecimal", code: "missing-quantity" });
    } else if (
      isCanonicalDecimal(input.quantityDecimal) &&
      !isPositiveDecimal(input.quantityDecimal)
    ) {
      issues.push({ field: "quantityDecimal", code: "non-positive-quantity" });
    }
    if (input.unitPriceDecimal === null) {
      issues.push({ field: "unitPriceDecimal", code: "missing-unit-price" });
    } else if (
      isCanonicalDecimal(input.unitPriceDecimal) &&
      !isPositiveDecimal(input.unitPriceDecimal)
    ) {
      issues.push({
        field: "unitPriceDecimal",
        code: "non-positive-unit-price",
      });
    }
  }

  if (input.type === "split") {
    if (input.quantityDecimal === null) {
      issues.push({ field: "quantityDecimal", code: "missing-quantity" });
    } else if (
      isCanonicalDecimal(input.quantityDecimal) &&
      !isPositiveDecimal(input.quantityDecimal)
    ) {
      issues.push({ field: "quantityDecimal", code: "non-positive-quantity" });
    }
    if (input.unitPriceDecimal === null) {
      issues.push({ field: "unitPriceDecimal", code: "missing-unit-price" });
    } else if (
      isCanonicalDecimal(input.unitPriceDecimal) &&
      !isPositiveDecimal(input.unitPriceDecimal)
    ) {
      issues.push({
        field: "unitPriceDecimal",
        code: "non-positive-unit-price",
      });
    }
  }

  if (
    input.type === "cash_deposit" ||
    input.type === "cash_withdrawal" ||
    input.type === "fee" ||
    input.type === "tax" ||
    input.type === "opening_balance"
  ) {
    if (input.grossAmountDecimal === null) {
      issues.push({ field: "grossAmountDecimal", code: "missing-amount" });
    } else if (
      isCanonicalDecimal(input.grossAmountDecimal) &&
      !isPositiveDecimal(input.grossAmountDecimal)
    ) {
      issues.push({
        field: "grossAmountDecimal",
        code: "non-positive-quantity",
      });
    }
  }

  if (
    input.fxRateToBaseDecimal !== null &&
    isCanonicalDecimal(input.fxRateToBaseDecimal) &&
    !isPositiveDecimal(input.fxRateToBaseDecimal)
  ) {
    issues.push({ field: "fxRateToBaseDecimal", code: "non-positive-fx-rate" });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function validateCashLedgerEntry(
  input: CashLedgerEntryInput,
): CashLedgerValidationResult {
  const unsignedAmount = input.signedAmountDecimal.replace(/^-/, "");
  if (!isCanonicalDecimal(unsignedAmount)) {
    return { ok: false, reason: "invalid-decimal" };
  }

  if (unsignedAmount === "0") {
    return { ok: false, reason: "zero-amount" };
  }

  const negative = input.signedAmountDecimal.startsWith("-");
  const positiveType =
    input.type === "cash_deposit" || input.type === "opening_balance";
  const negativeType =
    input.type === "cash_withdrawal" ||
    input.type === "fee" ||
    input.type === "tax";

  if ((positiveType && negative) || (negativeType && !negative)) {
    return { ok: false, reason: "wrong-sign" };
  }

  return { ok: true };
}
