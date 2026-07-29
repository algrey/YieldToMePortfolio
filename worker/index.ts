import handler from "vinext/server/app-router-entry";
import {
  createRuntimeConfigErrorResponse,
  resolveRuntimeConfig,
} from "./runtime-config";
import { applyResponseSecurityHeaders } from "./response-security";

const worker: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const runtimeConfig = resolveRuntimeConfig(env);
    if (!runtimeConfig.ok) {
      return applyResponseSecurityHeaders(
        request,
        createRuntimeConfigErrorResponse(runtimeConfig.errors),
      );
    }

    return applyResponseSecurityHeaders(
      request,
      await handler.fetch(request, env, ctx),
    );
  },
};

export default worker;
