import { notFound } from "next/navigation";
import {
  PortfolioShell,
  type PortfolioSection,
} from "../../../components/portfolio-shell";

const portfolioSections = [
  "overview",
  "holdings",
  "quotes",
  "details",
  "news",
] as const;

type PortfolioSectionPageProps = {
  params: Promise<{ portfolioId: string; section: string }>;
};

export default async function PortfolioSectionPage({
  params,
}: PortfolioSectionPageProps) {
  const { portfolioId, section } = await params;

  if (portfolioId !== "preview") {
    notFound();
  }

  if (!portfolioSections.includes(section as PortfolioSection)) {
    notFound();
  }

  return (
    <PortfolioShell
      activeSection={section as PortfolioSection}
      reviewBadgeLabel="Fixture market data"
      reviewNote="Static review build · fixture market data · no financial writes"
    />
  );
}
