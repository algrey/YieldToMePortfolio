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
 * sandboxed, no-referrer iframe -- the Worker CSP's `frame-src`
 * (worker/response-security.ts) already allows exactly this one origin, so
 * no widening was needed. The prototype/preview-mode `NewsScreen`
 * placeholder (reached only when there is no `ownedWorkspace` at all) is
 * unrelated and untouched.
 *
 * UI-028 (owner ruling, 2026-08-22, product choice -- reconciled here by
 * the Orchestrator, who owned the concurrent-session handoff; the owner's
 * behaviour is binding, not reverted): the PRIMARY tab's embed is now
 * intentionally CHROME-LESS -- no source-attribution paragraph beneath the
 * frame, and the frame fills the full viewport left below the sticky app
 * bar/tabs (`.owned-news-embed .holding-news-frame`'s
 * `height: calc(100dvh - var(--app-bar) - var(--tabs) -
 * env(safe-area-inset-top))`, `min-height: 420px`, `border-width: 0`,
 * `.owned-news-embed { gap: 0 }` -- replacing the earlier `calc(100dvh -
 * 320px)` attribution-line budget). Attribution remains reachable two other
 * ways this task did NOT touch: the per-holding News tab (UI-023B,
 * `holding-news-source`, its own unchanged `calc(100dvh - 250px)` budget --
 * pinned below, untouched) and the greeninvestments.au site itself. The
 * `<h1 id="owned-news-title" class="sr-only">` heading is unchanged (already
 * visually hidden before this reconciliation, kept that way).
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
  // UI-028 (owner ruling, 2026-08-22): the PRIMARY tab is intentionally
  // chrome-less -- no source-attribution link beneath the frame (unlike the
  // per-holding embed, which keeps its own attribution unchanged; see
  // tests/ui-023.test.ts / tests/ui-023b.test.ts). Positively pinned in
  // both directions so neither the attribution's absence nor the sr-only
  // heading regresses silently.
  assert.doesNotMatch(html, /holding-news-source/);
  assert.doesNotMatch(html, /greeninvestments\.au<\/a>/);
  assert.match(html, /<h1 id="owned-news-title" class="sr-only">News<\/h1>/);
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
  // "quotes" is excluded here as of WLT-001 (owner ruling, 2026-08-22): the
  // Quotes tab is now the user-scoped watchlist, which renders its own real
  // (possibly empty) content instead of the generic "No portfolios yet"
  // panel too -- the SAME treatment this test already gives "news". See
  // tests/wlt-001.test.ts.
  for (const section of ["overview", "holdings", "details"]) {
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

test("UI-025 review (fold), extended by WLT-001: OwnedWorkspaceScreen's generic per-section empty-state records no longer carry a 'news' OR 'quotes' entry -- the early returns for both mean titles/messages are typed Record<Exclude<PortfolioSection, \"news\" | \"quotes\">, string>, so a stale/false string can't silently exist for either", async () => {
  // PRF-014 step 2c: OwnedWorkspaceScreen moved to
  // portfolio-shell-leaves.tsx -- see that file's own header comment.
  const source = await readFile(
    new URL("../app/components/portfolio-shell-leaves.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const titles: Record<Exclude<PortfolioSection, "news" \| "quotes">, string> =\s*\{/,
  );
  assert.match(
    source,
    /const messages: Record<\s*Exclude<PortfolioSection, "news" \| "quotes">,\s*string\s*> = \{/,
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

test("UI-028 (owner ruling, 2026-08-22): the primary News tab's embed frame fills the full viewport left below the sticky app bar/tabs, chrome-less, distinct from the per-holding embed's unchanged attributed height", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  // Superseded rule (kept here only as a comment for history, never
  // re-asserted): `.owned-news-embed .holding-news-frame { height:
  // calc(100dvh - 320px); }` -- an attribution-line budget that no longer
  // applies now the primary tab has no attribution line at all.
  assert.match(
    css,
    /\.owned-news-embed \{\s*\n\s*gap: 0;\s*\n\s*\}/,
    "expected the primary embed's own no-gap rule",
  );
  assert.match(
    css,
    /\.owned-news-embed \.holding-news-frame \{\s*\n\s*height: calc\(\s*\n\s*100dvh - var\(--app-bar\) - var\(--tabs\) - env\(safe-area-inset-top\)\s*\n\s*\);\s*\n\s*min-height: 420px;\s*\n\s*border-width: 0;\s*\n\s*\}/,
    "expected the full-viewport, borderless, chrome-less primary embed height",
  );
  // The shared per-holding rule's own height declaration is UNCHANGED --
  // that embed keeps its attribution line and its original budget.
  assert.match(
    css,
    /\.holding-news-frame \{\s*\n\s*width: 100%;\s*\n\s*height: calc\(100dvh - 250px\);/,
  );
});

test("UI-025: the prototype/preview-mode NewsScreen placeholder is untouched", async () => {
  // PRF-014 step 2b: NewsScreen (and its call site) moved from
  // portfolio-shell.tsx to preview-shell.tsx's PreviewShell -- see that
  // file's own header comment. Both source and call site are pinned there
  // now instead.
  const source = await readFile(
    new URL("../app/components/preview-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /function NewsScreen\(\) \{\s*\n\s*return \(\s*\n\s*<section className="news-placeholder" aria-labelledby="news-title">/,
  );
  assert.match(source, /Portfolio news is not connected/);
  assert.match(
    source,
    /\{activeSection === "news" \? <NewsScreen \/> : null\}/,
  );
});
