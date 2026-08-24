# Running YieldToMe locally

This guide covers running the app on your own machine for manual testing. There
are two options:

1. **Fixture preview** — fastest way to see the UI; read-only sample data, no
   database. Good for reviewing styling and layout.
2. **Real DB-backed dev server** — the full app on the actual Cloudflare stack
   (workerd + Miniflare's local D1), with a real database you can write to
   (create portfolios, import CSV, etc.).

> **Why this needs setup at all.** The Worker (`worker/index.ts`) fails closed on
> Cloudflare Access for **every** request and has **no** local bypass, by design.
> In `local` mode with no Access config it returns `503`; with config but no
> token it returns `401`. Do not add a dev bypass to the Worker — that is exactly
> what the security hardening prevents. Both options below satisfy the real
> verifier with a signed test principal instead of weakening it.

Requirements: Node.js 22.13+ (tested on Node 26) and npm.

```sh
npm install
```

---

## Option 1 — Fixture preview (no database)

```sh
npm run build
npm run preview:harness
```

Then open **http://127.0.0.1:8788/portfolio/preview/overview**.

The harness (`scripts/preview-harness.mjs`) serves the built Worker with a signed
test principal and a deterministic mocked JWKS. It passes **no** database
binding, so only the fixture routes render:

- `/portfolio/preview/overview`
- `/portfolio/preview/holdings`
- `/portfolio/preview/quotes`
- `/portfolio/preview/news`
- `/portfolio/preview/details`

The root `/` and any other DB-backed route correctly show
"Portfolio data unavailable" here — that is expected, not a bug. Use Option 2 for
anything that reads or writes real data.

Rebuild (`npm run build`) and restart the harness to pick up code changes.

The harness fails closed at startup if `dist/server` and `dist/client` come from different builds (e.g. an interrupted or partial `npm run build`) — rerun `npm run build` and restart if you see that message.

---

## Option 2 — Real DB-backed dev server

This runs `vinext dev` (the real Cloudflare runtime with a local D1 database)
behind a small auth gateway that injects a valid Access token, so the Worker
stays unmodified.

### One-time / when you want a clean database

With the dev server **stopped**:

```sh
node scripts/setup-local-db.mjs
```

**The bare command now refuses to run against a database that holds real
owner data.** Before touching anything, it opens the existing Miniflare D1
file (`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`)
read-only and counts rows in `portfolios`, `transactions`, `import_batches`,
and `dividend_manual_records`. If any of those are non-zero, it prints exactly
what it would destroy and exits `1` **without touching the file** — no wipe,
no backup needed because nothing happened. An empty or absent database
proceeds with no friction, exactly like before.

Pick one of the two flags depending on what you actually want:

- **`--apply-pending`** — migrate the existing database **in place**, without
  wiping it. Use this after `git pull` brings new files into `drizzle/` and
  you want to keep your local portfolios/transactions/imports. It tracks
  which migrations have already run in a local-only bookkeeping table
  (`_local_dev_migrations`, never part of the reviewed schema); a database
  from before this table existed gets it backfilled from a small set of
  recent structural landmarks (see `scripts/setup-local-db-lib.mjs`'s
  `BACKFILL_LANDMARKS`). If your database's state doesn't match any known
  landmark, the script refuses rather than guess — fall back to `--force` in
  that case.

  ```sh
  node scripts/setup-local-db.mjs --apply-pending
  ```

- **`--force`** — a genuine reset: wipe the database and rebuild it from
  every migration, seeding reference currencies. Use this when you actually
  want to throw your local data away (e.g. it's corrupted, or you want a
  known-clean baseline). When the database being wiped holds any user data,
  the script copies the sqlite file (plus `-wal`/`-shm` if present) to
  `<name>.<ISO-timestamp>.backup` in the same directory **first**, and prints
  the backup path.

  ```sh
  node scripts/setup-local-db.mjs --force
  ```

The database persists in `.wrangler/`, so you only need to rerun this to
change its state — skip it entirely to keep working against what's already
there.

> `setup-local-db.mjs` applies migrations with `node:sqlite`, not
> `wrangler d1 execute`. `wrangler d1 execute` wraps each file in a transaction,
> where the table-rebuild migrations' `PRAGMA foreign_keys=OFF` is a no-op and
> migration `0009` fails with `foreign key mismatch`. Applying via `node:sqlite`
> honours the in-file pragma, matching how the test suite migrates.

### Configuration: `.dev.vars`

The setup relies on a `.dev.vars` file at the repo root (gitignored — local
only, not real secrets):

```sh
CLOUDFLARE_ACCESS_ISSUER=http://127.0.0.1:8799
CLOUDFLARE_ACCESS_AUDIENCE=yieldtome-local-dev
YIELDTOME_WORKERS_PLAN=paid
```

The issuer/audience must match the gateway. As of `IMP-010B` (2026-08-25), the
ledger CSV import path's byte-decode/row-split work runs in the browser, so it
no longer fails closed on `YIELDTOME_WORKERS_PLAN=free` (see
`docs/ARCHITECTURE.md`'s `IMP-010B` entry) -- `YIELDTOME_WORKERS_PLAN` is
still validated (must be `free` or `paid` outside `local`, where it defaults
to `free`) but is otherwise advisory/unused metadata for behavior; either
value works locally.

Repository write paths use D1's `batch()` API for atomic multi-statement
writes (D1 rejects SQL-level `BEGIN`/`COMMIT`/`ROLLBACK`), so local D1 and
production D1 use the same atomic write path — no local-only shim is needed.

### Run it (two terminals)

Terminal 1 — the dev server (port 3000):

```sh
npm run dev
```

Terminal 2 — the auth gateway (port 8799):

```sh
node --experimental-strip-types scripts/dev-auth-gateway.mjs
```

Then open **http://127.0.0.1:8799**.

**Always use the gateway port `8799`, not `3000`.** Port 3000 is the raw Worker
and returns `401` (no token). The gateway (`scripts/dev-auth-gateway.mjs`) serves
the JWKS the Worker fetches and adds a freshly signed `cf-access-jwt-assertion`
to every proxied request. The gateway can be stopped and restarted independently
of `npm run dev`: its signing key IDs are unique per process, so a restart
forces the Worker to refetch the JWKS instead of verifying against a stale
cached key.

On first load the app just-in-time provisions an active user
(`local-dev@example.com`, home currency AUD) in the local D1, then shows the
empty "No portfolios yet" state. From there you can:

- create a portfolio with the **+** control, or
- open **Import** and upload `docs/Example_Portfolio.csv`. Note the import is
  **review-only** in this build: the CSV uploads, parses, stages all rows, and
  renders the review, but the app does not yet wire the mapping-resolution and
  commit steps that turn a reviewed batch into holdings/transactions, so it does
  not populate the portfolio views yet.

### Notes

- **Ports need to bind.** Run the dev server and gateway from a normal terminal.
  If a sandbox blocks binding a listening socket, you'll see
  `listen EPERM`/`EACCES` — disable the sandbox for those commands.
- **HMR websocket warning.** Vite's hot-reload websocket may log a console
  warning through the proxy. It's harmless; the page still updates on navigation.
- **What is _not_ set up:** no real Cloudflare account, no remote D1, no live
  market data (`MARKET_DATA_PROVIDER=disabled`), and no production Access. For a
  real Cloudflare deployment see [PREVIEW_DEPLOYMENT.md](PREVIEW_DEPLOYMENT.md).

### Local dev files

| File                             | Purpose                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `.dev.vars`                      | Local Access issuer/audience + Workers plan (gitignored)                         |
| `scripts/setup-local-db.mjs`     | Guards, migrates (`--apply-pending`), or resets+seeds (`--force`) the local D1   |
| `scripts/setup-local-db-lib.mjs` | Pure guard/backfill/pending-migration decision logic behind `setup-local-db.mjs` |
| `scripts/dev-auth-gateway.mjs`   | JWKS + token-injecting proxy in front of `vinext dev`                            |
