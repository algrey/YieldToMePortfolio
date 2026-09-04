"use client";

// PRF-014 step 2c: `HoldingsSummaryFooterRow` (see
// portfolio-shell-leaves.tsx) has zero hooks/state/effects/browser APIs of
// its own -- its ONLY genuinely interactive fragment is the "Hide
// Sold"/"Show Sold" toggle button, which used to receive a bare
// `onToggleHideSold: () => void` closure as a prop. A plain function
// cannot cross a real server/client component boundary (only a Server
// Action can), so a component holding one in its own prop type can never
// actually be rendered from a Server Component -- it would only ever work
// by accident, the way it does TODAY, because `portfolio-shell.tsx` (the
// caller, `OwnedHoldingsScreen`) is itself still "use client" and nothing
// here crosses a real RSC boundary yet.
//
// Inversion: `OwnedHoldingsScreen` (still "use client", still owns the
// `hideSold`/`setHideSold` state) now builds this element itself and hands
// the FINISHED node down to `HoldingsSummaryFooterRow` as a plain
// `hideSoldToggle: ReactNode` prop -- an already-rendered React element is
// serializable across a real server/client boundary the way a closure is
// not, which is what makes `HoldingsSummaryFooterRow` itself safe to
// render from a genuine Server Component once PRF-014 step 2e gives it
// one. Markup is byte-identical to the pre-2c inline `<button>`.
//
// Honesty note (see portfolio-shell-leaves.tsx's own header comment): this
// file is "use client" and this component genuinely needs to be, but
// `portfolio-shell.tsx` (the only importer today) is ALSO still "use
// client" end-to-end, so this split changes nothing about what ships in
// today's production client bundle -- it is preparation for step 2e, not
// a bundle-size win by itself.
export function HideSoldToggle({
  hideSold,
  onToggleHideSold,
}: {
  hideSold: boolean;
  onToggleHideSold: () => void;
}) {
  return (
    <button
      type="button"
      className="hide-sold-toggle"
      aria-pressed={hideSold}
      onClick={onToggleHideSold}
    >
      {hideSold ? "Show Sold" : "Hide Sold"}
    </button>
  );
}
