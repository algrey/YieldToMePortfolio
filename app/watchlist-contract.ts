import type { Tone } from "./prototype-data.ts";

// WLT-001: the owner's watchlist -- a distinct display contract from the
// portfolio-scoped `app/quote-contract.ts` (`QuoteRow`/`QuoteDisplayState`)
// it replaces on the Quotes tab. Deliberately NOT reused as-is: `QuoteRow`
// carries `portfolioSecurityId` (a holding link the watchlist must never
// have -- interest only, never a position) and has no concept of a
// currency-pair row or the two-line time-vs-date rule this tab's column
// spec requires.

export type WatchlistDisplayState =
  "current" | "fallback" | "stale" | "unavailable";

export type WatchlistProvenance = {
  source: "provider" | "manual" | "none";
  providerId: string | null;
  observationAt: string | null;
  delayedMinutes: number | null;
  scope: "deployment" | "owner" | "none";
  quality: string | null;
  fallbackReason: string;
};

// Owner column spec (verbatim, 2026-08-22): three columns, two lines per
// row -- (1) Ticker over company name; (2) Last price over the time of last
// price (or date if not today); (3) Day change in price over change in
// percent.
export type WatchlistRow = {
  entryId: string;
  version: number;
  kind: "security" | "currency_pair";
  targetKey: string;
  /** Column 1, line 1: ticker, or a "BASE/QUOTE" pair code. */
  symbol: string;
  /** Column 1, line 2: company name, or "Base to Quote". */
  name: string;
  /**
   * Column 2, line 1: "CCY 12.34", a bare FX rate, or "unavailable" (WLT-001
   * review B6: the owner's one-off "Price unavailable" -> "unavailable"
   * wording change, AGENTS.md non-negotiable; NEW watchlist strings adopt
   * it directly). UI-029 has since aligned every remaining legacy
   * "Price unavailable" display string elsewhere in the app to the same
   * "unavailable" wording, so this is no longer a transition state.
   */
  price: string;
  /**
   * Column 2, line 2: the observation's market-local time (HH:MM) when its
   * market date is today, else the market date itself -- never a guessed
   * prior date, and never a fabricated time for a target with no market
   * timezone (a currency pair; see `app/owned-watchlist.ts`).
   */
  timeLine: string;
  /** Column 3, line 1: signed change, or the honest em-dash state. */
  change: string;
  /** Column 3, line 2: signed percent change, or the honest em-dash state. */
  percent: string;
  tone: Tone;
  state: WatchlistDisplayState;
  provenance: WatchlistProvenance;
  sort: { ticker: string; price: string; change: string };
};

export function watchlistExplanation(row: WatchlistRow): string {
  const { state, timeLine, provenance } = row;
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
    return `unavailable: no usable price exists for this watch entry. ${details}`;
  }
  if (state === "stale") {
    return `Last-known quote dated ${timeLine}; the observation is stale. ${details}`;
  }
  if (state === "fallback") {
    return `Fallback quote dated ${timeLine}. ${details}`;
  }
  return `Validated quote as of ${timeLine}. ${details}`;
}
