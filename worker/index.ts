import handler from "vinext/server/app-router-entry";
import {
  createRuntimeConfigErrorResponse,
  resolveRuntimeConfig,
} from "./runtime-config";
import {
  applyResponseSecurityHeaders,
  createCspNonce,
} from "./response-security";

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

    return await applyResponseSecurityHeaders(
      request,
      await handler.fetch(request, env, ctx),
      nonce,
    );
  },
};

export default worker;
