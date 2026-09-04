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
 *      established spike-testing convention).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
