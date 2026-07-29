import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";

/**
 * Read a built preview asset while tolerating a Worker module that still
 * references the previous Vite content hash after a rebuild.
 */
export async function readPreviewAsset(assetRoot, relativePath) {
  const root = resolve(assetRoot);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return null;
  }

  try {
    return {
      body: await readFile(candidate),
      fallback: false,
    };
  } catch (error) {
    if (error?.code !== "ENOENT" || extname(relativePath) !== ".css") {
      return null;
    }
  }

  const cssDirectory = dirname(candidate);
  const cssFiles = (await readdir(cssDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name) === ".css")
    .map((entry) => entry.name);
  if (cssFiles.length !== 1) {
    return null;
  }

  return {
    body: await readFile(join(cssDirectory, cssFiles[0])),
    fallback: true,
  };
}
