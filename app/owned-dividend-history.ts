// DIV-001: owner-scoped read service composing the dividend repositories
// (DB-005/MKT-005) into the derived history + aggregates domain functions
// (`domain/dividends/**`). Mirrors `app/owned-holdings.ts`'s pattern: this
// module owns SqlClient access and owner-scope predicates; every actual
// derivation/aggregation rule lives in the pure `domain/dividends` modules
// this file only composes. Read-only -- no routes/UI (UI-006A/B/C consume
// this later).
//
// Batched per-portfolio, not per-security (follow-up fix, review round 2):
// an earlier version issued five sequential queries (events, overrides,
// manual records, assumptions, transactions) INSIDE the per-security loop,
// which is 5xN round trips at the 500-security cap -- pathological.
// Mirrors `app/owned-holdings.ts`'s batching pattern instead: every input
// table is fetched ONCE for the whole portfolio (bounded `IN (...)`
// queries / whole-portfolio repository listings) and grouped in memory
// before the per-security derivation loop, which now does no I/O at all.
//
// Scope boundary (explicit, for the Orchestrator/Reviewer): every total
// this module returns is PER-SECURITY, in that security's OWN native
// currency -- there is no blended, FX-converted PORTFOLIO-level total here.
// `dividend_fy_overrides` is a portfolio-scoped, portfolio-BASE-CURRENCY
// correction (see `docs/DATA_MODEL.md`'s `dividend_fy_overrides` section);
// honestly applying it against a specific security's native-currency FY
// total would require FX-converting every security's native dividend cash
// into the base currency first (payment-date FX for dated rows, latest FX
// for forecast/estimate rows, mirroring `app/owned-holdings.ts`'s existing
// `selectFxObservation` pattern for holding values) -- meaningfully more
// scope than DIV-001's "domain layer that turns [ingested/owner facts] into
// derived history + forecast" charter. This module therefore computes each
// security's `fyTotals` with NO override applied (an honest
// `actual`/`partially_estimated`/`provider_estimate`-only per-security
// figure) and separately returns the portfolio's raw, unconverted
// `portfolioFyOverrides` list so a consuming task (UI-006A, which already
// needs FX-aware multi-security aggregation for its landing screen) can
// reconcile the two. Flagged as a follow-up rather than silently guessed.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  createDividendAssumptionsRepository,
  createDividendEventOverrideRepository,
  createDividendFyOverrideRepository,
  createDividendManualRecordRepository,
  createDividendReceiptRepository,
} from "../db/repositories/dividends.ts";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios.ts";
import { currentFyWindow } from "../domain/calculations/financial-year.ts";
import {
  computeFyDividendTotals,
  computeLifetimeDividendTotals,
  type FyDividendOverrideFact,
  type FyDividendTotal,
  type LifetimeDividendTotals,
} from "../domain/dividends/aggregations.ts";
import {
  deriveDividendHistoryForSecurity,
  type DerivedDividendRow,
  type DividendManualRecordFact,
  type DividendReceiptFact,
  type ProviderDividendEventFact,
} from "../domain/dividends/history.ts";
import type { EventOverrideFact } from "../domain/dividends/event-override-resolution.ts";
import {
  computeSecurityDividendForecast,
  type SecurityDividendForecast,
} from "../domain/dividends/forecast.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";
import type { TrailingDividendEventInput } from "../domain/market-data/dividend-yield.ts";

const MAX_SECURITIES = 500;
const MAX_EVENTS_PER_PORTFOLIO = 20_000;
const MAX_TRANSACTIONS_PER_PORTFOLIO = 100_000;

type Row = Record<string, unknown>;

export type OwnedDividendSecurityHistory = {
  portfolioSecurityId: string;
  securityId: string;
  symbol: string;
  currencyCode: string;
  rows: DerivedDividendRow[];
  lifetimeTotals: LifetimeDividendTotals;
  /** Empty (never fabricated) when `fyTotalsStatus !== "ok"`. */
  fyTotals: FyDividendTotal[];
  /** `"ok"` normally; a `computeFyDividendTotals` failure (most commonly `"mixed_currency"`) degrades THIS security only -- the rest of the portfolio still loads. */
  fyTotalsStatus:
    "ok" | "mixed_currency" | "invalid_start_month" | "invalid_date";
  forecast: SecurityDividendForecast;
};

export type OwnedDividendHistory = {
  today: string;
  financialYearStartMonth: number;
  securities: OwnedDividendSecurityHistory[];
  /** Raw, unconverted -- see the module header's scope-boundary note. */
  portfolioFyOverrides: FyDividendOverrideFact[];
};

function inClause(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

export async function loadOwnedDividendHistory(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
): Promise<OwnedDividendHistory> {
  const portfolio = await client.get<Row>(
    `SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) throw new Error("not_owned");

  const settings = await createOwnedUserSettingsRepository(client).get(userId);
  if (!settings) throw new Error("missing_user_settings");
  const currentWindow = currentFyWindow(
    now.toISOString(),
    settings.financialYearStartMonth,
    settings.timezone,
  );
  if (!currentWindow.ok)
    throw new Error(`invalid_fy_window:${currentWindow.reason}`);
  const today = currentWindow.window.endDate;

  const identityRows = await client.all<Row>(
    `SELECT ps.id, ps.security_id, COALESCE(ps.display_symbol, ps.source_symbol) AS symbol,
            s.primary_currency_code
     FROM portfolio_securities ps
     JOIN securities s ON s.id = ps.security_id
     WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held'
     ORDER BY ps.id LIMIT ?`,
    [userId, portfolioId, MAX_SECURITIES + 1],
  );
  if (identityRows.length > MAX_SECURITIES)
    throw new Error("too_many_securities");
  const identities = identityRows.map((row) => ({
    id: String(row.id),
    securityId: String(row.security_id),
    symbol: String(row.symbol),
    currencyCode: String(row.primary_currency_code),
  }));

  const fyOverrideRecords = await createDividendFyOverrideRepository(
    client,
  ).list(userId, portfolioId);
  const portfolioFyOverrides: FyDividendOverrideFact[] = fyOverrideRecords.map(
    (override) => ({
      endingYear: override.financialYearEndingYear,
      grossedAmountDecimal: override.grossedAmountDecimal,
      frankingAmountDecimal: override.frankingAmountDecimal,
    }),
  );

  if (identities.length === 0) {
    return {
      today,
      financialYearStartMonth: settings.financialYearStartMonth,
      securities: [],
      portfolioFyOverrides,
    };
  }

  // --- Batched, whole-portfolio reads (one query/listing per table). ---

  const securityIds = [...new Set(identities.map((row) => row.securityId))];
  const portfolioSecurityIds = identities.map((row) => row.id);

  const eventRows = await client.all<Row>(
    `SELECT id, security_id, kind, status, ex_date, payment_date, currency_code,
            gross_per_share_decimal, supersedes_event_id
     FROM dividend_events
     WHERE security_id IN (${inClause(securityIds.length)})
     ORDER BY security_id, ex_date IS NULL, ex_date DESC, id DESC
     LIMIT ?`,
    [...securityIds, MAX_EVENTS_PER_PORTFOLIO + 1],
  );
  if (eventRows.length > MAX_EVENTS_PER_PORTFOLIO)
    throw new Error("too_many_dividend_events");
  const eventsBySecurity = new Map<string, ProviderDividendEventFact[]>();
  for (const row of eventRows) {
    const securityId = String(row.security_id);
    const list = eventsBySecurity.get(securityId) ?? [];
    list.push({
      id: String(row.id),
      kind: String(row.kind) as ProviderDividendEventFact["kind"],
      status: String(row.status) as ProviderDividendEventFact["status"],
      exDate: row.ex_date === null ? null : String(row.ex_date),
      paymentDate: row.payment_date === null ? null : String(row.payment_date),
      currencyCode: String(row.currency_code),
      grossPerShareDecimal:
        row.gross_per_share_decimal === null
          ? null
          : String(row.gross_per_share_decimal),
      supersedesEventId:
        row.supersedes_event_id === null
          ? null
          : String(row.supersedes_event_id),
    });
    eventsBySecurity.set(securityId, list);
  }

  const overrideRecords = await createDividendEventOverrideRepository(
    client,
  ).list(userId, portfolioId);
  const overridesBySecurity = new Map<string, EventOverrideFact[]>();
  for (const override of overrideRecords) {
    const list = overridesBySecurity.get(override.portfolioSecurityId) ?? [];
    list.push({
      dividendEventId: override.dividendEventId,
      sharesDecimal: override.sharesDecimal,
      dividendPerShareDecimal: override.dividendPerShareDecimal,
      frankingCreditPerShareDecimal: override.frankingCreditPerShareDecimal,
      exclude: override.exclude,
    });
    overridesBySecurity.set(override.portfolioSecurityId, list);
  }

  const manualRecords = await createDividendManualRecordRepository(client).list(
    userId,
    portfolioId,
  );
  const manualBySecurity = new Map<string, DividendManualRecordFact[]>();
  for (const record of manualRecords) {
    const list = manualBySecurity.get(record.portfolioSecurityId) ?? [];
    list.push({
      id: record.id,
      paymentDate: record.paymentDate,
      sharesDecimal: record.sharesDecimal,
      dividendPerShareDecimal: record.dividendPerShareDecimal,
      frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
      // DIV-004: carried through so the derivation can separate the
      // owner-typed and imported tiers -- see domain/dividends/history.ts.
      importBatchId: record.importBatchId,
    });
    manualBySecurity.set(record.portfolioSecurityId, list);
  }

  const receiptRecords = await createDividendReceiptRepository(client).list(
    userId,
    portfolioId,
  );
  const receiptsBySecurity = new Map<string, DividendReceiptFact[]>();
  for (const receipt of receiptRecords) {
    const list = receiptsBySecurity.get(receipt.portfolioSecurityId) ?? [];
    list.push({
      id: receipt.id,
      dividendEventId: receipt.dividendEventId,
      sharesDecimal: receipt.sharesDecimal,
      dividendPerShareDecimal: receipt.dividendPerShareDecimal,
      frankingPerShareDecimal: receipt.frankingPerShareDecimal,
      currencyCode: receipt.currencyCode,
      paymentDate: receipt.paymentDate,
    });
    receiptsBySecurity.set(receipt.portfolioSecurityId, list);
  }

  const assumptionsRecords = await createDividendAssumptionsRepository(
    client,
  ).listSecurityAssumptions(userId, portfolioId);
  const assumptionsBySecurity = new Map(
    assumptionsRecords.map((row) => [
      row.portfolioSecurityId,
      row.frankingPercentDecimal,
    ]),
  );

  const transactionRows = await client.all<Row>(
    `SELECT id, portfolio_security_id, type, status, local_trade_date, trade_at,
            quantity_decimal, unit_price_decimal, reverses_transaction_id
     FROM transactions
     WHERE user_id = ? AND portfolio_id = ?
       AND portfolio_security_id IN (${inClause(portfolioSecurityIds.length)})
       AND status IN ('posted', 'reversed')
     ORDER BY portfolio_security_id, local_trade_date, trade_at, id
     LIMIT ?`,
    [
      userId,
      portfolioId,
      ...portfolioSecurityIds,
      MAX_TRANSACTIONS_PER_PORTFOLIO + 1,
    ],
  );
  if (transactionRows.length > MAX_TRANSACTIONS_PER_PORTFOLIO) {
    throw new Error("too_many_transactions");
  }
  const transactionsBySecurity = new Map<string, LedgerQuantityFact[]>();
  for (const row of transactionRows) {
    const portfolioSecurityId = String(row.portfolio_security_id);
    const list = transactionsBySecurity.get(portfolioSecurityId) ?? [];
    list.push({
      id: String(row.id),
      type: String(row.type),
      status: String(row.status) as "posted" | "reversed",
      localTradeDate: String(row.local_trade_date),
      tradeAt: String(row.trade_at),
      quantityDecimal:
        row.quantity_decimal === null ? null : String(row.quantity_decimal),
      unitPriceDecimal:
        row.unit_price_decimal === null ? null : String(row.unit_price_decimal),
      reversesTransactionId:
        row.reverses_transaction_id === null
          ? null
          : String(row.reverses_transaction_id),
    });
    transactionsBySecurity.set(portfolioSecurityId, list);
  }

  // --- Pure derivation loop: no I/O, everything above is already grouped. ---

  const securities: OwnedDividendSecurityHistory[] = identities.map(
    (identity) => {
      const events = eventsBySecurity.get(identity.securityId) ?? [];
      const overrides = overridesBySecurity.get(identity.id) ?? [];
      const manual = manualBySecurity.get(identity.id) ?? [];
      const receipts = receiptsBySecurity.get(identity.id) ?? [];
      const transactions = transactionsBySecurity.get(identity.id) ?? [];
      const defaultFrankingPercentDecimal =
        assumptionsBySecurity.get(identity.id) ?? null;

      const rows = deriveDividendHistoryForSecurity({
        portfolioSecurityId: identity.id,
        securityCurrencyCode: identity.currencyCode,
        events,
        overrides,
        receipts,
        manualRecords: manual,
        transactions,
        defaultFrankingPercentDecimal,
        today,
      });

      const lifetimeTotals = computeLifetimeDividendTotals(
        rows,
        identity.currencyCode,
      );
      // Follow-up fix (review round 3): a `computeFyDividendTotals` failure
      // for ONE security (most commonly `mixed_currency` -- an owner-typed
      // manual/receipt record in a different currency than the security)
      // previously threw and failed the ENTIRE portfolio load. Degrade
      // instead: that security's FY totals become an explicit empty list
      // with the failure reason surfaced via `fyTotalsStatus`
      // (`lifetimeTotals` already has its own independent `mixed_currency`
      // disclosure and is unaffected), while every OTHER security in the
      // portfolio still loads normally.
      const fyResult = computeFyDividendTotals(
        rows,
        [],
        settings.financialYearStartMonth,
      );
      const fyTotals = fyResult.ok ? fyResult.totals : [];
      const fyTotalsStatus: OwnedDividendSecurityHistory["fyTotalsStatus"] =
        fyResult.ok ? "ok" : fyResult.reason;

      const ttmEvents: TrailingDividendEventInput[] = events
        .filter((event) => event.grossPerShareDecimal !== null)
        .map((event) => ({
          exDate: event.exDate!,
          currencyCode: event.currencyCode,
          grossPerShareDecimal: event.grossPerShareDecimal!,
          kind: event.kind,
          status: event.status,
        }));

      const forecast = computeSecurityDividendForecast({
        portfolioSecurityId: identity.id,
        currencyCode: identity.currencyCode,
        historyRows: rows,
        ttmEvents,
        transactions,
        defaultFrankingPercentDecimal,
        today,
      });

      return {
        portfolioSecurityId: identity.id,
        securityId: identity.securityId,
        symbol: identity.symbol,
        currencyCode: identity.currencyCode,
        rows,
        lifetimeTotals,
        fyTotals,
        fyTotalsStatus,
        forecast,
      };
    },
  );

  return {
    today,
    financialYearStartMonth: settings.financialYearStartMonth,
    securities,
    portfolioFyOverrides,
  };
}
