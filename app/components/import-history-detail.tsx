import type { ImportHistoryDetail } from "../import-history-service.ts";
import type { ImportReversalActionResult } from "../import-reversal-service.ts";
import { useState } from "react";
import type { FormEvent } from "react";
import { summarizeRow } from "../../domain/imports/row-summary.ts";

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Recorded value";
  }
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

// IMP-008 review finding B1/B2: mirrors the server's own exclusion-
// mutability check (`app/import-row-exclusion-service.ts`, `setRowExclusion`
// in `db/repositories/import-staging.ts`: exclusion stays mutable right up
// to the moment commit actually starts, INCLUDING at `ready`, but never once
// `committing` has begun or the batch has reached a terminal status). This
// is the ONE definition (exported here, imported by `import-review.tsx`
// rather than re-declared there -- no circular dependency: this file already
// has no import from `import-review.tsx`, and `import-review.tsx` already
// imports `ImportHistoryDetailPanel` from this file, so adding this import
// is the same direction).
//
// UI-013 review round B3c: this is now DISTINCT from "this batch's review is
// safe to REACH" (`isResumableReviewStatus` below) -- exclusion mutations
// stay gated on exactly this function, unchanged.
export function isMutableExclusionStatus(status: string): boolean {
  return (
    status === "parsed" ||
    status === "needs_mapping" ||
    status === "invalid" ||
    status === "ready"
  );
}

// UI-013 review round B3c (BLOCKING correction): a `committing` sharesight
// batch that exhausted `acceptImportWithContext`'s own bounded server-side
// commit loop (`app/import-accept-service.ts`) used to be a dead end --
// `isMutableExclusionStatus` excludes `committing`, so "Open review" never
// offered a way back in, leaving only ~100 manual "Commit" clicks as
// (formerly) the sole recovery path. A `committing` batch's live-server
// preview is exactly as reachable via `GET /api/import/preview/:batchId` as
// any other status (`loadImportPreviewAction` never gates on batch status),
// and reopening it lets Accept Import double as the resume affordance (see
// `isSharesightSyncBatch`'s comment in `import-review.tsx`: its own
// client-side accept loop resumes an already-`committing` batch exactly
// like a fresh one). Deliberately NOT folded into
// `isMutableExclusionStatus` itself -- exclusion mutations (skip/un-skip a
// row/candidate) must stay blocked once commit has actually started; only
// the ability to REACH the review widens.
export function isResumableReviewStatus(status: string): boolean {
  return isMutableExclusionStatus(status) || status === "committing";
}

export function ImportHistoryDetailPanel({
  detail,
  pending,
  onLoadMore,
  onResume,
  onResumeReview,
  reversal,
  reversalPending,
  reversalRetryAvailable,
  successorPending,
  onReverse,
  onOpenSuccessor,
  onStageSuccessor,
}: {
  detail: ImportHistoryDetail;
  pending: boolean;
  onLoadMore: () => void;
  onResume: () => void;
  onResumeReview: (batchId: string) => void;
  reversal: ImportReversalActionResult | null;
  reversalPending: boolean;
  reversalRetryAvailable: boolean;
  successorPending: boolean;
  onReverse: (expectedVersion: number) => void;
  onOpenSuccessor: (batchId: string) => void;
  onStageSuccessor: (file: File) => void;
}) {
  const [confirmation, setConfirmation] = useState(false);
  const resumable =
    detail.batch.status === "committing" &&
    detail.progress.idempotencyKey !== null;
  const resumableReview = isResumableReviewStatus(detail.batch.status);
  return (
    <section
      className="import-history-detail"
      aria-labelledby="history-detail-title"
    >
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Batch detail</p>
          <h3 id="history-detail-title">{detail.batch.filename}</h3>
        </div>
        <span className="history-status">
          {statusLabel(detail.batch.status)}
        </span>
      </div>
      {resumableReview ? (
        <p className="import-history-resume-review">
          <button
            type="button"
            onClick={() => onResumeReview(detail.batch.id)}
            disabled={pending}
          >
            Open review
          </button>
          <span>
            {" "}
            Restore the resolution cards and commit flow for this staged batch.
          </span>
        </p>
      ) : null}
      <p>
        {detail.batch.transactionRows} transaction rows · showing{" "}
        {detail.rows.length} source rows and {detail.issues.length} issues in
        this bounded page · {detail.excludedRowCount} rows excluded by owner
      </p>

      {detail.batch.status === "committed" ||
      detail.batch.status === "reversing" ||
      detail.batch.status === "reversed" ||
      reversal ? (
        <section
          className="import-reversal-panel"
          aria-labelledby="import-reversal-title"
        >
          <h4 id="import-reversal-title">Import correction and reversal</h4>
          {detail.batch.status === "reversed" ? (
            <>
              <p className="import-reversal-status" role="status">
                This committed import is reversed. Its source rows and
                normalized facts remain visible below as immutable evidence.
              </p>
              {reversalRetryAvailable ? (
                <button
                  className="import-reversal-button"
                  type="button"
                  onClick={() => onReverse(detail.batch.version)}
                  disabled={reversalPending}
                  aria-busy={reversalPending || undefined}
                >
                  {reversalPending
                    ? "Checking reversal…"
                    : "Retry reversal request"}
                </button>
              ) : null}
              {!detail.successorBatchId && detail.batch.targetPortfolioId ? (
                <form
                  className="import-successor-form"
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    const file = new FormData(event.currentTarget).get(
                      "correctedFile",
                    );
                    if (file instanceof File && file.size > 0) {
                      onStageSuccessor(file);
                    }
                  }}
                >
                  <label>
                    Corrected CSV file
                    <input
                      name="correctedFile"
                      type="file"
                      accept=".csv,text/csv"
                      required
                    />
                  </label>
                  <button type="submit" disabled={successorPending}>
                    {successorPending
                      ? "Preparing corrected preview…"
                      : "Stage corrected successor"}
                  </button>
                </form>
              ) : !detail.successorBatchId ? (
                <p className="import-reversal-error" role="alert">
                  This batch has no single target portfolio, so a corrected
                  successor cannot be staged from this view.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p>
                Reversal creates compensating ledger facts; it does not delete
                this import or its source evidence. Later dependent facts can
                block the operation.
              </p>
              <label className="import-confirmation">
                <input
                  type="checkbox"
                  checked={confirmation}
                  onChange={(event) => setConfirmation(event.target.checked)}
                />
                <span>
                  I confirm this exact batch reversal and understand that it
                  creates compensating facts while retaining source history.
                </span>
              </label>
              {/* UI-013: `disabled` mixes a validation reason (confirmation
                  unchecked) with a genuine in-flight reason (`reversalPending`)
                  -- `aria-busy` isolates the latter so `.import-reversal-button`
                  can show `cursor: wait` only while a request is actually in
                  flight, not-allowed otherwise (see globals.css). */}
              <button
                className="import-reversal-button"
                type="button"
                onClick={() => onReverse(detail.batch.version)}
                disabled={!confirmation || reversalPending}
                aria-busy={reversalPending || undefined}
              >
                {reversalPending
                  ? "Reversing…"
                  : detail.batch.status === "reversing"
                    ? "Resume reversal"
                    : "Reverse this committed import"}
              </button>
            </>
          )}
          {reversal?.ok ? (
            <p className="import-reversal-status" role="status">
              {reversal.reversal.status === "reversed"
                ? `Reversal complete. ${reversal.reversal.reversedTransactions} ledger facts were compensated.`
                : `Reversal is in progress. ${reversal.reversal.remainingTransactions} ledger facts remain.`}
              {reversal.reversal.idempotent
                ? " The repeated request returned the existing result."
                : ""}
            </p>
          ) : reversal &&
            !reversal.ok &&
            reversal.impacts &&
            reversal.impacts.length > 0 ? (
            <div className="import-reversal-blocked" role="alert">
              <strong>Reversal blocked by dependent facts</strong>
              <p>Resolve these later facts before reversing the import.</p>
              <ul>
                {reversal.impacts.map((impact) => (
                  <li
                    key={`${impact.sourceTransactionId}-${impact.dependentTransactionId}`}
                  >
                    <span>
                      Dependent transaction · business date{" "}
                      {impact.dependentTradeAt.slice(0, 10)} · quantity{" "}
                      {impact.dependentQuantityDecimal ?? "unavailable"}
                    </span>
                    <details>
                      <summary>Show exact impact evidence</summary>
                      <p>
                        Source transaction: {impact.sourceTransactionId}. Exact
                        dependent trade time: {impact.dependentTradeAt}.
                        Dependent transaction: {impact.dependentTransactionId}.
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ) : reversal && !reversal.ok ? (
            <p className="import-reversal-error" role="alert">
              {reversal.message}
            </p>
          ) : null}
          {detail.successorBatchId ? (
            <p className="import-successor-link">
              <button
                type="button"
                onClick={() => onOpenSuccessor(detail.successorBatchId!)}
              >
                Open corrected successor batch
              </button>
            </p>
          ) : null}
        </section>
      ) : null}

      {detail.batch.status === "committing" ? (
        <section
          className="history-commit-progress"
          aria-labelledby="history-progress-title"
        >
          <h4 id="history-progress-title">Commit progress</h4>
          <p className="import-commit-status resumable" role="status">
            Commit is resumable after physical row{" "}
            {detail.progress.highWaterRow}. {detail.progress.committedRows} row
            effects are committed, {detail.progress.skippedRows} are skipped,
            and {detail.progress.remainingRows} remain. It is not complete.
          </p>
          {resumable ? (
            <button type="button" onClick={onResume} disabled={pending}>
              {pending ? "Resuming commit…" : "Resume this commit"}
            </button>
          ) : (
            <p role="alert">
              Resume evidence is unavailable. Reload this batch before taking
              further action.
            </p>
          )}
        </section>
      ) : null}

      <details>
        <summary>Batch timestamps and durable evidence</summary>
        <dl className="import-evidence-list">
          <div>
            <dt>Created</dt>
            <dd>{detail.batch.createdAt}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{detail.batch.updatedAt}</dd>
          </div>
          <div>
            <dt>Parsed</dt>
            <dd>{detail.batch.parsedAt ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Committed</dt>
            <dd>{detail.batch.committedAt ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Reversed</dt>
            <dd>{detail.batch.reversedAt ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Predecessor</dt>
            <dd>{detail.batch.supersedesBatchId ?? "None"}</dd>
          </div>
        </dl>
      </details>

      <section aria-labelledby="history-rows-title">
        <h4 id="history-rows-title">Original rows</h4>
        <div className="import-history-table-wrap">
          <table className="import-history-table">
            <caption>Immutable source rows and their durable outcome</caption>
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Class</th>
                <th scope="col">Validation</th>
                <th scope="col">Commit</th>
                <th scope="col">Excluded by owner</th>
                <th scope="col">Transaction</th>
                <th scope="col">Symbol</th>
                <th scope="col">Type</th>
                <th scope="col">Date</th>
                <th scope="col">Quantity</th>
                <th scope="col">Price/Amount</th>
                <th scope="col">Currency</th>
                <th scope="col">Original fields</th>
                <th scope="col">Normalized facts</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((row) => {
                const summary = summarizeRow(row.normalizedFields);
                return (
                  <tr key={row.id}>
                    <td>{row.physicalRowNumber}</td>
                    <td>{row.rowClass}</td>
                    <td>{row.validationStatus}</td>
                    <td>{row.commitStatus}</td>
                    <td>{row.excludedByOwnerAt ?? "No"}</td>
                    <td>{row.commitTransactionId ?? "None"}</td>
                    <td>{summary.symbol}</td>
                    <td>{summary.type}</td>
                    <td>{summary.date}</td>
                    <td>{summary.quantity}</td>
                    <td>{summary.amount}</td>
                    <td>{summary.currency}</td>
                    <td>
                      <details>
                        <summary>View</summary>
                        <code>{displayValue(row.originalFields)}</code>
                      </details>
                    </td>
                    <td>
                      <details>
                        <summary>View</summary>
                        <code>{displayValue(row.normalizedFields)}</code>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="history-mappings-title">
        <h4 id="history-mappings-title">Mapping decisions</h4>
        {detail.mappings.length === 0 ? (
          <p>No mapping decisions are recorded in this page.</p>
        ) : (
          <ul className="import-history-facts">
            {detail.mappings.map((mapping) => (
              <li key={mapping.id}>
                <strong>{mapping.kind}</strong>
                <span>
                  {mapping.sourceKey} →{" "}
                  {mapping.targetId ?? mapping.targetValue ?? "Unresolved"} (
                  {mapping.scope})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-audit-title">
        <h4 id="history-audit-title">Audit evidence</h4>
        {detail.audit.length === 0 ? (
          <p>No batch audit events are recorded in this page.</p>
        ) : (
          <ul className="import-history-facts">
            {detail.audit.map((event) => (
              <li key={event.id}>
                <strong>{event.action}</strong>
                <span>
                  {event.result} · {event.occurredAt} · request{" "}
                  {event.requestId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.pagination.hasMore && detail.pagination.nextOffset !== null ? (
        <button
          className="history-load-more"
          type="button"
          onClick={onLoadMore}
          disabled={pending}
        >
          {pending ? "Loading evidence…" : "Load more evidence"}
        </button>
      ) : (
        <p className="history-page-complete">All bounded evidence is shown.</p>
      )}
    </section>
  );
}
