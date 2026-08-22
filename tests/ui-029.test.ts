import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// UI-029 -- Align legacy "Price unavailable" display strings with the
// amended AGENTS.md wording ("unavailable"). Grep-driven, display-only
// alignment: `app/owned-holdings.ts`, `app/preview-route-data.ts`,
// `app/quote-contract.ts`, `app/components/portfolio-shell.tsx`, and
// `app/components/holding-detail.tsx` had their standalone-cell display
// strings changed to bare "unavailable" (matching `ownedHoldingUnavailableText`'s
// UI-028 precedent and the watchlist's WLT-001 strings); sentence-context
// strings were reworded rather than bluntly substituted, so they no longer
// contain the literal either (`quote-contract.ts`'s explain paragraph now
// reads "Unavailable: no usable price exists..."; `preview-route-data.ts`'s
// composite quantity line now reads "Average cost unavailable x N shares").
//
// This sweep pins that no `app/` source file renders the retired literal,
// with three deliberate, documented exceptions (all comments that QUOTE the
// retired literal to explain wording history, never rendered copy):
//   - app/watchlist-contract.ts: WLT-001 review B6's wording-history note.
//   - app/owned-holding-format.tsx: UI-028's function-scoped-wording note.
//   - app/sharesight-price-gate-service.ts: a BRK-012C review-round note
//     using the phrase informally to describe the missing-quote STATE.
// docs/ARCHITECTURE.md's UI-029 decision-log entry records the same list.
const EXCEPTIONS = new Set([
  "app/watchlist-contract.ts",
  "app/owned-holding-format.tsx",
  "app/sharesight-price-gate-service.ts",
]);

async function listTsFilesRecursive(dirUrl: URL): Promise<string[]> {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const childUrl = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      dirUrl,
    );
    if (entry.isDirectory()) {
      files.push(...(await listTsFilesRecursive(childUrl)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fileURLToPath(childUrl));
    }
  }
  return files;
}

test("UI-029 sweep: no app/ source file (outside the documented wording-history comments) renders the retired 'Price unavailable' literal", async () => {
  const appRoot = new URL("../app/", import.meta.url);
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const files = await listTsFilesRecursive(appRoot);
  assert.ok(
    files.length > 20,
    "sanity check: the app/ sweep found too few files",
  );

  const offenders: string[] = [];
  for (const absolutePath of files) {
    const relativePath = absolutePath.slice(repoRoot.length);
    if (EXCEPTIONS.has(relativePath)) continue;
    const content = await readFile(absolutePath, "utf8");
    if (content.includes("Price unavailable")) {
      offenders.push(relativePath);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `unexpected legacy "Price unavailable" literal(s) in: ${offenders.join(", ")}`,
  );
});

test("UI-029 sweep: the documented exception files' only occurrences of the retired literal are inside comments", async () => {
  const repoRoot = new URL("../", import.meta.url);
  for (const relativePath of EXCEPTIONS) {
    const content = await readFile(new URL(relativePath, repoRoot), "utf8");
    const lines = content
      .split("\n")
      .filter((line) => line.includes("Price unavailable"));
    assert.ok(
      lines.length > 0,
      `${relativePath} is listed as an exception but no longer references the legacy literal -- remove it from EXCEPTIONS`,
    );
    for (const line of lines) {
      const trimmed = line.trimStart();
      assert.ok(
        trimmed.startsWith("//") || trimmed.startsWith("*"),
        `${relativePath} references "Price unavailable" outside a comment: ${line}`,
      );
    }
  }
});
