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
  // UI-048: relabelled "CSV file" -> "Portfolio transactions (CSV)" for
  // clarity against the price-history/backup CSV areas elsewhere on the
  // page (owner-reported naming ambiguity).
  assert.match(component, /Portfolio transactions \(CSV\)/);
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
  assert.match(component, /name="targetValue"/);
  assert.match(component, /aria-labelledby="issues-title"/);
  assert.match(component, /aria-labelledby="mappings-title"/);
  assert.match(styles, /\.import-counts[\s\S]*grid-template-columns: 1fr 1fr/);
  assert.match(styles, /\.import-upload-form input[\s\S]*min-height: 44px/);
  assert.match(styles, /:focus-visible[\s\S]*outline: 2px solid/);
});

// UI-048 (owner-reported): the ledger-CSV file input used to render as the
// browser's own default file-input chrome. It is now a visually hidden
// native `<input type="file">` (`.file-picker-input`) plus a sibling
// button-look span (`.file-picker-button`), both wrapped in a `<label>` so
// the association stays programmatic (no separate `htmlFor`/`id` needed) --
// see `.file-picker`/`.file-picker-button`/`.file-picker-input` in
// globals.css for the shared shape reused by the price-history and backup
// file inputs too.
test("UI-048: the ledger-CSV file input uses the app's button-styled file-picker pattern, not the browser's default file-input chrome", async () => {
  const [component, styles] = await Promise.all([
    readFile(
      new URL("../app/components/import-review.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  const labelBlock = component.match(
    /Portfolio transactions \(CSV\)[\s\S]*?<\/label>/,
  )?.[0];
  assert.ok(labelBlock, "expected the ledger-CSV label block");
  assert.match(labelBlock!, /className="file-picker"/);
  assert.match(labelBlock!, /className="file-picker-input"/);
  assert.match(labelBlock!, /className="file-picker-button"/);
  assert.match(labelBlock!, /type="file"/);
  // One-line format hint, per the density ruling.
  assert.match(
    component,
    /Trade rows, plus optional dividend rows \(17- or 18-column CSV\)\./,
  );

  assert.match(
    styles,
    /input\[type="file"\]\.file-picker-input[\s\S]*?clip: rect\(0, 0, 0, 0\)/,
  );
  assert.match(
    styles,
    /\.file-picker-input:focus-visible \+ \.file-picker-button[\s\S]*?outline: 2px solid/,
  );
});

test("import review can resolve pending mappings, reach readiness, and confirm commit", async () => {
  const [action, readyService, component, readyRoute] = await Promise.all([
    readFile(new URL("../app/import-actions.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/import-ready-service.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/import-review.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/api/import/preview/[batchId]/ready/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(action, /markImportReadyAction/);
  assert.match(action, /markImportReadyWithContext/);
  assert.match(readyService, /transitionStatus/);
  assert.match(readyService, /preview\.ready/);
  assert.doesNotMatch(action, /commitImportAction|commitLedgerAction/);
  assert.match(readyRoute, /createImportReadyPost/);
  assert.match(readyRoute, /markImportReadyAction/);

  assert.match(component, /Mark import ready/);
  assert.match(component, /FX direction/);
  assert.match(component, /native_to_home/);
  assert.match(component, /home_to_native/);
  assert.match(component, /existing resolved security/);
  assert.match(
    component,
    /review\.batch\.status === "ready"[\s\S]*review\.batch\.status === "committing"/,
  );
  assert.match(component, /markReady/);
});

// IMP-004B: the brand-new-symbol verify affordance, the PORTFOLIO_MAPPING_INVALID
// resolve card, and the stale-preview "Refresh preview" affordance.
test("import review offers server-side security verification, a PORTFOLIO_MAPPING_INVALID card, and a refresh-preview affordance", async () => {
  const [service, route, verifyRoute, previewRoute, component, styles] =
    await Promise.all([
      readFile(
        new URL("../app/security-verification-service.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/security-verification-route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/api/import/preview/[batchId]/securities/verify/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/api/import/preview/[batchId]/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../app/components/import-review.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    ]);

  assert.match(service, /evaluateSecurityIdentityCandidates/);
  assert.match(service, /createOwnedSecurityVerificationRepository/);
  assert.match(service, /market_data_providers/);
  assert.match(route, /rejectCrossSiteMutation/);
  assert.match(verifyRoute, /createSecurityVerifyPost/);
  assert.match(previewRoute, /private, no-store/);

  assert.match(component, /securities\/verify/);
  assert.match(component, /Verify with market-data provider/);
  assert.match(component, /PORTFOLIO_MAPPING_INVALID/);
  assert.match(component, /Refresh preview/);
  assert.match(component, /isStalePreviewMessage/);
  assert.match(styles, /\.action-feedback button[\s\S]*min-height: 44px/);
});
