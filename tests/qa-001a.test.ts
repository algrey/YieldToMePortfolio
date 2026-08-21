import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { rejectCrossSiteMutation } from "../app/mutation-request.ts";

// QA-001A: these seven mutation endpoints were found during the security
// audit to be missing the AUTH-004 same-origin/CSRF gate applied everywhere
// else in the app (manual ledger, import commit/reverse, market-data
// overrides/refresh, account lifecycle/export). A forged cross-site form or
// fetch could otherwise ride an authenticated Cloudflare Access session
// cookie to create/rename/archive/restore a portfolio, change home-currency
// or holding-currency-view settings, or start/steer an import — all without
// the victim's consent. Each route now calls rejectCrossSiteMutation(request)
// before doing any other work.
//
// The route modules transitively import extension-less specifiers that only
// vinext's bundler resolves (not Node's strict ESM loader used by
// `node --test`), so — consistent with the existing CSRF coverage pattern in
// tests/ops-003a.test.ts and tests/ops-003b.test.ts — this file verifies the
// shared guard's behaviour directly and confirms each fixed route's source
// wires it in before any body read or authenticated work.

const CROSS_SITE_REQUEST = (url: string, method: string) =>
  new Request(url, {
    method,
    headers: {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify({}),
  });

test("QA-001A: rejectCrossSiteMutation blocks cross-site origin/Sec-Fetch-Site combinations for every fixed route's URL shape", () => {
  const urls = [
    "https://app.example/api/portfolios",
    "https://app.example/api/portfolios/portfolio-a",
    "https://app.example/api/portfolios/portfolio-a/restore",
    "https://app.example/api/settings/holding-currency-view",
    "https://app.example/api/settings/home-currency",
    "https://app.example/api/settings/financial-year",
    "https://app.example/api/settings/price-source-preference",
    "https://app.example/api/import/preview",
    "https://app.example/api/import/preview/batch-a/mappings",
  ];
  for (const url of urls) {
    const response = rejectCrossSiteMutation(CROSS_SITE_REQUEST(url, "POST"));
    assert.equal(response?.status, 403);
    assert.equal(response?.headers.get("cache-control"), "private, no-store");
  }
});

test("QA-001A: rejectCrossSiteMutation allows a same-origin request with no Origin header (native form/fetch)", () => {
  const response = rejectCrossSiteMutation(
    new Request("https://app.example/api/portfolios", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    }),
  );
  assert.equal(response, null);
});

test("QA-001A: fixed routes call rejectCrossSiteMutation before any other work", async () => {
  const fixedRoutes = [
    "../app/api/portfolios/route.ts",
    "../app/api/portfolios/[portfolioId]/route.ts",
    "../app/api/portfolios/[portfolioId]/restore/route.ts",
    "../app/api/settings/holding-currency-view/route.ts",
    "../app/api/settings/home-currency/route.ts",
    "../app/api/settings/financial-year/route.ts",
    "../app/api/settings/price-source-preference/route.ts",
    "../app/api/import/preview/route.ts",
    "../app/api/import/preview/[batchId]/mappings/route.ts",
  ];

  for (const route of fixedRoutes) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(
      source,
      /import \{ rejectCrossSiteMutation \} from ".*mutation-request";/,
      `${route} must import rejectCrossSiteMutation`,
    );
    const csrfIndex = source.indexOf("rejectCrossSiteMutation(request)");
    assert.ok(
      csrfIndex >= 0,
      `${route} must call rejectCrossSiteMutation(request)`,
    );
    const bodyReadCandidates = ["request.json(", "request.formData("]
      .map((needle) => source.indexOf(needle))
      .filter((index) => index >= 0);
    const bodyReadIndex =
      bodyReadCandidates.length > 0
        ? Math.min(...bodyReadCandidates)
        : Infinity;
    assert.ok(
      csrfIndex < bodyReadIndex,
      `${route} must reject cross-site mutations before reading the request body`,
    );
  }
});
