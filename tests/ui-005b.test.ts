import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("import review exposes an authenticated, non-mutating preview workflow", async () => {
  const [action, component, page, previewRoute, mappingRoute] =
    await Promise.all([
      readFile(new URL("../app/import-actions.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../app/components/import-review.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/import/page.tsx", import.meta.url), "utf8"),
      readFile(
        new URL("../app/api/import/preview/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/api/import/preview/[batchId]/mappings/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

  assert.match(action, /getAuthenticatedSqlContext/);
  assert.match(action, /buildImportReviewPreview/);
  assert.match(action, /expectedPreviewVersion/);
  assert.doesNotMatch(action, /commitImportAction|commitLedgerAction/);
  assert.match(component, /CSV file/);
  assert.match(component, /Target portfolio/);
  assert.match(component, /Server-issued preview/);
  assert.match(component, /Review only/);
  assert.match(component, /role="alert"/);
  assert.match(component, /expectedPreviewVersion/);
  assert.match(page, /force-dynamic/);
  assert.match(previewRoute, /private, no-store/);
  assert.match(mappingRoute, /private, no-store/);
  assert.match(action, /mapping service is temporarily unavailable/);
});

test("import review controls keep mapping and issue content operable on mobile", async () => {
  const [component, styles] = await Promise.all([
    readFile(
      new URL("../app/components/import-review.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /name="targetId"/);
  assert.match(component, /name="sourceKey"/);
  assert.match(component, /aria-labelledby="issues-title"/);
  assert.match(styles, /\.import-counts[\s\S]*grid-template-columns: 1fr 1fr/);
  assert.match(styles, /\.import-upload-form input[\s\S]*min-height: 44px/);
  assert.match(styles, /:focus-visible[\s\S]*outline: 2px solid/);
});
