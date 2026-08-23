"use client";

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
import { useRouter } from "next/navigation";

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
  const router = useRouter();
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
        event.preventDefault();
        // history.length === 1 means this tab has never navigated -- a
        // direct/deep-linked arrival where back() would be a no-op (or
        // leave the app entirely on some browsers).
        if (window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
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
