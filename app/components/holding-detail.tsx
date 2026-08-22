"use client";

// UI-023: the per-holding Details view -- the standalone full-screen page
// that replaced the owned holdings list's in-place <dialog> sheet (owner
// decision, competitor layout precedent: sub-tabs with a back control and
// maximum screen space for the holding itself, never a popup). The facts
// block, currency-view select, price-history chart, explanation, and
// Dividends link are carried over from that sheet verbatim in behaviour:
// unknown money renders its specific unavailable text, never zero, via the
// shared `owned-holding-format` helpers the holdings list itself uses.
import { useEffect, useRef, useState } from "react";
import type { OwnedHoldingRow } from "../owned-holdings-contract";
import {
  ownedHoldingAmount,
  ownedHoldingPercent,
  ownedHoldingQuantity,
  ownedHoldingTrimmed,
} from "../owned-holding-format";
import { HoldingNav } from "./holding-nav";
import { HoldingPriceChart } from "./holding-price-chart";
import { currencyDisplayPrefix } from "../currency-display.ts";
import type { QuoteRow } from "../quote-contract.ts";
import {
  QuoteCorrectionDialog,
  QuoteCorrectionHistory,
} from "./portfolio-shell";

// MKT-014: the old owned QuotesScreen was the only UI entry point for
// on-demand market-data refresh (`app/market-data-actions.ts`'s
// `requestMarketDataRefreshForContext`, unchanged by this task) and the
// manual quote-correction dialog + correction history. WLT-001 retired that
// screen in favour of the interest-only watchlist, stranding both
// affordances -- the Orchestrator's MKT-014 placement ruling puts them here:
// this sheet already owns the holding's security context, the UI-018 price
// chart, and the provenance surfaces. "Correct quote"/"Correction history"
// REUSE `QuoteCorrectionDialog`/`QuoteCorrectionHistory` from
// `portfolio-shell.tsx` (same ref+showModal/opener-restore/AbortController
// conventions) rather than forking a second copy of either.
const FETCH_TIMEOUT_MS = 15_000;

// Local, not imported from `portfolio-shell.tsx`: that file's
// `DIALOG_FETCH_TIMEOUT_MS`/`isAbortError` are private to it, and this
// panel's own refresh fetch is a plain scoped mutation, not a `<dialog>`
// submit racing a keyboard trap -- mirrors `holding-price-chart.tsx`'s
// identical precedent/comment for the same reason.
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function HoldingMarketDataPanel({
  portfolioId,
  portfolioSecurityId,
  holding,
  homeCurrencyCode,
  marketDataProviderEnabled,
}: {
  portfolioId: string;
  portfolioSecurityId: string;
  holding: OwnedHoldingRow;
  homeCurrencyCode: string;
  marketDataProviderEnabled: boolean;
}) {
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    const updateConnectivity = () => setIsOnline(navigator.onLine);
    updateConnectivity();
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    return () => {
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
    };
  }, []);

  const [actionPending, setActionPending] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<
    "idle" | "pending" | "queued" | "failed"
  >("idle");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const correctionButtonRef = useRef<HTMLButtonElement>(null);
  const correctionOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyOpenerRef = useRef<HTMLButtonElement | null>(null);

  // UI-007 opener-restore convention, mirroring QuotesScreen's identical
  // effect in portfolio-shell.tsx: the button ref is only captured into
  // `correctionOpenerRef` at the moment it opens the dialog, so this can't
  // steal focus on initial mount.
  useEffect(() => {
    if (!correctionOpen && correctionOpenerRef.current) {
      correctionOpenerRef.current.focus();
      correctionOpenerRef.current = null;
    }
  }, [correctionOpen]);

  // MKT-014 (F6): the correction-history panel gets the SAME opener-restore
  // treatment as the correction dialog above -- Close shouldn't drop focus
  // to <body>.
  useEffect(() => {
    if (!historyOpen && historyOpenerRef.current) {
      historyOpenerRef.current.focus();
      historyOpenerRef.current = null;
    }
  }, [historyOpen]);

  const mutationsDisabled = actionPending || !isOnline;

  async function requestRefresh() {
    setActionMessage(null);
    setActionPending(true);
    setRefreshState("pending");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch("/api/market-data/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portfolioId, portfolioSecurityId }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        ok: boolean;
        jobs?: Array<{ id: string }>;
        message?: string;
      };
      if (!response.ok || !result.ok)
        throw new Error(result.message ?? "Refresh could not be queued.");
      if (!result.jobs?.length) {
        setRefreshState("idle");
        setActionMessage(
          "No verified quote target is available; no refresh was queued.",
        );
        return;
      }
      setRefreshState("queued");
      setActionMessage("Refresh queued.");
    } catch (error) {
      setRefreshState("failed");
      setActionMessage(
        isAbortError(error)
          ? "The request timed out. It may still have gone through — check before retrying."
          : error instanceof Error
            ? error.message
            : "Refresh could not be queued.",
      );
    } finally {
      clearTimeout(timeout);
      setActionPending(false);
    }
  }

  // A minimal, valid `QuoteRow` for the ONE holding this sheet owns --
  // `QuoteCorrectionDialog` only ever reads `.securityId`/`.currencyCode`/
  // `.symbol`/`.name`/`.targetKey` off its `quoteTargets`, never the
  // display-only price/change/percent/provenance/sort fields, so those are
  // filled with placeholders that are honest about being unknown here
  // (`source`/`scope`: "none") rather than fabricating "provider"/
  // "deployment" provenance this panel never actually observed -- the
  // holding's current price may itself already be a manual correction.
  const correctionTarget: QuoteRow = {
    targetKey: holding.securityId,
    portfolioSecurityId,
    securityId: holding.securityId,
    symbol: holding.symbol,
    name: holding.name,
    currencyCode: holding.currencyCode,
    price: holding.nativePrice ?? "",
    change: "",
    percent: "",
    tone: holding.dailyTone,
    marketDate: "",
    state: holding.priceState,
    provenance: {
      source: "none",
      providerId: null,
      observationAt: null,
      delayedMinutes: null,
      scope: "none",
      quality: null,
      fallbackReason: holding.explanation,
    },
    sort: { ticker: holding.symbol, price: "", change: "" },
  };

  return (
    <>
      <div className="quote-actions" aria-label="Market data actions">
        {!marketDataProviderEnabled ? (
          <p className="data-explanation" role="status">
            Market-data refresh is unavailable for this deployment. Manual
            corrections remain available below.
          </p>
        ) : null}
        <div className="quote-action-buttons">
          <button
            type="button"
            onClick={() => void requestRefresh()}
            disabled={mutationsDisabled || !marketDataProviderEnabled}
          >
            {refreshState === "pending" ? "Queueing…" : "Refresh market data"}
          </button>
          <button
            ref={correctionButtonRef}
            type="button"
            onClick={() => {
              correctionOpenerRef.current = correctionButtonRef.current;
              setCorrectionOpen(true);
            }}
            disabled={mutationsDisabled}
          >
            Correct quote
          </button>
          <button
            ref={historyButtonRef}
            type="button"
            onClick={() => {
              historyOpenerRef.current = historyButtonRef.current;
              setHistoryOpen(true);
            }}
            disabled={mutationsDisabled}
          >
            Correction history
          </button>
        </div>
        {/* MKT-014 (F3): a persistent, non-color explanation of what
            "queued" does and doesn't mean -- mirrors QuotesScreen's own
            refreshState-driven hint (portfolio-shell.tsx), a separate line
            from the actionMessage toast below since actionMessage is
            shared with the correction-history panel's own messages. */}
        {refreshState === "queued" ? (
          <p className="quote-action-status" role="status" aria-live="polite">
            Refresh queued; current values are unchanged until the job
            completes.
          </p>
        ) : null}
        {/* UI-007: suppressed while the correction dialog is open --
            everything outside an open top-layer <dialog> is
            inert/unannounced, mirroring QuotesScreen's identical toast in
            portfolio-shell.tsx. */}
        {actionMessage && !correctionOpen ? (
          <p className="quote-action-status" role="alert">
            {actionMessage}
          </p>
        ) : null}
      </div>
      {historyOpen ? (
        <QuoteCorrectionHistory
          portfolioId={portfolioId}
          targetKey={holding.securityId}
          readOnly={false}
          onClose={() => setHistoryOpen(false)}
          onMessage={setActionMessage}
        />
      ) : null}
      {correctionOpen ? (
        <QuoteCorrectionDialog
          portfolioId={portfolioId}
          quoteTargets={[correctionTarget]}
          portfolioBaseCurrency={homeCurrencyCode}
          readOnly={false}
          onClose={() => setCorrectionOpen(false)}
          onMessage={setActionMessage}
        />
      ) : null}
    </>
  );
}

export function HoldingDetailScreen({
  portfolioId,
  holding,
  symbol,
  subtitle,
  portfolioSecurityId,
  homeCurrencyCode,
  initialView,
  marketDataProviderEnabled,
}: {
  portfolioId: string;
  /** The published valuation row -- null when this holding has no row in
   * the current published projection (e.g. a fully exited position). The
   * screen then renders an honest unavailable state, never zeros. */
  holding: OwnedHoldingRow | null;
  symbol: string;
  subtitle: string;
  portfolioSecurityId: string;
  homeCurrencyCode: string;
  initialView: "native" | "home";
  /** MKT-014: whether this deployment's `MARKET_DATA_PROVIDER` activation
   * gate is on (`app/market-data-provider-status.ts`) -- gates only the
   * refresh control; manual correction stays available regardless. */
  marketDataProviderEnabled: boolean;
}) {
  const [view, setView] = useState<"native" | "home">(initialView);

  return (
    <main className="income-screen holding-screen">
      <HoldingNav
        portfolioId={portfolioId}
        portfolioSecurityId={portfolioSecurityId}
        symbol={symbol}
        subtitle={subtitle}
        active="details"
      />

      {holding === null ? (
        <section
          className="empty-state"
          aria-labelledby="holding-valuation-unavailable"
        >
          <h2 id="holding-valuation-unavailable">
            No published valuation for this holding
          </h2>
          <p>
            This holding has no row in the current published portfolio valuation
            -- typically a fully exited position. Its transaction and dividend
            history remain available.
          </p>
        </section>
      ) : (
        <>
          <HoldingMarketDataPanel
            portfolioId={portfolioId}
            portfolioSecurityId={portfolioSecurityId}
            holding={holding}
            homeCurrencyCode={homeCurrencyCode}
            marketDataProviderEnabled={marketDataProviderEnabled}
          />
          {holding.currencyCode !== homeCurrencyCode ? (
            <label className="menu-field holding-view-field">
              <span>Display values</span>
              <select
                value={view}
                aria-label={`Display ${holding.symbol} values in native or home currency`}
                onChange={(event) =>
                  setView(event.target.value as "native" | "home")
                }
              >
                <option value="native">Native currency</option>
                <option value="home">Home currency</option>
              </select>
            </label>
          ) : null}
          <dl className="detail-facts">
            <div>
              <dt>Quantity</dt>
              <dd>{ownedHoldingQuantity(holding.quantity)}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>
                {(() => {
                  const home =
                    view === "home" && holding.homePrice.status === "available";
                  const price = home
                    ? holding.homePrice
                    : holding.nativePrice === null
                      ? {
                          status: "unavailable" as const,
                          value: null,
                          currencyCode: holding.currencyCode,
                        }
                      : {
                          status: "available" as const,
                          value: holding.nativePrice,
                          currencyCode: holding.currencyCode,
                        };
                  if (price.status !== "available" || price.value === null)
                    return holding.nativePrice === null
                      ? "unavailable"
                      : `${currencyDisplayPrefix(holding.currencyCode, homeCurrencyCode)} native fallback`;
                  try {
                    return `${currencyDisplayPrefix(price.currencyCode, homeCurrencyCode)}${ownedHoldingTrimmed(price.value)}${view === "home" && !home ? " · native fallback" : ""}`;
                  } catch {
                    return "unavailable";
                  }
                })()}
              </dd>
            </div>
            <div>
              <dt>Value</dt>
              <dd>
                {ownedHoldingAmount(
                  homeCurrencyCode,
                  view === "home" && holding.homeValue.status === "available"
                    ? holding.homeValue
                    : holding.nativeValue,
                )}
              </dd>
            </div>
            <div>
              <dt>Gain</dt>
              <dd className={`tone-${holding.gainTone}`}>
                {ownedHoldingAmount(
                  homeCurrencyCode,
                  holding.unrealisedGain,
                  2,
                  true,
                )}
              </dd>
            </div>
            <div>
              <dt>Daily %</dt>
              <dd className={`tone-${holding.dailyTone}`}>
                {ownedHoldingPercent(holding.dailyPercent, true)}
              </dd>
            </div>
            <div>
              <dt>Unrealised %</dt>
              <dd className={`tone-${holding.gainTone}`}>
                {ownedHoldingPercent(holding.unrealisedPercent, true)}
              </dd>
            </div>
            <div>
              <dt>Average cost × quantity</dt>
              <dd>
                {holding.averageNativeCost === null
                  ? "Basis unavailable"
                  : `${currencyDisplayPrefix(holding.currencyCode, homeCurrencyCode)}${ownedHoldingTrimmed(holding.averageNativeCost)} × ${ownedHoldingQuantity(holding.quantity)}`}
              </dd>
            </div>
          </dl>
        </>
      )}

      <HoldingPriceChart
        key={portfolioSecurityId}
        portfolioId={portfolioId}
        portfolioSecurityId={portfolioSecurityId}
        symbol={symbol}
        baseCurrencyCode={homeCurrencyCode}
      />
      {holding ? (
        <p className="detail-explanation">{holding.explanation}</p>
      ) : null}
    </main>
  );
}
