// design-sync shim: `node:crypto` for the browser bundle. A few pure app
// modules sit in the same import graph as repository code that mints ids;
// the design preview never persists anything, so the Web Crypto equivalent
// is sufficient and keeps the bundle resolvable.
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
