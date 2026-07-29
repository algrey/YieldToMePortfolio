export type RuntimeEnvironment = "local" | "preview" | "production";
export type WorkersPlan = "free" | "paid";
export type MarketDataProvider = "disabled" | "yahoo-best-effort";

type AssetsBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type RuntimeEnvInput = {
  ASSETS?: AssetsBinding;
  YIELDTOME_RUNTIME_ENV?: unknown;
  YIELDTOME_WORKERS_PLAN?: unknown;
  MARKET_DATA_PROVIDER?: unknown;
  CLOUDFLARE_ACCESS_ISSUER?: unknown;
  CLOUDFLARE_ACCESS_AUDIENCE?: unknown;
};

export type RuntimeConfigErrorCode =
  | "missing-assets-binding"
  | "invalid-runtime-environment"
  | "invalid-workers-plan"
  | "invalid-market-data-provider"
  | "production-requires-paid-workers"
  | "missing-access-issuer"
  | "missing-access-audience";

export type RuntimeConfigError = {
  code: RuntimeConfigErrorCode;
  message: string;
};

export type RuntimeConfig = {
  environment: RuntimeEnvironment;
  workersPlan: WorkersPlan;
  marketDataProvider: MarketDataProvider;
  csvImport: {
    enabled: boolean;
    maxBytes: number;
    maxRows: number;
    reason: string | null;
  };
  access: {
    issuer: string | null;
    audience: string | null;
  };
};

export type RuntimeConfigResult =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; errors: RuntimeConfigError[] };

const CSV_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const CSV_IMPORT_MAX_ROWS = 100_000;

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRuntimeEnvironment(value: unknown): RuntimeEnvironment | null {
  if (value === undefined) {
    return "local";
  }

  const normalized = normalizeString(value);

  switch (normalized) {
    case "local":
      return "local";
    case "preview":
      return "preview";
    case "production":
      return "production";
    default:
      return null;
  }
}

function parseWorkersPlan(
  value: unknown,
  environment: RuntimeEnvironment,
): WorkersPlan | null {
  const normalized = normalizeString(value);

  if (normalized === null) {
    return environment === "local" ? "free" : null;
  }

  switch (normalized) {
    case "free":
    case "paid":
      return normalized;
    default:
      return null;
  }
}

function parseMarketDataProvider(value: unknown): MarketDataProvider | null {
  const normalized = normalizeString(value);

  if (normalized === null) {
    return "disabled";
  }

  switch (normalized) {
    case "disabled":
    case "yahoo-best-effort":
      return normalized;
    default:
      return null;
  }
}

export function resolveRuntimeConfig(
  env: RuntimeEnvInput,
): RuntimeConfigResult {
  const errors: RuntimeConfigError[] = [];

  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    errors.push({
      code: "missing-assets-binding",
      message: "Missing required ASSETS binding.",
    });
  }

  const environment = parseRuntimeEnvironment(env.YIELDTOME_RUNTIME_ENV);
  if (environment === null) {
    errors.push({
      code: "invalid-runtime-environment",
      message:
        "YIELDTOME_RUNTIME_ENV must be one of local, preview, or production.",
    });
  }

  const resolvedEnvironment = environment ?? "local";
  const workersPlan = parseWorkersPlan(
    env.YIELDTOME_WORKERS_PLAN,
    resolvedEnvironment,
  );
  if (workersPlan === null) {
    errors.push({
      code: "invalid-workers-plan",
      message: "YIELDTOME_WORKERS_PLAN must be free or paid.",
    });
  }

  const marketDataProvider = parseMarketDataProvider(env.MARKET_DATA_PROVIDER);
  if (marketDataProvider === null) {
    errors.push({
      code: "invalid-market-data-provider",
      message: "MARKET_DATA_PROVIDER must be disabled or yahoo-best-effort.",
    });
  }

  const issuer = normalizeString(env.CLOUDFLARE_ACCESS_ISSUER);
  const audience = normalizeString(env.CLOUDFLARE_ACCESS_AUDIENCE);

  if (resolvedEnvironment !== "local") {
    if (issuer === null) {
      errors.push({
        code: "missing-access-issuer",
        message:
          "CLOUDFLARE_ACCESS_ISSUER is required outside local development.",
      });
    }

    if (audience === null) {
      errors.push({
        code: "missing-access-audience",
        message:
          "CLOUDFLARE_ACCESS_AUDIENCE is required outside local development.",
      });
    }
  }

  const resolvedWorkersPlan = workersPlan ?? "free";
  if (resolvedEnvironment === "production" && resolvedWorkersPlan !== "paid") {
    errors.push({
      code: "production-requires-paid-workers",
      message:
        "Production must run on Workers Paid for the documented CSV import profile.",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const csvImportEnabled = resolvedWorkersPlan === "paid";

  return {
    ok: true,
    config: {
      environment: resolvedEnvironment,
      workersPlan: resolvedWorkersPlan,
      marketDataProvider: marketDataProvider ?? "disabled",
      csvImport: {
        enabled: csvImportEnabled,
        maxBytes: CSV_IMPORT_MAX_BYTES,
        maxRows: CSV_IMPORT_MAX_ROWS,
        reason: csvImportEnabled
          ? null
          : "Workers Free fails closed on CSV import until a smaller measured limit is approved.",
      },
      access: {
        issuer,
        audience,
      },
    },
  };
}

export function createRuntimeConfigErrorResponse(
  errors: RuntimeConfigError[],
): Response {
  const status =
    errors.some((error) => error.code === "production-requires-paid-workers") ||
    errors.some((error) => error.code.startsWith("missing-access-"))
      ? 503
      : 500;

  return new Response("Service unavailable", {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
