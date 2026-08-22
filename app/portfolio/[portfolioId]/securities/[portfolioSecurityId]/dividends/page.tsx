import { redirect } from "next/navigation";

// UI-023C (owner-reported): this route was the per-security Dividends
// screen's home (UI-006C) but sat outside the holding area's chrome -- an
// orphan with no way back to the ticker's other views. The screen now lives
// as the holding area's fourth sub-tab at
// `/portfolio/:id/holdings/:portfolioSecurityId/dividends`
// (`app/portfolio/[portfolioId]/[section]/[holdingId]/dividends/page.tsx`,
// where all loading and owner-scoping now happens); this route survives
// only so old links and bookmarks keep working. The redirect embeds nothing
// but the ids already present in the requested URL, so no ownership check
// is needed here -- the destination page enforces all of them.
export const dynamic = "force-dynamic";

type LegacySecurityDividendsPageProps = {
  params: Promise<{ portfolioId: string; portfolioSecurityId: string }>;
};

export default async function LegacySecurityDividendsPage({
  params,
}: LegacySecurityDividendsPageProps) {
  const { portfolioId, portfolioSecurityId } = await params;
  redirect(
    `/portfolio/${portfolioId}/holdings/${portfolioSecurityId}/dividends`,
  );
}
