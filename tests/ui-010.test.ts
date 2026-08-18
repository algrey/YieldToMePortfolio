/** UI-010 — dominated-evidence disclosure in the per-security Dividends tab.
 *
 * `domain/dividends/history.ts`'s derived rows carry dominated-evidence
 * fields (`dominatedReceipt`, `dominatedImported`, `additionalReceiptsCount`,
 * `additionalImportedCount`) that DIV-004/DIV-005 populate to guarantee
 * folded-in evidence is disclosed, never silently dropped -- but until this
 * task no UI ever read them. Covers: `foldedInReceiptCount`/
 * `foldedInImportedCount` (the pure counting helpers), the tab's row-level
 * compact markers and totals-adjacent note, and `RecordDividendDialog`'s
 * read-only "superseded by this row" evidence panel.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  foldedInImportedCount,
  foldedInReceiptCount,
} from "../app/dividend-history-prefill.ts";
import type {
  DerivedDividendRow,
  FrankingResolution,
} from "../domain/dividends/index.ts";

// ---------------------------------------------------------------------------
// foldedInReceiptCount / foldedInImportedCount -- pure counting helpers.
// ---------------------------------------------------------------------------

function franking(
  source: "override" | "default" | "unknown",
  value: string | null,
): FrankingResolution {
  if (source === "unknown") return { source: "unknown", perShareDecimal: null };
  return { source, perShareDecimal: value as string };
}

function row(overrides: Partial<DerivedDividendRow>): DerivedDividendRow {
  return {
    id: "de1",
    portfolioSecurityId: "psa1",
    dividendEventId: "de1",
    kind: "cash",
    currencyCode: "AUD",
    exDate: "2026-03-01",
    paymentDate: "2026-03-01",
    sharesDecimal: "100",
    dividendPerShareDecimal: "1.50",
    cashDecimal: "150",
    franking: franking("override", "0.30"),
    frankingTotalDecimal: "30",
    grossDecimal: "180",
    grossIncludesFranking: true,
    status: "ex_date_passed",
    source: "manual",
    excluded: false,
    amountUnknown: false,
    providerGrossPerShareDecimal: "1.00",
    dominatedReceipt: null,
    dominatedImported: null,
    additionalReceiptsCount: 0,
    additionalImportedCount: 0,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
    ...overrides,
  };
}

const sampleDominatedReceipt = {
  sharesDecimal: "100",
  dividendPerShareDecimal: "1.40",
  frankingPerShareDecimal: "0.28",
  paymentDate: "2026-03-05",
};

const sampleDominatedImported = {
  sharesDecimal: "100",
  dividendPerShareDecimal: "1.35",
  frankingCreditPerShareDecimal: null,
  totalCashDecimal: null,
  totalFrankingDecimal: null,
  paymentDate: "2026-03-08",
  currencyCode: null,
  fxRateToPortfolioDecimal: null,
  fxRateSource: null,
};

test("UI-010: foldedInReceiptCount is 0 for a row with no dominated receipt and no additional count", () => {
  assert.equal(foldedInReceiptCount(row({})), 0);
});

test("UI-010: foldedInReceiptCount counts a dominated receipt as 1 plus any additional count", () => {
  assert.equal(
    foldedInReceiptCount(
      row({
        dominatedReceipt: sampleDominatedReceipt,
        additionalReceiptsCount: 2,
      }),
    ),
    3,
  );
});

test("UI-010: foldedInReceiptCount counts additionalReceiptsCount alone when the row's own source IS the receipt (dominatedReceipt null)", () => {
  assert.equal(
    foldedInReceiptCount(
      row({
        source: "receipt",
        dominatedReceipt: null,
        additionalReceiptsCount: 1,
      }),
    ),
    1,
  );
});

test("UI-010: foldedInImportedCount is 0 for a row with no dominated imported record and no additional count", () => {
  assert.equal(foldedInImportedCount(row({})), 0);
});

test("UI-010: foldedInImportedCount counts a dominated imported record as 1 plus any additional count", () => {
  assert.equal(
    foldedInImportedCount(
      row({
        dominatedImported: sampleDominatedImported,
        additionalImportedCount: 3,
      }),
    ),
    4,
  );
});

// ---------------------------------------------------------------------------
// Rendered tab: row-level markers and the totals-adjacent note.
// ---------------------------------------------------------------------------

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

const sampleLifetimeTotals = {
  currencyCode: "AUD",
  status: "ok" as const,
  rowCount: 1,
  excludedCount: 0,
  unknownAmountCount: 0,
  receivedCashDecimal: "150",
  receivedFrankingKnownDecimal: "30",
  receivedFrankingUnknownCount: 0,
  receivedGrossDecimal: "180",
  pendingCashDecimal: null,
  pendingFrankingKnownDecimal: null,
  pendingFrankingUnknownCount: 0,
  pendingGrossDecimal: null,
  pendingCount: 0,
};

const baseTabProps = {
  portfolioId: "pa",
  portfolioSecurityId: "psa1",
  symbol: "ALPHA",
  currencyCode: "AUD",
  today: "2026-08-13",
  rows: [row({})],
  filteredArtifactCount: 0,
  lifetimeTotals: sampleLifetimeTotals,
  overridesByEventId: {},
  manualRecordsById: {},
  assumptions: {
    dividendYieldPercentDecimal: null,
    frankingPercentDecimal: "50",
    dividendGrowthPercentDecimal: null,
    version: 1,
  },
  portfolioAssumptions: {
    valueGrowthPercentDecimal: null,
    portfolioDividendGrowthPercentDecimal: null,
    version: null,
  },
  holdingsHref: "/portfolio/pa/holdings",
};

test("UI-010: a row with a dominated receipt and additional receipts renders the '+N receipts folded in' marker as text, not colour", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      ...baseTabProps,
      rows: [
        row({
          dominatedReceipt: sampleDominatedReceipt,
          additionalReceiptsCount: 1,
        }),
      ],
    },
  );
  assert.match(html, /\+2 receipts folded in/);
  assert.match(html, /class="dividend-fold-note"/);
});

test("UI-010: a row with exactly one dominated receipt (no additional) renders the singular '+1 receipt folded in'", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      ...baseTabProps,
      rows: [row({ dominatedReceipt: sampleDominatedReceipt })],
    },
  );
  assert.match(html, /\+1 receipt folded in/);
  assert.doesNotMatch(html, /\+1 receipts folded in/);
});

test("UI-010: a row with a dominated imported record renders the '+N imported folded in' marker", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      ...baseTabProps,
      rows: [
        row({
          dominatedImported: sampleDominatedImported,
          additionalImportedCount: 1,
        }),
      ],
    },
  );
  assert.match(html, /\+2 imported folded in/);
});

test("UI-010: a plain row with no dominated evidence and zero additional counts renders no fold-in marker at all", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [row({})] },
  );
  assert.doesNotMatch(html, /folded in/);
  assert.doesNotMatch(html, /dividend-fold-note/);
});

test("UI-010: with at least one row carrying folded-in evidence, the totals-adjacent note renders once", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      ...baseTabProps,
      rows: [row({ dominatedReceipt: sampleDominatedReceipt })],
    },
  );
  const matches = html.match(/Some rows fold in additional records/g) ?? [];
  assert.equal(matches.length, 1);
});

test("UI-010: with no row carrying folded-in evidence, the totals-adjacent note does not render", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    { ...baseTabProps, rows: [row({})] },
  );
  assert.doesNotMatch(html, /Some rows fold in additional records/);
});

// ---------------------------------------------------------------------------
// RecordDividendDialog: read-only "superseded by this row" evidence panel.
// ---------------------------------------------------------------------------

const recordDialogSecurities = [
  { portfolioSecurityId: "psa1", symbol: "ALPHA", currencyCode: "AUD" },
];

function renderRecordDialog(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "RecordDividendDialog",
    "../app/components/dividend-assumptions-editor.tsx",
    {
      dialogRef: { current: null },
      portfolioId: "pa",
      securities: recordDialogSecurities,
      maxDate: "2026-08-13",
      ...overrides,
    },
  );
}

test("UI-010: the dialog renders the dominated receipt's values (per-share, franking, payment date) labelled as superseded, not counted in totals", () => {
  const html = renderRecordDialog({
    initialDividendEventId: "de1",
    initialPaymentDate: "2026-03-01",
    initialSharesDecimal: "100",
    initialDividendPerShareDecimal: "1.50",
    initialExpectedVersion: 1,
    dominatedReceipt: sampleDominatedReceipt,
  });
  assert.match(html, /Superseded by this row/);
  assert.match(html, /not counted separately in totals/);
  assert.match(html, /Receipt:/);
  assert.match(html, /1\.40/);
  assert.match(html, /0\.28/);
  assert.match(html, /2026-03-05/);
});

test("UI-010: the dialog renders the dominated imported record's values labelled as superseded", () => {
  const html = renderRecordDialog({
    initialDividendEventId: "de1",
    initialPaymentDate: "2026-03-01",
    initialSharesDecimal: "100",
    initialDividendPerShareDecimal: "1.50",
    initialExpectedVersion: 1,
    dominatedImported: sampleDominatedImported,
  });
  assert.match(html, /Superseded by this row/);
  assert.match(html, /Imported:/);
  assert.match(html, /1\.35/);
  assert.match(html, /2026-03-08/);
});

test("UI-010: the dialog discloses additionalReceiptsCount/additionalImportedCount as 'not shown individually' counts even with no single dominated fact of that kind", () => {
  const html = renderRecordDialog({
    initialDividendEventId: "de1",
    initialPaymentDate: "2026-03-01",
    initialSharesDecimal: "100",
    initialDividendPerShareDecimal: "1.50",
    initialExpectedVersion: 1,
    additionalReceiptsCount: 2,
    additionalImportedCount: 1,
  });
  assert.match(html, /\+2 more receipts not shown individually/);
  assert.match(html, /\+1 more imported not shown individually/);
});

test("UI-010: a totals-mode dominated imported record (BRK-005, null per-share/shares) renders its total cash rather than a fabricated per-share figure", () => {
  const html = renderRecordDialog({
    initialDividendEventId: "de1",
    initialPaymentDate: "2026-03-01",
    initialSharesDecimal: "100",
    initialDividendPerShareDecimal: "1.50",
    initialExpectedVersion: 1,
    dominatedImported: {
      sharesDecimal: null,
      dividendPerShareDecimal: null,
      frankingCreditPerShareDecimal: null,
      totalCashDecimal: "42.00",
      totalFrankingDecimal: null,
      paymentDate: "2026-03-09",
    },
  });
  assert.match(html, /Imported:/);
  assert.match(html, /42\.00/);
  assert.match(html, /total/);
});

test("UI-010: a fresh (non-row) dialog and a row-linked dialog with no dominated evidence render no 'superseded' panel", () => {
  const fresh = renderRecordDialog();
  assert.doesNotMatch(fresh, /Superseded by this row/);

  const noEvidence = renderRecordDialog({
    initialDividendEventId: "de1",
    initialPaymentDate: "2026-03-01",
    initialSharesDecimal: "100",
    initialDividendPerShareDecimal: "1.50",
    initialExpectedVersion: 1,
  });
  assert.doesNotMatch(noEvidence, /Superseded by this row/);
});

// ---------------------------------------------------------------------------
// QA-001B: markers/notes are plain text (colour, if any, is never the sole
// signal) -- assert the muted micro-label CSS declares a colour AND that the
// literal marker text is always present alongside it (covered above); this
// test just pins the class exists in globals.css with the established muted
// treatment, matching `.dividend-provider-note`/`.dividend-imported-note`.
// ---------------------------------------------------------------------------

test("UI-010: .dividend-fold-note reuses the app's established muted micro-label treatment", async () => {
  const { readFile } = await import("node:fs/promises");
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const match = styles.match(/\.dividend-fold-note\s*\{([^}]*)\}/);
  assert.ok(match, "expected a .dividend-fold-note rule in globals.css");
  assert.match(match![1]!, /color:\s*var\(--muted\)/);
});
