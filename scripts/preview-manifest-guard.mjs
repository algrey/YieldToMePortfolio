// Startup guard for the preview harness: confirms `dist/server`'s Vite RSC
// assets manifest and `dist/client`'s built assets came from the SAME
// build. A stale/mixed `dist/` (e.g. `dist/client` rebuilt without
// rebuilding `dist/server`, or vice versa) would otherwise only surface as
// a runtime 503 the first time some route happens to reference a missing
// asset -- this catches the mismatch once, at startup, with a clear
// message instead of a build-specific runtime failure.
//
// Pure/importable so it can be unit-tested with a fabricated mismatch
// without spawning the harness's HTTP server (see
// tests/preview-manifest-guard.test.mjs) -- mirrors
// scripts/preview-asset-resolver.mjs's separation from preview-harness.mjs.

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Extracts every `/assets/...` path the manifest references: the bootstrap
 * script path embedded in `bootstrapScriptContent` (a JS snippet, not a
 * plain path -- regex-extracted), and every `js`/`css` entry across
 * `clientReferenceDeps` and `serverResources`.
 *
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function manifestAssetPaths(manifest) {
  const paths = new Set();
  const record =
    typeof manifest === "object" && manifest !== null
      ? /** @type {Record<string, unknown>} */ (manifest)
      : {};

  if (typeof record.bootstrapScriptContent === "string") {
    for (const match of record.bootstrapScriptContent.matchAll(
      /\/assets\/[^"'()\s]+/g,
    )) {
      paths.add(match[0]);
    }
  }

  for (const groupKey of ["clientReferenceDeps", "serverResources"]) {
    const group = record[groupKey];
    if (typeof group !== "object" || group === null) continue;
    for (const entry of Object.values(
      /** @type {Record<string, unknown>} */ (group),
    )) {
      if (typeof entry !== "object" || entry === null) continue;
      for (const listKey of ["js", "css"]) {
        const list = /** @type {Record<string, unknown>} */ (entry)[listKey];
        if (!Array.isArray(list)) continue;
        for (const path of list) {
          if (typeof path === "string") paths.add(path);
        }
      }
    }
  }

  return [...paths];
}

/**
 * Returns every manifest-referenced asset path that does NOT exist under
 * `clientRoot` (typically `dist/client`, since manifest paths already start
 * with `/assets/...`). An empty array means the manifest and the client
 * build agree -- safe to start.
 *
 * @param {unknown} manifest
 * @param {string} clientRoot
 * @returns {string[]}
 */
export function findMissingManifestAssets(manifest, clientRoot) {
  const missing = [];
  for (const assetPath of manifestAssetPaths(manifest)) {
    const relative = assetPath.replace(/^\/+/, "");
    if (!existsSync(join(clientRoot, relative))) {
      missing.push(assetPath);
    }
  }
  return missing;
}
