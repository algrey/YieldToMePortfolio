// UI-048: remembers which PRIMARY tab the owner was on before entering a
// full-screen sub-area (Income), so that area's back control can return
// them there directly.
//
// Owner-reported against UI-046's plain history-back: cycling through the
// Income sub-tabs and then pressing back walked back through each sub-tab
// first (exactly what a browser Back does) instead of leaving the area.
// The owner's stated ideal: "go back to the higher level tab menu and land
// on the last main-tab you called the Income tab from."
//
// `PortfolioShell` renders on the primary tabs and NOWHERE else (the Income
// and holding areas render their own `<main>`), so recording the pathname
// from the shell captures exactly the "last primary tab" without any
// area-entry detection.
//
// Session storage, deliberately NOT the persistent kind: this is per-tab
// navigation state, and
// it must not leak between browser tabs or survive a browser restart. It
// holds a path only -- never portfolio values or any other private data.
import { portfolioSections } from "./portfolio-sections.ts";

export const LAST_PRIMARY_TAB_KEY = "yieldtome:last-primary-tab";

/**
 * Only the workspace root and a real `/portfolio/:id/:section` primary tab
 * are accepted. Validating on READ (not just write) keeps a tampered or
 * stale sessionStorage value from becoming an open redirect: anything
 * protocol-relative (`//evil.example`), absolute, or otherwise unexpected
 * is rejected in favour of the caller's own fallback.
 */
export function isPrimaryTabPath(value: string): boolean {
  if (value === "/") return true;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  const segments = value.split("/");
  // ["", "portfolio", "<id>", "<section>"]
  if (segments.length !== 4) return false;
  if (segments[1] !== "portfolio") return false;
  if (segments[2].length === 0) return false;
  return (portfolioSections as readonly string[]).includes(segments[3]);
}

export function rememberPrimaryTab(pathname: string): void {
  if (!isPrimaryTabPath(pathname)) return;
  try {
    window.sessionStorage.setItem(LAST_PRIMARY_TAB_KEY, pathname);
  } catch {
    // Private-mode / blocked storage: the back control keeps its fallback.
  }
}

export function readRememberedPrimaryTab(): string | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(LAST_PRIMARY_TAB_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  return isPrimaryTabPath(raw) ? raw : null;
}
