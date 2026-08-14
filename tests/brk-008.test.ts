/** BRK-008 -- Sharesight live read spike script.
 *
 * The spike (`scripts/sharesight-read-spike.mjs`) is not run against a real
 * Sharesight account in this suite -- no credentials exist yet (BRK-008 is
 * BLOCKED pending owner-supplied `.dev.vars` credentials) and it performs
 * live network I/O against the owner's real account, which must never
 * happen unattended in a test run. This file exercises ONLY the
 * missing-credentials dry path: run the script with no credentials
 * available and confirm it fails closed with a clear, exit-1 message
 * before attempting any network call.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseDevVars } from "../scripts/dev-vars.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/sharesight-read-spike.mjs", import.meta.url),
);

function runWithoutCredentials(devVarsPath: string) {
  // Strip any ambient SHARESIGHT_* env vars and point the script at a
  // dev-vars file with no Sharesight credentials, so this test's result
  // never depends on whether the real repo-root `.dev.vars` happens to have
  // credentials in it (it does not today, but must not be load-bearing).
  const env = { ...process.env };
  delete env.SHARESIGHT_CLIENT_ID;
  delete env.SHARESIGHT_CLIENT_SECRET;
  env.SHARESIGHT_DEV_VARS_PATH = devVarsPath;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", scriptPath],
    { encoding: "utf8", env },
  );
}

test("BRK-008: the spike exits 1 with a clear message when no credentials are configured (no .dev.vars file at all)", () => {
  const result = runWithoutCredentials(
    join(tmpdir(), "yieldtome-brk-008-nonexistent", ".dev.vars"),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing Sharesight credentials/);
  assert.match(result.stderr, /SHARESIGHT_CLIENT_ID/);
  assert.match(result.stderr, /SHARESIGHT_CLIENT_SECRET/);
  // Never attempted a request -- no token/portfolio output on stdout.
  assert.doesNotMatch(result.stdout, /acquire token/);
});

test("BRK-008: the spike exits 1 with a clear message when .dev.vars exists but has no Sharesight keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldtome-brk-008-"));
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

test("BRK-008: parseDevVars reads KEY=VALUE pairs, ignores comments/blank lines, and strips matching quotes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldtome-brk-008-parse-"));
  try {
    const devVarsPath = join(dir, ".dev.vars");
    await writeFile(
      devVarsPath,
      [
        "# a comment",
        "",
        "SHARESIGHT_CLIENT_ID=abc123",
        'SHARESIGHT_CLIENT_SECRET="quoted value"',
        "  SPACED_KEY = spaced value  ",
      ].join("\n"),
    );
    const parsed = parseDevVars(devVarsPath);
    assert.equal(parsed.SHARESIGHT_CLIENT_ID, "abc123");
    assert.equal(parsed.SHARESIGHT_CLIENT_SECRET, "quoted value");
    assert.equal(parsed.SPACED_KEY, "spaced value");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BRK-008: parseDevVars returns an empty object for a missing file (never throws)", () => {
  const parsed = parseDevVars(
    join(tmpdir(), "yieldtome-brk-008-definitely-missing", ".dev.vars"),
  );
  assert.deepEqual(parsed, {});
});

// Deliberately NOT tested here: env-var precedence over `.dev.vars` once
// credentials are present. Proving that would require running the script
// past the missing-credentials check, which immediately attempts a real
// network call to Sharesight -- exactly what BRK-008's "do not run it, no
// credentials exist" constraint and this suite's no-live-network rule
// (mirroring tests/brk-003.test.ts) forbid. `SHARESIGHT_CLIENT_ID ||
// devVars.SHARESIGHT_CLIENT_ID` in the script is a one-line, visually
// self-evident precedence rule; see the script's header comment.
