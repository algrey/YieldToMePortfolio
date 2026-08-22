/** UI-024 — Owner-reported: all tabs must be clickable when fresh, even
 * with no content (News called out as a good example destination for a
 * brand-new user).
 *
 * Root cause: `app/components/portfolio-shell.tsx`'s primary tab bar
 * renders plain `<Link>`s (never `disabled` -- that convention is reserved
 * for MUTATING controls, per the `actionPending || !isOnline` gate seen
 * throughout this shell). Nothing was actually disabled. Instead, every
 * owned-mode tab's `href` was built as
 * `ownedWorkspace.activePortfolio ? \`/portfolio/${id}/${section}\` : "/"` --
 * when there is no active portfolio (the fresh/no-portfolio workspace this
 * task is about), EVERY tab collapsed to the same hard-coded `"/"`, which is
 * also the URL of the page already being viewed. Clicking "News" (or
 * Quotes/Holdings/Details) was therefore a same-URL no-op navigation --
 * indistinguishable from a dead click, even though no control was disabled
 * and no gating condition suppressed the click handler.
 *
 * Fix: `ownedNoPortfolioHref()` gives every non-overview tab a distinct
 * `/?section=<section>` target (there is no portfolio id yet to build a
 * `/portfolio/:id/:section` URL from), and `app/page.tsx` reads that param
 * back into `activeSection` via `resolveSectionSearchParam` (shared,
 * server-safe `app/portfolio-sections.ts` module -- see below).
 *
 * Review round (BLOCKING fix + two folds, all addressed here):
 * BLOCKING -- `app/page.tsx`'s workspace load only ever requests overview
 * data (`includeOverview: true`), so once an active portfolio exists,
 * rendering `/?section=quotes|holdings|details` directly on THIS route
 * (reachable via a bookmark or a back-button history entry the tab bar's
 * own no-portfolio fallback creates) showed a FALSE "no holdings/quotes
 * yet" empty state on a populated portfolio, and a FALSE "unavailable" for
 * details. Fixed by `ownedSectionRedirectPath()`: once an active portfolio
 * exists and the requested section isn't "overview", `page.tsx` redirects
 * to the real portfolio-scoped route instead of rendering owned content
 * itself.
 * Fold 1 -- the old `?section=` validation test asserted page.tsx's SOURCE
 * TEXT via regex instead of exercising real validation logic. Replaced with
 * behavioural tests of `resolveSectionSearchParam`, the exact function
 * `page.tsx` calls, including the array-valued case (`?section=` repeated
 * as a query key parses to `string[]`, which must also fall back to
 * "overview" rather than being coerced/guessed).
 * Fold 2 -- `portfolioSections`/`PortfolioSection` were triplicated across
 * `portfolio-shell.tsx`, `app/page.tsx`, and the `[section]/page.tsx`
 * route. Extracted to ONE shared, plain (no "use client") module,
 * `app/portfolio-sections.ts`, that both the client shell and server pages
 * import the RUNTIME array from directly -- eliminating the drift risk
 * rather than pinning it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ownedSectionRedirectPath,
  resolveSectionSearchParam,
} from "../app/portfolio-sections.ts";

const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
  const routerStub = {
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  };
`;

function renderShell(
  activeSection: string,
  ownedWorkspace: Record<string, unknown>,
): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    const ownedWorkspace = ${JSON.stringify(ownedWorkspace)};

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: ${JSON.stringify(activeSection)},
            ownedWorkspace,
          }),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

const FRESH_WORKSPACE = {
  status: "empty",
  activePortfolio: null,
  portfolios: [],
};

function extractNav(html: string): string {
  const match = html.match(/<nav class="primary-tabs"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(match, "expected a primary-tabs nav to render");
  return match![0]!;
}

test("UI-024: in a fresh/no-portfolio workspace, every primary tab is a real <a href> link -- never disabled, never a `#`/empty href", () => {
  const nav = extractNav(renderShell("overview", FRESH_WORKSPACE));
  // No tab link is ever disabled/aria-disabled -- the `disabled={actionPending
  // || !isOnline}` convention is for mutating controls only and must never
  // reach these navigation links.
  assert.doesNotMatch(nav, /disabled/);
  assert.doesNotMatch(nav, /aria-disabled/);
  const hrefs = [...nav.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 5, "expected all 5 primary tabs to render");
  for (const href of hrefs) {
    assert.notEqual(href, "", "no tab should have an empty href");
    assert.notEqual(href, "#", "no tab should have a placeholder '#' href");
  }
});

test("UI-024 (regression pin): in a fresh/no-portfolio workspace, tabs no longer collapse to the SAME href -- each section gets a distinct navigable target", () => {
  const nav = extractNav(renderShell("overview", FRESH_WORKSPACE));
  const hrefs = [...nav.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [
    "/",
    "/?section=news",
    "/?section=quotes",
    "/?section=holdings",
    "/?section=details",
  ]);
  // Every href must be unique -- the original bug was every tab pointing at
  // the current page's own URL ("/"), making the click a no-op.
  assert.equal(new Set(hrefs).size, hrefs.length);
});

test("UI-024: the News tab is reachable in a fresh/no-portfolio workspace -- aria-current tracks activeSection, and the section renders real content (not a dead end)", () => {
  const html = renderShell("news", FRESH_WORKSPACE);
  const nav = extractNav(html);
  const newsLinkMatch = nav.match(
    /<a[^>]*href="\/\?section=news"[^>]*>news<\/a>/,
  );
  assert.ok(newsLinkMatch, "expected a news tab link");
  assert.match(newsLinkMatch![0]!, /aria-current="page"/);
  // The other tabs must NOT carry aria-current="page" while news is active.
  const overviewLinkMatch = nav.match(/<a[^>]*href="\/"[^>]*>overview<\/a>/);
  assert.ok(overviewLinkMatch, "expected an overview tab link");
  assert.doesNotMatch(overviewLinkMatch![0]!, /aria-current/);

  // UI-025 (owner ruling 2026-08-22, superseding this test's original
  // pinned behaviour): "A new user should see the news in the news tab.
  // There are plenty of avenues for a new user to create a portfolio." The
  // News tab no longer shows the "No portfolios yet" panel this test used
  // to assert -- it renders the real news embed instead. See
  // tests/ui-025.test.ts for the dedicated embed coverage; this test keeps
  // only the tab-navigation assertions that are still this file's concern.
  assert.doesNotMatch(html, /No portfolios yet/);
  assert.match(html, /<iframe/);
});

test("UI-024: when an active portfolio DOES exist, tabs still link through real /portfolio/:id/:section URLs (unchanged, non-regressed path)", () => {
  const nav = extractNav(
    renderShell("overview", {
      status: "ready",
      homeCurrencyCode: "AUD",
      activePortfolio: {
        id: "portfolio-a",
        name: "Fixture Portfolio",
        homeCurrencyCode: "AUD",
        baseCurrencyCode: "AUD",
        timezone: "Australia/Sydney",
        accountingMethod: "fifo",
        status: "active",
        version: 1,
      },
      portfolios: [
        {
          id: "portfolio-a",
          name: "Fixture Portfolio",
          homeCurrencyCode: "AUD",
          status: "active",
          version: 1,
        },
      ],
    }),
  );
  const hrefs = [...nav.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [
    "/portfolio/portfolio-a/overview",
    "/portfolio/portfolio-a/news",
    "/portfolio/portfolio-a/quotes",
    "/portfolio/portfolio-a/holdings",
    "/portfolio/portfolio-a/details",
    // The "income" tab is a separate call site (UI-006A) that only ever
    // appears alongside an active portfolio -- unaffected by this fix.
    "/portfolio/portfolio-a/income",
  ]);
});

// ---------------------------------------------------------------------------
// Fold 1: behavioural coverage for resolveSectionSearchParam (the exact
// function app/page.tsx calls to turn `?section=` into `activeSection`).
// ---------------------------------------------------------------------------

for (const section of [
  "overview",
  "holdings",
  "quotes",
  "details",
  "news",
] as const) {
  test(`UI-024: resolveSectionSearchParam accepts the known section "${section}"`, () => {
    assert.equal(resolveSectionSearchParam(section), section);
  });
}

test("UI-024: resolveSectionSearchParam falls back to overview for an absent value", () => {
  assert.equal(resolveSectionSearchParam(undefined), "overview");
});

test("UI-024: resolveSectionSearchParam falls back to overview for an unrecognised string, never guessing/coercing it into a real section", () => {
  assert.equal(resolveSectionSearchParam("not-a-real-section"), "overview");
  assert.equal(resolveSectionSearchParam(""), "overview");
  assert.equal(resolveSectionSearchParam("Overview"), "overview"); // case-sensitive, not fuzzy-matched
});

test("UI-024 (Fold 1): resolveSectionSearchParam falls back to overview for an ARRAY value -- a repeated `?section=` query key parses to string[], which must never be coerced into a section", () => {
  assert.equal(resolveSectionSearchParam(["holdings", "quotes"]), "overview");
  assert.equal(resolveSectionSearchParam([]), "overview");
  assert.equal(resolveSectionSearchParam(["overview"]), "overview");
});

// ---------------------------------------------------------------------------
// BLOCKING fix: behavioural coverage for ownedSectionRedirectPath (the exact
// function app/page.tsx calls, feeding `redirect()`, to keep owned content
// off the no-portfolio `/?section=...` fallback route once a real portfolio
// exists).
// ---------------------------------------------------------------------------

test("UI-024 (BLOCKING fix): with an active portfolio, a non-overview requested section redirects to the real portfolio-scoped route", () => {
  assert.equal(
    ownedSectionRedirectPath("portfolio-a", "holdings"),
    "/portfolio/portfolio-a/holdings",
  );
  assert.equal(
    ownedSectionRedirectPath("portfolio-a", "quotes"),
    "/portfolio/portfolio-a/quotes",
  );
  assert.equal(
    ownedSectionRedirectPath("portfolio-a", "details"),
    "/portfolio/portfolio-a/details",
  );
  assert.equal(
    ownedSectionRedirectPath("portfolio-a", "news"),
    "/portfolio/portfolio-a/news",
  );
});

test("UI-024 (BLOCKING fix): with an active portfolio, the overview section is exempt -- this route's own includeOverview load already serves it correctly, no redirect", () => {
  assert.equal(ownedSectionRedirectPath("portfolio-a", "overview"), null);
});

test("UI-024 (BLOCKING fix): no-portfolio behaviour is unchanged -- with no active portfolio id, every section (including holdings/quotes/details) renders in place via the tab bar's own /?section= fallback, never redirected", () => {
  for (const section of [
    "overview",
    "holdings",
    "quotes",
    "details",
    "news",
  ] as const) {
    assert.equal(ownedSectionRedirectPath(null, section), null);
  }
});

// ---------------------------------------------------------------------------
// Wiring guard: confirms app/page.tsx actually threads these two pure,
// independently-tested functions into `redirect()`/`activeSection`, not
// just that the functions themselves behave correctly in isolation.
// ---------------------------------------------------------------------------

test("UI-024: app/page.tsx wires resolveSectionSearchParam and ownedSectionRedirectPath into the real request/redirect flow", async () => {
  const source = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /searchParams: Promise<\{ section\?: string \| string\[\] \}>/,
  );
  assert.match(source, /resolveSectionSearchParam\(section\)/);
  assert.match(
    source,
    /ownedSectionRedirectPath\(\s*\n\s*workspace\.activePortfolio\?\.id \?\? null,\s*\n\s*requestedSection,\s*\n\s*\)/,
  );
  assert.match(source, /if \(redirectPath\) redirect\(redirectPath\);/);
  assert.match(source, /activeSection=\{requestedSection\}/);
});
