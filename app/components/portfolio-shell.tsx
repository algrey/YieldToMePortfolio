import Link from "next/link";
import { BrandMark } from "./brand-mark";
import { ServiceWorkerRegistration } from "./service-worker-registration";

export const portfolioSections = [
  "overview",
  "holdings",
  "quotes",
  "details",
  "news",
] as const;

export type PortfolioSection = (typeof portfolioSections)[number];

const sectionDetails: Record<
  PortfolioSection,
  { title: string; description: string }
> = {
  overview: {
    title: "Overview foundation",
    description:
      "The responsive portfolio summary will live here once the owned ledger and calculation engine are implemented.",
  },
  holdings: {
    title: "Holdings foundation",
    description:
      "This route will present explainable positions, cost basis, value, and coverage without hiding missing market data.",
  },
  quotes: {
    title: "Quotes foundation",
    description:
      "End-of-day prices, foreign exchange, source timestamps, and manual overrides will be added behind a provider-neutral boundary.",
  },
  details: {
    title: "Details foundation",
    description:
      "Portfolio settings, the immutable ledger, import history, mappings, and correction workflows will live here.",
  },
  news: {
    title: "News is intentionally deferred",
    description:
      "This navigation point is preserved from the reference, but no news source will be added without a licensing and privacy decision.",
  },
};

function sectionHref(section: PortfolioSection) {
  return section === "overview" ? "/" : `/portfolio/preview/${section}`;
}

export function PortfolioShell({
  activeSection,
}: {
  activeSection: PortfolioSection;
}) {
  const detail = sectionDetails[activeSection];

  return (
    <div className="app-frame">
      <ServiceWorkerRegistration />
      <header className="topbar">
        <Link className="brand" href="/" aria-label="YieldToMe home">
          <BrandMark />
          <span className="wordmark">YieldToMe</span>
        </Link>
        <span className="foundation-status">
          <span className="status-dot" aria-hidden="true" />
          Foundation ready
        </span>
      </header>

      <main className="workspace">
        <section
          className="workspace-heading"
          aria-labelledby="workspace-title"
        >
          <div>
            <p className="eyebrow">Private portfolio workspace</p>
            <h1 id="workspace-title">Portfolio scaffold</h1>
          </div>
          <button className="portfolio-selector" type="button" disabled>
            No portfolio connected
            <span aria-hidden="true">⌄</span>
          </button>
        </section>

        <nav className="section-tabs" aria-label="Portfolio sections">
          {portfolioSections.map((section) => (
            <Link
              key={section}
              href={sectionHref(section)}
              aria-current={activeSection === section ? "page" : undefined}
            >
              {section}
            </Link>
          ))}
        </nav>

        <section className="foundation-panel" aria-labelledby="section-title">
          <div className="foundation-copy">
            <p className="eyebrow">Scaffold preview</p>
            <h2 id="section-title">{detail.title}</h2>
            <p>{detail.description}</p>
          </div>
          <div className="scope-note">
            <span className="scope-icon" aria-hidden="true">
              i
            </span>
            <p>
              Authentication, portfolio data, imports, calculations, and market
              feeds are deliberately not connected in this pass.
            </p>
          </div>
        </section>

        <section className="foundation-grid" aria-label="Foundation boundaries">
          <article>
            <span className="panel-number">01</span>
            <h3>Ledger first</h3>
            <p>
              Immutable transactions, cash, and FIFO lots will become the source
              of truth.
            </p>
            <span className="pending-label">Not implemented</span>
          </article>
          <article>
            <span className="panel-number">02</span>
            <h3>Explicit provenance</h3>
            <p>
              Prices and FX will carry source, currency, as-of time, and
              freshness.
            </p>
            <span className="pending-label">Not connected</span>
          </article>
          <article>
            <span className="panel-number">03</span>
            <h3>Private by design</h3>
            <p>
              Cloudflare Access identity will be paired with server-enforced
              ownership.
            </p>
            <span className="pending-label">Specified only</span>
          </article>
        </section>
      </main>

      <footer className="footer">
        <BrandMark />
        <p>Built for calm, explainable portfolio decisions.</p>
      </footer>
    </div>
  );
}
