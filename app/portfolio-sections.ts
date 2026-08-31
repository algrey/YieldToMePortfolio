// Shared, server-safe list of the primary portfolio tab/section identifiers.
// Deliberately NOT "use client" -- `app/components/portfolio-shell.tsx` (a
// client component) and server components (`app/page.tsx`,
// `app/portfolio/[portfolioId]/[section]/page.tsx`) both need the RUNTIME
// array, not just the type. A "use client" module's runtime exports become
// opaque client references when imported into a server component (verified:
// importing `portfolioSections` from portfolio-shell.tsx into app/page.tsx
// broke `.includes()` at request time with "not a function"), so this list
// lives in its own plain module with no client/server affinity, letting
// every caller import the SAME array instead of hand-maintaining copies
// that can drift out of sync.
export const portfolioSections = [
  "overview",
  "holdings",
  "quotes",
  "details",
  "news",
] as const;

export type PortfolioSection = (typeof portfolioSections)[number];

/**
 * Validates a raw `?section=` search-param value (UI-024) against the known
 * primary sections, falling back to "overview" for anything unrecognised --
 * an absent value, a malformed string, OR an array (a repeated `?section=`
 * key parses to `string[]`, never a `PortfolioSection`). Never throws, never
 * guesses a section that doesn't exist.
 */
export function resolveSectionSearchParam(
  section: string | string[] | undefined,
): PortfolioSection {
  return typeof section === "string" &&
    portfolioSections.includes(section as PortfolioSection)
    ? (section as PortfolioSection)
    : "overview";
}

/**
 * UI-024 review (BLOCKING fix): `app/page.tsx`'s workspace load only ever
 * requests overview data (`includeOverview: true`), so once an active
 * portfolio exists, rendering `/?section=quotes|holdings|details` directly
 * on that route -- reachable via a bookmark or a back-button history entry
 * the tab bar's own no-portfolio `/?section=...` fallback creates -- would
 * show a FALSE empty/unavailable state on a populated portfolio instead of
 * real data. Returns the real portfolio-scoped path to redirect to, or
 * `null` when no redirect is needed: no active portfolio yet (the
 * no-portfolio fallback renders in place, unchanged), or the requested
 * section is "overview" (this route's own load already serves it
 * correctly).
 *
 * UI-051 (superseded-at-route-level, reviewer follow-up): `app/page.tsx`
 * now redirects to `/portfolio/:id/holdings` for ANY request to `/` once an
 * active portfolio exists (via `loadAuthenticatedWorkspace`'s
 * `landingRedirectOut` slot), checked BEFORE this function is ever called --
 * so in the real route, `activePortfolioId` is now always `null` by the time
 * this function runs, and its non-null-id branch above is unreachable in
 * practice. Retained, unchanged, purely for the null-portfolio path (its
 * `null` return whenever `activePortfolioId === null`) and for its own
 * still-valid unit tests (`tests/ui-024.test.ts`) -- not dead code, just no
 * longer reachable with a non-null id from this specific call site.
 */
export function ownedSectionRedirectPath(
  activePortfolioId: string | null,
  requestedSection: PortfolioSection,
): string | null {
  if (activePortfolioId === null || requestedSection === "overview") {
    return null;
  }
  return `/portfolio/${activePortfolioId}/${requestedSection}`;
}
