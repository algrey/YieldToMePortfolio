import type { ImportHistoryDetail } from "../import-history-service.ts";
import type { ImportReversalActionResult } from "../import-reversal-service.ts";
import { useState } from "react";
import type { FormEvent } from "react";

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

export function ImportHistoryDetailPanel({
  detail,
  pending,
  onLoadMore,
  onResume,
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
              <button
                className="import-reversal-button"
                type="button"
                onClick={() => onReverse(detail.batch.version)}
                disabled={!confirmation || reversalPending}
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
                <th scope="col">Original fields</th>
                <th scope="col">Normalized facts</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.physicalRowNumber}</td>
                  <td>{row.rowClass}</td>
                  <td>{row.validationStatus}</td>
                  <td>{row.commitStatus}</td>
                  <td>{row.excludedByOwnerAt ?? "No"}</td>
                  <td>{row.commitTransactionId ?? "None"}</td>
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
              ))}
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
