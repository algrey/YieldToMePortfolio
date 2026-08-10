"use client";

import { useEffect, useRef, useState } from "react";

type ExportJobView = {
  id?: string;
  status?: string;
  phase?: string;
  rowCount?: number;
  manifestDigest?: string | null;
};
type ExportAccess = {
  requestType: "deletion" | "export";
  idempotencyKey: string;
};

function accessQuery(access: ExportAccess): string {
  return `requestType=${access.requestType}&idempotencyKey=${encodeURIComponent(access.idempotencyKey)}`;
}

export function AccountLifecycleControls() {
  const [message, setMessage] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [exportAccess, setExportAccess] = useState<ExportAccess | null>(null);
  const [nextDownloadPart, setNextDownloadPart] = useState<number | null>(1);
  const [downloading, setDownloading] = useState(false);
  const keys = useRef<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    let key: string | null = null;
    try {
      key = window.sessionStorage.getItem("yieldtome.lifecycle.export");
    } catch {
      key = null;
    }
    if (!key) return () => undefined;
    void fetch(
      `/api/account/lifecycle/status?type=export&idempotencyKey=${encodeURIComponent(key)}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as {
          job?: (ExportJobView & { id?: string }) | null;
        };
      })
      .then((result) => {
        if (cancelled || !result?.job?.id) return;
        setExportAccess({ requestType: "export", idempotencyKey: key });
        setJobId(result.job.id);
        setJobStatus(result.job.status ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  async function processBounded(
    exportJobId: string,
    access: ExportAccess | null = exportAccess,
  ) {
    setPending(true);
    try {
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        const response = await fetch(
          `/api/account/export/${encodeURIComponent(exportJobId)}/process${access ? `?${accessQuery(access)}` : ""}`,
          { method: "POST", headers: { "content-type": "application/json" } },
        );
        const processed = (await response.json()) as { job?: ExportJobView };
        const status = processed.job?.status ?? "unavailable";
        setJobStatus(status);
        setMessage(
          status === "running"
            ? `Export is progressing (${processed.job?.phase ?? "capture"}; ${processed.job?.rowCount ?? 0} rows captured).`
            : `Export status: ${status}.`,
        );
        if (
          status === "completed" ||
          status === "failed" ||
          status === "expired" ||
          status === "unavailable"
        )
          return status;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      return "running";
    } finally {
      setPending(false);
    }
  }
  async function request(type: "disable" | "deletion" | "export") {
    if (
      type === "deletion" &&
      !window.confirm(
        "Request deletion and an owner-scoped export? Access is revoked immediately. After a 24-hour cooling-off period, a separate final confirmation can permanently purge the account.",
      )
    )
      return;
    let savedKey: string | null = null;
    try {
      savedKey = window.sessionStorage.getItem(`yieldtome.lifecycle.${type}`);
    } catch {
      savedKey = null;
    }
    const idempotencyKey =
      keys.current[type] ??
      savedKey ??
      (keys.current[type] = `account-${type}-${window.crypto.randomUUID()}`);
    keys.current[type] = idempotencyKey;
    const access =
      type === "deletion" || type === "export"
        ? { requestType: type, idempotencyKey }
        : null;
    setExportAccess(access);
    try {
      window.sessionStorage.setItem(
        `yieldtome.lifecycle.${type}`,
        idempotencyKey,
      );
    } catch {
      // The request remains safe because the key is retained in component state.
    }
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          includeExport: type === "deletion" || type === "export",
          idempotencyKey,
        }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        message?: string;
        request?: { exportJobId?: string | null };
      };
      setMessage(
        result.ok
          ? result.request?.exportJobId
            ? `Request accepted. Export job ${result.request.exportJobId} is being prepared.`
            : "Request accepted. Access is now revoked."
          : (result.message ?? "Request unavailable."),
      );
      const returnedJobId = result.request?.exportJobId ?? null;
      setJobId(returnedJobId);
      if (result.ok && returnedJobId) {
        const status = await processBounded(returnedJobId, access);
        if (status === "completed")
          setMessage(
            "Export is ready. Download the bounded export pages below.",
          );
        else if (status === "failed")
          setMessage("Export could not be reconciled safely. Contact support.");
        else
          setMessage("Export is being prepared. Refresh status to continue.");
      }
    } catch {
      setMessage("Request unavailable. No portfolio data was changed.");
    } finally {
      setPending(false);
    }
  }
  async function downloadNextPart() {
    if (!jobId || !exportAccess || nextDownloadPart === null || downloading)
      return;
    setDownloading(true);
    try {
      const part = nextDownloadPart;
      const response = await fetch(
        `/api/account/export/${encodeURIComponent(jobId)}?part=${part}&${accessQuery(exportAccess)}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        setMessage("Export part is unavailable.");
        return;
      }
      const result = (await response.json()) as {
        nextPart?: number | null;
      };
      const blob = new Blob([JSON.stringify(result)], {
        type: "application/json",
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `yieldtome-export-${jobId}-part-${part}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      const next = result.nextPart ?? null;
      setNextDownloadPart(next);
      setMessage(
        next === null
          ? "All export parts have been downloaded."
          : `Export part ${part} downloaded. Part ${next} is ready.`,
      );
    } finally {
      setDownloading(false);
    }
  }
  return (
    <section
      className="inspection-panel"
      aria-labelledby="account-lifecycle-title"
    >
      <p className="eyebrow">Account controls</p>
      <h2 id="account-lifecycle-title">Access and data export</h2>
      <p>
        Disable access immediately, or request deletion with an owner-scoped
        export. The deletion request does not itself purge financial rows.
      </p>
      <div className="inspection-actions">
        <button
          type="button"
          onClick={() => void request("disable")}
          disabled={pending}
        >
          Disable access
        </button>
        <button
          type="button"
          onClick={() => void request("export")}
          disabled={pending}
        >
          Request export
        </button>
        <button
          type="button"
          onClick={() => void request("deletion")}
          disabled={pending}
        >
          Request deletion and export
        </button>
        {jobId &&
        jobStatus !== "completed" &&
        jobStatus !== "failed" &&
        jobStatus !== "expired" ? (
          <button
            type="button"
            onClick={() => void processBounded(jobId)}
            disabled={pending}
          >
            Continue export processing
          </button>
        ) : null}
      </div>
      {jobId && jobStatus === "completed" ? (
        <div>
          <button
            type="button"
            onClick={() => void downloadNextPart()}
            disabled={downloading || nextDownloadPart === null}
          >
            {downloading
              ? "Downloading export part…"
              : nextDownloadPart === null
                ? "All export parts downloaded"
                : `Download export part ${nextDownloadPart}`}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!window.confirm("Start a new export with a new request key?"))
                return;
              delete keys.current.export;
              try {
                window.sessionStorage.removeItem("yieldtome.lifecycle.export");
              } catch {
                // The in-memory key is still cleared for this explicit action.
              }
              setJobId(null);
              setJobStatus(null);
              setExportAccess(null);
              setNextDownloadPart(1);
              setMessage("Choose Request export to start a new export.");
            }}
          >
            Start a new export
          </button>
        </div>
      ) : null}
      <p role="status">{message}</p>
    </section>
  );
}
