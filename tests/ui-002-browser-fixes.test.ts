import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("app/globals.css", "utf8");

test("UI-002 browser fixes preserve 44px tabs and readable 320px KPIs", () => {
  assert.match(styles, /--tabs:\s*44px/);
  assert.match(styles, /\.primary-tabs a\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(
    styles,
    /@media \(max-width: 350px\)\s*\{[\s\S]*\.overview-kpis\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 350px\)\s*\{[\s\S]*\.overview-kpis dd\s*\{[\s\S]*overflow:\s*visible[\s\S]*white-space:\s*normal/,
  );
});
