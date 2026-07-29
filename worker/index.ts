import handler from "vinext/server/app-router-entry";
import {
  createRuntimeConfigErrorResponse,
  resolveRuntimeConfig,
} from "./runtime-config";

const worker: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const runtimeConfig = resolveRuntimeConfig(env);
    if (!runtimeConfig.ok) {
      return createRuntimeConfigErrorResponse(runtimeConfig.errors);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
