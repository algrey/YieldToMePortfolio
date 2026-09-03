import { SinglePreviewSummary } from "yieldtome-ui";

type Preview = Parameters<typeof SinglePreviewSummary>[0]["preview"];

const vas: Preview = {
  ticker: "VAS",
  exchangeAlias: "ASX",
  currencyCode: "AUD",
  matchedSecurityId: "sec-vas",
  matchedName: "Vanguard Australian Shares Index ETF",
  rowCount: 1264,
  malformedCount: 0,
  dateFrom: "2021-07-01",
  dateTo: "2026-09-03",
  sampleFirst: { marketDate: "2021-07-01", priceDecimal: "93.41" },
  sampleLast: { marketDate: "2026-09-03", priceDecimal: "104.87" },
  existingObservations: [],
  identicalCount: 0,
  rowsToWriteCount: 1264,
  noDataOmittedCount: 0,
  downsampleApplied: false,
  downsampleBoundaryYear: 2024,
  preDownsampleRowCount: 1264,
};

/** A clean five-year VAS export: every row valid, nothing already present. */
export function CleanFile() {
  return <SinglePreviewSummary preview={vas} />;
}

/** CBA export with malformed lines and blank-price holiday rows disclosed separately. */
export function MalformedAndNoDataRows() {
  return (
    <SinglePreviewSummary
      preview={{
        ...vas,
        ticker: "CBA",
        matchedSecurityId: "sec-cba",
        matchedName: "Commonwealth Bank of Australia",
        rowCount: 1251,
        malformedCount: 3,
        dateFrom: "2021-07-01",
        dateTo: "2026-09-03",
        sampleFirst: { marketDate: "2021-07-01", priceDecimal: "99.87" },
        sampleLast: { marketDate: "2026-09-03", priceDecimal: "168.42" },
        rowsToWriteCount: 1251,
        noDataOmittedCount: 10,
      }}
    />
  );
}

/** Long WES history downsampled to monthly before 2024 -- states the row saving before confirm. */
export function Downsampled() {
  return (
    <SinglePreviewSummary
      preview={{
        ...vas,
        ticker: "WES",
        matchedSecurityId: "sec-wes",
        matchedName: "Wesfarmers Limited",
        rowCount: 812,
        dateFrom: "2010-01-04",
        dateTo: "2026-09-03",
        sampleFirst: { marketDate: "2010-01-29", priceDecimal: "30.86" },
        sampleLast: { marketDate: "2026-09-03", priceDecimal: "78.15" },
        rowsToWriteCount: 812,
        downsampleApplied: true,
        downsampleBoundaryYear: 2024,
        preDownsampleRowCount: 4216,
      }}
    />
  );
}

/** Re-uploading an overlapping VGS file: most rows are exact duplicates and are skipped. */
export function MostlyIdentical() {
  return (
    <SinglePreviewSummary
      preview={{
        ...vas,
        ticker: "VGS",
        matchedSecurityId: "sec-vgs",
        matchedName: "Vanguard MSCI Index International Shares ETF",
        rowCount: 250,
        dateFrom: "2025-09-01",
        dateTo: "2026-09-03",
        sampleFirst: { marketDate: "2025-09-01", priceDecimal: "138.02" },
        sampleLast: { marketDate: "2026-09-03", priceDecimal: "151.66" },
        existingObservations: [
          { marketDate: "2025-09-01", closeDecimal: "138.02" },
          { marketDate: "2025-09-02", closeDecimal: "137.55" },
        ],
        identicalCount: 244,
        rowsToWriteCount: 6,
      }}
    />
  );
}

/** A file that matched a security but contained no usable price rows at all. */
export function NothingToWrite() {
  return (
    <SinglePreviewSummary
      preview={{
        ...vas,
        ticker: "BHP",
        matchedSecurityId: "sec-bhp",
        matchedName: "BHP Group Limited",
        rowCount: 0,
        malformedCount: 12,
        dateFrom: null,
        dateTo: null,
        sampleFirst: null,
        sampleLast: null,
        rowsToWriteCount: 0,
        preDownsampleRowCount: 0,
      }}
    />
  );
}
