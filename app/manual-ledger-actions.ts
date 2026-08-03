import {
  createManualLedgerMutationKeyRepository,
  createOwnedLedgerRepository,
  type ManualLedgerMutationPurpose,
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

async function authenticatedContext(portfolioId: string) {
  const { getAuthenticatedSqlContext } = await import("./portfolio-actions.ts");
  return getAuthenticatedSqlContext(portfolioId);
}

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
    case "oversell":
      return "The sale exceeds the available FIFO quantity at its business time.";
    case "inventory_limit":
      return "This security has too much ledger history for one safe manual mutation. Rebuild or narrow the correction before retrying.";
    case "concurrent_change":
      return "The security ledger changed while this request was checked. Retry with the same server-issued key.";
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

export type ManualLedgerActionContext = Readonly<{
  client: SqlClient;
  userId: string;
  requestId: string;
}>;

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

export async function postManualLedgerWithContext(
  context: ManualLedgerActionContext,
  portfolioId: string,
  value: ManualLedgerFormValue,
  correctionTarget?: string,
): Promise<ManualLedgerActionResult> {
  const idempotencyKey =
    typeof value.idempotencyKey === "string" ? value.idempotencyKey : "";
  const purpose: ManualLedgerMutationPurpose = correctionTarget
    ? "supersede"
    : "create";
  const authorization = await createManualLedgerMutationKeyRepository(
    context.client,
  ).authorize(
    context.userId,
    portfolioId,
    idempotencyKey,
    purpose,
    correctionTarget ?? null,
  );
  if (!authorization) {
    return actionFailure(
      409,
      "A valid server-issued ledger key is required for this exact operation.",
      idempotencyKey,
    );
  }
  const parsed = parseManualLedgerForm(
    value,
    portfolioId,
    context.requestId,
    idempotencyKey,
  );
  if (!parsed.ok) return actionFailure(400, parsed.message, idempotencyKey);
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
        authorization,
      )
    : await repository.post(context.userId, parsed.input, authorization);
  if (!mutation.ok) {
    return actionFailure(
      mutation.reason === "not_found"
        ? 404
        : mutation.reason === "conflict" || mutation.reason === "oversell"
          ? 409
          : mutation.reason === "atomic_failure" ||
              mutation.reason === "concurrent_change" ||
              mutation.reason === "inventory_limit"
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
  const context = await authenticatedContext(portfolioId);
  if (!context.ok) return actionFailure(context.status, context.message, "");
  return postManualLedgerWithContext(
    context,
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
  const context = await authenticatedContext(portfolioId);
  if (!context.ok) return actionFailure(context.status, context.message, "");
  return postManualLedgerWithContext(
    context,
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
  const key =
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).idempotencyKey === "string"
      ? String((value as Record<string, unknown>).idempotencyKey)
      : "";
  const context = await authenticatedContext(portfolioId);
  if (!context.ok) return actionFailure(context.status, context.message, key);
  return reverseManualLedgerWithContext(
    context,
    portfolioId,
    transactionId,
    key,
  );
}

export async function reverseManualLedgerWithContext(
  context: ManualLedgerActionContext,
  portfolioId: string,
  transactionId: string,
  key: string,
): Promise<ManualLedgerActionResult> {
  const authorization = await createManualLedgerMutationKeyRepository(
    context.client,
  ).authorize(context.userId, portfolioId, key, "reverse", transactionId);
  if (!authorization) {
    return actionFailure(
      409,
      "A valid server-issued correction key is required for this exact reversal.",
      key,
    );
  }
  const base = await baseCurrency(context.client, portfolioId, context.userId);
  if (!base) return actionFailure(404, "Portfolio was not found.", key);
  const mutation = await createOwnedLedgerRepository(context.client).reverse(
    context.userId,
    portfolioId,
    transactionId,
    key,
    context.requestId,
    authorization,
  );
  if (!mutation.ok) {
    return actionFailure(
      mutation.reason === "not_found"
        ? 404
        : mutation.reason === "conflict" || mutation.reason === "oversell"
          ? 409
          : mutation.reason === "atomic_failure" ||
              mutation.reason === "concurrent_change" ||
              mutation.reason === "inventory_limit"
            ? 503
            : 400,
      messageFor(mutation.reason),
      key,
    );
  }
  const input = inputFromTransaction(
    mutation.transaction,
    portfolioId,
    context.requestId,
    key,
  );
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

export async function issueManualLedgerKeyAction(
  portfolioId: string,
  value: unknown,
): Promise<
  | { ok: true; idempotencyKey: string; expiresAt: string }
  | { ok: false; status: 400 | 401 | 404 | 409 | 503; message: string }
> {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const purpose = input.purpose;
  const targetTransactionId =
    typeof input.targetTransactionId === "string"
      ? input.targetTransactionId
      : null;
  if (
    purpose !== "create" &&
    purpose !== "reverse" &&
    purpose !== "supersede"
  ) {
    return {
      ok: false,
      status: 400,
      message: "A valid key purpose is required.",
    };
  }
  const context = await authenticatedContext(portfolioId);
  if (!context.ok) return context;
  try {
    const issued = await createManualLedgerMutationKeyRepository(
      context.client,
    ).issue(context.userId, portfolioId, purpose, targetTransactionId);
    return issued
      ? {
          ok: true,
          idempotencyKey: issued.key,
          expiresAt: issued.expiresAt,
        }
      : { ok: false, status: 404, message: "The ledger target was not found." };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "A ledger retry key could not be issued.",
    };
  }
}
