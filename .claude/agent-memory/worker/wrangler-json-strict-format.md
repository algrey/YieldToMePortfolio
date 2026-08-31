---
name: wrangler-json-strict-format
description: wrangler.json in this repo must stay strict JSON (no comments) — tests parse it with JSON.parse directly, even though wrangler itself tolerates JSONC.
metadata:
  type: project
---

This repo's `wrangler.json` is named `.json`, not `.jsonc`, but Wrangler's own config loader (`wrangler-dist/cli.js`) actually runs every config file — regardless of extension — through a JSONC parser (`parseJSONC`, `allowTrailingComma: true`), so Wrangler itself would tolerate `//` comments in it. Do NOT rely on that: `tests/mkt-003b.test.ts` and `tests/runtime-config.test.ts` both read `wrangler.json` and feed it straight into plain `JSON.parse`, which throws on any comment. Node's own `require()`/`import ... with { type: "json" }` would also choke on it.

**How to apply:** when editing `wrangler.json` in this repo, keep it strict JSON — no `//` or `/* */` comments, no trailing commas. If a change needs an explanation (e.g. why `placement.mode: "smart"` was added, or why a particular env var exists), put the rationale in `docs/ARCHITECTURE.md`'s dated decision log instead of inline in the config file. Verify with `node -e "require('./wrangler.json')"` (throws immediately on any JSONC-only syntax) before running the full test suite, to catch this class of mistake in one command rather than waiting for `tests/runtime-config.test.ts`/`tests/mkt-003b.test.ts` to fail.
