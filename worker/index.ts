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
    const runtimeConfig = resolveRuntimeConfig(env);
    if (!runtimeConfig.ok) {
      return await applyResponseSecurityHeaders(
        request,
        createRuntimeConfigErrorResponse(runtimeConfig.errors),
        nonce,
      );
    }

    const pathname = new URL(request.url).pathname;
    if (
      runtimeConfig.config.environment === "production" &&
      pathname.startsWith("/portfolio/preview/")
    ) {
      return await applyResponseSecurityHeaders(
        request,
        new Response("Not found", {
          status: 404,
          headers: {
            "cache-control": "private, no-store",
            "content-type": "text/plain; charset=utf-8",
          },
        }),
        nonce,
      );
    }

    const accessResult = await accessJwtVerifier.verify(
      request,
      runtimeConfig.config.access,
    );
    if (!accessResult.ok) {
      return await applyResponseSecurityHeaders(
        request,
        createAccessDeniedResponse(accessResult.status),
        nonce,
      );
    }

    return await applyResponseSecurityHeaders(
      request,
      await handler.fetch(request, env, ctx),
      nonce,
    );
  },
};

export default worker;
