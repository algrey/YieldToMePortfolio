/** UI-049 (owner-reported): a fresh installation with zero portfolios used
 * to hit a dead-end "Create a portfolio first" page at `/import`, blocking
 * the full-system restore panel (EXP-002/EXP-003) that renders on the same
 * page and whose documented purpose is restoring onto exactly this
 * zero-portfolio fresh-deployment state. This pins:
 *   1. `app/import/page.tsx` no longer returns the zero-portfolio dead end --
 *      it always renders `ImportReview` for a ready/empty workspace.
 *   2. `ImportReview` degrades the CSV-import section honestly (no file/
 *      target controls that can only end in the server's "Choose a target
 *      portfolio." rejection) when `portfolios` is empty, while the
 *      full-system restore section (`SystemBackupPanel`) stays fully
 *      reachable.
 *   3. Zero-portfolio edge paths (`loadOwnedSharesightLinks` with an empty
 *      id list, `portfolios[0]`/`portfolios.map` inside `ImportReview`) do
 *      not crash. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { DatabaseSync } from "node:sqlite";
import { loadOwnedSharesightLinks } from "../app/owned-sharesight-links.ts";

const PAGE_PATH = "../app/import/page.tsx";
const IMPORT_REVIEW_PATH = "../app/components/import-review.tsx";

// ---------------------------------------------------------------------------
// Source-level pin: the page's zero-portfolio guard is gone.
// ---------------------------------------------------------------------------

test("UI-049: app/import/page.tsx no longer dead-ends when workspace.portfolios is empty", async () => {
  const source = await readFile(new URL(PAGE_PATH, import.meta.url), "utf8");
  assert.doesNotMatch(source, /workspace\.portfolios\.length === 0/);
  // No actual JSX/markup still renders the old dead-end heading -- only a
  // header comment (this test's own concern) may mention it as history.
  assert.doesNotMatch(source, /<h1>Create a portfolio first<\/h1>/);
  assert.doesNotMatch(
    source,
    /No private portfolio is available to receive this import\./,
  );
  // The workspace-unavailable degraded branch (a genuinely different state --
  // auth/D1 failure, not "zero portfolios") must remain untouched.
  assert.match(
    source,
    /workspace\.status !== "ready" && workspace\.status !== "empty"/,
  );
  assert.match(source, /Import is unavailable/);
});

// ---------------------------------------------------------------------------
// Rendered markup: ImportReview with zero portfolios.
// ---------------------------------------------------------------------------

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

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(${componentName}, props),
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

test("UI-049: ImportReview with zero portfolios renders without the dead-end copy and keeps the full-system restore panel reachable", () => {
  const html = renderComponent("ImportReview", IMPORT_REVIEW_PATH, {
    portfolios: [],
    sharesightLinks: {},
  });
  assert.doesNotMatch(html, /Create a portfolio first/);
  assert.match(html, /id="system-backup"/);
  assert.match(html, /Full-system backup \(export \/ restore\)/);
});

test("UI-049: ImportReview with zero portfolios shows a text explanation in the CSV section and hides the file/target upload controls", () => {
  const html = renderComponent("ImportReview", IMPORT_REVIEW_PATH, {
    portfolios: [],
    sharesightLinks: {},
  });
  assert.match(html, /A portfolio is needed to receive a CSV import/);
  assert.match(html, /href="#system-backup"/);
  assert.doesNotMatch(html, /Portfolio transactions \(CSV\)/);
  assert.doesNotMatch(html, /Choose CSV file/);
  assert.doesNotMatch(html, /Create review preview/);
});

test("UI-049: ImportReview with at least one portfolio still renders the normal CSV upload form (no regression for the non-empty case)", () => {
  const html = renderComponent("ImportReview", IMPORT_REVIEW_PATH, {
    portfolios: [{ id: "portfolio-a", name: "Main", homeCurrencyCode: "AUD" }],
    sharesightLinks: {},
  });
  assert.match(html, /Portfolio transactions \(CSV\)/);
  assert.match(html, /Choose CSV file/);
  assert.doesNotMatch(html, /A portfolio is needed to receive a CSV import/);
});

// ---------------------------------------------------------------------------
// loadOwnedSharesightLinks with an empty portfolio id list must not crash and
// must return an empty map (never throw on a fresh, zero-portfolio owner).
// ---------------------------------------------------------------------------

test("UI-049: loadOwnedSharesightLinks resolves to an empty map for an empty portfolio id list, without crashing", async () => {
  const database = new DatabaseSync(":memory:");
  const client = createSqliteSqlClient(database);
  const links = await loadOwnedSharesightLinks(client, "user-a", []);
  assert.deepEqual(links, {});
});
