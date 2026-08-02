import {
  createOwnedManualOverrideRepository,
  type SaveManualOverrideInput,
} from "../db/repositories/index.ts";
import { getAuthenticatedSqlContext } from "./portfolio-actions";

type MarketDataActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
};

export async function saveManualOverrideAction(
  value: unknown,
): Promise<
  | { ok: true; override: unknown; invalidationId: string | null }
  | MarketDataActionFailure
> {
  const input = value as Record<string, unknown>;
  const portfolioId =
    typeof input?.portfolioId === "string" ? input.portfolioId : undefined;
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  const type = input?.type;
  const scope = {
    portfolioId: portfolioId ?? null,
    securityId: typeof input?.securityId === "string" ? input.securityId : null,
    type,
    targetKey: input?.targetKey,
    effectiveFrom: input?.effectiveFrom,
    effectiveTo: input?.effectiveTo ?? null,
    valueJson: input?.valueJson,
    reason: input?.reason,
    supersedesOverrideId:
      typeof input?.supersedesOverrideId === "string"
        ? input.supersedesOverrideId
        : null,
    requestId: context.requestId,
    calculationVersion: input?.calculationVersion,
  };
  if (
    !["price", "fx_rate", "security_mapping", "transaction_fx"].includes(
      String(type),
    ) ||
    typeof scope.targetKey !== "string" ||
    typeof scope.effectiveFrom !== "string" ||
    typeof scope.valueJson !== "string" ||
    typeof scope.reason !== "string"
  ) {
    return { ok: false, status: 400, message: "Override fields are invalid." };
  }
  const result = await createOwnedManualOverrideRepository(context.client).save(
    context.userId,
    scope as SaveManualOverrideInput,
  );
  if (result.ok) return result;
  return {
    ok: false,
    status:
      result.reason === "not_found" || result.reason === "ownership"
        ? 404
        : result.reason === "invalid_input"
          ? 400
          : result.reason === "conflict"
            ? 409
            : 503,
    message:
      result.reason === "conflict"
        ? "The override interval or supersession is no longer available."
        : "The market-data override could not be saved.",
  };
}

export async function removeManualOverrideAction(
  overrideId: string,
): Promise<
  | { ok: true; override: unknown; invalidationId: string | null }
  | MarketDataActionFailure
> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  if (!overrideId || overrideId.length > 100) {
    return {
      ok: false,
      status: 400,
      message: "Override identifier is invalid.",
    };
  }
  const result = await createOwnedManualOverrideRepository(
    context.client,
  ).remove(context.userId, overrideId, context.requestId);
  if (result.ok) return result;
  return {
    ok: false,
    status:
      result.reason === "not_found"
        ? 404
        : result.reason === "conflict"
          ? 409
          : 503,
    message:
      result.reason === "conflict"
        ? "This override has already been removed."
        : "The market-data override could not be removed.",
  };
}
