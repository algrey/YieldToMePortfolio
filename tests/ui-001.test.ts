import assert from "node:assert/strict";
import test from "node:test";
import { createOwnedWorkspace } from "../app/owned-workspace.ts";
import type { OwnedPortfolioRecord } from "../db/repositories/owned-portfolios.ts";

const user = {
  id: "user-1",
  status: "active" as const,
  displayName: null,
  primaryEmail: "owner@example.com",
  locale: "en-AU",
  timezone: "Australia/Sydney",
  identity: {
    provider: "cloudflare_access" as const,
    issuer: "https://example.cloudflareaccess.com",
    subject: "ui-001-user",
    status: "active" as const,
  },
};

const portfolio: OwnedPortfolioRecord = {
  id: "owned-1",
  userId: user.id,
  code: "OWNED",
  name: "Private portfolio",
  baseCurrencyCode: "AUD",
  timezone: "Australia/Sydney",
  accountingMethod: "fifo",
  historyCompleteFrom: null,
  status: "active",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  version: 1,
  homeCurrencyCode: "AUD",
};

test("owned workspace projection exposes only supplied owned portfolio records", () => {
  const workspace = createOwnedWorkspace(
    { ok: true, context: { user, activePortfolio: portfolio } },
    [portfolio],
  );
  assert.equal(workspace.status, "ready");
  assert.equal(workspace.activePortfolio?.name, "Private portfolio");
  assert.deepEqual(
    workspace.portfolios.map(({ name }) => name),
    ["Private portfolio"],
  );
  assert.doesNotMatch(JSON.stringify(workspace), /mock|A\$1,695,575/);
});

test("owned workspace projection has an honest empty state", () => {
  const workspace = createOwnedWorkspace({
    ok: true,
    context: { user, activePortfolio: null },
  });
  assert.equal(workspace.status, "empty");
  assert.equal(workspace.activePortfolio, null);
  assert.deepEqual(workspace.portfolios, []);
});
