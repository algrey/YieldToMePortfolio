// UI-027 (owner directive, verbatim, 2026-08-22): "All numbers of stocks
// held should be displayed as whole numbers with no decimals... if we
// handle fractional stocks, it should display a whole number, UNLESS the
// stock is fractional." This is the ONE shared quantity-display
// implementation for every surface in the app that renders a share/unit
// quantity (holdings rows/sheet, transactions, dividend forms/history, CGT
// screens, and any future caller) -- DISPLAY-ONLY: stored quantities stay
// exact decimal strings everywhere else (ledger, FIFO, CGT, exports, CSV
// backup/import).
//
// A genuinely INTEGRAL quantity renders with no decimal point at all
// ("150", never "150.00000000"); a genuinely FRACTIONAL quantity keeps its
// real digits at the FULL exact source/security scale, trimming only
// insignificant trailing zeroes ("150.5", "0.12345678", "1.0000001"),
// never rounded to any fixed display scale -- rounding a real fractional
// position would misstate a financial fact. This directly matches
// `docs/CALCULATIONS.md`'s rounding rule ("Display quantity up to the
// security/source scale, trimming insignificant trailing zeroes"), so no
// display-scale cap is applied here at all: `formatDecimalExact` reads the
// scale straight off the parsed decimal's own source string (however many
// digits it carries) rather than rounding to a fixed number of places.
// This also makes a "never a fake zero" fallback structurally unnecessary:
// since nothing is ever rounded away, a genuinely non-zero quantity can
// never collapse to "0" in the first place (UI-027 review, 2026-08-22 --
// an earlier revision capped this at a fixed 6dp trim, which both
// contradicted CALCULATIONS' full-source-scale rule and rounded a
// sufficiently precise real quantity, e.g. "1.0000001", to a fake whole
// "1"; fixed by switching the primary/only path to
// `formatDecimalExact`, mirroring the FIFO audit surface's
// (`app/components/portfolio-details.tsx`) pre-existing source-scale
// convention this task otherwise removed as a "duplicate"). If real-world
// display length ever becomes a UX problem for an unusually high-precision
// quantity, that is a future owner ruling on a display cap, not assumed
// here.
//
// Deliberately a plain, JSX-free `.ts` module rather than living only in
// `app/owned-holding-format.tsx` (which contains real JSX in
// `ownedHoldingPercent`): this repo's Node test runtime
// (`node --experimental-strip-types`) strips TypeScript type annotations
// but cannot parse JSX syntax, so a `.ts` module some tests import
// DIRECTLY -- `app/income-format.ts`, `app/dividend-history-prefill.ts`
// (see that file's own header comment on the same constraint) -- must
// never transitively import a `.tsx` file containing real JSX.
// `owned-holding-format.tsx` re-exports this as `ownedHoldingQuantity` for
// the `.tsx` call sites that already use its `ownedHoldingXxx` naming
// convention.
import {
  formatDecimalExact,
  groupThousands,
  parseDecimalResult,
} from "../domain/calculations/index.ts";

export function formatQuantityDisplay(
  value: string | null,
  unavailableLabel = "—",
): string {
  if (value === null) return unavailableLabel;
  try {
    return groupThousands(formatDecimalExact(parseDecimalResult(value)));
  } catch {
    return unavailableLabel;
  }
}
