"use client";

import { useEffect, useState } from "react";

export function ServiceWorkerRegistration() {
  const [online, setOnline] = useState(true);
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const updateConnectivity = () => setOnline(navigator.onLine);
    updateConnectivity();
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);

    if (
      process.env.NODE_ENV !== "production" ||
      !("serviceWorker" in navigator)
    ) {
      return () => {
        window.removeEventListener("online", updateConnectivity);
        window.removeEventListener("offline", updateConnectivity);
      };
    }

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });

        if (registration.waiting) setUpdateReady(true);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (
              worker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              setUpdateReady(true);
            }
          });
        });
      } catch {
        // A failed registration must not affect the authenticated shell.
      }
    };

    window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
    };
  }, []);

  return (
    <>
      {!online ? (
        <p className="connectivity-status" role="status">
          You are offline. Private data and changes are unavailable until you
          reconnect.
        </p>
      ) : null}
      {updateReady ? (
        <p className="update-status" role="status">
          <span>Update ready.</span>
          <button
            type="button"
            onClick={() => {
              navigator.serviceWorker.controller?.postMessage({
                type: "SKIP_WAITING",
              });
              window.location.reload();
            }}
          >
            Reload
          </button>
        </p>
      ) : null}
    </>
  );
}
