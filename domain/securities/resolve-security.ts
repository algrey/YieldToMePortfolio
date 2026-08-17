// BRK-009A: a PURE, no-I/O multi-scheme security resolver over
// caller-supplied `security_identifiers` rows. The durable identity model
// already exists (`securities` UUID PK; `security_identifiers`
// scheme/value/exchange/validity aliases -- see `docs/DATA_MODEL.md`); this
// module is the DECISION LOGIC that turns one candidate instrument identity
// (a Sharesight trade/payout's symbol/exchange/currency plus whatever
// optional durable ids BRK-009A's parse-layer capture surfaced) into a
// typed match/conflict/no-match outcome against a portfolio's already-known
// identifiers. It does not touch the database, the network, or any
// create/link decision -- BRK-009B wires this into the import pipeline and
// decides what to do with each outcome (auto-create on `no_match`, block on
// `conflict`).
//
// NEVER-MERGE-ON-TICKER-ALONE (the load-bearing safety rule this whole
// module exists to enforce): a ticker is not a durable security ID
// (AGENTS.md non-negotiable) -- the SAME ticker text can legitimately refer
// to two completely different securities (different exchanges, a delisted
// security whose ticker was later reissued, a data-entry typo that happens
// to collide). So ticker-text agreement ALONE never resolves a match: it
// only counts when the caller-supplied EXCHANGE alias also agrees (checked
// case-insensitively, using whatever alias/id string the caller supplies --
// this module has no opinion on whether that's a MIC, a DB exchange id, or
// a free-text alias), and even then only after every higher-priority durable
// identifier tier (`sharesight_instrument`, `isin`, `figi`) has already been
// checked and found no disagreeing evidence. A ticker match with no
// exchange agreement -- or no exchange evidence at all on either side -- is
// simply not a match, active or historical; it is never silently accepted
// as "close enough".

/**
 * The five tiers this resolver checks, in priority order. `ticker_active`
 * (the current, `valid_to IS NULL` ticker identifier) and `ticker_historical`
 * (a validity-closed ticker identifier -- e.g. a ticker that was later
 * renamed, the "Z1P renamed to ZIP" case) are two separate tiers over the
 * SAME `scheme = 'ticker'` value-space, split purely by `validTo`, both
 * still requiring exchange agreement (see the module header comment).
 */
export type SecurityResolutionTier =
  | "sharesight_instrument"
  | "isin"
  | "figi"
  | "ticker_active"
  | "ticker_historical";

/**
 * One caller-supplied `security_identifiers` row, denormalized with its
 * owning security's `primary_currency_code` so this module never needs a
 * separate securities lookup/join -- the caller (BRK-009B's repository
 * layer) does that join once and passes flat rows in. `scheme` is free-text
 * at the DB layer (no CHECK constraint -- see `db/schema.ts`); this module
 * only ever matches the four values in the closed set this task defines
 * (`ticker`, `sharesight_instrument`, `isin`, `figi`) and silently ignores
 * any row with a different scheme string (forward-compatible, never a
 * validation failure). `exchangeAlias` is whatever alias/id string the
 * caller resolves for this row's `exchange_id` (or `null` when the
 * identifier carries no exchange, e.g. every non-ticker scheme in practice)
 * -- compared case-insensitively against the candidate identity's own
 * `exchangeAlias`.
 */
export type SecurityIdentifierCandidateRow = Readonly<{
  securityId: string;
  scheme: string;
  value: string;
  exchangeAlias: string | null;
  validFrom: string;
  validTo: string | null;
  primaryCurrencyCode: string;
}>;

/**
 * The instrument identity being resolved. `symbol`/`currencyCode` are
 * always required (every Sharesight trade/payout carries them);
 * `exchangeAlias` may be `null` when the caller has no exchange evidence at
 * all, in which case no ticker tier can ever match (see the module header
 * comment) -- only the durable-id tiers remain reachable.
 * `sharesightInstrumentId`/`isin`/`figi` are OPTIONAL/absent-tolerant,
 * mirroring BRK-009A's parse-layer capture: omit or pass `null`/`undefined`
 * when the source evidence didn't carry one, and that tier is simply
 * skipped (no evidence to check, not a failure).
 */
export type ResolveSecurityCandidateIdentity = Readonly<{
  symbol: string;
  exchangeAlias: string | null;
  currencyCode: string;
  sharesightInstrumentId?: string | null;
  isin?: string | null;
  figi?: string | null;
}>;

export type ResolveSecurityOutcome =
  | Readonly<{
      outcome: "matched";
      securityId: string;
      tier: SecurityResolutionTier;
    }>
  | Readonly<{
      outcome: "conflict";
      /** The distinct tiers whose evidence disagreed (never picked between,
       * never merged) -- de-duplicated; length 1 when a SINGLE tier's own
       * rows disagreed with each other or when a single tier's match
       * disagreed on currency, length 2 when two DIFFERENT tiers each
       * cleanly resolved to a different security. */
      tiers: readonly SecurityResolutionTier[];
      /** The distinct, disagreeing security ids named in the conflict --
       * always at least one entry, at least two when the disagreement is
       * between two different securities (same-tier or cross-tier); a
       * single-entry array covers the currency-disagreement case, where
       * only one candidate security exists but its currency evidence
       * contradicts the requested identity (see the module header comment's
       * "never a skip" rule). */
      securityIds: readonly string[];
    }>
  | Readonly<{ outcome: "no_match" }>;

const TIER_ORDER: readonly SecurityResolutionTier[] = [
  "sharesight_instrument",
  "isin",
  "figi",
  "ticker_active",
  "ticker_historical",
];

/** The DB `scheme` value each tier matches against -- `ticker_active` and
 * `ticker_historical` share the same `'ticker'` scheme, split by validity
 * below (`rowMatchesTier`). */
const TIER_SCHEME: Readonly<Record<SecurityResolutionTier, string>> = {
  sharesight_instrument: "sharesight_instrument",
  isin: "isin",
  figi: "figi",
  ticker_active: "ticker",
  ticker_historical: "ticker",
};

function isTickerTier(tier: SecurityResolutionTier): boolean {
  return tier === "ticker_active" || tier === "ticker_historical";
}

/**
 * Case-insensitive token normalization, shared with
 * `domain/securities/verify-identity.ts`'s `normalizeToken` convention
 * (this module intentionally re-derives it rather than importing across a
 * boundary that has no other reason to depend on the verify-identity
 * module, keeping this file's only dependency surface its own types) --
 * every value/exchange/currency comparison in this resolver is
 * case-insensitive, matching this codebase's established
 * `UPPER(value) = ?` ticker-comparison convention (IMP-009).
 */
function normalizeToken(value: string): string {
  return value.trim().toUpperCase();
}

/** The candidate VALUE this tier is checking for (`null` when the candidate
 * identity carries no evidence for this tier at all -- e.g. no
 * `sharesightInstrumentId` supplied -- in which case the tier is skipped
 * entirely, not treated as a failed match). */
function tierCandidateValue(
  identity: ResolveSecurityCandidateIdentity,
  tier: SecurityResolutionTier,
): string | null {
  switch (tier) {
    case "sharesight_instrument": {
      const value = identity.sharesightInstrumentId;
      return value && value.trim().length > 0 ? value : null;
    }
    case "isin": {
      const value = identity.isin;
      return value && value.trim().length > 0 ? value : null;
    }
    case "figi": {
      const value = identity.figi;
      return value && value.trim().length > 0 ? value : null;
    }
    case "ticker_active":
    case "ticker_historical":
      return identity.symbol;
  }
}

/**
 * Whether `row` is evidence for `tier` given `candidateValue` (already
 * confirmed non-null by the caller). Ticker tiers additionally REQUIRE
 * exchange agreement (never matches on ticker text alone -- the module
 * header comment's load-bearing rule) and split active/historical purely on
 * `validTo`; the three durable-id tiers (`sharesight_instrument`/`isin`/
 * `figi`) only ever match the row's CURRENTLY ACTIVE identifier (`validTo
 * IS NULL`) -- this task defines no historical variant for those schemes
 * (unlike `ticker`, nothing in this task ever supersedes one).
 */
function rowMatchesTier(
  row: SecurityIdentifierCandidateRow,
  tier: SecurityResolutionTier,
  candidateValue: string,
  identity: ResolveSecurityCandidateIdentity,
): boolean {
  if (row.scheme !== TIER_SCHEME[tier]) return false;
  if (normalizeToken(row.value) !== normalizeToken(candidateValue)) {
    return false;
  }
  const isHistorical = row.validTo !== null;
  if (isTickerTier(tier)) {
    if (tier === "ticker_active" && isHistorical) return false;
    if (tier === "ticker_historical" && !isHistorical) return false;
    // Never-merge-on-ticker-alone: no exchange evidence on either side means
    // no agreement is possible, so this row is simply not a match -- never a
    // conflict, never a fallback "close enough" accept.
    if (identity.exchangeAlias === null || row.exchangeAlias === null) {
      return false;
    }
    if (
      normalizeToken(row.exchangeAlias) !==
      normalizeToken(identity.exchangeAlias)
    ) {
      return false;
    }
  } else if (isHistorical) {
    return false; // durable-id tiers: active identifier only, see doc comment
  }
  return true;
}

/**
 * Resolves `identity` against `identifiers` in tier-priority order
 * (`sharesight_instrument` -> `isin` -> `figi` -> active ticker+exchange ->
 * historical ticker+exchange), applying currency agreement (case-insensitive)
 * as a REQUIRED check at every tier a value match is found -- a
 * value/exchange match whose security's `primaryCurrencyCode` disagrees
 * with `identity.currencyCode` is a `conflict`, never silently skipped to
 * try the next tier (an otherwise-matching identifier that disagrees on
 * currency is itself suspicious evidence, not absence of evidence).
 *
 * Every tier with any candidate value is evaluated (not just the first
 * that matches), because tier PRIORITY only decides which tier's result is
 * REPORTED when every tier that matched agrees on the same security -- it
 * never decides which of two DISAGREEING tiers to believe. If a
 * higher-priority tier resolves to security A and a lower-priority tier
 * independently resolves the SAME candidate identity to a different
 * security B, that is exactly the ambiguous state this resolver must never
 * silently paper over by picking A because it came first -- it is reported
 * as a `conflict` naming both tiers and both ids instead.
 */
export function resolveSecurity(
  identity: ResolveSecurityCandidateIdentity,
  identifiers: readonly SecurityIdentifierCandidateRow[],
): ResolveSecurityOutcome {
  let established: {
    securityId: string;
    tier: SecurityResolutionTier;
  } | null = null;

  for (const tier of TIER_ORDER) {
    const candidateValue = tierCandidateValue(identity, tier);
    if (candidateValue === null) continue; // no evidence for this tier at all

    const matchingRows = identifiers.filter((row) =>
      rowMatchesTier(row, tier, candidateValue, identity),
    );
    if (matchingRows.length === 0) continue;

    const distinctSecurityIds = [
      ...new Set(matchingRows.map((row) => row.securityId)),
    ];
    const currencyDisagrees = matchingRows.some(
      (row) =>
        normalizeToken(row.primaryCurrencyCode) !==
        normalizeToken(identity.currencyCode),
    );

    // Currency disagreement, or two rows within this SAME tier resolving to
    // different securities, is a conflict at THIS tier -- reported
    // immediately, never silently resolved by picking one (module header
    // comment).
    if (currencyDisagrees || distinctSecurityIds.length > 1) {
      return {
        outcome: "conflict",
        tiers: [tier],
        securityIds: distinctSecurityIds,
      };
    }

    const tierSecurityId = distinctSecurityIds[0]!;
    if (established === null) {
      established = { securityId: tierSecurityId, tier };
    } else if (established.securityId !== tierSecurityId) {
      // Cross-tier conflict: a higher-priority tier already resolved to a
      // DIFFERENT security than this one -- never picked between.
      return {
        outcome: "conflict",
        tiers: [established.tier, tier],
        securityIds: [established.securityId, tierSecurityId],
      };
    }
    // Same security as already established -- extra confirmatory evidence,
    // keep the higher-priority tier as the reported one and keep checking
    // the remaining tiers for a possible later disagreement.
  }

  if (established) {
    return {
      outcome: "matched",
      securityId: established.securityId,
      tier: established.tier,
    };
  }
  return { outcome: "no_match" };
}
