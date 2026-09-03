import { MultiFileRunStatus } from "yieldtome-ui";

type Props = Parameters<typeof MultiFileRunStatus>[0];
type Preview = Props["currentPreview"];
type StepResult = Props["results"][number];

const cbaPreview: Preview = {
  ticker: "CBA",
  exchangeAlias: "ASX",
  currencyCode: "AUD",
  matchedSecurityId: "sec-cba",
  matchedName: "Commonwealth Bank of Australia",
  rowCount: 1251,
  malformedCount: 3,
  dateFrom: "2021-07-01",
  dateTo: "2026-09-03",
  sampleFirst: { marketDate: "2021-07-01", priceDecimal: "99.87" },
  sampleLast: { marketDate: "2026-09-03", priceDecimal: "168.42" },
  existingObservations: [],
  identicalCount: 0,
  rowsToWriteCount: 1251,
  noDataOmittedCount: 10,
  downsampleApplied: false,
  downsampleBoundaryYear: 2024,
  preDownsampleRowCount: 1251,
};

const doneVas: StepResult = {
  filename: "intelligent-investor-VAS.csv",
  status: "committed",
  message: "Imported 1264 row(s) for Vanguard Australian Shares Index ETF.",
};
const doneCba: StepResult = {
  filename: "intelligent-investor-CBA.csv",
  status: "committed",
  message: "Imported 1251 row(s) for Commonwealth Bank of Australia.",
};
const skippedWes: StepResult = {
  filename: "intelligent-investor-WES.csv",
  status: "skipped",
  message: "Skipped by you.",
};
const errorXyz: StepResult = {
  filename: "intelligent-investor-XYZ.csv",
  status: "error",
  message: "No security in this portfolio matches ticker XYZ on ASX.",
};

const handlers = { onConfirm: () => {}, onSkip: () => {}, onCancel: () => {} };

/** Second of four files is parsed and awaiting the owner's confirm/skip/cancel decision. */
export function Reviewing() {
  return (
    <MultiFileRunStatus
      running
      phase="reviewing"
      total={4}
      index={2}
      currentFilename="intelligent-investor-CBA.csv"
      currentPreview={cbaPreview}
      pending={false}
      results={[doneVas]}
      cancelled={false}
      {...handlers}
    />
  );
}

/** The confirmed file is being written; the action buttons are busy/disabled. */
export function Importing() {
  return (
    <MultiFileRunStatus
      running
      phase="importing"
      total={4}
      index={2}
      currentFilename="intelligent-investor-CBA.csv"
      currentPreview={cbaPreview}
      pending
      results={[doneVas]}
      cancelled={false}
      {...handlers}
    />
  );
}

/** Third file is still being parsed in the browser -- no preview yet, two results so far. */
export function Checking() {
  return (
    <MultiFileRunStatus
      running
      phase="checking"
      total={4}
      index={3}
      currentFilename="intelligent-investor-WES.csv"
      currentPreview={null as never}
      pending={false}
      results={[doneVas, doneCba]}
      cancelled={false}
      {...handlers}
    />
  );
}

/** Run complete: two imported, one skipped, one unmatched ticker. */
export function Finished() {
  return (
    <MultiFileRunStatus
      running={false}
      phase={null as never}
      total={4}
      index={4}
      currentFilename={null as never}
      currentPreview={null as never}
      pending={false}
      results={[doneVas, doneCba, skippedWes, errorXyz]}
      cancelled={false}
      {...handlers}
    />
  );
}

/** Owner cancelled the remaining files after the first import. */
export function Cancelled() {
  return (
    <MultiFileRunStatus
      running={false}
      phase={null as never}
      total={4}
      index={1}
      currentFilename={null as never}
      currentPreview={null as never}
      pending={false}
      results={[doneVas]}
      cancelled
      {...handlers}
    />
  );
}
