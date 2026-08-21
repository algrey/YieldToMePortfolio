"use client";

// UI-023: the per-holding Details view -- the standalone full-screen page
// that replaced the owned holdings list's in-place <dialog> sheet (owner
// decision, competitor layout precedent: sub-tabs with a back control and
// maximum screen space for the holding itself, never a popup). The facts
// block, currency-view select, price-history chart, explanation, and
// Dividends link are carried over from that sheet verbatim in behaviour:
// unknown money renders its specific unavailable text, never zero, via the
// shared `owned-holding-format` helpers the holdings list itself uses.
import Link from "next/link";
import { useState } from "react";
import type { OwnedHoldingRow } from "../owned-holdings-contract";
import {
  ownedHoldingAmount,
  ownedHoldingDecimal,
  ownedHoldingPercent,
  ownedHoldingTrimmed,
} from "../owned-holding-format";
import { HoldingNav } from "./holding-nav";
import { HoldingPriceChart } from "./holding-price-chart";

export function HoldingDetailScreen({
  portfolioId,
  holding,
  symbol,
  subtitle,
  portfolioSecurityId,
  homeCurrencyCode,
  initialView,
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
              <dd>{ownedHoldingDecimal(holding.quantity, 4)}</dd>
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
                      ? "Price unavailable"
                      : `${holding.currencyCode} native fallback`;
                  try {
                    return `${price.currencyCode} ${ownedHoldingTrimmed(price.value)}${view === "home" && !home ? " · native fallback" : ""}`;
                  } catch {
                    return "Price unavailable";
                  }
                })()}
              </dd>
            </div>
            <div>
              <dt>Value</dt>
              <dd>
                {ownedHoldingAmount(
                  view === "home" && holding.homeValue.status === "available"
                    ? holding.homeValue
                    : holding.nativeValue,
                )}
              </dd>
            </div>
            <div>
              <dt>Gain</dt>
              <dd className={`tone-${holding.gainTone}`}>
                {ownedHoldingAmount(holding.unrealisedGain, 2, true)}
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
                  : `${holding.currencyCode} ${ownedHoldingTrimmed(holding.averageNativeCost)} × ${ownedHoldingDecimal(holding.quantity, 4)}`}
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
      />
      {holding ? (
        <p className="detail-explanation">{holding.explanation}</p>
      ) : null}
      <p>
        <Link
          className="sheet-back"
          href={`/portfolio/${portfolioId}/securities/${portfolioSecurityId}/dividends`}
        >
          View dividends
        </Link>
      </p>
    </main>
  );
}
