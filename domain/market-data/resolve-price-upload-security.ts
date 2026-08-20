// MKT-008: resolves a price-history CSV's ticker (plus the settings'
// exchange/currency, defaulting ASX/AUD) against the OWNER'S OWN existing
// securities -- never creates. This is deliberately much simpler than
// `domain/securities/resolve-security.ts`/`resolve-security-candidate.ts`
// (BRK-009A/BRK-009B's multi-tier durable-id resolver with auto-create):
// this task's binding ruling is "no match -> honest error naming the
// ticker (no auto-create from a price file -- prices for a security the
// owner doesn't hold are meaningless here)", so there is no creation tier
// to wrap, and no cross-owner dedupe tier either (a price file only ever
// targets a security THIS owner already holds evidence for).
//
// The caller (`db/repositories/price-uploads.ts`) assembles same-user
// evidence rows already filtered to ticker+currency agreement (mirroring
// `resolve-security-candidate.ts`'s `SameUserSecurityEvidenceRow` shape and
// its caller-scoping contract); this module only adjudicates EXCHANGE
// evidence among that pre-filtered set.
//
// Review B3 fix (2026-08-21): the original version collapsed "exactly one
// candidate security, but it disagrees on exchange" into the SAME generic
// "ambiguous" outcome as "genuinely more than one distinct candidate
// security" -- both surfaced the unhelpful "matches more than one security"
// wording even when there was only ever ONE security in play. These are
// different, actionable situations: a single disagreeing candidate almost
// always means the owner typed the wrong exchange in the settings form (an
// honest, specific, correctable message names it: `held on X, not Y --
// check the exchange setting`); genuine ambiguity (two or more DISTINCT
// securities the ticker+currency could mean) has no single correction to
// suggest and must list every candidate instead. `exchange_mismatch` fires
// ONLY when every distinct security in the pre-filtered evidence collapses
// to ONE id and at least one of its evidence rows disagrees; `ambiguous`
// fires when more than one distinct security id remains, exactly like
// before.

export type PriceUploadSecurityEvidenceRow = Readonly<{
  securityId: string;
  canonicalName: string;
  exchangeAlias: string | null;
}>;

export type ResolvePriceUploadSecurityOutcome =
  | Readonly<{ outcome: "matched"; securityId: string; canonicalName: string }>
  | Readonly<{ outcome: "no_match" }>
  | Readonly<{
      outcome: "exchange_mismatch";
      securityId: string;
      canonicalName: string;
      /** The exchange the owner's OWN evidence actually names for this
       * security -- never null (this outcome only fires when a
       * contradicting row supplied one). */
      heldExchangeAlias: string;
    }>
  | Readonly<{
      outcome: "ambiguous";
      candidates: readonly PriceUploadSecurityEvidenceRow[];
    }>;

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * `evidence` must already be scoped by the caller to securities belonging
 * to the resolving owner whose ticker text and currency agree with the
 * upload's settings -- this function only adjudicates `exchangeAlias`
 * agreement among that pre-filtered set. `exchangeAlias` is the settings
 * form's own value (e.g. "ASX", defaulting from the owner's settings),
 * never `null` in practice for this feature (the settings field is
 * required), but accepted as `null` for symmetry with the same evaluation
 * this mirrors elsewhere in the codebase. Missing exchange evidence on
 * either side is treated as "no contradiction" (the alternative would make
 * a security with no recorded exchange alias permanently unmatchable); any
 * ACTUAL disagreement is never silently ignored.
 */
export function resolvePriceUploadSecurity(
  exchangeAlias: string | null,
  evidence: readonly PriceUploadSecurityEvidenceRow[],
): ResolvePriceUploadSecurityOutcome {
  if (evidence.length === 0) return { outcome: "no_match" };

  const identityExchange =
    exchangeAlias !== null ? normalize(exchangeAlias) : null;

  const contradicting = new Set<string>();
  const nonContradicting = new Map<string, PriceUploadSecurityEvidenceRow>();
  // The first contradicting evidence row seen per security -- its
  // `exchangeAlias` is guaranteed non-null (that is what made it
  // contradict), so it is the source for `heldExchangeAlias` below.
  const contradictingEvidence = new Map<
    string,
    PriceUploadSecurityEvidenceRow
  >();
  const byId = new Map<string, PriceUploadSecurityEvidenceRow>();
  for (const row of evidence) {
    byId.set(row.securityId, row);
    const rowExchange =
      row.exchangeAlias !== null ? normalize(row.exchangeAlias) : null;
    const disagrees =
      identityExchange !== null &&
      rowExchange !== null &&
      identityExchange !== rowExchange;
    if (disagrees) {
      contradicting.add(row.securityId);
      if (!contradictingEvidence.has(row.securityId)) {
        contradictingEvidence.set(row.securityId, row);
      }
    } else {
      nonContradicting.set(row.securityId, row);
    }
  }

  const distinctIds = new Set([...contradicting, ...nonContradicting.keys()]);

  // Genuine ambiguity: more than one DISTINCT security is in play at all,
  // regardless of which ones individually agree or disagree -- there is no
  // single correction to suggest, so every candidate is listed.
  if (distinctIds.size > 1) {
    return {
      outcome: "ambiguous",
      candidates: [...distinctIds].map((id) => byId.get(id)!),
    };
  }

  const [onlyId] = distinctIds;
  if (onlyId === undefined) return { outcome: "no_match" };

  // Exactly one distinct security -- if ANY of its evidence disagrees with
  // the settings' exchange, name the actual held exchange rather than the
  // generic "ambiguous" wording (B3): this is a wrong-setting correction,
  // not a genuine multi-candidate conflict.
  if (contradicting.has(onlyId)) {
    const row = contradictingEvidence.get(onlyId)!;
    return {
      outcome: "exchange_mismatch",
      securityId: onlyId,
      canonicalName: row.canonicalName,
      heldExchangeAlias: row.exchangeAlias!,
    };
  }

  const winner = byId.get(onlyId)!;
  return {
    outcome: "matched",
    securityId: winner.securityId,
    canonicalName: winner.canonicalName,
  };
}
