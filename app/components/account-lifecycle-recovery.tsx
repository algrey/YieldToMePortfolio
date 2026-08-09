"use client";

import { useEffect, useState } from "react";

type LifecycleType = "disable" | "deletion" | "export";

export function AccountLifecycleRecovery({
  lifecycle,
}: {
  lifecycle: "disabled" | "deletion_pending";
}) {
  const [status, setStatus] = useState<{
    requestType: LifecycleType;
    lifecycle: string | null;
    exportJobId: string | null;
    jobStatus: string | null;
    idempotencyKey: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [nextDownloadPart, setNextDownloadPart] = useState<number | null>(1);
  const [downloading, setDownloading] = useState(false);
  async function processRecovered(
    exportJobId: string,
    requestType: LifecycleType,
    idempotencyKey: string,
  ) {
    setPending(true);
    try {
      let jobStatus: string | null = "running";
      const query = `requestType=${requestType}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`;
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        const response = await fetch(
          `/api/account/export/${encodeURIComponent(exportJobId)}/process?${query}`,
          { method: "POST", headers: { "content-type": "application/json" } },
        );
        const result = (await response.json()) as {
          job?: { status?: string };
        };
        jobStatus = result.job?.status ?? "unavailable";
        setStatus((current) => (current ? { ...current, jobStatus } : current));
        if (
          ["completed", "failed", "expired", "unavailable"].includes(jobStatus)
        )
          break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    async function discover() {
      for (const type of ["deletion", "export", "disable"] as const) {
        let key: string | null = null;
        try {
          key = window.sessionStorage.getItem(`yieldtome.lifecycle.${type}`);
        } catch {
          continue;
        }
        if (!key) continue;
        const response = await fetch(
          `/api/account/lifecycle/status?type=${type}&idempotencyKey=${encodeURIComponent(key)}`,
          { cache: "no-store" },
        );
        if (!response.ok) continue;
        const result = (await response.json()) as {
          request?: {
            requestType?: LifecycleType;
            lifecycle?: string | null;
            exportJobId?: string | null;
          };
          job?: { status?: string } | null;
        };
        if (!cancelled && result.request)
          setStatus({
            requestType: result.request.requestType ?? type,
            lifecycle: result.request.lifecycle ?? lifecycle,
            exportJobId: result.request.exportJobId ?? null,
            jobStatus: result.job?.status ?? null,
            idempotencyKey: key,
          });
        if (
          !cancelled &&
          result.request?.exportJobId &&
          !["completed", "failed", "expired"].includes(
            result.job?.status ?? "running",
          )
        )
          void processRecovered(
            result.request.exportJobId,
            result.request.requestType ?? type,
            key,
          );
        return;
      }
    }
    void discover();
    return () => {
      cancelled = true;
    };
  }, [lifecycle]);
  async function continueProcessing() {
    if (!status?.exportJobId) return;
    await processRecovered(
      status.exportJobId,
      status.requestType,
      status.idempotencyKey,
    );
  }
  async function downloadNextPart() {
    if (!status?.exportJobId || nextDownloadPart === null || downloading)
      return;
    setDownloading(true);
    try {
      const part = nextDownloadPart;
      const query = `part=${part}&requestType=${status.requestType}&idempotencyKey=${encodeURIComponent(status.idempotencyKey)}`;
      const response = await fetch(
        `/api/account/export/${encodeURIComponent(status.exportJobId)}?${query}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const result = (await response.json()) as { nextPart?: number | null };
      const blob = new Blob([JSON.stringify(result)], {
        type: "application/json",
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `yieldtome-export-${status.exportJobId}-part-${part}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      setNextDownloadPart(result.nextPart ?? null);
    } finally {
      setDownloading(false);
    }
  }
  return (
    <section className="empty-state" aria-labelledby="lifecycle-recovery-title">
      <p className="eyebrow">Account lifecycle</p>
      <h2 id="lifecycle-recovery-title">
        {lifecycle === "deletion_pending"
          ? "Deletion pending"
          : "Account access disabled"}
      </h2>
      <p>
        Portfolio details are unavailable. Existing lifecycle requests can be
        resumed through the private support path.
      </p>
      {status?.exportJobId &&
      status.jobStatus !== "completed" &&
      status.jobStatus !== "failed" &&
      status.jobStatus !== "expired" ? (
        <button
          type="button"
          onClick={() => void continueProcessing()}
          disabled={pending}
        >
          {pending ? "Continuing export…" : "Continue export processing"}
        </button>
      ) : null}
      {status?.exportJobId && status.jobStatus === "completed" ? (
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
        </div>
      ) : (
        <p role="status">
          {status?.exportJobId
            ? "Export is not ready yet. Continue processing to resume it."
            : "No saved export request was found on this device."}
        </p>
      )}
    </section>
  );
}
