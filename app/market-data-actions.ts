import {
  createOwnedManualOverrideRepository,
  createMarketDataRefreshRepository,
  type SaveManualOverrideInput,
} from "../db/repositories/index.ts";
import { randomUUID } from "node:crypto";
import { getAuthenticatedSqlContext } from "./portfolio-actions";

type MarketDataActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 429 | 503;
  message: string;
};

type RefreshJobSummary = {
  id: string;
  targetKind: "price" | "fx";
  targetKey: string;
  rangeFrom: string;
  rangeTo: string;
  status: "queued" | "running" | "completed" | "failed";
};

export type ManualOverrideHistoryItem = {
  id: string;
  type: "price" | "fx_rate" | "security_mapping" | "transaction_fx";
  targetKey: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  status: "active" | "superseded" | "revoked";
  supersedesOverrideId: string | null;
  createdAt: string;
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

function recentRefreshWindow(
  value: unknown,
): { from: string; to: string } | null {
  if (value !== undefined && !validDate(value)) return null;
  const to = validDate(value) ? value : new Date().toISOString().slice(0, 10);
  const fromDate = new Date(`${to}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 4);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

function actionMessage(reason: string): string {
  return reason === "not_found"
    ? "The requested quote target was not found."
    : "Market data refresh is temporarily unavailable.";
}

export async function requestMarketDataRefreshAction(
  value: unknown,
): Promise<{ ok: true; jobs: RefreshJobSummary[] } | MarketDataActionFailure> {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const portfolioId =
    typeof input.portfolioId === "string" ? input.portfolioId.trim() : "";
  if (!portfolioId || portfolioId.length > 100) {
    return { ok: false, status: 400, message: "A portfolio is required." };
  }
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  const window = recentRefreshWindow(input.rangeTo);
  if (!window) {
    return { ok: false, status: 400, message: "The refresh date is invalid." };
  }
  if (input.rangeFrom !== undefined && !validDate(input.rangeFrom)) {
    return { ok: false, status: 400, message: "The refresh date is invalid." };
  }
  const rangeFrom = validDate(input.rangeFrom) ? input.rangeFrom : window.from;
  if (rangeFrom > window.to) {
    return {
      ok: false,
      status: 400,
      message: "The refresh interval is invalid.",
    };
  }

  try {
    const rows = await context.client.all<Record<string, unknown>>(
      `SELECT ps.id AS portfolio_security_id, ps.security_id,
              spm.id AS mapping_id
       FROM portfolio_securities ps
       JOIN security_provider_mappings spm
         ON spm.security_id = ps.security_id
        AND spm.provider_id = 'yahoo-compatible'
        AND spm.status = 'verified'
        AND spm.valid_from <= ?
        AND (spm.valid_to IS NULL OR spm.valid_to >= ?)
       WHERE ps.user_id = ? AND ps.portfolio_id = ?
         AND ps.status IN ('held', 'watch') AND ps.security_id IS NOT NULL
       ORDER BY ps.id ASC, spm.valid_from DESC, spm.id ASC`,
      [window.to, window.to, context.userId, portfolioId],
    );
    const targetId =
      typeof input.portfolioSecurityId === "string"
        ? input.portfolioSecurityId.trim()
        : null;
    const targets = rows
      .filter((row, index, all) => {
        if (targetId && String(row.portfolio_security_id) !== targetId)
          return false;
        return (
          all.findIndex(
            (candidate) =>
              String(candidate.portfolio_security_id) ===
              String(row.portfolio_security_id),
          ) === index
        );
      })
      .filter(
        (
          row,
        ): row is Record<string, unknown> & {
          security_id: string;
          mapping_id: string;
        } =>
          typeof row.security_id === "string" &&
          typeof row.mapping_id === "string",
      );
    if (targetId && targets.length === 0) {
      return {
        ok: false,
        status: 404,
        message: "The requested quote target was not found.",
      };
    }

    const repository = createMarketDataRefreshRepository(context.client);
    const idempotencyKey =
      typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
        ? input.idempotencyKey.trim().slice(0, 160)
        : context.requestId;
    const jobs = await Promise.all(
      targets.map(async (row, index) => {
        const job = await repository.request({
          id: randomUUID(),
          providerId: "yahoo-compatible",
          targetKind: "price",
          targetKey: String(row.mapping_id),
          mappingId: String(row.mapping_id),
          securityId: String(row.security_id),
          scope: { kind: "deployment", userId: null },
          rangeFrom,
          rangeTo: window.to,
          idempotencyKey: `${idempotencyKey}:${index}`,
          now: new Date().toISOString(),
        });
        return {
          id: job.id,
          targetKind: job.targetKind,
          targetKey: job.targetKey,
          rangeFrom: job.rangeFrom,
          rangeTo: job.rangeTo,
          status: job.status,
        };
      }),
    );
    return { ok: true, jobs };
  } catch (error) {
    if (error instanceof Error && error.message.includes("provider")) {
      return { ok: false, status: 503, message: actionMessage("provider") };
    }
    return { ok: false, status: 503, message: actionMessage("database") };
  }
}

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

export async function listManualOverrideAction(
  portfolioId: string,
  targetKey?: string,
): Promise<
  { ok: true; overrides: ManualOverrideHistoryItem[] } | MarketDataActionFailure
> {
  if (!portfolioId || portfolioId.length > 100) {
    return { ok: false, status: 400, message: "A portfolio is required." };
  }
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  try {
    const overrides = await createOwnedManualOverrideRepository(
      context.client,
    ).list(context.userId, targetKey?.trim() || undefined);
    return {
      ok: true,
      overrides: overrides.map((override): ManualOverrideHistoryItem => ({
        id: override.id,
        type: override.type,
        targetKey: override.targetKey,
        effectiveFrom: override.effectiveFrom,
        effectiveTo: override.effectiveTo,
        reason: override.reason,
        status: override.status,
        supersedesOverrideId: override.supersedesOverrideId,
        createdAt: override.createdAt,
      })),
    };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "The correction history is temporarily unavailable.",
    };
  }
}
