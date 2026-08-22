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
  // UI-030 review ruling (2026-08-23): the sign now lands BEFORE the
  // currency symbol ("+$12.34"), not after ("$+12.34") -- matches the
  // owner's own literal UI-030 examples ("+$15000", "+$333,000").
  assert.match(html, /\+\$12\.34/); // daily movement
  assert.match(html, /\+\$10\.00/); // unrealised gain
  assert.match(html, /\+3\.5%/); // daily percent
  assert.match(html, /\+11\.11%/); // unrealised percent
  // Negative figures already carry an explicit "-" from decimal formatting.
  assert.match(html, /-\$8\.00/);
  assert.match(html, /-\$5\.00/);
  assert.match(html, /-2\.1%/);
  assert.match(html, /-4\.44%/);
  // Colour classes remain present as a supplemental (not sole) signal.
  assert.match(html, /tone-positive/);
  assert.match(html, /tone-negative/);
});

test("QA-001B: the standalone holding Details screen also signs its gain/percent figures (source-verified; UI-023 replaced the in-place dialog)", async () => {
  const source = await readFile(
    new URL("../app/components/holding-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /ownedHoldingAmount\(\s*homeCurrencyCode,\s*holding\.unrealisedGain,\s*2,\s*true,?\s*\)/,
  );
  assert.match(source, /ownedHoldingPercent\(holding\.dailyPercent, true\)/);
  assert.match(
    source,
    /ownedHoldingPercent\(holding\.unrealisedPercent, true\)/,
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

test("QA-001B: the create/rename portfolio dialog is a true modal (ref + showModal, not a bare `open` attribute), closes its menu, and restores opener focus to a node that survives the popover unmounting", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  // The old bug: a bare `<dialog open>` with no ref/showModal renders as
  // inert, non-modal content in normal document flow (below the fold, no
  // ::backdrop). The dialog must use the app's ref + showModal() pattern
  // instead (mirrors income-multi-year.tsx / dividend-assumptions-editor.tsx).
  // Scoped to the portfolio dialog's own opening tag (matched by its
  // className, order-independent) so a same-line reordering of its
  // attributes, or an unrelated `<dialog>` elsewhere in the file (e.g. the
  // quote-correction dialog), can't hide or falsely trip the guard.
  const portfolioDialogTag = source.match(
    /<dialog\b[^>]*className="portfolio-dialog"[^>]*>/,
  );
  assert.ok(
    portfolioDialogTag,
    "expected to find the portfolio dialog's opening <dialog> tag",
  );
  assert.doesNotMatch(portfolioDialogTag![0], /\bopen\b/);
  assert.match(
    source,
    /const portfolioDialogRef = useRef<HTMLDialogElement>\(null\);/,
  );
  assert.match(
    source,
    /const portfolioDialogOpenerRef = useRef<HTMLButtonElement \| null>\(null\);/,
  );
  // B1 review fix: the opener must be a node that survives the popover
  // menu unmounting (setOpenMenu(null) removes the clicked menu item from
  // the DOM in the same render pass), so the `.portfolio-button` toggle --
  // not the menu item -- is captured as the ref target.
  assert.match(
    source,
    /const portfolioButtonRef = useRef<HTMLButtonElement>\(null\);/,
  );
  assert.match(
    source,
    /ref=\{portfolioButtonRef\}\s*\n\s*className="portfolio-button"/,
  );
  assert.match(source, /ref=\{portfolioDialogRef\}/);
  assert.match(
    source,
    /if \(portfolioDialog && dialog && !dialog\.open\) \{\s*dialog\.showModal\(\);/,
  );
  // Focus moves into the dialog on open.
  assert.match(
    source,
    /dialog\.querySelector<HTMLInputElement>\("input"\)\?\.focus\(\);/,
  );
  // Follow-up 2: symmetry with dividend-assumptions-editor's effect -- close
  // the dialog element if state goes false while the DOM still thinks it's open.
  assert.match(
    source,
    /if \(!portfolioDialog && dialog\?\.open\) dialog\.close\(\);/,
  );
  // Opener focus is captured from the surviving toggle by both the Create
  // and Rename menu items, and the dropdown menu closes so it doesn't stay
  // open behind the dialog.
  assert.match(
    source,
    /portfolioDialogOpenerRef\.current =\s*portfolioButtonRef\.current;\s*setOpenMenu\(null\);\s*setPortfolioDialog\("create"\);/,
  );
  assert.match(
    source,
    /portfolioDialogOpenerRef\.current =\s*portfolioButtonRef\.current;\s*setOpenMenu\(null\);\s*setPortfolioDialog\("rename"\);/,
  );
  // Opener focus is restored once the dialog closes.
  assert.match(
    source,
    /if \(!portfolioDialog && portfolioDialogOpenerRef\.current\) \{\s*portfolioDialogOpenerRef\.current\.focus\(\);/,
  );
  // Escape (the native `cancel` event) is routed through the same close
  // path as every other control, not left to uncontrolled default behavior.
  assert.match(
    source,
    /onCancel=\{\(event\) => \{\s*event\.preventDefault\(\);\s*portfolioDialogRef\.current\?\.close\(\);\s*setPortfolioDialog\(null\);\s*\}\}/,
  );
  assert.match(source, /onClose=\{\(\) => setPortfolioDialog\(null\)\}/);
  // A visible, labelled close control exists beyond Escape.
  assert.match(
    source,
    /onClick=\{\(\) => portfolioDialogRef\.current\?\.close\(\)\}\s*disabled=\{actionPending \|\| !isOnline\}\s*>\s*Cancel/,
  );
});

test("QA-001B: a failed portfolio create/rename shows its error INSIDE the modal dialog (B2) -- not in the inert outside toast", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  // The outside "toast" is suppressed while the dialog is open (it would be
  // inert/unannounced behind an open top-layer <dialog>), but still renders
  // for non-dialog actions (archive/restore).
  assert.match(
    source,
    /\{actionMessage && !portfolioDialog \? \(\s*<p className="action-feedback" role="alert">/,
  );
  // The dialog's own <form> renders the same actionMessage using the app's
  // established in-dialog error pattern (dividend-assumptions-editor.tsx).
  const portfolioDialogStart = source.indexOf('className="portfolio-dialog"');
  const dialogSection = source.slice(
    portfolioDialogStart,
    source.indexOf("</dialog>", portfolioDialogStart),
  );
  assert.match(
    dialogSection,
    /\{actionMessage \? \(\s*<p role="alert" className="unavailable">\s*\{actionMessage\}\s*<\/p>\s*\) : null\}/,
  );
});

test("UI-007: the quote correction dialog is a true modal (ref + showModal, not a bare `open` attribute) and restores opener focus to a surviving control", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  // The old bug: a bare `<dialog open>` with no ref/showModal renders as
  // inert, non-modal content in normal document flow (below the fold, no
  // ::backdrop) -- the same defect the portfolio dialog had. Scoped to the
  // quote dialog's own opening tag (matched by its className, order-
  // independent) so a same-line attribute reordering, or the unrelated
  // portfolio <dialog> elsewhere in the file, can't hide or falsely trip
  // the guard.
  const quoteDialogTag = source.match(
    /<dialog\b[^>]*className="quote-dialog"[^>]*>/,
  );
  assert.ok(
    quoteDialogTag,
    "expected to find the quote dialog's opening <dialog> tag",
  );
  assert.doesNotMatch(quoteDialogTag![0], /\bopen\b/);
  assert.match(quoteDialogTag![0], /ref=\{dialogRef\}/);
  assert.match(
    source,
    /const dialogRef = useRef<HTMLDialogElement>\(null\);\s*\n\s*const \[type, setType\]/,
  );
  // showModal() fires on mount (this component only exists in the tree
  // while `correctionOpen` is true, so mount doubles as open), and focus
  // moves into the dialog.
  assert.match(
    source,
    /if \(dialog && !dialog\.open\) \{\s*dialog\.showModal\(\);\s*[\s\S]*?dialog\.querySelector<HTMLElement>\("select"\)\?\.focus\(\);/,
  );
  // Defensive close: if this component is ever unmounted without routing
  // through onClose/close() first, the captured dialog element is still
  // closed on the way out (mirrors the portfolio dialog's defensive branch).
  assert.match(
    source,
    /return \(\) => \{\s*if \(dialog\?\.open\) dialog\.close\(\);\s*\};/,
  );
  // Escape (the native `cancel` event) and the Cancel button both route
  // through dialog.close(), and the native `close` event is the single
  // source of truth that tells the parent to drop `correctionOpen`.
  // F1 review fix: a save in flight (`pending`) must block the close --
  // Escape closing (and unmounting) the dialog mid-request would leave the
  // eventual success/failure landing on an unmounted component, telling the
  // user nothing. This is the same rule the disabled Cancel button follows.
  assert.match(
    source,
    /onCancel=\{\(event\) => \{\s*event\.preventDefault\(\);\s*[\s\S]*?if \(pending\) return;\s*dialogRef\.current\?\.close\(\);\s*\}\}/,
  );
  assert.match(source, /onClose=\{\(\) => onClose\(\)\}/);
  assert.match(
    source,
    /onClick=\{\(\) => dialogRef\.current\?\.close\(\)\}\s*disabled=\{pending\}\s*>\s*Cancel/,
  );
  // Opener-survival: the "Correct a quote" button is a static control (not
  // inside a popover that unmounts), and its ref is only captured into
  // `correctionOpenerRef` at the moment it opens the dialog -- so the
  // restore effect can't steal focus on initial render.
  assert.match(
    source,
    /const correctionButtonRef = useRef<HTMLButtonElement>\(null\);/,
  );
  assert.match(
    source,
    /const correctionOpenerRef = useRef<HTMLButtonElement \| null>\(null\);/,
  );
  assert.match(
    source,
    /if \(!correctionOpen && correctionOpenerRef\.current\) \{\s*correctionOpenerRef\.current\.focus\(\);\s*correctionOpenerRef\.current = null;\s*\}/,
  );
  assert.match(
    source,
    /ref=\{correctionButtonRef\}\s*\n\s*type="button"\s*\n\s*onClick=\{\(\) => \{\s*correctionOpenerRef\.current = correctionButtonRef\.current;\s*\n\s*setCorrectionOpen\(true\);/,
  );
});

test("UI-007: a failed quote correction renders its error INSIDE the modal dialog, not the inert outside toast; a success message still uses the toast once closed", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  // The outside quote-action-status toast is suppressed while the
  // correction dialog is open (inert/unannounced behind the top-layer
  // <dialog>), mirroring the portfolio-dialog B2 fix.
  assert.match(
    source,
    /\{actionMessage && !correctionOpen \? \(\s*<p className="quote-action-status" role="alert">/,
  );
  // Read-only and thrown-error paths both set local dialog state, so their
  // failure text itself never lands in the (suppressed) parent toast.
  const dialogFnStart = source.indexOf("function QuoteCorrectionDialog");
  const dialogFnEnd = source.indexOf("\nfunction DetailsScreen", dialogFnStart);
  const dialogFnSource = source.slice(dialogFnStart, dialogFnEnd);
  assert.match(
    dialogFnSource,
    /const \[dialogError, setDialogError\] = useState<string \| null>\(null\);/,
  );
  // B1 review fix: both paths that now report in-dialog also clear the
  // parent's `actionMessage` (onMessage(null)) -- otherwise a stale
  // "Correction saved..." toast from an earlier successful save in this
  // same dialog mount survives a subsequent failure (success-toast ->
  // reopen -> failing submit -> Escape/Cancel), a persistent false
  // confirmation of a versioned financial write.
  assert.match(
    dialogFnSource,
    /if \(readOnly\) \{\s*setDialogError\(\s*"Preview data is read-only; no financial write was attempted\."\s*,?\s*\);\s*[\s\S]*?onMessage\(null\);\s*return;\s*\}/,
  );
  assert.match(
    dialogFnSource,
    /setPending\(true\);\s*setDialogError\(null\);\s*[\s\S]*?onMessage\(null\);\s*[\s\S]*?try \{/,
  );
  // UI-008: a timed-out (aborted) request gets its own dedicated message
  // ahead of the pre-existing error-shape fallback chain.
  assert.match(
    dialogFnSource,
    /\} catch \(error\) \{\s*setDialogError\(\s*isAbortError\(error\)\s*\? DIALOG_TIMEOUT_MESSAGE\s*: error instanceof Error\s*\? error\.message\s*: "The correction could not be saved\."\s*,?\s*\);\s*\}/,
  );
  // The dialog's own <form> renders that local error using the app's
  // established in-dialog error pattern (dividend-assumptions-editor.tsx).
  const quoteDialogStart = source.indexOf('className="quote-dialog"');
  const dialogSection = source.slice(
    quoteDialogStart,
    source.indexOf("</dialog>", quoteDialogStart),
  );
  assert.match(
    dialogSection,
    /\{dialogError \? \(\s*<p role="alert" className="unavailable">\s*\{dialogError\}\s*<\/p>\s*\) : null\}/,
  );
  // A successful save still calls the parent's onMessage -- it is only
  // shown in the toast once the dialog has already closed, which is the
  // honest split: not every onMessage call is dialog-suppressed, only the
  // ones that fire while the dialog stays open.
  assert.match(
    dialogFnSource,
    /onMessage\("Correction saved with a reason and effective date\."\);\s*\n\s*dialogRef\.current\?\.close\(\);/,
  );
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

test("QA-001B: .period-tabs wraps instead of overflowing at 320px (9 buttons × 44px min-width + gaps > 296px content box, FY-001C)", async () => {
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

// UI-005E follow-up: the "+" add menu's "Add holding" and "Add transaction"
// items used to be prototype-era `<button>`s with no onClick and a literal
// "UI only" note -- dead controls even in owned mode. They must now route
// into the real manual-ledger-entry flow (UI-005E) in owned mode, while
// preview/prototype mode keeps its honest non-functional buttons unchanged.
test("QA-001B: owned add menu wires 'Add holding' and 'Add transaction' into the manual ledger entry route instead of leaving them as dead UI-only buttons", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );

  // Owned mode, active portfolio present: both items are real Links into
  // the manual-ledger route, and close the menu on click -- the same
  // pattern the working "Import CSV" item beside them already uses.
  assert.match(source, /ownedWorkspace\.activePortfolio \? \(/);
  assert.match(
    source,
    /href=\{`\/portfolio\/\$\{ownedWorkspace\.activePortfolio\.id\}\/ledger\/new\?type=buy`\}\s*\n\s*onClick=\{\(\) => setOpenMenu\(null\)\}/,
  );
  assert.match(
    source,
    /href=\{`\/portfolio\/\$\{ownedWorkspace\.activePortfolio\.id\}\/ledger\/new`\}\s*\n\s*onClick=\{\(\) => setOpenMenu\(null\)\}/,
  );
  assert.match(source, /<span>Add holding<\/span>/);
  assert.match(source, /<span>Add transaction<\/span>/);

  // Empty workspace (no active portfolio yet): the items must not render a
  // link to a portfolio id that doesn't exist. They are hidden, matching
  // the same-file convention already used for "Rename portfolio"/"Archive"
  // (`ownedWorkspace.activePortfolio ? (...) : null`).
  assert.match(
    source,
    /href=\{`\/portfolio\/\$\{ownedWorkspace\.activePortfolio\.id\}\/ledger\/new`\}\s*\n\s*onClick=\{\(\) => setOpenMenu\(null\)\}\s*\n\s*>\s*\n\s*<span>Add transaction<\/span>\s*\n\s*<small>Manual ledger entry<\/small>\s*\n\s*<\/Link>\s*\n\s*<\/>\s*\n\s*\) : null\s*\n\s*\) : \(/,
  );

  // Preview/prototype mode is intentionally unchanged: it keeps the honest
  // non-functional "UI only" markers rather than pointing at a route that
  // has no real backing portfolio.
  assert.match(
    source,
    /<button type="button">\s*\n\s*<span>Add holding<\/span>\s*\n\s*<small>UI only<\/small>\s*\n\s*<\/button>\s*\n\s*<button type="button">\s*\n\s*<span>Add transaction<\/span>\s*\n\s*<small>UI only<\/small>\s*\n\s*<\/button>/,
  );
});

// UI-008: with Escape blocked and Cancel disabled while a dialog save is
// pending (portfolio-shell.tsx's QuoteCorrectionDialog) or Cancel/Save
// disabled (every other dialog below), a fetch that never settles is a
// temporary keyboard trap -- every dialog submit must bound its fetch with
// an AbortController-driven timeout and surface a dedicated in-dialog
// message when it fires.
test("UI-008: portfolio-shell.tsx's dialog submits (portfolio create/rename, quote correction) are bounded by an AbortController timeout with an in-dialog timeout message", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const DIALOG_FETCH_TIMEOUT_MS = 15_000;/);
  assert.match(
    source,
    /const DIALOG_TIMEOUT_MESSAGE =\s*"The request timed out\. It may still have gone through — check before retrying\.";/,
  );
  assert.match(
    source,
    /function isAbortError\(error: unknown\): boolean \{\s*return error instanceof DOMException && error\.name === "AbortError";/,
  );

  const submitPortfolioActionStart = source.indexOf(
    "async function submitPortfolioAction",
  );
  const submitPortfolioActionEnd = source.indexOf(
    "\n  async function changeHomeCurrency",
    submitPortfolioActionStart,
  );
  const submitPortfolioActionSource = source.slice(
    submitPortfolioActionStart,
    submitPortfolioActionEnd,
  );
  assert.match(
    submitPortfolioActionSource,
    /const controller = new AbortController\(\);/,
  );
  assert.match(submitPortfolioActionSource, /signal: controller\.signal,/);
  assert.match(
    submitPortfolioActionSource,
    /isAbortError\(error\)\s*\? DIALOG_TIMEOUT_MESSAGE/,
  );
  assert.match(submitPortfolioActionSource, /clearTimeout\(timeout\);/);

  const quoteDialogSubmitStart = source.indexOf(
    "async function submit(event: React.FormEvent<HTMLFormElement>) {",
  );
  const quoteDialogSubmitEnd = source.indexOf(
    "\n  return (",
    quoteDialogSubmitStart,
  );
  const quoteDialogSubmitSource = source.slice(
    quoteDialogSubmitStart,
    quoteDialogSubmitEnd,
  );
  assert.match(
    quoteDialogSubmitSource,
    /const controller = new AbortController\(\);/,
  );
  assert.match(quoteDialogSubmitSource, /signal: controller\.signal,/);
  assert.match(
    quoteDialogSubmitSource,
    /isAbortError\(error\)\s*\? DIALOG_TIMEOUT_MESSAGE/,
  );
  assert.match(quoteDialogSubmitSource, /clearTimeout\(timeout\);/);
});

// WLT-001 review (B3, BLOCKING): the watchlist's OwnedWatchlistScreen has
// FIVE fetch call sites of its own (runSearch, addSecurity, addCurrencyPair,
// removeEntry, moveEntry) -- none of these are `<dialog>` submits (the
// watchlist uses an inline expanding panel, not a modal), but the SAME
// never-hang guarantee applies: `actionPending`/`searchPending` must always
// clear via a bounded fetch, never wait on a connection that never settles.
// Tightened enumeration (cheap, per the review's own suggestion): rather
// than name each of the five functions individually (as the two tests
// above do for portfolio-shell.tsx's two PRE-EXISTING dialogs), this counts
// occurrences of each convention element across the WHOLE
// `OwnedWatchlistScreen` function body.
//
// Round-2 review fix (BLOCKING): the round-1 shape of this test counted
// `AbortController`/`signal`/`isAbortError`/`clearTimeout` occurrences but
// NEVER counted the fetch call sites themselves -- a sixth, entirely
// UNGUARDED `fetch(...)` (no controller, no signal, no timeout) left every
// one of those counts at 5 and passed cleanly, silently defeating the
// enumeration's whole purpose (reviewer-proved). Fixed by ALSO asserting
// `await fetch(` itself occurs exactly 5 times, tying the fetch-site count
// to the convention-element counts -- a 6th fetch (guarded or not) now
// changes THIS count first and fails the test regardless of whether its
// author remembered the convention.
test("UI-008/WLT-001 review (B3, BLOCKING): OwnedWatchlistScreen's five fetch call sites (runSearch, addSecurity, addCurrencyPair, removeEntry, moveEntry) are ALL bounded by the same AbortController timeout convention", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function OwnedWatchlistScreen({");
  assert.ok(start >= 0, "expected to find OwnedWatchlistScreen");
  const end = source.indexOf("\nfunction OwnedWorkspaceScreen({", start);
  assert.ok(end > start, "expected to find the next top-level function");
  const screenSource = source.slice(start, end);

  const names = [
    "runSearch",
    "addSecurity",
    "addCurrencyPair",
    "removeEntry",
    "moveEntry",
  ];
  for (const name of names) {
    assert.match(
      screenSource,
      new RegExp(`async function ${name}\\(`),
      `expected to find ${name}`,
    );
  }

  const fetchCallCount = (screenSource.match(/await fetch\(/g) ?? []).length;
  assert.equal(
    fetchCallCount,
    5,
    "expected exactly 5 fetch call sites -- a 6th (guarded or not) must change this count",
  );
  const controllerCount = (
    screenSource.match(/const controller = new AbortController\(\);/g) ?? []
  ).length;
  assert.equal(controllerCount, 5);
  const timeoutSetupCount = (
    screenSource.match(
      /const timeout = setTimeout\(\s*\(\) => controller\.abort\(\),\s*DIALOG_FETCH_TIMEOUT_MS,\s*\);/g,
    ) ?? []
  ).length;
  assert.equal(timeoutSetupCount, 5);
  const signalCount = (screenSource.match(/signal: controller\.signal,/g) ?? [])
    .length;
  assert.equal(signalCount, 5);
  const timeoutMessageUsageCount = (
    screenSource.match(
      /isAbortError\(error\)\s*\n\s*\? DIALOG_TIMEOUT_MESSAGE/g,
    ) ?? []
  ).length;
  assert.equal(timeoutMessageUsageCount, 5);
  const clearTimeoutCount = (
    screenSource.match(/clearTimeout\(timeout\);/g) ?? []
  ).length;
  assert.equal(clearTimeoutCount, 5);
});

test("UI-008: dividend-assumptions-editor.tsx's dialog submits (record dividend, delete dividend, FY override) are bounded by an AbortController timeout with an in-dialog timeout message", async () => {
  const source = await readFile(
    new URL(
      "../app/components/dividend-assumptions-editor.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /const DIALOG_FETCH_TIMEOUT_MS = 15_000;/);
  assert.match(
    source,
    /const DIALOG_TIMEOUT_MESSAGE =\s*"The request timed out\. It may still have gone through — check before retrying\.";/,
  );
  assert.match(
    source,
    /function isAbortError\(error: unknown\): boolean \{\s*return error instanceof DOMException && error\.name === "AbortError";/,
  );
  // Three dialog-scoped async fetches (record submit, delete, FY override
  // submit) each get their own AbortController + timeout.
  const controllerCount = (
    source.match(/const controller = new AbortController\(\);/g) ?? []
  ).length;
  assert.equal(controllerCount, 3);
  const signalCount = (source.match(/signal: controller\.signal,/g) ?? [])
    .length;
  assert.equal(signalCount, 3);
  const timeoutMessageUsageCount = (
    source.match(/isAbortError\(error\)\s*\? DIALOG_TIMEOUT_MESSAGE/g) ?? []
  ).length;
  assert.equal(timeoutMessageUsageCount, 3);
  assert.equal((source.match(/clearTimeout\(timeout\);/g) ?? []).length, 3);
});

test("UI-008: security-dividends-tab.tsx's refresh-confirmation dialog submit (runRefresh) is bounded by an AbortController timeout with an in-dialog timeout message", async () => {
  const source = await readFile(
    new URL("../app/components/security-dividends-tab.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const DIALOG_FETCH_TIMEOUT_MS = 15_000;/);
  assert.match(
    source,
    /const DIALOG_TIMEOUT_MESSAGE =\s*"The request timed out\. It may still have gone through — check before retrying\.";/,
  );
  const runRefreshStart = source.indexOf("async function runRefresh");
  const runRefreshEnd = source.indexOf(
    "\n  async function saveFrankingDefault",
    runRefreshStart,
  );
  const runRefreshSource = source.slice(runRefreshStart, runRefreshEnd);
  assert.match(runRefreshSource, /const controller = new AbortController\(\);/);
  assert.match(runRefreshSource, /signal: controller\.signal/);
  assert.match(
    runRefreshSource,
    /isAbortError\(error\)\s*\? DIALOG_TIMEOUT_MESSAGE/,
  );
  assert.match(runRefreshSource, /clearTimeout\(timeout\);/);
  // saveFrankingDefault is an inline page action, not a modal <dialog>
  // submit -- Escape/Cancel keyboard-trap concerns don't apply there, so it
  // is intentionally out of this task's scope and unmodified.
});
