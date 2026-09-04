# Session handoff — 2026-09-03 → 2026-09-04

Orchestrator session. Started from the previous handoff's instruction to audit the Sharesight sync, page loads and data-integrity paths, then work the backlog. 21 tasks landed on `main` in 71 commits, every one through worker → reviewer rounds; nothing is deployed yet. This is the context a fresh session needs.

---

## 1. What is on `main` and NOT deployed

Everything below is committed and reviewed but **not deployed**. Three migrations must be applied first, in order, with a Time Travel bookmark taken before each:

| Migration | Task    | Shape                                                                                     |
| --------- | ------- | ----------------------------------------------------------------------------------------- |
| `0059`    | BUG-012 | new sibling table `portfolio_value_history_unresolvable` (+ purge-lock triggers)          |
| `0060`    | BUG-018 | `transactions_portfolio_source_reference_unique` narrowed to `WHERE status <> 'reversed'` |
| `0061`    | OPS-005 | four nullable `import_batches` columns (bundle ref digests + counts), plain ADD COLUMN    |

Deploy sequence (unchanged from the previous handoff): owner runs `! npx wrangler login`; `npx wrangler d1 time-travel info` → bookmark; `npx wrangler d1 execute yieldtome-portfolio --remote --file=drizzle/0059_*.sql` (then 0060, 0061); `CLOUDFLARE_ENV=production npm run build`; `npx wrangler deploy --config dist/server/wrangler.json`. **Operational rule from BUG-018:** a chunked CORE restore that was interrupted before this deploy must be started over, not resumed (OPS-005 removes the condition once live).

Tasks done this session (all `DONE` in `TASKS.md` with full round records):

- Sharesight sync: **BRK-014** (honest new-vs-already-imported counts; five rounds), **BRK-016** (token provider memoised per isolate — one OAuth exchange per token lifetime instead of one per cron tick/gate/sync; parallel trade+payout fetch; 401 invalidation), **BRK-015 (b)(c)**.
- Data integrity: **BUG-016** (chunked reversal no longer hard-deletes dividends on the first chunk; batch-wide run advancement), **BUG-017** (stale projection publication now self-heals or shows "Recalculating…"), **BUG-018** (reversed trades can be re-imported; DFS chain order so the shape restores), **BUG-019** (atomic restore scaffold), **BUG-020** (calculation-run tie-break on rowid), **BUG-012** (persist unresolvable value-history dates; four rounds), **BUG-014/021/022/023** (dividend amounts bounded at the read path's decimal limits at every writer; unreadable stored amounts isolated per record and never rendered as zero or a default).
- Page load / free-plan budget: **PRF-008** (Sharesight price gate off `/income*`: 86 → 33 statements cold), **PRF-011**, **PRF-012** (`/income` 33 → 26, depth 11 → 9), **PRF-013** (`/holdings/:id/dividends` 21 → 15), **PRF-009** (single-pass finalize query), **PRF-015** (shared query module kills the test-mirror drift), **PRF-014 step 1** (prototype fixture data out of the production bundle, −6 KB).
- Ops: **OPS-005** (chunked restore resumes by server-computed missing refs; finalize cross-checks persisted digests).

## 2. Open items, in recommended order

1. **BRK-020** — identical Sharesight re-sync after a reversal reuses the terminal `reversed` batch, so BUG-018's unblocked commit is still unreachable on that route. **The owner started this in a separate session (`task_9bfd4cd7`)** during this session; check that session's branch before doing anything. If it produced a commit, cherry-pick it onto `main` and review it the same way (the whole session used cherry-pick-then-review for worktree branches).
2. **BRK-019** — needs an OWNER decision: what does accepting a value-corrected Sharesight row do (recommendation in the entry: an explicit needs-decision row with a one-click supersede, never an auto-write). Also covers the `paidOnDate` component of the payout identity key.
3. **BRK-017** — Sharesight pagination is unverified; needs a live GET probe (owner must `wrangler login` first; probes need `dangerouslyDisableSandbox`).
4. **PRF-014 step 2** — push the `"use client"` boundary below `portfolio-shell.tsx`; needs scoping. A discriminated props union for the shell is a recorded small follow-up.
5. Recorded follow-ups inside DONE entries worth promoting: the BUG-017 pending-run subquery reads every superseded run of the portfolio (needs an index or pruning); BUG-012's residual FX-gap cron cost; BUG-016's 25-portfolio advance overflow prefers dividend portfolios by id; receipts' franking column is unsanitised (unreachable today); a `@/*` alias would blind PRF-014's source walker.

Older PLANNED items (IMP-010, EXP-005, FRAC-001, MKT-019, IMP-008, SPK-003, DIV-016 marked in progress from an earlier session) are unchanged.

## 3. Process facts that mattered this session

- **Parallel execution worked, with rules.** After the owner asked for parallelism, workers ran in isolated worktrees (`isolation: "worktree"`), committed on their branch, and the Orchestrator cherry-picked onto `main` and then reviewed on `main`. Two gotchas: the first batch of worktrees was created from the session-start commit, not current `main` (tell workers to `git merge --no-edit main` first), and twice the worktree tool refused and the agent had to `git worktree add` under the scratchpad itself. 35 agent branches and ~36 worktrees are left behind — prune with `git worktree prune` / `git branch -D worktree-agent-*` once you are sure nothing is unmerged.
- **Reviewers must never `git stash` in the shared checkout.** Two reviewers captured other agents' work that way early on. The rule now in every review prompt: use `git archive <commit> -o $TMPDIR/x.tar` + `tar -x` scratch trees with a `node_modules` symlink. Three docs sentences had to be corrected because a worker recorded "confirmed via git stash".
- **`npm test` does not run `tsc`.** One round shipped a type error the suite could not see. `npm run typecheck` is now in every verification line.
- **Rate limits killed agents mid-flight three times.** A worker with uncommitted worktree changes can be resumed with `SendMessage` (context intact); a killed reviewer is relaunched fresh. Check the worktree's `git status` first.
- **Reviewer honesty findings dominated.** Most FAILs were "the code is right, the claim is wrong": test counts described as pre-fix failures that were guards, `git stash` provenance, doc sentences left describing a retired mechanism, attributions to the wrong test file. The fix pattern the repo now uses everywhere: append a dated "(corrected YYYY-MM-DD after review: …)" marker, never rewrite prior text.
- **Silent-skip pattern, six more instances**, all caught in review, none by tests: a `[MIN,MAX]` range that over-deleted a whole series; a suppression set that was really a comparison set; a `LIMIT` with no `ORDER BY` truncating invalidations deterministically every hour; a count-slice resume that drops rows across an ordering change; an unreadable value nulled and then filled from a default; an INNER JOIN dropping unresolved rows so a cap fired on one path only. Same lesson as last time: ask what becomes invisible, and make the reviewer construct it.
- Owner tooling drops `ds-bundle/`, `.ds-sync/`, `.design-sync/` and a nested `.claude/worktrees/` into the repo; ESLint and Prettier now ignore them (`eslint.config.mjs`, `.prettierignore`). `.gitignore` carries the owner's own uncommitted edit for the same — leave it.

## 4. Environment reminders (still true)

- Wrangler auth expires hourly; `api.sharesight.com` and the Cloudflare API are outside the sandbox allowlist. Sharesight is read-only, GET-only, non-negotiable.
- `.claude/agent-memory/` is owner-owned and always dirty; never stage it.
- `npx prettier --write TASKS.md` before committing it.
- `tests/bug-010.test.ts:324` has a load-sensitive 20 ms wall-clock assertion that fails under concurrent suites; rerun alone.
- Time Travel bookmark from the previous session, if a rollback to before `0058` is ever needed: `000000fb-00000000-000050da-be8768947e2e6503d75758c11a0c3357`.
