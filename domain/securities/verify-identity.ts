import type { SecurityCandidate } from "../market-data/contracts.ts";

// IMP-004B: the server-side "verify security" flow evaluates a provider
// search result against the owner's requested (symbol, exchange, currency)
// before the shared `securities` master is ever written. This module is
// pure decision logic -- no I/O, no persistence -- so the match rule stays
// independently testable from both the provider adapter and the repository.

export type SecurityIdentityRequest = {
  symbol: string;
  exchangeAlias: string | null;
  currencyCode: string;
};

export type VerifiedSecurityIdentity = {
  // The provider's own symbol/exchange strings become the identity key
  // recorded on `security_provider_mappings` (provider_symbol/provider_exchange)
  // -- never the raw, unverified owner-submitted request fields.
  providerSymbol: string;
  providerExchange: string | null;
  currencyCode: string;
  name: string;
  assetType: "equity" | "etf" | "fund";
};

export type SecurityIdentityVerificationFailureReason =
  "not_found" | "ambiguous" | "mismatched";

export type SecurityIdentityVerificationOutcome =
  | { ok: true; identity: VerifiedSecurityIdentity }
  | {
      ok: false;
      reason: SecurityIdentityVerificationFailureReason;
      message: string;
    };

function normalizeToken(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Applies the evidence-based match rule (AGENTS.md non-negotiables: a
 * ticker alone is never a durable security ID; market-data currency/
 * timezone/source must be recorded, never assumed): a provider candidate
 * only counts as verification evidence for `request` when its symbol
 * matches exactly (case-insensitive) AND its currency agrees AND -- when
 * the owner's row supplied an exchange alias -- its exchange agrees too.
 * Zero agreeing candidates is `not_found` (no symbol match at all) or
 * `mismatched` (a symbol matched but currency/exchange disagreed); more
 * than one agreeing candidate is `ambiguous`. Only exactly one agreeing
 * candidate is safe to publish.
 */
export function evaluateSecurityIdentityCandidates(
  request: SecurityIdentityRequest,
  candidates: readonly SecurityCandidate[],
): SecurityIdentityVerificationOutcome {
  const requestedSymbol = normalizeToken(request.symbol);
  const requestedCurrency = normalizeToken(request.currencyCode);
  const requestedExchange =
    request.exchangeAlias && request.exchangeAlias.trim().length > 0
      ? normalizeToken(request.exchangeAlias)
      : null;

  const symbolMatches = candidates.filter(
    (candidate) => normalizeToken(candidate.symbol) === requestedSymbol,
  );
  if (symbolMatches.length === 0) {
    return {
      ok: false,
      reason: "not_found",
      message: "The provider found no security matching this symbol.",
    };
  }

  const agreed = symbolMatches.filter((candidate) => {
    if (
      candidate.currencyCode === null ||
      normalizeToken(candidate.currencyCode) !== requestedCurrency
    ) {
      return false;
    }
    if (requestedExchange === null) return true;
    return (
      candidate.exchangeId !== null &&
      normalizeToken(candidate.exchangeId) === requestedExchange
    );
  });

  if (agreed.length === 0) {
    return {
      ok: false,
      reason: "mismatched",
      message: "The provider's match does not agree on currency and exchange.",
    };
  }
  if (agreed.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message:
        "More than one provider match agrees; verification cannot proceed automatically.",
    };
  }

  const match = agreed[0]!;
  return {
    ok: true,
    identity: {
      providerSymbol: match.symbol,
      providerExchange: match.exchangeId,
      // Canonicalize to upper case before this ever reaches
      // `securities.primary_currency_code`: the agreement check above is
      // case-insensitive (`normalizeToken`), so a lower-case provider value
      // (e.g. "aud") would otherwise pass verification here and only fail
      // later against the `currencies` FK, inside the repository's opaque
      // catch block.
      currencyCode: normalizeToken(match.currencyCode ?? requestedCurrency),
      name: match.name,
      assetType: match.assetType,
    },
  };
}
