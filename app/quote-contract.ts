export type QuoteDisplayState =
  "current" | "fallback" | "stale" | "partial" | "unavailable";

export function quoteDisplayState(
  viewState: "populated" | "empty" | "partial" | "provider-error",
  isLastRow: boolean,
): QuoteDisplayState {
  if (viewState === "partial" && isLastRow) return "unavailable";
  if (viewState === "provider-error") return "stale";
  return "current";
}

export function quoteExplanation(
  state: QuoteDisplayState,
  businessDate: string,
): string {
  switch (state) {
    case "current":
      return `Validated quote for ${businessDate}. Routine source and timestamp details are available in the quote explanation.`;
    case "fallback":
      return `Fallback quote dated ${businessDate}. The selected observation is retained with its source and fallback reason.`;
    case "stale":
      return `Last-known quote dated ${businessDate}. The provider is unavailable or the observation is stale; refresh can be retried.`;
    case "partial":
      return `Partial pricing: this quote is not included because its usable price is missing.`;
    case "unavailable":
      return "Price unavailable: no usable price exists for this quote.";
  }
}
