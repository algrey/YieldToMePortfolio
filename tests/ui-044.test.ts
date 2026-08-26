/** UI-044 — No undefined CSS custom properties in globals.css.
 *
 * Owner-reported: the Quotes tab's two watchlist buttons ("Add a stock",
 * "Add a currency pair") rendered as empty boxes. The labels were present in
 * the DOM all along -- their rule set `background: var(--surface-raised)`
 * and `color: var(--ink)`, but that surface token was never defined in
 * `:root`, so the background fell back to transparent and near-black text
 * sat on the dark page at ~1:1 contrast. A dead token fails SILENTLY in
 * CSS, so this guards the whole stylesheet rather than the one rule.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("UI-044: every var(--token) referenced in globals.css actually resolves to a definition", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /:root\s*\{/, "expected a :root token block");
  // Defined ANYWHERE in the stylesheet -- a few tokens are deliberately
  // scoped to a component rule rather than :root (e.g. sticky-offset
  // measurements) rather than being global palette entries.
  const defined = new Set(
    [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]),
  );
  // Some tokens are supplied at runtime as an inline style by a component
  // (e.g. an allocation bar's own width); those are defined in TSX, not CSS.
  for (const source of await Promise.all(
    ["../app/components/portfolio-shell.tsx"].map((path) =>
      readFile(new URL(path, import.meta.url), "utf8"),
    ),
  )) {
    for (const match of source.matchAll(/"(--[\w-]+)":/g)) {
      defined.add(match[1]);
    }
  }

  const referenced = new Set(
    [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]),
  );
  // A reference with its own fallback (`var(--x, ...)`) is deliberate and
  // degrades on purpose; everything else must resolve.
  const undefinedTokens = [...referenced].filter(
    (token) =>
      !defined.has(token) &&
      !new RegExp(`var\\(\\s*${token}\\s*,`).test(css) &&
      // Tailwind/browser-provided custom properties are not ours to define.
      !token.startsWith("--tw-"),
  );
  assert.deepEqual(
    undefinedTokens,
    [],
    `globals.css references CSS variables that :root never defines (they fail silently): ${undefinedTokens.join(", ")}`,
  );
});

test("UI-044: the watchlist add buttons render readable text on their own surface, never near-black ink on the dark page", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const block = css.match(
    /\.quote-action-buttons button,\s*\n\.quote-dialog button \{([^}]*)\}/,
  );
  assert.ok(block, "expected the shared quote/watchlist button rule");
  assert.match(block![1], /background:\s*var\(--forest-raised\)/);
  assert.match(block![1], /color:\s*var\(--cream\)/);
  assert.doesNotMatch(block![1], /color:\s*var\(--ink\)/);
});

/** UI-045 — the watchlist add panels are styled, compact rows.
 *
 * Owner: "add a currency pair ... is a bit ugly ... should give you two
 * boxes and an add button ... in the style of the rest of the page and
 * compact." They previously rendered bare labels and inputs with no CSS of
 * their own, flowing inline against the page background.
 */
test("UI-045: the currency-pair form renders two labelled code fields and an Add button in one compact row", async () => {
  const [shell, css] = await Promise.all([
    readFile(
      new URL("../app/components/portfolio-shell.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  // Both add panels share the styled panel + form classes.
  assert.equal(
    (shell.match(/quote-history watchlist-add-panel/g) ?? []).length,
    2,
  );
  assert.equal(
    (shell.match(/className="watchlist-add-form"/g) ?? []).length,
    2,
  );
  // Two currency fields, each a labelled 3-character code box.
  assert.equal(
    (shell.match(/className="watchlist-add-field"/g) ?? []).length,
    2,
  );
  assert.match(shell, /<span>Base<\/span>/);
  assert.match(shell, /<span>Quote<\/span>/);

  // Compact row: the form lays out inline and the code fields are fixed to
  // a 3-letter width so the pair plus Add fit one line.
  const form = css.match(/\.watchlist-add-form \{([^}]*)\}/);
  assert.ok(form, "expected a .watchlist-add-form rule");
  assert.match(form![1], /display:\s*flex/);
  assert.match(form![1], /flex-wrap:\s*wrap/);
  assert.match(
    css,
    /\.watchlist-add-form \.watchlist-add-field:not\(\.wide\) \{[^}]*flex:\s*0 0 \d+px/,
  );
  // Inputs keep the 44px touch target (QA-001B) and readable contrast.
  const input = css.match(/\.watchlist-add-field input \{([^}]*)\}/);
  assert.ok(input, "expected a .watchlist-add-field input rule");
  assert.match(input![1], /min-height:\s*44px/);
  assert.match(input![1], /color:\s*var\(--cream\)/);
});
