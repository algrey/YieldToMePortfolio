/** BRK-017 step 1 -- Sharesight list-endpoint pagination PROBE tooling.
 *
 * `scripts/sharesight-pagination-probe.mjs` is not run against a real
 * Sharesight account in this suite -- it performs live network I/O against
 * the owner's real account, which must never happen unattended in a test
 * run. This file exercises:
 *   1. the missing-credentials fail-closed path (mirrors
 *      `tests/brk-008.test.ts`'s identical drill for the other spikes);
 *   2. the pure summary formatter (`formatSummaryTable`) against fixed
 *      input;
 *   3. the full probe pipeline (`runProbe` + `formatSummaryTable`) driven
 *      by the script's own in-process fake client (`buildFakeClient`),
 *      covering both the "ignores paging" (trades) and "honours paging"
 *      (payouts) branches of `probeEndpoint`'s comparison logic -- no
 *      network, no credentials;
 *   4. that `--dry-run` on the command line exercises the identical path
 *      end to end (spawned as a real process, matching this repo's
 *      established spike-testing convention);
 *   5. BRK-017 step 2 -- `parseItemList`'s (`domain/sharesight/parse.ts`)
 *      fail-closed pagination guard, added once step 1's live probe (see
 *      docs/ARCHITECTURE.md §8.2, 2026-09-04) confirmed none of the tested
 *      endpoints paginates server-side today. The guard exists so a future
 *      API change that starts truncating these lists surfaces as a visible
 *      sync failure rather than a silent partial import.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildFakeClient,
  deriveEnvelopeEvidence,
  formatSummaryTable,
  probeEndpoint,
  runProbe,
} from "../scripts/sharesight-pagination-probe.mjs";
import {
  parseSharesightPayouts,
  parseSharesightTrades,
  parseSharesightUserInstruments,
} from "../domain/sharesight/parse.ts";

const scriptPath = fileURLToPath(
  new URL("../scripts/sharesight-pagination-probe.mjs", import.meta.url),
);

function runWithoutCredentials(devVarsPath: string, extraArgs: string[] = []) {
  const env = { ...process.env };
  delete env.SHARESIGHT_CLIENT_ID;
  delete env.SHARESIGHT_CLIENT_SECRET;
  env.SHARESIGHT_DEV_VARS_PATH = devVarsPath;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", scriptPath, ...extraArgs],
    { encoding: "utf8", env },
  );
}

// ---------------------------------------------------------------------------
// 1. Missing-credentials fail-closed drill (mirrors tests/brk-008.test.ts)
// ---------------------------------------------------------------------------

test("BRK-017: the probe exits 1 with a clear message when no credentials are configured", () => {
  const result = runWithoutCredentials(
    join(tmpdir(), "yieldtome-brk-017-nonexistent", ".dev.vars"),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing Sharesight credentials/);
  assert.match(result.stderr, /SHARESIGHT_CLIENT_ID/);
  assert.match(result.stderr, /SHARESIGHT_CLIENT_SECRET/);
  // Never attempted a request -- no token/portfolio output on stdout.
  assert.doesNotMatch(result.stdout, /acquire token/);
  assert.doesNotMatch(result.stdout, /portfolios:/);
});

test("BRK-017: --dry-run never requires credentials and never hits the missing-credentials path", () => {
  const result = runWithoutCredentials(
    join(tmpdir(), "yieldtome-brk-017-nonexistent-2", ".dev.vars"),
    ["--dry-run"],
  );
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /Missing Sharesight credentials/);
});

// ---------------------------------------------------------------------------
// 2. Pure summary formatter, fixed input
// ---------------------------------------------------------------------------

test("BRK-017: deriveEnvelopeEvidence reports envelope keys, array length, sibling keys, and ONLY pagination-shaped sibling values", () => {
  const evidence = deriveEnvelopeEvidence(
    {
      trades: [{ id: "1" }, { id: "2" }],
      total_pages: 5,
      per_page: 25,
      // Not pagination-shaped by name -- must never be echoed even though
      // it is a sibling key.
      portfolio_name: "should never appear",
    },
    "trades",
  );
  assert.ok(evidence);
  assert.deepEqual(evidence.topLevelKeys, [
    "per_page",
    "portfolio_name",
    "total_pages",
    "trades",
  ]);
  assert.equal(evidence.arrayLength, 2);
  assert.deepEqual(evidence.siblingKeys.sort(), [
    "per_page",
    "portfolio_name",
    "total_pages",
  ]);
  assert.deepEqual(evidence.paginationMetaValues, {
    total_pages: 5,
    per_page: 25,
  });
  assert.equal(
    "portfolio_name" in evidence.paginationMetaValues,
    false,
    "a non-pagination-shaped sibling key's value must never be surfaced",
  );
});

test("BRK-017: deriveEnvelopeEvidence returns null for a body with no array under the envelope key", () => {
  assert.equal(
    deriveEnvelopeEvidence({ trades: "not an array" }, "trades"),
    null,
  );
  assert.equal(deriveEnvelopeEvidence(null, "trades"), null);
  assert.equal(deriveEnvelopeEvidence([1, 2, 3], "trades"), null);
});

test("BRK-017: formatSummaryTable renders a dated header line and one row per probe result", () => {
  const probeResults = [
    {
      label: "portfolio #1 trades",
      envelopeKey: "trades",
      outcomes: {
        wide: {
          ok: true,
          topLevelKeys: ["trades"],
          envelopeKey: "trades",
          arrayLength: 3,
          siblingKeys: [],
          paginationMetaValues: {},
        },
        page1: {
          ok: true,
          topLevelKeys: ["trades"],
          envelopeKey: "trades",
          arrayLength: 3,
          siblingKeys: [],
          paginationMetaValues: {},
        },
        page2: {
          ok: true,
          topLevelKeys: ["trades"],
          envelopeKey: "trades",
          arrayLength: 3,
          siblingKeys: [],
          paginationMetaValues: {},
        },
      },
      pagingEffect: "ignores paging (response identical)",
    },
  ];
  const table = formatSummaryTable(probeResults, "2026-09-04T00:00:00.000Z");
  const lines = table.split("\n");
  assert.equal(
    lines[0],
    "BRK-017 pagination probe -- 2026-09-04T00:00:00.000Z",
  );
  assert.match(lines[1], /^endpoint \|/);
  // 3 table lines + a blank + the "pagination-meta values" header + one
  // value line per call (wide/page1/page2) for the single probe result.
  assert.equal(lines.length, 8);
  assert.match(
    lines[2],
    /^portfolio #1 trades \| 3 \| 3 \| 3 \| \(none\) \| \(none\) \| ignores paging/,
  );
  assert.equal(lines[3], "");
  assert.equal(lines[4], "pagination-meta values (wide / p1 / p2):");
  assert.equal(lines[5], "portfolio #1 trades [wide]: {}");
  assert.equal(lines[6], "portfolio #1 trades [page1]: {}");
  assert.equal(lines[7], "portfolio #1 trades [page2]: {}");
});

test("BRK-017: formatSummaryTable reports an unavailable outcome by its typed error kind, never a raw value", () => {
  const probeResults = [
    {
      label: "portfolio #1 payouts",
      envelopeKey: "payouts",
      outcomes: {
        wide: { ok: false, kind: "rate_limit", hint: "rate limited" },
        page1: { ok: false, kind: "rate_limit", hint: "rate limited" },
        page2: { ok: false, kind: "rate_limit", hint: "rate limited" },
      },
      pagingEffect: "not computable",
    },
  ];
  const table = formatSummaryTable(probeResults, "2026-09-04T00:00:00.000Z");
  assert.match(table, /unavailable \(rate_limit\)/);
});

// ---------------------------------------------------------------------------
// 3. Fake-client dry run of the full probe pipeline (no network)
// ---------------------------------------------------------------------------

test("BRK-017: probeEndpoint against the fake client's trades method reports 'ignores paging' (identical response regardless of page/per_page)", async () => {
  const client = buildFakeClient();
  const result = await probeEndpoint("portfolio #1 trades", "trades", {
    wide: () => client.getTradesRaw("1001", { from: "1990-01-01" }),
    page1: () => client.getTradesRaw("1001", { page: 1, perPage: 1 }),
    page2: () => client.getTradesRaw("1001", { page: 2 }),
  });
  assert.equal(result.pagingEffect, "ignores paging (response identical)");
  assert.equal(result.outcomes.wide.arrayLength, 3);
  assert.equal(result.outcomes.page1.arrayLength, 3);
});

test("BRK-017: probeEndpoint against the fake client's payouts method reports 'honours paging' (per_page shrinks the list, metadata present)", async () => {
  const client = buildFakeClient();
  const result = await probeEndpoint("portfolio #1 payouts", "payouts", {
    wide: () => client.getPayoutsRaw("1001", { from: "1990-01-01" }),
    page1: () => client.getPayoutsRaw("1001", { page: 1, perPage: 1 }),
    page2: () => client.getPayoutsRaw("1001", { page: 2, perPage: 1 }),
  });
  assert.match(result.pagingEffect, /^honours paging/);
  assert.equal(result.outcomes.wide.arrayLength, 4);
  assert.equal(result.outcomes.page1.arrayLength, 1);
  assert.deepEqual(
    Object.keys(result.outcomes.wide.paginationMetaValues).sort(),
    ["per_page", "total_pages"],
  );
});

test("BRK-017: runProbe against the fake client covers every portfolio's trades/payouts plus one account-wide user_instruments probe", async () => {
  const client = buildFakeClient();
  const results = await runProbe(client);
  const labels = results.map((r) => r.label);
  assert.deepEqual(labels, [
    "portfolio #1 trades",
    "portfolio #1 payouts",
    "user_instruments (account-wide)",
  ]);
  const table = formatSummaryTable(results, "2026-09-04T00:00:00.000Z");
  assert.match(table, /^BRK-017 pagination probe -- 2026-09-04T00:00:00\.000Z/);
  // Never a raw Sharesight value anywhere in the fake-client run's output --
  // the fake fixture itself carries none (only synthetic `id`s inside item
  // arrays, which this probe never prints), but pin the shape anyway.
  assert.doesNotMatch(table, /undefined/);
});

// ---------------------------------------------------------------------------
// 4. `--dry-run` end to end as a real spawned process
// ---------------------------------------------------------------------------

test("BRK-017: --dry-run runs the full probe against the fake client and prints a pasteable summary table, no network/credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldtome-brk-017-dry-"));
  try {
    // No .dev.vars file at all in this directory -- proves --dry-run truly
    // never reads credentials.
    const devVarsPath = join(dir, ".dev.vars");
    const env = { ...process.env };
    delete env.SHARESIGHT_CLIENT_ID;
    delete env.SHARESIGHT_CLIENT_SECRET;
    delete env.SHARESIGHT_REFRESH_TOKEN;
    env.SHARESIGHT_DEV_VARS_PATH = devVarsPath;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", scriptPath, "--dry-run"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /--dry-run: using an in-process fake client, no network\./,
    );
    assert.match(result.stdout, /BRK-017 pagination probe --/);
    assert.match(result.stdout, /portfolio #1 trades/);
    assert.match(result.stdout, /portfolio #1 payouts/);
    assert.match(result.stdout, /user_instruments \(account-wide\)/);
    assert.match(result.stdout, /ignores paging/);
    assert.match(result.stdout, /honours paging/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BRK-017: the probe exits 1 with a clear message when .dev.vars exists but has no Sharesight keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldtome-brk-017-"));
  try {
    const devVarsPath = join(dir, ".dev.vars");
    await writeFile(
      devVarsPath,
      "CLOUDFLARE_ACCESS_ISSUER=http://127.0.0.1:8799\n# a comment\n\n",
    );
    const result = runWithoutCredentials(devVarsPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing Sharesight credentials/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. `parseItemList`'s fail-closed pagination guard (BRK-017 step 2)
// ---------------------------------------------------------------------------
//
// Live-recorded evidence (docs/ARCHITECTURE.md §8.2, 2026-09-04): every
// probed response carried ONLY a `links.self` echo (or an empty `links: {}`)
// -- no `next`/`prev`/`total_pages`/`next_page`/`total_count`/`per_page` key
// has ever been observed on the wire. Guard triggers below are therefore
// exercised against SYNTHETIC envelopes; they document defensive behaviour
// for a shape that hasn't happened yet, not a reproduction of a real bug.
// Fixtures use empty/near-empty item arrays throughout because the guard
// runs BEFORE per-item parsing -- item-shape correctness is covered by
// tests/brk-003.test.ts, tests/brk-012b.test.ts, etc.

test("BRK-017 guard: links.next (non-empty string) rejects the whole list closed", () => {
  const result = parseSharesightTrades(
    {
      trades: [],
      links: { self: "https://x/trades", next: "https://x/trades?page=2" },
    },
    "1",
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invalid_response");
    assert.match(result.error.message, /trades/);
    assert.match(result.error.message, /"links\.next"/);
  }
});

test("BRK-017 guard: links.prev (non-empty string) rejects the whole list closed", () => {
  const result = parseSharesightTrades(
    {
      trades: [],
      links: { self: "https://x/trades", prev: "https://x/trades?page=1" },
    },
    "1",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /"links\.prev"/);
});

test("BRK-017 guard: top-level total_pages > 1 rejects the whole list closed", () => {
  const result = parseSharesightTrades({ trades: [], total_pages: 2 }, "1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /"total_pages"/);
});

test("BRK-017 guard: top-level page_count > 1 rejects the whole list closed", () => {
  const result = parseSharesightTrades({ trades: [], page_count: 3 }, "1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /"page_count"/);
});

test("BRK-017 guard: a non-null next_page rejects the whole list closed", () => {
  const result = parseSharesightTrades({ trades: [], next_page: 2 }, "1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /"next_page"/);
});

test("BRK-017 guard: total_count greater than the returned array length rejects the whole list closed", () => {
  const result = parseSharesightTrades({ trades: [], total_count: 5 }, "1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /"total_count"/);
});

test("BRK-017 guard: bare total greater than the returned array length rejects the whole list closed", () => {
  const result = parseSharesightTrades({ trades: [], total: 5 }, "1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /"total"/);
});

test("BRK-017 guard: per_page reached by the returned array length rejects the whole list closed", () => {
  // Array length (1) >= per_page (1) -- the page is exactly full, which is
  // the ambiguous "might be truncated" case this guard treats as evidence.
  const result = parseSharesightTrades({ trades: [{}], per_page: 1 }, "1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /"per_page"/);
});

test("BRK-017 guard: nested meta/pagination sub-objects are also checked", () => {
  const viaMeta = parseSharesightTrades(
    { trades: [], meta: { total_pages: 2 } },
    "1",
  );
  assert.equal(viaMeta.ok, false);
  const viaPagination = parseSharesightTrades(
    { trades: [], pagination: { next_page: 2 } },
    "1",
  );
  assert.equal(viaPagination.ok, false);
});

test("BRK-017 guard: links.self alone, an empty links object, and an unrelated sibling key all pass unchanged", () => {
  const selfOnly = parseSharesightTrades(
    { trades: [], links: { self: "https://x/trades" } },
    "1",
  );
  assert.equal(selfOnly.ok, true);

  const emptyLinks = parseSharesightUserInstruments({
    instruments: [],
    links: {},
  });
  assert.equal(emptyLinks.ok, true);

  // `api_transaction` matches none of the trigger key names -- passes even
  // though it is an unrecognised sibling key, because this guard only ever
  // reacts to pagination-shaped names, never "any unknown key".
  const unrelatedSibling = parseSharesightTrades(
    {
      trades: [],
      api_transaction: { some: "shape" },
      links: { self: "https://x/trades" },
    },
    "1",
  );
  assert.equal(unrelatedSibling.ok, true);
});

test("BRK-017 guard: the real recorded envelope shapes (dummy portfolio id) all pass unchanged", () => {
  // Masked/dummy portfolio id -- never a real one, per ARCHITECTURE §8.2
  // leak discipline.
  const DUMMY_ID = "12345";

  const tradesWide = parseSharesightTrades(
    {
      trades: [],
      api_transaction: {},
      links: {
        self: `https://api.sharesight.com/api/v3.0/portfolios/${DUMMY_ID}/trades?end_date=2026-09-04&start_date=1990-01-01`,
      },
    },
    DUMMY_ID,
  );
  assert.equal(tradesWide.ok, true);

  const tradesPage1 = parseSharesightTrades(
    {
      trades: [],
      api_transaction: {},
      links: {
        self: `https://api.sharesight.com/api/v3.0/portfolios/${DUMMY_ID}/trades`,
      },
    },
    DUMMY_ID,
  );
  assert.equal(tradesPage1.ok, true);

  const payoutsWide = parseSharesightPayouts(
    {
      payouts: [],
      links: {
        self: `https://api.sharesight.com/api/v2.0/portfolios/${DUMMY_ID}/payouts?end_date=2026-09-04&start_date=1990-01-01`,
      },
    },
    DUMMY_ID,
  );
  assert.equal(payoutsWide.ok, true);

  const payoutsPage1 = parseSharesightPayouts(
    {
      payouts: [],
      links: {
        self: `https://api.sharesight.com/api/v2.0/portfolios/${DUMMY_ID}/payouts?page=1&per_page=1`,
      },
    },
    DUMMY_ID,
  );
  assert.equal(payoutsPage1.ok, true);

  const payoutsPage2 = parseSharesightPayouts(
    {
      payouts: [],
      links: {
        self: `https://api.sharesight.com/api/v2.0/portfolios/${DUMMY_ID}/payouts?page=2`,
      },
    },
    DUMMY_ID,
  );
  assert.equal(payoutsPage2.ok, true);

  const userInstruments = parseSharesightUserInstruments({
    instruments: [],
    links: {},
  });
  assert.equal(userInstruments.ok, true);
});

test("BRK-017 guard: listTrades/listPayouts/listUserInstruments's parsers all reject the identical trigger, proving they share the one guard", () => {
  const trigger = { links: { next: "https://x/more" } };
  const trades = parseSharesightTrades({ trades: [], ...trigger }, "1");
  const payouts = parseSharesightPayouts({ payouts: [], ...trigger }, "1");
  const userInstruments = parseSharesightUserInstruments({
    instruments: [],
    ...trigger,
  });
  for (const result of [trades, payouts, userInstruments]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /"links\.next"/);
  }
});

test("BRK-017 guard: parseSharesightTrades/Payouts/UserInstruments route through parseItemList by source (guards against a future bypass)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../domain/sharesight/parse.ts", import.meta.url)),
    "utf8",
  );
  for (const fnName of [
    "parseSharesightTrades",
    "parseSharesightPayouts",
    "parseSharesightUserInstruments",
  ]) {
    const start = source.indexOf(`export function ${fnName}(`);
    assert.notEqual(start, -1, `${fnName} not found in parse.ts`);
    const nextExport = source.indexOf("\nexport function", start + 1);
    const body = source.slice(
      start,
      nextExport === -1 ? undefined : nextExport,
    );
    assert.match(
      body,
      /parseItemList\(/,
      `${fnName} must call parseItemList (the guard's only home) directly`,
    );
  }
});
