// PRF-014 step 2c: the zero-hook/state/effect/browser-API leaves that used
// to live inline in `portfolio-shell.tsx` (`"use client"`) now live in this
// plain (non "use client") sibling module -- the same PRF-014 step 2a
// precedent `portfolio-shell-model.ts` established for pure DTO
// types/helpers, extended here to components that render JSX but hold no
// client-only state of their own. `portfolio-shell.tsx` imports these back
// (re-exporting `ToneValue`/`EmptyState` under their original names, since
// `preview-shell.tsx` and this task's own tests already import them `from
// "./portfolio-shell"`) so the composition is unchanged.
//
// Honesty note (see TASKS.md's PRF-014 step-2 scoping, sub-task 2c):
// `portfolio-shell.tsx` is STILL "use client" today (that split is step
// 2e's job), and everything transitively imported from a "use client"
// entry point -- this module included -- is bundled into the SAME client
// chunk regardless of whether the importED file itself carries the
// directive. Moving these components out of the "use client" file changes
// NOTHING about what ships in today's production client bundle (expect
// dist/client's `portfolio-shell-*.js` byte count to be materially
// unchanged by this step); the point is to make each of them independently
// safe to render from an actual Server Component once step 2e gives
// `portfolio-shell.tsx`'s chrome a real server/client split. Two of these
// components used to hold a bare callback prop (`HoldingsSummaryFooterRow`'s
// `onToggleHideSold`, `OwnedWorkspaceScreen`'s `onCreatePortfolio`) -- a
// plain closure cannot cross a real server/client boundary the way an
// already-rendered client element can, so both call sites now build the
// interactive piece themselves (still client-side, in `portfolio-shell.tsx`)
// and hand down a finished `ReactNode` instead. Rendered HTML is
// byte-identical either way.
import type { MouseEvent, ReactNode } from "react";
import { type Tone } from "../prototype-data";
import { BrandMark } from "./brand-mark";
import { AccountLifecycleRecovery } from "./account-lifecycle-recovery";
import { AccountLifecycleControls } from "./account-lifecycle-controls";
import {
  ownedHoldingAmountWhole,
  ownedHoldingHiddenSoldDisclosureText,
  ownedHoldingPercent,
  ownedHoldingSplitLeadingSign,
  ownedHoldingToneFromDecimal,
} from "../owned-holding-format";
import type { HoldingsSummaryFooter } from "../owned-holdings-summary.ts";
import { currencyDisplayPrefix } from "../currency-display.ts";
import { formatDayMonth } from "../date-display.ts";
import { type PortfolioSection } from "../portfolio-sections";
import { type OwnedWorkspace } from "./portfolio-shell-model";

// PRF-014 step 2b: exported -- shared with preview-shell.tsx (see that
// file's own header comment for why it stays a separate, reusable
// component rather than a fork). PRF-014 step 2c: moved here (zero hooks)
// from portfolio-shell.tsx, which now re-exports it under the same name.
export function ToneValue({
  children,
  tone,
  className = "",
}: {
  children: React.ReactNode;
  tone: Tone;
  className?: string;
}) {
  return <span className={`tone-${tone} ${className}`}>{children}</span>;
}

// PRF-014 step 2b: `EmptyState` stays shared with the OWNED screens' own
// empty states (OwnedHoldingsScreen, OwnedOverviewScreen, OwnedWorkspaceScreen)
// as well as preview-shell.tsx's prototype screens -- `StatusBanner` moved
// to `preview-shell.tsx` instead: its pre-2b render call site was
// UNCONDITIONAL (not gated by `ownedMode`); it was inert in owned mode only
// because the only caller that could move `viewState` OFF "populated" lived
// inside the `!ownedMode`-gated prototype-state popover (the banner's own
// `onReset` only resets TO "populated" and is reachable only once a banner
// shows), so `viewState` stayed "populated" in owned mode and `StatusBanner`
// returned null -- never a visible banner from any owned screen.
// PRF-014 step 2c: moved here (zero hooks) from portfolio-shell.tsx, which
// now re-exports it under the same name -- this also removes a circular
// module import `OwnedWorkspaceScreen` (below, also moved here) would
// otherwise create, since it is EmptyState's only caller with a real
// `onClick` (see that function's own comment).
export function EmptyState({
  title = "No holdings yet",
  message = "Add a quote or import transactions to start this portfolio.",
  action,
}: {
  title?: string;
  message?: string;
  // UI-021 (owner-reported): every empty state used to offer nothing
  // actionable at all -- this optional slot lets a specific call site (only
  // the "no portfolios yet" state, so far) supply a real, wired action.
  // Review B2 (correction): the OLD `showAction`/"Preview add menu" slot had
  // no `onClick` at all -- it was always inert, never wired to anything --
  // but it DID render at every call site that omitted the prop (its
  // default was `true`): the owned-mode `OwnedHoldingsScreen` empty state,
  // plus the prototype `OverviewScreen`, `HoldingsScreen`, `QuotesScreen`,
  // and `DetailsScreen` empty states (five call sites in total; only the
  // four call sites that explicitly passed `showAction={false}` suppressed
  // it). Its removal here is an intentional, orchestrator-approved cleanup
  // of that dead placeholder everywhere, not a claim that no call site was
  // affected.
  action?: {
    label: string;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    // Review B1 (BLOCKING): every other mutating control in this shell is
    // disabled while a mutation is in flight or the shell is offline
    // (`actionPending || !isOnline` -- see the portfolio dialog's own
    // Save/Cancel buttons). This action button had no such gate, so an
    // offline click could open the create dialog while every OTHER control
    // in this shell already treats offline as blocking -- Save/Cancel both
    // disabled, `submitPortfolioAction` early-returns on `!isOnline`
    // silently, leaving Escape as the only way out. Optional so a future
    // action-bearing call site that has no such state to report can omit it.
    disabled?: boolean;
  };
}) {
  return (
    <section className="empty-state" aria-labelledby="empty-title">
      <span className="empty-mark" aria-hidden="true">
        <BrandMark />
      </span>
      <p className="eyebrow">Empty state</p>
      <h2 id="empty-title">{title}</h2>
      <p>{message}</p>
      {action ? (
        <button
          type="button"
          className="empty-state-primary-action"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </button>
      ) : null}
    </section>
  );
}

// UI-031 (owner directive, verbatim): "Holdings should have a summary
// row ... four lines ... static at the bottom of the page (as in the
// holdings scroll past it) but may later change my mind to have it first
// or last." A DELIBERATELY placement-agnostic, pure presentational
// component -- it takes already-composed data (`app/owned-holdings-
// summary.ts`'s `buildHoldingsSummaryFooter`) and knows nothing about
// where its caller puts it; the ONLY thing pinning it to the bottom of
// the holdings scroll flow is the `.holdings-summary-footer` CSS class
// (`app/globals.css`, `position: sticky; bottom: ...`). Moving it first
// or last later is a JSX reorder at the ONE call site above, nothing in
// this component or its CSS class needs to change.
// UI-031B (Orchestrator ruling): when a line's figure is a genuinely
// partial/incomplete sum, the figure itself keeps its honest "available"
// (partial) state -- never a fifth visible summary line -- and the full
// exclusion explanation compresses to accessible text (sr-only for
// screen readers, `title` for pointer/hover users) plus this minimal
// visible "partial" marker rendered INSIDE the affected cell, in the same
// row-tertiary type the rest of the footer's micro-text uses. `null`
// (no qualifier) renders nothing at all.
// Review fold: some qualifiers already begin "partial -- " (e.g. the
// All Time / Realised qualifiers `buildHoldingsSummaryFooter` composes),
// others don't (the plain value/daily exclusion sentences) -- the sr-only
// text below supplies exactly ONE "partial -- " prefix regardless of
// which shape `text` arrives in, so it never stutters "partial --
// partial -- excludes...".
function partialDetail(text: string): string {
  return text.startsWith("partial -- ")
    ? text.slice("partial -- ".length)
    : text;
}
function PartialMarker({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="row-tertiary partial-marker" title={text}>
      {" "}
      partial
      <span className="sr-only"> -- {partialDetail(text)}</span>
    </span>
  );
}

function HoldingsSummaryFooterRow({
  summary,
  homeCurrencyCode,
  hideSold,
  hiddenSoldCount,
  hideSoldToggle,
}: {
  summary: HoldingsSummaryFooter;
  homeCurrencyCode: string;
  /** UI-040: display state only -- never derived from or fed back into
   * `summary`, so the footer's own totals below are BYTE-UNCHANGED
   * regardless of this value (they still include sold history). */
  hideSold: boolean;
  /** Count of fully-sold rows a `true` `hideSold` would remove -- feeds
   * ONLY the sr-only live region (owner ruling: never visible text, and
   * review B3: no `title`/hover disclosure either -- a hover tooltip is
   * still visible text). */
  hiddenSoldCount: number;
  /** PRF-014 step 2c: was `onToggleHideSold: () => void` -- inverted into
   * an already-rendered `HideSoldToggle` element (portfolio-shell-
   * client-leaves.tsx) that the caller (`OwnedHoldingsScreen`, which owns
   * the `hideSold` state) builds and hands down whole. This component
   * itself now holds no callback prop at all. See that leaf's own header
   * comment for the full rationale. */
  hideSoldToggle: ReactNode;
}) {
  // UI-030's own tone rule (a plain decimal string's sign), reused
  // verbatim rather than re-implemented -- "unavailable" figures stay
  // neutral (no colour claim about a number that isn't shown).
  const toneOf = (value: {
    status: "available" | "unavailable";
    value: string | null;
  }): Tone =>
    value.status === "available" && value.value !== null
      ? ownedHoldingToneFromDecimal(value.value)
      : "neutral";
  const dailyTone = toneOf(summary.dailyMovement);
  const gainTone = toneOf(summary.unrealisedGain);
  const allTimeTone = toneOf(summary.allTimeGain);
  const realisedTone = toneOf(summary.realisedGain);
  // UI-040 review (B1, BLOCKING): split ONCE per line into { sign, rest }
  // (see `ownedHoldingSplitLeadingSign`'s own doc comment for the full
  // alignment mechanism) -- computed here rather than inline in the JSX
  // below so the same split is never recomputed (and can never diverge)
  // between the sign slot and the rest of the figure.
  const allTimeSplit = ownedHoldingSplitLeadingSign(
    ownedHoldingAmountWhole(homeCurrencyCode, summary.allTimeGain, true),
  );
  const realisedSplit = ownedHoldingSplitLeadingSign(
    ownedHoldingAmountWhole(homeCurrencyCode, summary.realisedGain, true),
  );

  return (
    <div
      className="holdings-summary-footer"
      role="group"
      aria-label="Portfolio totals"
    >
      {/* UI-031B (owner directive, verbatim: "UI-031 has 6 lines not 4,
          remove the extra explanatory text"): the footer renders EXACTLY
          the four owner-specified lines below -- this base-currency
          statement (UI-032, Orchestrator ruling round 2 review fix B1)
          is a ROUTINE label under AGENTS.md's compact-view rule (it
          states the same ISO identity every render, never an action-
          required fact), so it goes sr-only rather than a fifth visible
          line: still reachable to a screen-reader user (the honesty
          guarantee AGENTS.md requires), never rendered as on-screen text.
          Per-row labels only name each HOLDING's own currency
          (`holding.currencyCode`), which is never guaranteed to equal the
          base currency (a portfolio of entirely foreign-currency holdings
          would show it nowhere) -- so the statement is restated here,
          unconditionally, wherever this summary renders. Describes the
          REAL rule instead of "every figure is base currency": `view ===
          "native"` can put a held security's own (foreign) currency on
          its row, so this names the actual bare marker via
          `currencyDisplayPrefix(homeCurrencyCode, homeCurrencyCode)`
          rather than claiming amounts render with "no prefix" --
          `currencyDisplayPrefix` NEVER returns empty (base amounts still
          get a bare $/£/€/¥, or the "CODE " fallback for a symbol-less
          code like CHF). tests/ui-032.test.ts asserts the sr-only
          presence, not visible text. */}
      <p className="sr-only">
        <strong>{homeCurrencyCode} reporting values</strong> -- amounts shown as{" "}
        <strong>
          {currencyDisplayPrefix(homeCurrencyCode, homeCurrencyCode)}
        </strong>{" "}
        are this portfolio&apos;s base currency; other currencies are flagged
        (e.g. US$).
      </p>
      <div
        className="holdings-grid summary-line"
        role="group"
        aria-label="Unrealised total value, daily gain, and total gain"
      >
        <span className="row-primary symbol">Unrealised</span>
        <span className="row-primary numeric">
          {ownedHoldingAmountWhole(homeCurrencyCode, summary.marketValue)}
          <PartialMarker text={summary.valueQualifier} />
        </span>
        <ToneValue tone={dailyTone} className="row-primary numeric">
          {ownedHoldingAmountWhole(
            homeCurrencyCode,
            summary.dailyMovement,
            true,
          )}
          <PartialMarker text={summary.dailyQualifier} />
        </ToneValue>
        <ToneValue tone={gainTone} className="row-primary numeric">
          {ownedHoldingAmountWhole(
            homeCurrencyCode,
            summary.unrealisedGain,
            true,
          )}
        </ToneValue>
      </div>
      <div
        className="holdings-grid summary-line"
        role="group"
        aria-label="Cost basis, daily percent, and total percent"
      >
        <span className="row-secondary" aria-hidden="true" />
        <span className="row-secondary numeric">
          {ownedHoldingAmountWhole(homeCurrencyCode, summary.costBasis)}
        </span>
        <ToneValue tone={dailyTone} className="row-secondary numeric">
          {ownedHoldingPercent(summary.dailyPercent, true)}
        </ToneValue>
        <ToneValue tone={gainTone} className="row-secondary numeric">
          {ownedHoldingPercent(summary.totalPercent, true)}
        </ToneValue>
      </div>
      {/* UI-040 (owner directive, verbatim, 2026-08-25): "We move the
          values to the left side (ie just after the text, though I would
          like the dollar signs to line up), then on the right side in the
          same row have a Hide Sold button ... It should not cause the
          summary row to grow in vertical size." The two lines below stay
          NORMAL in-flow flex children (same line-height/gap as before, so
          `--holdings-summary-h` above is byte-unchanged) -- only the
          toggle is taken OUT of flow (`position: absolute` in
          `app/globals.css`, vertically centered across both lines), so its
          own QA-001B 44px target can exceed the ~41px two-line block's
          height without growing this wrapper at all. Alignment mechanism
          (review B1 fix -- the FULL mechanism has TWO fixed-width slots,
          not one): (1) each line's label carries the shared
          `.summary-line-label` class, fixing an identical column width
          (`min-width`, in `em`) on BOTH lines; (2) each line's SIGN
          (`ownedHoldingSplitLeadingSign`, below) renders in its own fixed
          one-character `.summary-line-sign` slot immediately after the
          label -- "+", "-"/"−", and "" (no sign) all occupy the same slot
          width, so the "$" that follows (the value's real first character
          once the sign is pulled out) lands at the identical x offset on
          both lines regardless of which of the three sign states either
          line is in. Slot (1) alone was insufficient: the sign used to
          render INLINE with the value, so its own variable (or absent)
          width shifted the "$" itself -- pre-fix a mixed +/− pair
          misaligned 2.6px and an unsigned "$0" Realised line misaligned
          9.35px, both now zero. */}
      <div className="summary-lines-lower">
        <div
          className="summary-line-combined"
          role="group"
          aria-label="All time gain"
        >
          <span className="row-primary symbol summary-line-label">
            All Time
          </span>
          <ToneValue tone={allTimeTone} className="row-primary numeric">
            <span className="summary-line-sign">{allTimeSplit.sign}</span>
            {allTimeSplit.rest} (
            {ownedHoldingPercent(summary.allTimePercent, true)})
            <PartialMarker text={summary.allTimeQualifier} />
          </ToneValue>
        </div>
        <div
          className="summary-line-combined"
          role="group"
          aria-label="Realised gain"
        >
          <span className="row-primary symbol summary-line-label">
            Realised
          </span>
          <ToneValue tone={realisedTone} className="row-primary numeric">
            <span className="summary-line-sign">{realisedSplit.sign}</span>
            {realisedSplit.rest} (
            {ownedHoldingPercent(summary.realisedPercent, true)})
            <PartialMarker text={summary.realisedQualifier} />
          </ToneValue>
        </div>
        {/* UI-040 review (owner follow-up, verbatim: "No explanatory text
            on the screen please ... Preserving information density on the
            holding screen is very important"): the button's LABEL is the
            entire visible surface of this feature -- text-as-state
            (QA-001B non-colour signal), `aria-pressed` for assistive tech,
            44px target. No visible helper sentence, count, or disclosure
            line anywhere -- the honesty note below is sr-only ONLY, no
            `title`/hover (review B3: a hover tooltip is still visible
            text). PRF-014 step 2c: the button itself now lives in
            portfolio-shell-client-leaves.tsx's HideSoldToggle -- see this
            component's own prop comment. */}
        {hideSoldToggle}
        {/* UI-040 review fold: the live region element is ALWAYS mounted
            (never conditionally added/removed) -- only its TEXT content
            changes with `hideSold`. Assistive tech reliably announces a
            change to an EXISTING live region's content; a region that is
            itself mounted-with-content on the same render (the previous
            shape here) is not reliably announced, since there was no prior
            state for the AT to diff against. */}
        <span className="sr-only" role="status">
          {hideSold
            ? (ownedHoldingHiddenSoldDisclosureText(hiddenSoldCount) ?? "")
            : ""}
        </span>
      </div>
    </div>
  );
}

// UI-025 (owner ruling 2026-08-22): "A new user should see the news in the
// news tab. There are plenty of avenues for a new user to create a
// portfolio." -- the primary News tab embeds the SAME owner news site as the
// per-holding News tab (UI-023B: app/portfolio/[portfolioId]/[section]/
// [holdingId]/news/page.tsx), whether or not a portfolio exists yet, instead
// of the generic "No portfolios yet"/"News is not connected yet" empty
// states OwnedWorkspaceScreen otherwise renders for every section. Same
// origin, same `referrerPolicy="no-referrer"` (portfolio URLs are never at
// risk here since this route carries no portfolio id at all), and the same
// Worker CSP `frame-src` allowance (worker/response-security.ts) already
// covers this one origin -- no widening required. The embed URL carries no
// portfolio/security identifiers, so it is safe to render before a
// portfolio exists.
const PRIMARY_NEWS_EMBED_URL = "https://greeninvestments.au/?embed=1";

function OwnedNewsScreen() {
  return (
    <section
      className="owned-news-embed holding-news-embed"
      aria-labelledby="owned-news-title"
    >
      <h1 id="owned-news-title" className="sr-only">
        News
      </h1>
      <iframe
        className="holding-news-frame"
        src={PRIMARY_NEWS_EMBED_URL}
        title="Green Investments news"
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      />
    </section>
  );
}

function OwnedWorkspaceScreen({
  activeSection,
  workspace,
  quotesScreen,
  createPortfolioAction,
}: {
  activeSection: PortfolioSection;
  workspace: OwnedWorkspace;
  /** PRF-014 step 2c: `OwnedWatchlistScreen` stays a "use client" component
   * in portfolio-shell.tsx (fetch/state-heavy -- 613 lines per the step-2
   * survey, well outside 2c's zero-hook scope). Moving OwnedWorkspaceScreen
   * out of that file while still calling OwnedWatchlistScreen directly
   * would create a circular module import (portfolio-shell.tsx imports
   * OwnedWorkspaceScreen from here, this file would import
   * OwnedWatchlistScreen back from portfolio-shell.tsx). The caller
   * (`PortfolioShell`) pre-builds the identical element once and hands it
   * down instead -- both "quotes" branches below render the SAME element
   * (rows/viewState/isOnline are unconditional at the call site), so one
   * slot covers both, and `isOnline` is no longer a prop of this function
   * at all (folded into this pre-built node). */
  quotesScreen: ReactNode;
  /** PRF-014 step 2c: was `onCreatePortfolio: (event) => void` +
   * `createPortfolioDisabled: boolean`. A plain closure cannot cross a
   * real server/client boundary the way an already-rendered client
   * element can, so the ONE call site that used to build
   * `<EmptyState action={{ onClick: ..., ... }}>` (the `onClick` closed
   * over the old `onCreatePortfolio`) inside
   * THIS function now happens in `PortfolioShell` (still "use client",
   * where `portfolioDialogOpenerRef`/`setPortfolioDialog`/`actionPending`/
   * `isOnline` actually live) instead, and the finished element is handed
   * down whole. Rendered HTML is byte-identical -- same `EmptyState`
   * component, same `action` shape, just built one call frame up. */
  createPortfolioAction: ReactNode;
}) {
  if (workspace.status === "unavailable") {
    return (
      <>
        <section
          className="empty-state"
          aria-labelledby="workspace-error-title"
        >
          <p className="eyebrow">Private workspace</p>
          <h1 id="workspace-error-title">Portfolio data unavailable</h1>
          <p>{workspace.message ?? "Try again shortly."}</p>
        </section>
        {workspace.lifecycle === "purged" ? (
          <section
            className="empty-state"
            aria-labelledby="lifecycle-purged-title"
          >
            <p className="eyebrow">Account lifecycle</p>
            <h2 id="lifecycle-purged-title">Account purged</h2>
            <p>
              This account has been verifiably purged. Financial ledger facts
              and portfolio details are permanently deleted.
            </p>
          </section>
        ) : workspace.lifecycle === "disabled" ||
          workspace.lifecycle === "deletion_pending" ? (
          <AccountLifecycleRecovery lifecycle={workspace.lifecycle} />
        ) : null}
      </>
    );
  }

  if (workspace.status === "empty" || workspace.activePortfolio === null) {
    // UI-025: News is the one tab that has real content with no portfolio
    // at all -- see OwnedNewsScreen's comment. WLT-001 (owner ruling,
    // 2026-08-22): the watchlist is the SECOND such tab -- it is USER-scoped
    // (see `app/owned-watchlist.ts`), not portfolio-scoped, so a brand-new
    // owner with zero portfolios can still build one. Every other tab keeps
    // the UI-021 "No portfolios yet" panel and its create-portfolio action.
    if (activeSection === "news") {
      return (
        <>
          <OwnedNewsScreen />
          <AccountLifecycleControls />
        </>
      );
    }
    if (activeSection === "quotes") {
      return (
        <>
          {quotesScreen}
          <AccountLifecycleControls />
        </>
      );
    }
    return (
      <>
        {createPortfolioAction}
        <AccountLifecycleControls />
      </>
    );
  }

  // UI-025: with an active portfolio, News also renders the real embed
  // instead of falling through to the generic per-section empty state below
  // (the "News is not connected yet" placeholder this replaces). WLT-001:
  // the watchlist does the same -- it renders in EVERY "ready" state too,
  // never the generic per-section empty panel below.
  if (activeSection === "news") {
    return <OwnedNewsScreen />;
  }
  if (activeSection === "quotes") {
    return quotesScreen;
  }

  // UI-025 review (fold), extended by WLT-001: "news" and "quotes" are both
  // excluded from these records' key type -- the early returns above mean
  // this generic per-section empty branch never actually receives either
  // section, so there is no longer a real string to write for them.
  // Narrowing the type (rather than keeping now-unreachable entries only to
  // satisfy Record<PortfolioSection, string>) means TypeScript itself -- not
  // a comment -- guarantees this branch can't silently regress into showing
  // stale, false copy for either tab.
  const titles: Record<Exclude<PortfolioSection, "news" | "quotes">, string> = {
    overview: "No holdings yet",
    holdings: "No holdings yet",
    details: "No valuation history yet",
  };
  const messages: Record<
    Exclude<PortfolioSection, "news" | "quotes">,
    string
  > = {
    overview:
      "This portfolio is ready. Holdings and valuations will appear after ledger data is added.",
    holdings: "Import or add a holding when portfolio entry is available.",
    details: "Historical valuation data will appear here when available.",
  };

  return (
    <EmptyState
      title={titles[activeSection]}
      message={messages[activeSection]}
    />
  );
}

// BUG-003: delegates to the Intl/locale-data-free `date-display.ts`
// formatter -- this fed the Overview table's own `<th scope="row">` rows,
// the exact hydration mismatch the owner's browser console reported
// (server "1 June 2026" vs. browser "1 Jun 2026"); see that module's header
// comment for the full root cause.
function overviewDate(date: string) {
  return formatDayMonth(date);
}

function OverviewFact({
  label,
  value,
  signed = false,
}: {
  label: string;
  value: string | null;
  signed?: boolean;
}) {
  const unavailable = value === null;
  const negative = value?.startsWith("−") || value?.startsWith("-");
  const positive = !negative && value?.startsWith("+");
  const zero = value !== null && /(?:^| )0\.00$/.test(value);
  return (
    <div>
      <dt>{label}</dt>
      <dd
        className={
          unavailable
            ? "muted-copy"
            : negative
              ? "tone-negative"
              : positive
                ? "tone-positive"
                : ""
        }
      >
        {unavailable
          ? "Unavailable"
          : signed && !positive && !negative && !zero
            ? `+${value}`
            : value}
      </dd>
    </div>
  );
}

export {
  HoldingsSummaryFooterRow,
  OverviewFact,
  overviewDate,
  OwnedNewsScreen,
  OwnedWorkspaceScreen,
  PartialMarker,
  partialDetail,
};
