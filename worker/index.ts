import handler from "vinext/server/app-router-entry";
import {
  createRuntimeConfigErrorResponse,
  resolveRuntimeConfig,
} from "./runtime-config";
import {
  applyResponseSecurityHeaders,
  createCspNonce,
} from "./response-security";
import {
  createAccessJwtVerifier,
  encodeAccessJwtBase64Url,
} from "../domain/auth/access-jwt";
import { VERIFIED_PRINCIPAL_HEADER } from "../domain/auth/verified-principal-header";
import {
  addRequestId,
  createRequestId,
  emitStructuredLog,
  REQUEST_NOW_HEADER,
} from "../domain/observability/index.ts";
import {
  runScheduledCalculationSweep,
  runScheduledCorporateActionRefresh,
  runScheduledDailyPriceCapture,
  runScheduledMarketDataRefresh,
  runScheduledSharesightPriceRefresh,
  runScheduledValueHistoryBackfill,
} from "./scheduled-refresh";

// MKT-011A: the intraday-capture sweep's own cron pattern (`wrangler.json`'s
// `triggers.crons`) -- distinct from every other scheduled job's `0 * * * *`.
// `scheduled` below dispatches on `controller.cron` so the hourly jobs never
// run twice as often and the intraday sweep never runs on the hourly tick.
const DAILY_PRICE_CAPTURE_CRON = "25,55 * * * *";

const accessJwtVerifier = createAccessJwtVerifier();

function createAccessDeniedResponse(status: 401 | 403 | 503): Response {
  const message =
    status === 503
      ? "Cloudflare Access configuration is unavailable."
      : "Cloudflare Access authentication failed.";

  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

const worker: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const nonce = createCspNonce();
    const requestId = createRequestId(request);
    const respond = async (response: Response): Promise<Response> =>
      addRequestId(
        await applyResponseSecurityHeaders(request, response, nonce),
        requestId,
      );
    const runtimeConfig = resolveRuntimeConfig(env);
    if (!runtimeConfig.ok) {
      emitStructuredLog({
        level: "error",
        event: "request.config",
        action: "runtime.config",
        result: "failure",
        requestId,
        metadata: {
          errorCodes: runtimeConfig.errors.map((error) => error.code),
        },
      });
      return await respond(
        createRuntimeConfigErrorResponse(runtimeConfig.errors),
      );
    }

    const pathname = new URL(request.url).pathname;
    if (
      runtimeConfig.config.environment === "production" &&
      pathname.startsWith("/portfolio/preview/")
    ) {
      emitStructuredLog({
        event: "request.route",
        action: "route.preview_blocked",
        result: "denied",
        requestId,
      });
      return await respond(
        new Response("Not found", {
          status: 404,
          headers: {
            "cache-control": "private, no-store",
            "content-type": "text/plain; charset=utf-8",
          },
        }),
      );
    }

    const accessResult = await accessJwtVerifier.verify(
      request,
      runtimeConfig.config.access,
    );
    if (!accessResult.ok) {
      emitStructuredLog({
        level: accessResult.status >= 500 ? "error" : "warn",
        event: "request.auth",
        action: "auth.verify",
        result: "denied",
        requestId,
        metadata: { status: accessResult.status },
      });
      return await respond(createAccessDeniedResponse(accessResult.status));
    }

    emitStructuredLog({
      event: "request.auth",
      action: "auth.verify",
      result: "success",
      requestId,
    });
    const authenticatedHeaders = new Headers(request.headers);
    authenticatedHeaders.delete(VERIFIED_PRINCIPAL_HEADER);
    authenticatedHeaders.set(
      VERIFIED_PRINCIPAL_HEADER,
      encodeAccessJwtBase64Url(accessResult.principal),
    );
    // BUG-002 (hydration half): stamp this request's canonical "now" ONCE,
    // here, and carry it with the Request -- Vinext invokes the page's
    // async Server Component twice per request (see
    // `domain/observability/request-correlation.ts`'s module comment), and
    // both passes must read the identical instant or a second/minute
    // boundary crossed between them can desync the server-rendered HTML
    // from the RSC flight payload. SECURITY: unconditionally delete any
    // client-supplied copy of this header BEFORE setting our own -- same
    // strip-before-stamp discipline as `VERIFIED_PRINCIPAL_HEADER` above --
    // a client must never be able to inject the "now" a server render
    // anchors on.
    authenticatedHeaders.delete(REQUEST_NOW_HEADER);
    authenticatedHeaders.set(REQUEST_NOW_HEADER, new Date().toISOString());
    const authenticatedRequest = new Request(request, {
      headers: authenticatedHeaders,
    });
    return await respond(await handler.fetch(authenticatedRequest, env, ctx));
  },

  async scheduled(controller, env) {
    // MKT-011A: the intraday-capture cron pattern fires on its OWN schedule
    // slot, never alongside the hourly jobs below -- see
    // `DAILY_PRICE_CAPTURE_CRON`'s comment and
    // `runScheduledDailyPriceCapture`'s doc comment for why `isSecondaryTick`
    // is derived from the REAL fired minute rather than the pattern string
    // (`:25` and `:55` share one pattern).
    if (controller.cron === DAILY_PRICE_CAPTURE_CRON) {
      const isSecondaryTick =
        new Date(controller.scheduledTime).getUTCMinutes() === 55;
      const captureResult = await runScheduledDailyPriceCapture(env, {
        isSecondaryTick,
      });
      // Review round B3: `captureResult.ok` alone is not enough to call this
      // "success" -- a nonzero `rollupsFailed` means at least one
      // (owner, security, market_date) pair genuinely threw and its
      // intraday cache was deliberately left unpurged for retry. The
      // `StructuredLogInput.result` union has no third "degraded" state, so
      // this logs as `"failure"`/`"warn"` (never `"success"`/`"info"`) --
      // the closest honest fit -- rather than letting a wedged pipeline read
      // as routine success.
      const degraded = captureResult.ok && captureResult.rollupsFailed > 0;
      emitStructuredLog({
        level: !captureResult.ok ? "error" : degraded ? "warn" : "info",
        event: "market.refresh",
        action: "market.refresh.daily_price_capture.scheduled",
        result: captureResult.ok && !degraded ? "success" : "failure",
        requestId: "scheduled",
        metadata: captureResult.ok
          ? {
              isSecondaryTick,
              usersProcessed: captureResult.usersProcessed,
              sharesightRequests: captureResult.sharesightRequests,
              yahooRequests: captureResult.yahooRequests,
              intradayPointsCaptured: captureResult.intradayPointsCaptured,
              rolledUp: captureResult.rolledUp,
              purged: captureResult.purged,
              skippedNoMapping: captureResult.skippedNoMapping,
              rollupsFailed: captureResult.rollupsFailed,
              // Review round F5: the structured log emits ONLY the closed
              // `firstRollupErrorKind` enum, never the free-text
              // `firstRollupError` message -- an unbounded DB error string
              // is not a safe/stable thing to ship into log metadata (the
              // full message stays on `captureResult` itself for
              // tests/deeper debugging, just never logged here).
              firstRollupErrorKind: captureResult.firstRollupErrorKind,
            }
          : { reason: captureResult.reason },
      });
      return;
    }

    const result = await runScheduledMarketDataRefresh(env);
    emitStructuredLog({
      level: result.ok ? "info" : "error",
      event: "market.refresh",
      action: "market.refresh.scheduled",
      result: result.ok ? "success" : "failure",
      requestId: "scheduled",
      metadata: result.ok
        ? {
            skipped: result.skipped,
            jobs: result.jobs,
            providerRequests: result.providerRequests,
          }
        : { reason: result.reason },
    });

    const corporateActionResult = await runScheduledCorporateActionRefresh(env);
    emitStructuredLog({
      level: corporateActionResult.ok ? "info" : "error",
      event: "market.refresh",
      action: "market.refresh.corporate_actions.scheduled",
      result: corporateActionResult.ok ? "success" : "failure",
      requestId: "scheduled",
      metadata: corporateActionResult.ok
        ? {
            skipped: corporateActionResult.skipped,
            securitiesProcessed: corporateActionResult.securitiesProcessed,
            securitiesFailed: corporateActionResult.securitiesFailed,
          }
        : { reason: corporateActionResult.reason },
    });

    const sharesightPriceRefreshResult =
      await runScheduledSharesightPriceRefresh(env);
    emitStructuredLog({
      level: sharesightPriceRefreshResult.ok ? "info" : "error",
      event: "market.refresh",
      action: "market.refresh.sharesight_price.scheduled",
      result: sharesightPriceRefreshResult.ok ? "success" : "failure",
      requestId: "scheduled",
      metadata: sharesightPriceRefreshResult.ok
        ? {
            skipped: sharesightPriceRefreshResult.skipped,
            usersProcessed: sharesightPriceRefreshResult.usersProcessed,
            usersFailed: sharesightPriceRefreshResult.usersFailed,
            matchedCount: sharesightPriceRefreshResult.matchedCount,
            unmatchedCount: sharesightPriceRefreshResult.unmatchedCount,
            invalidTimestampCount:
              sharesightPriceRefreshResult.invalidTimestampCount,
            observationsWritten:
              sharesightPriceRefreshResult.observationsWritten,
          }
        : { reason: sharesightPriceRefreshResult.reason },
    });

    const calculationSweepResult = await runScheduledCalculationSweep();
    emitStructuredLog({
      level: calculationSweepResult.ok ? "info" : "error",
      event: "calculation.sweep",
      action: "calculation.sweep.scheduled",
      result: calculationSweepResult.ok ? "success" : "failure",
      requestId: "scheduled",
      metadata: calculationSweepResult.ok
        ? {
            portfolios: calculationSweepResult.portfolios,
            advanced: calculationSweepResult.advanced,
            completed: calculationSweepResult.completed,
            // CALC-005: rows the snapshot-pipeline retirement cleanup moved
            // to `abandoned` this sweep -- see `sweepCalculationRuns`'s doc
            // comment. Zero on every sweep after the first following
            // deployment.
            snapshotRunsTerminated:
              calculationSweepResult.snapshotRunsTerminated,
          }
        : { reason: calculationSweepResult.reason },
    });

    // BUG-010: LAST on the hourly tick, deliberately -- on Workers FREE a
    // Cron Trigger gets the same 10ms CPU allowance an HTTP request does
    // (verified against Cloudflare's limits table; see
    // `app/value-history-backfill-service.ts`), so this bounded backfill
    // spends what is left of the tick rather than competing with the sweeps
    // above. Its work is persisted per slice, so even a tick cut short at
    // the CPU limit leaves durable forward progress.
    const valueHistoryBackfillResult = await runScheduledValueHistoryBackfill();
    emitStructuredLog({
      level: valueHistoryBackfillResult.ok ? "info" : "error",
      event: "value_history.backfill",
      action: "value_history.backfill.scheduled",
      result: valueHistoryBackfillResult.ok ? "success" : "failure",
      requestId: "scheduled",
      metadata: valueHistoryBackfillResult.ok
        ? {
            portfoliosConsidered:
              valueHistoryBackfillResult.portfoliosConsidered,
            portfoliosAdvanced: valueHistoryBackfillResult.portfoliosAdvanced,
            datesDerived: valueHistoryBackfillResult.datesDerived,
            rowsPersisted: valueHistoryBackfillResult.rowsPersisted,
            // Nonzero while a wiped series is still catching up -- the
            // operational signal that a rebuild is in progress.
            portfoliosPending: valueHistoryBackfillResult.portfoliosPending,
            portfoliosFailed: valueHistoryBackfillResult.portfoliosFailed,
            // PRF-010: how many of the above were reported converged via
            // the convergence-marker shortcut rather than a freshly-run
            // candidate-date scan this tick -- the visible proxy for the
            // rows_read saving this task exists to deliver.
            portfoliosConvergedSkipped:
              valueHistoryBackfillResult.portfoliosConvergedSkipped,
          }
        : { reason: valueHistoryBackfillResult.reason },
    });
  },
};

export default worker;
