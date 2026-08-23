/** UI-037 — Back control on the manual ledger entry page (owner-reported
 * orphan). `/portfolio/:id/ledger/new` is reachable from the Details screen,
 * an empty-state prose link, AND the top bar's "+" menu on every primary
 * tab, so the back control goes BACK in browser history rather than to one
 * hard-coded parent; a direct/deep-linked arrival (or a no-JS/modified
 * click) falls back to the Details page via a real href. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

function renderBackControl(): string {
  const componentUrl = new URL(
    "../app/components/back-control.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
    import { HistoryBackControl } from ${JSON.stringify(componentUrl)};
    const routerStub = {
      push() {},
      replace() {},
      back() {},
      forward() {},
      refresh() {},
      prefetch() {},
    };
    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(HistoryBackControl, {
            fallbackHref: "/portfolio/pa/details",
            label: "Back",
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

test("UI-037: HistoryBackControl renders a real fallback href, the shared .subnav-back styling, and an accessible label", () => {
  const html = renderBackControl();
  assert.match(html, /<a class="subnav-back"/);
  assert.match(html, /href="\/portfolio\/pa\/details"/);
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /<svg viewBox="0 0 24 24" aria-hidden="true"/);
});

test("UI-037: the control goes back in history only for an unmodified primary click on a tab that has history; otherwise the real href/fallback wins", async () => {
  const source = await readFile(
    new URL("../app/components/back-control.tsx", import.meta.url),
    "utf8",
  );
  // Modified/non-primary clicks return BEFORE preventDefault so the
  // browser's own open-in-new-tab gesture uses the fallback href (the
  // UI-016 Link-guard convention).
  const guardIndex = source.indexOf("event.button !== 0");
  const preventIndex = source.indexOf("event.preventDefault()");
  assert.ok(guardIndex > -1 && preventIndex > -1 && guardIndex < preventIndex);
  assert.match(source, /event\.metaKey/);
  assert.match(source, /event\.ctrlKey/);
  assert.match(source, /event\.shiftKey/);
  assert.match(source, /event\.altKey/);
  // history-back only when this tab has actually navigated; a fresh tab
  // (history.length === 1) routes to the fallback instead of a no-op.
  assert.match(source, /window\.history\.length > 1/);
  assert.match(source, /router\.back\(\)/);
  assert.match(source, /router\.push\(fallbackHref\)/);
});

test("UI-037: the manual ledger page and its degraded states all render the back control with the Details fallback; the old text link is gone", async () => {
  const [entry, page] = await Promise.all([
    readFile(
      new URL("../app/components/manual-ledger-entry.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/ledger/new/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(entry, /<HistoryBackControl/);
  assert.match(
    entry,
    /fallbackHref=\{`\/portfolio\/\$\{portfolioId\}\/details`\}/,
  );
  // Every degraded state keeps a way out too (workspace unavailable +
  // both options-unavailable branches).
  const pageControls = page.match(/<HistoryBackControl/g) ?? [];
  assert.equal(pageControls.length, 3);
  for (const source of [entry, page]) {
    assert.doesNotMatch(source, /Return to portfolio details/);
  }
});
