// UI-023: the per-holding detail area's chrome -- the back control that
// returns to the Holdings tab, the holding's compact identity line, and the
// three sub-tabs (News / Details / Transactions). One list, rendered by
// every holding view including degraded states, mirroring `income-nav.tsx`
// exactly so the two sub-areas cannot drift apart.
import { SubNav } from "./sub-nav";

export type HoldingView = "news" | "details" | "transactions";

const HOLDING_VIEWS: readonly {
  key: HoldingView;
  label: string;
  href: (portfolioId: string, portfolioSecurityId: string) => string;
}[] = [
  {
    key: "news",
    label: "News",
    href: (id, sid) => `/portfolio/${id}/holdings/${sid}/news`,
  },
  {
    key: "details",
    label: "Details",
    // Details is the area's landing view, so it owns the bare holding URL.
    href: (id, sid) => `/portfolio/${id}/holdings/${sid}`,
  },
  {
    key: "transactions",
    label: "Transactions",
    href: (id, sid) => `/portfolio/${id}/holdings/${sid}/transactions`,
  },
];

/** Back control target: the Holdings primary tab this area was entered from. */
export function holdingBackHref(portfolioId: string): string {
  return `/portfolio/${portfolioId}/holdings`;
}

export function HoldingNav({
  portfolioId,
  portfolioSecurityId,
  symbol,
  subtitle,
  active,
}: {
  portfolioId: string;
  portfolioSecurityId: string;
  /** Omitted only on degraded states where the identity could not be
   * loaded -- the heading then reads as a generic eyebrow, never a
   * fabricated symbol. */
  symbol?: string;
  /** Muted identity line beside the symbol, e.g. "Name · ASX · AUD". */
  subtitle?: string;
  active: HoldingView;
}) {
  return (
    <SubNav
      backHref={holdingBackHref(portfolioId)}
      backLabel="Back to holdings"
      heading={
        symbol ? (
          <>
            <h1 className="subnav-title">{symbol}</h1>
            {subtitle ? <p className="subnav-subtitle">{subtitle}</p> : null}
          </>
        ) : (
          <p className="eyebrow">Holding</p>
        )
      }
      tabs={HOLDING_VIEWS.map((view) => ({
        key: view.key,
        label: view.label,
        href: view.href(portfolioId, portfolioSecurityId),
      }))}
      active={active}
      tabsLabel="Holding views"
    />
  );
}

// UI-023: shared degraded state for the holding pages -- like the Income
// pages' *Unavailable components, it still renders the area chrome (back
// control + tabs) so an owner is never stranded on a dead-end page.
export function HoldingAreaUnavailable({
  portfolioId,
  portfolioSecurityId,
  active,
  message,
}: {
  portfolioId: string;
  portfolioSecurityId: string;
  active: HoldingView;
  message: string;
}) {
  return (
    <main className="income-screen holding-screen">
      <HoldingNav
        portfolioId={portfolioId}
        portfolioSecurityId={portfolioSecurityId}
        active={active}
      />
      <section
        className="empty-state"
        aria-labelledby="holding-area-unavailable"
      >
        <h2 id="holding-area-unavailable">This holding is unavailable</h2>
        <p>{message}</p>
      </section>
    </main>
  );
}
