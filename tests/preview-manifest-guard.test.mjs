import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import {
  findMissingManifestAssets,
  manifestAssetPaths,
} from "../scripts/preview-manifest-guard.mjs";

// Small fixture mirroring the real shape of
// dist/server/__vite_rsc_assets_manifest.js's default export.
function fixtureManifest() {
  return {
    bootstrapScriptContent: 'import("/assets/index-BOECXZqf.js")',
    clientReferenceDeps: {
      abc123: {
        js: [
          "/assets/portfolio-shell-Ccy4bZV7.js",
          "/assets/index-BOECXZqf.js",
        ],
        css: [],
      },
    },
    serverResources: {
      "app/layout.tsx": {
        js: [],
        css: ["/assets/index-U58gzuuU.css"],
      },
    },
  };
}

test("manifestAssetPaths extracts the bootstrap path plus every clientReferenceDeps/serverResources js and css entry", () => {
  const paths = manifestAssetPaths(fixtureManifest());
  assert.deepEqual(
    [...paths].sort(),
    [
      "/assets/index-BOECXZqf.js",
      "/assets/index-U58gzuuU.css",
      "/assets/portfolio-shell-Ccy4bZV7.js",
    ].sort(),
  );
});

test("manifestAssetPaths tolerates a malformed/empty manifest instead of throwing", () => {
  assert.deepEqual(manifestAssetPaths(null), []);
  assert.deepEqual(manifestAssetPaths({}), []);
  assert.deepEqual(manifestAssetPaths({ bootstrapScriptContent: 42 }), []);
});

async function withAssets(files, run) {
  const clientRoot = await mkdtemp(
    join(tmpdir(), "yieldtome-preview-manifest-"),
  );
  try {
    await mkdir(join(clientRoot, "assets"), { recursive: true });
    for (const file of files) {
      await writeFile(join(clientRoot, "assets", file), "content");
    }
    return await run(clientRoot);
  } finally {
    await rm(clientRoot, { recursive: true, force: true });
  }
}

test("findMissingManifestAssets returns empty when every manifest-referenced asset exists in the client build", async () => {
  await withAssets(
    ["index-BOECXZqf.js", "portfolio-shell-Ccy4bZV7.js", "index-U58gzuuU.css"],
    async (clientRoot) => {
      const missing = findMissingManifestAssets(fixtureManifest(), clientRoot);
      assert.deepEqual(missing, []);
    },
  );
});

test("findMissingManifestAssets reports a fabricated mismatch: dist/server references an asset dist/client does not have", async () => {
  // Simulates the exact hazard this guard exists for: dist/client was
  // rebuilt (new content hash) without rebuilding dist/server, so the
  // server's manifest still references the OLD hashed filename.
  await withAssets(
    ["index-U58gzuuU.css"], // portfolio-shell + index js are "missing"
    async (clientRoot) => {
      const missing = findMissingManifestAssets(fixtureManifest(), clientRoot);
      assert.deepEqual(
        [...missing].sort(),
        [
          "/assets/index-BOECXZqf.js",
          "/assets/portfolio-shell-Ccy4bZV7.js",
        ].sort(),
      );
    },
  );
});

test("findMissingManifestAssets reports every referenced asset missing against an empty client build directory", async () => {
  const clientRoot = await mkdtemp(
    join(tmpdir(), "yieldtome-preview-manifest-empty-"),
  );
  try {
    const missing = findMissingManifestAssets(fixtureManifest(), clientRoot);
    assert.equal(missing.length, 3);
  } finally {
    await rm(clientRoot, { recursive: true, force: true });
  }
});
