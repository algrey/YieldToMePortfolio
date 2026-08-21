import { randomUUID } from "node:crypto";
import type { SqlClient } from "./sql-client.ts";
import { SHARESIGHT_PRICE_PROVIDER_ID } from "./sharesight-price-refresh.ts";

// MKT-011A: repository layer for the daily intraday-price-capture sweep --
// `app/daily-price-capture-service.ts` is the orchestrator; every function
// here is a single, owner-scoped DB primitive (mirroring
// `db/repositories/sharesight-price-refresh.ts`'s own split), never a
// cross-user query.

export const YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID = "yahoo-compatible";

export const DAILY_CAPTURE_LIMITS = Object.freeze({
  /** Owner fan-out per sweep tick -- mirrors
   * `SHARESIGHT_PRICE_REFRESH_LIMITS.maxUsersPerRun`'s identical headroom
   * rationale (this deployment currently has one real owner). */
  maxUsersPerRun: 50,
  /** Hard ceiling on `getLatestObservation` calls to the Yahoo-compatible
   * adapter across ALL yahoo-source owners in one sweep tick -- the
   * "per-sweep request budget bounded" ruling (TASKS.md MKT-011A). Sharesight
   * captures cost at most ONE shared `listUserInstruments()` call per sweep
   * regardless of owner count (BRK-012B precedent), so only the
   * per-security Yahoo path needs an explicit request cap. */
  maxYahooRequestsPerSweep: 50,
  /** Rollup+purge pairs processed per owner per sweep tick -- bounded so a
   * pathological backlog (many abandoned days) cannot make one tick
   * unbounded; a remaining backlog simply gets picked up on the NEXT tick
   * (rollup is idempotent and safe to defer). */
  maxRollupPairsPerUserPerSweep: 100,
});

export type DailyCaptureSource =
  "sharesight" | "yahoo_anonymous" | "yahoo_authenticated";

const VALID_DAILY_CAPTURE_SOURCES = new Set<string>([
  "sharesight",
  "yahoo_anonymous",
  "yahoo_authenticated",
]);

function isDailyCaptureSource(value: string): value is DailyCaptureSource {
  return VALID_DAILY_CAPTURE_SOURCES.has(value);
}

const VALID_DAILY_CAPTURE_INTERVAL_MINUTES = new Set<number>([30, 60]);

/**
 * Review round follow-up F2: `daily_capture_interval_minutes` has no DB
 * `CHECK` either (same documented ADD-COLUMN trade-off as
 * `daily_capture_source` -- db/schema.ts). A malformed/NaN value read back
 * (a hand-run write bypassing `validateDailyCaptureIntervalMinutes`) must
 * fail closed to the SAME safe default the column's own DEFAULT carries --
 * never silently DOUBLE the cadence (or worse) by passing a garbage number
 * through to `isCaptureTickEligible`'s `>= 60` comparison.
 */
function normalizeDailyCaptureIntervalMinutes(value: unknown): number {
  const numeric = Number(value);
  return VALID_DAILY_CAPTURE_INTERVAL_MINUTES.has(numeric) ? numeric : 60;
}

export type DailyCaptureUserSetting = Readonly<{
  userId: string;
  dailyCaptureSource: DailyCaptureSource;
  dailyCaptureIntervalMinutes: number;
}>;

/**
 * Every owner's daily-capture settings, bounded (`maxUsersPerRun`) and
 * deterministically ordered. Malformed rows (e.g. bypassing the
 * request-boundary enum validation via a hand-run write) are skipped --
 * never crash the whole sweep for one bad row, same runtime-guard discipline
 * as `sharesight-price-refresh.ts`'s `VALID_WATERMARK_STATUSES` (this
 * column has no DB `CHECK` -- see db/schema.ts's `dailyCaptureSource`
 * comment for the documented trade-off).
 */
export async function resolveDailyCaptureUserSettings(
  client: SqlClient,
  limit: number = DAILY_CAPTURE_LIMITS.maxUsersPerRun,
): Promise<DailyCaptureUserSetting[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("invalid_daily_capture_user_limit");
  }
  const rows = await client.all<{
    user_id: string;
    daily_capture_source: string;
    daily_capture_interval_minutes: number;
  }>(
    `SELECT user_id, daily_capture_source, daily_capture_interval_minutes
       FROM user_settings ORDER BY user_id ASC LIMIT ?`,
    [limit],
  );
  const settings: DailyCaptureUserSetting[] = [];
  for (const row of rows) {
    if (!isDailyCaptureSource(row.daily_capture_source)) continue;
    settings.push({
      userId: row.user_id,
      dailyCaptureSource: row.daily_capture_source,
      dailyCaptureIntervalMinutes: normalizeDailyCaptureIntervalMinutes(
        row.daily_capture_interval_minutes,
      ),
    });
  }
  return settings;
}

export type YahooCaptureCandidate = Readonly<{
  securityId: string;
  mappingId: string;
}>;

/**
 * This owner's yahoo-compatible-mapped, non-unresolved securities across
 * EVERY portfolio they own -- mirrors
 * `sharesight-price-refresh.ts`'s `resolveScopedSharesightInstrumentSecurities`
 * exactly (any status except `unresolved`, since that status structurally
 * carries no `security_id` -- see that function's own doc comment), just
 * resolved through `security_provider_mappings` (a VERIFIED, currently-valid
 * mapping) instead of a `sharesight_instrument` identifier. Never ticker
 * text (AGENTS.md).
 */
export async function resolveScopedYahooCaptureSecurities(
  client: SqlClient,
  userId: string,
): Promise<YahooCaptureCandidate[]> {
  const rows = await client.all<{ security_id: string; mapping_id: string }>(
    `SELECT DISTINCT ps.security_id AS security_id, spm.id AS mapping_id
       FROM portfolio_securities ps
       JOIN security_provider_mappings spm
         ON spm.security_id = ps.security_id
        AND spm.provider_id = ?
        AND spm.status = 'verified'
        AND spm.valid_to IS NULL
      WHERE ps.user_id = ? AND ps.status <> 'unresolved'
      ORDER BY ps.security_id ASC`,
    [YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID, userId],
  );
  return rows.map((row) => ({
    securityId: row.security_id,
    mappingId: row.mapping_id,
  }));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * This app's OWN stored market timezone per security (`exchanges.timezone`,
 * joined via `securities.exchange_id`) -- the window-gating decision's
 * source of truth per the owner/orchestrator ruling ("use the stored market
 * timezone"), never a provider-reported zone. `null` for a security with no
 * exchange (or no timezone recorded) -- an honest "cannot gate this
 * security" state, never a guessed default.
 */
export async function resolveSecurityMarketTimezones(
  client: SqlClient,
  securityIds: readonly string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(securityIds)];
  const map = new Map<string, string | null>();
  if (unique.length === 0) return map;
  for (const batch of chunk(unique, 50)) {
    const placeholders = batch.map(() => "?").join(",");
    const rows = await client.all<{ id: string; timezone: string | null }>(
      `SELECT s.id AS id, ex.timezone AS timezone
         FROM securities s
         LEFT JOIN exchanges ex ON ex.id = s.exchange_id
        WHERE s.id IN (${placeholders})`,
      batch,
    );
    for (const row of rows) map.set(row.id, row.timezone ?? null);
  }
  return map;
}

/**
 * The SAME guarded "INSERT ... SELECT ... WHERE NOT EXISTS" technique
 * `sharesight-price-refresh.ts`'s `upsertSharesightPriceObservations` uses
 * for its FIRST accretion write for a security -- reused here at CAPTURE
 * time (not deferred to rollup) so that by construction, any
 * `intraday_price_points` row for `provider_id = 'sharesight'` implies a
 * resolvable `security_provider_mappings` row already exists by the time
 * rollup runs (see `db/schema.ts`'s `intradayPricePoints` header comment).
 * Idempotent -- a no-op after the first successful call for a security.
 */
export async function guardInsertSharesightMapping(
  client: SqlClient,
  input: Readonly<{
    securityId: string;
    marketCode: string;
    instrumentCode: string;
    now: string;
  }>,
): Promise<void> {
  await client.run(
    `INSERT INTO security_provider_mappings (
       id, security_id, provider_id, provider_exchange, provider_symbol,
       valid_from, valid_to, status, verified_by_user_id, verified_at
     )
     SELECT ?, ?, ?, ?, ?, ?, NULL, 'candidate', NULL, NULL
     WHERE NOT EXISTS (
       SELECT 1 FROM security_provider_mappings
       WHERE provider_id = ? AND security_id = ? AND valid_to IS NULL
     )`,
    [
      randomUUID(),
      input.securityId,
      SHARESIGHT_PRICE_PROVIDER_ID,
      input.marketCode,
      input.instrumentCode,
      input.now.slice(0, 10),
      SHARESIGHT_PRICE_PROVIDER_ID,
      input.securityId,
    ],
  );
}

export type IntradayCaptureInput = Readonly<{
  userId: string;
  securityId: string;
  providerId: string;
  priceDecimal: string;
  currencyCode: string;
  marketDate: string;
  marketTimezone: string;
  observedAt: string;
  capturedAt: string;
  delayedMinutes: number | null;
  quality: string;
  providerRevisionId: string | null;
}>;

/**
 * Idempotent capture: `ON CONFLICT (user_id, security_id, provider_id,
 * observed_at) DO NOTHING` means a re-captured, UNCHANGED tick (the source
 * had nothing new to report) is a harmless no-op, never a duplicate row --
 * see `intraday_price_points_user_security_provider_observed_unique`
 * (db/schema.ts).
 */
export async function insertIntradayPricePoint(
  client: SqlClient,
  input: IntradayCaptureInput,
): Promise<{ inserted: boolean }> {
  const rows = await client.all<{ id: string }>(
    `INSERT INTO intraday_price_points (
       id, user_id, security_id, provider_id, price_decimal, currency_code,
       market_date, market_timezone, observed_at, captured_at,
       delayed_minutes, quality, provider_revision_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, security_id, provider_id, observed_at) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.userId,
      input.securityId,
      input.providerId,
      input.priceDecimal,
      input.currencyCode,
      input.marketDate,
      input.marketTimezone,
      input.observedAt,
      input.capturedAt,
      input.delayedMinutes,
      input.quality,
      input.providerRevisionId,
    ],
  );
  return { inserted: rows.length > 0 };
}

export type DailyCaptureRollupCandidate = Readonly<{
  securityId: string;
  marketDate: string;
  /** This app's own stored exchange timezone for the security, or `null`
   * when unresolvable (no exchange linked / no timezone recorded) -- see
   * `resolveSecurityMarketTimezones`'s identical honesty note. */
  marketTimezone: string | null;
}>;

/**
 * Every distinct (security, market_date) this owner currently has cached
 * for this provider -- the rollup sweep's own candidate list. Ordered by
 * `market_date` first so an older abandoned day (crash recovery) is always
 * processed before today's, within the per-sweep `maxRollupPairsPerUserPerSweep`
 * bound.
 */
export async function resolveDailyCaptureRollupCandidates(
  client: SqlClient,
  input: Readonly<{ userId: string; providerId: string }>,
): Promise<DailyCaptureRollupCandidate[]> {
  const rows = await client.all<{
    security_id: string;
    market_date: string;
    market_timezone: string | null;
  }>(
    `SELECT DISTINCT ip.security_id AS security_id, ip.market_date AS market_date,
            ex.timezone AS market_timezone
       FROM intraday_price_points ip
       JOIN securities s ON s.id = ip.security_id
       LEFT JOIN exchanges ex ON ex.id = s.exchange_id
      WHERE ip.user_id = ? AND ip.provider_id = ?
      ORDER BY ip.market_date ASC, ip.security_id ASC`,
    [input.userId, input.providerId],
  );
  return rows.map((row) => ({
    securityId: row.security_id,
    marketDate: row.market_date,
    marketTimezone: row.market_timezone,
  }));
}

export type IntradayPricePointRow = Readonly<{
  priceDecimal: string;
  currencyCode: string;
  marketDate: string;
  marketTimezone: string;
  observedAt: string;
  delayedMinutes: number | null;
  quality: string;
  providerRevisionId: string | null;
}>;

/** The LAST captured tick (max `observed_at`) for this (owner, provider,
 * security, market_date) -- what the rollup promotes into
 * `price_observations`. `null` when nothing is cached (defensive; the
 * caller normally already knows this pair exists from
 * `resolveDailyCaptureRollupCandidates`). */
export async function selectLastIntradayPricePoint(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    providerId: string;
    securityId: string;
    marketDate: string;
  }>,
): Promise<IntradayPricePointRow | null> {
  const row = await client.get<Record<string, unknown>>(
    `SELECT price_decimal, currency_code, market_date, market_timezone,
            observed_at, delayed_minutes, quality, provider_revision_id
       FROM intraday_price_points
      WHERE user_id = ? AND provider_id = ? AND security_id = ? AND market_date = ?
      ORDER BY observed_at DESC LIMIT 1`,
    [input.userId, input.providerId, input.securityId, input.marketDate],
  );
  if (!row) return null;
  return {
    priceDecimal: String(row.price_decimal),
    currencyCode: String(row.currency_code),
    marketDate: String(row.market_date),
    marketTimezone: String(row.market_timezone),
    observedAt: String(row.observed_at),
    delayedMinutes:
      row.delayed_minutes === null ? null : Number(row.delayed_minutes),
    quality: String(row.quality),
    providerRevisionId:
      row.provider_revision_id === null
        ? null
        : String(row.provider_revision_id),
  };
}

export type DailyCaptureRollupResult =
  { ok: true; written: boolean } | { ok: false; reason: "no_mapping" };

const PRICE_OBSERVATION_INSERT_COLUMNS = `
       id, provider_id, access_scope, scope_user_id, scope_key,
       mapping_id, security_id, interval, observation_at, market_date,
       market_timezone, currency_code, close_decimal, previous_close_decimal,
       adjustment_state, quality, delayed_minutes, ingested_at,
       provider_revision_id, payload_sha256`;

function priceObservationInsertParams(
  input: Readonly<{
    providerId: string;
    accessScope: string;
    scopeUserId: string | null;
    scopeKey: string;
    mappingId: string;
    securityId: string;
    point: IntradayPricePointRow;
    now: string;
  }>,
): unknown[] {
  return [
    randomUUID(),
    input.providerId,
    input.accessScope,
    input.scopeUserId,
    input.scopeKey,
    input.mappingId,
    input.securityId,
    input.point.observedAt,
    input.point.marketDate,
    input.point.marketTimezone,
    input.point.currencyCode,
    input.point.priceDecimal,
    input.point.quality,
    input.point.delayedMinutes,
    input.now,
    input.point.providerRevisionId,
  ];
}

/**
 * Promotes ONE (security, market_date) pair's last intraday point into
 * `price_observations` -- `interval = 'delayed'`, `adjustment_state =
 * 'raw'`, NEVER `'eod'` (AGENTS.md: never label a delayed capture an
 * official exchange close). Scope follows the SAME convention each
 * provider's OTHER writers already use: `sharesight` is user-scoped
 * (BRK-012B: fetched with the owner's own credentials), `yahoo-compatible`
 * is deployment-scoped (MKT-007/009B: the same public market data
 * regardless of which owner's sweep captured it).
 *
 * Price observations are a CONVERGING CACHE, not ledger facts -- immutability
 * rules do not apply here (Orchestrator ruling, MKT-011A review round). Both
 * providers converge through a SYMMETRIC mechanism (review round 2, B2
 * REVERSAL -- an earlier version of this function converged
 * `yahoo-compatible` at the application level via a read-then-insert check;
 * that design assumed a pre-existing multi-row-per-day `delayed`
 * yahoo-compatible writer that a round-2 review TRACED and DISPROVED --
 * `getLatestObservation`, the only producer of a `delayed` yahoo row, has no
 * call site in this codebase except this sweep, so no such writer to
 * coexist with ever existed): each provider targets its OWN partial
 * date-scoped unique index (db/schema.ts) via `ON CONFLICT ... DO UPDATE`,
 * converging the row to whichever point is genuinely newer.
 *
 * - `sharesight` targets `price_observations_provider_scope_mapping_date_unique`
 *   (`WHERE provider_id = 'sharesight'`, BRK-012B's OWN index -- its hourly
 *   refresh already writes/overwrites through this SAME index all day, so
 *   any Sharesight intraday point this sweep captures has a near-certain
 *   colliding same-day row already there; targeting the exact-`observation_at`
 *   index instead throws on that collision and wedges the whole rollup loop,
 *   review finding B1). The `DO UPDATE` is unconditional -- the sweep's own
 *   16:25 last-captured point is always at least as authoritative as
 *   whatever BRK-012B wrote earlier the same day.
 * - `yahoo-compatible` targets the NEW, symmetric
 *   `price_observations_yahoo_scope_mapping_date_unique` (migration
 *   `0050_mkt_011a_yahoo_rollup_index.sql`, `WHERE provider_id =
 *   'yahoo-compatible' AND interval = 'delayed'` -- narrower than the
 *   Sharesight index because this index must never constrain `eod` rows.
 *   The evidence for that is NOT a directly-observed yahoo-specific write
 *   pattern -- it is the FIRST (`observation_at`-exact) unique index's own
 *   documented rationale (db/schema.ts), which preserves a same-day
 *   "correction received later" capability -- two rows, same `market_date`,
 *   different `observation_at` -- for EVERY provider, grounded in
 *   `tests/calc-002-repository.test.ts`'s fixture; this new index scopes to
 *   `interval = 'delayed'` specifically so it can never take that
 *   provider-agnostic capability away from `yahoo-compatible`'s `eod` rows,
 *   whether or not this provider actually exercises it in practice). Its
 *   `DO UPDATE` carries an explicit `WHERE excluded.observation_at >
 *   price_observations.observation_at` guard -- unlike Sharesight (a single
 *   writer, this sweep, always advancing forward in time within one run),
 *   this branch is ALSO what makes two different owners' independent
 *   captures of the SAME security+day (both `access_scope = 'deployment'`)
 *   converge safely regardless of arrival order: an out-of-order arrival
 *   (an older point landing after a newer one) is a genuine no-op (SQLite's
 *   upsert reports zero `RETURNING` rows when the `DO UPDATE` guard
 *   suppresses the update -- verified directly against this exact query
 *   shape), never a downgrade.
 *
 * Returns `{ ok: false, reason: 'no_mapping' }` (never throws, never writes
 * a guessed value) when no resolvable `security_provider_mappings` row
 * exists for this (provider, security) -- by construction this should not
 * happen (see `intradayPricePoints`' schema comment), but the caller must
 * still handle it as an honest "cannot roll up yet" outcome, leaving the
 * intraday points in place for a later retry rather than purging data that
 * was never promoted.
 */
export async function rollupIntradayPricePoint(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    providerId: string;
    securityId: string;
    point: IntradayPricePointRow;
    now: string;
  }>,
): Promise<DailyCaptureRollupResult> {
  const mapping = await client.get<{ id: string }>(
    `SELECT id FROM security_provider_mappings
      WHERE provider_id = ? AND security_id = ? AND valid_to IS NULL
      ORDER BY valid_from DESC LIMIT 1`,
    [input.providerId, input.securityId],
  );
  if (!mapping) return { ok: false, reason: "no_mapping" };

  const isSharesight = input.providerId === SHARESIGHT_PRICE_PROVIDER_ID;
  const accessScope = isSharesight ? "user" : "deployment";
  const scopeUserId = isSharesight ? input.userId : null;
  const scopeKey = isSharesight ? input.userId : "deployment";
  const baseParams = priceObservationInsertParams({
    providerId: input.providerId,
    accessScope,
    scopeUserId,
    scopeKey,
    mappingId: mapping.id,
    securityId: input.securityId,
    point: input.point,
    now: input.now,
  });

  // Both branches target their OWN partial date-scoped unique index (see
  // this function's doc comment) -- symmetric shape, different `WHERE`
  // predicate (repeated verbatim from the index definition, required for
  // SQLite to match an `ON CONFLICT` clause against a PARTIAL index) and a
  // guard clause only `yahoo-compatible` needs (Sharesight has exactly one
  // writer, this sweep, always advancing forward within one run).
  const conflictWhere = isSharesight
    ? `WHERE provider_id = 'sharesight'`
    : `WHERE provider_id = 'yahoo-compatible' AND interval = 'delayed'`;
  const updateGuard = isSharesight
    ? ""
    : `WHERE excluded.observation_at > price_observations.observation_at`;
  const rows = await client.all<{ id: string }>(
    `INSERT INTO price_observations (${PRICE_OBSERVATION_INSERT_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, 'delayed', ?, ?, ?, ?, ?, NULL, 'raw', ?, ?, ?, ?, NULL)
     ON CONFLICT (
       provider_id, scope_key, mapping_id, interval, market_date, adjustment_state
     ) ${conflictWhere}
     DO UPDATE SET
       observation_at = excluded.observation_at,
       market_timezone = excluded.market_timezone,
       currency_code = excluded.currency_code,
       close_decimal = excluded.close_decimal,
       ingested_at = excluded.ingested_at,
       provider_revision_id = excluded.provider_revision_id
     ${updateGuard}
     RETURNING id`,
    baseParams,
  );
  return { ok: true, written: rows.length > 0 };
}

const MARKET_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRICE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * F5 (MKT-011B review follow-up): mirrors `app/owned-price-history.ts`'s
 * `fetchObservations`/`MAX_RAW_OBSERVATIONS` fail-closed-on-overflow
 * pattern -- this read had no such bound at all, an asymmetry with every
 * other owner-scoped price read in this codebase. In practice a single
 * (owner, security, day) is bounded by the capture cadence itself (the
 * `daily_capture_interval_minutes` setting is 30 or 60 over a fixed
 * 10:25-16:25 window, so even a hypothetical 1-minute cadence yields only
 * ~360 ticks) -- 1000 is a generously wide ceiling that should never be
 * reached by legitimate data, kept purely to close the asymmetry and fail
 * closed rather than silently truncate on a corrupted/pathological row
 * count.
 */
const MAX_INTRADAY_POINTS_PER_DAY = 1000;

export type OwnedTodayIntradayPoint = Readonly<{
  providerId: string;
  priceDecimal: string;
  currencyCode: string;
  marketDate: string;
  observedAt: string;
}>;

export type OwnedTodayIntradayReadResult = Readonly<{
  points: readonly OwnedTodayIntradayPoint[];
  /** Rows that failed row-shape validation at this external boundary
   * (AGENTS.md) -- counted, never silently dropped, mirroring
   * `app/owned-price-history.ts`'s own `mapRow` disclosure discipline. */
  excludedMalformedCount: number;
}>;

/**
 * MKT-011B: this owner's cached intraday ticks for ONE security on ONE
 * market day, ordered by observation time ascending -- the today-series
 * read path for the UI-018 price-history chart's intraday overlay. Owner-
 * scoped by `user_id` at the SQL boundary (never a caller-supplied scope --
 * AGENTS.md "constrain every portfolio-scoped query... by authenticated
 * internal user_id"). A security with zero cached points for this day
 * returns an empty `points` array -- an HONEST "nothing captured yet"
 * state (market closed, capture not yet run, or the capture source
 * disabled all read identically as "nothing cached" from this read alone;
 * the caller must never turn that into a fabricated zero-value point).
 *
 * Returns `null` (never truncates silently) when this (owner, security,
 * day) has MORE than `MAX_INTRADAY_POINTS_PER_DAY` cached rows -- the same
 * MAX+1-probe, fail-closed shape `app/owned-price-history.ts`'s
 * `fetchObservations` uses for the historical series (F5, MKT-011B review
 * follow-up).
 */
export async function listOwnedIntradayPricePointsForDate(
  client: SqlClient,
  input: Readonly<{ userId: string; securityId: string; marketDate: string }>,
): Promise<OwnedTodayIntradayReadResult | null> {
  const rows = await client.all<Record<string, unknown>>(
    `SELECT provider_id, price_decimal, currency_code, market_date, observed_at
       FROM intraday_price_points
      WHERE user_id = ? AND security_id = ? AND market_date = ?
      ORDER BY observed_at ASC
      LIMIT ?`,
    [
      input.userId,
      input.securityId,
      input.marketDate,
      MAX_INTRADAY_POINTS_PER_DAY + 1,
    ],
  );
  if (rows.length > MAX_INTRADAY_POINTS_PER_DAY) return null; // unbounded -- caller fails closed
  const points: OwnedTodayIntradayPoint[] = [];
  let excludedMalformedCount = 0;
  for (const row of rows) {
    const providerId = String(row.provider_id ?? "");
    const priceDecimal = String(row.price_decimal ?? "");
    const currencyCode = String(row.currency_code ?? "");
    const marketDate = String(row.market_date ?? "");
    const observedAt = String(row.observed_at ?? "");
    if (
      !providerId ||
      !PRICE_DECIMAL_PATTERN.test(priceDecimal) ||
      !currencyCode ||
      !MARKET_DATE_PATTERN.test(marketDate) ||
      !observedAt
    ) {
      excludedMalformedCount += 1;
      continue;
    }
    points.push({
      providerId,
      priceDecimal,
      currencyCode,
      marketDate,
      observedAt,
    });
  }
  return { points, excludedMalformedCount };
}

/** Deletes every cached tick for this (owner, provider, security,
 * market_date) -- called ONLY after `rollupIntradayPricePoint` reports
 * success (the "purge only after successful rollup" ruling). */
export async function purgeIntradayPricePoints(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    providerId: string;
    securityId: string;
    marketDate: string;
  }>,
): Promise<{ purged: number }> {
  const result = await client.run(
    `DELETE FROM intraday_price_points
      WHERE user_id = ? AND provider_id = ? AND security_id = ? AND market_date = ?`,
    [input.userId, input.providerId, input.securityId, input.marketDate],
  );
  return { purged: result.changes };
}
