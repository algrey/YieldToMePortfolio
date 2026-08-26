"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { readRememberedPrimaryTab } from "../last-primary-tab";

// UI-037: the back control for full-screen pages reachable from MORE THAN
// ONE place. The manual ledger entry page is linked from the Details
// screen, from an empty-state prose link, and from the top bar's "+" menu
// -- which is available on every primary tab -- so a hard-coded "back to
// details" would be wrong for most arrivals. This control goes BACK in
// browser history when this tab actually has somewhere to go back to, and
// falls back to a real, owner-chosen href for direct loads (deep link,
// fresh tab), where history.back() would do nothing or leave the app.
//
// Pages with a single definite parent (the holding area, the Income area)
// keep their static SubNav back links instead -- a deterministic target is
// better than history where one exists.

export function HistoryBackControl({
  fallbackHref,
  label,
}: {
  /** Real href for no-JS and no-history arrivals; also the modified-click
   * (new tab) target. */
  fallbackHref: string;
  /** Accessible name for the icon-only control, e.g. "Back". */
  label: string;
}) {
  return (
    <a
      className="subnav-back"
      href={fallbackHref}
      aria-label={label}
      onClick={(event) => {
        // Modified/non-primary clicks are the browser's own open-in-new-tab
        // gesture: let the native fallback href handle them (mirrors the
        // Link guard convention established in UI-016).
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        // history.length === 1 means this tab has never navigated -- a
        // direct/deep-linked arrival where back() would be a no-op (or
        // leave the app entirely on some browsers). Falling THROUGH to the
        // anchor's own href covers that case, and keeps this component
        // free of any router hook so it renders in any tree (UI-046: the
        // Income screens' many static-render tests mount no router).
        if (window.history.length > 1) {
          event.preventDefault();
          window.history.back();
        }
      }}
    >
      {/* Style guide -- Iconography: thin-line, geometric, consistent stroke
          weight; identical glyph and .subnav-back styling to the holding and
          Income areas' back controls. */}
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M14.5 5 7.5 12l7 7" />
      </svg>
    </a>
  );
}

/** The remembered tab only changes while the owner is on a PRIMARY tab --
 * never while this control is mounted -- so there is nothing to subscribe
 * to; the snapshot is read once per mount. */
function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * UI-048: the back control for a full-screen sub-area whose sub-tabs each
 * push their own history entry (Income). Plain history-back walks those
 * sub-tabs one at a time before leaving the area -- correct browser
 * behaviour, but not what the owner wants from an area's own back arrow.
 * This instead LEAVES the area, returning to the primary tab the owner was
 * on when they entered it (recorded by `PortfolioShell`).
 *
 * Renders a real `<Link>`, so it works with JS disabled, supports
 * cmd/middle-click, and needs no router mounted for a static render: the
 * href starts as `fallbackHref` and is upgraded to the remembered tab
 * after hydration.
 */
export function AreaExitBackControl({
  fallbackHref,
  label,
}: {
  /** Where to go when nothing was remembered (a direct/deep-linked arrival
   * or blocked storage) -- the owner's usual entry point for the area. */
  fallbackHref: string;
  label: string;
}) {
  // `useSyncExternalStore` is the SSR-safe way to read external (storage)
  // state: the server snapshot is the fallback href, so the static render
  // and first paint agree, and the client snapshot upgrades to the
  // remembered tab. Reading sessionStorage during render or setting state
  // inside an effect would either break hydration or cascade a re-render.
  const href = useSyncExternalStore(
    subscribeToNothing,
    () => readRememberedPrimaryTab() ?? fallbackHref,
    () => fallbackHref,
  );
  return (
    <Link className="subnav-back" href={href} aria-label={label}>
      {/* Identical glyph/class to the other back controls. */}
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M14.5 5 7.5 12l7 7" />
      </svg>
    </Link>
  );
}
