import type {
  MarketDataError,
  MarketDataProvider,
  MarketDataResult,
  ProviderCapabilities,
} from "./contracts.ts";

export type MarketDataProviderCode = "disabled" | "yahoo-best-effort";

export type MarketDataProviderConfiguration = {
  code: MarketDataProviderCode;
  enabled: boolean;
  observationScope: "deployment";
};

export type ProviderConfigurationResult =
  | { ok: true; config: MarketDataProviderConfiguration }
  | { ok: false; error: MarketDataError };

export function parseMarketDataProviderConfiguration(
  value: unknown,
): ProviderConfigurationResult {
  if (typeof value !== "string") {
    return {
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Market-data provider configuration must be a string.",
        retryable: false,
      },
    };
  }

  const code = value.trim();
  if (code !== "disabled" && code !== "yahoo-best-effort") {
    return {
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Market-data provider configuration is unsupported.",
        retryable: false,
      },
    };
  }

  return {
    ok: true,
    config: {
      code,
      enabled: code !== "disabled",
      observationScope: "deployment",
    },
  };
}

const NO_CAPABILITIES: ProviderCapabilities = {
  exchanges: [],
  intervals: [],
  supportsRawPrices: false,
  supportsAdjustedPrices: false,
  supportsFx: false,
  supportsDividends: false,
  supportsSplits: false,
  supportsFundamentals: false,
};

function unavailable<T>(capability: string): MarketDataResult<T> {
  return {
    ok: false,
    error: {
      kind: "unavailable_capability",
      message: `${capability} is unavailable while market data is disabled.`,
      retryable: false,
    },
  };
}

export function createDisabledMarketDataProvider(): MarketDataProvider {
  return {
    capabilities: () => NO_CAPABILITIES,
    searchSecurities: async () => unavailable("Security search"),
    getDailyPrices: async () => unavailable("Daily prices"),
    getLatestObservation: async () => unavailable("Latest observation"),
    getFxRates: async () => unavailable("FX rates"),
    getDividendEvents: async () => unavailable("Dividend events"),
    getSplitEvents: async () => unavailable("Split events"),
    getFundamentals: async () => unavailable("Fundamentals"),
  };
}
