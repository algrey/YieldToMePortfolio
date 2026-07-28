import { notFound } from "next/navigation";
import {
  PortfolioShell,
  portfolioSections,
  type PortfolioSection,
} from "../../../components/portfolio-shell";

type PortfolioSectionPageProps = {
  params: Promise<{ portfolioId: string; section: string }>;
};

export default async function PortfolioSectionPage({
  params,
}: PortfolioSectionPageProps) {
  const { section } = await params;

  if (!portfolioSections.includes(section as PortfolioSection)) {
    notFound();
  }

  return <PortfolioShell activeSection={section as PortfolioSection} />;
}
