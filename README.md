# YieldToMe

YieldToMe is a private, multi-currency portfolio tracking application being rebuilt from a screen-recorded reference and an exported CSV. This repository currently contains the consolidated product and engineering specification plus a deliberately minimal Vinext/Cloudflare scaffold. Portfolio features are not implemented yet.

## Start here

- [Consolidated product specification](docs/CONSOLIDATED_PRODUCT_SPEC.md)
- [Requirements and acceptance criteria](docs/REQUIREMENTS_AND_ACCEPTANCE_CRITERIA.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA_MODEL.md)
- [Market-data strategy](docs/MARKET_DATA_STRATEGY.md)
- [Calculations](docs/CALCULATIONS.md)
- [CSV import specification](docs/CSV_IMPORT_SPEC.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Executable backlog](TASKS.md)
- [Agent instructions](AGENTS.md)

The original reverse-engineering notes and visual guide remain in `docs/source-evidence/`, and the sample CSV remains in `docs/`, as source evidence.

## Local development

Requirements: Node.js 22.13 or later and npm.

```sh
npm install
npm run dev
```

Then open `http://localhost:3000`.

For running the full app locally — including a real local database, or a
read-only fixture preview — see [Local development guide](docs/LOCAL_DEVELOPMENT.md).

Useful checks:

```sh
npm run lint
npm run build
npm test
```

No Cloudflare project, D1 database, market-data account, or production environment is created by this scaffold. Configuration keys are documented in `.env.example`; local identity is intentionally fail-closed until an authentication task implements the development boundary.

## Current boundary

The scaffold proves routing, responsive styling, installable-web-app metadata, a safe service-worker foundation, and the Cloudflare build target. It does not yet implement authentication, persistence, CSV import, calculations, quotes, dividends, alerts, or deployment.
