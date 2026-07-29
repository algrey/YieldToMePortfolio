import { headers } from "next/headers";
import {
  decodeAccessJwtBase64Url,
  type VerifiedAccessPrincipal,
} from "../domain/auth/access-jwt";
import { resolveAuthenticatedRequestContext } from "../domain/auth/request-context";
import { VERIFIED_PRINCIPAL_HEADER } from "../domain/auth/verified-principal-header";
import { createOwnedPortfolioRepository } from "../db/repositories/owned-portfolios";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios";
import { createOwnedWorkspace } from "./owned-workspace";
import type { OwnedWorkspace } from "./components/portfolio-shell";

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

function unavailableWorkspace(message: string): OwnedWorkspace {
  return {
    status: "unavailable",
    message,
    activePortfolio: null,
    portfolios: [],
  };
}

export async function loadAuthenticatedWorkspace(
  requestedPortfolioId?: string,
): Promise<OwnedWorkspace> {
  const principalHeader = (await headers()).get(VERIFIED_PRINCIPAL_HEADER);
  if (!principalHeader) {
    return unavailableWorkspace("Authentication is unavailable.");
  }

  let principal: VerifiedAccessPrincipal;
  try {
    const decoded = decodeAccessJwtBase64Url(principalHeader);
    if (!isPrincipal(decoded)) throw new Error("Invalid verified principal.");
    principal = decoded;
  } catch {
    return unavailableWorkspace("Authentication is unavailable.");
  }

  try {
    const { getSqlClient } = await import("../db/d1-sql-client");
    const client = await getSqlClient();
    const result = await resolveAuthenticatedRequestContext(
      client,
      principal,
      requestedPortfolioId,
    );
    const portfolioRecords = result.ok
      ? await createOwnedPortfolioRepository(client).list(
          result.context.user.id,
          {
            includeArchived: true,
          },
        )
      : [];
    const workspace = createOwnedWorkspace(result, portfolioRecords);
    if (!result.ok) return workspace;
    const settings = await createOwnedUserSettingsRepository(client).get(
      result.context.user.id,
    );
    return settings
      ? {
          ...workspace,
          holdingCurrencyView: settings.defaultHoldingCurrencyView,
          settingsVersion: settings.version,
        }
      : workspace;
  } catch {
    return unavailableWorkspace("Portfolio data is temporarily unavailable.");
  }
}
