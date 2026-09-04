// PRF-014 step 2b type-level pin -- see tests/prf-014.test.ts for this
// task's runtime/source pins.
//
// This file is intentionally NOT named `*.test.ts`: `npm test`'s
// `node --experimental-strip-types --test tests/*.test.ts tests/*.test.mjs`
// glob does not pick it up. That matters because it statically
// value-imports `portfolio-shell.tsx`, a "use client" JSX module --
// `--experimental-strip-types` strips TYPES but not JSX, so actually
// EXECUTING that import under plain Node would fail; every runtime test
// that needs to render this component instead shells out to a separate
// `tsx`-loaded process (see e.g. tests/ui-035.test.ts's
// `renderOwnedHoldingsScreen`). `npm run typecheck` (`tsc --noEmit`, whose
// tsconfig `include` covers every `**/*.ts`) DOES pick this file up --
// that's the whole point: a compile-time-only assertion that
// `PortfolioShell`'s discriminated props (PRF-014 step 2b) reject
// preview-only props at the TYPE level, not merely by omission at runtime.
import type { ComponentProps } from "react";
import { PortfolioShell } from "../app/components/portfolio-shell.tsx";

type PortfolioShellProps = ComponentProps<typeof PortfolioShell>;

// Never constructed at runtime (this module is never imported by anything
// that executes) -- exists only so `tsc --noEmit` type-checks the
// assignment below and enforces that it stays a type error.
const _rejectedByPortfolioShell: PortfolioShellProps = {
  activeSection: "overview",
  // @ts-expect-error -- `portfolioPrototypesOverride` is a PreviewShell-only
  // prop (see preview-shell.tsx's own props type); PortfolioShell requires
  // `ownedWorkspace` and no longer accepts any preview prop at all. If this
  // stops erroring, PortfolioShell's discriminated-props boundary has
  // regressed and PRF-014 step 2b's guarantee no longer holds.
  portfolioPrototypesOverride: [],
};
void _rejectedByPortfolioShell;
