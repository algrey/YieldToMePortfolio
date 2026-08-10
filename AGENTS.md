# YieldToMe engineering instructions

## Mission

Build YieldToMe as a trustworthy private portfolio ledger and reporting product. Financial correctness, provenance, privacy, reversibility, and explicit uncertainty take priority over visual novelty or delivery speed.

## Sources and context

Normative sources:

- `docs/CONSOLIDATED_PRODUCT_SPEC.md`
- `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/MARKET_DATA_STRATEGY.md`
- `docs/CALCULATIONS.md`
- `docs/CSV_IMPORT_SPEC.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `TASKS.md`

The numbered files in `docs/source-evidence/`, `docs/source-evidence/YieldToMe_Visual_Style_Guide.md`, and `docs/Example_Portfolio.csv` are preserved source evidence unless a task explicitly archives or replaces them.

The Orchestrator may read these broadly when planning, resolving architecture/product questions, selecting tasks, or reviewing project-wide behavior. Workers and Reviewers should read only the task, routed normative sections, target code, and minimum nearby dependencies needed to do their job. Do not perform repository-wide discovery merely for general context.

## Agent roles

Roles are model- and vendor-independent. Runtime configuration selects the model; do not encode model choices in this file or `TASKS.md`.

### Orchestrator

Owns planning/architecture, task and dependency selection, context routing, delegation, broad review, cross-task decisions, and `TASKS.md` maintenance. It may inspect the repository and normative sources broadly when needed.

### Worker

Each Worker invocation starts with fresh context containing only the assigned task and context routed by the Orchestrator.

A Worker:

- implements only the assigned task;
- uses minimum necessary context, following imports, types, tests, callers, and established patterns when needed;
- does not select more work, redesign architecture, or materially expand scope;
- does not spawn subagents unless explicitly instructed;
- reports results concisely.

External Worker CLIs follow the same scope, context, verification, escalation, and completion rules. They must not select backlog work or assume Orchestrator responsibilities.

### Reviewer

Each Reviewer invocation starts with fresh context containing only the task, relevant requirements/specifications, implementation diff, and verification evidence. Prefer fresh context for each fix-review cycle unless reconstructing the review packet would cost materially more.

Review independently against acceptance criteria, tests, and applicable security, ownership, financial, privacy, and data-integrity rules. Prefer diff-focused review and targeted source inspection; do not broadly re-index the repository.

A Reviewer may fix a defect only when it is small, local, unambiguous, low-risk, and within task scope; rerun relevant verification afterward. Otherwise return it to the Orchestrator. Do not redesign architecture, add dependencies, broaden scope, perform unrelated refactoring, or implement speculative improvements.

Classify findings as:

- **Blocking:** required before completion.
- **Follow-up:** valid work outside current scope.

Propose follow-up `TASKS.md` work only for material issues, not style preferences or speculative cleanup.

### Implementation escalation

Use the normal Worker for initial implementation and ordinary corrections. Escalate to `escalation-worker` when:

- the same blocking issue remains after two Worker correction attempts;
- successive attempts materially repeat the same failed approach;
- a blocking issue requires substantially deeper reasoning but remains within scope; or
- tests still fail after two reasonable task-scoped correction attempts.

Provide the original task/acceptance criteria, current diff, Reviewer findings, failed verification, and a concise history of attempted approaches. The escalation Worker resolves the existing task only. Always send its result through the normal Reviewer. Do not escalate merely because a task is large, unfamiliar, or failed once.

## Approved stack

- Vinext Next-compatible App Router on Vite, React, strict TypeScript.
- Cloudflare Workers/static assets and Cloudflare Access with Worker-side JWT verification.
- Cloudflare D1 with Drizzle schema/migrations.
- CSS design tokens/responsive components; Tailwind where useful.
- Node test runner plus task-approved domain/integration tools.
- Prettier and ESLint.

R2, KV, Queues, Durable Objects, and Images transformations are not approved by default; use the triggers in `docs/ARCHITECTURE.md`.

## Repository structure

```text
app/       App Router pages, metadata, UI
build/     Cloudflare/Sites build packaging only
db/        Drizzle entry point and approved schemas
docs/      normative specs and preserved evidence
drizzle/   generated, reviewed D1 migrations
public/    public static/PWA assets; never private data
tests/     route/render scaffold tests
worker/    Cloudflare Worker entry and bindings
AGENTS.md  engineering rules
TASKS.md   dependency-ordered executable backlog
```

Create new domain/repository folders only when real task code requires them.

## Development and Git

Core commands:

```sh
npm install
npm run dev
npm run format
npm run format:check
npm run lint
npm run build
npm test
```

Before task completion run `npm run format:check`, `npm run lint`, and relevant tests. Run the production build for routing, Worker, configuration, dependency, or scaffold changes.

Treat each completed repository-changing user prompt and each completed ready `TASKS.md` item as a commit boundary.

- Start with `git status --short`; pre-existing changes belong to the user/another task unless explicitly owned.
- After required verification, stage only task-owned files, including required migrations/docs, and create one focused commit.
- Prefix task commits with the stable ID, e.g. `FND-002A: configure Worker bindings`.
- Never use `git add -A`, `git add .`, or indiscriminate commits in a dirty worktree.
- Never commit `.env*`, secrets, runtime state, exports/uploads, D1 files, provider payload dumps, or another task's changes.
- If overlapping uncommitted changes cannot be separated safely, stop before staging/committing and ask the Orchestrator/user.
- If nothing changed, no commit is required; say so in the completion note.

## Coding conventions

- Keep TypeScript strict; avoid `any` and validate `unknown` at external boundaries.
- Prefer small pure domain functions and explicit typed results for expected missing-data states.
- Use lower-case kebab-case module/component filenames and stable upper-case requirement/task IDs.
- Keep React server components by default; add `"use client"` at the smallest interactive boundary.
- Keep provider, database, and secret code server-only.
- Use semantic HTML, labelled controls, keyboard-visible focus, and non-color status text.
- Never render untrusted raw HTML.
- Comments explain non-obvious financial/security intent, not syntax.
- New dependencies require documented need, exact version, lockfile update, and Cloudflare-runtime verification.

## Non-negotiable rules

- Constrain every portfolio-scoped query/mutation by authenticated internal `user_id`; never trust a client-supplied owner ID.
- Validate Cloudflare Access JWT signature, issuer, audience, expiry, and not-before at the Worker boundary; forwarded identity headers alone are not authentication.
- Store money, price, quantity, and FX values as validated decimal strings; never use JavaScript binary floating point for financial arithmetic.
- Record market-data currency, timezone, source, observation time, ingestion time, and adjustment status.
- Ledger facts are immutable; corrections use reversal/supersession or versioned override, never silent history rewrites.
- Missing quote, FX, cost basis, or dividend data is never zero; show `Price unavailable` when no usable quote exists.
- Retain market-data provenance/freshness internally. Compact views may suppress routine source/delay/timestamp/fallback labels, but explanations must remain accessible and action-required states visible.
- Prefer business-relevant dates in user-facing summaries; retain exact timestamps where audit/provenance requires them.
- A ticker is not a durable security ID; resolve through `securities`, exchange/MIC, currency, and validity-dated provider mappings.
- CSV imports must be staged, previewed, validated, idempotent, batch-attributable, and reversible before affecting totals.
- Service workers must not cache authenticated HTML, API responses, portfolio data, or uploads in v1.
- Keep secrets out of source, logs, client bundles, fixtures, screenshots, and error payloads.

## Scope and token discipline

Implement only ready `TASKS.md` work with its dependencies and acceptance criteria. Keep changes task-sized. If larger decisions/work emerge, record/split them rather than silently expanding scope.

Do not add providers, frameworks, Cloudflare products/bindings, or persistence layers without an architecture decision. Use D1 first; add R2/KV/Queues/Durable Objects/Images only when the documented trigger is met. Do not implement self-service registration while Cloudflare Access is the only identity gateway. Do not call a price `live` without contractual/timestamp evidence.

Prefer targeted file reads, symbol searches, narrow listings, `git diff`, `git status --short`, and task-scoped history. Search large files for the relevant symbol/heading/requirement before reading broadly. `TASKS.md` `Context`, `Likely code`, and `Verification` are routing guidance, not hard boundaries; inspect unnamed files only when directly needed for dependencies, callers, patterns, tests, or acceptance criteria.

Ignore by default unless directly relevant: `node_modules/`, `.git/`, `dist/`, `.next/`, coverage, temp/cache directories, `*.log`, `build/`, lockfiles, and generated migration output.

Stop and report to the Orchestrator rather than inventing a decision when work requires an undocumented architecture/product assumption, conflicting normative requirements, a new dependency/Cloudflare product, an unplanned persistence/schema approach, or material scope expansion.

## Testing and definition of done

Test proportionally to affected behavior, including where applicable:

- decimal calculations, FIFO, FX, dividends, dates, and import normalization;
- D1 constraints, idempotency, ownership isolation, audit/reversal, and provider retries;
- no identity, wrong audience, expired token, and cross-user access attempts;
- CSV BOM/line-ending/header/date/duplicate/enum/mapping/multi-currency edge cases;
- empty, error, missing-data, and stale states;
- rendered HTML smoke tests for scaffold/routing changes.

A task is done only when acceptance/requirement links are satisfied, relevant verification passes, required migrations/docs are included, security/ownership and applicable financial/data-integrity paths are tested, operational/data-migration consequences are documented, implementation and migrations are committed together, and unrelated user/source changes are preserved.

## Documentation and protected files

When behavior changes, update the applicable normative document, acceptance criteria, and task mapping in the same change set. Update:

- schema decisions → `docs/DATA_MODEL.md`
- calculations → `docs/CALCULATIONS.md`
- imports → `docs/CSV_IMPORT_SPEC.md`
- providers → `docs/MARKET_DATA_STRATEGY.md`
- durable architecture decisions/rejected alternatives → `docs/ARCHITECTURE.md`

Keep `TASKS.md` dependencies/status/evidence accurate. Preserve stable requirement IDs; deprecate rather than reuse them. Mark assumptions/missing evidence explicitly and never rewrite inference as observation.

Do not modify preserved source evidence (`docs/source-evidence/01_*` through `docs/source-evidence/04_*`, `docs/source-evidence/YieldToMe_Visual_Style_Guide.md`, `docs/Example_Portfolio.csv`) without explicit task justification. Do not hand-edit generated migration SQL without documenting why and rerunning migration tests. Do not incidentally change `.openai/hosting.json`, Worker bindings, Access issuer/audience behavior, provider configuration, calculation rules, or retention/deletion behavior.

## Completion output

Worker reports stay concise:

- files changed;
- substantive implementation decisions;
- verification commands/results;
- blockers, uncertainties, or required Orchestrator decisions.

Do not restate the task, unchanged architecture, large diffs, or routine implementation details unless requested.
