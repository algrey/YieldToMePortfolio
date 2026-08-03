import { randomUUID } from "node:crypto";
import {
  addDecimal,
  compareDecimal,
  parseDecimal,
} from "../domain/calculations/decimal.ts";
import {
  createOwnedLedgerRepository,
  loadOwnedPortfolioInspection,
  type LedgerMutationResult,
  type LedgerMutationSuccess,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  prepareLedgerPosting,
  type LedgerPostingInput,
} from "../domain/ledger/posting.ts";
import {
  parseManualLedgerForm,
  previewFromPrepared,
  type ManualLedgerFormValue,
  type ManualLedgerPreview,
  type ManualLedgerType,
} from "./manual-ledger-contract.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";

type ManualLedgerFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
  idempotencyKey: string;
  preview?: ManualLedgerPreview;
};

export type ManualLedgerActionResult =
  | {
      ok: true;
      idempotencyKey: string;
      preview: ManualLedgerPreview;
      mutation: LedgerMutationSuccess;
    }
  | ManualLedgerFailure;

function actionFailure(
  status: ManualLedgerFailure["status"],
  message: string,
  idempotencyKey: string,
  preview?: ManualLedgerPreview,
): ManualLedgerFailure {
  return { ok: false, status, message, idempotencyKey, preview };
}

function messageFor(reason: string): string {
  switch (reason) {
    case "not_found":
      return "The owned portfolio or security was not found.";
    case "conflict":
      return "This ledger request conflicts with an existing fact or correction.";
    case "gross_mismatch":
      return "Gross amount must equal quantity multiplied by unit price.";
    case "invalid_date":
      return "The business date or exact trade time is invalid.";
    case "cash_effect_invalid":
      return "The cash impact could not be represented as an exact non-zero amount.";
    case "atomic_failure":
      return "The ledger write was not completed. Retry with the same server-issued key.";
    default:
      return "The manual ledger entry is invalid.";
  }
}

async function baseCurrency(
  client: SqlClient,
  portfolioId: string,
  userId: string,
): Promise<string | null> {
  const row = await client.get<{ base_currency_code: string }>(
    "SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ? AND status = 'active' LIMIT 1",
    [portfolioId, userId],
  );
  return row?.base_currency_code ?? null;
}

async function rejectOversell(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  securityId: string,
  quantity: string,
): Promise<boolean> {
  const inspection = await loadOwnedPortfolioInspection(
    client,
    userId,
    portfolioId,
  );
  if (!inspection) return true;
  try {
    let available = parseDecimal("0");
    for (const lot of inspection.lots) {
      if (lot.securityId !== securityId || lot.status !== "open") continue;
      available = addDecimal(available, parseDecimal(lot.openQuantityDecimal));
    }
    return compareDecimal(parseDecimal(quantity), available) > 0;
  } catch {
    return true;
  }
}

function inputFromTransaction(
  transaction: LedgerMutationSuccess["transaction"],
  portfolioId: string,
  requestId: string,
  idempotencyKey: string,
): LedgerPostingInput | null {
  const type = transaction.type;
  if (
    type !== "buy" &&
    type !== "sell" &&
    type !== "cash_deposit" &&
    type !== "cash_withdrawal" &&
    type !== "fee" &&
    type !== "tax" &&
    type !== "split"
  ) {
    return null;
  }
  return {
    portfolioId,
    type,
    portfolioSecurityId: transaction.portfolioSecurityId,
    quantityDecimal: transaction.quantityDecimal,
    unitPriceDecimal: transaction.unitPriceDecimal,
    grossAmountDecimal: transaction.grossAmountDecimal,
    feeAmountDecimal: transaction.feeAmountDecimal,
    taxAmountDecimal: transaction.taxAmountDecimal,
    fxRateToBaseDecimal: transaction.fxRateToBaseDecimal,
    sourceType: "system",
    idempotencyKey,
    tradeAt: transaction.tradeAt,
    localTradeDate: transaction.localTradeDate,
    settlementDate: transaction.settlementDate,
    currencyCode: transaction.currencyCode,
    fxRateSource: transaction.fxRateSource,
    fxObservedAt: transaction.fxObservedAt,
    requestId,
  };
}

async function postManualLedger(
  portfolioId: string,
  value: ManualLedgerFormValue,
  correctionTarget?: string,
): Promise<ManualLedgerActionResult> {
  const requestedKey =
    typeof value.idempotencyKey === "string" ? value.idempotencyKey : "";
  const idempotencyKey = requestedKey.startsWith("manual-ledger:")
    ? requestedKey
    : `manual-ledger:${randomUUID()}`;
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok)
    return actionFailure(context.status, context.message, idempotencyKey);
  const parsed = parseManualLedgerForm(
    value,
    portfolioId,
    context.requestId,
    idempotencyKey,
  );
  if (!parsed.ok) return actionFailure(400, parsed.message, idempotencyKey);
  if (
    parsed.type === "sell" &&
    parsed.input.portfolioSecurityId !== null &&
    parsed.input.quantityDecimal !== null &&
    !(await context.client.get<{ id: string }>(
      "SELECT id FROM transactions WHERE user_id = ? AND portfolio_id = ? AND idempotency_key = ? LIMIT 1",
      [context.userId, portfolioId, idempotencyKey],
    )) &&
    (await rejectOversell(
      context.client,
      context.userId,
      portfolioId,
      parsed.input.portfolioSecurityId,
      parsed.input.quantityDecimal,
    ))
  ) {
    return actionFailure(
      409,
      "The sale exceeds the currently available FIFO quantity.",
      idempotencyKey,
    );
  }
  const base = await baseCurrency(context.client, portfolioId, context.userId);
  if (!base)
    return actionFailure(404, "Portfolio was not found.", idempotencyKey);
  const prepared = prepareLedgerPosting(parsed.input);
  if (!prepared.ok)
    return actionFailure(400, messageFor(prepared.reason), idempotencyKey);
  const preview = previewFromPrepared(
    parsed.type,
    parsed.input,
    prepared.posting,
    base,
  );
  const repository = createOwnedLedgerRepository(context.client);
  const mutation: LedgerMutationResult = correctionTarget
    ? await repository.supersede(
        context.userId,
        portfolioId,
        correctionTarget,
        parsed.input,
      )
    : await repository.post(context.userId, parsed.input);
  if (!mutation.ok) {
    return actionFailure(
      mutation.reason === "not_found"
        ? 404
        : mutation.reason === "conflict"
          ? 409
          : mutation.reason === "atomic_failure"
            ? 503
            : 400,
      messageFor(mutation.reason),
      idempotencyKey,
      preview,
    );
  }
  return { ok: true, idempotencyKey, preview, mutation };
}

export async function createManualLedgerAction(
  portfolioId: string,
  value: unknown,
): Promise<ManualLedgerActionResult> {
  return postManualLedger(
    portfolioId,
    typeof value === "object" && value !== null
      ? (value as ManualLedgerFormValue)
      : {},
  );
}

export async function supersedeManualLedgerAction(
  portfolioId: string,
  transactionId: string,
  value: unknown,
): Promise<ManualLedgerActionResult> {
  return postManualLedger(
    portfolioId,
    typeof value === "object" && value !== null
      ? (value as ManualLedgerFormValue)
      : {},
    transactionId,
  );
}

export async function reverseManualLedgerAction(
  portfolioId: string,
  transactionId: string,
  value: unknown,
): Promise<ManualLedgerActionResult> {
  const requestedKey =
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).idempotencyKey === "string"
      ? String((value as Record<string, unknown>).idempotencyKey)
      : `manual-ledger:${randomUUID()}`;
  const key = requestedKey.startsWith("manual-ledger:")
    ? requestedKey
    : `manual-ledger:${randomUUID()}`;
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return actionFailure(context.status, context.message, key);
  const mutation = await createOwnedLedgerRepository(context.client).reverse(
    context.userId,
    portfolioId,
    transactionId,
    key,
    context.requestId,
  );
  if (!mutation.ok) {
    return actionFailure(
      mutation.reason === "not_found"
        ? 404
        : mutation.reason === "conflict"
          ? 409
          : mutation.reason === "atomic_failure"
            ? 503
            : 400,
      messageFor(mutation.reason),
      key,
    );
  }
  const base = await baseCurrency(context.client, portfolioId, context.userId);
  const input = base
    ? inputFromTransaction(
        mutation.transaction,
        portfolioId,
        context.requestId,
        key,
      )
    : null;
  const prepared = input ? prepareLedgerPosting(input) : null;
  if (!base || !input || !prepared || !prepared.ok) {
    return actionFailure(
      503,
      "The correction was stored but its impact preview is unavailable.",
      key,
    );
  }
  const type = input.type as ManualLedgerType;
  const impact = mutation.cashEntry?.signedAmountDecimal ?? null;
  return {
    ok: true,
    idempotencyKey: key,
    preview: {
      ...previewFromPrepared(type, input, prepared.posting, base),
      cashEffectDecimal: impact,
      cashImpact:
        impact === null
          ? "none"
          : impact.startsWith("-")
            ? "withdrawal"
            : "deposit",
    },
    mutation,
  };
}
