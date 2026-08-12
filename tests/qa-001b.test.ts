import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

// QA-001B: accessibility and responsive hardening. These tests are the
// automated half of the audit (see docs/QA-001B_ACCESSIBILITY_AUDIT.md for
// the full record, including the manual VoiceOver/physical-device checklist
// that only an owner running real assistive tech/hardware can complete).

// --- WCAG 2.2 contrast helper (sRGB relative luminance, no dependency) ----
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const value = parseInt(clean, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relativeLuminance([r, g, b]: [number, number, number]): number {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}
function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexToRgb(hexA));
  const b = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

function extractToken(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})`));
  assert.ok(match, `expected --${name} token in globals.css`);
  return match![1];
}

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*{([^}]*)}`));
  assert.ok(match, `expected a "${selector}" rule in globals.css`);
  return match![1];
}

// PortfolioShell calls next/navigation's useRouter(), which throws unless an
// AppRouterContext provider is mounted. The rest of the test suite works
// around this by asserting on source text instead of rendering PortfolioShell
// (see tests/ui-001.test.ts); a stub router context lets these tests render
// real markup instead for the checks that need it.
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

function renderOwnedHoldings(): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    function holdingValue(status, currencyCode, value, reason) {
      return { status, currencyCode, value, reason: reason ?? null };
    }

    const gainer = {
      id: "row-gainer",
      securityId: "security-gainer",
      symbol: "GAIN",
      name: "Gainer Co",
      exchange: "ASX",
      currencyCode: "AUD",
      quantity: "10.000",
      averageNativeCost: "9.00",
      nativeBasis: holdingValue("available", "AUD", "90.00"),
      homeBasis: holdingValue("available", "AUD", "90.00"),
      nativePrice: "10.00",
      nativeValue: holdingValue("available", "AUD", "100.00"),
      homePrice: holdingValue("available", "AUD", "10.00"),
      homeValue: holdingValue("available", "AUD", "100.00"),
      dailyMovement: holdingValue("available", "AUD", "12.34"),
      dailyPercent: holdingValue("available", "AUD", "3.5"),
      unrealisedGain: holdingValue("available", "AUD", "10.00"),
      unrealisedPercent: holdingValue("available", "AUD", "11.11"),
      dailyTone: "positive",
      gainTone: "positive",
      priceState: "current",
      actionStatus: "none",
      explanation: "Fixture explanation for the gaining holding.",
      sort: { ticker: "GAIN", value: "100.00", daily: "3.5", gain: "11.11" },
    };
    const loser = {
      ...gainer,
      id: "row-loser",
      securityId: "security-loser",
      symbol: "LOSE",
      name: "Loser Co",
      dailyMovement: holdingValue("available", "AUD", "-8.00"),
      dailyPercent: holdingValue("available", "AUD", "-2.1"),
      unrealisedGain: holdingValue("available", "AUD", "-5.00"),
      unrealisedPercent: holdingValue("available", "AUD", "-4.44"),
      dailyTone: "negative",
      gainTone: "negative",
      sort: { ticker: "LOSE", value: "100.00", daily: "-2.1", gain: "-4.44" },
    };

    const ownedWorkspace = {
      status: "ready",
      userDisplayName: "Fixture Owner",
      homeCurrencyCode: "AUD",
      holdingCurrencyView: "native",
      settingsVersion: 1,
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
      holdings: [gainer, loser],
      holdingsViewState: "complete",
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "holdings",
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

function renderOwnedOverview(): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
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
        status: "complete",
        currencyCode: "AUD",
        current: {
          date: "2026-08-01",
          value: "AUD 1,000.00",
          securities: "AUD 900.00",
          cash: "AUD 100.00",
          cost: "AUD 800.00",
          unrealised: "+AUD 100.00",
          realised: "+AUD 0.00",
          daily: "+AUD 5.00",
          valueDecimal: "1000.00",
          completeness: "complete",
          barHeight: "80%",
        },
        history: [
          {
            date: "2026-07-31",
            value: "AUD 995.00",
            securities: "AUD 895.00",
            cash: "AUD 100.00",
            cost: "AUD 800.00",
            unrealised: "+AUD 95.00",
            realised: "+AUD 0.00",
            daily: "+AUD 2.00",
            valueDecimal: "995.00",
            completeness: "complete",
            barHeight: "78%",
          },
          {
            date: "2026-08-01",
            value: "AUD 1,000.00",
            securities: "AUD 900.00",
            cash: "AUD 100.00",
            cost: "AUD 800.00",
            unrealised: "+AUD 100.00",
            realised: "+AUD 0.00",
            daily: "+AUD 5.00",
            valueDecimal: "1000.00",
            completeness: "complete",
            barHeight: "80%",
          },
        ],
        coverage: {
          pricedHoldingCount: 1,
          nonZeroHoldingCount: 1,
          convertedCashAccountCount: 1,
          nonZeroCashAccountCount: 1,
          totalHoldingCount: 1,
          excluded: [],
          issues: [],
          marketDataStates: [],
        },
        allocation: { status: "complete", rows: [] },
      },
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

test("QA-001B: positive and negative holding gain/movement/percent figures carry an explicit +/− sign, not colour alone", () => {
  const html = renderOwnedHoldings();
  // Positive figures must show an explicit "+", matching the already
  // established OverviewFact `signed` convention (colour is supplemental).
  assert.match(html, /AUD \+12\.34/); // daily movement
  assert.match(html, /AUD \+10\.00/); // unrealised gain
  assert.match(html, /\+3\.5%/); // daily percent
  assert.match(html, /\+11\.11%/); // unrealised percent
  // Negative figures already carry an explicit "-" from decimal formatting.
  assert.match(html, /AUD -8\.00/);
  assert.match(html, /AUD -5\.00/);
  assert.match(html, /-2\.1%/);
  assert.match(html, /-4\.44%/);
  // Colour classes remain present as a supplemental (not sole) signal.
  assert.match(html, /tone-positive/);
  assert.match(html, /tone-negative/);
});

test("QA-001B: the owned holding-detail dialog also signs its gain/percent figures (source-verified; dialog is closed on initial static render)", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /ownedHoldingAmount\(selectedHolding\.unrealisedGain, 2, true\)/,
  );
  assert.match(
    source,
    /ownedHoldingPercent\(selectedHolding\.dailyPercent, true\)/,
  );
  assert.match(
    source,
    /ownedHoldingPercent\(selectedHolding\.unrealisedPercent, true\)/,
  );
});

test("QA-001B: the owned portfolio history chart has a full table alternative", () => {
  const html = renderOwnedOverview();
  assert.match(html, /role="img"/);
  assert.match(html, /<table>/);
  assert.match(html, /<caption>Published portfolio value history<\/caption>/);
  assert.match(html, /Unavailable|995\.00|1,000\.00/);
});

test("QA-001B: primary landmarks and keyboard-visible focus styling are present", async () => {
  const [html, styles] = await Promise.all([
    Promise.resolve(renderOwnedHoldings()),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /<nav className="primary-tabs"|<nav class="primary-tabs"/);
  assert.match(html, /aria-label="Portfolio sections"/);
  assert.match(html, /<main /);
  assert.match(html, /<header class(Name)?="app-bar"/);
  assert.match(
    styles,
    /:focus-visible\s*{\s*outline:\s*2px solid var\(--green-bright\)/,
  );
});

test("QA-001B: the mobile navigation drawer restores focus, traps Tab, and closes on Escape", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  // Opener is captured so focus returns to the hamburger button on close.
  assert.match(source, /drawerOpenerRef\.current = event\.currentTarget/);
  assert.match(source, /drawerOpenerRef\.current\.focus\(\)/);
  // Focus moves into the drawer's close control on open.
  assert.match(source, /drawerCloseRef\.current\?\.focus\(\)/);
  // Escape closes the drawer.
  assert.match(
    source,
    /event\.key === "Escape"[\s\S]{0,80}setDrawerOpen\(false\)/,
  );
  // Tab is contained inside the drawer while it covers the screen.
  assert.match(source, /if \(event\.key !== "Tab"\) return;/);
});

test("QA-001B: interactive controls meet the 44×44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".period-tabs button",
    ".compact-select",
    ".sheet-close",
    ".quote-history-heading button",
    ".range-controls button",
    ".dialog-actions button",
    ".popover button,\n.popover a",
    ".icon-button,\n.portfolio-button",
    ".primary-tabs a",
    ".navigation-drawer > a,\n.navigation-drawer > button",
    ".import-mapping-form button",
    ".action-feedback button",
  ]) {
    const block = extractBlock(styles, selector);
    assert.match(
      block,
      /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
      `${selector} must declare min-height >= 44px`,
    );
  }
});

test("QA-001B: .period-tabs wraps instead of overflowing at 320px (7 buttons × 44px min-width + gaps > 296px content box)", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const block = extractBlock(styles, ".period-tabs");
  assert.match(
    block,
    /flex-wrap:\s*wrap/,
    ".period-tabs must wrap its buttons instead of overflowing the 320px content box",
  );
});

test("QA-001B: --muted-dark supplementary text meets 4.5:1 contrast against every panel background", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const mutedDark = extractToken(styles, "muted-dark");
  for (const backgroundToken of [
    "ink",
    "forest",
    "forest-soft",
    "forest-raised",
  ]) {
    const background = extractToken(styles, backgroundToken);
    const ratio = contrastRatio(mutedDark, background);
    assert.ok(
      ratio >= 4.5,
      `--muted-dark (${mutedDark}) vs --${backgroundToken} (${background}) contrast ${ratio.toFixed(2)} is below WCAG AA 4.5:1`,
    );
  }
});

test("QA-001B: reduced-motion preferences suppress non-essential animation", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const block = extractBlock(styles, "@media (prefers-reduced-motion: reduce)");
  assert.match(block, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(block, /animation-duration:\s*0\.01ms\s*!important/);
});

test("QA-001B: the viewport never disables pinch/keyboard zoom, and the shell has a 320px overflow floor", async () => {
  const [layout, styles] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(layout, /maximumScale/);
  assert.doesNotMatch(layout, /userScalable/);
  assert.match(extractBlock(styles, "html"), /min-width:\s*320px/);
  assert.match(extractBlock(styles, "body"), /min-width:\s*320px/);
});
