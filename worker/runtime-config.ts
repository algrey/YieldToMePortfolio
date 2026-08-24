import {
  parseMarketDataProviderConfiguration,
  type MarketDataProviderCode,
} from "../domain/market-data/config.ts";

export type RuntimeEnvironment = "local" | "preview" | "production";
export type WorkersPlan = "free" | "paid";
export type MarketDataProvider = MarketDataProviderCode;

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
  | "missing-access-issuer"
  | "missing-access-audience";

export type RuntimeConfigError = {
  code: RuntimeConfigErrorCode;
  message: string;
};

export type RuntimeConfig = {
  environment: RuntimeEnvironment;
  // IMP-010B review round (B2 ruling): as of IMP-010B, this field gates
  // NOTHING behavioral -- confirmed by a repo-wide grep: no module reads
  // `RuntimeConfig.workersPlan` for any purpose. It is validated (must be
  // `free`/`paid` when set) and carried through purely as recorded
  // deployment metadata. Before IMP-010B it was the input to the
  // `production-requires-paid-workers` gate below (removed) and to
  // `app/import-actions.ts`'s now-retired `assessCsvImportUploadStart`
  // call (see CSV_IMPORT_SPEC.md's IMP-010B section) -- the ledger CSV
  // import path's CPU-heavy work moved to the browser, so nothing in this
  // codebase needs a paid Workers plan to function correctly any more.
  // Retiring `YIELDTOME_WORKERS_PLAN` entirely (env var, `wrangler.json`
  // vars, this field, `parseWorkersPlan`) is a reasonable follow-up, not
  // decided here -- left in place, advisory-only, to avoid expanding this
  // task's scope into an unrelated config-surface removal.
  workersPlan: WorkersPlan;
  marketDataProvider: MarketDataProvider;
  access: {
    issuer: string | null;
    audience: string | null;
  };
};

export type RuntimeConfigResult =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; errors: RuntimeConfigError[] };

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

  const providerConfiguration = parseMarketDataProviderConfiguration(
    env.MARKET_DATA_PROVIDER ?? "disabled",
  );
  if (!providerConfiguration.ok) {
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

  // IMP-010B review round (B2 ruling): production previously hard-failed
  // (503, every request) unless `YIELDTOME_WORKERS_PLAN === "paid"`. That
  // gate existed SOLELY because the ledger CSV import path's decode/parse
  // work ran on the Worker and needed Workers Paid's CPU-time budget to
  // complete reliably -- IMP-010B moved that work into the browser (see
  // CSV_IMPORT_SPEC.md's IMP-010B section), so nothing in this codebase
  // requires a paid Workers plan any more. Per the owner's explicit
  // free-plan production directive, this gate is retired deliberately, not
  // incidentally: a `production` deployment now resolves successfully
  // under `workersPlan: "free"`.
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      environment: resolvedEnvironment,
      workersPlan: resolvedWorkersPlan,
      marketDataProvider: providerConfiguration.ok
        ? providerConfiguration.config.code
        : "disabled",
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
  const status = errors.some((error) =>
    error.code.startsWith("missing-access-"),
  )
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
