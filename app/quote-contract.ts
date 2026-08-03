import type { Tone } from "./prototype-data.ts";

export type QuoteDisplayState =
  "current" | "fallback" | "stale" | "unavailable";

export type QuoteProvenance = {
  source: "provider" | "manual" | "none";
  providerId: string | null;
  observationAt: string | null;
  delayedMinutes: number | null;
  scope: "deployment" | "owner" | "none";
  quality: string | null;
  fallbackReason: string;
};

export type QuoteRow = {
  targetKey: string;
  portfolioSecurityId: string;
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  price: string;
  change: string;
  percent: string;
  tone: Tone;
  marketDate: string;
  state: QuoteDisplayState;
  provenance: QuoteProvenance;
  sort: { ticker: string; price: string; change: string };
};

export function quoteDisplayState(
  selectionState: QuoteDisplayState,
  hasUsablePrice: boolean,
): QuoteDisplayState {
  return hasUsablePrice ? selectionState : "unavailable";
}

export function quoteExplanation(quote: QuoteRow): string {
  const { state, marketDate, provenance } = quote;
  const source =
    provenance.source === "provider"
      ? `provider ${provenance.providerId ?? "unknown"}`
      : provenance.source === "manual"
        ? "owner-entered manual correction"
        : "no source";
  const timestamp = provenance.observationAt ?? "not available";
  const delay =
    provenance.delayedMinutes === null
      ? "delay not reported"
      : `${provenance.delayedMinutes} minute delay`;
  const quality = provenance.quality ?? "not available";
  const details = `Source: ${source}; observation timestamp: ${timestamp}; ${delay}; scope: ${provenance.scope}; quality: ${quality}; fallback: ${provenance.fallbackReason}.`;

  if (state === "unavailable") {
    return `Price unavailable: no usable price exists for this quote. ${details}`;
  }
  if (state === "stale") {
    return `Last-known quote dated ${marketDate}; the observation is stale. ${details}`;
  }
  if (state === "fallback") {
    return `Fallback quote dated ${marketDate}. ${details}`;
  }
  return `Validated quote for ${marketDate}. ${details}`;
}
