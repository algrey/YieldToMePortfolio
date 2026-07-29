import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

type PackageScripts = Record<string, string>;

test("typecheck rejects an intentional type error", () => {
  const compiler = fileURLToPath(
    new URL("../node_modules/typescript/bin/tsc", import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL("./fixtures/intentional-type-error.ts", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      compiler,
      "--noEmit",
      "--strict",
      "--target",
      "ES2020",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      fixture,
    ],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /not assignable to type 'string'/i,
  );
});

test("aggregate check is complete and fail-fast", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: PackageScripts };

  assert.equal(
    packageJson.scripts.check,
    "./node_modules/.bin/prettier --check . && ./node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next --ignore-pattern worker-configuration.d.ts && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vinext check && ./node_modules/.bin/vinext build && node --experimental-strip-types --test tests/*.test.ts tests/*.test.mjs",
  );
});
