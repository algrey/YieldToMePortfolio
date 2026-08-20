// BRK-012B: pure helpers turning `listUserInstruments`' typed output into
// price_observations accretion candidates -- no I/O, no DB access, no
// client calls. Kept separate from `db/repositories/sharesight-price-
// refresh.ts` (the write path) so the market-date/offset derivation rule
// and the scope-match/unmatch counting are independently unit-testable
// without a database. See docs/ARCHITECTURE.md §8.2's BRK-012B entry and
// TASKS.md's RESCOPE paragraph: historical backfill from Sharesight is
// impossible (BRK-012A's 406-dead route), so dailies instead ACCRETE
// forward -- one observation per (security, market_date, source, scope),
// last-write-wins within the day, converging toward the close.

import type { SharesightUserInstrument } from "./contracts.ts";

/**
 * Same shape check `domain/sharesight/parse.ts`'s `isTimestampWithOffset`
 * enforces before a `SharesightUserInstrument` can even be constructed --
 * duplicated here (not imported; that function is module-private to
 * `parse.ts`) so this module's own exported functions fail closed on their
 * own, defensively, rather than trusting every future caller to have
 * already validated. In the real pipeline this is always already true by
 * construction; this guard exists for callers who bypass that pipeline.
 */
function isValidOffsetTimestamp(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

/**
 * Extracts the trading-day calendar date directly from
 * `current_price_updated_at`'s own text, NEVER by converting the instant to
 * UTC first. Sharesight's timestamp already carries the exchange-local
 * offset (live evidence, docs/ARCHITECTURE.md §8.2: `+10:00`/`+11:00` for
 * Sydney) -- slicing the string's own date component is the only way to
 * recover the trading day Sharesight itself meant. `new
 * Date(value).toISOString()` would re-express the SAME instant in UTC and
 * could silently shift a late-evening positive-offset observation onto the
 * PREVIOUS calendar day (or, symmetrically, an early-morning
 * negative-offset observation onto the NEXT day) -- exactly the bug this
 * rule exists to avoid.
 *
 * BRK-012B review finding F5 (2026-08-20): fails CLOSED (`null`) on a
 * malformed/unparseable input rather than blindly slicing the first 10
 * characters of whatever string it was handed -- this module's convention
 * (mirroring `parse.ts`'s absent-vs-malformed sentinel discipline) is to
 * never echo a garbage value forward into a written record. In the real
 * pipeline `SharesightUserInstrument.currentPriceUpdatedAt` is already
 * shape-validated by `parse.ts` before it ever reaches this function, so
 * `null` should never occur there -- this guard is defense-in-depth for any
 * OTHER caller of this exported pure function.
 */
export function deriveMarketDateFromTimestamp(
  timestampWithOffset: string,
): string | null {
  return isValidOffsetTimestamp(timestampWithOffset)
    ? timestampWithOffset.slice(0, 10)
    : null;
}

/**
 * BRK-012B review finding B1(a) (2026-08-20, BLOCKING): converts
 * `current_price_updated_at` to a UTC `...Z` ISO string for storage as
 * `price_observations.observation_at`. The FIRST hourly write blanked the
 * owner's holdings view before this fix: `app/owned-holdings.ts`'s
 * `mapPrice` validates `observation_at` against a Z-only ISO regex
 * (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/`), which every OTHER
 * provider's stored timestamp already satisfies (Yahoo-compatible writes
 * UTC) but a raw Sharesight `+10:00`-suffixed string does not -- that
 * mismatch was silently swallowed into an "unavailable" state by the
 * calling workspace's catch, with no visible error.
 *
 * ORDER MATTERS and is INTENTIONAL: `market_date` (via
 * `deriveMarketDateFromTimestamp` above) is always derived from the
 * ORIGINAL, pre-conversion offset string -- this function's UTC-converted
 * output must NEVER be fed back into that derivation, since the whole
 * point of deriving market_date from the original offset is to avoid
 * exactly the UTC-conversion date-shift this function's own output would
 * reintroduce if misused that way. Callers (`buildSharesightPriceAccretionPlan`
 * below) MUST call both functions independently against the SAME original
 * `currentPriceUpdatedAt` string, never chain one into the other.
 *
 * Sharesight's raw offset-preserving string is NOT separately retained:
 * `price_observations` has no spare text column suited to carry it (see
 * `docs/DATA_MODEL.md`'s `price_observations` entry) -- this conversion IS
 * the documented rule, not a placeholder pending a future column.
 *
 * Fails CLOSED (`null`) on a malformed/unparseable input, same discipline
 * and same defense-in-depth rationale as `deriveMarketDateFromTimestamp`
 * above -- never writes a garbage/unparseable timestamp forward.
 */
export function normalizeTimestampToUtcIso(
  timestampWithOffset: string,
): string | null {
  if (!isValidOffsetTimestamp(timestampWithOffset)) return null;
  const parsed = new Date(timestampWithOffset);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * The UTC-offset suffix embedded in `current_price_updated_at` (e.g.
 * `"+10:00"`, `"Z"`) -- stored verbatim as `price_observations.market_timezone`.
 * Sharesight's wire never supplies a resolved IANA zone name, only a
 * numeric offset and an instrument `market_code` (e.g. `"ASX"`); this
 * module deliberately does NOT maintain a market_code -> IANA-zone mapping
 * table, since that would be inventing evidence the wire never sent for
 * every market this codebase hasn't live-confirmed. This is therefore an
 * honest, documented limitation: the stored value is the numeric offset AT
 * THE MOMENT OF THIS OBSERVATION, not a durable zone identifier -- it will
 * read differently across a DST transition for the same market, which is
 * expected and does not affect `deriveMarketDateFromTimestamp`'s
 * correctness (that reads the date digits directly, never this suffix).
 */
export function extractOffsetSuffix(timestampWithOffset: string): string {
  const match = /(Z|[+-]\d{2}:\d{2})$/.exec(timestampWithOffset);
  return match ? match[1] : timestampWithOffset;
}

export type SharesightPriceAccretionCandidate = Readonly<{
  securityId: string;
  /** Sharesight's own instrument ticker/market code -- carried through so
   * the write path can populate `security_provider_mappings.provider_exchange`/
   * `provider_symbol` for the FIRST accretion write for a security (the
   * `price_observations.mapping_id` FK requires a mapping row to already
   * exist; see `db/repositories/sharesight-price-refresh.ts`). Never used
   * for identity resolution itself -- that already happened via the
   * `sharesight_instrument` identifier, resolved by the caller before this
   * function ever runs (AGENTS.md: a ticker is not a durable security id). */
  instrumentCode: string;
  marketCode: string;
  currencyCode: string;
  closeDecimal: string;
  /** Derived from the ORIGINAL offset timestamp -- see
   * `deriveMarketDateFromTimestamp`'s doc comment on why this must never be
   * derived from `observationAt` below instead. */
  marketDate: string;
  marketTimezone: string;
  /** UTC `...Z` ISO string -- see `normalizeTimestampToUtcIso`'s doc
   * comment (BRK-012B review B1(a)). NOT Sharesight's raw offset string. */
  observationAt: string;
}>;

export type SharesightPriceAccretionPlan = Readonly<{
  candidates: readonly SharesightPriceAccretionCandidate[];
  matchedCount: number;
  unmatchedCount: number;
  /** Sharesight's own instrument ids only -- never a security id, ticker,
   * or price value. Names-only diagnostic, matching this module family's
   * established no-values-beyond-identifiers discipline. */
  unmatchedInstrumentIds: readonly string[];
  /** BRK-012B review finding F5: an instrument that DID match a security
   * but whose `current_price_updated_at` failed
   * `deriveMarketDateFromTimestamp`/`normalizeTimestampToUtcIso`'s shape
   * validation -- distinct from `unmatchedCount` (which means "no scope
   * match at all"), since this is a malformed-timestamp failure on an
   * otherwise-resolvable instrument. In the real pipeline this should never
   * be non-zero (the parse layer already validated the shape), but the
   * count/ids are disclosed the same names-only way `unmatchedInstrumentIds`
   * is, never silently dropped. */
  invalidTimestampCount: number;
  invalidTimestampInstrumentIds: readonly string[];
}>;

/**
 * Maps each returned instrument to the caller's OWNER-SCOPED
 * `sharesight_instrument` -> `security_id` lookup (BRK-009A identifiers,
 * resolved by the repository layer through the owner's `portfolio_securities`
 * -- never ticker text, per this task's ruling #4). An instrument with no
 * match is IGNORED, never guessed onto a nearest-ticker security -- its
 * count is disclosed via `unmatchedCount`/`unmatchedInstrumentIds` so a
 * caller can log/report it, but it produces no accretion candidate. A
 * matched instrument whose timestamp fails to validate (see
 * `invalidTimestampCount` above) is similarly excluded, never written with
 * a guessed/garbage date or timestamp.
 */
export function buildSharesightPriceAccretionPlan(
  instruments: readonly SharesightUserInstrument[],
  instrumentIdToSecurityId: ReadonlyMap<string, string>,
): SharesightPriceAccretionPlan {
  const candidates: SharesightPriceAccretionCandidate[] = [];
  const unmatchedInstrumentIds: string[] = [];
  const invalidTimestampInstrumentIds: string[] = [];
  for (const instrument of instruments) {
    const securityId = instrumentIdToSecurityId.get(instrument.id);
    if (!securityId) {
      unmatchedInstrumentIds.push(instrument.id);
      continue;
    }
    // Both derived independently from the SAME original offset string --
    // never chained, see `deriveMarketDateFromTimestamp`'s ORDER MATTERS
    // note.
    const marketDate = deriveMarketDateFromTimestamp(
      instrument.currentPriceUpdatedAt,
    );
    const observationAt = normalizeTimestampToUtcIso(
      instrument.currentPriceUpdatedAt,
    );
    if (marketDate === null || observationAt === null) {
      invalidTimestampInstrumentIds.push(instrument.id);
      continue;
    }
    candidates.push({
      securityId,
      instrumentCode: instrument.code,
      marketCode: instrument.marketCode,
      currencyCode: instrument.currencyCode,
      closeDecimal: instrument.currentPriceDecimal,
      marketDate,
      marketTimezone: extractOffsetSuffix(instrument.currentPriceUpdatedAt),
      observationAt,
    });
  }
  return {
    candidates,
    matchedCount: candidates.length,
    unmatchedCount: unmatchedInstrumentIds.length,
    unmatchedInstrumentIds,
    invalidTimestampCount: invalidTimestampInstrumentIds.length,
    invalidTimestampInstrumentIds,
  };
}
