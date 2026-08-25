// UI-040 (owner directive, verbatim, 2026-08-25): "Let add a 'Hide Sold'
// button for the holdings." Orchestrator ruling: "The toggle is display
// state, not a mutation: no isOnline gating, works offline; persists per
// portfolio for the session (sessionStorage per the DIV-013 pattern,
// try/catch, default SHOW)." This module mirrors `income-whatif.ts`'s
// DIV-013 session-storage helpers verbatim: a per-portfolio namespaced key
// (two portfolios open in the same session never share or clobber each
// other's toggle state), try/catch on both read and write (AGENTS.md: a
// private/incognito tab, a storage quota, or corrupted content must never
// break rendering), and an honest default (`false` -- "SHOW", the owner's
// explicit default) on any failure or absent value.
import type { StorageLike } from "./income-whatif";

export type { StorageLike };

/** Per-portfolio session-storage key -- same namespacing rationale as
 * `capitalEventsStorageKey` (DIV-013). */
export function hideSoldStorageKey(portfolioId: string): string {
  return `yieldtome:holdings-hide-sold:${portfolioId}`;
}

/** Reads this session's Hide Sold toggle state back out of `storage`
 * (normally `window.sessionStorage`). Returns the honest default (`false`,
 * "Show Sold" -- the owner's explicit default) on any failure: no stored
 * value, unrecognised content, or a throwing storage implementation. */
export function loadHideSoldSession(
  storage: StorageLike,
  key: string,
): boolean {
  try {
    return storage.getItem(key) === "true";
  } catch {
    return false;
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
