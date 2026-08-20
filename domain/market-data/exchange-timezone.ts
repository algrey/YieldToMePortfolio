// MKT-008: derives an honest `observation_at` UTC instant from a bare
// exchange-local trading date, for the owner price-history CSV import.
//
// The `exchanges` table (db/schema.ts) carries a `timezone` column in
// principle, but it is UNPOPULATED in this deployment today (BRK-009A
// carried finding F2: no exchange rows have ever been seeded), and this
// task's owner directive scopes the feature to Intelligent Investor's
// ASX-only export ("the three-letter ASX code", settings "defaulting
// ASX/AUD"). Rather than invent exchange metadata this codebase does not
// actually have, this module keeps a small, EXPLICIT allow-list of the
// exchange aliases the settings form may choose, each mapped to its real
// IANA timezone -- honest by construction: an exchange alias this list does
// not recognise is rejected (never defaults to a guessed timezone). Adding a
// future exchange is a one-line addition here, never a schema change --
// matches this task's "future sources must fit" ruling for the CSV shape
// itself.
const KNOWN_EXCHANGE_TIMEZONES: Readonly<Record<string, string>> = {
  ASX: "Australia/Sydney",
};

export function resolveExchangeTimezone(exchangeAlias: string): string | null {
  const normalized = exchangeAlias.trim().toUpperCase();
  return KNOWN_EXCHANGE_TIMEZONES[normalized] ?? null;
}

function utcOffsetMinutesAt(
  instantMs: number,
  timeZone: string,
): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instantMs));
    const map = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const asUtc = Date.UTC(
      Number(map.get("year")),
      Number(map.get("month")) - 1,
      Number(map.get("day")),
      Number(map.get("hour")),
      Number(map.get("minute")),
      Number(map.get("second")),
    );
    if (!Number.isFinite(asUtc)) return null;
    return Math.round((asUtc - instantMs) / 60_000);
  } catch {
    return null;
  }
}

/**
 * Converts a bare exchange-local trading date into the UTC instant of
 * MIDNIGHT on that date in `timeZone` -- the "midnight-Sydney convention"
 * this task's ruling requires: the file supplies only a trading DATE (its
 * own `HH:MM:SS`, when present, is discarded by `price-csv.ts` -- it is
 * never genuine intraday precision, just an export artifact), so this
 * function never fabricates a time-of-day beyond an explicit, documented
 * midnight placeholder. Two-step DST-safe: the first pass estimates the
 * offset from a UTC-midnight probe, the second re-evaluates the offset at
 * the resulting candidate instant (correct even on the exchange's own DST
 * transition day, when the two evaluations could disagree by an hour).
 */
export function deriveMidnightObservationAtUtc(
  marketDate: string,
  timeZone: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(marketDate)) return null;
  const guessMs = Date.parse(`${marketDate}T00:00:00Z`);
  if (!Number.isFinite(guessMs)) return null;
  const firstOffset = utcOffsetMinutesAt(guessMs, timeZone);
  if (firstOffset === null) return null;
  const candidateMs = guessMs - firstOffset * 60_000;
  const secondOffset = utcOffsetMinutesAt(candidateMs, timeZone);
  if (secondOffset === null) return null;
  const finalMs = guessMs - secondOffset * 60_000;
  const iso = new Date(finalMs).toISOString();
  return Number.isFinite(finalMs) ? iso : null;
}
