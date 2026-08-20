import type { SqlClient } from "../db/repositories/sql-client.ts";
import { createOwnedManualOverrideRepository } from "../db/repositories/market-data.ts";
import type { PriceObservation } from "../domain/market-data/contracts.ts";
import { selectPriceObservation } from "../domain/market-data/selection.ts";
import {
  divideDecimal,
  formatDecimalFixed,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
} from "./preview-decimal.ts";
import type { QuoteRow } from "./quote-contract.ts";

type QuoteIdentity = {
  portfolio_security_id: string;
  security_id: string;
  symbol: string;
  name: string;
  currency_code: string;
  mapping_id: string | null;
};

function sortKey(value: string | null): string {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return "0";
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const scaled = BigInt(`${whole}${fraction.padEnd(8, "0").slice(0, 8)}`);
  return (negative ? -scaled : scaled).toString();
}

function signed(value: string): string {
  return value.startsWith("-") ? `−${value.slice(1)}` : `+${value}`;
}

function mapObservation(row: Record<string, unknown>): PriceObservation {
  return {
    kind: "price",
    providerId: String(row.provider_id),
    providerRevisionId:
      row.provider_revision_id === null
        ? null
        : String(row.provider_revision_id),
    mappingId: String(row.mapping_id),
    securityId: String(row.security_id),
    scope:
      row.access_scope === "user"
        ? { kind: "user", userId: String(row.scope_user_id) }
        : { kind: "deployment", userId: null },
    interval: String(row.interval) as PriceObservation["interval"],
    observationAt: String(row.observation_at),
    marketDate: String(row.market_date),
    marketTimezone: String(row.market_timezone),
    currencyCode: String(row.currency_code),
    closeDecimal: String(row.close_decimal),
    previousCloseDecimal:
      row.previous_close_decimal === null
        ? null
        : String(row.previous_close_decimal),
    adjustmentState: String(
      row.adjustment_state,
    ) as PriceObservation["adjustmentState"],
    adjustmentFactor: null,
    quality: String(row.quality) as PriceObservation["quality"],
    delayedMinutes:
      row.delayed_minutes === null ? null : Number(row.delayed_minutes),
    ingestedAt: String(row.ingested_at),
    payloadSha256:
      row.payload_sha256 === null ? null : String(row.payload_sha256),
  };
}

export async function loadOwnedQuotes(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
): Promise<QuoteRow[]> {
  const asOf = now.toISOString().slice(0, 10);
  const identities = await client.all<QuoteIdentity>(
    `SELECT ps.id AS portfolio_security_id, ps.security_id,
            COALESCE(ps.display_symbol, spm.provider_symbol, ps.source_symbol) AS symbol,
            COALESCE(ps.display_name, s.canonical_name, ps.source_name, ps.source_symbol) AS name,
            s.primary_currency_code AS currency_code, spm.id AS mapping_id
       FROM portfolio_securities ps
       JOIN securities s ON s.id = ps.security_id
       LEFT JOIN security_provider_mappings spm
         ON spm.security_id = ps.security_id
        AND spm.provider_id = 'yahoo-compatible'
        AND spm.status = 'verified'
        AND spm.valid_from <= ?
        AND (spm.valid_to IS NULL OR spm.valid_to >= ?)
      WHERE ps.user_id = ? AND ps.portfolio_id = ?
        AND ps.status IN ('held', 'watch')
      ORDER BY ps.id, spm.valid_from DESC, spm.id`,
    [asOf, asOf, userId, portfolioId],
  );
  const unique = identities.filter(
    (row, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.portfolio_security_id === row.portfolio_security_id,
      ) === index,
  );
  // BRK-012B review note (2026-08-20): unlike owned-holdings.ts/snapshots.ts,
  // this read is ALREADY `access_scope = 'deployment'`-only (no OR-branch
  // admitting a user-scoped row at all), so a Sharesight accretion row
  // (always `access_scope = 'user'`) can never reach it -- no
  // `provider_id <> 'sharesight'` predicate is needed here for THIS slice.
  const observations = await client.all<Record<string, unknown>>(
    `SELECT po.* FROM price_observations po
       JOIN portfolio_securities ps ON ps.security_id = po.security_id
      WHERE ps.user_id = ? AND ps.portfolio_id = ?
        AND ps.status IN ('held', 'watch')
        AND po.access_scope = 'deployment'
        AND po.market_date BETWEEN date(?, '-5 days') AND ?
      ORDER BY po.market_date DESC, po.observation_at DESC`,
    [userId, portfolioId, asOf, asOf],
  );
  const overrides =
    await createOwnedManualOverrideRepository(client).list(userId);

  return unique.map((identity): QuoteRow => {
    const selection = selectPriceObservation({
      asOf,
      now: now.toISOString(),
      userId,
      targetKey: identity.security_id,
      currencyCode: identity.currency_code,
      scope: { kind: "deployment", userId: null },
      observations: observations
        .filter((row) => row.security_id === identity.security_id)
        .map(mapObservation),
      overrides: overrides.filter(
        (override) =>
          override.portfolioId === null || override.portfolioId === portfolioId,
      ),
    });
    const selected = selection.selected;
    const previous = selected?.observation?.previousCloseDecimal ?? null;
    const changeDecimal =
      selected && previous
        ? subtractDecimal(
            parseDecimal(selected.closeDecimal),
            parseDecimal(previous),
          )
        : null;
    const percentDecimal =
      changeDecimal && previous
        ? multiplyDecimal(
            divideDecimal(changeDecimal, parseDecimal(previous)),
            parseDecimal("100"),
          )
        : null;
    const change = changeDecimal ? formatDecimalFixed(changeDecimal, 2) : null;
    const percent = percentDecimal
      ? formatDecimalFixed(percentDecimal, 2)
      : null;
    const state = selection.display ? selection.status : "unavailable";
    return {
      targetKey: identity.security_id,
      portfolioSecurityId: identity.portfolio_security_id,
      securityId: identity.security_id,
      symbol: identity.symbol,
      name: identity.name,
      currencyCode: identity.currency_code,
      price: selected
        ? `${selected.currencyCode} ${selected.closeDecimal}`
        : "Price unavailable",
      change: change ? signed(change) : "—",
      percent: percent ? `${signed(percent)}%` : "—",
      tone: change?.startsWith("-")
        ? "negative"
        : change === null || /^0(?:\.0+)?$/.test(change)
          ? "neutral"
          : "positive",
      marketDate: selected?.marketDate ?? "No business date",
      state,
      provenance: {
        source:
          selection.explanation.source === "manual"
            ? "manual"
            : selection.explanation.source === "provider"
              ? "provider"
              : "none",
        providerId: selection.explanation.providerId,
        observationAt: selection.explanation.observationAt,
        delayedMinutes: selected?.observation?.delayedMinutes ?? null,
        scope:
          selection.explanation.source === "manual"
            ? "owner"
            : selection.explanation.source === "provider"
              ? "deployment"
              : "none",
        quality: selection.explanation.quality,
        fallbackReason: selection.explanation.reason,
      },
      sort: {
        ticker: identity.symbol,
        price: sortKey(selected?.closeDecimal ?? null),
        change: sortKey(change),
      },
    };
  });
}
