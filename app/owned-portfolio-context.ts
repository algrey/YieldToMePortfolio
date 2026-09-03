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
// that security was sold). It also includes `status === "unresolved"` rows
// (`security_id IS NULL` by the table's own CHECK constraint) -- the
// identity read below LEFT (not INNER) JOINs `securities` so those rows
// survive with `securityId: null`, matching `loadFacts`'s own unfiltered,
// unjoined `securityRows` self-load predicate exactly (PRF-012 correction
// round B1: an INNER JOIN here silently dropped `unresolved` rows that the
// self-load path counted, so a portfolio that only failed the self-load's
// `too_many_securities` cap could pass when a context was supplied --
// `loadOwnedHoldings`/`loadOwnedDividendHistory` filter this list to
// `status === "held"` themselves -- the SAME filter their own self-load
// queries already apply, and `unresolved` can never be `held` by that same
// CHECK constraint, so a `null` `securityId` never reaches them.
//
// Caps and fallback (PRF-012 correction round B2): `MAX_CONTEXT_IDENTITY_ROWS`
// below is a SANITY ceiling on the raw, unfiltered (all-status) read alone,
// deliberately far above any individual loader's own business cap
// (`MAX_HELD`/`MAX_SECURITIES`, all 500 today). Unlike each loader's own
// cap (which matches a pre-existing self-load failure mode exactly), this
// ceiling and the `base_currency_code`/`timezone` sanity checks below are
// NEW checks this context introduces that no self-load performed on its
// own filtered subset -- a caller whose self-load would have stayed under
// 500 could still exceed 2,000 in the unfiltered superset (e.g. many
// `hidden` or `unresolved` rows), or the portfolio's stored currency/
// timezone could be malformed on a field a given self-load never reads.
// Failing closed there would be a NEW failure mode this context introduces
// that the caller would not otherwise hit. Instead, `resolveOwnedPortfolioContext`
// returns `null` on any of these three sanity failures (never throws) and
// logs one structured warning naming the reason only (no owner data) --
// every caller must treat `null` exactly like "no context resolved" and
// pass `undefined` to each loader, which then self-loads exactly as it did
// before this context existed.
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
  /** `null` only for `status === "unresolved"` rows (`security_id IS NULL`
   * by the table's own CHECK constraint) -- see this module's header
   * comment. `loadOwnedHoldings`/`loadOwnedDividendHistory` filter to
   * `status === "held"` before ever reading this field, and `unresolved`
   * can never be `held`, so a `null` here never reaches them. */
  securityId: string | null;
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

/** PRF-012 correction round B2: logs a single structured warning naming
 * WHY `resolveOwnedPortfolioContext` is falling back to `null` -- the
 * reason code only, never `userId`/`portfolioId`/any owner data. */
function warnContextFallback(reason: string): void {
  console.warn(
    JSON.stringify({ event: "owned_portfolio_context_fallback", reason }),
  );
}

/** Resolves the portfolio/settings/identities facts every `/income*`
 * loader on this read path independently self-loads -- ONE read of each,
 * shared by every loader a page threads it through to. Owner-scoped
 * exactly like every self-load query it replaces: `portfolio`/`identities`
 * are constrained by `userId` AND `portfolioId`, `settings` by the PK
 * lookup `userId` alone (matches `createOwnedUserSettingsRepository`'s own
 * scoping).
 *
 * Returns `null` (never throws) for the three SANITY-only failures this
 * context introduces beyond what any self-load already checks --
 * `MAX_CONTEXT_IDENTITY_ROWS`, an invalid stored `base_currency_code`, or
 * an invalid stored `timezone` -- see this module's header comment. Every
 * caller must pass `undefined` (not `null`) to each loader on a `null`
 * return so the loader self-loads exactly as it did before this context
 * existed; `not_owned`/`missing_user_settings` are unchanged, still
 * thrown, matching every self-load's own ownership gate. */
export async function resolveOwnedPortfolioContext(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<OwnedPortfolioContext | null> {
  const [portfolioRow, settings, identityRows] = await Promise.all([
    client.get<Row>(
      `SELECT id, base_currency_code, timezone FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
      [portfolioId, userId],
    ),
    createOwnedUserSettingsRepository(client).get(userId),
    // PRF-012 correction round B1: LEFT (not INNER) JOIN `securities` --
    // `status = 'unresolved'` rows have `security_id IS NULL` by the
    // table's own CHECK constraint and must still be carried (with
    // `securityId: null`), matching `loadFacts`'s own unjoined,
    // unfiltered `securityRows` self-load predicate exactly. An INNER
    // JOIN silently dropped them, undercounting this read relative to
    // that self-load's own row count.
    client.all<Row>(
      `SELECT ps.id, ps.security_id, ps.status,
              COALESCE(ps.display_symbol, ps.source_symbol) AS symbol,
              COALESCE(ps.display_name, s.canonical_name, ps.source_name, ps.source_symbol) AS name,
              COALESCE(e.mic, e.name, ps.source_exchange_alias, 'N/A') AS exchange,
              s.primary_currency_code, ps.source_currency_code
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       LEFT JOIN exchanges e ON e.id = s.exchange_id
       WHERE ps.user_id = ? AND ps.portfolio_id = ?
       ORDER BY ps.id LIMIT ?`,
      [userId, portfolioId, MAX_CONTEXT_IDENTITY_ROWS + 1],
    ),
  ]);
  if (!portfolioRow) throw new Error("not_owned");
  if (!settings) throw new Error("missing_user_settings");
  if (identityRows.length > MAX_CONTEXT_IDENTITY_ROWS) {
    warnContextFallback("too_many_securities");
    return null;
  }

  const baseCurrencyCode = String(portfolioRow.base_currency_code ?? "");
  const timezone = String(portfolioRow.timezone ?? "");
  if (!CURRENCY.test(baseCurrencyCode)) {
    warnContextFallback("invalid_base_currency_code");
    return null;
  }
  if (!timezone) {
    warnContextFallback("invalid_timezone");
    return null;
  }

  const identities: OwnedPortfolioContextIdentity[] = identityRows.map(
    (row) => ({
      id: String(row.id),
      securityId: row.security_id === null ? null : String(row.security_id),
      status: String(row.status),
      symbol: String(row.symbol),
      name: String(row.name),
      exchange: String(row.exchange),
      // `s.primary_currency_code` is only ever `null` for the `unresolved`
      // rows the LEFT JOIN above now carries (no matching `securities`
      // row) -- irrelevant to every consumer, which filters to `held`
      // (never `unresolved`) before reading this field; `String(null)`
      // would otherwise store the misleading literal text `"null"`.
      primaryCurrencyCode:
        row.primary_currency_code === null
          ? ""
          : String(row.primary_currency_code),
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
