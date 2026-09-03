import { PriceUploadList } from "yieldtome-ui";

type Batch = Parameters<typeof PriceUploadList>[0]["batches"][number];

const batches: Batch[] = [
  {
    id: "batch-01",
    sourceLabel: "Intelligent Investor",
    format: "single",
    filename: "intelligent-investor-VAS.csv",
    rowCount: 1264,
    insertedRowCount: 1264,
    malformedRowCount: 0,
    createdAt: "2026-09-03",
  },
  {
    id: "batch-02",
    sourceLabel: "Intelligent Investor",
    format: "single",
    filename: "intelligent-investor-CBA.csv",
    rowCount: 1251,
    insertedRowCount: 1251,
    malformedRowCount: 3,
    createdAt: "2026-09-03",
  },
  {
    id: "batch-03",
    sourceLabel: "Intelligent Investor",
    format: "single",
    filename: "intelligent-investor-WES.csv",
    rowCount: 812,
    insertedRowCount: 812,
    malformedRowCount: 0,
    createdAt: "2026-08-21",
  },
  {
    id: "batch-04",
    sourceLabel: "YieldToMe backup",
    format: "backup",
    filename: "yieldtome-price-backup-2026-06-30.csv",
    rowCount: 9420,
    insertedRowCount: 9420,
    malformedRowCount: 0,
    createdAt: "2026-07-02",
  },
];

const noop = () => {};

/** Four past uploads -- three single-ticker files and one backup restore. */
export function Populated() {
  return (
    <PriceUploadList
      batches={batches}
      batchesError=""
      deletePending=""
      onDeleteClick={noop}
    />
  );
}

/** A re-upload that overlaid rows another upload had already created; the VGS row's delete is in flight. */
export function OverlaidRowsDeleting() {
  return (
    <PriceUploadList
      batches={[
        {
          id: "batch-05",
          sourceLabel: "Intelligent Investor",
          format: "single",
          filename: "intelligent-investor-VGS.csv",
          rowCount: 250,
          insertedRowCount: 6,
          malformedRowCount: 0,
          createdAt: "2026-09-04",
        },
        ...batches.slice(0, 2),
      ]}
      batchesError=""
      deletePending="batch-05"
      onDeleteClick={noop}
    />
  );
}

/** No uploads recorded for this portfolio yet. */
export function Empty() {
  return (
    <PriceUploadList
      batches={[]}
      batchesError=""
      deletePending=""
      onDeleteClick={noop}
    />
  );
}

/** Initial load: the list has not arrived yet (the component accepts `null` for this state). */
export function Loading() {
  return (
    <PriceUploadList
      batches={null as never}
      batchesError=""
      deletePending=""
      onDeleteClick={noop}
    />
  );
}

/** The list failed to load; the error is announced above the (stale) rows. */
export function LoadError() {
  return (
    <PriceUploadList
      batches={batches.slice(0, 2)}
      batchesError="Could not load past uploads — the request timed out after 20 seconds."
      deletePending=""
      onDeleteClick={noop}
    />
  );
}
