import handler from "vinext/server/app-router-entry";
import {
  createRuntimeConfigErrorResponse,
  resolveRuntimeConfig,
} from "./runtime-config";
import {
  applyResponseSecurityHeaders,
  createCspNonce,
} from "./response-security";
import { createAccessJwtVerifier } from "../domain/auth/access-jwt";
import {
  addRequestId,
  createRequestId,
  emitStructuredLog,
} from "../domain/observability/index.ts";

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
    return await respond(await handler.fetch(request, env, ctx));
  },
};

export default worker;
