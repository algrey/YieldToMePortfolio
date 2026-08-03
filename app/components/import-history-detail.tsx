import type { ImportHistoryDetail } from "../import-history-service.ts";

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
}: {
  detail: ImportHistoryDetail;
  pending: boolean;
  onLoadMore: () => void;
  onResume: () => void;
}) {
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
        this bounded page
      </p>

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
