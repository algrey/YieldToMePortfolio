# Session handoff — 2026-09-04

Orchestrator session. Picked up the 2026-09-03 handoff's open items in order: BRK-020 (ported from the owner's other session), BRK-019 (owner ruling), BRK-017 (live probe + guard), PRF-014 step 2 (scoped; 2a and 2b landed). Every task went through worker → reviewer rounds on `main`; nothing is deployed yet.

---

## 1. What is on `main` and NOT deployed

Everything from the previous handoff (migrations `0059`/`0060`/`0061`) plus:

| Migration | Task    | Shape                                                                                                                                                                |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0062`    | BRK-020 | `import_batches_user_file_parser_unique` narrowed to `WHERE status <> 'reversed'` (partial unique index; `startUpload`'s `ON CONFLICT` target repeats the predicate) |

Deploy sequence is unchanged: owner runs `! npx wrangler login`; `npx wrangler d1 time-travel info` → bookmark; apply `0059`, `0060`, `0061`, `0062` in order with a bookmark before each; `CLOUDFLARE_ENV=production npm run build`; `npx wrangler deploy --config dist/server/wrangler.json`.

**The BUG-018 "start over, don't resume" rule is moot** for this deploy: OPS-005 (already on main, same deploy) replaced count-slice resume with a server-side per-ref probe, so a chunked restore interrupted before the deploy resumes correctly after it. The restore panel's "re-select this backup and confirm again to resume" copy is accurate; a stale pre-deploy browser tab is rejected fail-closed by the finalize digest check. Nothing to change in the UI.

Landed this session (all `DONE` in `TASKS.md` with round records):

- **BRK-020** — identical Sharesight re-sync / CSV re-upload after a reversal now mints a fresh batch (partial index, migration `0062`). Ported from branch `claude/eager-gauss-cfeacc` `9a83016`, which was mislabelled BUG-023 and numbered its migration 0061 (collided with OPS-005). Three review rounds: the `failed` status was ruled to stay in the key (unreachable for CSV/Sharesight; guard test mutation-tested 4/4), `findExistingBatch` gained a live-first `ORDER BY` (real plan keeps the owner-index seek + temp B-tree), and three false evidence claims were corrected. Filed **BRK-021** (should the bundle-restore scaffold still reuse-and-reset a reversed bundle batch now that a fresh INSERT no longer collides?).
- **BRK-017** — live pagination probe (GET-only, `.dev.vars` credentials, sandbox bypass for egress only; NO `wrangler login` needed): trades 107 / payouts 119 / user_instruments 18 identical for wide, `page=1&per_page=1`, `page=2`; `links` carries only `self`. No Sharesight list endpoint paginates. Fail-closed guard added in `parseItemList` (the single envelope reader): rejects `links.next/prev`, `total_pages`/`page_count` > 1, `next_page` positive/non-empty/`true`, `total_count`/`total_entries` > length, `per_page` reached, and `total` > length inside `meta`/`pagination` ONLY (bare top-level `total` reads as money and is scoped out). Post-guard live read-spike parsed portfolios/holdings/trades/payouts OK. Probe redacts ids. 429 stance recorded.
- **BRK-019** — OWNER RULING recorded (option **A** for both the value-corrected row and the `paidOnDate` case): explicit `needs_decision` row with one-click Supersede (reversal + new posting / supersession chain) or Exclude; Accept never writes a corrected row; near-match against a committed Sharesight record with the same portfolio+holding+cash becomes needs-decision too. Entry is READY with full acceptance criteria; sequence after BRK-020 (done).
- **PRF-014 step 2** — scoped into 2a–2e (survey facts in the entry). **2a** DONE (`a5a9577`: pure block → `portfolio-shell-model.ts`, byte-identical SSR, 119,561 → 119,559 bytes). **2b** landed (`855a7f4`: preview-only subtree → `preview-shell.tsx`, discriminated props, 17 SSR fixtures byte-identical, `portfolio-shell-*.js` 119,559 → 102,831 + `preview-shell-*.js` 21,799 loaded only by the preview client reference; `QuotesScreen` stayed because `tests/mkt-014.test.ts` pins it adjacent to the QuoteCorrection components); its review FAILed on docs only (§9.12 still said no separate preview chunk exists) — correction round: see §2.

## 2. Open items, in recommended order

1. **PRF-014 2b correction round** — landed. **2c** and **2d** DONE (see §5). Next is **2e** (zero-hook leaves → server-renderable), **2d** (split `OwnedOverviewScreen`'s FY-range selector out, ~500 lines + `portfolio-value-chart.tsx` behind it), **2e** (shrink the root to chrome + `children`). Each: byte-identical SSR via a `git archive` scratch tree, measured chunk bytes recorded in the entry, `prf-014.test.ts` walker + dist pin.
2. **BRK-019** — READY, ruling recorded; a real implementation task (preview state, supersede path for trades and dividends, sync-result counts, docs). Consider splitting trades vs dividends.
3. **BRK-021** — needs an Orchestrator/owner ruling (keep reuse-and-reset vs mint-new for reversed bundle batches).
4. Residual follow-ups recorded inside DONE entries: BRK-017 (probe redaction misses string ids / `sub_portfolio_id=` / money `total` siblings; numeric-only `total_*` triggers), BRK-020 (guard misses Drizzle-style `.update().set()` writers — none exist), plus the previous handoff's list (BUG-017 pending-run subquery, BUG-012 FX-gap cron cost, BUG-016 advance overflow, receipts' franking column, `@/*` alias blinding the PRF-014 walker).

## 3. Process facts that mattered this session

- **Cherry-pick-then-review on `main` worked again**; every worker ran in `isolation: "worktree"` with `git merge --no-edit main` first. Two workers had no `node_modules` in their worktree and ran `npm install`; a `git archive` scratch tree needs a `node_modules` symlink to the TOP-LEVEL repo's `node_modules` (Node's resolver walks up from the worktree, not from `$TMPDIR`).
- **Workers refuse TASKS.md edits** (worker memory says Orchestrator-only even when the brief asks). Put TASKS.md text in the brief only as a spec; write it yourself.
- **Rate limits killed three agents at once** (session limit). `SendMessage` was unavailable afterwards, so resume was impossible; relaunching fresh worked because every worker had been told to commit early. Keep telling them that.
- **Reviewers share the scratchpad**: one reviewer's probe files landed in another's freshly extracted tree and produced bogus format failures. Tell each reviewer to use a UNIQUELY named scratch directory.
- **Honesty findings again dominated**: a metadata-only change classified as "honours paging"; an EXPLAIN pin built on an index-free table asserting the opposite of production; a guard test that only matched one SQL spelling; a "never handed back" claim disproved with real writers; a doc inventory listing a trigger the code did not implement. Same remedy: mutation-test pins, measure plans on the migrated schema, quote-and-correct rather than rewrite.
- **Sandbox**: `api.sharesight.com` egress and `.claude/worktrees` deletion both need `dangerouslyDisableSandbox` (prompted once each). Everything else ran sandboxed. The python3 shim prints an xcrun cache warning but still runs.
- **Worktree cleanup done**: all 45 agent worktrees removed and their branches deleted after a patch-id check (`git cherry main <branch>`; conflict-resolved cherry-picks show as divergent — verify by task ID on main before deleting). Only `main` and the owner's `UI-005A` remain.

## 4. Environment reminders (still true)

- Wrangler auth expires hourly and is only needed for deploys. Sharesight probes/spikes use `.dev.vars` (`SHARESIGHT_CLIENT_ID`/`_SECRET`, optional `SHARESIGHT_REFRESH_TOKEN`) and the GET-only client; run with the sandbox bypass for network only. Sharesight is read-only, GET-only, non-negotiable.
- `.claude/agent-memory/` is owner-owned and always dirty; never stage it.
- `npx prettier --write TASKS.md` before committing it; `handoff.md` is untracked and also needs formatting or `format:check` goes red.
- `npm test` does not run `tsc`; `npm run typecheck` is in every verification line. `tests/bug-010.test.ts:324` is load-sensitive; rerun alone.
- Time Travel bookmark from two sessions ago, if a rollback to before `0058` is ever needed: `000000fb-00000000-000050da-be8768947e2e6503d75758c11a0c3357`.

## 5. Status at session end

Final `main` is the commit that carries this file (see `git log -1`). Landed after the earlier "stop at the boundary" point, on `Continue`: **PRF-014 2c** (`bf2918c`+`ba8c92a`, PASS), **2d** (`f6be4c6`, PASS; +523 bytes disclosed; design (b) URL-param range deferred), **BRK-019 slice 1** (eight commits ending `270728f`; three review rounds incl. one escalation — see the TASKS entry for the chunk-boundary silent skip and the previewVersion divergence it caught). **2e** and **BRK-019 slice 2** are READY, not started. **BRK-021** still needs an owner ruling.

**Branch situation to know about.** The owner's other session created `pending_dividends` in the shared checkout mid-session (BRK-022 work) and checked it out there. One Orchestrator commit, `757aa20` (PRF-014 2d close-out, docs + TASKS.md), landed on `pending_dividends` before this was noticed; it was re-applied to `main` as `1e1e4ee`, so merging `pending_dividends` later will show a trivial overlap on that commit (identical content). After that, all `main` work was done from a dedicated worktree under the session scratchpad; the shared checkout was left on `pending_dividends` untouched. **Never merge or delete `pending_dividends`; the owner merges it.**

**Agent-memory incident (recovered).** Carrying one escalation worker's memory commit across with `git archive … | tar -x` overwrote the shared checkout's uncommitted reviewer memory with the committed versions. The owner's own 16:41 commit `9fc647b` ("Agent Memory files") had captured everything up to then, so only two reviewer entries (recurring-issues 63c and 66 plus their index lines) were lost; both were replayed from the session's agent transcripts and are back. Rule now in memory: never extract an archive over `.claude/agent-memory/`; use `git show <rev>:<file>` or `git apply` of the memory diff.

Cleanup: all agent worktrees and `worktree-agent-*` branches removed after a per-branch patch-id/task-ID check; remaining branches are `main`, `UI-005A`, `pending_dividends`. Nothing is deployed; migrations `0059`–`0062` are waiting.
