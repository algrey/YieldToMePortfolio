/**
 * MKT-018B (guided flow) — owner-scoped price-history COVERAGE read for the
 * import page's "Download price history" panel. `docs/MARKET_DATA_STRATEGY.md`
 * section 24's spike verdict (2026-08-24) is NO-GO for a Worker-side fetch
 * against Intelligent Investor's `_price-chart` endpoint (robots.txt
 * `Disallow`, WAF UA gate) — the fallback per that section's own
 * recommendation is a GUIDED flow: this read tells the owner which of their
 * ACTIVE (`status = 'held'`) portfolio securities have zero price-history
 * rows (so they know which ticker pages to visit) and which have only
 * PARTIAL coverage (so they can decide whether to backfill — v1 reports the
 * gap, it never auto-fills it, per MKT-018's own binding ruling).
 *
 * Coverage classification (`classifyPriceHistoryCoverage`) and owner-facing
 * display formatting live in `app/price-history-coverage-format.ts` -- a
 * PLAIN, DB-free module deliberately kept separate from THIS file (see its
 * own header comment for why: this file's dynamic
 * `import("./portfolio-actions.ts")` transitively reaches
 * `db/d1-sql-client.ts`'s `cloudflare:workers` import, which breaks the
 * production client bundle if the "use client" panel ever imported THIS
 * file directly for even one unrelated pure export).
 *
 * Mirrors `app/owned-price-history.ts`'s owner-visible scope predicate
 * (deployment-wide rows plus the CALLING owner's own user-scoped rows) and
 * `app/owned-holdings.ts`'s held-security identity query (same
 * COALESCE(display_symbol, source_symbol) ticker resolution) — this module
 * does not invent a new notion of "the owner's ticker for this security".
 */
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  compareDecimal,
  fromInteger,
  parseDecimalResult,
} from "../domain/calculations/index.ts";
import {
  deriveSharesHeldAtDate,
  type LedgerQuantityFact,
} from "../domain/dividends/shares-held.ts";
import {
  classifyPriceHistoryCoverage,
  type PriceHistoryCoverageRow,
} from "./price-history-coverage-format.ts";

export {
  classifyPriceHistoryCoverage,
  TRAILING_STALENESS_DAYS,
  type PriceHistoryCoverageClassification,
  type PriceHistoryCoverageRow,
} from "./price-history-coverage-format.ts";

const MAX_HELD = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZERO = fromInteger(0n);

/**
 * Review round-1 fix (B2, BLOCKING): a single `IN (...)` clause bound one
 * parameter per requested security id -- unbounded up to `MAX_HELD` (500),
 * risking a real bind-parameter ceiling well before that (D1's documented
 * ~100-bound-parameter-per-statement limit). Mirrors
 * `db/repositories/sharesight-delayed-price-cache.ts`'s identical
 * `CACHE_READ_CHUNK_SIZE = 50` precedent and its own doc comment's exact
 * reasoning: this keeps every single `IN (...)` statement to at most ~52
 * bind params (userId + portfolioId + up to 50 ids), comfortably under any
 * realistic per-statement limit regardless of how many securities the
 * portfolio holds.
 */
const COVERAGE_READ_CHUNK_SIZE = 50;

type Row = Record<string, unknown>;

export type PriceHistoryCoverageSuccess = Readonly<{
  ok: true;
  zero: readonly PriceHistoryCoverageRow[];
  partial: readonly PriceHistoryCoverageRow[];
}>;

export type PriceHistoryCoverageFailure = Readonly<{
  ok: false;
  // Matches `app/owned-price-history.ts`'s `PriceHistoryFailure` status
  // union -- `getAuthenticatedSqlContext` is typed to the same broader
  // `ActionFailure` union even though only 401/404/503 are reachable
  // through the paths this module actually exercises.
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
}>;

export type PriceHistoryCoverageResult =
  PriceHistoryCoverageSuccess | PriceHistoryCoverageFailure;

function optionalDate(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const text = String(value);
  return DATE.test(text) ? text : null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Mirrors `app/owned-price-history.ts`'s local `localDate` helper exactly
 * (this codebase deliberately keeps small date helpers local per-module
 * rather than sharing one utility -- see that file plus
 * `app/owned-holdings.ts`/`app/owned-watchlist.ts` for the same pattern).
 */
function localDate(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const result = `${values.year}-${values.month}-${values.day}`;
    if (!DATE.test(result)) throw new Error("invalid_local_date");
    return result;
  } catch {
    throw new Error("invalid_portfolio_timezone");
  }
}

/**
 * Review round-2 fix (B3, BLOCKING): the original heuristic here was a
 * naive buy-minus-sell sum over raw `transactions` rows -- SPLIT-BLIND. A
 * real drill exposed it: buy 100, split 2:1 (-> 200 held), sell 150 (->
 * 50 still held) summed as `100 - 150 = -50`, wrongly exempting a
 * STILL-HELD security from the B1(b) trailing-staleness rule and dropping
 * it from the panel entirely. Per the reviewer's RULING (no parallel
 * weaker convention), this now selects the exact `LedgerQuantityFact`
 * columns `deriveSharesHeldAtDate` (`domain/dividends/shares-held.ts`,
 * DIV-001) already needs and DELEGATES the actual quantity derivation to
 * that ONE pure, already-tested, split- and reversal-aware function --
 * the SAME function `app/dividend-assumptions-actions.ts`'s shares-at-date
 * action uses, with the IDENTICAL `status IN ('posted', 'reversed')` read
 * (that function's own two-signal reversal exclusion needs the reversing
 * marker row present to build `reversedIds`, and its `split` handling
 * needs every transaction type, not just buy/sell). `asOfDate` is this
 * read's own `today` (the SAME local business date the B1(b) staleness
 * rule is anchored to), so "sold out" here means "zero or fewer shares
 * held as of today" -- consistent with the panel's own "today" concept,
 * not some other cutoff.
 *
 * Still deliberately NOT the full FIFO/cost-basis projection engine
 * `app/owned-holdings.ts` reads from the published `holding_projections`
 * table (that requires a completed, high-water-gated calculation run;
 * this coverage panel is a lightweight display-only read that must
 * degrade gracefully rather than depend on one) -- `deriveSharesHeldAtDate`
 * needs only a signed, split-adjusted quantity sum, which is exactly what
 * this exemption needs too. A security whose derived result fails to
 * parse (should not happen; `deriveSharesHeldAtDate` always returns a
 * well-formed exact decimal) resolves as "not confirmed sold-out"
 * (excluded from the returned set) -- the safer default per
 * `classifyPriceHistoryCoverage`'s own doc comment, so an unresolvable
 * quantity still gets the B1(b) staleness check applied rather than a
 * silent exemption.
 */
async function loadSoldOutPortfolioSecurityIds(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  portfolioSecurityIds: readonly string[],
  today: string,
): Promise<Set<string>> {
  const factsByPortfolioSecurity = new Map<string, LedgerQuantityFact[]>();
  for (const batchIds of chunk(
    portfolioSecurityIds,
    COVERAGE_READ_CHUNK_SIZE,
  )) {
    const placeholders = batchIds.map(() => "?").join(",");
    const rows = await client.all<Row>(
      `SELECT portfolio_security_id, id, type, status, local_trade_date,
              trade_at, quantity_decimal, unit_price_decimal,
              reverses_transaction_id
         FROM transactions
        WHERE user_id = ? AND portfolio_id = ?
          AND portfolio_security_id IN (${placeholders})
          AND status IN ('posted', 'reversed')`,
      [userId, portfolioId, ...batchIds],
    );
    for (const row of rows) {
      const portfolioSecurityId = String(row.portfolio_security_id);
      const fact: LedgerQuantityFact = {
        id: String(row.id),
        type: String(row.type),
        status: String(row.status) as "posted" | "reversed",
        localTradeDate: String(row.local_trade_date),
        tradeAt: String(row.trade_at),
        quantityDecimal:
          row.quantity_decimal === null ? null : String(row.quantity_decimal),
        unitPriceDecimal:
          row.unit_price_decimal === null
            ? null
            : String(row.unit_price_decimal),
        reversesTransactionId:
          row.reverses_transaction_id === null
            ? null
            : String(row.reverses_transaction_id),
      };
      const existing = factsByPortfolioSecurity.get(portfolioSecurityId);
      if (existing) existing.push(fact);
      else factsByPortfolioSecurity.set(portfolioSecurityId, [fact]);
    }
  }
  const soldOut = new Set<string>();
  for (const [portfolioSecurityId, facts] of factsByPortfolioSecurity) {
    const sharesDecimal = deriveSharesHeldAtDate(facts, today);
    try {
      if (compareDecimal(parseDecimalResult(sharesDecimal), ZERO) <= 0) {
        soldOut.add(portfolioSecurityId);
      }
    } catch {
      // Never expected -- deriveSharesHeldAtDate always returns a
      // well-formed exact decimal -- but fail toward "not confirmed
      // sold-out" rather than crash this best-effort hint.
    }
  }
  return soldOut;
}

export async function loadOwnedPriceHistoryCoverage(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
): Promise<PriceHistoryCoverageResult> {
  const portfolio = await client.get<Row>(
    `SELECT id, timezone FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) {
    return { ok: false, status: 404, message: "Portfolio was not found." };
  }

  // Review round-1 fix (B2, BLOCKING): count FIRST, fail closed rather than
  // silently truncating to `MAX_HELD` results below -- mirrors
  // `app/owned-holdings.ts`'s identical `heldCount > MAX_HELD` guard.
  const heldCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM portfolio_securities WHERE user_id = ? AND portfolio_id = ? AND status = 'held'`,
    [userId, portfolioId],
  );
  const heldCount = Number(heldCountRow?.count ?? Number.NaN);
  if (!Number.isSafeInteger(heldCount) || heldCount < 0) {
    return {
      ok: false,
      status: 503,
      message: "This portfolio's held securities could not be counted.",
    };
  }
  if (heldCount > MAX_HELD) {
    return {
      ok: false,
      status: 503,
      message:
        "This portfolio has too many held securities to check price-history coverage safely.",
    };
  }
  if (heldCount === 0) return { ok: true, zero: [], partial: [] };

  let today: string;
  try {
    today = localDate(now, String(portfolio.timezone ?? ""));
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Portfolio timezone is unavailable.",
    };
  }

  // Same held-security identity shape as `app/owned-holdings.ts`'s
  // `identities` query (ticker/name resolution) plus a correlated
  // first-transaction-date subquery mirroring
  // `app/owned-capital-gains.ts`'s `earliest_trade_date` pattern, scoped to
  // THIS security within THIS portfolio rather than the whole portfolio.
  const identities = await client.all<Row>(
    `SELECT ps.id AS portfolio_security_id, ps.security_id AS security_id,
            COALESCE(ps.display_symbol, ps.source_symbol) AS ticker,
            COALESCE(ps.display_name, s.canonical_name, ps.source_name, ps.source_symbol) AS name,
            (SELECT MIN(t.local_trade_date) FROM transactions t
              WHERE t.user_id = ps.user_id AND t.portfolio_id = ps.portfolio_id
                AND t.portfolio_security_id = ps.id
                AND t.status IN ('posted', 'reversed')) AS first_transaction_date
       FROM portfolio_securities ps
       JOIN securities s ON s.id = ps.security_id
      WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held'
      ORDER BY ps.id
      LIMIT ?`,
    [userId, portfolioId, MAX_HELD],
  );
  // Review round-1 fix (B2, BLOCKING): a mismatch here means the held set
  // changed between the count above and this list (a genuine race, e.g. a
  // concurrent import commit) -- fail closed and honest rather than ever
  // silently returning a shorter download list than the portfolio actually
  // holds.
  if (identities.length !== heldCount) {
    return {
      ok: false,
      status: 503,
      message:
        "This portfolio's held securities changed while checking coverage. Please retry.",
    };
  }

  const portfolioSecurityIds = identities.map((row) =>
    String(row.portfolio_security_id),
  );
  const securityIds = identities.map((row) => String(row.security_id));

  const soldOutIds = await loadSoldOutPortfolioSecurityIds(
    client,
    userId,
    portfolioId,
    portfolioSecurityIds,
    today,
  );

  // ONE BATCHED (chunked, B2) aggregate query per chunk of held securities'
  // coverage -- never an N+1 per-security read. Owner-visible scope
  // predicate matches `app/owned-price-history.ts`'s `SCOPE_PREDICATE`
  // exactly (deployment rows plus the CALLING owner's own user-scoped
  // rows). Review round-1 fix (fold): joins `securities s` and requires
  // `po.currency_code = s.primary_currency_code` -- the SAME currency
  // filter `app/owned-price-history.ts` applies per-row (B1 there): a row
  // in a currency the chart would never plot must not count as coverage
  // either, or this panel could tell an owner "covered" while the chart
  // they'd actually see still shows nothing.
  const coverageBySecurity = new Map<string, Row>();
  for (const batchIds of chunk(securityIds, COVERAGE_READ_CHUNK_SIZE)) {
    const placeholders = batchIds.map(() => "?").join(",");
    const coverageRows = await client.all<Row>(
      `SELECT po.security_id AS security_id,
              COUNT(*) AS observation_count,
              MIN(po.market_date) AS first_observation_date,
              MAX(po.market_date) AS last_observation_date
         FROM price_observations po
         JOIN securities s ON s.id = po.security_id
        WHERE po.adjustment_state = 'raw'
          AND po.security_id IN (${placeholders})
          AND po.currency_code = s.primary_currency_code
          AND ((po.access_scope = 'deployment' AND po.scope_user_id IS NULL)
               OR (po.access_scope = 'user' AND po.scope_user_id = ?))
        GROUP BY po.security_id`,
      [...batchIds, userId],
    );
    for (const row of coverageRows) {
      coverageBySecurity.set(String(row.security_id), row);
    }
  }

  const zero: PriceHistoryCoverageRow[] = [];
  const partial: PriceHistoryCoverageRow[] = [];
  for (const identity of identities) {
    const securityId = String(identity.security_id);
    const portfolioSecurityId = String(identity.portfolio_security_id);
    const coverage = coverageBySecurity.get(securityId);
    const rawCount = coverage ? Number(coverage.observation_count) : 0;
    const observationCount =
      Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 0;
    const firstObservationDate = coverage
      ? optionalDate(coverage, "first_observation_date")
      : null;
    const lastObservationDate = coverage
      ? optionalDate(coverage, "last_observation_date")
      : null;
    const firstTransactionDate = optionalDate(
      identity,
      "first_transaction_date",
    );
    const isSoldOut = soldOutIds.has(portfolioSecurityId);
    const classification = classifyPriceHistoryCoverage({
      observationCount,
      firstObservationDate,
      lastObservationDate,
      firstTransactionDate,
      isSoldOut,
      today,
    });
    if (classification === "covered") continue;
    const row: PriceHistoryCoverageRow = {
      portfolioSecurityId,
      securityId,
      ticker: String(identity.ticker),
      name: String(identity.name),
      observationCount,
      firstObservationDate,
      lastObservationDate,
      firstTransactionDate,
      isSoldOut,
      classification,
    };
    if (classification === "zero") zero.push(row);
    else partial.push(row);
  }

  return { ok: true, zero, partial };
}

/**
 * Route-facing entry point -- same dynamic-import shape as
 * `app/owned-price-history.ts`'s `priceHistoryAction` (`portfolio-actions.ts`
 * transitively imports `next/headers`, which only resolves through
 * vinext's bundler, not Node's strict ESM loader under `node --test`).
 */
export async function priceHistoryCoverageAction(
  portfolioId: string,
): Promise<PriceHistoryCoverageResult> {
  const { getAuthenticatedSqlContext } = await import("./portfolio-actions.ts");
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) {
    return { ok: false, status: context.status, message: context.message };
  }
  return loadOwnedPriceHistoryCoverage(
    context.client,
    context.userId,
    portfolioId,
  );
}
