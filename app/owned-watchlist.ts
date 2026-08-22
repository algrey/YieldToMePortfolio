import type { SqlClient } from "../db/repositories/sql-client.ts";
import type {
  FxObservation,
  PriceObservation,
} from "../domain/market-data/contracts.ts";
import {
  selectFxObservation,
  selectPriceObservation,
} from "../domain/market-data/selection.ts";
import {
  compareDecimal,
  divideDecimal,
  formatDecimalFixed,
  formatDecimalTrimmed,
  isZero,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "./preview-decimal.ts";
import type { Tone } from "./prototype-data.ts";
import type { WatchlistRow } from "./watchlist-contract.ts";

// WLT-001: reads the owner's watchlist (`watchlist_entries`, USER-scoped --
// no portfolioId anywhere in this module) and resolves each entry's quote
// through the SAME selection machinery `app/owned-holdings.ts` uses for
// held securities: `selectPriceObservation`/`selectFxObservation` over a
// merged deployment-scope + this-owner's-own-user-scope observation set
// (Yahoo, Sharesight, and MKT-012 owner-import all compete in ONE call --
// no parallel quote path), honouring the owner's MKT-009B
// `priceSourcePreference`. This is deliberately NOT `app/owned-quotes.ts`'s
// narrower deployment-scope-only slice (that module's own comment records
// why it was safe to skip Sharesight/owner-import there: it depends on
// `portfolio_securities.status`, which does not exist for a watchlist
// entry) -- the watchlist reuses the fuller selection this codebase's
// holdings surface already relies on.

const MAX_LOOKBACK_DAYS = 5;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function sortKey(value: string | null): string {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return "0";
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const scaled = BigInt(`${whole}${fraction.padEnd(8, "0").slice(0, 8)}`);
  return (negative ? -scaled : scaled).toString();
}

// WLT-001 review (fold): mirrors `app/owned-holding-format.tsx`'s
// `signPrefixed` -- a value that reads as zero (exact "0"/"0.00"/etc.) gets
// NO sign at all, never a fake "+0.00". A genuine negative already carries
// its own "-" from `formatDecimalFixed`/`formatDecimalTrimmed`.
function signed(value: string): string {
  if (value.startsWith("-")) return `−${value.slice(1)}`;
  if (/^0(?:\.0+)?$/.test(value)) return value;
  return `+${value}`;
}

// WLT-001 review (fold): tone is derived from the DECIMAL's own true sign
// (`compareDecimal` against zero), never by sniffing a "-" prefix on a
// rounded DISPLAY string -- a change that rounds to a "-0.00"-shaped string
// at 2dp must classify flat/neutral, not negative, and this is robust to
// that regardless of which formatting path (fixed 2dp, or the trimmed
// non-zero fallback below) produced the string actually rendered.
function changeTone(changeDecimal: DecimalFraction | null): Tone {
  if (changeDecimal === null || isZero(changeDecimal)) return "neutral";
  return compareDecimal(changeDecimal, parseDecimal("0")) < 0
    ? "negative"
    : "positive";
}

// WLT-001 review round 3 (B7, BLOCKING): `parseDecimal` THROWS on a
// malformed string. Both `previous_close_decimal` and `close_decimal` are
// written by this codebase's own validated paths but carry no DB CHECK
// enforcing decimal shape (documented ADD-COLUMN trade-off, same as
// MKT-011A's `daily_capture_interval_minutes`) -- so a stray malformed value
// must degrade only the ONE row it belongs to, never throw out of the
// `.map()` below and take the whole tab down into a false provider-error for
// every other row (reviewer-drilled). This is the AGENTS.md "missing data is
// never zero" guarantee extended one step further: malformed data is treated
// exactly like ABSENT data, never like a crash.
function tryParseDecimal(value: string): DecimalFraction | null {
  try {
    return parseDecimal(value);
  } catch {
    return null;
  }
}

// MKT-009B: mirrors `app/owned-holdings.ts`'s identical
// `providerIdsForPreference` mapping -- duplicated locally (a 10-line pure
// function) rather than imported, so this module's dependency surface stays
// as narrow as its established siblings' (same rationale
// `db/repositories/dividends.ts`'s header comment gives for re-deriving
// `isValidDateString` locally instead of importing it).
function providerIdsForPreference(
  preference:
    | "yahoo_authenticated"
    | "yahoo_anonymous"
    | "sharesight_delayed"
    | undefined,
): readonly string[] {
  switch (preference) {
    case "yahoo_authenticated":
    case "yahoo_anonymous":
      return ["yahoo-compatible"];
    case "sharesight_delayed":
    case undefined:
      return ["sharesight"];
  }
}

/** The calendar date in `timezone` for instant `instant`, or `null` if `timezone` cannot be resolved. */
function localDateInZone(instant: Date, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const result = `${values.year}-${values.month}-${values.day}`;
    return DATE_PATTERN.test(result) ? result : null;
  } catch {
    return null;
  }
}

/** "HH:MM" in `timezone` for ISO instant `observationAt`, or `null` if unresolvable. */
function localTimeOfDay(
  observationAt: string,
  timezone: string,
): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(observationAt));
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return values.hour && values.minute
      ? `${values.hour}:${values.minute}`
      : null;
  } catch {
    return null;
  }
}

function mapPriceObservation(row: Record<string, unknown>): PriceObservation {
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

function mapFxObservation(row: Record<string, unknown>): FxObservation {
  return {
    kind: "fx",
    providerId: String(row.provider_id),
    providerRevisionId:
      row.provider_revision_id === null
        ? null
        : String(row.provider_revision_id),
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
    delayedMinutes:
      row.delayed_minutes === null ? null : Number(row.delayed_minutes),
    ingestedAt: String(row.ingested_at),
    payloadSha256:
      row.payload_sha256 === null ? null : String(row.payload_sha256),
  };
}

export type LoadOwnedWatchlistOptions = {
  now?: Date;
  priceSourcePreference?:
    "yahoo_authenticated" | "yahoo_anonymous" | "sharesight_delayed";
};

export async function loadOwnedWatchlist(
  client: SqlClient,
  userId: string,
  options: LoadOwnedWatchlistOptions = {},
): Promise<WatchlistRow[]> {
  const now = options.now ?? new Date();
  const asOf = now.toISOString().slice(0, 10);
  const preferredProviderIds = providerIdsForPreference(
    options.priceSourcePreference,
  );

  const securityIdentities = await client.all<Record<string, unknown>>(
    `SELECT we.id AS entry_id, we.version, we.display_order, we.security_id,
            s.primary_currency_code AS currency_code,
            COALESCE(spm.provider_symbol, si.value, we.security_id) AS symbol,
            COALESCE(s.canonical_name, spm.provider_symbol, we.security_id) AS name
       FROM watchlist_entries we
       JOIN securities s ON s.id = we.security_id
       LEFT JOIN security_provider_mappings spm
         ON spm.security_id = we.security_id
        AND spm.provider_id = 'yahoo-compatible'
        AND spm.status = 'verified'
        AND spm.valid_from <= ?
        AND (spm.valid_to IS NULL OR spm.valid_to >= ?)
       LEFT JOIN security_identifiers si
         ON si.security_id = we.security_id
        AND si.scheme = 'ticker' AND si.valid_to IS NULL
      WHERE we.user_id = ? AND we.kind = 'security'
      ORDER BY we.display_order, we.created_at, we.id`,
    [asOf, asOf, userId],
  );
  const pairIdentities = await client.all<Record<string, unknown>>(
    `SELECT we.id AS entry_id, we.version, we.display_order,
            we.base_currency_code, we.quote_currency_code,
            cb.name AS base_name, cq.name AS quote_name
       FROM watchlist_entries we
       JOIN currencies cb ON cb.code = we.base_currency_code
       JOIN currencies cq ON cq.code = we.quote_currency_code
      WHERE we.user_id = ? AND we.kind = 'currency_pair'
      ORDER BY we.display_order, we.created_at, we.id`,
    [userId],
  );

  const orderByEntryId = new Map<string, number>();
  for (const row of [...securityIdentities, ...pairIdentities]) {
    orderByEntryId.set(String(row.entry_id), Number(row.display_order));
  }

  const securityIds = securityIdentities.map((row) => String(row.security_id));
  const priceObservations = securityIds.length
    ? await client.all<Record<string, unknown>>(
        `SELECT po.* FROM price_observations po
          WHERE po.security_id IN (${securityIds.map(() => "?").join(",")})
            AND po.market_date BETWEEN date(?, '-${MAX_LOOKBACK_DAYS} days') AND ?
            AND ((po.access_scope = 'deployment' AND po.scope_user_id IS NULL)
                 OR (po.access_scope = 'user' AND po.scope_user_id = ?))
          ORDER BY po.security_id, po.market_date DESC, po.observation_at DESC`,
        [...securityIds, asOf, asOf, userId],
      )
    : [];

  const pairs = pairIdentities.map((row) => ({
    base: String(row.base_currency_code),
    quote: String(row.quote_currency_code),
  }));
  const fxObservations = pairs.length
    ? await client.all<Record<string, unknown>>(
        `SELECT fx.* FROM fx_rate_observations fx
          WHERE fx.market_date BETWEEN date(?, '-${MAX_LOOKBACK_DAYS} days') AND ?
            AND ((fx.access_scope = 'deployment' AND fx.scope_user_id IS NULL)
                 OR (fx.access_scope = 'user' AND fx.scope_user_id = ?))
            AND (${pairs
              .map(
                () =>
                  "(fx.base_currency_code = ? AND fx.quote_currency_code = ?)",
              )
              .join(" OR ")})
          ORDER BY fx.market_date DESC, fx.observed_at DESC`,
        [
          asOf,
          asOf,
          userId,
          ...pairs.flatMap((pair) => [pair.base, pair.quote]),
        ],
      )
    : [];

  const securityRows: WatchlistRow[] = securityIdentities.map((identity) => {
    const securityId = String(identity.security_id);
    const selection = selectPriceObservation({
      asOf,
      now: now.toISOString(),
      userId,
      targetKey: securityId,
      currencyCode: String(identity.currency_code),
      observations: priceObservations
        .filter((row) => row.security_id === securityId)
        .map(mapPriceObservation),
      preferredProviderIds,
    });
    const selected = selection.selected;
    const observation = selected?.observation ?? null;
    const previous = observation?.previousCloseDecimal ?? null;
    const previousDecimal = previous ? tryParseDecimal(previous) : null;
    // WLT-001 review round 2 (F1, BLOCKING): a zero previous close is not a
    // usable baseline -- treating it as "the stock was worth $0 yesterday"
    // and computing `change = close - 0` FABRICATES a full-price movement
    // that never happened (round-1's shape rendered e.g. "+7.00" here, with
    // only the separately-guarded PERCENT correctly degrading to em-dash --
    // a change value with no matching percent is itself a silent
    // fabrication, reviewer-drilled). A zero (or otherwise unparseable)
    // previous close is therefore treated as ABSENT, not as zero: `change`
    // AND `percent` degrade together to the honest em-dash state, exactly
    // like a genuinely missing previous close already did. This also
    // removes the need for a separate `isZero`-before-`divideDecimal` guard
    // (round-1's fold fix) -- `divideDecimal` is never reached at all when
    // there is no usable previous close to divide by.
    const usablePreviousDecimal =
      previousDecimal && !isZero(previousDecimal) ? previousDecimal : null;
    // WLT-001 review round 3 (B7, BLOCKING): a malformed `close_decimal` is
    // just as possible (and just as row-local, never tab-wide) as a
    // malformed `previous_close_decimal` above -- `closeDecimal` is `null`
    // for both "no selection" and "selection present but unparseable close",
    // which is exactly the ABSENT-close case this row must already degrade
    // to (see `price`/`state` below).
    const closeDecimal = selected
      ? tryParseDecimal(selected.closeDecimal)
      : null;
    const changeDecimal =
      closeDecimal && usablePreviousDecimal
        ? subtractDecimal(closeDecimal, usablePreviousDecimal)
        : null;
    const percentDecimal =
      changeDecimal && usablePreviousDecimal
        ? multiplyDecimal(
            divideDecimal(changeDecimal, usablePreviousDecimal),
            parseDecimal("100"),
          )
        : null;
    const changeFixed = changeDecimal
      ? formatDecimalFixed(changeDecimal, 2)
      : null;
    const percentFixed = percentDecimal
      ? formatDecimalFixed(percentDecimal, 2)
      : null;
    // WLT-001 review (fold, round 2 F2 extends the SAME rule to percent):
    // never render a genuinely non-zero change OR percent as a fake
    // "0.00"/"0.00%" -- a sub-cent movement (or a sub-0.01% move) that
    // rounds away to zero at 2dp but is genuinely non-zero shows its
    // trimmed exact digits instead (AGENTS.md: missing/derived data is
    // never presented as zero). Exactly zero keeps the plain "0.00"/
    // "0.00%" -- that IS the honest value there. The two checks are
    // deliberately INDEPENDENT (round 1 gated the change fallback on the
    // PERCENT being non-zero, which both under- and over-fired -- a
    // genuinely non-zero change with a percent that ALSO happens to round
    // to zero still deserves its own trimmed digits, and vice versa).
    const changeRoundsToFakeZero =
      changeDecimal !== null &&
      !isZero(changeDecimal) &&
      changeFixed !== null &&
      /^0(?:\.0+)?$/.test(changeFixed);
    const change =
      changeDecimal !== null && changeRoundsToFakeZero
        ? formatDecimalTrimmed(changeDecimal, 6, { trimTrailingZeros: true })
        : changeFixed;
    const percentRoundsToFakeZero =
      percentDecimal !== null &&
      !isZero(percentDecimal) &&
      percentFixed !== null &&
      /^0(?:\.0+)?$/.test(percentFixed);
    const percent =
      percentDecimal !== null && percentRoundsToFakeZero
        ? formatDecimalTrimmed(percentDecimal, 6, { trimTrailingZeros: true })
        : percentFixed;
    // WLT-001 review round 3 (B7, BLOCKING): `selection.display` is truthy
    // exactly when `selected` is (see `selectPriceObservation`) -- a
    // malformed close must ALSO fail this gate, so the row renders the same
    // honest "unavailable" price/state a genuinely absent observation
    // already does, never a rendered price string paired with a crash-shaped
    // hole in `change`/`percent` elsewhere.
    const state =
      closeDecimal && selection.display ? selection.status : "unavailable";
    // Time-vs-date rule: the observation's own market-local time when its
    // market date is TODAY in that market's own timezone, else the market
    // date itself. A manual-override selection carries no `observation`
    // (no market timezone to convert into), so it always shows its date --
    // never a fabricated time.
    const todayLocal = observation
      ? localDateInZone(now, observation.marketTimezone)
      : null;
    const timeLine = selected
      ? observation && todayLocal === selected.marketDate
        ? (localTimeOfDay(
            observation.observationAt,
            observation.marketTimezone,
          ) ?? selected.marketDate)
        : selected.marketDate
      : "No business date";

    return {
      entryId: String(identity.entry_id),
      version: Number(identity.version),
      kind: "security",
      targetKey: securityId,
      symbol: String(identity.symbol),
      name: String(identity.name),
      price:
        selected && closeDecimal
          ? `${selected.currencyCode} ${selected.closeDecimal}`
          : "unavailable",
      timeLine,
      change: change ? signed(change) : "—",
      percent: percent ? `${signed(percent)}%` : "—",
      tone: changeTone(changeDecimal),
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
        delayedMinutes: observation?.delayedMinutes ?? null,
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
        ticker: String(identity.symbol),
        price: sortKey(selected?.closeDecimal ?? null),
        change: sortKey(change),
      },
    };
  });

  const pairRows: WatchlistRow[] = pairIdentities.map((identity) => {
    const base = String(identity.base_currency_code);
    const quote = String(identity.quote_currency_code);
    const targetKey = `${base}/${quote}`;
    const selection = selectFxObservation({
      asOf,
      baseCurrencyCode: base,
      quoteCurrencyCode: quote,
      targetKey,
      userId,
      observations: fxObservations
        .filter(
          (row) =>
            row.base_currency_code === base &&
            row.quote_currency_code === quote,
        )
        .map(mapFxObservation),
    });
    const selected = selection.selected;
    const state = selection.display ? selection.status : "unavailable";
    return {
      entryId: String(identity.entry_id),
      version: Number(identity.version),
      kind: "currency_pair",
      targetKey,
      symbol: targetKey,
      name: `${identity.base_name} to ${identity.quote_name}`,
      price: selected ? `${selected.rateDecimal} ${quote}` : "unavailable",
      // No `marketTimezone` field exists on `FxObservation` anywhere in this
      // codebase's domain contracts (unlike a security's own exchange
      // timezone) -- the date is always shown for a currency pair rather
      // than fabricating a "local time" with no real market to anchor it
      // to.
      timeLine: selected ? selected.marketDate : "No business date",
      // `FxObservation` carries no previous-rate field at all (unlike
      // `PriceObservation.previousCloseDecimal`) -- change is therefore
      // ALWAYS the honest em-dash state for a currency pair, never derived
      // from a second, separately-queried prior-date observation (AGENTS.md:
      // never a guessed prior date).
      change: "—",
      percent: "—",
      tone: "neutral",
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
        ticker: targetKey,
        price: sortKey(selected?.rateDecimal ?? null),
        change: sortKey(null),
      },
    };
  });

  return [...securityRows, ...pairRows].sort(
    (left, right) =>
      (orderByEntryId.get(left.entryId) ?? 0) -
      (orderByEntryId.get(right.entryId) ?? 0),
  );
}
