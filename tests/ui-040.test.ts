// UI-040 (owner directive, verbatim, 2026-08-25): "Let add a 'Hide Sold'
// button for the holdings. I don't want it to take up valuable screen
// realestate on the holdings page. I propose for the last two lines of the
// summary row in holdings (All Time and Realised): We move the values to
// the left side (ie just after the text, though I would like the dollar
// signs to line up), then on the right side in the same row have a Hide
// Sold button that turns into a Show Sold button when pressed. It should
// not cause the summary row to grow in vertical size. I think partially
// sold holdings should stay as they are."
//
// Owner follow-up ruling (verbatim): "No explanatory text on the screen
// please. It should be obvious from the UI. Preserving information density
// on the holding screen is very important." -- the toggle is the button
// label alone; the honesty note about hidden rows is sr-only ONLY, never
// visible.
//
// Test layout mirrors this repo's own established precedent for this exact
// situation (DIV-013's own effect-based sessionStorage hydration, per
// tests/div-013.test.ts): a server-render (`renderToStaticMarkup`) harness
// never runs `useEffect`, so it can only exercise the DEFAULT ("Show Sold")
// state -- toggled-state and session-persistence behaviour are proven via
// (a) the underlying PURE functions the component wires into that state,
// tested directly, and (b) structural source pins (regex over the real
// component source), exactly like tests/div-013.test.ts's own "structural
// pin, since this harness cannot simulate a click" tests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  hideSoldStorageKey,
  loadHideSoldSession,
  saveHideSoldSession,
  type StorageLike,
} from "../app/owned-holdings-hide-sold.ts";

// ===========================================================================
// Part 1: ownedHoldingVisibleWhenHideSold / ownedHoldingHiddenSoldCount /
// ownedHoldingHiddenSoldDisclosureText / ownedHoldingSplitLeadingSign
// (app/owned-holding-format.tsx), unit
// ===========================================================================
//
// `app/owned-holding-format.tsx` contains real JSX, which this repo's Node
// test runtime (`node --experimental-strip-types`) cannot parse directly --
// mirrors tests/ui-036.test.ts's/tests/ui-031.test.ts's own child-process
// `tsx` loader trick for this file.

function callSplitLeadingSign(
  texts: string[],
): { sign: string; rest: string }[] {
  const moduleUrl = new URL("../app/owned-holding-format.tsx", import.meta.url)
    .href;
  const script = `
    import { ownedHoldingSplitLeadingSign } from ${JSON.stringify(moduleUrl)};
    const texts = ${JSON.stringify(texts)};
    process.stdout.write(
      JSON.stringify(texts.map((t) => ownedHoldingSplitLeadingSign(t))),
    );
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

// UI-040 review (B1, BLOCKING -- the owner's one explicit layout requirement,
// "I would like the dollar signs to line up"): `ownedHoldingSplitLeadingSign`
// is the fix -- it pulls the SHARED formatter's own leading sign character
// (if any) out into its own fixed-width slot, without modifying the shared
// formatter itself (per the review ruling). Covers exactly the three sign
// states the review measured misaligning: signed positive ("+"), signed
// negative ("-"), and an unsigned genuine zero ("" -- no sign at all).
test("UI-040 ownedHoldingSplitLeadingSign: splits a signed-positive, a signed-negative, and an unsigned-zero figure into { sign, rest } -- the exact three states the review found misaligned", () => {
  const [positive, negative, unsignedZero] = callSplitLeadingSign([
    "+$333,000",
    "-$1,204",
    "$0",
  ]);
  assert.deepEqual(positive, { sign: "+", rest: "$333,000" });
  assert.deepEqual(negative, { sign: "-", rest: "$1,204" });
  assert.deepEqual(unsignedZero, { sign: "", rest: "$0" });
});

test("UI-040 ownedHoldingSplitLeadingSign: also recognises the Unicode minus '−' (U+2212), matching signPrefixed's own recognised sign characters", () => {
  const [unicodeMinus] = callSplitLeadingSign(["−$1,204"]);
  assert.deepEqual(unicodeMinus, { sign: "−", rest: "$1,204" });
});

test("UI-040 ownedHoldingSplitLeadingSign: text with no leading sign character at all (e.g. an 'unavailable' string) round-trips untouched as an empty sign", () => {
  const [unavailable] = callSplitLeadingSign(["Basis unavailable"]);
  assert.deepEqual(unavailable, { sign: "", rest: "Basis unavailable" });
});

function callHideSoldHelpers(
  rows: { id: string; quantity: string }[],
  hideSold: boolean,
  hiddenSoldDisclosureCounts: number[],
): {
  visible: { id: string; quantity: string }[];
  hiddenCount: number;
  disclosures: (string | null)[];
} {
  const moduleUrl = new URL("../app/owned-holding-format.tsx", import.meta.url)
    .href;
  const script = `
    import {
      ownedHoldingVisibleWhenHideSold,
      ownedHoldingHiddenSoldCount,
      ownedHoldingHiddenSoldDisclosureText,
    } from ${JSON.stringify(moduleUrl)};
    const rows = ${JSON.stringify(rows)};
    const result = {
      visible: ownedHoldingVisibleWhenHideSold(rows, ${JSON.stringify(hideSold)}),
      hiddenCount: ownedHoldingHiddenSoldCount(rows),
      disclosures: ${JSON.stringify(hiddenSoldDisclosureCounts)}.map((c) =>
        ownedHoldingHiddenSoldDisclosureText(c),
      ),
    };
    process.stdout.write(JSON.stringify(result));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

test("UI-040 ownedHoldingVisibleWhenHideSold: hideSold=false (default 'Show Sold') returns every row unchanged, including fully-sold ones", () => {
  const rows = [
    { id: "held", quantity: "10" },
    { id: "sold", quantity: "0" },
    { id: "partial", quantity: "0.00000001" },
  ];
  const { visible } = callHideSoldHelpers(rows, false, []);
  assert.deepEqual(
    visible.map((r) => r.id),
    ["held", "sold", "partial"],
  );
});

test("UI-040 ownedHoldingVisibleWhenHideSold: hideSold=true removes ONLY exact-zero-quantity rows (the UI-036 convention) -- a partially-sold row (quantity > 0, however small) is never affected", () => {
  const rows = [
    { id: "held", quantity: "10" },
    { id: "sold-a", quantity: "0" },
    { id: "sold-b", quantity: "0.00000000" },
    { id: "partial", quantity: "0.00000001" },
  ];
  const { visible } = callHideSoldHelpers(rows, true, []);
  assert.deepEqual(
    visible.map((r) => r.id),
    ["held", "partial"],
  );
});

test("UI-040 hide/show round trip: toggling hideSold true then false on the SAME row set removes then restores the sold rows exactly, with the held/partial rows present throughout", () => {
  const rows = [
    { id: "held", quantity: "10" },
    { id: "sold", quantity: "0" },
    { id: "partial", quantity: "0.00000001" },
  ];
  const hidden = callHideSoldHelpers(rows, true, []).visible.map((r) => r.id);
  const shown = callHideSoldHelpers(rows, false, []).visible.map((r) => r.id);
  assert.deepEqual(hidden, ["held", "partial"]);
  assert.deepEqual(shown, ["held", "sold", "partial"]);
});

test("UI-040 ownedHoldingHiddenSoldCount: counts fully-sold rows independent of the CURRENT toggle state (stays accurate whichever state the toggle is in)", () => {
  const rows = [
    { id: "held", quantity: "10" },
    { id: "sold-a", quantity: "0" },
    { id: "sold-b", quantity: "0.0" },
    { id: "partial", quantity: "0.00000001" },
  ];
  const { hiddenCount } = callHideSoldHelpers(rows, false, []);
  assert.equal(hiddenCount, 2);
});

test("UI-040 ownedHoldingHiddenSoldDisclosureText: null when nothing is hidden; singular/plural text otherwise -- this feeds ONLY the sr-only disclosure (owner ruling: never visible text)", () => {
  const { disclosures } = callHideSoldHelpers([], false, [0, 1, 3]);
  assert.deepEqual(disclosures, [
    null,
    "1 sold holding hidden",
    "3 sold holdings hidden",
  ]);
});

// ===========================================================================
// Part 2: hideSoldStorageKey / loadHideSoldSession / saveHideSoldSession
// (app/owned-holdings-hide-sold.ts) -- plain .ts, no JSX, mirrors
// tests/div-013.test.ts's own session-persistence suite for
// capitalEventsStorageKey/loadCapitalEventsSession/saveCapitalEventsSession.
// ===========================================================================

class FakeStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class ThrowingStorage implements StorageLike {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
}

test("UI-040 hideSoldStorageKey: namespaces by portfolio -- two portfolios in the same session never share or clobber each other's toggle state", () => {
  assert.notEqual(
    hideSoldStorageKey("portfolio-a"),
    hideSoldStorageKey("portfolio-b"),
  );
});

test("UI-040/UI-052 loadHideSoldSession: on empty storage returns the default -- true ('hide sold', the owner's UI-052 directive superseding UI-040's default-SHOW)", () => {
  const storage = new FakeStorage();
  assert.equal(loadHideSoldSession(storage, hideSoldStorageKey("p1")), true);
});

test("UI-040 session persistence: save then load round-trips true and false exactly, per portfolio", () => {
  const storage = new FakeStorage();
  const keyA = hideSoldStorageKey("portfolio-a");
  const keyB = hideSoldStorageKey("portfolio-b");
  saveHideSoldSession(storage, keyA, true);
  saveHideSoldSession(storage, keyB, false);
  assert.equal(loadHideSoldSession(storage, keyA), true);
  assert.equal(loadHideSoldSession(storage, keyB), false);
});

test("UI-040/UI-052 loadHideSoldSession: degrades any unrecognised stored content to the default (true, hide sold) rather than throwing; an explicit stored 'false' is honoured as SHOW", () => {
  const storage = new FakeStorage();
  const key = hideSoldStorageKey("p1");
  storage.setItem(key, "not-a-boolean");
  assert.equal(loadHideSoldSession(storage, key), true);
  storage.setItem(key, "false");
  assert.equal(loadHideSoldSession(storage, key), false);
});

test("UI-040: a throwing storage (private/incognito tab, quota, blocked) never breaks load or save -- both degrade honestly, never throw into the caller (AGENTS.md/DIV-013 precedent)", () => {
  const storage = new ThrowingStorage();
  const key = hideSoldStorageKey("p1");
  assert.equal(loadHideSoldSession(storage, key), true);
  assert.doesNotThrow(() => saveHideSoldSession(storage, key, true));
});

// ===========================================================================
// Part 3: structural source pins (portfolio-shell.tsx) -- session wiring,
// effect ordering, and the "no visible explanatory text" ruling. Mirrors
// tests/div-013.test.ts's own B3 structural pins for the identical
// save-before-load hydration-race guard.
// ===========================================================================

async function readComponentSource(): Promise<string> {
  return readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
}

test("UI-040: session persistence is wired through window.sessionStorage specifically (never localStorage), reusing the DIV-013 pattern's hideSoldStorageKey/loadHideSoldSession/saveHideSoldSession helpers, never isOnline-gated", async () => {
  const source = await readComponentSource();
  assert.match(source, /window\.sessionStorage/);
  assert.match(
    source,
    /saveHideSoldSession\(\s*window\.sessionStorage,\s*hideSoldStorageKey\(portfolioId\),\s*hideSold,\s*\)/,
  );
  assert.match(
    source,
    /setHideSold\(loadHideSoldSession\(window\.sessionStorage, key\)\)/,
  );
  // Not gated on isOnline anywhere near the toggle's own handler/effects.
  const toggleRegion = source.slice(
    source.indexOf("const [hideSold, setHideSold]"),
    source.indexOf("function handleSort"),
  );
  assert.doesNotMatch(toggleRegion, /isOnline/);
});

test("UI-040 structural pin: the SAVE effect is declared BEFORE the LOAD effect in source, and gates on hydratedHideSoldKeyRef.current !== hideSoldStorageKey(portfolioId) -- the DIV-013 B3 portfolio-switch race guard, reused verbatim for this toggle", async () => {
  const source = await readComponentSource();
  assert.match(
    source,
    /if \(hydratedHideSoldKeyRef\.current !== hideSoldStorageKey\(portfolioId\)\) \{\s*\n\s*return;\s*\n\s*\}/,
  );
  const saveIndex = source.indexOf("saveHideSoldSession(\n      window");
  const loadIndex = source.indexOf(
    "setHideSold(loadHideSoldSession(window.sessionStorage, key));",
  );
  assert.ok(saveIndex > 0, "expected to find the save effect's call site");
  assert.ok(loadIndex > 0, "expected to find the load effect's call site");
  assert.ok(
    saveIndex < loadIndex,
    "expected the save effect to be declared (and therefore run) BEFORE the load effect",
  );
});

test("UI-040 structural pin: the row list maps over visibleRows (the hideSold-filtered array), while the footer's summary prop stays the ORIGINAL, unfiltered summary -- totals can never be affected by the toggle", async () => {
  const source = await readComponentSource();
  assert.match(source, /\{visibleRows\.map\(\(holding\) => \{/);
  assert.doesNotMatch(source, /\{sortedRows\.map\(\(holding\) => \{/);
  // The footer is gated on sortedRows.length (real emptiness), not
  // visibleRows.length -- it must still render (with its real totals) even
  // if the toggle currently hides every row.
  assert.match(
    source,
    /\{summary && sortedRows\.length > 0 \? \(\s*\n\s*<HoldingsSummaryFooterRow\s*\n\s*summary=\{summary\}/,
  );
  assert.match(source, /hideSold=\{hideSold\}/);
  assert.match(source, /hiddenSoldCount=\{hiddenSoldCount\}/);
});

test("UI-040 structural pin: ownedHoldingHiddenSoldCount is computed from the FULL sortedRows (not visibleRows) -- stays accurate regardless of the toggle's current state", async () => {
  const source = await readComponentSource();
  assert.match(
    source,
    /const hiddenSoldCount = useMemo\(\s*\n\s*\(\) => ownedHoldingHiddenSoldCount\(sortedRows\),\s*\n\s*\[sortedRows\],\s*\n\s*\);/,
  );
});

test("UI-040 structural pin (owner ruling: 'No explanatory text on the screen please ... never visible'): the toggle button's ONLY child is the state text itself -- no title attribute anywhere in the summary-lines-lower region (review B3: a hover tooltip is still visible text, forbidden)", async () => {
  const source = await readComponentSource();
  const region = source.slice(
    source.indexOf('<div className="summary-lines-lower">'),
    source.indexOf("</div>\n    </div>\n  );\n}"),
  );
  assert.match(region, /aria-pressed=\{hideSold\}/);
  assert.match(region, /\{hideSold \? "Show Sold" : "Hide Sold"\}/);
  assert.doesNotMatch(region, /title=/);
});

test("UI-040 structural pin (review fold): the sr-only live region is ALWAYS mounted (never conditionally added/removed) -- only its TEXT content is conditional on hideSold. A live region that is itself mounted-with-content on the same render is not reliably announced by assistive tech; a region already present in the a11y tree before its content changes is.", async () => {
  const source = await readComponentSource();
  const region = source.slice(
    source.indexOf('<div className="summary-lines-lower">'),
    source.indexOf("</div>\n    </div>\n  );\n}"),
  );
  // The live region element itself is unconditional JSX -- no `{cond ? (
  // <span ...> : null}` wrapper around the <span> anywhere in this region.
  assert.match(
    region,
    /<span className="sr-only" role="status">\s*\n\s*\{hideSold\s*\n\s*\? \(ownedHoldingHiddenSoldDisclosureText\(hiddenSoldCount\) \?\? ""\)\s*\n\s*: ""\}\s*\n\s*<\/span>/,
  );
  assert.doesNotMatch(
    region,
    /\{hideSold && hiddenSoldCount > 0 \? \(/,
    "the live region must not be conditionally mounted/unmounted",
  );
});

test("UI-040 structural pin: dollar-sign alignment mechanism -- both All Time and Realised labels carry the shared summary-line-label class (identical fixed-width column across both lines)", async () => {
  const source = await readComponentSource();
  const labelOccurrences = (
    source.match(/row-primary symbol summary-line-label/g) ?? []
  ).length;
  assert.equal(
    labelOccurrences,
    2,
    "expected both 'All Time' and 'Realised' labels to share the summary-line-label class",
  );
});

// ===========================================================================
// Part 4: rendered pins (default state -- server render never runs effects,
// so hideSold is always its default `true` here (UI-052: hide sold); mirrors
// tests/ui-036.test.ts's/tests/ui-031.test.ts's render-harness pattern).
// ===========================================================================

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

function holdingValue(
  status: "available" | "unavailable",
  currencyCode: string,
  value: string | null,
  reason: string | null = null,
) {
  return { status, currencyCode, value, reason };
}

function baseRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "row-base",
    securityId: "security-base",
    symbol: "BASE",
    name: "Base Co",
    exchange: "ASX",
    currencyCode: "AUD",
    quantity: "10",
    averageNativeCost: "9.00",
    nativeBasis: holdingValue("available", "AUD", "90.00"),
    homeBasis: holdingValue("available", "AUD", "90.00"),
    nativePrice: "10.00",
    nativeValue: holdingValue("available", "AUD", "100.00"),
    homePrice: holdingValue("available", "AUD", "10.00"),
    homeValue: holdingValue("available", "AUD", "100.00"),
    dailyMovement: holdingValue("available", "AUD", "1.00"),
    dailyPercent: holdingValue("available", "AUD", "1.0"),
    unrealisedGain: holdingValue("available", "AUD", "10.00"),
    unrealisedPercent: holdingValue("available", "AUD", "11.11"),
    dailyTone: "positive",
    gainTone: "positive",
    priceState: "current",
    actionStatus: "none",
    explanation: "Fixture explanation.",
    sort: { ticker: "BASE", value: "100.00", daily: "1.0", gain: "11.11" },
    ...overrides,
  };
}

const FOOTER_FIXTURE = {
  currencyCode: "AUD",
  marketValue: holdingValue("available", "AUD", "10000"),
  dailyMovement: holdingValue("available", "AUD", "150"),
  unrealisedGain: holdingValue("available", "AUD", "2000"),
  costBasis: holdingValue("available", "AUD", "8000"),
  dailyPercent: holdingValue("available", "%", "1.52"),
  totalPercent: holdingValue("available", "%", "25"),
  allTimeGain: holdingValue("available", "AUD", "333000"),
  allTimePercent: holdingValue("available", "%", "33.19"),
  realisedGain: holdingValue("available", "AUD", "700"),
  realisedPercent: holdingValue("available", "%", "20"),
  valueQualifier: null,
  dailyQualifier: null,
  allTimeQualifier: null,
  realisedQualifier: null,
};

function renderOwnedHoldingsScreen(
  holdings: Record<string, unknown>[],
  footerOverrides: Record<string, unknown> = {},
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
      holdings: ${JSON.stringify(holdings)},
      holdingsViewState: "complete",
      realisedGains: {},
      holdingsSummary: ${JSON.stringify({ ...FOOTER_FIXTURE, ...footerOverrides })},
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

test("UI-040/UI-052 render (default 'hide sold' state): the toggle renders aria-pressed=true with the 'Show Sold' label, a fully-sold row is REMOVED from the row list, and held rows stay (UI-052 default HIDE)", () => {
  const html = renderOwnedHoldingsScreen([
    baseRow({ id: "row-held", symbol: "HELD", quantity: "10" }),
    baseRow({ id: "row-sold", symbol: "SOLD", quantity: "0" }),
  ]);
  assert.match(html, /class="hide-sold-toggle"[^>]*aria-pressed="true"/);
  assert.match(html, />Show Sold</);
  assert.doesNotMatch(html, />Hide Sold</);
  assert.doesNotMatch(html, /\/portfolio\/portfolio-a\/holdings\/row-sold"/);
  assert.match(html, /\/portfolio\/portfolio-a\/holdings\/row-held"/);
});

test("UI-040/UI-052 render (review fold): the sr-only live region is ALWAYS present, and in the new default (hide sold) state its TEXT is the honest hidden-count sentence", () => {
  const html = renderOwnedHoldingsScreen([
    baseRow({ id: "row-sold", symbol: "SOLD", quantity: "0" }),
  ]);
  assert.match(
    html,
    /<span class="sr-only" role="status">1 sold holding hidden<\/span>/,
  );
});

test("UI-040 render: no visible helper text anywhere in the toggle region -- the button's own label is the only visible string this feature adds (owner ruling: 'No explanatory text on the screen please')", () => {
  const html = renderOwnedHoldingsScreen([
    baseRow({ id: "row-sold", symbol: "SOLD", quantity: "0" }),
  ]);
  const start = html.indexOf('class="summary-lines-lower"');
  assert.ok(start !== -1, "expected the summary-lines-lower wrapper to render");
  const region = html.slice(start, start + 1200);
  // Visible text nodes present: "All Time", "Realised", the money/percent
  // figures, and "Hide Sold" -- nothing else (no extra sentence).
  assert.doesNotMatch(region, />\s*sold holdings? hidden/i);
  assert.doesNotMatch(region, /toggle to view/i);
});

test("UI-040 render: the footer's own totals (All Time / Realised) still render their real owner-format figures -- '+' sign, thousands grouping, and percent parenthetical -- just with the leading sign now living in its own fixed-width slot (review B1 fix) rather than inline with the rest of the text", () => {
  const html = renderOwnedHoldingsScreen([
    baseRow({ id: "row-held", symbol: "HELD", quantity: "10" }),
  ]);
  assert.match(
    html,
    /<span class="summary-line-sign">\+<\/span>\$333,000\s*\(\+33\.19%\)/,
  );
  assert.match(
    html,
    /<span class="summary-line-sign">\+<\/span>\$700\s*\(\+20%\)/,
  );
});

test("UI-040 render (review B1 fix, mixed-sign + zero-Realised alignment pin -- the exact case the review measured '9.35px off'): a positive, signed All Time ('+') alongside a genuine unsigned zero Realised ('$0', no sign at all) -- BOTH lines render a sign slot (one non-empty, one empty) immediately followed by the '$'-leading rest, the structural shape that keeps the '$' at the same offset regardless of sign state", () => {
  const html = renderOwnedHoldingsScreen(
    [baseRow({ id: "row-held", symbol: "HELD", quantity: "10" })],
    {
      realisedGain: holdingValue("available", "AUD", "0"),
      realisedPercent: holdingValue("unavailable", "%", null, "zero_basis"),
    },
  );
  const signSlotCount = (html.match(/<span class="summary-line-sign">/g) ?? [])
    .length;
  assert.equal(
    signSlotCount,
    2,
    "expected exactly two sign slots, one per line",
  );
  assert.match(html, /<span class="summary-line-sign">\+<\/span>\$333,000/);
  assert.match(html, /<span class="summary-line-sign"><\/span>\$0(?!,)/);
  assert.doesNotMatch(html, /-\$0\b/);
  assert.doesNotMatch(html, /\+\$0\b/);
});

test("UI-040 render (review B1 fix, mixed-sign alignment pin): a NEGATIVE, signed All Time ('-') alongside a positive, signed Realised ('+') -- the two sign slots carry different characters, and both are immediately followed by their own '$'-leading rest", () => {
  const html = renderOwnedHoldingsScreen(
    [baseRow({ id: "row-held", symbol: "HELD", quantity: "10" })],
    {
      allTimeGain: holdingValue("available", "AUD", "-1204"),
      allTimePercent: holdingValue("available", "%", "-12.04"),
    },
  );
  assert.match(
    html,
    /<span class="summary-line-sign">-<\/span>\$1,204\s*\(-12\.04%\)/,
  );
  assert.match(
    html,
    /<span class="summary-line-sign">\+<\/span>\$700\s*\(\+20%\)/,
  );
});

test("UI-040 render: the footer still renders (with real totals) even though ALL rows are held (sanity: summary gate is sortedRows.length, unaffected by hideSold's default false state)", () => {
  const html = renderOwnedHoldingsScreen([
    baseRow({ id: "row-held", symbol: "HELD", quantity: "10" }),
  ]);
  assert.match(html, /class="[^"]*holdings-summary-footer[^"]*"/);
});

// ===========================================================================
// Part 5: CSS pins -- dollar-sign alignment mechanism, no-vertical-growth,
// and the 44px touch target taken out of flow.
// ===========================================================================

test("UI-040 CSS: --holdings-summary-h stays byte-unchanged at 100px -- the owner's 'must not grow the summary row' pin", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /--holdings-summary-h:\s*100px;/);
});

test("UI-040 CSS: label column half of the alignment mechanism -- a fixed-width label (min-width) shared by both All Time/Realised lines, NOT justify-content: space-between (which pushed values to the far right, the pre-UI-040 layout)", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const combinedMatch = css.match(
    /\.holdings-summary-footer \.summary-line-combined \{([^}]*)\}/,
  );
  assert.ok(combinedMatch, "expected a .summary-line-combined rule");
  assert.doesNotMatch(combinedMatch![1], /justify-content:\s*space-between/);

  const labelMatch = css.match(
    /\.holdings-summary-footer \.summary-line-combined \.summary-line-label \{([^}]*)\}/,
  );
  assert.ok(labelMatch, "expected a fixed-width .summary-line-label rule");
  assert.match(labelMatch![1], /min-width:\s*4\.6em/);
});

// UI-040 review (B1, BLOCKING): the label column alone was INSUFFICIENT --
// a variable-or-absent sign character still shifted the "$" that followed
// it. This is the SECOND half of the mechanism: a fixed one-character sign
// slot, immediately after the label, so "+", "-"/"−", and "" all occupy the
// same width. Also covers B2 (the false "always the value's first
// character" comment) by pinning the CORRECTED comment text is present and
// the old false claim is gone.
test("UI-040 CSS (review B1 fix): the sign slot half of the alignment mechanism -- .summary-line-sign is a fixed inline-block 1ch box, and its containing .row-primary.numeric establishes tabular-nums so the slot measures the same digit-width the figure itself renders in", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const signMatch = css.match(
    /\.holdings-summary-footer \.summary-line-combined \.summary-line-sign \{([^}]*)\}/,
  );
  assert.ok(signMatch, "expected a .summary-line-sign rule");
  assert.match(signMatch![1], /display:\s*inline-block/);
  assert.match(signMatch![1], /width:\s*1ch/);

  const tabularMatch = css.match(
    /\.holdings-summary-footer \.summary-line-combined \.row-primary\.numeric \{([^}]*)\}/,
  );
  assert.ok(
    tabularMatch,
    "expected a tabular-nums rule on .row-primary.numeric",
  );
  assert.match(tabularMatch![1], /font-variant-numeric:\s*tabular-nums/);
});

test("UI-040 CSS (review B2 fix): the label-column comment no longer makes the FALSE claim that the value's leading currency symbol is 'always the value's first character' -- the sign (when present) is the true first character, and the corrected comment says so", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    css,
    /always the value's first character/,
    "the B2-flagged false claim must be gone",
  );
  assert.match(css, /variable-or-absent SIGN character shift the "\$"/);
  assert.match(css, /which is what actually pins the "\$" itself/);
});

test("UI-040 CSS: the Hide Sold toggle is taken out of normal flow (position: absolute) so its 44px QA-001B target can never grow the two-line block/footer height", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const toggleMatch = css.match(
    /\.holdings-summary-footer \.hide-sold-toggle \{([^}]*)\}/,
  );
  assert.ok(toggleMatch, "expected a .hide-sold-toggle rule");
  const block = toggleMatch![1];
  assert.match(block, /position:\s*absolute/);
  assert.match(block, /min-height:\s*44px/);
});

test("UI-040 CSS: .summary-lines-lower is a position: relative container reserving right-hand room for the toggle (padding-right keyed to --hide-sold-toggle-w) -- the anchor the absolutely positioned toggle centers within", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const wrapperMatch = css.match(
    /\.holdings-summary-footer \.summary-lines-lower \{([^}]*)\}/,
  );
  assert.ok(wrapperMatch, "expected a .summary-lines-lower rule");
  assert.match(wrapperMatch![1], /position:\s*relative/);
  assert.match(
    wrapperMatch![1],
    /padding-right:\s*calc\(var\(--hide-sold-toggle-w\)/,
  );
});

// UI-040 review (B1 fold, 320px narrow-width budget re-check): the reviewer
// measured only ~2px of slack at 320px with a six-figure+partial line
// BEFORE the sign-slot fix -- adding the new ~1ch slot without freeing
// anything would overflow. This pin codifies the arithmetic the CSS
// comment documents (`app/globals.css`'s `--hide-sold-toggle-w` rule) so a
// future change that widens the reservation without re-checking the budget
// fails here rather than silently reintroducing the overflow risk. This is
// a MATH pin over the declared CSS values, not a live browser pixel
// measurement -- this repo's Node test harness has no headless-browser
// tooling to render and measure an actual layout (see the CSS comment's
// own caveat); a real-device/zoom confirmation remains a QA-001B-style
// manual follow-up if pixel-exact certainty is needed.
test("UI-040 CSS budget re-check (review B1 fold): the reserved right-hand region (toggle width + gutter) shrank enough to plausibly cover the new sign slot's estimated ~1ch cost while leaving real margin -- shrunk from the toggle/gutter only, never the label column", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const toggleWMatch = css.match(/--hide-sold-toggle-w:\s*(\d+)px;/);
  assert.ok(
    toggleWMatch,
    "expected --hide-sold-toggle-w to be a plain px value",
  );
  const toggleW = Number(toggleWMatch![1]);

  const gutterMatch = css.match(
    /padding-right:\s*calc\(var\(--hide-sold-toggle-w\)\s*\+\s*(\d+)px\)/,
  );
  assert.ok(gutterMatch, "expected the gutter to be a plain px addend");
  const gutter = Number(gutterMatch![1]);

  const totalReserved = toggleW + gutter;
  // Pre-fix reservation was 92px (toggle) + 8px (gutter) = 100px, with
  // only ~2px of measured slack remaining at 320px.
  const PRE_FIX_RESERVED = 100;
  const PRE_FIX_SLACK_PX = 2;
  assert.ok(
    totalReserved < PRE_FIX_RESERVED,
    `expected the reserved region (${totalReserved}px) to have shrunk below the pre-fix ${PRE_FIX_RESERVED}px`,
  );
  const freedPx = PRE_FIX_RESERVED - totalReserved;
  const availableSlackPx = freedPx + PRE_FIX_SLACK_PX;
  // The sign slot's estimated cost is ~1ch at the value line's 0.97rem
  // font-size -- roughly 8-9px for a typical proportional sans-serif "0"
  // glyph advance. Require a positive margin above the top of that
  // estimate, not just clearing it exactly.
  const ESTIMATED_SIGN_SLOT_COST_PX = 9;
  assert.ok(
    availableSlackPx > ESTIMATED_SIGN_SLOT_COST_PX,
    `expected freed budget + pre-fix slack (${availableSlackPx}px) to exceed the estimated ~${ESTIMATED_SIGN_SLOT_COST_PX}px sign-slot cost with real margin`,
  );

  // The label column is untouched by the fix -- confirms the budget came
  // from the toggle/gutter only, per the review's own prescription ("shrink
  // the label column OR the gutter", and the comment states gutter/toggle).
  const labelMatch = css.match(
    /\.holdings-summary-footer \.summary-line-combined \.summary-line-label \{([^}]*)\}/,
  );
  assert.ok(labelMatch);
  assert.match(labelMatch![1], /min-width:\s*4\.6em/);
});
