import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { readPreviewAsset } from "../scripts/preview-asset-resolver.mjs";

test("preview asset resolver falls back to the current CSS after a rebuild", async () => {
  const assetRoot = await mkdtemp(join(tmpdir(), "yieldtome-preview-assets-"));
  try {
    await mkdir(join(assetRoot, "assets"));
    await writeFile(
      join(assetRoot, "assets", "index-current.css"),
      "body { color: red; }",
    );

    const asset = await readPreviewAsset(
      assetRoot,
      "assets/index-old-hash.css",
    );

    assert.equal(asset?.fallback, true);
    assert.equal(
      asset
        ? await readFile(join(assetRoot, "assets", "index-current.css"), "utf8")
        : null,
      "body { color: red; }",
    );
  } finally {
    await rm(assetRoot, { recursive: true, force: true });
  }
});

test("preview asset resolver does not substitute unrelated missing assets", async () => {
  const assetRoot = await mkdtemp(join(tmpdir(), "yieldtome-preview-assets-"));
  try {
    await writeFile(
      join(assetRoot, "index-current.css"),
      "body { color: red; }",
    );
    assert.equal(await readPreviewAsset(assetRoot, "index-old-hash.js"), null);
  } finally {
    await rm(assetRoot, { recursive: true, force: true });
  }
});
