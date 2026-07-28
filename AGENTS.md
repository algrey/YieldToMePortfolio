# YieldToMe engineering instructions

## Mission

Build YieldToMe as a trustworthy, private portfolio ledger and reporting product. Financial correctness, provenance, privacy, reversibility, and explicit uncertainty take priority over visual novelty or delivery speed.

## Read before changing code

1. `docs/CONSOLIDATED_PRODUCT_SPEC.md`
2. `docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATA_MODEL.md`
5. `docs/MARKET_DATA_STRATEGY.md`
6. `docs/CALCULATIONS.md`
7. `docs/CSV_IMPORT_SPEC.md`
8. `docs/IMPLEMENTATION_PLAN.md`
9. `TASKS.md`

The numbered files already in `docs/` and `YieldToMe_Visual_Style_Guide.md` are source evidence. Preserve them unless a task explicitly archives or replaces them.

## Approved stack

- Vinext’s Next-compatible App Router on Vite, React, and strict TypeScript.
- Cloudflare Workers and static assets.
- Cloudflare Access as the invited-user gateway, with Worker-side JWT verification.
- Cloudflare D1 with Drizzle schema/migrations.
- CSS design tokens and responsive components; Tailwind is available but not required for every style.
- Node’s test runner for scaffold smoke tests; domain/integration tools may be added only by an approved task.
- Prettier and ESLint as baseline formatting/lint gates.

Cloudflare R2, KV, Queues, and Durable Objects are not approved by default. Use the architecture triggers before adding them.

## Repository structure

```text
app/                    App Router pages, metadata, and UI components
build/                  Cloudflare/Sites build packaging only
db/                     Drizzle entry point and approved schemas
docs/                   normative specs plus preserved source evidence
drizzle/                generated, reviewed D1 migrations
public/                 public static/PWA assets; never private data
tests/                  route/render scaffold tests
worker/                 Cloudflare Worker entry and bindings
AGENTS.md                engineering rules and decision log
TASKS.md                 executable, dependency-ordered backlog
```

Create domain/repository folders only when their task introduces real code; do not pre-fill speculative architecture with empty modules.

## Development commands

```sh
npm install
npm run dev
npm run format
npm run format:check
npm run lint
npm run build
npm test
```

Before completing a task, run `npm run format:check`, `npm run lint`, and the relevant tests. Run the production build for routing, Worker, configuration, dependency, or scaffold changes.

## Coding conventions

- TypeScript strictness stays enabled. Avoid `any`; validate `unknown` at every external boundary.
- Prefer small pure domain functions and explicit typed results over exceptions for expected missing-data states.
- Use lower-case kebab-case filenames for components/modules and stable upper-case requirement/task IDs in documentation.
- Keep React server components by default; add `"use client"` only at the smallest browser-interactive boundary.
- Keep provider, database, and secret code server-only. Never import it into a client component.
- Use semantic HTML, labelled controls, keyboard-visible focus, and non-color status text.
- Do not render raw HTML from users/providers/imports.
- Comments explain financial/security intent and non-obvious constraints, not line-by-line syntax.
- A new dependency needs a documented need, exact version, lockfile update, and Cloudflare-runtime check.

## Non-negotiable rules

- Keep every user’s rows isolated. Every portfolio-scoped query and mutation must be constrained by the authenticated internal `user_id`; never trust a client-supplied owner ID.
- Validate the Cloudflare Access JWT at the Worker boundary, including signature, issuer, audience, expiry, and not-before claims. A forwarded email/header alone is not authentication.
- Store monetary, price, quantity, and FX values as validated decimal strings. Do not use JavaScript binary floating point for financial arithmetic.
- Record the currency, timezone, source, observation time, ingestion time, and adjustment status for market data.
- Preserve immutable ledger facts. Corrections create a reversal/superseding record or a versioned override; they do not silently rewrite history.
- Make missing or stale data visible. Never turn a missing quote, FX rate, cost basis, or dividend into zero.
- Label estimates, delayed prices, stale data, partial history, and incomplete return metrics in the interface.
- A ticker is not a durable security identifier. Resolve holdings through `securities`, exchange/MIC, currency, and validity-dated provider mappings.
- CSV imports must be staged, previewed, validated, idempotent, attributable to a batch, and reversible before they affect portfolio totals.
- Service workers must not cache authenticated HTML, API responses, portfolio data, or uploaded files in v1.
- Keep secrets out of source, logs, client bundles, fixtures, screenshots, and error payloads.

## Scope discipline

- Implement only a task marked ready in `TASKS.md`, including its dependencies and acceptance criteria.
- Keep changes session-sized. If a task reveals a larger decision, update the decision log and split the work rather than quietly expanding scope.
- Do not add providers, frameworks, Cloudflare products, or persistence layers without an architecture decision.
- Use D1 first. Add R2, KV, Queues, or Durable Objects only when the documented trigger is met.
- Do not call a price “live” unless the contract and data timestamps prove it. Prefer “as of”, “delayed”, or “previous close”.
- Do not implement self-service registration while Cloudflare Access remains the only identity gateway.

## Definition of done

A task is done only when:

- its requirement IDs are linked;
- implementation and migrations are committed together;
- authorization and ownership failure paths are tested;
- calculation or import behavior has deterministic fixtures where applicable;
- empty, error, missing-data, and stale states are handled;
- lint, type/build checks, and relevant tests pass;
- operational or data-migration consequences are documented;
- no unrelated source documents or user changes are overwritten.

## Testing expectations

- Unit-test decimal calculations, FIFO matching, FX conversion, dividend estimation, date boundaries, and import normalization.
- Integration-test D1 constraints, idempotency, ownership isolation, audit records, reversal, and provider retry behavior.
- Test routes with no identity, wrong audience, expired tokens, and attempts to access another user’s IDs.
- Test CSVs with BOMs, CRLF/LF, padded headers, blank definition dates, mixed date formats, duplicate rows, bad enums, missing mappings, and multi-currency values.
- Build and run the rendered HTML smoke test for every scaffold or routing change.

## Documentation update rules

- A behavior change updates its normative document, requirement acceptance criteria, and task mapping in the same change set.
- A schema/calculation/import/provider decision updates `DATA_MODEL.md`, `CALCULATIONS.md`, `CSV_IMPORT_SPEC.md`, or `MARKET_DATA_STRATEGY.md` respectively.
- Add durable architecture decisions to this file’s decision log and explain rejected alternatives in `ARCHITECTURE.md`.
- Mark assumptions and missing evidence explicitly; never rewrite an inference as an observation.
- Preserve stable requirement IDs. Deprecate with a note rather than reusing an ID for a different meaning.
- Keep `TASKS.md` dependencies/status/evidence accurate after implementation.

## Files requiring explicit justification

- Do not modify the preserved source evidence: `docs/01_*`, `docs/02_*`, `docs/03_*`, `docs/04_*`, `docs/YieldToMe_Visual_Style_Guide.md`, or `docs/Example_Portfolio.csv`.
- Do not hand-edit generated migration SQL after generation without documenting why and re-running migration tests.
- Do not change `.openai/hosting.json`, Worker bindings, Access audience/issuer behavior, provider-rights flags, calculation rules, or retention/deletion behavior as incidental cleanup.
- Never commit `.env*` secrets, runtime state, exports, uploaded CSVs, D1 files, provider payload dumps, or access tokens.

## Decision log

- `2026-07-28`: Vinext/Next-compatible App Router on Cloudflare Workers is the application foundation.
- `2026-07-28`: D1 is the system of record and initial cache; no R2/KV/Queues at scaffold stage.
- `2026-07-28`: Cloudflare Access is acceptable for a private, administrator-invited first release, but is not an in-app account-management system.
- `2026-07-28`: active quote views prefer lawfully sourced approximately 20-minute-delayed international data, with clearly labelled EOD/manual fallback. Free hosted-display rights are not assumed and production remains rights/cost gated.
- `2026-07-28`: the supplied 17-column CSV header is the complete supported import contract; fields visible only in other references are not inferred.
- `2026-07-28`: EODHD is the preferred global delayed/EOD/FX provider candidate. Yahoo Finance and undocumented community endpoints are excluded; production EODHD activation remains conditional on written hosted-display, storage, exchange-coverage, retention, and pricing terms.
- `2026-07-28`: FIFO is the first cost-basis method; the stored accounting method remains explicit for future alternatives.
- `2026-07-28`: Offline v1 is a safe static shell only, not offline access to private portfolio data or offline mutations.
- `2026-07-28`: sample screens/video and the sample CSV are independent layout/schema fixtures; differences in their portfolio contents are expected and must not be reconciled or carried as product uncertainty.
- `2026-07-28`: user settings define home currency. Native ledger/market facts remain native, while holding projections/snapshots store home-currency reporting values; the native/home menu changes display only.
- `2026-07-28`: future broker sync must enter through owner-scoped encrypted connections and staged/idempotent ledger and market-data adapters; broker positions never silently overwrite holdings.
