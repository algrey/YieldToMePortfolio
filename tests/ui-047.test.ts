import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

// UI-047 (owner-reported): the Overview screen regressed the moment the
// dormant CALC-003/CALC-004 persisted-snapshot pipeline started actually
// publishing for this account (its read-time self-heal, CALC-004, finally
// found something to advance) -- `OwnedOverviewScreen` switched from the
// permanently-"empty" Fragment branch (no hero, no KPI box, no banner, the
// chart rendered directly under `.screen-content` with no grid) to the
// "final" branch, which wraps everything in `.overview-screen`'s desktop
// 2-column grid. That single switch explains all four symptoms the owner
// reported in one sitting:
//  - the hero headline appeared, sourced from `data.current.value` -- the
//    snapshot's own total, which stays CASH-INCLUSIVE (BUG-002's ruling
//    only touched the HIST-001 series and live holdings reads, not this
//    dormant pipeline; see CALC-005 follow-up) and carries BUG-002's
//    phantom negative cash, so it disagreed with the Holdings tab's
//    securities-only total by roughly the size of that phantom cash;
//  - the KPI box and "Known value" coverage banner appeared (both were
//    always conditioned on `data.status !== "empty"`);
//  - the chart visually narrowed, because its own top-level element shares
//    the `.history-panel` class with the "Published value" section below
//    it, and `.overview-screen`'s desktop grid pins EVERY `.history-panel`
//    to the narrower left column.
//
// This suite pins the fix: the hero headline now sources the SAME
// securities-only total the Holdings tab already shows
// (`buildHoldingsSummaryFooter`'s `marketValue`, loaded once more,
// best-effort, in `authenticated-workspace.ts`'s `includeOverview` branch),
// at whole-dollar precision; the "Known value" box is gone from the
// rendered page (its text stays reachable to a screen reader, honouring the
// provenance non-negotiable, but never as a visible box); and the chart
// gets its own full-width grid placement independent of the "Published
// value" section it used to share a class with.

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

/** The text following the first occurrence of `marker` in `source`, bounded
 * so a `match` against it can't accidentally reach into unrelated code. */
function excerptAfter(source: string, marker: string, length = 200): string {
  const index = source.indexOf(marker);
  assert.ok(index !== -1, `expected to find "${marker}" in source`);
  return source.slice(index, index + marker.length + length);
}

const DEFAULT_HOLDINGS_SUMMARY = {
  currencyCode: "AUD",
  marketValue: {
    status: "available",
    currencyCode: "AUD",
    value: "1321205.37",
    reason: null,
  },
  dailyMovement: {
    status: "available",
    currencyCode: "AUD",
    value: "500",
    reason: null,
  },
  unrealisedGain: {
    status: "available",
    currencyCode: "AUD",
    value: "1000",
    reason: null,
  },
  costBasis: {
    status: "available",
    currencyCode: "AUD",
    value: "1300000",
    reason: null,
  },
  dailyPercent: {
    status: "available",
    currencyCode: "%",
    value: "0.1",
    reason: null,
  },
  totalPercent: {
    status: "available",
    currencyCode: "%",
    value: "1.6",
    reason: null,
  },
  allTimeGain: {
    status: "available",
    currencyCode: "AUD",
    value: "20000",
    reason: null,
  },
  allTimePercent: {
    status: "available",
    currencyCode: "%",
    value: "2",
    reason: null,
  },
  realisedGain: {
    status: "available",
    currencyCode: "AUD",
    value: "0",
    reason: null,
  },
  realisedPercent: {
    status: "available",
    currencyCode: "%",
    value: "0",
    reason: null,
  },
  valueQualifier: null,
  dailyQualifier: null,
  allTimeQualifier: null,
  realisedQualifier: null,
};

/** Renders PortfolioShell's owned Overview screen on the "final" branch
 * (`data.status` not "empty"/"unavailable") -- the branch UI-047 fixes.
 * `holdingsSummary: null` omits the field entirely from the workspace
 * fixture, exercising the best-effort-load-failed case. */
function renderOwnedOverviewFinal(
  options: {
    status?: string;
    currentValue?: string | null;
    issues?: { id: string; reason: string }[];
    holdingsSummary?: Record<string, unknown> | null;
  } = {},
): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const holdingsSummary =
    options.holdingsSummary === null
      ? undefined
      : (options.holdingsSummary ?? DEFAULT_HOLDINGS_SUMMARY);
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    const ownedWorkspace = {
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
      overview: {
        status: ${JSON.stringify(options.status ?? "complete")},
        currencyCode: "AUD",
        current: {
          date: "2026-08-01",
          value: ${JSON.stringify(
            options.currentValue === undefined
              ? "AUD 492,306.46"
              : options.currentValue,
          )},
          securities: "AUD 1,321,205.37",
          cash: "AUD -828,899.00",
          cost: "AUD 800.00",
          unrealised: "+AUD 100.00",
          realised: "+AUD 0.00",
          daily: "+AUD 5.00",
          valueDecimal: "492306.46",
          completeness: "complete",
          barHeight: "80%",
        },
        history: [],
        coverage: {
          pricedHoldingCount: 1,
          nonZeroHoldingCount: 1,
          convertedCashAccountCount: 1,
          nonZeroCashAccountCount: 1,
          totalHoldingCount: 1,
          excluded: [],
          issues: ${JSON.stringify(options.issues ?? [])},
          marketDataStates: [],
        },
        allocation: { status: "complete", rows: [] },
      },
      ${
        holdingsSummary === undefined
          ? ""
          : `holdingsSummary: ${JSON.stringify(holdingsSummary)},`
      }
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "overview",
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

/** The hero `<section class="overview-hero">...</section>` markup, isolated
 * so assertions about the headline never accidentally match the untouched
 * "Coverage and formula details" drilldown further down the page, which
 * still legitimately shows the raw CALC-003/CALC-004 snapshot figures this
 * task deliberately leaves alone (see this file's header comment; the
 * pipeline itself is CALC-005 territory, not this fix). */
function heroSection(html: string): string {
  const start = html.indexOf('<section class="overview-hero"');
  assert.notEqual(start, -1, "expected an .overview-hero section");
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

test("UI-047: the hero headline is the securities-only holdings total (whole dollars, no cents), never the cash-inclusive published-snapshot value", () => {
  const html = renderOwnedOverviewFinal();
  const hero = heroSection(html);
  const heading = /<h1 id="owned-overview-title">([^<]*)</.exec(hero);
  assert.ok(heading, "expected the hero <h1> to render");
  // Whole-dollar, half-even rounded, bare-$ base-currency figure --
  // `ownedHoldingAmountWhole`'s established UI-031B/UI-026 convention.
  assert.equal(heading![1], "$1,321,205");
  // The old cash-inclusive snapshot total (BUG-002's phantom negative cash
  // dragging it far below the securities-only figure) never appears in the
  // hero itself (it's still shown, unchanged, in the out-of-scope
  // CALC-005 drilldown further down the page -- see `heroSection` above).
  assert.doesNotMatch(hero, /492,306/);
});

test("UI-047: the hero headline reads honestly unavailable when the best-effort holdings load failed, rather than falling back to the snapshot total", () => {
  const html = renderOwnedOverviewFinal({ holdingsSummary: null });
  const hero = heroSection(html);
  const heading = /<h1 id="owned-overview-title">([^<]*)</.exec(hero);
  assert.ok(heading, "expected the hero <h1> to render");
  // UI-047 review (minor 1): a headline-appropriate phrase -- this <h1> IS
  // the section's accessible name (`aria-labelledby="owned-overview-title"`
  // on `.overview-hero`), so `ownedHoldingAmountWhole`'s bare lowercase
  // "unavailable" (fine inline, mid-sentence, elsewhere) reads wrong as a
  // heading on its own.
  assert.equal(heading![1], "Value unavailable");
  assert.doesNotMatch(hero, /492,306/);
});

test("UI-047 review (B2, BLOCKING): the movement line beneath the headline is sourced from the SAME holdings read as the headline, never the published snapshot's current.daily", () => {
  const html = renderOwnedOverviewFinal();
  const hero = heroSection(html);
  // DEFAULT_HOLDINGS_SUMMARY.dailyMovement is "500" (-> "+$500.00" at 2dp,
  // signed, bare-$ base currency); the fixture's overview.current.daily is
  // the deliberately DIFFERENT "+AUD 5.00" -- proving which one actually
  // renders, not just that some plausible-looking movement text exists.
  assert.match(hero, /\+\$500\.00/);
  assert.doesNotMatch(hero, /AUD 5\.00/);
});

test("UI-047 review round 3 (C2, BLOCKING): the movement line renders the SAME read's real daily percent, not a hardcoded 'Percentage unavailable'", () => {
  const html = renderOwnedOverviewFinal();
  const hero = heroSection(html);
  // DEFAULT_HOLDINGS_SUMMARY.dailyPercent is "0.1" -> "+0.1%" (ownedHolding
  // Percent, signed, trimmed).
  assert.match(hero, /\+\$500\.00 today · \+0\.1%/);
  assert.doesNotMatch(hero, /Percentage unavailable/);
});

test("UI-047 review round 3 (C2): a genuinely-null daily percent (e.g. zero_previous_value) still falls back honestly to 'Percentage unavailable', only for that real case", () => {
  const html = renderOwnedOverviewFinal({
    holdingsSummary: {
      ...DEFAULT_HOLDINGS_SUMMARY,
      dailyPercent: {
        status: "unavailable",
        currencyCode: "%",
        value: null,
        reason: null,
      },
    },
  });
  const hero = heroSection(html);
  assert.match(hero, /\+\$500\.00 today/);
  assert.match(hero, /Percentage unavailable/);
});

test("UI-047 review round 3 (C1, BLOCKING): a partial daily-movement qualifier renders inline, the same field the Holdings tab already surfaces via PartialMarker", () => {
  const html = renderOwnedOverviewFinal({
    holdingsSummary: {
      ...DEFAULT_HOLDINGS_SUMMARY,
      dailyQualifier: "excludes 1 holding without a comparable daily movement",
    },
  });
  const hero = heroSection(html);
  assert.match(hero, /class="row-tertiary partial-marker"/);
  assert.match(hero, /excludes 1 holding without a comparable daily movement/);
});

test("UI-047 review round 3 (C3, BLOCKING): the hero makes no 'as of' timestamp claim -- deleted outright, never relabelled, since the holdings read has no aggregate freshness disclosure", () => {
  const html = renderOwnedOverviewFinal();
  const hero = heroSection(html);
  assert.doesNotMatch(hero, /as of/i);
  // The fixture's overview.current.date ("2026-08-01") formats to "01 Aug"
  // -- confirms no relabelled date claim replaced the deleted span either.
  assert.doesNotMatch(hero, /01 Aug/);
});

test("UI-047 review (B2/C2): an unavailable holdings-sourced movement reads honestly unavailable, never silently falling back to the snapshot's own daily figure, and shows no percent at all", () => {
  const html = renderOwnedOverviewFinal({
    holdingsSummary: {
      ...DEFAULT_HOLDINGS_SUMMARY,
      dailyMovement: {
        status: "unavailable",
        currencyCode: "AUD",
        value: null,
        reason: null,
      },
    },
  });
  const hero = heroSection(html);
  assert.match(hero, /Daily movement unavailable/);
  assert.doesNotMatch(hero, /AUD 5\.00/);
  assert.match(hero, /class="muted-copy"/);
  // No "today · X%" tail at all when the movement itself is unavailable --
  // a percent with no accompanying amount would be a non-sequitur.
  assert.doesNotMatch(hero, /today ·/);
});

test("UI-047: a partial-coverage holdings total still shows the reachable 'partial' marker inline, never a big banner box", () => {
  const html = renderOwnedOverviewFinal({
    holdingsSummary: {
      ...DEFAULT_HOLDINGS_SUMMARY,
      valueQualifier:
        "excludes 1 holding without both a price and a cost basis",
    },
  });
  assert.match(html, /class="row-tertiary partial-marker"/);
  assert.match(
    html,
    /excludes 1 holding without both a price and a cost basis/,
  );
});

test('UI-047: the "Known value" coverage banner is no longer a visible box on Overview', () => {
  const html = renderOwnedOverviewFinal({
    status: "incomplete",
    currentValue: "AUD 492,306.46",
    issues: [{ id: "sec-1", reason: "missing basis" }],
  });
  assert.doesNotMatch(html, /class="status-banner/);
  assert.doesNotMatch(html, /status-symbol/);
});

test('UI-047: the same "Known value" / incomplete-coverage explanation stays reachable to a screen reader, sr-only, honouring the provenance non-negotiable', () => {
  const html = renderOwnedOverviewFinal({
    status: "incomplete",
    currentValue: "AUD 492,306.46",
    issues: [{ id: "sec-1", reason: "missing basis" }],
  });
  assert.match(html, /<p class="sr-only" role="status">/);
  assert.match(html, /Known value/);
  assert.match(
    html,
    /The current value is known, but the published calculation has incomplete coverage\./,
  );
});

test('UI-047: the "Stale coverage" state is also relocated sr-only, not deleted', () => {
  const html = renderOwnedOverviewFinal({ status: "stale" });
  assert.doesNotMatch(html, /class="status-banner/);
  assert.match(html, /<p class="sr-only" role="status">/);
  assert.match(html, /Stale coverage/);
});

test("UI-047: the 'Portfolio value over time' chart gets its own full-width grid wrapper, distinct from the narrower 'Published value' panel", () => {
  const html = renderOwnedOverviewFinal();
  const wrapIndex = html.indexOf('class="overview-chart-full"');
  assert.notEqual(wrapIndex, -1, "expected an .overview-chart-full wrapper");
  const publishedIndex = html.indexOf("Published value");
  assert.ok(
    publishedIndex > wrapIndex,
    "the chart wrapper must precede the separate 'Published value' section",
  );
  const chartTitleCount = (html.match(/Portfolio value over time/g) ?? [])
    .length;
  assert.ok(chartTitleCount >= 1);
});

test("UI-047 CSS: .overview-chart-full spans the full desktop 2-column grid width, alongside .overview-hero", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const desktopBlock = excerptAfter(
    styles,
    "@media (min-width: 700px) {",
    4000,
  );
  assert.match(
    desktopBlock,
    /\.overview-hero,[\s\S]*\.overview-chart-full\s*\{\s*grid-column:\s*1\s*\/\s*-1;/,
  );
  assert.match(desktopBlock, /\.history-panel\s*\{\s*grid-column:\s*1;/);
});

test("UI-047 CSS: overview-kpis divider border applies only to non-first-of-row cells (fixes the misaligned/gapped divider)", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.overview-kpis div:not\(:nth-child\(3n \+ 1\)\)\s*\{[\s\S]{0,80}border-left:\s*1px solid var\(--divider\);/,
  );
  // `div + div` (which applied the border regardless of grid column) is
  // gone -- otherwise the old bug would still fire alongside the fix.
  assert.doesNotMatch(styles, /\.overview-kpis div \+ div/);
});

test("UI-047 CSS (review B1, BLOCKING): the <350px KPI border reset matches the base rule's specificity, so it actually overrides it -- a bare '.overview-kpis div' reset is (0,1,1) and cannot beat the base rule's (0,2,1) ':not(:nth-child(3n + 1))'", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const baseIndex = styles.indexOf(
    ".overview-kpis div:not(:nth-child(3n + 1))",
  );
  assert.notEqual(baseIndex, -1, "expected the base 3-column divider rule");
  const smallScreenStart = styles.indexOf("@media (max-width: 350px) {");
  assert.ok(
    smallScreenStart > baseIndex,
    "the <350px override must come after the base rule -- equal-specificity rules resolve by source order",
  );
  const smallScreenBlock = excerptAfter(
    styles,
    "@media (max-width: 350px) {",
    1600,
  );
  // The fix: `:not(:nth-child(2n))` has the identical shape as the base
  // rule's `:not(:nth-child(3n + 1))` -- one class, one :not(:nth-child),
  // one type -- so it carries the same (0,2,1) specificity and, coming
  // later in source, actually wins for every left-column (odd) item.
  assert.match(
    smallScreenBlock,
    /\.overview-kpis div:not\(:nth-child\(2n\)\)\s*\{\s*padding-left:\s*0;\s*border-left:\s*none;/,
  );
  // The old specificity-inert reset (a bare `.overview-kpis div` selector)
  // must be GONE, not merely left alongside the fix -- otherwise it's
  // dead-but-harmless at best and misleading at worst.
  assert.doesNotMatch(
    smallScreenBlock,
    /\.overview-kpis div\s*\{\s*padding-left:\s*0;/,
  );
  assert.match(
    smallScreenBlock,
    /\.overview-kpis div:nth-child\(2n\)\s*\{[\s\S]{0,80}border-left:\s*1px solid var\(--divider\);/,
  );
});

test("UI-047 source: loadAuthenticatedWorkspace loads the same securities-only holdings summary for Overview it already loads for Holdings", async () => {
  const source = await readFile(
    new URL("../app/authenticated-workspace.ts", import.meta.url),
    "utf8",
  );
  const overviewBlock = excerptAfter(
    source,
    "if (options.includeOverview) {",
    8000,
  );
  // PRF-003 (owner-reported slow tab navigation): the value-history graph,
  // this holdings-derived summary, and the snapshot-publication read all run
  // concurrently now (one `Promise.all` wave instead of three sequential
  // `await`s) -- `holdingsSummary` is destructured from that wave rather
  // than bound by its own `await loadOwnedHoldings(` statement.
  assert.match(
    overviewBlock,
    /const \[portfolioValueHistory, holdingsSummary, overview\] =\s*\n?\s*await Promise\.all\(/,
  );
  assert.match(overviewBlock, /loadOwnedHoldings\(/);
  assert.match(overviewBlock, /buildHoldingsSummaryFooter\(/);
  // PRF-003 review round 2 (BLOCKING correction): `createOverviewData` and
  // `createUnavailableOverviewData` must BOTH live inside the SAME
  // `.then`/`.catch` pair as the `loadPublishedOverview` read -- an earlier
  // version called `createOverviewData` OUTSIDE this wave entirely, so a
  // malformed-publication throw from it would have escaped to the outer
  // catch and discarded the already-successful `portfolioValueHistory`/
  // `holdingsSummary` alongside it, a strictly worse degradation than the
  // pre-parallelization code's single shared try block.
  assert.match(
    overviewBlock,
    /\.then\(\(overview\) => createOverviewData\(overview\)\)\s*\n?\s*\.catch\(\(\) =>\s*\n?\s*createUnavailableOverviewData\(\s*\n?\s*configuredWorkspace\.activePortfolio!\.baseCurrencyCode,\s*\n?\s*\),\s*\n?\s*\),/,
  );
  assert.match(
    overviewBlock,
    /overview,\s*\n?\s*portfolioValueHistory,\s*\n?\s*holdingsSummary,/,
  );
});

test("UI-047 source: the Overview hero headline reads ownedHoldingAmountWhole on the holdings-derived value, never data.current.value", () => {
  return readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  ).then((source) => {
    const heroBlock = excerptAfter(
      source,
      '<h1 id="owned-overview-title">',
      600,
    );
    assert.match(
      heroBlock,
      /ownedHoldingAmountWhole\(data\.currencyCode, headlineValue\)/,
    );
    // UI-047 review (minor 1): the failure branch reads a headline-
    // appropriate phrase, not the bare lowercase "unavailable" text
    // `ownedHoldingAmountWhole` itself would return.
    assert.match(heroBlock, /"Value unavailable"/);
    assert.doesNotMatch(heroBlock, /current\.value/);
  });
});
