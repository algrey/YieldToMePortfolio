# design-sync notes (YieldToMe)

Repo-specific facts a future sync needs. Config lives in `config.json`; this file holds the why.

## Shape and inputs

- This is a Next-compatible app (vinext), not a library: no `dist/` entry, no `.d.ts` tree, no Storybook. `.design-sync/pkg/` is a tiny package manifest that presents `app/components/*.tsx` as a library so the converter can run its normal package path. `node .design-sync/build-pkg.mjs` (cfg.buildCmd) regenerates its three machine-made siblings - `index.ts` barrel, `types/` (tsc declaration emit), `yieldtome.css` (globals compiled through the app's Tailwind v4 postcss pipeline). Those three are gitignored; only `pkg/package.json` is committed. Run buildCmd before every converter run.
- `tsc` declaration emit reports errors from `db/d1-sql-client.ts` unless `worker-configuration.d.ts` is in the include list (it is, in `tsconfig.types.json`). It still emits on errors.
- `service-worker-registration.tsx` is excluded from the barrel (wiring, not UI).
- Components import `next/link`, `next/navigation`, and (transitively via `app/owned-dividend-list.ts`) `node:crypto`. `.design-sync/tsconfig.json` `paths` map those to `.design-sync/shims/*` so the bundle resolves and renders without an App Router. The shims are plain anchors / window.location-backed hooks / `crypto.randomUUID`. If a new Next module import appears in `app/components`, add a shim and a path entry.
- Value imports from components reach only pure formatting modules; `db/`, `domain/observability`, Sharesight, and provider code do not enter the bundle (checked by grepping `_ds_bundle.js` for `cloudflare:`, `D1Database`, `drizzle`, `process.env`, `server-only` - all zero). Re-check after adding components.
- No `@/` alias usage in `app/components` today; the paths entry is there for completeness.

## Styling

- `app/globals.css` is a hand-written class system (~320 classes, dark ink/forest palette, `--sans`/`--serif` stacks) plus `@import "tailwindcss"` for preflight/theme; components use zero Tailwind utilities.
- Tokens are `:root` custom properties inside the compiled CSS; there is no separate tokens package, so `tokens/` is empty and the token scope comes from `_ds_bundle.css`.

## Fonts

- Owner decision (2026-09-03): accept system substitutes. The app ships no font files and loads no web font, so `[FONT_MISSING]` for Inter / Geist / SF Pro Text / Iowan Old Style / Palatino is expected and matches production behaviour. Do not add `extraFonts` unless the app itself starts shipping fonts.

## Grouping

- `app/components/` is flat, so the converter would put everything in `general`. `.design-sync/docs/<Name>.md` stubs carry only `category:` frontmatter; `docsDir: ../docs` (package-relative) binds them by basename. Add a stub when adding a component, or it lands in `general`.

## Known render warns

- (filled in during the verify loop)

## Re-sync risks

- (filled in at the end of the run)

## Preview canvas (AppCanvas provider)

- Every card renders on the converter's white body, so cream-on-ink components were unreadable. `.design-sync/shims/app-canvas.tsx` (via `extraEntries`) exports `AppCanvas`, set as `cfg.provider`; it re-applies the app's `html`/`body` defaults (ink background, cream text, `--sans`, tabular numerals) and fills the 24px card padding. It is also exposed to the design agent as the canvas wrapper (see conventions.md). Side effect: a component that renders `null` with the floor's stub props no longer falls to the typographic floor card (the canvas div keeps the root non-empty) and shows as `[RENDER_BLANK]` instead — author a preview for it (MultiFileRunStatus, RecordDividendDialog were the two).

## Sandbox

- `package-validate.mjs`, `package-capture.mjs`, `npx playwright install` need `dangerouslyDisableSandbox` in Claude Code: the render check listens on 127.0.0.1 (`listen EPERM`) and the browser cache lives in `~/Library/Caches/ms-playwright` (mkdir EPERM). Playwright 1.62.1 → chromium_headless_shell-1234.
- The shell cwd drifts between Bash calls; always use absolute paths or prefix `cd <repo> &&`.

## Upstream defects seen while grading (not fixed by the sync)

- `OwnedDividendList`: its `<p className="status-banner warning"><strong/><span/></p>` notices put the `<strong>` in `.status-banner`'s 24px symbol column (grid `24px minmax(0,1fr) auto`), so the summary wraps one word per line. Real app render; fix belongs in `app/components/owned-dividend-list.tsx` (add the `status-symbol` span / `<p>` wrapper the CSS expects).
- `HoldingPriceChart` / `PriceHistoryChartView` error banner and `HoldingTransactionsScreen` truncated notice: same `.status-banner` grid misuse (`holding-price-chart.tsx:314`) — the `<strong>` title overprints the message.
- `.sheet-close` (`globals.css:2807`) is an unpositioned 44px inline button that overlaps the first `.eyebrow` in `.income-dialog`/`.gains-dialog` (`FyDetailDialog`, `RecordDividendDialog`).
- `.detail-facts` is only styled under `.holding-screen` (`globals.css:4539`), so `FyDetailDialog`'s fact lists render as bare dt/dd.

## Preview authoring facts (from the first wave)

- Card overrides: charts and tab bars are `cardMode: column`; full screens are `column` + a tall `viewport` (900x1100–2600); dialogs and the viewport-tall `HoldingAreaUnavailable` empty state are `single` + viewport. All in `config.json` `overrides`.
- Native `<dialog>` components (`FyDetailDialog`, `RecordDividendDialog`) are opened in the preview with `useRef` + `useEffect(() => ref.current?.show())` (non-modal, renders inline).
- `HoldingPriceChart` and `HoldingDetailScreen` fetch `/api/...` on mount; with no server they settle into the real "could not be loaded" state — an expected story, not a broken cell. `RecordDividendDialog` fetches shares-at-date only when security + payment date are set without shares; prefilled stories pass `initialSharesDecimal`.
- Day/Week price ranges intentionally render no calendar x-axis row (sub-day time axis). Day fixtures need `marketTimezone` + `observedAt` inside market hours.
- `CapitalGainsScreen` recomputes the carry chain from `fyTotals` with the real domain functions: fixtures must be internally consistent and use `fyLabel()`'s `FY26` label format.
- Emitted `.d.ts` gaps: `inspection`, `rows`, `state`, `holding`, `projection` are `unknown` or drop `| null` (types >240 chars fall back). Candidates for `dtsPropsFor` if the design agent misuses them: `OwnedPortfolioDetails.inspection: PortfolioInspection | null`, `HoldingTransactionsScreen.rows: readonly OwnedHoldingTransactionRow[]`, `HoldingDetailScreen.holding: OwnedHoldingRow | null`, `IncomeLanding.projection: OwnedIncomeProjection`. Previews use `Parameters<typeof X>[0]["prop"]` or `null as never` where the contract is narrower than the source.
- `AreaExitBackControl` reads sessionStorage `yieldtome:last-primary-tab`; empty in capture, so the href is the fallback. The two back controls render identical glyphs by design.

## Known render warns

- `[FONT_MISSING]` Inter / Geist / SF Pro Text / Iowan Old Style / Palatino — accepted (see Fonts).
- `[RENDER_BLANK]` on `AreaExitBackControl`, `BrandMark`, `HistoryBackControl` before authoring — icon-sized components; cleared by authored previews.
- `[RENDER_THIN] HoldingPriceChart: variants render identically` — benign: both authored cells are the real fetch-failure state (no API behind the preview host); the populated chart is covered by `PriceHistoryChartView`/`ChartBody`.
- `[GRID_OVERFLOW]` fired once for the nav/brand/import-summary previews; resolved with `cardMode: column` overrides (in config).

## Re-sync risks

- `.design-sync/pkg/types/` and the barrel are regenerated by buildCmd; if `app/components` gains a file, it is auto-included (and lands in `general` until a `docs/<Name>.md` category stub exists). If a component gains a new Next/Node import, the bundle fails to resolve until a shim + `tsconfig.json` path entry is added.
- The compiled CSS is Tailwind v4 output; a Tailwind upgrade changes preflight/theme bytes and will re-key every render hash (full re-verify) without any visual change.
- Fixtures in `previews/*.tsx` mirror the source types by shape, not by import (previews can only import from `yieldtome-ui`). A renamed/added required field in `OwnedHoldingRow`, `PortfolioInspection`, `OwnedIncomeProjection`, `SinglePreview`, `UploadBatch`, or the capital-gains FY types breaks the preview compile (`! preview build failed`) or renders a degraded state silently — re-read those sheets after domain changes.
- Previews depend on the AppCanvas provider; removing `cfg.provider` reverts every card to cream-on-white.
- `HoldingPriceChart`/`HoldingDetailScreen`/`RecordDividendDialog` fetch on mount; a 15s fetch timeout would appear as a hang in capture if the host ever stops failing fast.
- Fonts: system substitutes by owner decision; if the app starts shipping Inter, set `extraFonts` and drop the Known render warn.
- Verified with Node 26.5, playwright 1.62.1 / chromium_headless_shell-1234, esbuild 0.28.2, ts-morph latest at 2026-09-04.
