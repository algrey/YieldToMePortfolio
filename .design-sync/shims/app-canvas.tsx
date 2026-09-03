// design-sync: the app's page canvas as a component. In the real app these
// values come from `html`/`body` rules in app/globals.css (ink background,
// cream text, the --sans stack, tabular numerals). Preview cards and designs
// built with the library render inside a host page that paints its own
// white body, so this wrapper re-establishes the canvas the components were
// designed on. It adds no design of its own - only the body-level defaults.
import * as React from "react";

export function AppCanvas({ children }: { children?: React.ReactNode }) {
  return (
    <div
      className="app-canvas"
      style={{
        background: "var(--ink)",
        color: "var(--cream)",
        fontFamily: "var(--sans)",
        fontVariantNumeric: "tabular-nums lining-nums",
        minHeight: "100%",
        // Fill the preview host's 24px body padding so the card is edge-to-edge ink.
        margin: "-24px",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}
