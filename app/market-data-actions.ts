import {
  createOwnedManualOverrideRepository,
  createMarketDataRefreshRepository,
  type SaveManualOverrideInput,
} from "../db/repositories/index.ts";
import { randomUUID } from "node:crypto";
import type { SqlClient } from "../db/repositories/sql-client.ts";

async function authenticatedSqlContext(portfolioId?: string) {
  const { getAuthenticatedSqlContext } = await import("./portfolio-actions.ts");
  return getAuthenticatedSqlContext(portfolioId);
}

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

export const UI_REFRESH_MAX_DAYS = 5;
export const UI_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;

export type MarketDataSqlContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

export function recentRefreshWindow(
  value: unknown,
  now = new Date(),
): { from: string; to: string } | null {
  if (value !== undefined && !validDate(value)) return null;
  const today = now.toISOString().slice(0, 10);
  const to = validDate(value) ? value : today;
  if (to > today) return null;
  const fromDate = new Date(`${to}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (UI_REFRESH_MAX_DAYS - 1));
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
  const context = await authenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  return requestMarketDataRefreshForContext(context, input);
}

export async function requestMarketDataRefreshForContext(
  context: MarketDataSqlContext,
  value: unknown,
  now = new Date(),
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
  const window = recentRefreshWindow(input.rangeTo, now);
  if (!window) {
    return { ok: false, status: 400, message: "The refresh date is invalid." };
  }
  if (input.rangeFrom !== undefined && !validDate(input.rangeFrom)) {
    return { ok: false, status: 400, message: "The refresh date is invalid." };
  }
  const rangeFrom = validDate(input.rangeFrom) ? input.rangeFrom : window.from;
  if (rangeFrom > window.to || rangeFrom < window.from) {
    return {
      ok: false,
      status: 400,
      message: `Refreshes are limited to the most recent ${UI_REFRESH_MAX_DAYS} days.`,
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

    const completedSince = new Date(
      now.getTime() - UI_REFRESH_COOLDOWN_MS,
    ).toISOString();
    const recent = await context.client.all<{ target_key: string }>(
      `SELECT DISTINCT job.target_key
         FROM market_data_refresh_jobs job
         JOIN security_provider_mappings spm
           ON spm.id = job.mapping_id
         JOIN portfolio_securities ps
           ON ps.security_id = spm.security_id
        WHERE ps.user_id = ? AND ps.portfolio_id = ?
          AND job.provider_id = 'yahoo-compatible'
          AND job.scope_key = 'deployment' AND job.target_kind = 'price'
          AND job.status = 'completed' AND job.completed_at >= ?`,
      [context.userId, portfolioId, completedSince],
    );
    const recentTargets = new Set(recent.map((row) => row.target_key));
    const eligibleTargets = targets.filter(
      (row) => !recentTargets.has(String(row.mapping_id)),
    );
    if (eligibleTargets.length === 0 && targets.length > 0) {
      return {
        ok: false,
        status: 429,
        message:
          "Quotes were refreshed recently. Try again after the cooldown.",
      };
    }
    const repository = createMarketDataRefreshRepository(context.client);
    const bucket = Math.floor(now.getTime() / UI_REFRESH_COOLDOWN_MS);
    const jobs = await Promise.all(
      eligibleTargets.map(async (row) => {
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
          idempotencyKey: `ui:${portfolioId}:${row.mapping_id}:${rangeFrom}:${window.to}:${bucket}`,
          now: now.toISOString(),
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
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const portfolioId =
    typeof input.portfolioId === "string" ? input.portfolioId.trim() : "";
  if (!portfolioId || portfolioId.length > 100) {
    return { ok: false, status: 400, message: "A portfolio is required." };
  }
  const context = await authenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  return saveManualOverrideForContext(context, input);
}

export async function saveManualOverrideForContext(
  context: MarketDataSqlContext,
  value: unknown,
): Promise<
  | { ok: true; override: unknown; invalidationId: string | null }
  | MarketDataActionFailure
> {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const portfolioId =
    typeof input.portfolioId === "string" ? input.portfolioId.trim() : "";
  const type = input.type;
  if (
    !portfolioId ||
    !["price", "fx_rate"].includes(String(type)) ||
    typeof input.targetKey !== "string" ||
    typeof input.effectiveFrom !== "string" ||
    typeof input.valueJson !== "string" ||
    typeof input.reason !== "string"
  ) {
    return { ok: false, status: 400, message: "Override fields are invalid." };
  }
  let valueRecord: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.valueJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("invalid value");
    }
    valueRecord = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, message: "Override value is invalid." };
  }

  let securityId: string | null = null;
  if (type === "price") {
    securityId =
      typeof input.securityId === "string" ? input.securityId.trim() : null;
    if (!securityId || input.targetKey !== securityId) {
      return {
        ok: false,
        status: 400,
        message: "The price target is not canonical.",
      };
    }
    const ownedTarget = await context.client.get<{ currency_code: string }>(
      `SELECT s.primary_currency_code AS currency_code
         FROM portfolio_securities ps
         JOIN securities s ON s.id = ps.security_id
        WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.security_id = ?
          AND ps.status IN ('held', 'watch') LIMIT 1`,
      [context.userId, portfolioId, securityId],
    );
    if (!ownedTarget) {
      return {
        ok: false,
        status: 404,
        message: "The requested quote target was not found.",
      };
    }
    if (valueRecord.currencyCode !== ownedTarget.currency_code) {
      return {
        ok: false,
        status: 400,
        message: "The price currency must match the security currency.",
      };
    }
  } else {
    const base = valueRecord.baseCurrencyCode;
    const quote = valueRecord.quoteCurrencyCode;
    if (
      typeof base !== "string" ||
      typeof quote !== "string" ||
      !/^[A-Z]{3}$/.test(base) ||
      !/^[A-Z]{3}$/.test(quote) ||
      base === quote ||
      input.targetKey !== `${base}/${quote}`
    ) {
      return {
        ok: false,
        status: 400,
        message: "The FX target and currencies are not canonical.",
      };
    }
    const pair = await context.client.get<{ id: string }>(
      `SELECT p.id
         FROM portfolios p
         JOIN currencies base ON base.code = ? AND base.is_active = 1
         JOIN currencies quote ON quote.code = ? AND quote.is_active = 1
        WHERE p.id = ? AND p.user_id = ? AND p.base_currency_code = ?
          AND EXISTS (
            SELECT 1 FROM portfolio_securities ps
            JOIN securities s ON s.id = ps.security_id
            WHERE ps.user_id = p.user_id AND ps.portfolio_id = p.id
              AND ps.status IN ('held', 'watch')
              AND s.primary_currency_code = ?
          ) LIMIT 1`,
      [base, quote, portfolioId, context.userId, quote, base],
    );
    if (!pair) {
      return {
        ok: false,
        status: 404,
        message: "The requested FX target was not found for this portfolio.",
      };
    }
  }
  const scope = {
    portfolioId,
    securityId,
    type,
    targetKey: input.targetKey,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    valueJson: input.valueJson,
    reason: input.reason,
    supersedesOverrideId:
      typeof input?.supersedesOverrideId === "string"
        ? input.supersedesOverrideId
        : null,
    requestId: context.requestId,
    calculationVersion: input?.calculationVersion,
  };
  try {
    const result = await createOwnedManualOverrideRepository(
      context.client,
    ).save(context.userId, scope as SaveManualOverrideInput);
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
  } catch {
    return {
      ok: false,
      status: 503,
      message: "The market-data override could not be saved.",
    };
  }
}

export async function removeManualOverrideAction(
  overrideId: string,
): Promise<
  | { ok: true; override: unknown; invalidationId: string | null }
  | MarketDataActionFailure
> {
  const context = await authenticatedSqlContext();
  if (!context.ok) return context;
  if (!overrideId || overrideId.length > 100) {
    return {
      ok: false,
      status: 400,
      message: "Override identifier is invalid.",
    };
  }
  try {
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
  } catch {
    return {
      ok: false,
      status: 503,
      message: "The market-data override could not be removed.",
    };
  }
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
  const context = await authenticatedSqlContext(portfolioId);
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
