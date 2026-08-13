// MKT-005: server-side ingestion of provider dividend/split history into
// the shared `dividend_events`/`split_events` tables (DB-005). This module
// implements ingestion triggers (a) and (c) from the task's recorded
// decision as ONE reusable function: both "pull full history when a
// security is first added/verified" and "owner-initiated per-security
// historical re-pull" are the same operation -- re-fetch the provider's full
// history and reconcile it against existing rows via supersession, never
// deletion. Trigger (b) ("new declarations on the normal refresh path") is
// `runDueCorporateActionRefresh` below, which repeatedly calls the same
// reconciliation for a small bounded batch of securities per invocation.
//
// Reconciliation never touches owner override/manual/exclusion rows
// (`dividend_event_overrides`, `dividend_manual_records`, `dividend_receipts`,
// the assumptions tables) because this module only ever writes to
// `dividend_events`/`split_events` via `createDividendEventRepository`/
// `createSplitEventRepository` (db/repositories/dividends.ts), which are
// separate, provider-write-only tables (see that file's module header). An
// owner override stays keyed to whichever event version was active when the
// owner created it; see `collectEventLineageIds` below for why that is NOT
// automatically "the override still wins" without a resolution step.
import type { SqlClient } from "../../db/repositories/sql-client.ts";
import {
  createCorporateActionRefreshRepository,
  createDividendEventRepository,
  createSplitEventRepository,
  type DividendEventRecord,
  type DividendEventStatus,
  type SplitEventRecord,
  type SplitEventStatus,
} from "../../db/repositories/dividends.ts";
import type {
  DividendEventInput,
  MarketDataProvider,
  ObservationScope,
  SplitEventInput,
} from "./contracts.ts";

const DEFAULT_HISTORY_YEARS = 20;

// Franking is never sourced from any current provider (MKT-005's recorded
// decision) -- both fields are always written as this explicit `null`
// (unknown), never a guessed/silent zero. See db/schema.ts's `dividend_events`
// column comments and docs/DATA_MODEL.md's `dividend_events` section for the
// same seam documented at the schema layer.
const FRANKING_UNAVAILABLE = null;

function subtractYears(dateStr: string, years: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

// Both dedupe helpers keep the FIRST event for a colliding natural key and
// report how many were dropped (surfaced in the reconciliation summary
// rather than silently discarded -- review follow-up). Known limitation:
// this provider's dividend events carry no type classification (every
// ingested row is written with `kind = 'cash'`, see
// `domain/market-data/yahoo-compatible.ts`'s `getDividendEvents`), so an
// ordinary dividend and a genuinely separate special dividend sharing the
// same ex-date are indistinguishable here and one would be dropped as a
// "duplicate" natural key. This is a real limitation of Yahoo's undifferentiated
// event shape, not a bug in the dedupe logic; see
// docs/MARKET_DATA_STRATEGY.md's dividend/split capability section.
function dedupeByExDate(
  events: readonly DividendEventInput[],
): DividendEventInput[] {
  const seen = new Set<string>();
  const result: DividendEventInput[] = [];
  for (const event of events) {
    if (seen.has(event.exDate)) continue;
    seen.add(event.exDate);
    result.push(event);
  }
  return result;
}

function dedupeByEffectiveDate(
  events: readonly SplitEventInput[],
): SplitEventInput[] {
  const seen = new Set<string>();
  const result: SplitEventInput[] = [];
  for (const event of events) {
    if (seen.has(event.effectiveDate)) continue;
    seen.add(event.effectiveDate);
    result.push(event);
  }
  return result;
}

export type CorporateActionReconciliationSummary = {
  created: number;
  superseded: number;
  /** B4: a pure lifecycle transition (declared -> paid/effective) applied in place. */
  statusUpdated: number;
  unchanged: number;
  /** Provider events dropped because they collided on natural key within one fetch; see `dedupeByExDate`. */
  droppedDuplicates: number;
};

function emptyReconciliationSummary(): CorporateActionReconciliationSummary {
  return {
    created: 0,
    superseded: 0,
    statusUpdated: 0,
    unchanged: 0,
    droppedDuplicates: 0,
  };
}

function dividendFactsMatch(
  row: DividendEventRecord,
  event: DividendEventInput,
): boolean {
  return (
    row.currencyCode === event.currencyCode &&
    row.grossPerShareDecimal === event.amountDecimal &&
    row.paymentDate === event.paymentDate
  );
}

async function reconcileDividends(
  client: SqlClient,
  providerId: string,
  securityId: string,
  fetched: readonly DividendEventInput[],
  nowIso: string,
): Promise<CorporateActionReconciliationSummary | null> {
  const repository = createDividendEventRepository(client, () => nowIso);
  const today = nowIso.slice(0, 10);
  const readActive = async (): Promise<DividendEventRecord[]> =>
    (await repository.listForSecurity(securityId)).filter(
      (event) =>
        event.status !== "superseded" && event.providerId === providerId,
    );
  let active = await readActive();
  const deduped = dedupeByExDate(fetched);
  const summary = emptyReconciliationSummary();
  summary.droppedDuplicates = fetched.length - deduped.length;

  for (const event of deduped) {
    const status: DividendEventStatus =
      event.exDate <= today ? "paid" : "declared";
    let match = active.find((row) => row.exDate === event.exDate);

    if (!match) {
      const result = await repository.recordEvent({
        securityId,
        providerId,
        kind: "cash",
        status,
        exDate: event.exDate,
        paymentDate: event.paymentDate,
        currencyCode: event.currencyCode,
        grossPerShareDecimal: event.amountDecimal,
        frankingPercentDecimal: FRANKING_UNAVAILABLE,
        frankingCreditPerShareDecimal: FRANKING_UNAVAILABLE,
        observedAt: nowIso,
        ingestedAt: nowIso,
      });
      if (result.ok) {
        summary.created += 1;
        active.push(result.event);
        continue;
      }
      // B1: benign concurrent-ingestion race. The IMP-004B verify trigger
      // and the periodic sweep can both reconcile the same security around
      // the same time; `dividend_events_active_natural_key_unique` (a
      // partial unique index on security/provider/ex-date among active
      // rows) can make this create INSERT fail because a concurrent
      // attempt already created the row moments earlier. Re-read and, if
      // the row is now present, fall through to the ordinary match-compare
      // path below instead of reporting a spurious write failure.
      active = await readActive();
      match = active.find((row) => row.exDate === event.exDate);
      if (!match) return null;
    }

    const factsMatch = dividendFactsMatch(match, event);
    if (factsMatch && match.status === status) {
      summary.unchanged += 1;
      continue;
    }
    if (factsMatch) {
      // B4: `status` is a lifecycle column, not an immutable provider fact.
      // A pure lifecycle progression (declared -> paid once the ex-date
      // passes) with every other fact unchanged is an in-place update, not
      // a correction and not a supersession -- see
      // docs/DATA_MODEL.md's `dividend_events` status-semantics note.
      const result = await repository.updateStatus(
        match.id,
        securityId,
        status,
        nowIso,
      );
      if (!result.ok) return null;
      summary.statusUpdated += 1;
      active = active.map((row) =>
        row.id === result.event.id ? result.event : row,
      );
      continue;
    }
    const result = await repository.recordEvent({
      securityId,
      providerId,
      kind: "cash",
      status,
      exDate: event.exDate,
      paymentDate: event.paymentDate,
      currencyCode: event.currencyCode,
      grossPerShareDecimal: event.amountDecimal,
      frankingPercentDecimal: FRANKING_UNAVAILABLE,
      frankingCreditPerShareDecimal: FRANKING_UNAVAILABLE,
      observedAt: nowIso,
      ingestedAt: nowIso,
      supersedesEventId: match.id,
    });
    if (result.ok) {
      summary.superseded += 1;
      active.push(result.event);
      continue;
    }
    // B1: benign race on the supersede path -- a concurrent attempt already
    // superseded this exact row with a matching corrected value.
    active = await readActive();
    const reMatch = active.find((row) => row.exDate === event.exDate);
    if (!reMatch || !dividendFactsMatch(reMatch, event)) return null;
    summary.unchanged += 1;
  }
  return summary;
}

function splitFactsMatch(
  row: SplitEventRecord,
  event: SplitEventInput,
): boolean {
  return (
    row.numeratorDecimal === event.numeratorDecimal &&
    row.denominatorDecimal === event.denominatorDecimal &&
    row.exDate === event.effectiveDate
  );
}

async function reconcileSplits(
  client: SqlClient,
  providerId: string,
  securityId: string,
  fetched: readonly SplitEventInput[],
  nowIso: string,
): Promise<CorporateActionReconciliationSummary | null> {
  const repository = createSplitEventRepository(client, () => nowIso);
  const today = nowIso.slice(0, 10);
  const readActive = async (): Promise<SplitEventRecord[]> =>
    (await repository.listForSecurity(securityId)).filter(
      (event) =>
        event.status !== "superseded" && event.providerId === providerId,
    );
  let active = await readActive();
  const deduped = dedupeByEffectiveDate(fetched);
  const summary = emptyReconciliationSummary();
  summary.droppedDuplicates = fetched.length - deduped.length;

  for (const event of deduped) {
    // Yahoo's split events carry a single date; MKT-005 uses it for both
    // the repository's required `exDate` and `effectiveDate` fields (see
    // the identical decision noted in yahoo-compatible.ts's
    // `getSplitEvents`).
    let match = active.find((row) => row.effectiveDate === event.effectiveDate);
    const status: SplitEventStatus =
      event.effectiveDate <= today ? "effective" : "declared";

    if (!match) {
      const result = await repository.recordEvent({
        securityId,
        providerId,
        exDate: event.effectiveDate,
        effectiveDate: event.effectiveDate,
        numeratorDecimal: event.numeratorDecimal,
        denominatorDecimal: event.denominatorDecimal,
        status,
        observedAt: nowIso,
        ingestedAt: nowIso,
      });
      if (result.ok) {
        summary.created += 1;
        active.push(result.event);
        continue;
      }
      // B1: same benign-race handling as the dividend create path above,
      // guarded by `split_events_active_natural_key_unique`.
      active = await readActive();
      match = active.find((row) => row.effectiveDate === event.effectiveDate);
      if (!match) return null;
    }

    const factsMatch = splitFactsMatch(match, event);
    if (factsMatch && match.status === status) {
      summary.unchanged += 1;
      continue;
    }
    if (factsMatch) {
      // B4: pure lifecycle progression (declared -> effective), in place.
      const result = await repository.updateStatus(
        match.id,
        securityId,
        status,
        nowIso,
      );
      if (!result.ok) return null;
      summary.statusUpdated += 1;
      active = active.map((row) =>
        row.id === result.event.id ? result.event : row,
      );
      continue;
    }
    const result = await repository.recordEvent({
      securityId,
      providerId,
      exDate: event.effectiveDate,
      effectiveDate: event.effectiveDate,
      numeratorDecimal: event.numeratorDecimal,
      denominatorDecimal: event.denominatorDecimal,
      status,
      observedAt: nowIso,
      ingestedAt: nowIso,
      supersedesEventId: match.id,
    });
    if (result.ok) {
      summary.superseded += 1;
      active.push(result.event);
      continue;
    }
    // B1: benign race on the supersede path.
    active = await readActive();
    const reMatch = active.find(
      (row) => row.effectiveDate === event.effectiveDate,
    );
    if (!reMatch || !splitFactsMatch(reMatch, event)) return null;
    summary.unchanged += 1;
  }
  return summary;
}

export type CorporateActionIngestionOptions = {
  client: SqlClient;
  provider: MarketDataProvider;
  providerId: string;
  securityId: string;
  mappingId: string;
  scope: ObservationScope;
  now?: () => string;
  /** Defaults to `DEFAULT_HISTORY_YEARS` before `to`. */
  from?: string;
  /** Defaults to today (from `now`). */
  to?: string;
};

export type CorporateActionIngestionSummary = {
  dividends: CorporateActionReconciliationSummary;
  splits: CorporateActionReconciliationSummary;
};

export type CorporateActionIngestionResult =
  | { ok: true; summary: CorporateActionIngestionSummary }
  | {
      ok: false;
      reason:
        | "invalid_input"
        | "dividend_provider_error"
        | "split_provider_error"
        | "write_failed";
    };

async function runIngestion(
  options: CorporateActionIngestionOptions,
  nowIso: string,
): Promise<CorporateActionIngestionResult> {
  const today = nowIso.slice(0, 10);
  const to = options.to ?? today;
  const from = options.from ?? subtractYears(to, DEFAULT_HISTORY_YEARS);
  if (from > to) {
    return { ok: false, reason: "invalid_input" };
  }

  const dividends = await options.provider.getDividendEvents({
    mappingId: options.mappingId,
    securityId: options.securityId,
    from,
    to,
    scope: options.scope,
  });
  // `unavailable_capability` is expected for a provider that simply does not
  // support this capability (e.g. the disabled provider stub); treat it as
  // "nothing to ingest" rather than a hard failure, so a full corporate-
  // action pull never blocks an unrelated caller (IMP-004B's verify success
  // path) on a capability this deployment's provider does not have.
  if (!dividends.ok && dividends.error.kind !== "unavailable_capability") {
    return { ok: false, reason: "dividend_provider_error" };
  }
  const splits = await options.provider.getSplitEvents({
    mappingId: options.mappingId,
    securityId: options.securityId,
    from,
    to,
    scope: options.scope,
  });
  if (!splits.ok && splits.error.kind !== "unavailable_capability") {
    return { ok: false, reason: "split_provider_error" };
  }

  const dividendSummary = dividends.ok
    ? await reconcileDividends(
        options.client,
        options.providerId,
        options.securityId,
        dividends.value,
        nowIso,
      )
    : emptyReconciliationSummary();
  if (!dividendSummary) return { ok: false, reason: "write_failed" };

  const splitSummary = splits.ok
    ? await reconcileSplits(
        options.client,
        options.providerId,
        options.securityId,
        splits.value,
        nowIso,
      )
    : emptyReconciliationSummary();
  if (!splitSummary) return { ok: false, reason: "write_failed" };

  return {
    ok: true,
    summary: { dividends: dividendSummary, splits: splitSummary },
  };
}

/**
 * Pulls a security's full provider dividend/split history and reconciles it
 * against existing `dividend_events`/`split_events` rows: unchanged ->
 * no-op, changed fact -> supersede (prior row preserved, new row created),
 * pure lifecycle status progression -> in-place update (B4), missing ->
 * create. Reused for both "security added/verified" (trigger a) and an
 * owner-initiated historical re-pull (trigger c) -- both are exactly this
 * same full-pull-and-reconcile operation.
 *
 * Never throws: every code path (including unexpected repository/provider
 * errors) resolves to a typed result. At the end of every attempt --
 * success or failure -- this upserts
 * `corporate_action_refresh_state.last_attempted_at` for `securityId`
 * (best-effort; a bookkeeping failure never turns an otherwise successful
 * ingestion into a reported failure), which is what lets
 * `runDueCorporateActionRefresh` rotate through the full candidate set
 * instead of re-selecting the same security forever (B1).
 */
export async function ingestSecurityCorporateActionHistory(
  options: CorporateActionIngestionOptions,
): Promise<CorporateActionIngestionResult> {
  if (!options.securityId || !options.mappingId || !options.providerId) {
    return { ok: false, reason: "invalid_input" };
  }
  const now = options.now ?? (() => new Date().toISOString());
  const nowIso = now();

  let result: CorporateActionIngestionResult;
  try {
    result = await runIngestion(options, nowIso);
  } catch {
    result = { ok: false, reason: "write_failed" };
  }

  try {
    await createCorporateActionRefreshRepository(options.client).recordAttempt(
      options.securityId,
      nowIso,
      result.ok ? "ok" : "failed",
    );
  } catch {
    // Best-effort bookkeeping only; see the doc comment above.
  }

  return result;
}

export type DueCorporateActionRefreshOptions = {
  client: SqlClient;
  provider: MarketDataProvider;
  providerId: string;
  scope: ObservationScope;
  now?: () => string;
  /** Bounded batch size per invocation; default 3, hard-capped at 10. */
  maxSecurities?: number;
};

export type DueCorporateActionRefreshSummary = {
  securitiesProcessed: number;
  securitiesFailed: number;
  dividends: CorporateActionReconciliationSummary;
  splits: CorporateActionReconciliationSummary;
};

const DEFAULT_MAX_SECURITIES_PER_SWEEP = 3;
const MAX_SECURITIES_PER_SWEEP = 10;

function addReconciliationSummary(
  total: CorporateActionReconciliationSummary,
  delta: CorporateActionReconciliationSummary,
): void {
  total.created += delta.created;
  total.superseded += delta.superseded;
  total.statusUpdated += delta.statusUpdated;
  total.unchanged += delta.unchanged;
  total.droppedDuplicates += delta.droppedDuplicates;
}

/**
 * Ingestion trigger (b): "new declarations picked up on the normal
 * market-data refresh path". Ranks verified provider mappings by
 * `corporate_action_refresh_state.last_attempted_at` (oldest/never first,
 * see `createCorporateActionRefreshRepository`) and re-pulls a small bounded
 * batch per invocation -- deliberately NOT the price/FX chunked job-queue
 * (`market_data_refresh_jobs`); see that repository's module comment for why
 * this task does not migrate that schema for a sparse full-history-reconcile
 * capability. This sweep runs its own bounded provider work independent of
 * `MARKET_DATA_REFRESH_LIMITS` (the price/FX budget) -- each
 * `MarketDataProvider` instance carries its own circuit breaker
 * (`yahoo-compatible.ts`), so a struggling corporate-action fetch trips its
 * own breaker without affecting price/FX refresh health.
 */
export async function runDueCorporateActionRefresh(
  options: DueCorporateActionRefreshOptions,
): Promise<DueCorporateActionRefreshSummary> {
  const now = options.now ?? (() => new Date().toISOString());
  const limit = Math.max(
    1,
    Math.min(
      options.maxSecurities ?? DEFAULT_MAX_SECURITIES_PER_SWEEP,
      MAX_SECURITIES_PER_SWEEP,
    ),
  );
  const candidates = await createCorporateActionRefreshRepository(
    options.client,
  ).listCandidates(options.providerId, limit);

  const summary: DueCorporateActionRefreshSummary = {
    securitiesProcessed: 0,
    securitiesFailed: 0,
    dividends: emptyReconciliationSummary(),
    splits: emptyReconciliationSummary(),
  };
  for (const candidate of candidates) {
    // Review follow-up: an unexpected throw from one security's ingestion
    // (network/DB) must not abort the rest of the bounded batch.
    // `ingestSecurityCorporateActionHistory` itself already never throws,
    // but this is a defensive second layer around the loop.
    try {
      const result = await ingestSecurityCorporateActionHistory({
        client: options.client,
        provider: options.provider,
        providerId: options.providerId,
        securityId: candidate.securityId,
        mappingId: candidate.mappingId,
        scope: options.scope,
        now,
      });
      if (!result.ok) {
        summary.securitiesFailed += 1;
        continue;
      }
      summary.securitiesProcessed += 1;
      addReconciliationSummary(summary.dividends, result.summary.dividends);
      addReconciliationSummary(summary.splits, result.summary.splits);
    } catch {
      summary.securitiesFailed += 1;
    }
  }
  return summary;
}

export type EventLineageNode = { id: string; supersedesEventId: string | null };

/**
 * B3 (MKT-005 review fix): pure lineage-walk helper -- NOT override
 * resolution, which is DIV-001 scope. Supersession mints a NEW event id for
 * a corrected fact and moves the prior row's status to `superseded`; an
 * owner override (`dividend_event_overrides`) stays keyed to whichever event
 * id was active when the owner created it, so a naive "read only the
 * current active event" lookup would miss an override attached to a now-
 * superseded prior version -- the OPPOSITE of the intended "override still
 * wins" behaviour. Given the full set of a security's dividend or split
 * events and a starting event id, this returns the ordered chain of ids
 * from that event backward through every version it supersedes (most
 * recent first). Resolving "does an override exist for this event OR any
 * version in its lineage" by checking each id in the returned list against
 * the override table is DIV-001's job; this only supplies the lineage.
 */
export function collectEventLineageIds(
  events: readonly EventLineageNode[],
  startEventId: string,
): string[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const lineage: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = startEventId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    lineage.push(cursor);
    cursor = byId.get(cursor)?.supersedesEventId ?? null;
  }
  return lineage;
}
