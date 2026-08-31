import { headers } from "next/headers";
import {
  decodeAccessJwtBase64Url,
  type VerifiedAccessPrincipal,
} from "../domain/auth/access-jwt";
import { resolveAuthenticatedRequestContext } from "../domain/auth/request-context";
import { VERIFIED_PRINCIPAL_HEADER } from "../domain/auth/verified-principal-header";
import {
  REQUEST_NOW_HEADER,
  resolveRequestNow,
} from "../domain/observability/index.ts";
import {
  createOwnedPortfolioRepository,
  createOwnedUserSettingsRepository,
  type OwnedPortfolioRecord,
} from "../db/repositories/owned-portfolios";
import { createOwnedWorkspace } from "./owned-workspace";
import type { OwnedWorkspace } from "./components/portfolio-shell";
import { loadOwnedWatchlist } from "./owned-watchlist";
import { loadOwnedHoldings } from "./owned-holdings";
import { loadOwnedRealisedGainTotals } from "./owned-capital-gains";
import { buildHoldingsSummaryFooter } from "./owned-holdings-summary";
import { createOverviewData } from "./overview-read-model";
import { loadHistoricalPortfolioValueSeries } from "./historical-portfolio-value.ts";
import { loadUsdAudRate } from "./authenticated-fx-rate.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";

function isPrincipal(value: unknown): value is VerifiedAccessPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.tokenType === "app" &&
    typeof candidate.issuer === "string" &&
    typeof candidate.audience === "string" &&
    typeof candidate.subject === "string" &&
    (candidate.email === null || typeof candidate.email === "string") &&
    (candidate.issuedAt === null || typeof candidate.issuedAt === "number") &&
    typeof candidate.notBefore === "number" &&
    typeof candidate.expiresAt === "number" &&
    typeof candidate.keyId === "string"
  );
}

// PRF-002 (owner-reported production CPU-limit failure across every
// authenticated page): six section pages under `/portfolio/:id/*`
// (gains, income, income/dividends, income/assumptions,
// income/multi-year, and `details` via `app/portfolio-inspection.ts`)
// call THIS function purely as an auth/ownership gate (no `includeX`
// option) and then call `app/portfolio-actions.ts`'s
// `getAuthenticatedSqlContext(portfolioId)` A SECOND TIME to obtain the
// `SqlClient`/`userId` their own section-specific loader needs --
// re-running `resolveAuthenticatedRequestContext` (identity lookup PLUS
// `touchWithAudit`'s 3-statement UPDATE/UPDATE/INSERT batch) from
// scratch, doubling that cost on every one of those page loads for no
// behavioural benefit (both resolutions authenticate the SAME principal
// against the SAME portfolio id in the SAME request). `sqlContextOut` is
// an optional output slot: when supplied, this function fills it in with
// the SAME `client`/`userId` it already resolved for its own use, so
// those callers can drop their second `getAuthenticatedSqlContext` call
// entirely (see each affected page's own comment). Never embedded in the
// `OwnedWorkspace` return value itself -- that DTO crosses into "use
// client" components, and a raw `SqlClient` must never ride along.
export type AuthenticatedWorkspaceSqlContext =
  { ok: true; client: SqlClient; userId: string } | { ok: false };

function unavailableWorkspace(message: string): OwnedWorkspace {
  return {
    status: "unavailable",
    message,
    activePortfolio: null,
    portfolios: [],
    quotes: [],
    quoteViewState: "empty",
  };
}

export async function loadAuthenticatedWorkspace(
  requestedPortfolioId?: string,
  options: {
    includeQuotes?: boolean;
    includeOverview?: boolean;
    includeHoldings?: boolean;
  } = {},
  // PRF-002: see `AuthenticatedWorkspaceSqlContext`'s doc comment above --
  // an optional output slot letting the auth-gate-only callers recover the
  // resolved `client`/`userId` without a second, duplicate
  // `resolveAuthenticatedRequestContext` call.
  sqlContextOut?: { current: AuthenticatedWorkspaceSqlContext },
  // UI-051 (owner-directed): the workspace root (`app/page.tsx`) now lands
  // the owner on their first portfolio's Holdings tab instead of rendering
  // Overview in place, once a portfolio exists. This output slot is filled
  // the moment `result` (below) is known -- BEFORE the settings/usdAudRate/
  // portfolio-list reads that follow -- with the SAME "first" portfolio id
  // `result.context.activePortfolio` already resolved (identical ordering to
  // every other caller's implicit default: `resolveAuthenticatedRequestContext`'s
  // own `list(userId)[0]` fallback), or `null` when there is nothing to
  // redirect to. When it resolves non-null, this function returns
  // immediately with a throwaway placeholder workspace (the caller redirects
  // before ever looking at it) rather than paying for the rest of this
  // function's reads -- a populated-portfolio visit to `/` now costs nothing
  // beyond the identity+portfolio lookup every authenticated page already
  // pays. When it resolves `null` (no active portfolio -- a fresh install,
  // UI-049 -- or the request failed auth/D1), this function falls through to
  // its normal full load exactly as before, so those paths' cost is
  // completely unchanged. Deliberately a SEPARATE output slot rather than a
  // second call to this function or to `resolveAuthenticatedRequestContext`:
  // that identity resolution's `touchWithAudit` write is not safe to run
  // twice in one request (it would double-insert the audit-log row), so
  // there must only ever be one resolution per request.
  landingRedirectOut?: { current: string | null },
): Promise<OwnedWorkspace> {
  const requestHeaders = await headers();
  const principalHeader = requestHeaders.get(VERIFIED_PRINCIPAL_HEADER);
  if (!principalHeader) {
    if (sqlContextOut) sqlContextOut.current = { ok: false };
    return unavailableWorkspace("Authentication is unavailable.");
  }

  let principal: VerifiedAccessPrincipal;
  try {
    const decoded = decodeAccessJwtBase64Url(principalHeader);
    if (!isPrincipal(decoded)) throw new Error("Invalid verified principal.");
    principal = decoded;
  } catch {
    if (sqlContextOut) sqlContextOut.current = { ok: false };
    return unavailableWorkspace("Authentication is unavailable.");
  }

  try {
    const { getSqlClient } = await import("../db/d1-sql-client");
    const client = await getSqlClient();
    const result = await resolveAuthenticatedRequestContext(
      client,
      principal,
      requestedPortfolioId,
    );
    // UI-051: see `landingRedirectOut`'s own doc comment above -- checked
    // immediately once `result` is known, before any further D1 reads.
    if (landingRedirectOut) {
      landingRedirectOut.current =
        result.ok && result.context.activePortfolio
          ? result.context.activePortfolio.id
          : null;
      if (landingRedirectOut.current !== null) return unavailableWorkspace("");
    }
    // Resolved once, server-side, per request -- this is the single "now"
    // FY window math anchors on (see domain/calculations/financial-year.ts
    // and docs/CALCULATIONS.md §9). It must never be re-derived from a
    // history point's date (stale data would then falsely rename/mislabel
    // the FY) or recomputed client-side (non-deterministic across
    // server/client render, and drifts from the request's real "now").
    //
    // BUG-002 (hydration half): read from the Worker-stamped
    // `REQUEST_NOW_HEADER` (see `worker/index.ts` and
    // `domain/observability/request-correlation.ts`) rather than calling
    // `new Date()` directly here -- Vinext invokes this async Server
    // Component TWICE per request (a discarded probe pass, then the real
    // render), so a bare `new Date()` here could return two different
    // instants for the SAME request if a second/minute boundary fell
    // between the two invocations, desyncing the server-rendered HTML from
    // the RSC flight payload (a React hydration mismatch). The header
    // guarantees both invocations read the identical instant. Computed here
    // (headers-only, no DB) rather than after the reads below so the
    // `usdAudRate` read can use it without waiting on `settings`/
    // `portfolioRecords` first. `resolveRequestNow` falls back to a fresh
    // `new Date()` only when the header is absent/malformed (tests, dev
    // paths that bypass `worker/index.ts`) -- it never throws on a missing
    // header.
    const nowInstant = resolveRequestNow(
      requestHeaders.get(REQUEST_NOW_HEADER),
    );
    // PRF-003 (owner-reported slow tab navigation): `portfolioRecords`
    // (below), `settings`, and `usdAudRate` (the UI-050 app-bar USD/AUD
    // pill) are three mutually independent reads -- none consumes another's
    // output, they just all happen to key off the SAME already-resolved
    // `userId` -- so running them sequentially paid three full D1 round
    // trips where one concurrent wave suffices. Collapsed into a single
    // `Promise.all` wave once `result.ok` is known; the `!result.ok` branch
    // still does zero reads at all (unchanged from before).
    // `usdAudRate` keeps its own `.catch(() => null)`: a failure here must
    // never take down the rest of the workspace, mirroring `realisedGains`'s
    // identical pattern below.
    const [portfolioRecords, settings, usdAudRate] = result.ok
      ? await Promise.all([
          createOwnedPortfolioRepository(client).list(result.context.user.id, {
            includeArchived: true,
          }),
          createOwnedUserSettingsRepository(client).get(result.context.user.id),
          loadUsdAudRate(
            client,
            result.context.user.id,
            nowInstant.slice(0, 10),
          ).catch(() => null),
        ])
      : ([[] as OwnedPortfolioRecord[], null, null] as const);
    const workspace = createOwnedWorkspace(result, portfolioRecords);
    if (!result.ok) {
      if (sqlContextOut) sqlContextOut.current = { ok: false };
      return workspace;
    }
    if (sqlContextOut) {
      sqlContextOut.current = {
        ok: true,
        client,
        userId: result.context.user.id,
      };
    }
    const configuredWorkspace = settings
      ? {
          ...workspace,
          holdingCurrencyView: settings.defaultHoldingCurrencyView,
          financialYearStartMonth: settings.financialYearStartMonth,
          priceSourcePreference: settings.priceSourcePreference,
          dailyCaptureSource: settings.dailyCaptureSource,
          dailyCaptureIntervalMinutes: settings.dailyCaptureIntervalMinutes,
          timezone: settings.timezone,
          settingsVersion: settings.version,
          nowInstant,
          usdAudRate,
        }
      : { ...workspace, nowInstant, usdAudRate };
    // WLT-001: the watchlist is USER-scoped, not portfolio-scoped (owner
    // ruling, 2026-08-22) -- it must load whenever a real userId is known
    // (this point, `result.ok`), regardless of whether an active portfolio
    // exists. This branch therefore runs BEFORE the `activePortfolio ===
    // null` early return below, unlike the holdings/overview branches,
    // which genuinely need one.
    if (options.includeQuotes) {
      try {
        const quotes = await loadOwnedWatchlist(
          client,
          result.context.user.id,
          {
            now: new Date(nowInstant),
            priceSourcePreference: configuredWorkspace.priceSourcePreference,
            // UI-026: the watchlist is user-scoped (no portfolio of its
            // own), but this workspace load already knows whether ONE is
            // active -- pass its base currency through explicitly rather
            // than letting the watchlist module fall back to its own
            // no-portfolio default every time a portfolio genuinely exists.
            baseCurrencyCode:
              configuredWorkspace.activePortfolio?.baseCurrencyCode,
          },
        );
        const unavailable = quotes.filter(
          (quote) => quote.state === "unavailable",
        ).length;
        return {
          ...configuredWorkspace,
          quotes,
          quoteViewState:
            quotes.length === 0
              ? "empty"
              : unavailable === quotes.length
                ? "provider-error"
                : unavailable > 0
                  ? "partial"
                  : "populated",
        };
      } catch (error) {
        console.error("loadOwnedWatchlist failed", error);
        return {
          ...configuredWorkspace,
          quotes: [],
          quoteViewState: "provider-error",
        };
      }
    }
    if (configuredWorkspace.activePortfolio === null)
      return configuredWorkspace;
    if (!options.includeOverview && !options.includeHoldings)
      return configuredWorkspace;
    if (options.includeHoldings) {
      try {
        // PRF-003 (owner-reported slow tab navigation): `realised` never
        // reads anything `holdings` produces (both are independent reads
        // keyed off the same userId/portfolioId) -- it is only COMBINED
        // with `holdings.unrealisedSummary` afterward, below. Running them
        // concurrently collapses two sequential D1 round trips into one
        // wave; `realised`'s own `.catch(() => undefined)` is unchanged, so
        // a `loadOwnedRealisedGainTotals` failure still never surfaces here
        // -- only a `loadOwnedHoldings` failure still falls through to this
        // block's `catch` below, exactly as before.
        const [holdings, realised] = await Promise.all([
          loadOwnedHoldings(
            client,
            result.context.user.id,
            configuredWorkspace.activePortfolio.id,
          ),
          // UI-030: the holdings row's "Realised:" fourth line is a
          // best-effort enrichment on top of the already-working holdings
          // read above, mirroring `owned-holdings.ts`'s own Sharesight
          // price-freshness gate (`.catch(() => undefined)`) -- a failure
          // here (e.g. the CGT domain's calculation run not yet published,
          // a genuinely rare edge since `loadOwnedHoldings` above already
          // requires the SAME publication to exist) must never take down
          // the primary, already-honest holdings figures. `realisedGains`
          // is simply omitted on failure; `ownedHoldingRealisedGainLine`
          // (`owned-holding-format.tsx`) then omits the fourth line
          // entirely rather than rendering a guess.
          loadOwnedRealisedGainTotals(
            client,
            result.context.user.id,
            configuredWorkspace.activePortfolio.id,
          ).catch(() => undefined),
        ]);
        const realisedGains = realised
          ? Object.fromEntries(realised.bySecurity)
          : undefined;
        // UI-031: the holdings summary row's four lines, composed from
        // `holdings.unrealisedSummary` (server-computed in
        // `loadOwnedHoldings` from the SAME rows returned above) and this
        // SAME `realisedGains` map UI-030 already loads -- no additional
        // read, no second calculation path. `unrealisedSummary` is
        // `undefined` only when there are no held securities at all (see
        // its own doc comment), in which case there is nothing to
        // summarise and the holdings screen renders no summary row.
        const holdingsSummary = holdings.unrealisedSummary
          ? buildHoldingsSummaryFooter(
              configuredWorkspace.activePortfolio.baseCurrencyCode,
              holdings.unrealisedSummary,
              realisedGains,
            )
          : undefined;
        // UI-032: the securities-coverage-counts field the retired "Cash
        // separate" panel displayed is no longer threaded onto the
        // workspace -- `holdings.coverage` itself stays computed in
        // `loadOwnedHoldings` (it feeds `owned-income-projection.ts`'s
        // `portfolioValueCoverage`, a different, still-live consumer),
        // only this now-unread passthrough went.
        return {
          ...configuredWorkspace,
          holdings: holdings.rows,
          holdingsViewState: holdings.status,
          cash: holdings.cash,
          realisedGains,
          holdingsSummary,
        };
      } catch {
        return {
          ...configuredWorkspace,
          holdings: [],
          holdingsViewState: "unavailable",
        };
      }
    }
    if (options.includeOverview) {
      // HIST-001 (HISTORY -- PRF-006 below removed the third wave member
      // this comment originally pointed at; the "`overview`/
      // `loadPublishedOverview` block" referenced here no longer exists):
      // the "portfolio value over time" graph is a SEPARATE, best-effort
      // read -- it never depends on the CALC-003/CALC-004 persisted
      // snapshot pipeline (investigation found that pipeline had never
      // published for the real account under review; see
      // `docs/ARCHITECTURE.md`'s HIST-001 entry). A failure here must never
      // take down the existing Overview hero/coverage sections, so it gets
      // its OWN try/catch and its own honest "unavailable" fallback,
      // mirroring the `realisedGains` best-effort pattern above.
      // PRF-003 (owner-reported slow tab navigation; HISTORY -- PRF-006
      // below reduced this wave from three members to two, removing the
      // snapshot-publication `overview` read this paragraph describes):
      // `portfolioValueHistory`, `holdingsSummary`, and (at the time) the
      // snapshot-publication `overview` read were THREE fully independent
      // best-effort reads -- none consumed another's output, they were only
      // combined together in the object literals returned at the end.
      // Before this fix they ran as three separate sequential `await`s
      // (three full D1 round trips end-to-end); collapsed into one
      // `Promise.all` wave here. Each kept its OWN failure handling
      // (`.catch` for all three) so a failure in any ONE of them degraded
      // only that piece, never the others. Review round 2 (BLOCKING
      // correction; HISTORY -- describes the now-removed `overview` wave
      // member): `overview`'s `.catch` had to cover `createOverviewData`
      // itself, not just the `loadPublishedOverview` read -- the original
      // pre-parallelization code had BOTH inside one try block, so a
      // malformed-publication throw from `createOverviewData` degraded only
      // the overview section. An earlier version of this refactor called
      // `createOverviewData` OUTSIDE this `Promise.all` entirely, so that
      // same throw would have escaped to the OUTER catch (below) and
      // discarded the already-successful `portfolioValueHistory`/
      // `holdingsSummary` alongside it -- a strictly worse degradation than
      // before.
      // PRF-006 (owner-directed final pass, 2026-08-31): the third wave
      // member used to be a `loadPublishedOverview` D1 read feeding
      // `createOverviewData`/`createUnavailableOverviewData`. CALC-005
      // (2026-08-31) already retired the snapshot pipeline's every writer --
      // `db/repositories/ledger.ts`, `import-commit.ts`, and this module's
      // own former self-heal all stopped queueing/claiming/advancing a
      // `snapshot`-pipeline row -- so `snapshot_publications` has NO
      // reachable production writer any more (its sole writer,
      // `completeAndPublish`, is reached only via `pipeline: "snapshot"`,
      // which no production caller passes; see `docs/ARCHITECTURE.md`'s
      // dated PRF-006 correction under the CALC-005 entry for the full
      // four-part proof), not merely "confirmed empty for this account"
      // (production verified 0 rows on 2026-08-31, per the CALC-005 entry).
      // `loadPublishedOverview` therefore always resolves `null` and
      // `createOverviewData(null)` is a pure, synchronous function --
      // computing it directly removes a permanently-wasted D1 round trip
      // from EVERY root-page load (root overview census: 20/20 D1
      // calls/statements -> 19/19, depth unchanged at 6 -- this read was
      // concurrent with its two siblings, never the critical-path
      // bottleneck).
      //
      // This IS a deliberate behavior change on the error path, not a
      // byte-identical-output preservation: before this change, a genuine
      // `loadPublishedOverview` D1 failure (a transient connectivity error,
      // not a data-shape issue -- `createOverviewData` cannot throw on the
      // `null` this call was always going to resolve to) reached
      // `.catch(() => createUnavailableOverviewData(...))`, which rendered
      // `OwnedOverviewScreen`'s `data.status === "unavailable"` branch
      // (`app/components/portfolio-shell.tsx`): an "Overview unavailable /
      // Published valuation data could not be loaded. Try again shortly."
      // banner, shown alongside the independently-rendering HIST-001 graph.
      // With the read removed, that failure mode is gone entirely -- the
      // screen always takes the SAME `data.status === "empty"` path it
      // already took on every successful call (the query always returned
      // zero rows), which shows only the chart plus, if the chart itself
      // also has nothing to plot, a "No valuation history yet" empty state
      // -- never the "could not be loaded" banner, since there is no longer
      // a read that can fail. A transient D1 hiccup against a permanently
      // unwritable table can no longer disrupt the Overview screen at all.
      // This is an improvement, not a preserved invariant --
      // `createHistoricalSnapshotRepository`/`createUnavailableOverviewData`
      // are unused here now.
      const overview = createOverviewData(null);
      const [portfolioValueHistory, holdingsSummary] = await Promise.all([
        // HIST-001 (HISTORY -- see the PRF-006 comment above; the "read
        // below" this originally pointed at is gone, only `holdingsSummary`
        // remains as this read's sibling in the wave): the "portfolio value
        // over time" graph is a SEPARATE, best-effort read -- it never
        // depends on the CALC-003/CALC-004 persisted snapshot pipeline
        // (investigation found that pipeline had never published for the
        // real account under review; see `docs/ARCHITECTURE.md`'s HIST-001
        // entry). A failure here must never take down the existing Overview
        // hero/coverage sections, so it gets its OWN `.catch` and its own
        // honest "unavailable" fallback, mirroring the `realisedGains`
        // best-effort pattern above.
        loadHistoricalPortfolioValueSeries(
          client,
          result.context.user.id,
          configuredWorkspace.activePortfolio.id,
          new Date(nowInstant),
        )
          .then((result) =>
            result === null
              ? {
                  status: "unavailable" as const,
                  points: [],
                  baseCurrencyCode:
                    configuredWorkspace.activePortfolio!.baseCurrencyCode,
                  datesTruncated: false,
                  backfillPending: false,
                }
              : {
                  status:
                    result.points.length === 0
                      ? ("empty" as const)
                      : ("ok" as const),
                  points: result.points,
                  baseCurrencyCode: result.baseCurrencyCode,
                  datesTruncated: result.datesTruncated,
                  backfillPending: result.backfillPending,
                },
          )
          .catch(() => ({
            status: "unavailable" as const,
            points: [],
            baseCurrencyCode:
              configuredWorkspace.activePortfolio!.baseCurrencyCode,
            datesTruncated: false,
            backfillPending: false,
          })),
        // UI-047 (owner-reported): the Overview hero headline must show
        // the SAME securities-only current portfolio value the Holdings
        // tab (`buildHoldingsSummaryFooter`'s `marketValue`) and the
        // HIST-001/BUG-002 value-history graph already show -- never the
        // CALC-003/CALC-004 persisted-snapshot total below, which stayed
        // cash-inclusive (BUG-002 only touched the HIST-001 series and
        // live holdings reads, not that dormant snapshot pipeline).
        // CALC-005 retired the snapshot pipeline entirely, so that total
        // can now never populate at all -- the divergence this comment
        // used to flag as a follow-up is moot by construction. Loaded
        // independently, mirroring `portfolioValueHistory` above: a
        // failure here must never take down the rest of Overview, so the
        // headline simply reads "unavailable" rather than dragging the
        // whole screen down with it.
        loadOwnedHoldings(
          client,
          result.context.user.id,
          configuredWorkspace.activePortfolio.id,
        )
          .then((holdings) =>
            holdings.unrealisedSummary
              ? buildHoldingsSummaryFooter(
                  configuredWorkspace.activePortfolio!.baseCurrencyCode,
                  holdings.unrealisedSummary,
                  undefined,
                )
              : undefined,
          )
          .catch(() => undefined),
      ]);
      return {
        ...configuredWorkspace,
        overview,
        portfolioValueHistory,
        holdingsSummary,
      };
    }
    return configuredWorkspace;
  } catch (error) {
    // UI-023B follow-up: same rationale as getAuthenticatedSqlContext's
    // catch -- keep the user-facing message generic, but never swallow the
    // underlying error silently (a missing local migration column produced
    // an undiagnosable blanket outage here).
    console.error("loadAuthenticatedWorkspace failed", error);
    if (sqlContextOut) sqlContextOut.current = { ok: false };
    return unavailableWorkspace("Portfolio data is temporarily unavailable.");
  }
}
