import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseManualLedgerForm,
  previewFromPrepared,
} from "../app/manual-ledger-contract.ts";
import { prepareLedgerPosting } from "../domain/ledger/posting.ts";

const base = {
  type: "buy",
  portfolioSecurityId: "membership-a",
  quantityDecimal: "2",
  unitPriceDecimal: "10.25",
  grossAmountDecimal: "20.50",
  feeAmountDecimal: "1.25",
  taxAmountDecimal: "0.50",
  currencyCode: "USD",
  tradeAt: "2026-08-03T10:00:00.000Z",
  localTradeDate: "2026-08-03",
  settlementDate: "2026-08-05",
  fxRateToBaseDecimal: null,
  fxRateSource: null,
  fxObservedAt: null,
  sourceReference: null,
};

test("manual contract supports each supported type and rejects deferred income/transfers", () => {
  for (const type of [
    "buy",
    "sell",
    "cash_deposit",
    "cash_withdrawal",
    "fee",
    "tax",
    "split",
  ]) {
    const input =
      type === "split"
        ? {
            ...base,
            type,
            grossAmountDecimal: null,
            quantityDecimal: "3",
            unitPriceDecimal: "2",
            feeAmountDecimal: "0",
            taxAmountDecimal: "0",
          }
        : type === "buy" || type === "sell"
          ? { ...base, type }
          : {
              ...base,
              type,
              portfolioSecurityId: null,
              quantityDecimal: null,
              unitPriceDecimal: null,
              grossAmountDecimal: "10",
            };
    assert.equal(
      parseManualLedgerForm(
        input,
        "portfolio-a",
        "request-a",
        "manual-ledger:key",
      ).ok,
      true,
      type,
    );
  }
  const deferred = parseManualLedgerForm(
    { ...base, type: "dividend" },
    "portfolio-a",
    "request-a",
    "manual-ledger:key",
  );
  assert.equal(deferred.ok, false);
  assert.match(deferred.ok ? "" : deferred.message, /Transfers and dividends/);
});

test("manual contract keeps exact preview values and exposes missing FX", () => {
  const parsed = parseManualLedgerForm(
    base,
    "portfolio-a",
    "request-a",
    "manual-ledger:key",
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const prepared = prepareLedgerPosting(parsed.input);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const preview = previewFromPrepared(
    "buy",
    parsed.input,
    prepared.posting,
    "AUD",
  );
  assert.equal(preview.grossAmountDecimal, "20.5");
  assert.equal(preview.cashEffectDecimal, "-22.25");
  assert.equal(preview.fxStatus, "unavailable");
});

test("manual contract fails closed for invalid exact decimals, ratios, and dates", () => {
  const invalidDate = parseManualLedgerForm(
    { ...base, localTradeDate: "2026-02-30" },
    "portfolio-a",
    "request-a",
    "manual-ledger:key",
  );
  assert.equal(invalidDate.ok, true);
  if (!invalidDate.ok) return;
  assert.equal(prepareLedgerPosting(invalidDate.input).ok, false);

  const invalidDecimal = parseManualLedgerForm(
    { ...base, quantityDecimal: "1e2" },
    "portfolio-a",
    "request-a",
    "manual-ledger:key",
  );
  assert.equal(invalidDecimal.ok, true);
  if (!invalidDecimal.ok) return;
  assert.equal(prepareLedgerPosting(invalidDecimal.input).ok, false);

  const invalidRatio = parseManualLedgerForm(
    {
      ...base,
      type: "split",
      grossAmountDecimal: null,
      quantityDecimal: "0",
      unitPriceDecimal: "2",
      feeAmountDecimal: "0",
      taxAmountDecimal: "0",
    },
    "portfolio-a",
    "request-a",
    "manual-ledger:key",
  );
  assert.equal(invalidRatio.ok, true);
  if (!invalidRatio.ok) return;
  assert.equal(prepareLedgerPosting(invalidRatio.input).ok, false);
});

test("manual entry boundary is authenticated, same-origin, immutable, and mobile-labelled", async () => {
  const [
    actions,
    component,
    page,
    postRoute,
    reverseRoute,
    replaceRoute,
    styles,
  ] = await Promise.all([
    readFile(
      new URL("../app/manual-ledger-actions.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/manual-ledger-entry.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/ledger/new/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/api/portfolios/[portfolioId]/ledger/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/api/portfolios/[portfolioId]/ledger/[transactionId]/reverse/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/api/portfolios/[portfolioId]/ledger/[transactionId]/supersede/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /getAuthenticatedSqlContext/);
  assert.match(actions, /randomUUID/);
  assert.match(actions, /createOwnedLedgerRepository/);
  assert.match(actions, /supersede/);
  assert.match(actions, /reverse/);
  assert.match(component, /Buy/);
  assert.match(component, /Cash deposit/);
  assert.match(component, /Split numerator/);
  assert.match(component, /Server impact preview/);
  assert.match(component, /FX unavailable/);
  assert.match(component, /original transaction[\s\S]*remain unchanged/);
  assert.match(page, /loadOwnedManualLedgerOptions/);
  assert.match(postRoute, /rejectCrossSiteMutation/);
  assert.match(reverseRoute, /rejectCrossSiteMutation/);
  assert.match(replaceRoute, /rejectCrossSiteMutation/);
  assert.match(styles, /\.manual-ledger-grid[\s\S]*min-height: 44px/);
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.manual-ledger-grid/,
  );
});
