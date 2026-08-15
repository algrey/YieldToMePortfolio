/** BRK-005B -- Sharesight sync UI wiring (import screen). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSharesightSyncStateRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import { listSharesightPortfoliosWithContext } from "../app/sharesight-sync-service.ts";
import { loadOwnedSharesightLinks } from "../app/owned-sharesight-links.ts";
import {
  formatSyncResultMessage,
  isDisabledIntegrationMessage,
  mergeSharesightLinks,
  type SharesightLinkStatus,
} from "../app/sharesight-sync-panel-helpers.ts";

const PANEL_PATH = "../app/components/sharesight-sync-panel.tsx";
const IMPORT_REVIEW_PATH = "../app/components/import-review.tsx";

// ---------------------------------------------------------------------------
// Fixture (mirrors tests/brk-005.test.ts's migratedDatabase()).
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-15', '2026-08-15', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-15', '2026-08-15', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-15', '2026-08-15', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-15', '2026-08-15', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-15', '2026-08-15', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-15', '2026-08-15', 1);
  `);
  return database;
}

// ---------------------------------------------------------------------------
// isDisabledIntegrationMessage: pinned against the REAL backend message via
// the actual service function (not just a literal-copy self-check), so a
// future wording change in `disabledIntegrationFailure`
// (`app/sharesight-sync-service.ts`) would break this test rather than
// silently desyncing the UI's inert/error disambiguation.
// ---------------------------------------------------------------------------

test("BRK-005B: isDisabledIntegrationMessage recognizes the real 'not_configured' backend message and rejects an unrelated 409 message", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const result = await listSharesightPortfoliosWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "portfolio-a",
    { integration: { enabled: false, reason: "not_configured" } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(isDisabledIntegrationMessage(result.message), true);
  }
});

test("BRK-005B: isDisabledIntegrationMessage recognizes the real 'incomplete_configuration' backend message", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const result = await listSharesightPortfoliosWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "portfolio-a",
    { integration: { enabled: false, reason: "incomplete_configuration" } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(isDisabledIntegrationMessage(result.message), true);
  }
});

test("BRK-005B: isDisabledIntegrationMessage does NOT treat an unrelated 409 (e.g. 'link first') as an inert disabled state", () => {
  assert.equal(
    isDisabledIntegrationMessage(
      "Link a Sharesight portfolio to this portfolio before syncing.",
    ),
    false,
  );
  assert.equal(
    isDisabledIntegrationMessage(
      "This portfolio has more than one enabled Sharesight link, which should never happen -- re-link before syncing.",
    ),
    false,
  );
  assert.equal(isDisabledIntegrationMessage(""), false);
});

// ---------------------------------------------------------------------------
// formatSyncResultMessage: created vs reused, singular/plural, the
// skipped-payout warning naming where to find details, and (review
// follow-up 2) the reused batch's own CURRENT status.
// ---------------------------------------------------------------------------

test("BRK-005B: formatSyncResultMessage distinguishes a newly created batch from a reused one and pluralizes rows correctly", () => {
  assert.equal(
    formatSyncResultMessage({
      ok: true,
      batchId: "batch-1",
      batchStatus: "parsed",
      rowsStaged: 1,
      skippedPayouts: 0,
      reused: false,
    }),
    "Created batch batch-1. 1 row staged.",
  );
  assert.equal(
    formatSyncResultMessage({
      ok: true,
      batchId: "batch-1",
      batchStatus: "parsed",
      rowsStaged: 5,
      skippedPayouts: 0,
      reused: true,
    }),
    "No changes since last sync -- reused batch batch-1 (status: parsed). 5 rows staged.",
  );
});

test("BRK-005B: formatSyncResultMessage surfaces a skipped-payout count with a pointer to the batch preview, singular and plural", () => {
  const one = formatSyncResultMessage({
    ok: true,
    batchId: "batch-2",
    batchStatus: "parsed",
    rowsStaged: 3,
    skippedPayouts: 1,
    reused: false,
  });
  assert.match(one, /1 future-dated payout skipped/);
  assert.match(one, /details in the batch preview/);

  const many = formatSyncResultMessage({
    ok: true,
    batchId: "batch-3",
    batchStatus: "parsed",
    rowsStaged: 3,
    skippedPayouts: 4,
    reused: false,
  });
  assert.match(many, /4 future-dated payouts skipped/);
});

test("BRK-005B: formatSyncResultMessage never mentions skipped payouts when there are none", () => {
  const message = formatSyncResultMessage({
    ok: true,
    batchId: "batch-4",
    batchStatus: "parsed",
    rowsStaged: 2,
    skippedPayouts: 0,
    reused: false,
  });
  assert.doesNotMatch(message, /skipped/);
});

test("BRK-005B follow-up 2: formatSyncResultMessage surfaces the reused batch's CURRENT status, so an already-committed batch never implies fresh pending work", () => {
  const committed = formatSyncResultMessage({
    ok: true,
    batchId: "batch-9",
    batchStatus: "committed",
    rowsStaged: 4,
    skippedPayouts: 0,
    reused: true,
  });
  assert.match(committed, /status: committed/);

  const needsMapping = formatSyncResultMessage({
    ok: true,
    batchId: "batch-9",
    batchStatus: "needs_mapping",
    rowsStaged: 4,
    skippedPayouts: 0,
    reused: true,
  });
  assert.match(needsMapping, /status: needs mapping/);

  // A freshly created batch's own message never claims a "status:" -- there
  // is no ambiguity about pending-vs-done for a batch that was just made.
  const created = formatSyncResultMessage({
    ok: true,
    batchId: "batch-10",
    batchStatus: "committed",
    rowsStaged: 4,
    skippedPayouts: 0,
    reused: false,
  });
  assert.doesNotMatch(created, /status:/);
});

// ---------------------------------------------------------------------------
// Review finding B1 (BLOCKING): a link created for one target portfolio
// must survive switching the target away and back -- `mergeSharesightLinks`
// is the exact, directly-testable merge `ImportReview` performs on every
// render from its hoisted `sharesightLinkOverrides` state (which persists
// across a target switch) over the server-seeded snapshot.
// ---------------------------------------------------------------------------

test("BRK-005B review B1 fix pin: a link created for portfolio A survives switching the target to B and back to A", () => {
  const base: Record<string, SharesightLinkStatus> = {
    "portfolio-a": { status: "not_linked" },
    "portfolio-b": { status: "not_linked" },
  };
  // "link A" -- `onLinked` writes into the persistent overrides map (this
  // is the ONLY place that map is ever written; switching targets never
  // touches it).
  let overrides: Record<string, SharesightLinkStatus> = {};
  overrides = {
    ...overrides,
    "portfolio-a": { status: "linked", sharesightPortfolioId: "sp-1" },
  };
  assert.deepEqual(mergeSharesightLinks(base, overrides)["portfolio-a"], {
    status: "linked",
    sharesightPortfolioId: "sp-1",
  });

  // "switch to B" -- SharesightSyncPanel remounts (key change) for
  // portfolio B; nothing about switching writes to `overrides`.
  assert.deepEqual(mergeSharesightLinks(base, overrides)["portfolio-b"], {
    status: "not_linked",
  });

  // "switch back to A" -- the override for A must still be present. The
  // PRE-FIX behaviour re-seeded a fresh panel purely from the panel's own
  // one-time `initialLink` prop (equivalent to reading `base` alone here)
  // and lost it; this asserts against `base` directly at the same key to
  // prove the merge -- not the stale base -- is what the panel now reads.
  const afterSwitchBack = mergeSharesightLinks(base, overrides)["portfolio-a"];
  assert.deepEqual(afterSwitchBack, {
    status: "linked",
    sharesightPortfolioId: "sp-1",
  });
  assert.notDeepEqual(afterSwitchBack, base["portfolio-a"]);
});

test("BRK-005B review B1 fix: SharesightSyncPanel owns no internal link state -- link is a fully controlled prop, so the switch-and-lose-it bug is structurally impossible", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  assert.doesNotMatch(source, /useState<LinkState>/);
  assert.doesNotMatch(source, /useState\(initialLink\)/);
  assert.doesNotMatch(source, /\bsetLink\(/);
  // Only the header comment (this test's own concern) may mention the OLD
  // prop name as history -- no actual prop destructuring/type still uses it.
  assert.doesNotMatch(source, /initialLink,\n/);
  assert.doesNotMatch(source, /initialLink: LinkState/);
  assert.match(
    source,
    /onLinked\(portfolioId, result\.sharesightPortfolioId\)/,
  );
});

test("BRK-005B review B1 fix: ImportReview hoists sharesightLinkOverrides state and merges it over the sharesightLinks prop via mergeSharesightLinks", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const \[sharesightLinkOverrides, setSharesightLinkOverrides\] = useState</,
  );
  assert.match(
    source,
    /mergeSharesightLinks\(\s*sharesightLinks,\s*sharesightLinkOverrides,?\s*\)/,
  );
  assert.match(
    source,
    /onLinked=\{\(linkedPortfolioId, sharesightPortfolioId\) =>/,
  );
  assert.match(source, /setSharesightLinkOverrides\(\(prev\) => \(\{/);
});

// ---------------------------------------------------------------------------
// loadOwnedSharesightLinks: the server-side link-status snapshot the import
// page passes down -- honest linked/not_linked, defensive against a
// pre-existing multi-enabled-row invariant violation (needs_repair, review
// follow-up 1), and owner-scoped.
// ---------------------------------------------------------------------------

async function link(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  sharesightPortfolioId: string,
) {
  const repository = createSharesightSyncStateRepository(client);
  const result = await repository.upsert(
    userId,
    portfolioId,
    sharesightPortfolioId,
    {
      enabled: true,
      lastSyncedAt: null,
      lastTradeWatermark: null,
      expectedVersion: null,
      requestId: "req-1",
    },
  );
  assert.equal(result.ok, true, "fixture link upsert must succeed");
}

test("BRK-005B: loadOwnedSharesightLinks reports not_linked for a portfolio with no Sharesight link", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const links = await loadOwnedSharesightLinks(client, "user-a", [
    "portfolio-a",
  ]);
  assert.deepEqual(links["portfolio-a"], { status: "not_linked" });
});

test("BRK-005B: loadOwnedSharesightLinks reports the linked Sharesight portfolio id when exactly one enabled link exists", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  await link(client, "user-a", "portfolio-a", "sp-42");
  const links = await loadOwnedSharesightLinks(client, "user-a", [
    "portfolio-a",
  ]);
  assert.deepEqual(links["portfolio-a"], {
    status: "linked",
    sharesightPortfolioId: "sp-42",
  });
});

test("BRK-005B follow-up 1: loadOwnedSharesightLinks reports needs_repair (never a silent guess, never a bare not_linked) if more than one enabled link is somehow present, matching the sync path's own fail-closed defense", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  // `upsert` alone (unlike `linkExclusive`) does not disable a prior link --
  // this simulates the pre-existing-invariant-violation scenario
  // `runSharesightSyncWithContext` itself defends against with a 409.
  await link(client, "user-a", "portfolio-a", "sp-1");
  await link(client, "user-a", "portfolio-a", "sp-2");
  const links = await loadOwnedSharesightLinks(client, "user-a", [
    "portfolio-a",
  ]);
  assert.deepEqual(
    links["portfolio-a"],
    { status: "needs_repair" },
    "must never non-deterministically pick one of several enabled links, and must never claim not_linked when a (broken) link actually exists",
  );
});

test("BRK-005B: loadOwnedSharesightLinks never leaks another user's link (owner-scoped)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  await link(client, "user-b", "portfolio-b", "sp-other-owner");
  const links = await loadOwnedSharesightLinks(client, "user-a", [
    "portfolio-a",
  ]);
  assert.deepEqual(links["portfolio-a"], { status: "not_linked" });
});

test("BRK-005B: loadOwnedSharesightLinks resolves multiple portfolios independently in one call", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  database.exec(`
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a2', 'user-a', 'A2', 'Second', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-15', '2026-08-15', 1);
  `);
  await link(client, "user-a", "portfolio-a", "sp-1");
  const links = await loadOwnedSharesightLinks(client, "user-a", [
    "portfolio-a",
    "portfolio-a2",
  ]);
  assert.deepEqual(links["portfolio-a"], {
    status: "linked",
    sharesightPortfolioId: "sp-1",
  });
  assert.deepEqual(links["portfolio-a2"], { status: "not_linked" });
});

// ---------------------------------------------------------------------------
// No new mutation surface: this task consumes BRK-005's three existing
// routes only -- no new page, no new route.
// ---------------------------------------------------------------------------

test("BRK-005B: exactly BRK-005's three existing sharesight-* routes exist under app/api/portfolios/[portfolioId] -- no new route was added", async () => {
  const entries = await readdir(
    new URL("../app/api/portfolios/[portfolioId]", import.meta.url),
    { withFileTypes: true },
  );
  const sharesightDirs = entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("sharesight"),
    )
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(sharesightDirs, [
    "sharesight-link",
    "sharesight-portfolios",
    "sharesight-sync",
  ]);
});

async function findFiles(
  dirUrl: URL,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    const entryUrl = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      dirUrl,
    );
    if (entry.isDirectory()) {
      matches.push(...(await findFiles(entryUrl, predicate)));
    } else if (predicate(entry.name)) {
      matches.push(entryUrl.pathname);
    }
  }
  return matches;
}

test("BRK-005B: no new page was added for Sharesight -- the import screen (app/import/page.tsx) is the only page.tsx referencing the Sharesight panel", async () => {
  const importPageSource = await readFile(
    new URL("../app/import/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(importPageSource, /loadOwnedSharesightLinks/);
  const pageFiles = await findFiles(
    new URL("../app/", import.meta.url),
    (name) => name === "page.tsx",
  );
  const referencing: string[] = [];
  for (const path of pageFiles) {
    const source = await readFile(path, "utf8");
    if (/sharesight/i.test(source)) referencing.push(path);
  }
  assert.equal(
    referencing.length,
    1,
    `expected only app/import/page.tsx to reference Sharesight, got: ${referencing.join(", ")}`,
  );
  assert.ok(referencing[0]!.endsWith("/app/import/page.tsx"));
});

// ---------------------------------------------------------------------------
// Rendered markup: linked / not-linked / needs-repair / unknown states,
// entry points, wiring through ImportReview's own selected-portfolio state.
// ---------------------------------------------------------------------------

// Round-2 follow-up 2: `SharesightSyncPanel` now calls `useRouter()`
// (for the post-link `router.refresh()`), which throws outside a mounted
// Next.js App Router -- both `SharesightSyncPanel` itself and `ImportReview`
// (which renders it) need a stub router context to render at all now.
// Mirrors `tests/qa-001b.test.ts`'s identical `ROUTER_STUB_IMPORT`.
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

test("BRK-005B: SharesightSyncPanel renders the honest 'not linked' status and no Sync button when unlinked", () => {
  const html = renderComponent("SharesightSyncPanel", PANEL_PATH, {
    portfolioId: "portfolio-a",
    link: { status: "not_linked" },
  });
  assert.match(html, /Not linked to a Sharesight portfolio\./);
  assert.match(html, /Link Sharesight portfolio/);
  assert.doesNotMatch(html, /<button[^>]*>Sync from Sharesight</);
});

test("BRK-005B: SharesightSyncPanel renders the linked portfolio id and a Sync button when linked", () => {
  const html = renderComponent("SharesightSyncPanel", PANEL_PATH, {
    portfolioId: "portfolio-a",
    link: { status: "linked", sharesightPortfolioId: "sp-99" },
  });
  assert.match(html, /Linked to Sharesight portfolio/);
  assert.match(html, /sp-99/);
  assert.match(html, /Sync from Sharesight/);
  assert.match(html, /Change linked Sharesight portfolio/);
});

test("BRK-005B follow-up 1: SharesightSyncPanel renders distinct copy for needs_repair vs unknown vs not_linked -- never the same message for three different states", () => {
  const repair = renderComponent("SharesightSyncPanel", PANEL_PATH, {
    portfolioId: "portfolio-a",
    link: { status: "needs_repair" },
  });
  assert.match(repair, /Link needs repair -- re-link\./);
  assert.doesNotMatch(repair, /<button[^>]*>Sync from Sharesight</);

  const unknown = renderComponent("SharesightSyncPanel", PANEL_PATH, {
    portfolioId: "portfolio-a",
    link: { status: "unknown" },
  });
  // Round-2 follow-up 1: gains a recovery hint -- "unavailable" alone gives
  // the owner no next step.
  assert.match(unknown, /Link status unavailable — reload to retry\./);
  assert.doesNotMatch(unknown, /<button[^>]*>Sync from Sharesight</);

  const notLinked = renderComponent("SharesightSyncPanel", PANEL_PATH, {
    portfolioId: "portfolio-a",
    link: { status: "not_linked" },
  });
  assert.match(notLinked, /Not linked to a Sharesight portfolio\./);

  const messages = new Set([
    "Link needs repair -- re-link.",
    "Link status unavailable — reload to retry.",
    "Not linked to a Sharesight portfolio.",
  ]);
  assert.equal(messages.size, 3, "sanity: the three pinned strings differ");
});

test("BRK-005B: ImportReview wires sharesightLinks through to the Sharesight panel for the initially-selected target portfolio", () => {
  const html = renderComponent("ImportReview", IMPORT_REVIEW_PATH, {
    portfolios: [{ id: "portfolio-a", name: "Main", homeCurrencyCode: "AUD" }],
    sharesightLinks: {
      "portfolio-a": { status: "linked", sharesightPortfolioId: "sp-7" },
    },
  });
  assert.match(html, /Linked to Sharesight portfolio/);
  assert.match(html, /sp-7/);
});

test("BRK-005B: ImportReview defaults to 'not linked' when no sharesightLinks prop is supplied at all", () => {
  const html = renderComponent("ImportReview", IMPORT_REVIEW_PATH, {
    portfolios: [{ id: "portfolio-a", name: "Main", homeCurrencyCode: "AUD" }],
  });
  assert.match(html, /Not linked to a Sharesight portfolio\./);
});

// ---------------------------------------------------------------------------
// Established modal dialog pattern (UI-007) + shared fetch timeout (UI-008)
// -- asserted against the component's own source, matching this codebase's
// convention for gated-by-internal-state dialogs (e.g. the refresh dialog in
// security-dividends-tab.tsx), since there is no jsdom harness to open the
// dialog and exercise its fetch/focus behavior at runtime.
// ---------------------------------------------------------------------------

test("BRK-005B: the link dialog uses ref+showModal with sheet-close focus on open and opener-restore focus on close", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(
    source,
    /dialog\.querySelector<HTMLButtonElement>\("\.sheet-close"\)\?\.focus\(\)/,
  );
  assert.match(source, /openerRef\.current\.focus\(\)/);
});

test("BRK-005B: the link dialog blocks Escape/backdrop-cancel while a link submit is pending, but the Close button and Cancel are still wired", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  const onCancelIndex = source.indexOf("onCancel={(event) => {");
  const cancelBlock = source.slice(onCancelIndex, onCancelIndex + 200);
  assert.match(cancelBlock, /event\.preventDefault\(\)/);
  assert.match(cancelBlock, /if \(linkPending\) return;/);
  assert.match(source, /className="sheet-close"/);
  assert.match(source, />\s*Cancel\s*</);
});

test("BRK-005B: every fetch in the panel uses an AbortController raced against the shared 15s timeout, with the established uncertain-retry timeout message on mutation submits", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  assert.match(source, /const DIALOG_FETCH_TIMEOUT_MS = 15_000;/);
  const abortControllerCount = (source.match(/new AbortController\(\)/g) ?? [])
    .length;
  assert.equal(
    abortControllerCount,
    3,
    "list portfolios, link, and sync each need their own bounded fetch",
  );
  const timeoutUses = (source.match(/DIALOG_FETCH_TIMEOUT_MS/g) ?? []).length;
  assert.ok(timeoutUses >= 4); // 1 declaration + at least one setTimeout per fetch
  assert.match(
    source,
    /It may still have gone through — check before retrying\./,
  );
  assert.equal((source.match(/signal: controller\.signal/g) ?? []).length, 3);
});

test("BRK-005B follow-up 3: the read-only portfolio-list GET uses distinct 'nothing to check' timeout wording, never the mutation-submit 'may still have gone through' wording", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  assert.match(
    source,
    /const DIALOG_READ_TIMEOUT_MESSAGE = "The request timed out\. Retry when ready\.";/,
  );
  const loadPortfoliosIndex = source.indexOf(
    "async function loadPortfolios() {",
  );
  const openLinkDialogIndex = source.indexOf("function openLinkDialog(event");
  assert.ok(
    loadPortfoliosIndex >= 0 && openLinkDialogIndex > loadPortfoliosIndex,
  );
  const loadPortfoliosBlock = source.slice(
    loadPortfoliosIndex,
    openLinkDialogIndex,
  );
  assert.match(loadPortfoliosBlock, /DIALOG_READ_TIMEOUT_MESSAGE/);
  assert.doesNotMatch(loadPortfoliosBlock, /may still have gone through/);

  // The link/sync mutation submits, by contrast, still use the uncertain
  // "may still have gone through" wording (they are real mutations).
  const submitLinkIndex = source.indexOf("async function submitLink(");
  const runSyncIndex = source.indexOf("async function runSync()");
  const submitLinkBlock = source.slice(submitLinkIndex, runSyncIndex);
  assert.match(submitLinkBlock, /DIALOG_TIMEOUT_MESSAGE/);
  assert.doesNotMatch(submitLinkBlock, /DIALOG_READ_TIMEOUT_MESSAGE/);
});

test("BRK-005B follow-up 4: loadPortfolios preselects the CURRENTLY linked Sharesight portfolio id when present in the returned list, instead of always defaulting to the first entry, and the option is marked in its label", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  assert.match(source, /const currentlyLinkedId =/);
  assert.match(
    source,
    /currentlyLinkedId &&\s*\n\s*result\.portfolios\.some\(\(option\) => option\.id === currentlyLinkedId\)/,
  );
  assert.match(source, /-- currently linked/);
});

test("BRK-005B round-2 follow-up 2: a successful link calls router.refresh() (converging the server-seeded snapshot) in addition to onLinked (the immediate client-side feedback layer)", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  assert.match(source, /import \{ useRouter \} from "next\/navigation";/);
  assert.match(source, /const router = useRouter\(\);/);
  const submitLinkIndex = source.indexOf("async function submitLink(");
  const runSyncIndex = source.indexOf("async function runSync()");
  const submitLinkBlock = source.slice(submitLinkIndex, runSyncIndex);
  assert.match(
    submitLinkBlock,
    /onLinked\(portfolioId, result\.sharesightPortfolioId\);/,
  );
  assert.match(submitLinkBlock, /router\.refresh\(\);/);
  // onLinked (synchronous, immediate) must be called BEFORE router.refresh()
  // (whose data lands later) -- never the other way, which would risk a
  // visible flash back to the pre-link state while the refresh is in flight.
  const onLinkedIndex = submitLinkBlock.indexOf(
    "onLinked(portfolioId, result.sharesightPortfolioId);",
  );
  const refreshIndex = submitLinkBlock.indexOf("router.refresh();");
  assert.ok(onLinkedIndex >= 0 && refreshIndex > onLinkedIndex);
  // runSync (a read of already-linked state, not a link mutation) must NOT
  // itself call refresh() -- only a genuine link change needs to converge
  // the server snapshot.
  const runSyncBlock = source.slice(runSyncIndex, source.indexOf("return (\n"));
  assert.doesNotMatch(runSyncBlock, /router\.refresh\(\)/);
});

test("BRK-005B: the panel's three fetches target exactly BRK-005's three existing routes, never a fabricated new one", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  assert.match(
    source,
    /`\/api\/portfolios\/\$\{portfolioId\}\/sharesight-portfolios`/,
  );
  assert.match(
    source,
    /`\/api\/portfolios\/\$\{portfolioId\}\/sharesight-link`/,
  );
  assert.match(
    source,
    /`\/api\/portfolios\/\$\{portfolioId\}\/sharesight-sync`/,
  );
});

test("BRK-005B: the link dialog states the single-active-link replacement semantics in its own copy", async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  assert.match(source, /replaces any previous link/);
});

test('BRK-005B: the disabled-integration state renders with role="status" (inert), never role="alert" (error tone)', async () => {
  const source = await readFile(new URL(PANEL_PATH, import.meta.url), "utf8");
  const disabledBlockIndex = source.indexOf('status === "disabled"');
  const block = source.slice(disabledBlockIndex, disabledBlockIndex + 150);
  assert.match(block, /role="status"/);
  assert.match(block, /className="sharesight-sync-inert"/);
  const syncDisabledIndex = source.indexOf("syncResult.disabled");
  assert.ok(syncDisabledIndex >= 0);
});

test("BRK-005B follow-up 6: loadReviewByBatchId targets /api/import/preview/:batchId, resets commit state, and is wired as SharesightSyncPanel's onOpenBatch", async () => {
  const source = await readFile(
    new URL(IMPORT_REVIEW_PATH, import.meta.url),
    "utf8",
  );
  const fnIndex = source.indexOf(
    "async function loadReviewByBatchId(batchId: string) {",
  );
  assert.ok(fnIndex >= 0, "expected loadReviewByBatchId to exist");
  const nextFnIndex = source.indexOf(
    "async function refreshPreview() {",
    fnIndex,
  );
  assert.ok(nextFnIndex > fnIndex);
  const block = source.slice(fnIndex, nextFnIndex);
  assert.match(block, /`\/api\/import\/preview\/\$\{batchId\}`/);
  assert.match(block, /setCommit\(null\);/);
  assert.match(block, /setCommitConfirmed\(false\);/);
  assert.match(block, /setCommitKey\(null\);/);
  assert.match(
    source,
    /onOpenBatch=\{\(batchId\) => void loadReviewByBatchId\(batchId\)\}/,
  );
});

// ---------------------------------------------------------------------------
// QA-001B accessibility: 44px touch targets, the section's own
// aria-labelledby wiring, and (review follow-up 5) the dialog's error/inert
// paragraph colours actually applying despite `.sharesight-dialog p`'s
// higher CSS specificity.
// ---------------------------------------------------------------------------

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a "${selector}" rule in globals.css`);
  return match![1];
}

test("BRK-005B: every interactive control the Sharesight panel adds meets the 44x44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".sharesight-sync-actions button",
    ".sharesight-sync-result button",
    ".sharesight-sync-error button",
    ".sharesight-portfolio-option",
  ]) {
    const block = extractBlock(styles, selector);
    assert.match(
      block,
      /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
      `${selector} must declare min-height >= 44px`,
    );
  }
});

test("BRK-005B: the Sharesight dialog fits within the 320px content-box floor (width: min(480px, calc(100vw - 32px)))", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const block = extractBlock(styles, ".sharesight-dialog");
  assert.match(block, /width:\s*min\(480px,\s*calc\(100vw - 32px\)\)/);
});

test("BRK-005B follow-up 5: .sharesight-dialog p.sharesight-sync-error/.sharesight-sync-inert are specificity-qualified so their colours actually win over the plain .sharesight-dialog p rule", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const dialogPBlock = extractBlock(styles, ".sharesight-dialog p");
  assert.match(dialogPBlock, /color:\s*var\(--muted\)/);
  const errorOverride = extractBlock(
    styles,
    ".sharesight-dialog p.sharesight-sync-error",
  );
  assert.match(errorOverride, /color:\s*var\(--warning\)/);
  const inertOverride = extractBlock(
    styles,
    ".sharesight-dialog p.sharesight-sync-inert",
  );
  assert.match(inertOverride, /color:\s*var\(--muted\)/);
  // Both qualified overrides must appear AFTER the bare `.sharesight-dialog p`
  // rule in source order -- with equal-or-higher specificity, a rule earlier
  // in the file would still lose a tie to a later one, so source order is a
  // real (if secondary) part of the fix, not incidental.
  const bareIndex = styles.indexOf(".sharesight-dialog p {");
  const errorIndex = styles.indexOf(
    ".sharesight-dialog p.sharesight-sync-error",
  );
  const inertIndex = styles.indexOf(
    ".sharesight-dialog p.sharesight-sync-inert",
  );
  assert.ok(bareIndex >= 0 && errorIndex > bareIndex && inertIndex > bareIndex);
});

test("BRK-005B: the panel section and dialog are labelled via aria-labelledby, not a bare visual heading alone", () => {
  const html = renderComponent("SharesightSyncPanel", PANEL_PATH, {
    portfolioId: "portfolio-a",
    link: { status: "not_linked" },
  });
  assert.match(html, /aria-labelledby="sharesight-sync-title"/);
  assert.match(html, /id="sharesight-sync-title"/);
});

// ---------------------------------------------------------------------------
// Review follow-up 7: the /import page row's matrix evidence citation for
// the cross-user link-status read must quote a LITERAL test title from this
// file (grep -F self-check, mirrors tests/ui-006c.test.ts's identical
// citation-integrity guard).
// ---------------------------------------------------------------------------

test("BRK-005B: every matrix citation naming tests/brk-005b.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/brk-005b.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/brk-005b\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  let titleCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      titleCount += 1;
      const title = quoted.slice(1, -1);
      assert.ok(
        ownSource.includes(title),
        `matrix cites "${title}" in tests/brk-005b.test.ts, but that title is not a literal substring of the file (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
  assert.ok(titleCount >= 1, "expected at least 1 quoted title to check");
});
