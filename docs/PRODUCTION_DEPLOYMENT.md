# Production Deployment

DEP-002 records the first production deployment profile. Production runs on
the operator's existing dashboard Worker `yieldtome-portfolio` (which carries
the routes, custom domain, and Cloudflare Access configuration) and the real
D1 database `yieldtome-portfolio`
(`17b674b8-034a-4e78-9916-dab14499bb9c`). `wrangler.json`'s `production`
environment pins both, sets `YIELDTOME_RUNTIME_ENV=production` (the Worker
fails closed on Access verification outside `local`), and enables
`MARKET_DATA_PROVIDER=yahoo-best-effort`.

## One-time operator setup

1. Authenticate Wrangler on the deploying machine: `npx wrangler login`
   (interactive), or export a scoped `CLOUDFLARE_API_TOKEN`.
2. Set the Worker secrets. The runtime reads them as **plain string env
   bindings**, so they must be Worker secrets on `yieldtome-portfolio`
   (dashboard: Worker → Settings → Variables and Secrets → type "Secret", or
   `npx wrangler secret put <NAME> --name yieldtome-portfolio`). Secrets Store
   entries are NOT readable by the current code — a Secrets Store binding
   surfaces as an object with an async `get()`, not a string — so copy the
   values into Worker secrets (or file a task to adapt
   `worker/runtime-config.ts` and both provider config modules first).

   Required:
   - `CLOUDFLARE_ACCESS_ISSUER` — `https://<team>.cloudflareaccess.com`
   - `CLOUDFLARE_ACCESS_AUDIENCE` — the Access application's AUD tag
     (Zero Trust → Access → Applications → app → Overview)

   Optional providers (absent means that integration is disabled, never an
   error):
   - `SHARESIGHT_CLIENT_ID`, `SHARESIGHT_CLIENT_SECRET`
   - `YAHOO_COOKIE_T`, `YAHOO_COOKIE_Y`

3. Confirm the Access application covers every hostname that should serve the
   app (`portfolio.greeninvestments.au`). Requests that bypass Access (for
   example the bare `workers.dev` URL, which cannot sit behind an Access app)
   fail closed with an authentication error — safe, but not usable as an
   entry point.

## Route shape warning

The app owns a whole origin: `/`, `/import`, `/api/*`, hashed asset paths,
and `/portfolio/*`. A path-scoped route such as
`*.greeninvestments.au/portfolio/*` sends only `/portfolio/*` requests to the
Worker, so assets, API calls, and every other page fall through to whatever
else serves that host — the app renders broken there. Serve the app only on
full-host routes/custom domains (`portfolio.greeninvestments.au`,
`yieldtome-portfolio.argreen.workers.dev`); remove path-scoped routes.

## Migrate the production database

Per `docs/OPS-002_BACKUP_RESTORE_RUNBOOK.md`, capture a Time Travel bookmark,
then apply every checked-in migration in filename order, stopping on any
failure:

```sh
npx wrangler d1 time-travel info yieldtome-portfolio
for migration in drizzle/*.sql; do
  npx wrangler d1 execute yieldtome-portfolio --remote --yes --file="$migration" || break
done
```

Re-running the full loop is NOT idempotent; on an already-migrated database
apply only the new files. (Local dev tracks applied files via
`scripts/setup-local-db.mjs --apply-pending`; remote tracking is manual until
a task adds bookkeeping.)

Then seed the ISO reference currencies — the migration chain deliberately
leaves `currencies` empty (test fixtures depend on that), and without these
rows the first authenticated request fails closed on JIT user provisioning:

```sh
npx wrangler d1 execute yieldtome-portfolio --remote --yes --file=scripts/seed-reference-currencies.sql
```

The seed is `INSERT OR IGNORE`, so re-running it is a no-op.

## Build and deploy

`CLOUDFLARE_ENV` selects the wrangler environment at build time; the build
writes the resolved config to `dist/server/wrangler.json`:

```sh
CLOUDFLARE_ENV=production npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

Deploying does not touch dashboard-managed routes/custom domains and
preserves existing Worker secrets. Cron triggers (`0 * * * *`,
`25,55 * * * *`) deploy with the Worker.

## Post-deploy checks

1. Open `https://portfolio.greeninvestments.au/` through Access; the
   workspace should render for the authenticated owner (users are provisioned
   just-in-time from the verified Access identity).
2. A request without a valid Access JWT must fail closed.
3. Load real data via the app's export/restore (EXP-001/EXP-002): export from
   the local instance, restore into production through the UI — never by
   copying SQLite files.
