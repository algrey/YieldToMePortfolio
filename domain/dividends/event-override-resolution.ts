// DIV-001 BINDING requirement (MKT-005 review, 2026-08-13): an owner
// override on `dividend_event_overrides` stays keyed to whichever event id
// was active when the owner created it. Supersession mints a NEW event id
// for a corrected provider fact and moves the prior row's status to
// `superseded` -- it never rewrites or re-keys an existing override. A
// naive lookup of "is there an override for the security's CURRENT active
// event" therefore MISSES an override attached to a now-superseded prior
// version, which is the OPPOSITE of the intended "the override still wins
// over the corrected provider value" behaviour. Resolving this correctly
// requires walking the `supersedes_event_id` chain from the current active
// event backward through every prior version and checking each id for an
// override -- `collectEventLineageIds`
// (`domain/market-data/corporate-action-ingestion.ts`) supplies exactly
// that ordered lineage; this module is the resolution step the MKT-005
// review explicitly deferred to DIV-001.
import { collectEventLineageIds } from "../market-data/corporate-action-ingestion.ts";

export type EventOverrideLineageNode = {
  id: string;
  supersedesEventId: string | null;
};

export type EventOverrideFact = {
  dividendEventId: string;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
  frankingCreditPerShareDecimal: string | null;
  exclude: boolean;
};

/**
 * Given a security's full event set (active AND superseded -- required to
 * walk the lineage) and the CURRENT active event's id, returns the override
 * attached to that event OR any version it supersedes, if one exists.
 * Overrides are keyed uniquely per `(user, portfolio, security, event)`, so
 * at most one lineage id can match; the first match walking from the
 * active event backward is authoritative.
 */
export function resolveEventOverrideForLineage(
  events: readonly EventOverrideLineageNode[],
  activeEventId: string,
  overrides: readonly EventOverrideFact[],
): EventOverrideFact | null {
  const lineageIds = collectEventLineageIds(events, activeEventId);
  const overrideByEventId = new Map(
    overrides.map((override) => [override.dividendEventId, override]),
  );
  for (const id of lineageIds) {
    const match = overrideByEventId.get(id);
    if (match) return match;
  }
  return null;
}
