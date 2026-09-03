import { useEffect, useRef } from "react";
import { RecordDividendDialog } from "yieldtome-ui";

type Props = Parameters<typeof RecordDividendDialog>[0];

const securities: Props["securities"] = [
  { portfolioSecurityId: "ps-vas", symbol: "VAS", currencyCode: "AUD" },
  { portfolioSecurityId: "ps-cba", symbol: "CBA", currencyCode: "AUD" },
  { portfolioSecurityId: "ps-wes", symbol: "WES", currencyCode: "AUD" },
  { portfolioSecurityId: "ps-vgs", symbol: "VGS", currencyCode: "AUD" },
  { portfolioSecurityId: "ps-aapl", symbol: "AAPL", currencyCode: "USD" },
];

const shell = {
  portfolioId: "p1",
  securities,
  baseCurrencyCode: "AUD",
  maxDate: "2026-09-04",
};

/** Opens the native dialog non-modally so it renders inline in the preview card. */
function OpenDialog(props: Omit<Props, "dialogRef" | "onClose">) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.show();
  }, []);
  return (
    <RecordDividendDialog {...props} dialogRef={dialogRef} onClose={() => {}} />
  );
}

/** Fresh "Record dividend received" form -- nothing prefilled. */
export function RecordNew() {
  return <OpenDialog {...shell} />;
}

/** Recording a manual CBA dividend per share, with shares and franking filled in so the computed totals show. */
export function PerShareFilled() {
  return (
    <OpenDialog
      {...shell}
      initialPortfolioSecurityId="ps-cba"
      initialPaymentDate="2026-03-27"
      initialSharesDecimal="420"
      initialDividendPerShareDecimal="2.25"
      initialFrankingCreditPerShareDecimal="0.964285"
    />
  );
}

/** Editing an auto-populated (event-linked) VAS distribution -- title changes and no totals mode is offered. */
export function EditEventLinked() {
  return (
    <OpenDialog
      {...shell}
      initialPortfolioSecurityId="ps-vas"
      initialPaymentDate="2026-07-17"
      initialDividendEventId="evt-vas-2026-q4"
      initialSharesDecimal="1180"
      initialDividendPerShareDecimal="0.3494"
      initialFrankingCreditPerShareDecimal="0.1002"
      initialExpectedVersion={2}
    />
  );
}

/** A standalone imported row already stored as totals (Sharesight payout shape), reopened for override. */
export function TotalsMode() {
  return (
    <OpenDialog
      {...shell}
      initialPortfolioSecurityId="ps-wes"
      initialPaymentDate="2026-04-01"
      initialManualRecordId="man-wes-2026-04"
      initialAmountMode="totals"
      initialTotalCashDecimal="386.10"
      initialTotalFrankingDecimal="165.47"
      initialExpectedVersion={1}
    />
  );
}

/** An event-linked row that superseded both a receipt and a USD Sharesight import; also marked excluded. */
export function WithSupersededEvidence() {
  return (
    <OpenDialog
      {...shell}
      initialPortfolioSecurityId="ps-aapl"
      initialPaymentDate="2026-05-15"
      initialDividendEventId="evt-aapl-2026-05"
      initialSharesDecimal="150"
      initialDividendPerShareDecimal="0.26"
      initialFrankingCreditPerShareDecimal="0"
      initialExpectedVersion={3}
      initialExclude
      dominatedReceipt={{
        sharesDecimal: "150",
        dividendPerShareDecimal: "0.25",
        frankingPerShareDecimal: null,
        paymentDate: "2026-05-15",
      }}
      dominatedImported={{
        sharesDecimal: "150",
        dividendPerShareDecimal: "0.26",
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "39.00",
        totalFrankingDecimal: null,
        paymentDate: "2026-05-15",
        currencyCode: "USD",
        fxRateToPortfolioDecimal: "1.5312",
        fxRateSource: "sharesight",
      }}
      additionalReceiptsCount={1}
      additionalImportedCount={2}
    />
  );
}
