// PRF-012 (`/income` re-reads the portfolio, `user_settings`, and held
// identities three to four times per request -- across
// `loadOwnedIncomeProjection` itself and each of `loadOwnedHoldings`/
// `loadOwnedDividendHistory`/`loadHistoricalPortfolioValueAtDates`, which
// were all independently designed as SELF-CONTAINED, self-loading
// services): a single, explicit, typed "resolved portfolio context" a
// page-level caller resolves ONCE and threads through as an OPTIONAL,
// trailing parameter to every one of those loaders. Omitting it (every
// pre-existing caller) is unchanged -- each loader still does its own
// self-load exactly as before.
//
// Ownership discipline: `identities` below is the SUPERSET every consumer
// needs -- ALL `portfolio_securities` rows regardless of `status` (not
// just `held`), because `loadHistoricalPortfolioValueAtDates` genuinely
// needs a SOLD security's identity too (a past FY-end date can fall before
// that security was sold). `loadOwnedHoldings`/`loadOwnedDividendHistory`
// filter this list to `status === "held"` themselves -- the SAME filter
// their own self-load queries already apply -- rather than the context
// pre-filtering it away.
//
// Caps: `MAX_CONTEXT_IDENTITY_ROWS` below is a SANITY ceiling on the raw,
// unfiltered (all-status) read alone, deliberately far above any
// individual loader's own business cap (`MAX_HELD`/`MAX_SECURITIES`, all
// 500 today) -- it exists only to bound a single pathological read, never
// to change what a normal-scale portfolio can do. Each loader still
// enforces its OWN existing cap (500) against its OWN filtered subset of
// `identities` exactly as it does on a real DB row set, so a portfolio
// with (say) 450 held + 600 sold securities behaves identically whether
// or not a caller supplies this context -- `loadHistoricalPortfolioValueAtDates`
// already imposes an unfiltered 500-row cap on its own self-load today
// (`loadFacts`'s `securityRows` query has no `status` filter), so this
// context never introduces a NEW failure mode; it can only ever fail in a
// scenario a caller of that function already fails in today.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  createOwnedUserSettingsRepository,
  type OwnedUserSettingsRecord,
} from "../db/repositories/owned-portfolios.ts";

type Row = Record<string, unknown>;

const CURRENCY = /^[A-Z]{3}$/;
// Sanity ceiling only -- see this module's header comment. 4x the largest
// individual per-status cap in use today (500), not a business rule.
const MAX_CONTEXT_IDENTITY_ROWS = 2_000;

export type OwnedPortfolioContextIdentity = {
  id: string;
  securityId: string;
  status: string;
  symbol: string;
  name: string;
  exchange: string;
  primaryCurrencyCode: string;
  sourceCurrencyCode: string;
};

export type OwnedPortfolioContext = {
  /** The authenticated userId this context was resolved for -- every
   * consuming loader must assert this equals ITS OWN `userId` argument
   * before trusting anything else on this object (never trust a
   * caller-supplied portfolio/identity list it did not itself verify). */
  userId: string;
  portfolio: {
    id: string;
    baseCurrencyCode: string;
    timezone: string;
  };
  settings: OwnedUserSettingsRecord;
  /** ALL `portfolio_securities` rows for this portfolio, any `status`,
   * ordered by `ps.id` (matching every self-load query's own ordering) --
   * see this module's header comment for why sold securities are
   * included. */
  identities: OwnedPortfolioContextIdentity[];
};

/** Every consuming loader calls this immediately after receiving an
 * optional context, before reading anything off it -- fails closed
 * (`invalid_portfolio_context`) rather than silently trusting a context
 * resolved for a different user or a different portfolio. */
export function assertOwnedPortfolioContext(
  context: OwnedPortfolioContext,
  userId: string,
  portfolioId: string,
): void {
  if (context.userId !== userId || context.portfolio.id !== portfolioId) {
    throw new Error("invalid_portfolio_context");
  }
}

/** Resolves the portfolio/settings/identities facts every `/income*`
 * loader on this read path independently self-loads -- ONE read of each,
 * shared by every loader a page threads it through to. Owner-scoped
 * exactly like every self-load query it replaces: `portfolio`/`identities`
 * are constrained by `userId` AND `portfolioId`, `settings` by the PK
 * lookup `userId` alone (matches `createOwnedUserSettingsRepository`'s own
 * scoping). */
export async function resolveOwnedPortfolioContext(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<OwnedPortfolioContext> {
  const [portfolioRow, settings, identityRows] = await Promise.all([
    client.get<Row>(
      `SELECT id, base_currency_code, timezone FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
      [portfolioId, userId],
    ),
    createOwnedUserSettingsRepository(client).get(userId),
    client.all<Row>(
      `SELECT ps.id, ps.security_id, ps.status,
              COALESCE(ps.display_symbol, ps.source_symbol) AS symbol,
              COALESCE(ps.display_name, s.canonical_name, ps.source_name, ps.source_symbol) AS name,
              COALESCE(e.mic, e.name, ps.source_exchange_alias, 'N/A') AS exchange,
              s.primary_currency_code, ps.source_currency_code
       FROM portfolio_securities ps
       JOIN securities s ON s.id = ps.security_id
       LEFT JOIN exchanges e ON e.id = s.exchange_id
       WHERE ps.user_id = ? AND ps.portfolio_id = ?
       ORDER BY ps.id LIMIT ?`,
      [userId, portfolioId, MAX_CONTEXT_IDENTITY_ROWS + 1],
    ),
  ]);
  if (!portfolioRow) throw new Error("not_owned");
  if (!settings) throw new Error("missing_user_settings");
  if (identityRows.length > MAX_CONTEXT_IDENTITY_ROWS)
    throw new Error("too_many_securities");

  const baseCurrencyCode = String(portfolioRow.base_currency_code ?? "");
  const timezone = String(portfolioRow.timezone ?? "");
  if (!CURRENCY.test(baseCurrencyCode))
    throw new Error("invalid_base_currency_code");
  if (!timezone) throw new Error("invalid_timezone");

  const identities: OwnedPortfolioContextIdentity[] = identityRows.map(
    (row) => ({
      id: String(row.id),
      securityId: String(row.security_id),
      status: String(row.status),
      symbol: String(row.symbol),
      name: String(row.name),
      exchange: String(row.exchange),
      primaryCurrencyCode: String(row.primary_currency_code),
      sourceCurrencyCode: String(row.source_currency_code),
    }),
  );

  return {
    userId,
    portfolio: { id: String(portfolioRow.id), baseCurrencyCode, timezone },
    settings,
    identities,
  };
}
