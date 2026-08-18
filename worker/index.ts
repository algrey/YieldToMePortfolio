import handler from "vinext/server/app-router-entry";
import {
  createRuntimeConfigErrorResponse,
  resolveRuntimeConfig,
} from "./runtime-config";
import {
  applyResponseSecurityHeaders,
  createCspNonce,
} from "./response-security";
import {
  createAccessJwtVerifier,
  encodeAccessJwtBase64Url,
} from "../domain/auth/access-jwt";
import { VERIFIED_PRINCIPAL_HEADER } from "../domain/auth/verified-principal-header";
import {
  addRequestId,
  createRequestId,
  emitStructuredLog,
} from "../domain/observability/index.ts";
import {
  runScheduledCalculationSweep,
  runScheduledCorporateActionRefresh,
  runScheduledMarketDataRefresh,
} from "./scheduled-refresh";

const accessJwtVerifier = createAccessJwtVerifier();

function createAccessDeniedResponse(status: 401 | 403 | 503): Response {
  const message =
    status === 503
      ? "Cloudflare Access configuration is unavailable."
      : "Cloudflare Access authentication failed.";

  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

const worker: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const nonce = createCspNonce();
    const requestId = createRequestId(request);
    const respond = async (response: Response): Promise<Response> =>
      addRequestId(
        await applyResponseSecurityHeaders(request, response, nonce),
        requestId,
      );
    const runtimeConfig = resolveRuntimeConfig(env);
    if (!runtimeConfig.ok) {
      emitStructuredLog({
        level: "error",
        event: "request.config",
        action: "runtime.config",
        result: "failure",
        requestId,
        metadata: {
          errorCodes: runtimeConfig.errors.map((error) => error.code),
        },
      });
      return await respond(
        createRuntimeConfigErrorResponse(runtimeConfig.errors),
      );
    }

    const pathname = new URL(request.url).pathname;
    if (
      runtimeConfig.config.environment === "production" &&
      pathname.startsWith("/portfolio/preview/")
    ) {
      emitStructuredLog({
        event: "request.route",
        action: "route.preview_blocked",
        result: "denied",
        requestId,
      });
      return await respond(
        new Response("Not found", {
          status: 404,
          headers: {
            "cache-control": "private, no-store",
            "content-type": "text/plain; charset=utf-8",
          },
        }),
      );
    }

    const accessResult = await accessJwtVerifier.verify(
      request,
      runtimeConfig.config.access,
    );
    if (!accessResult.ok) {
      emitStructuredLog({
        level: accessResult.status >= 500 ? "error" : "warn",
        event: "request.auth",
        action: "auth.verify",
        result: "denied",
        requestId,
        metadata: { status: accessResult.status },
      });
      return await respond(createAccessDeniedResponse(accessResult.status));
    }

    emitStructuredLog({
      event: "request.auth",
      action: "auth.verify",
      result: "success",
      requestId,
    });
    const authenticatedHeaders = new Headers(request.headers);
    authenticatedHeaders.delete(VERIFIED_PRINCIPAL_HEADER);
    authenticatedHeaders.set(
      VERIFIED_PRINCIPAL_HEADER,
      encodeAccessJwtBase64Url(accessResult.principal),
    );
    const authenticatedRequest = new Request(request, {
      headers: authenticatedHeaders,
    });
    return await respond(await handler.fetch(authenticatedRequest, env, ctx));
  },

  async scheduled(_controller, env) {
    const result = await runScheduledMarketDataRefresh(env);
    emitStructuredLog({
      level: result.ok ? "info" : "error",
      event: "market.refresh",
      action: "market.refresh.scheduled",
      result: result.ok ? "success" : "failure",
      requestId: "scheduled",
      metadata: result.ok
        ? {
            skipped: result.skipped,
            jobs: result.jobs,
            providerRequests: result.providerRequests,
          }
        : { reason: result.reason },
    });

    const corporateActionResult = await runScheduledCorporateActionRefresh(env);
    emitStructuredLog({
      level: corporateActionResult.ok ? "info" : "error",
      event: "market.refresh",
      action: "market.refresh.corporate_actions.scheduled",
      result: corporateActionResult.ok ? "success" : "failure",
      requestId: "scheduled",
      metadata: corporateActionResult.ok
        ? {
            skipped: corporateActionResult.skipped,
            securitiesProcessed: corporateActionResult.securitiesProcessed,
            securitiesFailed: corporateActionResult.securitiesFailed,
          }
        : { reason: corporateActionResult.reason },
    });

    const calculationSweepResult = await runScheduledCalculationSweep();
    emitStructuredLog({
      level: calculationSweepResult.ok ? "info" : "error",
      event: "calculation.sweep",
      action: "calculation.sweep.scheduled",
      result: calculationSweepResult.ok ? "success" : "failure",
      requestId: "scheduled",
      metadata: calculationSweepResult.ok
        ? {
            portfolios: calculationSweepResult.portfolios,
            advanced: calculationSweepResult.advanced,
            completed: calculationSweepResult.completed,
          }
        : { reason: calculationSweepResult.reason },
    });
  },
};

export default worker;
