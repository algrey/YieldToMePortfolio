// UI-023: the compact identity line shown beside the symbol in the holding
// area's heading, shared by all three tab pages. Parts that are genuinely
// unknown (an unresolved candidate has no canonical currency) are simply
// omitted -- never rendered as a placeholder value.
import type { OwnedHoldingIdentity } from "./owned-holding-transactions.ts";

export function holdingSubtitle(identity: OwnedHoldingIdentity): string {
  return [identity.name, identity.exchange, identity.currencyCode]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
}
