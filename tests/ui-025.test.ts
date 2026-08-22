/** UI-025 — the primary News tab must show real news.
 *
 * Owner ruling (2026-08-22): "A new user should see the news in the news
 * tab. There are plenty of avenues for a new user to create a portfolio."
 * Before this task, `app/components/portfolio-shell.tsx`'s `OwnedWorkspaceScreen`
 * rendered a generic placeholder on the primary News tab in EVERY owned
 * workspace state:
 *   - no portfolio yet: the shared "No portfolios yet" / create-portfolio
 *     panel (same as every other empty tab) -- exactly the case the owner
 *     called out.
 *   - an active portfolio: "News is not connected yet" / "YieldToMe does
 *     not provide investment news in this release."
 *
 * Fix: both states now render `OwnedNewsScreen`, embedding the SAME owner
 * news site as the per-holding News tab (UI-023B:
 * app/portfolio/[portfolioId]/[section]/[holdingId]/news/page.tsx) in a
 * sandboxed, no-referrer iframe with source attribution -- the Worker CSP's
 * `frame-src` (worker/response-security.ts) already allows exactly this one
 * origin, so no widening was needed. The prototype/preview-mode `NewsScreen`
 * placeholder (reached only when there is no `ownedWorkspace` at all) is
 * unrelated and untouched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

const ACTIVE_PORTFOLIO_WORKSPACE = {
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
};

function assertNewsEmbed(html: string) {
  assert.match(html, /<iframe/);
  assert.match(
    html,
    /src="https:\/\/greeninvestments\.au\/\?embed=1"/,
    "expected the exact owner news embed URL",
  );
  assert.match(html, /referrerPolicy="no-referrer"/);
  assert.match(html, /title="Green Investments news"/);
  // Source attribution stays visible outside the frame.
  assert.match(html, /greeninvestments\.au<\/a>/);
}

test("UI-025: the News tab in a fresh/no-portfolio workspace renders the real news embed, not the 'No portfolios yet' panel", () => {
  const html = renderShell("news", FRESH_WORKSPACE);
  assertNewsEmbed(html);
  assert.doesNotMatch(html, /No portfolios yet/);
  assert.doesNotMatch(
    html,
    /<button type="button" class="empty-state-primary-action">Create a new portfolio<\/button>/,
  );
});

test("UI-025: the News tab with an active portfolio renders the same real news embed, not the 'News is not connected yet' placeholder", () => {
  const html = renderShell("news", ACTIVE_PORTFOLIO_WORKSPACE);
  assertNewsEmbed(html);
  assert.doesNotMatch(html, /News is not connected yet/);
  assert.doesNotMatch(
    html,
    /YieldToMe does not provide investment news in this release\./,
  );
});

test("UI-025: the news embed carries no portfolio/security identifiers -- same exact URL and referrer policy in both workspace states", () => {
  const freshHtml = renderShell("news", FRESH_WORKSPACE);
  const activeHtml = renderShell("news", ACTIVE_PORTFOLIO_WORKSPACE);
  const extractSrc = (html: string) =>
    html.match(/<iframe[^>]*src="([^"]*)"/)?.[1];
  assert.equal(extractSrc(freshHtml), "https://greeninvestments.au/?embed=1");
  assert.equal(extractSrc(activeHtml), "https://greeninvestments.au/?embed=1");
});

test("UI-025: every other primary tab's 'No portfolios yet' empty state is unchanged -- the create-portfolio action still renders", () => {
  for (const section of ["overview", "holdings", "quotes", "details"]) {
    const html = renderShell(section, FRESH_WORKSPACE);
    assert.match(html, /No portfolios yet/, `expected "${section}" unaffected`);
    assert.match(
      html,
      /<button type="button" class="empty-state-primary-action">Create a new portfolio<\/button>/,
      `expected "${section}" to keep its create-portfolio action`,
    );
  }
});

test("UI-025: the Worker CSP already allows exactly the greeninvestments.au origin the news embed uses (no widening required)", async () => {
  const csp = await readFile(
    new URL("../worker/response-security.ts", import.meta.url),
    "utf8",
  );
  assert.match(csp, /"frame-src 'self' https:\/\/greeninvestments\.au"/);
});

test("UI-025 review (fold): OwnedWorkspaceScreen's generic per-section empty-state records no longer carry a 'news' entry -- the early return for News means titles/messages are typed Record<Exclude<PortfolioSection, \"news\">, string>, so a stale/false News string can't silently exist there", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const titles: Record<Exclude<PortfolioSection, "news">, string> = \{/,
  );
  assert.match(
    source,
    /const messages: Record<Exclude<PortfolioSection, "news">, string> = \{/,
  );
  // The false News copy is gone from the actual record literals (comments
  // referencing the removed placeholder, for history, are fine and not
  // asserted against here).
  assert.doesNotMatch(source, /news: "News is not connected yet"/);
  assert.doesNotMatch(
    source,
    /news: "YieldToMe does not provide investment news in this release\."/,
  );
});

test("UI-025 review (fold): the primary News tab's embed frame gets its own height rule scoped to .owned-news-embed, distinct from the per-holding embed's unchanged height", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.owned-news-embed \.holding-news-frame \{\s*\n\s*height: calc\(100dvh - \d+px\);\s*\n\s*\}/,
  );
  // The shared per-holding rule's own height declaration is unchanged.
  assert.match(
    css,
    /\.holding-news-frame \{\s*\n\s*width: 100%;\s*\n\s*height: calc\(100dvh - 250px\);/,
  );
});

test("UI-025: the prototype/preview-mode NewsScreen placeholder is untouched", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /function NewsScreen\(\) \{\s*\n\s*return \(\s*\n\s*<section className="news-placeholder" aria-labelledby="news-title">/,
  );
  assert.match(source, /Portfolio news is not connected/);
  assert.match(
    source,
    /\{!ownedMode && activeSection === "news" \? <NewsScreen \/> : null\}/,
  );
});
