import { useEffect, useRef } from "react";
import { FyDetailDialog } from "yieldtome-ui";

type Props = Parameters<typeof FyDetailDialog>[0];
type Fy = Props["fy"];
type Row = Fy["rows"][number];
type Carried = NonNullable<Props["carried"]>;

const rowBase = {
  taxDecimal: "0",
  basisStatus: "complete",
  holdingPeriodEligible: true,
} as const;

const vasLongLot: Row = {
  ...rowBase,
  allocationId: "alloc-2025-01",
  portfolioSecurityId: "ps-vas",
  securitySymbol: "VAS",
  securityName: "Vanguard Australian Shares Index ETF",
  acquiredDate: "2021-02-15",
  disposedDate: "2025-05-06",
  quantityDecimal: "120",
  proceedsDecimal: "11760.00",
  basisDecimal: "8340.05",
  feeDecimal: "19.95",
  gainDecimal: "3400.00",
  discountThresholdDate: "2022-02-15",
  eligibility: "discount_eligible",
};

const vasShortLot: Row = {
  ...rowBase,
  allocationId: "alloc-2025-02",
  portfolioSecurityId: "ps-vas",
  securitySymbol: "VAS",
  securityName: "Vanguard Australian Shares Index ETF",
  acquiredDate: "2024-09-02",
  disposedDate: "2025-05-06",
  quantityDecimal: "30",
  proceedsDecimal: "2940.00",
  basisDecimal: "2340.00",
  feeDecimal: "0",
  gainDecimal: "600.00",
  holdingPeriodEligible: false,
  discountThresholdDate: "2025-09-02",
  eligibility: "discount_ineligible",
};

const cbaLoss: Row = {
  ...rowBase,
  allocationId: "alloc-2024-01",
  portfolioSecurityId: "ps-cba",
  securitySymbol: "CBA",
  securityName: "Commonwealth Bank of Australia",
  acquiredDate: "2022-11-08",
  disposedDate: "2024-03-19",
  quantityDecimal: "40",
  proceedsDecimal: "4480.00",
  basisDecimal: "5710.00",
  feeDecimal: "19.95",
  gainDecimal: "-1250.00",
  discountThresholdDate: "2023-11-08",
  eligibility: "not_applicable_loss",
};

const wesGain: Row = {
  ...rowBase,
  allocationId: "alloc-2026-01",
  portfolioSecurityId: "ps-wes",
  securitySymbol: "WES",
  securityName: "Wesfarmers Limited",
  acquiredDate: "2020-04-22",
  disposedDate: "2025-11-14",
  quantityDecimal: "85",
  proceedsDecimal: "6885.00",
  basisDecimal: "1744.55",
  feeDecimal: "19.95",
  gainDecimal: "5120.50",
  discountThresholdDate: "2021-04-22",
  eligibility: "discount_eligible",
};

const nabUnknown: Row = {
  ...rowBase,
  allocationId: "alloc-2026-03",
  portfolioSecurityId: "ps-nab",
  securitySymbol: "NAB",
  securityName: "National Australia Bank Limited",
  acquiredDate: "2019-08-30",
  disposedDate: "2026-04-10",
  quantityDecimal: "60",
  proceedsDecimal: "2262.00",
  basisDecimal: null,
  feeDecimal: "19.95",
  gainDecimal: null,
  basisStatus: "incomplete_basis",
  discountThresholdDate: "2020-08-30",
  eligibility: "unknown_incomplete_basis",
};

const fyBase = {
  excludedIncompleteCount: 0,
  excludedIncompleteSecurityNames: [] as string[],
  partialCoverage: false,
  discountRateDecimal: "0.5",
};

const fy2025: Fy = {
  ...fyBase,
  endingYear: 2025,
  label: "FY25",
  window: { startDate: "2024-07-01", endDate: "2025-06-30" },
  rows: [vasLongLot, vasShortLot],
  disposalCount: 2,
  totalDiscountableGainsGrossDecimal: "3400.00",
  totalNonDiscountableGainsGrossDecimal: "600.00",
  totalLossesDecimal: "0",
  lossAppliedToNonDiscountableDecimal: "0",
  lossAppliedToDiscountableDecimal: "0",
  remainingNonDiscountableAfterLossDecimal: "600.00",
  remainingDiscountableAfterLossDecimal: "3400.00",
  discountAppliedDecimal: "1700.00",
  netCapitalGainEstimateDecimal: "2300.00",
  unabsorbedLossDecimal: "0",
};

/** FY2025 with the FY2024 CBA loss ($1,250) brought forward and fully applied. */
const carried2025: Carried = {
  endingYear: 2025,
  carryInLossDecimal: "1250.00",
  carryInAppliedToNonDiscountableDecimal: "600.00",
  carryInAppliedToDiscountableDecimal: "650.00",
  carryInAppliedDecimal: "1250.00",
  remainingDiscountableAfterCarryInDecimal: "2750.00",
  discountAppliedDecimal: "1375.00",
  netCapitalGainEstimateDecimal: "1375.00",
  carryOutLossDecimal: "0",
  ownPartialCoverage: false,
  carriedFiguresPartial: false,
};

const fy2024: Fy = {
  ...fyBase,
  endingYear: 2024,
  label: "FY24",
  window: { startDate: "2023-07-01", endDate: "2024-06-30" },
  rows: [cbaLoss],
  disposalCount: 1,
  totalDiscountableGainsGrossDecimal: "0",
  totalNonDiscountableGainsGrossDecimal: "0",
  totalLossesDecimal: "1250.00",
  lossAppliedToNonDiscountableDecimal: "0",
  lossAppliedToDiscountableDecimal: "0",
  remainingNonDiscountableAfterLossDecimal: "0",
  remainingDiscountableAfterLossDecimal: "0",
  discountAppliedDecimal: "0",
  netCapitalGainEstimateDecimal: "0",
  unabsorbedLossDecimal: "1250.00",
};

const carried2024: Carried = {
  endingYear: 2024,
  carryInLossDecimal: "0",
  carryInAppliedToNonDiscountableDecimal: "0",
  carryInAppliedToDiscountableDecimal: "0",
  carryInAppliedDecimal: "0",
  remainingDiscountableAfterCarryInDecimal: "0",
  discountAppliedDecimal: "0",
  netCapitalGainEstimateDecimal: "0",
  carryOutLossDecimal: "1250.00",
  ownPartialCoverage: false,
  carriedFiguresPartial: false,
};

const fy2026Partial: Fy = {
  ...fyBase,
  endingYear: 2026,
  label: "FY26",
  window: { startDate: "2025-07-01", endDate: "2026-06-30" },
  rows: [wesGain, nabUnknown],
  disposalCount: 2,
  excludedIncompleteCount: 1,
  excludedIncompleteSecurityNames: ["National Australia Bank Limited"],
  partialCoverage: true,
  totalDiscountableGainsGrossDecimal: "5120.50",
  totalNonDiscountableGainsGrossDecimal: "0",
  totalLossesDecimal: "0",
  lossAppliedToNonDiscountableDecimal: "0",
  lossAppliedToDiscountableDecimal: "0",
  remainingNonDiscountableAfterLossDecimal: "0",
  remainingDiscountableAfterLossDecimal: "5120.50",
  discountAppliedDecimal: "2560.25",
  netCapitalGainEstimateDecimal: "2560.25",
  unabsorbedLossDecimal: "0",
};

const carried2026Partial: Carried = {
  endingYear: 2026,
  carryInLossDecimal: "0",
  carryInAppliedToNonDiscountableDecimal: "0",
  carryInAppliedToDiscountableDecimal: "0",
  carryInAppliedDecimal: "0",
  remainingDiscountableAfterCarryInDecimal: "5120.50",
  discountAppliedDecimal: "2560.25",
  netCapitalGainEstimateDecimal: "2560.25",
  carryOutLossDecimal: "0",
  ownPartialCoverage: true,
  carriedFiguresPartial: true,
};

/** Opens the native dialog non-modally so it renders inline in the preview card. */
function OpenDialog(props: Omit<Props, "dialogRef" | "onClose">) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.show();
  }, []);
  return <FyDetailDialog {...props} dialogRef={dialogRef} onClose={() => {}} />;
}

/** FY25: two VAS lots, prior-year loss brought forward and applied; standalone and carried breakdowns. */
export function CarriedWithPriorLoss() {
  return <OpenDialog fy={fy2025} currencyCode="AUD" carried={carried2025} />;
}

/** The same FY rendered from a bare fixture with no carried totals supplied. */
export function StandaloneOnly() {
  return <OpenDialog fy={fy2025} currencyCode="AUD" />;
}

/** FY24: a single CBA loss with nothing to offset -- unabsorbed and carried out. */
export function UnabsorbedLoss() {
  return <OpenDialog fy={fy2024} currencyCode="AUD" carried={carried2024} />;
}

/** FY26: an incomplete-basis NAB lot excluded, so coverage is partial and carried figures are flagged. */
export function PartialCoverage() {
  return (
    <OpenDialog
      fy={fy2026Partial}
      currencyCode="AUD"
      carried={carried2026Partial}
    />
  );
}
