import { isValidFinancialYearStartMonth } from "../domain/calculations/financial-year.ts";

export type PortfolioActionInput = {
  code: string;
  name: string;
  timezone: string;
  historyCompleteFrom?: string | null;
};

export type PortfolioActionValidation =
  { ok: true; input: PortfolioActionInput } | { ok: false; message: string };

export function validatePortfolioActionInput(
  value: unknown,
): PortfolioActionValidation {
  if (typeof value !== "object" || value === null) {
    return { ok: false, message: "Portfolio details are required." };
  }
  const input = value as Record<string, unknown>;
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const timezone =
    typeof input.timezone === "string" ? input.timezone.trim() : "";
  const historyCompleteFrom =
    input.historyCompleteFrom === null ||
    input.historyCompleteFrom === undefined
      ? null
      : typeof input.historyCompleteFrom === "string"
        ? input.historyCompleteFrom.trim()
        : null;

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(code)) {
    return {
      ok: false,
      message: "Use a short letters-and-numbers portfolio code.",
    };
  }
  if (name.length < 1 || name.length > 120) {
    return {
      ok: false,
      message: "Portfolio name must be 1 to 120 characters.",
    };
  }
  if (timezone.length < 1 || timezone.length > 80) {
    return { ok: false, message: "A portfolio timezone is required." };
  }
  if (
    historyCompleteFrom !== null &&
    !/^\d{4}-\d{2}-\d{2}$/.test(historyCompleteFrom)
  ) {
    return { ok: false, message: "History start must be a calendar date." };
  }

  return { ok: true, input: { code, name, timezone, historyCompleteFrom } };
}

export function validateHomeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

export function validateHoldingCurrencyView(
  value: unknown,
): "native" | "home" | null {
  return value === "native" || value === "home" ? value : null;
}

// MKT-009B: mirrors `validateHoldingCurrencyView` exactly -- a closed enum,
// never a silent default for a malformed value.
export function validatePriceSourcePreference(
  value: unknown,
): "yahoo_authenticated" | "yahoo_anonymous" | "sharesight_delayed" | null {
  return value === "yahoo_authenticated" ||
    value === "yahoo_anonymous" ||
    value === "sharesight_delayed"
    ? value
    : null;
}

/** Validates a financial-year start month at the request boundary: an
 * integer 1-12, never a silent default when the input is malformed. */
export function validateFinancialYearStartMonth(value: unknown): number | null {
  return isValidFinancialYearStartMonth(value) ? value : null;
}
