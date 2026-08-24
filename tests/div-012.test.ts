/**
 * DIV-012 -- What-if inputs: live apply, no buttons, no cross-reset,
 * select-on-focus (owner-directed, 2026-08-24). Round 1 review (BLOCKING
 * fixes B1/B2, RULING B3) landed after the original implementation; this
 * file covers the FINAL design.
 *
 * ROOT CAUSE (documented verbatim in `app/components/income-multi-year.tsx`'s
 * module header too): the pre-fix design gated BOTH growth axes' displayed
 * figures behind one SHARED "applied" boolean plus a paired "applied result"
 * state cell. Editing EITHER input's change handler unconditionally cleared
 * BOTH of those shared cells, which flipped the rendered projection/summary
 * for BOTH growth axes back to the saved baseline assumptions at once, even
 * though only one field's own text had changed and the other field's own
 * typed value was untouched in its own state. From the owner's seat that
 * read exactly as "the field I didn't touch reset to its default". This was
 * never a draft-state/server-resync bug -- the what-if has never made a
 * server round trip (see `tests/ui-006a.test.ts`'s non-persistence tests) --
 * it was a single shared pair of state cells coupling two otherwise-
 * independent inputs' VISIBLE effect.
 *
 * Fix: remove the "applied"/"not applied" concept entirely. Each growth
 * field has its own independent `useState`.
 *
 * B3 (RULING): each field SEEDS from the portfolio's own saved growth
 * assumption when one is recorded, defaulting to 6%/yr only when none
 * exists (`portfolioValueGrowthPercentDecimal`/`portfolioDividendGrowthPercentDecimal`
 * already encode exactly that resolution). The "(what-if)" suffix applies
 * only once the owner EDITS a field away from its seed -- an untouched
 * axis's override is `undefined`, so the baseline's own owner-set/default
 * source passes straight through.
 *
 * B1 (BLOCKING): the controlled input's OWN value stays instant; the
 * RECOMPUTE reads a separately-debounced (~300ms) echo, so a mid-typing
 * invalid state ("3.", "", a lone "-") never flashes the table/summary to
 * the fallback the way the original bug flashed it to the baseline.
 *
 * B2 (BLOCKING): a live recompute can itself fail (e.g. an overflow-class
 * growth input the decimal library rejects) even when the ORIGINAL
 * server-computed `multiYear` was fine -- this gets its OWN disclosure,
 * keyed off `activeProjection`, never `multiYear`, and the assumption
 * summary is suppressed entirely rather than describing rows that no
 * longer render.
 *
 * This test suite has no jsdom/interactive-DOM harness available (see
 * `tests/ui-006a.test.ts`'s `renderComponent` -- static `renderToStaticMarkup`
 * only), so "typing" cannot be simulated as real DOM events, and neither can
 * a post-edit ("touched") render. Coverage instead: (a) unit-tests the
 * exported pure resolver `resolveWhatIfGrowthPercentDecimal` and the domain
 * `projectMultiYearIncomeWhatIf` directly, (b) renders the component's
 * UNTOUCHED (fresh-mount) state to pin the B3 seeding contract, (c) pins the
 * B1 debounce and B2 unavailable-disclosure wiring structurally (source
 * pins) since neither is reachable through a static, event-free render, and
 * (d) renders a synthesized "baseline itself is overflow-class while
 * `multiYear` says ok:true" fixture to exercise the ACTUAL B2 rendering
 * branch end-to-end (documented in that test -- the real production trigger
 * is an owner typing an overflow value, which this harness cannot simulate,
 * but the code path exercised is identical either way).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  projectMultiYearIncome,
  projectMultiYearIncomeWhatIf,
  resolvePortfolioDividendGrowth,
  resolvePortfolioValueGrowth,
  type MultiYearProjectionAssumptions,
  type MultiYearProjectionInput,
} from "../domain/dividends/projection.ts";
import {
  resolveWhatIfGrowthPercentDecimal,
  WHATIF_DEFAULT_GROWTH_PERCENT_DECIMAL,
} from "../app/income-whatif.ts";

// --- Fixtures (self-contained, mirrors tests/ui-006a.test.ts's shapes) ---

// A portfolio WITH a recorded growth assumption on both axes.
const savedAssumptions: MultiYearProjectionAssumptions = {
  currentPortfolioValueDecimal: "10000.00",
  currentPortfolioValueStatus: "available",
  baseForecastGrossDecimal: "600.00",
  baseForecastCashDecimal: "480.00",
  baseYieldIncludesPartialTtm: false,
  baseForecastFrankingIncomplete: false,
  baseExcludedSecurityCount: 0,
  valueGrowthPercentDecimal: "8",
  valueGrowthSource: "portfolio_assumption",
  dividendGrowthPercentDecimal: "3",
  dividendGrowthSource: "portfolio_assumption",
};
const savedBaselineInput: MultiYearProjectionInput = {
  assumptions: savedAssumptions,
  yearsForward: 2,
  startEndingYear: 2025,
};
const savedMultiYear = projectMultiYearIncome(savedBaselineInput);

// A portfolio with NO recorded growth assumption on either axis -- the
// domain resolvers (`resolvePortfolioValueGrowth`/`resolvePortfolioDividendGrowth`)
// already default an unset assumption to 6%/yr, source "none", so this
// mirrors exactly what the service hands the component in that case.
const noneAssumptions: MultiYearProjectionAssumptions = {
  ...savedAssumptions,
  valueGrowthPercentDecimal: "6",
  valueGrowthSource: "none",
  dividendGrowthPercentDecimal: "6",
  dividendGrowthSource: "none",
};
const noneBaselineInput: MultiYearProjectionInput = {
  assumptions: noneAssumptions,
  yearsForward: 2,
  startEndingYear: 2025,
};
const noneMultiYear = projectMultiYearIncome(noneBaselineInput);

const basePropsShape = {
  portfolioId: "portfolio-a",
  assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
  dividendsHref: "/portfolio/portfolio-a/income/dividends",
  baseCurrencyCode: "AUD",
  pastFinancialYears: { ok: true, rows: [] },
  currentFinancialYear: { ok: false, reason: "invalid_start_month" },
  yearsBack: 0,
  yearsForward: 2,
};

const savedProps = {
  ...basePropsShape,
  multiYear: savedMultiYear,
  multiYearBaselineInput: savedBaselineInput,
  portfolioValueGrowthPercentDecimal: "8",
  portfolioDividendGrowthPercentDecimal: "3",
};

const noneProps = {
  ...basePropsShape,
  multiYear: noneMultiYear,
  multiYearBaselineInput: noneBaselineInput,
  portfolioValueGrowthPercentDecimal: "6",
  portfolioDividendGrowthPercentDecimal: "6",
};

// DIV-014 added a `useRouter()` call to `IncomeMultiYear` (`router.refresh()`
// after the new "Save Scenario" save/delete calls), so a bare
// `renderToStaticMarkup` now throws "invariant expected app router to be
// mounted". Mirrors `tests/wlt-001.test.ts`'s `AppRouterContext.Provider`
// stub wrapping for `portfolio-shell.tsx` (also a `useRouter()` consumer) --
// harmless for components that don't call `useRouter` at all.
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

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(${componentName}, props),
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

function renderMultiYear(props: Record<string, unknown>) {
  return renderComponent(
    "IncomeMultiYear",
    "../app/components/income-multi-year.tsx",
    props,
  );
}

function extractWhatIfSection(html: string): string {
  const match = html.match(/<section class="income-whatif"[\s\S]*?<\/section>/);
  assert.ok(match, "expected an .income-whatif section");
  return match![0];
}

async function readComponentSource(): Promise<string> {
  return readFile(
    new URL("../app/components/income-multi-year.tsx", import.meta.url),
    "utf8",
  );
}

// --- B3 (RULING): seed from the saved assumption, or 6% when none ------

test("DIV-012 (B3 RULING): when a saved portfolio growth assumption is recorded, both what-if fields seed from it -- and the summary shows owner-set semantics, never a premature '(what-if)' -- on the very first (untouched) render", () => {
  const html = renderMultiYear(savedProps);
  const whatIf = extractWhatIfSection(html);
  const inputValues = [...whatIf.matchAll(/<input[^>]*\bvalue="([^"]*)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(inputValues, ["8", "3"]);
  assert.match(html, /compounds at 8%\/yr(?! \(what-if\))/);
  assert.match(html, /compound at 3%\/yr(?! \(what-if\))/);
  assert.doesNotMatch(html, /\(what-if\)/);
});

test("DIV-012 (B3 RULING): when NO portfolio growth assumption is recorded, both fields seed at the domain-resolved 6%/yr default -- and the summary shows the honest '(default)' label, never bare and never '(what-if)' -- on the very first (untouched) render", () => {
  const html = renderMultiYear(noneProps);
  const whatIf = extractWhatIfSection(html);
  const inputValues = [...whatIf.matchAll(/<input[^>]*\bvalue="([^"]*)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(inputValues, ["6", "6"]);
  assert.match(html, /compounds at 6%\/yr \(default\)/);
  assert.match(html, /compound at 6%\/yr \(default\)/);
  assert.doesNotMatch(html, /\(what-if\)/);
});

test("DIV-012 (B3 RULING): the domain resolvers this seed relies on really do default an UNSET assumption to 6%/yr -- ties the 'none' fixture above to the real service contract, not a fabricated one", () => {
  const unsetValue = resolvePortfolioValueGrowth(null);
  assert.equal(unsetValue.source, "none");
  assert.equal(unsetValue.growthPercentDecimal, "6");
  const unsetDividend = resolvePortfolioDividendGrowth(null);
  assert.equal(unsetDividend.source, "none");
  assert.equal(unsetDividend.growthPercentDecimal, "6");
  // And an owner-set value is NEVER overridden (CALCULATIONS.md:696).
  const setValue = resolvePortfolioValueGrowth("11");
  assert.equal(setValue.source, "portfolio_assumption");
  assert.equal(setValue.growthPercentDecimal, "11");
});

test("DIV-012 (B3 RULING, structural pin): each field seeds its useState from the SAVED-assumption prop, not a hardcoded constant -- and each axis's override is passed to the pure projector ONLY once that axis's OWN touched flag is true (an untouched axis stays undefined, letting the baseline's own source through)", async () => {
  const source = await readComponentSource();
  assert.match(
    source,
    /const \[valueGrowthInput, setValueGrowthInput\] = useState\(\s*portfolioValueGrowthPercentDecimal,?\s*\);/,
  );
  assert.match(
    source,
    /const \[dividendGrowthInput, setDividendGrowthInput\] = useState\(\s*portfolioDividendGrowthPercentDecimal,?\s*\);/,
  );
  assert.match(
    source,
    /valueGrowthPercentDecimal: valueGrowthTouched\s*\n?\s*\?\s*resolvedValueGrowthPercentDecimal\s*\n?\s*:\s*undefined,/,
  );
  assert.match(
    source,
    /dividendGrowthPercentDecimal: dividendGrowthTouched\s*\n?\s*\?\s*resolvedDividendGrowthPercentDecimal\s*\n?\s*:\s*undefined,/,
  );
});

// --- Invalid/empty input fallback (never NaN, never a fabricated 0) ----

test("DIV-012: resolveWhatIfGrowthPercentDecimal falls back to the honest 6%/yr default for empty/invalid input -- never NaN, never a fabricated 0", () => {
  for (const raw of ["", "   ", "abc", "-", ".", "-.", "1e3", "6%", "NaN"]) {
    assert.equal(
      resolveWhatIfGrowthPercentDecimal(raw),
      "6",
      `expected "${raw}" to fall back to the default`,
    );
  }
});

test("DIV-012: resolveWhatIfGrowthPercentDecimal passes through a genuinely valid plain decimal unchanged (trimmed)", () => {
  assert.equal(resolveWhatIfGrowthPercentDecimal("3.25"), "3.25");
  assert.equal(resolveWhatIfGrowthPercentDecimal("-1.5"), "-1.5");
  assert.equal(resolveWhatIfGrowthPercentDecimal("  4  "), "4");
  assert.equal(resolveWhatIfGrowthPercentDecimal("0"), "0");
});

test("DIV-012: the exported WHATIF_DEFAULT_GROWTH_PERCENT_DECIMAL constant is a real, non-zero 6", () => {
  assert.equal(WHATIF_DEFAULT_GROWTH_PERCENT_DECIMAL, "6");
});

// --- B1 (BLOCKING): debounce the recompute, not the input ---------------

test("DIV-012 (B1, BLOCKING, structural pin): the recompute reads a SEPARATELY-DEBOUNCED echo of each input (~300ms via WHATIF_DEBOUNCE_MS, two independent useEffect+setTimeout+clearTimeout blocks), never the raw input directly -- so a transient mid-typing invalid state cannot flash the table/summary the way the original cross-reset bug flashed it", async () => {
  const source = await readComponentSource();
  assert.match(source, /const WHATIF_DEBOUNCE_MS = \d+;/);
  const debounceMs = Number(
    source.match(/const WHATIF_DEBOUNCE_MS = (\d+);/)?.[1],
  );
  assert.ok(
    debounceMs >= 200 && debounceMs <= 500,
    `expected a ~300ms debounce, got ${debounceMs}`,
  );
  // Two independent debounce effects (value axis, dividend axis) -- each
  // its own timer, each cleared on the NEXT keystroke via the effect
  // cleanup, so only a SETTLED value ever reaches the debounced state.
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*const timer = setTimeout\(\(\) => \{\s*setDebouncedValueGrowthInput\(valueGrowthInput\);\s*\}, WHATIF_DEBOUNCE_MS\);\s*return \(\) => clearTimeout\(timer\);\s*\}, \[valueGrowthInput\]\);/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*const timer = setTimeout\(\(\) => \{\s*setDebouncedDividendGrowthInput\(dividendGrowthInput\);\s*\}, WHATIF_DEBOUNCE_MS\);\s*return \(\) => clearTimeout\(timer\);\s*\}, \[dividendGrowthInput\]\);/,
  );
  // The RECOMPUTE resolves the DEBOUNCED echo -- never
  // `resolveWhatIfGrowthPercentDecimal(valueGrowthInput)`/`(dividendGrowthInput)`
  // directly, which would bypass the debounce entirely.
  assert.match(
    source,
    /resolveWhatIfGrowthPercentDecimal\(\s*debouncedValueGrowthInput,?\s*\)/,
  );
  assert.match(
    source,
    /resolveWhatIfGrowthPercentDecimal\(debouncedDividendGrowthInput\)/,
  );
  assert.doesNotMatch(
    source,
    /resolveWhatIfGrowthPercentDecimal\(\s*valueGrowthInput,?\s*\)/,
  );
  assert.doesNotMatch(
    source,
    /resolveWhatIfGrowthPercentDecimal\(dividendGrowthInput\)/,
  );
});

test("DIV-012 (B1, structural pin): the controlled <input>'s own `value` stays wired to the INSTANT raw state, never the debounced one -- typing itself must never lag even though the recompute does", async () => {
  const source = await readComponentSource();
  assert.match(source, /value={valueGrowthInput}/);
  assert.match(source, /value={dividendGrowthInput}/);
  assert.doesNotMatch(source, /value={debouncedValueGrowthInput}/);
  assert.doesNotMatch(source, /value={debouncedDividendGrowthInput}/);
});

// --- B2 (BLOCKING): a live recompute failure gets its own disclosure ---

test("DIV-012 (B2, BLOCKING): an overflow-class growth override (8 digits) at a 10-years-forward baseline fails the pure projector honestly (ok:false, invalid_decimal) -- names the exact scenario review flagged, independent of the component", () => {
  const tenYearBaseline: MultiYearProjectionInput = {
    assumptions: savedAssumptions,
    yearsForward: 10,
    startEndingYear: 2025,
  };
  const result = projectMultiYearIncomeWhatIf(tenYearBaseline, {
    valueGrowthPercentDecimal: "99999999",
    dividendGrowthPercentDecimal: "99999999",
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "invalid_decimal");
});

// The real production trigger for this is an owner TYPING an overflow value
// into a what-if box (untestable here -- no jsdom/event harness). This
// fixture instead gives `multiYearBaselineInput` itself overflow-class
// growth while deliberately keeping the `multiYear` PROP marked `ok: true`
// (standing in for "the original server compute was fine") -- exercising
// the IDENTICAL code path (`activeProjectionUnavailable` computed from
// `activeProjection.ok`, never `multiYear.ok`) a live-typed overflow value
// would hit, end to end through the real component render.
const overflowAssumptions: MultiYearProjectionAssumptions = {
  ...savedAssumptions,
  valueGrowthPercentDecimal: "99999999",
  dividendGrowthPercentDecimal: "99999999",
};
const overflowBaselineInput: MultiYearProjectionInput = {
  assumptions: overflowAssumptions,
  yearsForward: 10,
  startEndingYear: 2025,
};
const overflowProps = {
  ...basePropsShape,
  yearsForward: 10,
  // Deliberately a DIFFERENT, perfectly fine result -- proves the banner
  // below cannot be keyed off this prop.
  multiYear: savedMultiYear,
  multiYearBaselineInput: overflowBaselineInput,
  portfolioValueGrowthPercentDecimal: "8",
  portfolioDividendGrowthPercentDecimal: "3",
};

test("DIV-012 (B2, BLOCKING): when the live recompute itself fails, a dedicated 'What-if projection unavailable' banner renders -- keyed off activeProjection, NOT the (perfectly fine) multiYear prop -- and states 'That combination could not be projected.'", () => {
  const html = renderMultiYear(overflowProps);
  assert.doesNotMatch(html, /Forward projection unavailable/);
  assert.match(html, /What-if projection unavailable/);
  assert.match(html, /That combination could not be projected\./);
});

test("DIV-012 (B2, BLOCKING): when the live recompute has failed, the assumption-summary paragraph is suppressed ENTIRELY -- it must never describe rows that are not rendered", () => {
  const html = renderMultiYear(overflowProps);
  assert.doesNotMatch(html, /class="income-assumption-summary"/);
});

test("DIV-012 (B2, BLOCKING, structural pin): activeProjectionUnavailable is derived from activeProjection.ok, never from multiYear.ok", async () => {
  const source = await readComponentSource();
  assert.match(
    source,
    /const activeProjectionUnavailable =\s*\n?\s*multiYearBaselineInput !== null && !activeProjection\.ok;/,
  );
});

// --- No Apply/Reset controls, no shared 'applied' marker ----------------

test("DIV-012: no Apply/Reset button exists anywhere in the what-if section, and no shared 'applied' marker gates the projection", () => {
  const html = renderMultiYear(savedProps);
  const whatIf = extractWhatIfSection(html);
  assert.doesNotMatch(whatIf, /<button/);
  assert.doesNotMatch(whatIf, />Apply</);
  assert.doesNotMatch(whatIf, />Reset</);
  assert.doesNotMatch(whatIf, /Applied, not saved/);
});

// --- Cross-reset regression pin (the exact quirk) -----------------------

test("DIV-012 (cross-reset regression pin): the removed shared 'applied' state cells no longer exist anywhere in the component source, and each input's onChange writes ONLY its own independent field state + its own field's touched flag, never the sibling's", async () => {
  const source = await readComponentSource();
  // The exact pre-fix shared-gate identifiers are gone entirely -- not
  // renamed, not still present but unused: structurally removed.
  for (const identifier of [
    "whatIfApplied",
    "whatIfResult",
    "applyWhatIf",
    "resetWhatIf",
    "setWhatIfApplied",
    "setWhatIfResult",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\b${identifier}\\b`),
      `expected the removed "${identifier}" identifier to be gone entirely`,
    );
  }
  assert.match(
    source,
    /onChange={\(event\) => \{\s*setValueGrowthInput\(event\.target\.value\);\s*setValueGrowthTouched\(true\);\s*\}}/,
  );
  assert.match(
    source,
    /onChange={\(event\) => \{\s*setDividendGrowthInput\(event\.target\.value\);\s*setDividendGrowthTouched\(true\);\s*\}}/,
  );
  // Two independent touched-flag useState calls.
  assert.match(
    source,
    /const \[valueGrowthTouched, setValueGrowthTouched\] = useState\(false\);/,
  );
  assert.match(
    source,
    /const \[dividendGrowthTouched, setDividendGrowthTouched\] = useState\(false\);/,
  );
});

test("DIV-012: the what-if is still recomputed CLIENT-SIDE via the pure domain projector on every render -- confirms this was never a server-round-trip/draft-resync bug", async () => {
  const source = await readComponentSource();
  assert.match(source, /"use client"/);
  // DIV-014 added a genuinely NEW, explicitly-persisted "Save Scenario"
  // feature to this SAME file -- every `fetch(` this file now contains
  // must belong to THAT feature's own CSRF-gated route, never the growth
  // what-if this test is about (see `tests/div-014.test.ts` for that
  // feature's own coverage; `tests/ui-006a.test.ts` carries the identical
  // scoped assertion).
  const fetchCalls = source.match(/fetch\(/g) ?? [];
  const scenarioRouteFetchCalls =
    source.match(
      /fetch\(\s*\n?\s*`\/api\/portfolios\/\$\{portfolioId\}\/income-scenarios`/g,
    ) ?? [];
  assert.equal(fetchCalls.length, scenarioRouteFetchCalls.length);
  assert.ok(scenarioRouteFetchCalls.length > 0);
  assert.doesNotMatch(source, /"use server"/);
  assert.match(
    source,
    /activeProjection = multiYearBaselineInput\s*\n?\s*\?\s*projectMultiYearIncomeWhatIf/,
  );
});

// --- Select-on-focus/click (mobile tap included) ------------------------

test("DIV-012 (owner directive): clicking or focusing either what-if field selects its current contents -- select() on both onFocus and onClick, for mobile tap coverage", async () => {
  const source = await readComponentSource();
  const selectHandlerCount = (
    source.match(/onFocus={\(event\) => event\.currentTarget\.select\(\)}/g) ??
    []
  ).length;
  const clickHandlerCount = (
    source.match(/onClick={\(event\) => event\.currentTarget\.select\(\)}/g) ??
    []
  ).length;
  // DIV-013 (owner directive, 2026-08-24) reuses this identical
  // select-on-focus/click convention on 5 more numeric fields in the new
  // "Add/Remove Capital" section (amount, year, yield, capital growth,
  // dividend growth) -- 2 (this test's original growth what-if pair) + 5 =
  // 7 total across the whole component source.
  assert.equal(
    selectHandlerCount,
    7,
    "expected onFocus select() on the growth what-if pair plus the 5 DIV-013 capital-event fields",
  );
  assert.equal(
    clickHandlerCount,
    7,
    "expected onClick select() on the growth what-if pair plus the 5 DIV-013 capital-event fields",
  );
});

// --- Fold: hint moved out of <label> to aria-describedby ----------------

test("DIV-012 (review fold): the per-field invalid-input hint is NOT nested inside the <label> (which would fold it into the input's accessible NAME) -- it is a sibling element, associated instead via aria-describedby, mirroring dividend-assumptions-editor.tsx's precedent", () => {
  const html = renderMultiYear(savedProps);
  const whatIf = extractWhatIfSection(html);
  // Each <label> contains ONLY the caption span + the input -- no hint text
  // nested inside it.
  const labelMatches = [...whatIf.matchAll(/<label>([\s\S]*?)<\/label>/g)];
  assert.equal(labelMatches.length, 2);
  for (const match of labelMatches) {
    assert.doesNotMatch(match[1], /Using the default/);
  }
  // Both inputs' `aria-describedby` targets are absent here (both fields are
  // seeded with genuinely valid saved values in this fixture, so no hint
  // renders) -- the wiring itself is pinned below with an invalid fixture.
  assert.doesNotMatch(whatIf, /aria-describedby/);
});

test("DIV-012 (review fold): once a field's settled value is invalid, its hint renders as a sibling of the <label> (inside the shared .income-whatif-field wrapper) with a stable id, and the input's aria-describedby points at that exact id", async () => {
  const source = await readComponentSource();
  // Structural pin (an invalid SEEDED value cannot be reached through props
  // any more -- seeding always comes from the service's own valid decimal
  // strings -- so this is a source pin on the wiring itself, mirroring the
  // debounce/B2 pins above).
  assert.match(
    source,
    /aria-describedby={\s*\n?\s*valueGrowthHintVisible\s*\n?\s*\?\s*"whatif-value-growth-hint"\s*\n?\s*:\s*undefined\s*\n?\s*}/,
  );
  assert.match(
    source,
    /<span id="whatif-value-growth-hint" className="unavailable">/,
  );
  assert.match(
    source,
    /aria-describedby={\s*\n?\s*dividendGrowthHintVisible\s*\n?\s*\?\s*"whatif-dividend-growth-hint"\s*\n?\s*:\s*undefined\s*\n?\s*}/,
  );
  assert.match(
    source,
    /<span id="whatif-dividend-growth-hint" className="unavailable">/,
  );
  // The hint's visibility (and the aria-describedby it drives) is gated on
  // the DEBOUNCED (settled) input, same B1 no-flash guarantee as the
  // table/summary -- never the raw input.
  assert.match(
    source,
    /const valueGrowthHintVisible = !isValidGrowthInput\(debouncedValueGrowthInput\);/,
  );
});
