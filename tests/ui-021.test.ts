/** UI-021 — Empty workspace tabs need a create-portfolio path.
 *
 * Owner-reported: when no portfolio exists yet, every section tab
 * (`app/components/portfolio-shell.tsx`'s shared `EmptyState`, rendered by
 * `OwnedWorkspaceScreen` for every owned-mode section when
 * `workspace.status === "empty"`) rendered only static placeholder text --
 * no action at all. This adds a "Create a new portfolio" button below the
 * placeholder text, wired to the SAME create-portfolio dialog the header
 * dropdown's "Create portfolio" item opens (`portfolioDialogOpenerRef` +
 * `setPortfolioDialog("create")`), capturing itself (a node that survives
 * the dialog opening, unlike the dropdown item which unmounts) as the
 * opener for focus restore on close.
 *
 * Review round (two BLOCKING findings, both fixed here):
 * B1 -- the new button had no `disabled={actionPending || !isOnline}` gate,
 * unlike every other mutating control in this shell (the portfolio dialog's
 * own Save/Cancel buttons, the header dropdown's Create/Rename/Archive
 * items, etc.). Offline, the create dialog is a mouse-trap: Save AND
 * Cancel both disabled, `submitPortfolioAction` early-returns on
 * `!isOnline` silently, leaving Escape as the only way out. Fixed by
 * threading a `createPortfolioDisabled` prop down to `OwnedWorkspaceScreen`
 * and a `disabled?: boolean` field on `EmptyState`'s `action` shape.
 * B2 -- the removed `showAction`/"Preview add menu" slot's own doc comment
 * (and this file's own test comment) FALSELY claimed every real call site
 * suppressed it with `showAction={false}`. Five call sites actually
 * omitted the prop and relied on its `true` default, so it DID render
 * there: the owned-mode `OwnedHoldingsScreen` empty state, plus the
 * prototype `OverviewScreen`, `HoldingsScreen`, `QuotesScreen`, and
 * `DetailsScreen` empty states. Orchestrator ruling: removing that inert,
 * never-wired placeholder is APPROVED everywhere (it had no `onClick` at
 * all) -- only the rationale of record needed correcting, which this file
 * and the component's own comment now do.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
  const routerStub = {
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  };
`;

function renderEmptyWorkspace(activeSection: string): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    const ownedWorkspace = {
      status: "empty",
      activePortfolio: null,
      portfolios: [],
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: ${JSON.stringify(activeSection)},
            ownedWorkspace,
          }),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

// Renders an owned-mode empty state that has NO create action at all (a
// portfolio already exists, so it is not the "no portfolios yet" case) --
// `OwnedHoldingsScreen`'s own bare `<EmptyState />` (no active holdings in
// an otherwise-ready portfolio), one of the five original placeholder call
// sites named below. ("news" and, as of WLT-001 (owner ruling 2026-08-22),
// "quotes" used to be viable examples of `OwnedWorkspaceScreen`'s OWN
// generic per-section empty branch too, but both tabs now render real
// content -- the news embed, the user-scoped watchlist -- in every owned
// state, so neither reaches that generic branch any more; see
// tests/ui-025.test.ts and tests/wlt-001.test.ts.)
function renderOwnedSectionEmptyStateWithNoAction(): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    const ownedWorkspace = {
      status: "ready",
      homeCurrencyCode: "AUD",
      activePortfolio: {
        id: "portfolio-a",
        name: "Fixture Portfolio",
        homeCurrencyCode: "AUD",
        baseCurrencyCode: "AUD",
        timezone: "Australia/Sydney",
        accountingMethod: "fifo",
        status: "active",
        version: 1,
      },
      portfolios: [
        {
          id: "portfolio-a",
          name: "Fixture Portfolio",
          homeCurrencyCode: "AUD",
          status: "active",
          version: 1,
        },
      ],
      holdings: [],
      holdingsViewState: "empty",
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "holdings",
            ownedWorkspace,
          }),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

// "news" is deliberately excluded here: UI-025 (owner ruling 2026-08-22)
// made News the one tab that renders real content -- the news embed --
// instead of the "No portfolios yet" panel even in a fresh/no-portfolio
// workspace. See tests/ui-025.test.ts for its dedicated coverage. "quotes"
// is excluded for the SAME reason as of WLT-001 (owner ruling
// 2026-08-22): the watchlist is user-scoped, not portfolio-scoped, so it
// renders its own real (possibly empty) content instead of the generic
// "No portfolios yet" panel too. See tests/wlt-001.test.ts.
for (const section of ["overview", "holdings", "details"]) {
  test(`UI-021: the "no portfolios yet" empty state on the "${section}" tab renders a "Create a new portfolio" button`, () => {
    const html = renderEmptyWorkspace(section);
    assert.match(html, /No portfolios yet/);
    assert.match(
      html,
      /<button type="button" class="empty-state-primary-action">Create a new portfolio<\/button>/,
    );
  });
}

test("UI-021: the 'no portfolios yet' create-portfolio button is NOT disabled while online and idle (the shell's default state)", () => {
  const html = renderEmptyWorkspace("overview");
  assert.match(
    html,
    /<button type="button" class="empty-state-primary-action">Create a new portfolio<\/button>/,
  );
  assert.doesNotMatch(html, /class="empty-state-primary-action" disabled/);
});

test("UI-021 review B1 (BLOCKING fix): the create-portfolio button is gated by the SAME actionPending || !isOnline convention as every other mutating control in this shell (mirrors the portfolio dialog's own Cancel button, tests/qa-001b.test.ts's pinned pattern)", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  // The wiring site (inside PortfolioShell, where actionPending/isOnline
  // actually live) passes the shell's own gate down.
  assert.match(
    source,
    /createPortfolioDisabled=\{actionPending \|\| !isOnline\}/,
  );
  // OwnedWorkspaceScreen threads it straight into EmptyState's action,
  // never re-deriving or dropping it.
  assert.match(source, /createPortfolioDisabled: boolean;/);
  assert.match(
    source,
    /action=\{\{\s*\n\s*label: "Create a new portfolio",\s*\n\s*onClick: onCreatePortfolio,\s*\n\s*disabled: createPortfolioDisabled,\s*\n\s*\}\}/,
  );
  // EmptyState's button actually reads action.disabled.
  assert.match(
    source,
    /<button\s*\n\s*type="button"\s*\n\s*className="empty-state-primary-action"\s*\n\s*onClick=\{action\.onClick\}\s*\n\s*disabled=\{action\.disabled\}\s*\n\s*>/,
  );
});

test("UI-021 review B2 (correction): EmptyState never renders an action-less placeholder button -- the button only exists inside the `action ? ... : null` branch, and an empty state with no action (a portfolio already exists; this section just has no data yet) renders NO button at all inside .empty-state", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const fnMatch = source.match(/function EmptyState\(\{[\s\S]*?\n\}\n/);
  assert.ok(fnMatch, "expected to find the EmptyState function body");
  const buttonOccurrences = [...fnMatch![0]!.matchAll(/<button\b/g)];
  assert.equal(
    buttonOccurrences.length,
    1,
    "expected EmptyState to render at most one <button>, and only conditionally",
  );
  assert.match(fnMatch![0]!, /\{action \? \(\s*\n\s*<button\b/);

  // Real-input proof: a section with no create action (a portfolio already
  // exists; this specific section just has no data of its own yet) renders
  // its empty state with NO button inside it.
  const html = renderOwnedSectionEmptyStateWithNoAction();
  const emptyStateMatch = html.match(
    /<section class="empty-state"[\s\S]*?<\/section>/,
  );
  assert.ok(emptyStateMatch, "expected an empty-state section to render");
  assert.doesNotMatch(emptyStateMatch![0]!, /<button/);
});

test("UI-021: EmptyState's action slot is wired at exactly the 'no portfolios yet' call site, not the other three owned-mode call sites that explicitly suppressed the old placeholder", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const actionMatches = [...source.matchAll(/<EmptyState\b[\s\S]*?\/>/g)];
  for (const call of actionMatches) {
    assert.doesNotMatch(call[0], /showAction=/);
  }
  assert.ok(
    actionMatches.length >= 4,
    "expected multiple EmptyState call sites",
  );
  const withAction = actionMatches.filter((m) => m[0].includes("action={{"));
  assert.equal(
    withAction.length,
    1,
    "expected exactly one EmptyState call site to pass an action",
  );
  assert.match(withAction[0]![0], /label: "Create a new portfolio"/);
  assert.match(withAction[0]![0], /onClick: onCreatePortfolio/);
});

test("UI-021 review B2 (correction): the component's own doc comment accurately names all five call sites that relied on the removed placeholder's default, not a false 'every real call site suppressed it' claim", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  for (const name of [
    "OwnedHoldingsScreen",
    "OverviewScreen",
    "HoldingsScreen",
    "QuotesScreen",
    "DetailsScreen",
  ]) {
    assert.match(
      source,
      new RegExp(`EmptyState[\\s\\S]{0,900}\`${name}\``),
      `expected the EmptyState doc comment to name ${name}`,
    );
  }
  assert.match(source, /five call sites in total/);
  assert.match(source, /orchestrator-approved cleanup/);
});

test("UI-021: onCreatePortfolio opens the SAME create-portfolio dialog as the header dropdown, capturing the surviving empty-state button itself as the opener", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const match = source.match(
    /onCreatePortfolio=\{\(event\) => \{([\s\S]*?)\n {14}\}\}/,
  );
  assert.ok(
    match,
    "expected an onCreatePortfolio handler passed to OwnedWorkspaceScreen",
  );
  assert.match(
    match![1]!,
    /portfolioDialogOpenerRef\.current = event\.currentTarget;/,
  );
  assert.match(match![1]!, /setPortfolioDialog\("create"\);/);
  // OwnedWorkspaceScreen itself has no dialog state of its own -- it takes
  // the callback as a prop, one dialog shared across the whole shell.
  assert.match(
    source,
    /onCreatePortfolio: \(event: MouseEvent<HTMLButtonElement>\) => void;/,
  );
});

test("UI-021 (re-pointed for PRF-014 step 2b): preview/prototype mode never reaches OwnedWorkspaceScreen or the empty-state create action -- each prototype section keeps its own distinct, unchanged screen component", async () => {
  // PRF-014 step 2b split the old single `ownedMode`-branching PortfolioShell
  // into two components in two files: `PortfolioShell` (portfolio-shell.tsx,
  // owned-only) and `PreviewShell` (preview-shell.tsx, preview-only). The
  // guarantee this test pins is now structural (file boundaries + module
  // imports) rather than a runtime `ownedMode` branch -- see both files' own
  // header comments.
  const [shellSource, previewSource] = await Promise.all([
    readFile(
      new URL("../app/components/portfolio-shell.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/preview-shell.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  // OwnedWorkspaceScreen (the only caller of the new onCreatePortfolio prop)
  // is `PortfolioShell`'s unconditional else-branch -- always reached when no
  // more specific owned section matches.
  assert.match(
    shellSource,
    /\) : \(\s*<OwnedWorkspaceScreen[\s\S]{0,1200}\/>\s*\)\}/,
  );
  // portfolio-shell.tsx never renders (as JSX) any of the preview-only
  // screen components -- they live only in preview-shell.tsx. (Their names
  // may still appear in doc comments describing the PRF-014 step 2b move,
  // so this checks for a JSX tag, not a bare identifier.)
  for (const componentName of [
    "OverviewScreen",
    "HoldingsScreen",
    "DetailsScreen",
    "NewsScreen",
  ]) {
    assert.doesNotMatch(
      shellSource,
      new RegExp(`<${componentName}\\b`),
      `expected portfolio-shell.tsx to never render the preview-only <${componentName}>`,
    );
  }
  // Every prototype (non-owned) section still renders its own dedicated,
  // untouched screen component in PreviewShell, never OwnedWorkspaceScreen.
  assert.doesNotMatch(previewSource, /<OwnedWorkspaceScreen\b/);
  for (const [section, componentName] of [
    ["overview", "OverviewScreen"],
    ["holdings", "HoldingsScreen"],
    ["quotes", "QuotesScreen"],
    ["details", "DetailsScreen"],
    ["news", "NewsScreen"],
  ]) {
    assert.match(
      previewSource,
      new RegExp(
        `activeSection === "${section}"[\\s\\S]{0,400}<${componentName}\\b`,
      ),
      `expected the prototype "${section}" tab to still render <${componentName}>`,
    );
  }
});

test('UI-021 follow-up: .empty-state-primary-action is scoped to the new create-portfolio button, not the generic .empty-state > button rule -- so account-lifecycle-recovery.tsx\'s own direct-child .empty-state button ("Continue export processing") keeps its original, smaller size', async () => {
  const [source, styles] = await Promise.all([
    readFile(
      new URL(
        "../app/components/account-lifecycle-recovery.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  // account-lifecycle-recovery.tsx's "Continue export processing" button
  // really is a direct child of its own `.empty-state` section, with no
  // class of its own -- it would inherit ANY change to the base
  // `.empty-state > button` rule.
  assert.match(
    source,
    /<section className="empty-state" aria-labelledby="lifecycle-recovery-title">/,
  );
  assert.match(
    source,
    /<button\s*\n\s*type="button"\s*\n\s*onClick=\{\(\) => void continueProcessing\(\)\}\s*\n\s*disabled=\{pending\}\s*\n\s*>/,
  );
  const baseRule = styles.match(/\.empty-state > button \{([^}]*)\}/);
  assert.ok(baseRule, "expected the base .empty-state > button rule");
  assert.match(baseRule![1]!, /font-size:\s*0\.76rem/);
  const scopedRule = styles.match(
    /\.empty-state > button\.empty-state-primary-action \{([^}]*)\}/,
  );
  assert.ok(
    scopedRule,
    "expected a scoped .empty-state-primary-action rule, not a widened base rule",
  );
  assert.match(scopedRule![1]!, /font-size:\s*1rem/);
});
