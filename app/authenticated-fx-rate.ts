import type { SqlClient } from "../db/repositories/sql-client.ts";
import type { FxObservation } from "../domain/market-data/contracts.ts";
import { selectFxObservation } from "../domain/market-data/selection.ts";
import {
  formatDecimalFixed,
  parseDecimal,
  type DecimalFraction,
} from "./preview-decimal.ts";

// Mirrors `owned-watchlist.ts`'s identical wrapper: a malformed stored
// decimal must degrade to the honest "unavailable" pill, never throw and
// take the whole app bar down with it.
function tryParseDecimal(value: string): DecimalFraction | null {
  try {
    return parseDecimal(value);
  } catch {
    return null;
  }
}

// UI-050 (owner-directed: a USD/AUD pill in the top app bar): the SAME
// selection machinery `owned-watchlist.ts`'s currency-pair rows use --
// `selectFxObservation` over a merged deployment-scope + this-owner's-own-
// user-scope observation set, bounded to a short lookback window (no
// look-ahead, no unbounded table scan). A failure or a genuinely absent
// rate resolves to `null`, never a fabricated/stale-looking figure (see
// `loadAuthenticatedWorkspace`'s caller, which renders "unavailable" for
// `null`).
const MAX_LOOKBACK_DAYS = 5;
const BASE_CURRENCY_CODE = "USD";
const QUOTE_CURRENCY_CODE = "AUD";

function mapFxObservation(row: Record<string, unknown>): FxObservation {
  return {
    kind: "fx",
    providerId: String(row.provider_id),
    providerRevisionId: null,
    scope:
      row.access_scope === "user"
        ? { kind: "user", userId: String(row.scope_user_id) }
        : { kind: "deployment", userId: null },
    baseCurrencyCode: String(row.base_currency_code),
    quoteCurrencyCode: String(row.quote_currency_code),
    rateDecimal: String(row.rate_decimal),
    interval: String(row.interval) as FxObservation["interval"],
    observedAt: String(row.observed_at),
    marketDate: String(row.market_date),
    quality: String(row.quality) as FxObservation["quality"],
    delayedMinutes: null,
    ingestedAt: String(row.ingested_at),
    payloadSha256:
      row.payload_sha256 === null ? null : String(row.payload_sha256),
  };
}

/** Two-decimal USD/AUD rate for the app-bar pill, or `null` when no usable
 * observation exists -- never a zero/fabricated figure. */
export async function loadUsdAudRate(
  client: SqlClient,
  userId: string,
  asOf: string,
): Promise<string | null> {
  const rows = await client.all<Record<string, unknown>>(
    `SELECT fx.* FROM fx_rate_observations fx
      WHERE fx.market_date BETWEEN date(?, '-${MAX_LOOKBACK_DAYS} days') AND ?
        AND ((fx.access_scope = 'deployment' AND fx.scope_user_id IS NULL)
             OR (fx.access_scope = 'user' AND fx.scope_user_id = ?))
        AND fx.base_currency_code = ? AND fx.quote_currency_code = ?
      ORDER BY fx.market_date DESC, fx.observed_at DESC`,
    [asOf, asOf, userId, BASE_CURRENCY_CODE, QUOTE_CURRENCY_CODE],
  );
  const selection = selectFxObservation({
    asOf,
    baseCurrencyCode: BASE_CURRENCY_CODE,
    quoteCurrencyCode: QUOTE_CURRENCY_CODE,
    targetKey: `${BASE_CURRENCY_CODE}/${QUOTE_CURRENCY_CODE}`,
    userId,
    observations: rows.map(mapFxObservation),
  });
  const rateDecimal = selection.selected?.rateDecimal ?? null;
  const parsed = rateDecimal === null ? null : tryParseDecimal(rateDecimal);
  return parsed === null ? null : formatDecimalFixed(parsed, 2);
}
