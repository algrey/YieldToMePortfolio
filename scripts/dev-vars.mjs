// Minimal `.dev.vars`-shaped KEY=VALUE parser, shared by local dev tooling
// that needs to read `.dev.vars` outside `wrangler`/`vinext dev` (which load
// it automatically). Not a general dotenv implementation -- just enough for
// this repo's convention: plain `KEY=value` lines, optional matching
// single/double quotes around the value, `#`-prefixed comments, and blank
// lines, all ignored/stripped the same way.
//
// Deliberately its own module (no other top-level code) so importing
// `parseDevVars` alone -- e.g. from a test -- never triggers a consuming
// script's own top-level side effects (see scripts/sharesight-read-spike.mjs,
// which used to export this function itself before extraction).

import { existsSync, readFileSync } from "node:fs";

/** @param {string} path
 * @returns {Record<string, string>} */
export function parseDevVars(path) {
  /** @type {Record<string, string>} */
  const result = {};
  if (!existsSync(path)) return result;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}
