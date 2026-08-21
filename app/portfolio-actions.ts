import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import {
  decodeAccessJwtBase64Url,
  type VerifiedAccessPrincipal,
} from "../domain/auth/access-jwt";
import { resolveAuthenticatedRequestContext } from "../domain/auth/request-context";
import {
  createOwnedPortfolioRepository,
  createOwnedUserSettingsRepository,
} from "../db/repositories/owned-portfolios";
import { VERIFIED_PRINCIPAL_HEADER } from "../domain/auth/verified-principal-header";
import {
  validateFinancialYearStartMonth,
  validateHomeCurrency,
  validateHoldingCurrencyView,
  validatePortfolioActionInput,
  validatePriceSourcePreference,
} from "./portfolio-action-contract";

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
};
type PrincipalResult =
  | { ok: true; principal: VerifiedAccessPrincipal; requestId: string }
  | ActionFailure;

function isPrincipal(value: unknown): value is VerifiedAccessPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.tokenType === "app" &&
    typeof candidate.issuer === "string" &&
    typeof candidate.audience === "string" &&
    typeof candidate.subject === "string" &&
    (candidate.email === null || typeof candidate.email === "string") &&
    (candidate.issuedAt === null || typeof candidate.issuedAt === "number") &&
    typeof candidate.notBefore === "number" &&
    typeof candidate.expiresAt === "number" &&
    typeof candidate.keyId === "string"
  );
}

async function readPrincipal(): Promise<PrincipalResult> {
  const requestHeaders = await headers();
  const encoded = requestHeaders.get(VERIFIED_PRINCIPAL_HEADER);
  if (!encoded)
    return {
      ok: false,
      status: 401,
      message: "Authentication is unavailable.",
    };
  try {
    const value = decodeAccessJwtBase64Url(encoded);
    if (!isPrincipal(value)) throw new Error("invalid principal");
    return { ok: true, principal: value, requestId: randomUUID() };
  } catch {
    return {
      ok: false,
      status: 401,
      message: "Authentication is unavailable.",
    };
  }
}

export async function getAuthenticatedSqlContext(portfolioId?: string) {
  const principal = await readPrincipal();
  if (!principal.ok) return principal;
  try {
    const { getSqlClient } = await import("../db/d1-sql-client");
    const client = await getSqlClient();
    const context = await resolveAuthenticatedRequestContext(
      client,
      principal.principal,
      portfolioId,
      { requestId: principal.requestId },
    );
    if (!context.ok)
      return {
        ok: false as const,
        status: 404 as const,
        message: "Portfolio was not found.",
      };
    return {
      ok: true as const,
      client,
      userId: context.context.user.id,
      requestId: principal.requestId,
    };
  } catch (error) {
    // UI-023B follow-up: this catch deliberately collapses every failure
    // into one honest 503 message, but the silent version made a local
    // schema-drift outage (missing migration column) undiagnosable without
    // editing code. Log server-side; the response payload stays generic.
    console.error("getAuthenticatedSqlContext failed", error);
    return {
      ok: false as const,
      status: 503 as const,
      message: "Portfolio data is temporarily unavailable.",
    };
  }
}

/** Lifecycle retries need verified identity and D1 access without restoring workspace access. */
export async function getVerifiedPrincipalSqlContext() {
  const principal = await readPrincipal();
  if (!principal.ok) return principal;
  try {
    const { getSqlClient } = await import("../db/d1-sql-client");
    return {
      ok: true as const,
      client: await getSqlClient(),
      principal: principal.principal,
      requestId: principal.requestId,
    };
  } catch {
    return {
      ok: false as const,
      status: 503 as const,
      message: "Account lifecycle data is temporarily unavailable.",
    };
  }
}

export async function createPortfolioAction(value: unknown) {
  const validation = validatePortfolioActionInput(value);
  if (!validation.ok)
    return {
      ok: false as const,
      status: 400 as const,
      message: validation.message,
    };
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  try {
    const portfolio = await createOwnedPortfolioRepository(
      context.client,
      undefined,
      { requestId: context.requestId },
    ).create(context.userId, validation.input);
    return portfolio
      ? { ok: true as const, portfolio }
      : {
          ok: false as const,
          status: 404 as const,
          message: "User settings were not found.",
        };
  } catch {
    return {
      ok: false as const,
      status: 409 as const,
      message: "Portfolio could not be created.",
    };
  }
}

export async function renamePortfolioAction(
  portfolioId: string,
  value: unknown,
) {
  const input = value as Record<string, unknown>;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const timezone =
    typeof input?.timezone === "string" ? input.timezone.trim() : undefined;
  const expectedVersion =
    typeof input?.expectedVersion === "number" ? input.expectedVersion : NaN;
  if (
    name.length < 1 ||
    name.length > 120 ||
    !Number.isInteger(expectedVersion)
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      message: "A valid name and portfolio version are required.",
    };
  }
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  try {
    const result = await createOwnedPortfolioRepository(
      context.client,
      undefined,
      { requestId: context.requestId },
    ).rename(context.userId, portfolioId, { name, timezone, expectedVersion });
    return result.ok
      ? result
      : {
          ...result,
          status:
            result.reason === "version_conflict"
              ? (409 as const)
              : (404 as const),
          message: "Portfolio could not be renamed.",
        };
  } catch {
    return {
      ok: false as const,
      status: 409 as const,
      message: "Portfolio could not be renamed.",
    };
  }
}

async function setPortfolioStatus(
  portfolioId: string,
  expectedVersion: unknown,
  action: "archive" | "restore",
) {
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion))
    return {
      ok: false as const,
      status: 400 as const,
      message: "A valid portfolio version is required.",
    };
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  try {
    const repository = createOwnedPortfolioRepository(
      context.client,
      undefined,
      { requestId: context.requestId },
    );
    const result = await repository[action](context.userId, portfolioId, {
      expectedVersion,
    });
    return result.ok
      ? result
      : {
          ...result,
          status:
            result.reason === "version_conflict"
              ? (409 as const)
              : (404 as const),
          message: "Portfolio status could not be changed.",
        };
  } catch {
    return {
      ok: false as const,
      status: 409 as const,
      message: "Portfolio status could not be changed.",
    };
  }
}

export const archivePortfolioAction = (portfolioId: string, version: unknown) =>
  setPortfolioStatus(portfolioId, version, "archive");
export const restorePortfolioAction = (portfolioId: string, version: unknown) =>
  setPortfolioStatus(portfolioId, version, "restore");

export async function changeHomeCurrencyAction(value: unknown) {
  const input = value as Record<string, unknown>;
  const currency = validateHomeCurrency(input?.homeCurrencyCode);
  const expectedVersion = input?.expectedVersion;
  if (
    !currency ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion)
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      message: "A valid currency and settings version are required.",
    };
  }
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  try {
    const result = await createOwnedUserSettingsRepository(
      context.client,
      undefined,
      { requestId: context.requestId },
    ).requestHomeCurrencyRebase(context.userId, {
      homeCurrencyCode: currency,
      expectedVersion,
    });
    return result.ok
      ? result
      : {
          ...result,
          status:
            result.reason === "version_conflict"
              ? (409 as const)
              : (404 as const),
          message: "Home currency could not be changed.",
        };
  } catch {
    return {
      ok: false as const,
      status: 409 as const,
      message: "Home currency could not be changed.",
    };
  }
}

export async function changeHoldingCurrencyViewAction(value: unknown) {
  const input = value as Record<string, unknown>;
  const view = validateHoldingCurrencyView(input?.view);
  const expectedVersion = input?.expectedVersion;
  if (
    !view ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion)
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      message: "A valid display view and settings version are required.",
    };
  }
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  try {
    const result = await createOwnedUserSettingsRepository(
      context.client,
      undefined,
      { requestId: context.requestId },
    ).setHoldingCurrencyView(context.userId, {
      view,
      expectedVersion,
    });
    return result.ok
      ? result
      : {
          ...result,
          status:
            result.reason === "version_conflict"
              ? (409 as const)
              : (404 as const),
          message: "Display view could not be changed.",
        };
  } catch {
    return {
      ok: false as const,
      status: 409 as const,
      message: "Display view could not be changed.",
    };
  }
}

export async function changeFinancialYearStartMonthAction(value: unknown) {
  const input = value as Record<string, unknown>;
  const financialYearStartMonth = validateFinancialYearStartMonth(
    input?.financialYearStartMonth,
  );
  const expectedVersion = input?.expectedVersion;
  if (
    financialYearStartMonth === null ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion)
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      message:
        "A financial-year start month between 1 and 12, and a valid settings version, are required.",
    };
  }
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  try {
    const result = await createOwnedUserSettingsRepository(
      context.client,
      undefined,
      { requestId: context.requestId },
    ).setFinancialYearStartMonth(context.userId, {
      financialYearStartMonth,
      expectedVersion,
    });
    return result.ok
      ? result
      : {
          ...result,
          status:
            result.reason === "version_conflict"
              ? (409 as const)
              : (404 as const),
          message: "Financial-year start month could not be changed.",
        };
  } catch {
    return {
      ok: false as const,
      status: 409 as const,
      message: "Financial-year start month could not be changed.",
    };
  }
}

// MKT-009B: mirrors `changeFinancialYearStartMonthAction` exactly.
export async function changePriceSourcePreferenceAction(value: unknown) {
  const input = value as Record<string, unknown>;
  const priceSourcePreference = validatePriceSourcePreference(
    input?.priceSourcePreference,
  );
  const expectedVersion = input?.expectedVersion;
  if (
    !priceSourcePreference ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion)
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      message:
        "A valid price-source preference and settings version are required.",
    };
  }
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  try {
    const result = await createOwnedUserSettingsRepository(
      context.client,
      undefined,
      { requestId: context.requestId },
    ).setPriceSourcePreference(context.userId, {
      priceSourcePreference,
      expectedVersion,
    });
    return result.ok
      ? result
      : {
          ...result,
          status:
            result.reason === "version_conflict"
              ? (409 as const)
              : (404 as const),
          message: "Price-source preference could not be changed.",
        };
  } catch {
    return {
      ok: false as const,
      status: 409 as const,
      message: "Price-source preference could not be changed.",
    };
  }
}
