// UI-040 (owner directive, verbatim, 2026-08-25): "Let add a 'Hide Sold'
// button for the holdings." Orchestrator ruling: "The toggle is display
// state, not a mutation: no isOnline gating, works offline; persists per
// portfolio for the session (sessionStorage per the DIV-013 pattern,
// try/catch, default SHOW)." This module mirrors `income-whatif.ts`'s
// DIV-013 session-storage helpers verbatim: a per-portfolio namespaced key
// (two portfolios open in the same session never share or clobber each
// other's toggle state), try/catch on both read and write (AGENTS.md: a
// private/incognito tab, a storage quota, or corrupted content must never
// break rendering), and an honest default on any failure or absent value.
//
// UI-052 (owner directive, verbatim, 2026-08-31): "Quickly change the
// default to be 'hide sold' in the holdings tab." SUPERSEDES UI-040's
// default-SHOW ruling above: the default is now `true` ("Hide Sold"
// active). An explicit stored `"false"` from earlier in the session still
// means SHOW -- only the ABSENT/unreadable/unrecognised cases take the
// new default, so a toggle the owner flipped this session is respected.
import type { StorageLike } from "./income-whatif";

export type { StorageLike };

/** Per-portfolio session-storage key -- same namespacing rationale as
 * `capitalEventsStorageKey` (DIV-013). */
export function hideSoldStorageKey(portfolioId: string): string {
  return `yieldtome:holdings-hide-sold:${portfolioId}`;
}

/** Reads this session's Hide Sold toggle state back out of `storage`
 * (normally `window.sessionStorage`). Returns the default (`true`, "hide
 * sold" -- the owner's UI-052 directive) on any failure: no stored value,
 * unrecognised content, or a throwing storage implementation. An explicit
 * stored `"false"` (the owner toggled to Show this session) is honoured. */
export function loadHideSoldSession(
  storage: StorageLike,
  key: string,
): boolean {
  try {
    const stored = storage.getItem(key);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return true;
  } catch {
    return true;
  }
}

/** Mirror write path -- try/catch wrapped for the identical reasons as
 * `saveCapitalEventsSession` (DIV-013): a full or blocked storage must
 * never surface as a rendering error, it simply won't survive navigation. */
export function saveHideSoldSession(
  storage: StorageLike,
  key: string,
  value: boolean,
): void {
  try {
    storage.setItem(key, value ? "true" : "false");
  } catch {
    // Storage unavailable/full/blocked -- swallowed deliberately.
  }
}
