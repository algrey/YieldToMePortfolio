import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("import commit UI carries the exact preview contract and durable outcome states", async () => {
  const [component, historyAction, commitRoute, historyRoute, detailRoute] =
    await Promise.all([
      readFile(
        new URL("../app/components/import-review.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/import-history-actions.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/import/commit/[batchId]/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/import/history/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/api/import/history/[batchId]/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

  assert.match(component, /expectedPreviewVersion/);
  assert.match(component, /expectedVersion/);
  assert.match(component, /confirmation: true/);
  assert.match(component, /crypto\.randomUUID\(\)/);
  assert.match(component, /Commit is resumable/);
  assert.match(component, /It is not complete/);
  assert.match(component, /Commit complete/);
  assert.match(component, /role="status"/);
  assert.match(component, /Import history/);
  assert.match(component, /Original rows/);
  assert.match(component, /Mapping decisions/);
  assert.match(component, /Audit evidence/);
  assert.match(component, /Batch timestamps and durable evidence/);
  assert.match(component, /type="checkbox"/);
  assert.match(historyAction, /getAuthenticatedSqlContext/);
  assert.match(historyAction, /listBatches\(context\.userId\)/);
  assert.match(historyAction, /listForOwnerTarget/);
  assert.match(commitRoute, /private, no-store/);
  assert.match(historyRoute, /private, no-store/);
  assert.match(detailRoute, /private, no-store/);
});

test("import commit history stays keyboard and narrow-layout operable", async () => {
  const [component, styles] = await Promise.all([
    readFile(
      new URL("../app/components/import-review.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /button\n\s+type="button"\n\s+aria-pressed/);
  assert.match(component, /caption>[\s\S]*Immutable source rows/);
  assert.match(component, /summary>Batch timestamps/);
  assert.match(styles, /\.import-history-table-wrap[\s\S]*overflow-x: auto/);
  assert.match(styles, /\.import-history-list button[\s\S]*min-height: 58px/);
  assert.match(styles, /\.import-commit-panel > button[\s\S]*min-height: 44px/);
  assert.match(styles, /:focus-visible[\s\S]*outline: 2px solid/);
});
