// BRK-009B: two thin, pure candidate-level PRE-PASSES wrapped around
// BRK-009A's strict multi-scheme resolver (`resolve-security.ts`), built to
// close that task's carried finding F2 -- every ticker identifier this
// codebase writes today has `exchange_id = NULL` (no exchanges table row
// models a Sharesight market code), so the pure resolver's
// `ticker_active`/`ticker_historical` tiers can never fire in practice (they
// require exchange agreement on BOTH sides -- see that module's header
// comment). Without some fallback, every Sharesight security the owner has
// ALREADY attested or provider-verified through the pre-existing CSV import
// flow would silently duplicate on its first sync, because the pure resolver
// would report `no_match` for it every time.
//
// Neither wrapper changes the pure resolver's stricter semantics (its own
// module header comment forbids that) -- each only adds a SECOND, LOOSER
// check that fires only when a higher-priority stage already returned
// `no_match`, over evidence the CALLER has scoped appropriately:
//   - `resolveSecurityCandidate`'s same-user fallback: `sameUserEvidence`
//     scoped to the RESOLVING OWNER's own already-linked securities (CSV
//     verify/attest or an earlier sync).
//   - `resolveGlobalTickerCurrencyCandidate`: a THIRD, LOWEST-priority tier,
//     consulted only after BOTH the strict resolver and the same-user
//     fallback report `no_match`, over GLOBAL (cross-owner) ticker+currency
//     evidence -- `securities`/`security_identifiers` are the shared
//     canonical master (IMP-004B precedent: two different owners verifying
//     the identical provider identity dedupe onto ONE security row), so a
//     genuinely agreeing cross-owner ticker+currency match is a legitimate
//     dedupe target too, but -- exactly like the same-user tier -- ONLY when
//     no exchange evidence anywhere contradicts it.
//
// Both tiers share the identical "no contradiction = match" evaluation
// (`evaluateExchangeEvidenceMatches` below), applied to differently-scoped
// evidence:
//   1. Missing exchange evidence on EITHER side is treated as "no
//      contradiction", not "no match" (the opposite of the strict
//      resolver's own rule) -- the alternative is guaranteed duplication of
//      a security that already exists.
//   2. Evidence that ACTIVELY DISAGREES (both sides carry an exchange alias
//      and they differ), or evidence that itself resolves to more than one
//      distinct security with no way to prefer one, is a `conflict` --
//      never silently guessed, any more than the strict resolver does.
import {
  resolveSecurity,
  type ResolveSecurityCandidateIdentity,
  type ResolveSecurityOutcome,
  type SecurityIdentifierCandidateRow,
  type SecurityResolutionTier,
} from "./resolve-security.ts";

/** One piece of exchange evidence for a security some caller-scoped query
 * has already determined matches `identity`'s symbol+currency. `exchangeAlias`
 * is whatever alias string the caller assembled (`portfolio_securities.source_exchange_alias`
 * and/or `security_provider_mappings.provider_exchange`), or `null` when no
 * source carries one. The caller decides SCOPE (same-owner-only vs. global)
 * by which rows it passes in -- this type itself carries no scope
 * information. */
export type SameUserSecurityEvidenceRow = Readonly<{
  securityId: string;
  exchangeAlias: string | null;
}>;

/** The tier `resolveSecurityCandidate` reports for its own same-user
 * fallback match -- distinct from every tier `resolve-security.ts` itself
 * defines, so a conflict/match this wrapper produces is never confused with
 * one the strict resolver produced. */
export const SAME_USER_TICKER_TIER = "same_user_ticker" as const;

/** The tier `resolveGlobalTickerCurrencyCandidate` reports for its
 * cross-owner ticker+currency fallback match -- distinct from both the
 * strict resolver's tiers and `SAME_USER_TICKER_TIER`, so an auditor can
 * always tell which of the three stages actually decided a match. */
export const GLOBAL_TICKER_CURRENCY_TIER = "global_ticker_currency" as const;

export type ResolveSecurityCandidateTier =
  | SecurityResolutionTier
  | typeof SAME_USER_TICKER_TIER
  | typeof GLOBAL_TICKER_CURRENCY_TIER;

export type ResolveSecurityCandidateOutcome =
  | Readonly<{
      outcome: "matched";
      securityId: string;
      tier: ResolveSecurityCandidateTier;
    }>
  | Readonly<{
      outcome: "conflict";
      tiers: readonly ResolveSecurityCandidateTier[];
      securityIds: readonly string[];
    }>
  | Readonly<{ outcome: "no_match" }>;

function normalizeToken(value: string): string {
  return value.trim().toUpperCase();
}

type ExchangeEvidenceEvaluation =
  | { outcome: "matched"; securityId: string }
  | { outcome: "conflict"; securityIds: readonly string[] }
  | { outcome: "no_match" };

/**
 * The shared "no contradiction = match" evaluation both fallback tiers use:
 * given `identityExchangeAlias` (the candidate's own exchange evidence, or
 * `null`) and a set of `evidence` rows already pre-filtered by the caller to
 * ones whose symbol+currency agree with the identity, decide whether this
 * counts as an unambiguous match. See this module's header comment for the
 * two rulings this enforces.
 */
function evaluateExchangeEvidenceMatches(
  identityExchangeAlias: string | null,
  evidence: readonly SameUserSecurityEvidenceRow[],
): ExchangeEvidenceEvaluation {
  if (evidence.length === 0) return { outcome: "no_match" };

  const identityExchange =
    identityExchangeAlias !== null
      ? normalizeToken(identityExchangeAlias)
      : null;

  const contradicting = new Set<string>();
  const nonContradicting = new Set<string>();
  for (const row of evidence) {
    const rowExchange =
      row.exchangeAlias !== null ? normalizeToken(row.exchangeAlias) : null;
    const disagrees =
      identityExchange !== null &&
      rowExchange !== null &&
      identityExchange !== rowExchange;
    if (disagrees) {
      contradicting.add(row.securityId);
    } else {
      nonContradicting.add(row.securityId);
    }
  }

  // Any contradicting evidence, or more than one distinct non-contradicted
  // security, is ambiguous -- never guessed, always surfaced.
  if (contradicting.size > 0 || nonContradicting.size > 1) {
    return {
      outcome: "conflict",
      securityIds: [...new Set([...contradicting, ...nonContradicting])],
    };
  }

  const [securityId] = nonContradicting;
  if (securityId === undefined) return { outcome: "no_match" };
  return { outcome: "matched", securityId };
}

/**
 * Resolves `identity` first through the strict, no-I/O `resolveSecurity`
 * (tiers `sharesight_instrument` -> `isin` -> `figi` -> ticker+exchange,
 * evaluated globally over `globalIdentifiers`). Only when that reports
 * `no_match` does this wrapper apply the looser same-user ticker+currency
 * fallback over `sameUserEvidence` (already pre-filtered by the caller to
 * rows whose symbol+currency agree with `identity` and whose security is
 * already linked to the RESOLVING OWNER's own portfolio -- see this
 * module's header comment; the caller must never widen this beyond the
 * resolving owner's own linked securities). A `matched`/`conflict` outcome
 * from the strict resolver is returned completely unchanged; this wrapper
 * never overrides or second-guesses it.
 */
export function resolveSecurityCandidate(
  identity: ResolveSecurityCandidateIdentity,
  globalIdentifiers: readonly SecurityIdentifierCandidateRow[],
  sameUserEvidence: readonly SameUserSecurityEvidenceRow[],
): ResolveSecurityCandidateOutcome {
  const strict: ResolveSecurityOutcome = resolveSecurity(
    identity,
    globalIdentifiers,
  );
  if (strict.outcome !== "no_match") return strict;

  const evaluation = evaluateExchangeEvidenceMatches(
    identity.exchangeAlias,
    sameUserEvidence,
  );
  if (evaluation.outcome === "conflict") {
    return {
      outcome: "conflict",
      tiers: [SAME_USER_TICKER_TIER],
      securityIds: evaluation.securityIds,
    };
  }
  if (evaluation.outcome === "no_match") return { outcome: "no_match" };
  return {
    outcome: "matched",
    securityId: evaluation.securityId,
    tier: SAME_USER_TICKER_TIER,
  };
}

/**
 * The THIRD, lowest-priority fallback tier -- consulted only by the caller
 * AFTER both the strict resolver and `resolveSecurityCandidate`'s same-user
 * fallback have already reported `no_match` (this function does not itself
 * re-run either of those; it is a standalone evaluation over whatever
 * GLOBAL, cross-owner ticker+currency evidence the caller supplies).
 * `globalTickerCurrencyEvidence` must already be scoped by the caller to
 * securities whose ticker text and canonical currency agree with `identity`
 * -- this function only adjudicates exchange-evidence agreement among that
 * pre-filtered set, exactly like the same-user tier. Legitimate cross-owner
 * dedupe (IMP-004B precedent: `securities`/`security_identifiers` are a
 * shared canonical master) happens ONLY when identity genuinely agrees
 * (no contradicting exchange evidence); a genuine disagreement, or more than
 * one distinct security among the candidates, is a `conflict`, never a
 * silent merge.
 */
export function resolveGlobalTickerCurrencyCandidate(
  identityExchangeAlias: string | null,
  globalTickerCurrencyEvidence: readonly SameUserSecurityEvidenceRow[],
): ResolveSecurityCandidateOutcome {
  const evaluation = evaluateExchangeEvidenceMatches(
    identityExchangeAlias,
    globalTickerCurrencyEvidence,
  );
  if (evaluation.outcome === "conflict") {
    return {
      outcome: "conflict",
      tiers: [GLOBAL_TICKER_CURRENCY_TIER],
      securityIds: evaluation.securityIds,
    };
  }
  if (evaluation.outcome === "no_match") return { outcome: "no_match" };
  return {
    outcome: "matched",
    securityId: evaluation.securityId,
    tier: GLOBAL_TICKER_CURRENCY_TIER,
  };
}
