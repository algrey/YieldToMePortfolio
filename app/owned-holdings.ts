import type { SqlClient } from "../db/repositories/sql-client.ts";
import { createOwnedManualOverrideRepository } from "../db/repositories/market-data.ts";
import {
  createOwnedUserSettingsRepository,
  type PriceSourcePreference,
} from "../db/repositories/owned-portfolios.ts";
import {
  ensureSharesightPriceFreshness,
  type SharesightPriceGateOptions,
} from "./sharesight-price-gate-service.ts";
import {
  calculateCashConversion,
  calculateDailyMovement,
  calculateNativeHomeHolding,
  composePortfolioDailyMovementTotal,
  composePortfolioTotals,
  type CalculationValue,
  type FxEvidence,
  type PortfolioDailyMovementResult,
  type PortfolioTotalsResult,
} from "../domain/calculations/index.ts";
import {
  addDecimal,
  divideDecimal,
  formatDecimalExact,
  formatDecimalFixed,
  formatDecimalTrimmed,
  isZero,
  multiplyDecimal,
  parseDecimal,
  parseDecimalResult,
  subtractDecimal,
} from "../domain/calculations/index.ts";
import {
  OWNER_IMPORT_PROVIDER_ID,
  selectFxObservation,
  selectPriceObservation,
  type FxSelection,
  type PriceSelection,
  type SelectedPrice,
} from "../domain/market-data/selection.ts";
import type {
  FxObservation,
  PriceObservation,
} from "../domain/market-data/contracts.ts";
import type {
  OwnedCashSummary,
  OwnedHoldingRow,
  OwnedHoldingsUnrealisedSummary,
  OwnedHoldingValue,
} from "./owned-holdings-contract.ts";
import type { Tone } from "./prototype-data.ts";
import {
  advanceCalculationRuns,
  READ_TIME_CALCULATION_BUDGET,
} from "./calculation-executor-service.ts";

const MAX_HELD = 500;
const MAX_PROJECTIONS = 500;
const MAX_OBSERVATIONS = 2_000;
const MAX_CASH_ACCOUNTS = 100;
const MAX_CASH_ENTRIES = 10_000;
const MAX_SELECTION_LOOKBACK_DAYS = 24;
const OVERRIDE_TARGET_CHUNK = 32;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
// cash_ledger_entries.signed_amount_decimal is the one genuinely signed
// source-of-record decimal this module reads directly (a withdrawal is
// negative by construction, e.g. paying for a buy) -- every other
// `sourceDecimal`/`DECIMAL` use here is a price, rate, quantity, or basis,
// none of which are ever negative at the source. Kept as its own pattern
// rather than loosening `DECIMAL` itself, so an unexpectedly negative
// price/quantity/basis still fails closed instead of silently validating.
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY = /^[A-Z]{3}$/;

function priorDate(value: string): string {
  const dateValue = new Date(`${value}T00:00:00Z`);
  dateValue.setUTCDate(dateValue.getUTCDate() - 1);
  return dateValue.toISOString().slice(0, 10);
}
function localDate(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const result = `${values.year}-${values.month}-${values.day}`;
    if (!DATE.test(result)) throw new Error("invalid_local_date");
    return result;
  } catch {
    throw new Error("invalid_portfolio_timezone");
  }
}

type Row = Record<string, unknown>;
type Identity = {
  id: string;
  securityId: string;
  symbol: string;
  name: string;
  exchange: string;
  currencyCode: string;
};
type Projection = {
  id: string;
  portfolioSecurityId: string;
  quantity: string;
  nativeBasis: string | null;
  homeBasis: string | null;
};

function field(row: Row, key: string): unknown {
  return row[key];
}
function requiredText(row: Row, key: string, pattern?: RegExp): string {
  const value = field(row, key);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (pattern && !pattern.test(value))
  )
    throw new Error(`invalid_${key}`);
  return value;
}
function optionalText(row: Row, key: string, pattern?: RegExp): string | null {
  const value = field(row, key);
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || (pattern && !pattern.test(value)))
    throw new Error(`invalid_${key}`);
  return value;
}
function integer(row: Row, key: string): number {
  const value = field(row, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid_${key}`);
  return value;
}
function sourceDecimal(
  value: string | null,
  key: string,
  positive = false,
): string | null {
  if (value === null) return null;
  if (!DECIMAL.test(value)) throw new Error(`invalid_${key}`);
  const parsed = parseDecimal(value);
  if (positive && isZero(parsed)) throw new Error(`invalid_${key}`);
  return value;
}
function signedSourceDecimal(value: string, key: string): string {
  if (!SIGNED_DECIMAL.test(value)) throw new Error(`invalid_${key}`);
  parseDecimalResult(value);
  return value;
}
function resultDecimal(value: string | null, key: string): string | null {
  if (value === null) return null;
  if (!DECIMAL.test(value)) throw new Error(`invalid_${key}`);
  parseDecimalResult(value);
  return value;
}
function enumValue<T extends string>(
  value: string,
  key: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T)) throw new Error(`invalid_${key}`);
  return value as T;
}
function scope(
  row: Row,
): { kind: "deployment"; userId: null } | { kind: "user"; userId: string } {
  const access = requiredText(row, "access_scope");
  const scopeUser = optionalText(row, "scope_user_id");
  const scopeKey = requiredText(row, "scope_key");
  if (
    access === "deployment" &&
    scopeUser === null &&
    scopeKey === "deployment"
  )
    return { kind: "deployment", userId: null };
  if (access === "user" && scopeUser !== null && scopeKey === scopeUser)
    return { kind: "user", userId: scopeUser };
  throw new Error("invalid_observation_scope");
}
function available(currencyCode: string, value: string): OwnedHoldingValue {
  return { status: "available", currencyCode, value, reason: null };
}
function unavailable(currencyCode: string, reason: string): OwnedHoldingValue {
  return { status: "unavailable", currencyCode, value: null, reason };
}
function tone(value: string | null): Tone {
  return value === null || /^0(?:\.0*)?$/.test(value)
    ? "neutral"
    : value.startsWith("-")
      ? "negative"
      : "positive";
}
function money(
  value: string | null,
  currencyCode: string,
  reason = "missing_value",
): OwnedHoldingValue {
  return value === null
    ? unavailable(currencyCode, reason)
    : available(currencyCode, value);
}
// UI-031: adapts a row's already-rendered `OwnedHoldingValue` (this
// module's own contract shape) into the domain layer's `CalculationValue`
// (`composePortfolioTotals`/`composePortfolioDailyMovementTotal`'s input
// shape) for the summary row's totals below. `reason` is deliberately
// collapsed to a single generic value on the unavailable branch -- neither
// portfolio-total function inspects `reason` for anything beyond narrowing
// `status`, so this never needs (and must never invent) a mapping from
// `OwnedHoldingRow`'s own free-form reason strings to
// `CalculationUnavailableReason`'s specific literal union.
function toCalculationValue(value: OwnedHoldingValue): CalculationValue {
  return value.status === "available" && value.value !== null
    ? { status: "available", valueDecimal: value.value }
    : { status: "unavailable", reason: "invalid_input" };
}
// BRK-012C: honest, explicit source labelling for a selected price's
// `interval` -- required so a Sharesight-sourced current price is ALWAYS
// identifiable as "Delayed (Sharesight)" with its own quote timestamp
// (`observationAt`, Sharesight's `current_price_updated_at` normalized to
// UTC -- see `domain/sharesight/price-accretion.ts`), never merely
// "provider sharesight" buried in generic wording, and NEVER "live" (AGENTS
// non-negotiable -- `tests/brk-012c.test.ts` greps this file's rendered
// explanation text for that word). `eod`/`intraday`/`manual` keep their
// existing plain interval name -- this labelling is additive, not a
// reinterpretation of any other provider's data.
function priceIntervalLabel(selected: SelectedPrice): string {
  return selected.interval === "delayed"
    ? `Delayed (Sharesight) as of ${selected.observationAt ?? "not supplied"}`
    : selected.interval;
}
function evidence(selection: PriceSelection | FxSelection): FxEvidence | null {
  const selected = selection.selected;
  if (!selected) return null;
  return {
    rateDecimal:
      "rateDecimal" in selected ? selected.rateDecimal : selected.closeDecimal,
    baseCurrencyCode:
      "baseCurrencyCode" in selected
        ? selected.baseCurrencyCode
        : selected.currencyCode,
    quoteCurrencyCode:
      "quoteCurrencyCode" in selected
        ? selected.quoteCurrencyCode
        : selected.currencyCode,
    marketDate: selected.marketDate,
    observedAt:
      "observedAt" in selected ? selected.observedAt : selected.observationAt,
    source:
      selection.explanation.source === "manual"
        ? "manual"
        : selection.explanation.source === "identity"
          ? "identity"
          : "provider",
    sourceId: selection.explanation.providerId,
    selectionState: selection.status as FxEvidence["selectionState"],
    quality: selected.quality === "identity" ? "identity" : selected.quality,
    fallback: selection.explanation.fallback,
    selectionReason: selection.explanation.reason,
  };
}
// MKT-009B: maps the owner's PRICE-SOURCE PREFERENCE setting to the
// `providerId`(s) `selectPriceObservation` should try first (see that
// function's own `preferredProviderIds` doc comment for the honest-fallback
// semantics). Both Yahoo options prefer the SAME `providerId` --
// `price_observations` accretes one row per provider/mapping/date (last
// write wins), so there is no separately-stored "authenticated" vs
// "anonymous" Yahoo row to choose between; the distinction instead surfaces
// as the `yahooAuthPreferenceUnmet` note built alongside `priceDetail`
// below, using the SAME observation's `providerRevisionId` session tag.
function providerIdsForPreference(
  preference: PriceSourcePreference,
): readonly string[] {
  switch (preference) {
    case "yahoo_authenticated":
    case "yahoo_anonymous":
      return ["yahoo-compatible"];
    case "sharesight_delayed":
      return ["sharesight"];
  }
}
// MKT-009B (review round-1 fix, B1 -- BLOCKING): the ORIGINAL combiner below
// hardcoded "the user-scoped (Sharesight/owner-import) selection wins any
// market-date tie against the deployment-scoped (Yahoo) one", with no
// knowledge of `preferredProviderIds` at all -- `preferredProviderIds` was
// only ever applied WITHIN each of the two scope-restricted
// `selectPriceObservation` calls (narrowing deployment-scope down to
// nothing-but-Yahoo, or user-scope down to Sharesight over owner-import),
// never across them. Reproduced by the reviewer: a same-date Yahoo + a
// same-date Sharesight row selected Sharesight under EVERY preference,
// including `yahoo_authenticated`/`yahoo_anonymous` -- the feature was a
// no-op for two of its three settings. Fixed by making the CROSS-scope
// choice preference-aware too: whichever scope's own selection actually
// matches the preferred provider(s) wins outright over the other scope,
// with no date comparison at all -- per the Orchestrator's F1 ruling
// (docs/CALCULATIONS.md §2), a configured preference deliberately outranks
// freshness within the existing fallback window; that IS what "prefer this
// source" means. The original recency tie-break is preserved verbatim as
// the fallback path for the no-preference case and for the (structurally
// impossible today, but not assumed away) case where neither or both
// scopes match the preference.
function combineScopedPriceSelections(
  deployment: PriceSelection,
  user: PriceSelection,
  preferredProviderIds: readonly string[] | null | undefined,
): PriceSelection {
  // MKT-012 round 2 (Orchestrator ruling, 2026-08-22, rule 4): an
  // owner-import row is ALWAYS user-scope (`app/price-upload-service.ts`
  // writes `access_scope = 'user'` only for CSV upload/backup restore). At
  // an equal-or-newer market date than whatever the deployment scope itself
  // selected, it wins this combiner OUTRIGHT -- checked BEFORE the
  // preference branch below, so a configured `yahoo_authenticated`/
  // `yahoo_anonymous` preference (which matches the DEPLOYMENT scope's own
  // selection and would otherwise hand it the win purely on that match)
  // can never defeat the owner's own uploaded close. A strictly OLDER
  // owner-import date still loses to a fresher deployment-scope
  // observation -- date-age precedence is unchanged; this is a same-or-newer
  // check, not a blanket override.
  if (
    user.selected?.providerId === OWNER_IMPORT_PROVIDER_ID &&
    (!deployment.selected ||
      user.selected.marketDate >= deployment.selected.marketDate)
  ) {
    return user;
  }
  if (preferredProviderIds && preferredProviderIds.length > 0) {
    const deploymentPreferred =
      deployment.selected !== null &&
      deployment.selected.providerId !== null &&
      preferredProviderIds.includes(deployment.selected.providerId);
    const userPreferred =
      user.selected !== null &&
      user.selected.providerId !== null &&
      preferredProviderIds.includes(user.selected.providerId);
    if (deploymentPreferred && !userPreferred) return deployment;
    if (userPreferred && !deploymentPreferred) return user;
    // Neither (or, structurally impossible today, both) scope's selection
    // matches the preference -- honest fallback to the ORIGINAL recency
    // tie-break below, identical to the no-preference case.
  }
  return user.selected &&
    (!deployment.selected ||
      user.selected.marketDate >= deployment.selected.marketDate)
    ? user
    : deployment;
}
function choosePrice(
  input: Parameters<typeof selectPriceObservation>[0],
  userId: string,
): Promise<PriceSelection> {
  return Promise.all([
    selectPriceObservation(input),
    selectPriceObservation({ ...input, scope: { kind: "user", userId } }),
  ]).then(([deployment, user]) =>
    combineScopedPriceSelections(deployment, user, input.preferredProviderIds),
  );
}
function chooseFx(
  input: Parameters<typeof selectFxObservation>[0],
  userId: string,
): FxSelection {
  const deployment = selectFxObservation(input);
  const user = selectFxObservation({
    ...input,
    scope: { kind: "user", userId },
  });
  return user.selected &&
    (!deployment.selected ||
      user.selected.marketDate >= deployment.selected.marketDate)
    ? user
    : deployment;
}
function unavailableFxSelection(reason: string): FxSelection {
  return {
    status: "unavailable",
    selected: null,
    display: null,
    explanation: {
      reason,
      source: "none",
      providerId: null,
      observationAt: null,
      marketDate: null,
      quality: null,
      fallback: false,
      overrideId: null,
    },
  };
}

function mapPrice(row: Row): PriceObservation {
  const accessScope = scope(row);
  return {
    kind: "price",
    providerId: requiredText(row, "provider_id"),
    providerRevisionId: optionalText(row, "provider_revision_id"),
    mappingId: requiredText(row, "mapping_id"),
    securityId: requiredText(row, "security_id"),
    scope: accessScope,
    interval: enumValue(requiredText(row, "interval"), "interval", [
      "eod",
      "delayed",
      "intraday",
    ]),
    observationAt: requiredText(row, "observation_at", ISO),
    marketDate: requiredText(row, "market_date", DATE),
    marketTimezone: requiredText(row, "market_timezone"),
    currencyCode: requiredText(row, "currency_code", CURRENCY),
    closeDecimal: sourceDecimal(
      requiredText(row, "close_decimal"),
      "close_decimal",
      true,
    )!,
    previousCloseDecimal: sourceDecimal(
      optionalText(row, "previous_close_decimal"),
      "previous_close_decimal",
      true,
    ),
    adjustmentState: enumValue(
      requiredText(row, "adjustment_state"),
      "adjustment_state",
      ["raw", "split_adjusted", "total_return_adjusted"],
    ),
    adjustmentFactor: null,
    quality: enumValue(requiredText(row, "quality"), "quality", [
      "observed",
      "corrected",
      "indicative",
      "stale_candidate",
    ]),
    delayedMinutes:
      field(row, "delayed_minutes") === null
        ? null
        : integer(row, "delayed_minutes"),
    ingestedAt: requiredText(row, "ingested_at", ISO),
    payloadSha256: optionalText(row, "payload_sha256"),
  };
}
function mapFx(row: Row): FxObservation {
  const accessScope = scope(row);
  return {
    kind: "fx",
    providerId: requiredText(row, "provider_id"),
    providerRevisionId: optionalText(row, "provider_revision_id"),
    scope: accessScope,
    baseCurrencyCode: requiredText(row, "base_currency_code", CURRENCY),
    quoteCurrencyCode: requiredText(row, "quote_currency_code", CURRENCY),
    rateDecimal: sourceDecimal(
      requiredText(row, "rate_decimal"),
      "rate_decimal",
      true,
    )!,
    interval: enumValue(requiredText(row, "interval"), "interval", [
      "eod",
      "delayed",
      "intraday",
    ]),
    observedAt: requiredText(row, "observed_at", ISO),
    marketDate: requiredText(row, "market_date", DATE),
    quality: enumValue(requiredText(row, "quality"), "quality", [
      "observed",
      "corrected",
      "indicative",
      "stale_candidate",
    ]),
    delayedMinutes: null,
    ingestedAt: requiredText(row, "ingested_at", ISO),
    payloadSha256: optionalText(row, "payload_sha256"),
  };
}

export async function loadOwnedHoldings(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
  // BRK-012C test-only seam: lets tests inject a fake Sharesight
  // integration/clock/lease-owner into the read gate below without needing
  // the `cloudflare:workers` env import a plain node:sqlite test cannot
  // use. Production callers never pass this.
  sharesightGateOptions: SharesightPriceGateOptions = {},
): Promise<{
  status: "complete" | "partial" | "empty" | "unavailable";
  homeCurrencyCode: string;
  rows: OwnedHoldingRow[];
  cash: OwnedCashSummary;
  coverage: {
    total: number;
    nonZero: number;
    zero: number;
    priced: number;
    converted: number;
    basis: number;
  };
  // UI-031: `undefined` for a portfolio with no held securities at all
  // (nothing to summarise, mirroring the empty-state short-circuit
  // immediately below) -- present whenever `rows.length > 0`, even if every
  // row is a zero-quantity (sold-to-zero) one.
  unrealisedSummary?: OwnedHoldingsUnrealisedSummary;
}> {
  const nowIso = now.toISOString();
  const portfolio = await client.get<Row>(
    `SELECT base_currency_code, timezone FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) throw new Error("not_owned");
  const timezone = requiredText(portfolio, "timezone");
  const asOf = localDate(now, timezone);
  const homeCurrencyCode = requiredText(
    portfolio,
    "base_currency_code",
    CURRENCY,
  );
  const heldCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM portfolio_securities WHERE user_id = ? AND portfolio_id = ? AND status = 'held'`,
    [userId, portfolioId],
  );
  const heldCount = integer(heldCountRow ?? {}, "count");
  if (heldCount > MAX_HELD) throw new Error("too_many_holdings");
  if (heldCount === 0) {
    const cash = await loadCash(
      client,
      userId,
      portfolioId,
      homeCurrencyCode,
      asOf,
      nowIso,
      timezone,
    );
    return {
      status:
        cash.cashSubtotal === null
          ? "empty"
          : cash.status === "complete"
            ? "complete"
            : "partial",
      homeCurrencyCode,
      rows: [],
      cash,
      coverage: {
        total: 0,
        nonZero: 0,
        zero: 0,
        priced: 0,
        converted: 0,
        basis: 0,
      },
    };
  }
  let publicationCount = await client.get<Row>(
    `SELECT count(*) AS count FROM projection_publications pp WHERE pp.user_id = ? AND pp.portfolio_id = ?`,
    [userId, portfolioId],
  );
  if (integer(publicationCount ?? {}, "count") !== 1) {
    // CALC-003 trigger 2 (read-time self-heal): this is the single choke
    // point every owned-holdings read passes through (and, transitively via
    // `loadOwnedHoldings`, `owned-income-projection.ts` and
    // `owned-dividend-assumptions.ts`) when a portfolio's calculation runs
    // were queued (by a ledger post or import commit) but never advanced --
    // e.g. local dev with no cron, or trigger 1's post-commit budget
    // exhausting before this portfolio's run finished. Best-effort, bounded,
    // and re-read exactly once: if nothing is claimable (or another reader
    // already claimed it -- lease semantics prevent stampedes) this falls
    // through to the existing honest "not yet calculated" failure below,
    // never a fabricated result.
    await advanceCalculationRuns(
      { client, now: () => nowIso },
      {
        userId,
        portfolioId,
        pipeline: "projection",
        budget: READ_TIME_CALCULATION_BUDGET,
      },
    ).catch(() => undefined);
    publicationCount = await client.get<Row>(
      `SELECT count(*) AS count FROM projection_publications pp WHERE pp.user_id = ? AND pp.portfolio_id = ?`,
      [userId, portfolioId],
    );
  }
  if (integer(publicationCount ?? {}, "count") !== 1)
    throw new Error("invalid_projection_publication_count");
  const publication = await client.get<Row>(
    `SELECT pp.calculation_run_id, pp.calculation_version, pp.ledger_high_water, r.status AS run_status, r.calculation_version AS run_version, r.ledger_high_water_end, p.base_currency_code FROM projection_publications pp JOIN portfolios p ON p.id = pp.portfolio_id AND p.user_id = pp.user_id JOIN calculation_runs r ON r.id = pp.calculation_run_id AND r.user_id = pp.user_id AND r.portfolio_id = pp.portfolio_id WHERE pp.user_id = ? AND pp.portfolio_id = ? LIMIT 1`,
    [userId, portfolioId],
  );
  if (!publication) throw new Error("missing_projection_publication");
  const runId = requiredText(publication, "calculation_run_id");
  const version = integer(publication, "calculation_version");
  if (
    requiredText(publication, "run_status") !== "completed" ||
    integer(publication, "run_version") !== version ||
    requiredText(publication, "ledger_high_water") !==
      requiredText(publication, "ledger_high_water_end") ||
    requiredText(publication, "base_currency_code") !== homeCurrencyCode
  )
    throw new Error("invalid_projection_publication");
  const identities = (
    await client.all<Row>(
      `SELECT ps.id, ps.security_id, COALESCE(ps.display_symbol, ps.source_symbol) AS symbol, COALESCE(ps.display_name, s.canonical_name, ps.source_name, ps.source_symbol) AS name, COALESCE(e.mic, e.name, ps.source_exchange_alias, 'N/A') AS exchange, s.primary_currency_code FROM portfolio_securities ps JOIN securities s ON s.id = ps.security_id LEFT JOIN exchanges e ON e.id = s.exchange_id WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held' ORDER BY ps.id LIMIT ?`,
      [userId, portfolioId, MAX_HELD],
    )
  ).map((row): Identity => ({
    id: requiredText(row, "id"),
    securityId: requiredText(row, "security_id"),
    symbol: requiredText(row, "symbol"),
    name: requiredText(row, "name"),
    exchange: requiredText(row, "exchange"),
    currencyCode: requiredText(row, "primary_currency_code", CURRENCY),
  }));
  if (identities.length !== heldCount)
    throw new Error("invalid_held_security_count");
  // BRK-012C read-time gate: before reading price_observations below, make
  // sure this owner's Sharesight delayed-price data (if any) is no more
  // than 10 minutes stale for their CURRENT holdings -- see
  // `app/sharesight-price-gate-service.ts`'s module doc comment for the
  // full four-gate design (credentials -> enabled link -> cache staleness
  // -> single-flight lease). Best-effort, exactly like CALC-003's
  // `advanceCalculationRuns(...).catch(() => undefined)` immediately below:
  // a fetch failure, a lost lease race, or a genuine DB error here must
  // never block this read -- the existing price selection below simply
  // sees whatever data already exists, honestly.
  await ensureSharesightPriceFreshness(
    client,
    userId,
    identities.map((identity) => identity.securityId),
    // The gate's own clock defaults to this SAME request's `nowIso` (not a
    // fresh `new Date()`) so its 10-minute staleness comparison is anchored
    // to the read's own "now", not real wall-clock time -- a caller-
    // supplied `now` override (test-only) still wins via spread order.
    { now: () => nowIso, ...sharesightGateOptions },
  ).catch(() => undefined);
  const projectionRows = await client.all<Row>(
    `SELECT id, portfolio_security_id, quantity_decimal, native_open_basis_decimal, base_open_basis_decimal, completeness, status, calculation_run_id, calculation_version, last_ledger_high_water FROM holding_projections WHERE user_id = ? AND portfolio_id = ? AND calculation_run_id = ? AND status = 'ready' ORDER BY portfolio_security_id LIMIT ?`,
    [userId, portfolioId, runId, MAX_PROJECTIONS + 1],
  );
  if (
    projectionRows.length > MAX_PROJECTIONS ||
    projectionRows.length !== heldCount
  )
    throw new Error("invalid_projection_count");
  const projections = projectionRows.map((row): Projection => {
    if (
      requiredText(row, "calculation_run_id") !== runId ||
      integer(row, "calculation_version") !== version ||
      requiredText(row, "last_ledger_high_water") !==
        requiredText(publication, "ledger_high_water") ||
      !["complete", "partial", "incomplete"].includes(
        requiredText(row, "completeness"),
      )
    )
      throw new Error("invalid_projection_row");
    return {
      id: requiredText(row, "id"),
      portfolioSecurityId: requiredText(row, "portfolio_security_id"),
      quantity: resultDecimal(
        requiredText(row, "quantity_decimal"),
        "quantity_decimal",
      )!,
      nativeBasis: resultDecimal(
        optionalText(row, "native_open_basis_decimal"),
        "native_open_basis_decimal",
      ),
      homeBasis: resultDecimal(
        optionalText(row, "base_open_basis_decimal"),
        "base_open_basis_decimal",
      ),
    };
  });
  const ids = new Set(identities.map((row) => row.id));
  const projectionIds = new Set(
    projections.map((row) => row.portfolioSecurityId),
  );
  if (
    projectionIds.size !== projections.length ||
    projections.some((row) => !ids.has(row.portfolioSecurityId))
  )
    throw new Error("projection_identity_mismatch");
  const priceCountRow = await client.get<Row>(
    // BRK-012B review B1/B3 (2026-08-20) originally excluded
    // `provider_id = 'sharesight'` rows here ("this slice is pure
    // storage"). BRK-012C deliberately LIFTS that exclusion: a user-scoped
    // Sharesight accretion row is a legitimate valuation input for CURRENT
    // holdings, ranked by the EXISTING selection semantics
    // (`domain/market-data/selection.ts`'s `providerRank`), under which
    // `delayed` still outranks `eod` at equal date age. MKT-012 (owner
    // ruling, 2026-08-22, round 2) does NOT change that ordinary interval
    // tie-break -- it adds a NARROWER `OWNER_IMPORT_PROVIDER_ID` precedence
    // tier ahead of it: a same-or-newer-date owner-uploaded CSV close (this
    // combiner's `combineScopedPriceSelections`, above) now outranks a
    // same-date Sharesight `delayed` accretion row, but an ordinary
    // provider-vs-provider `eod`/`delayed` tie (e.g. two live sources, or
    // owner-import absent) is UNCHANGED from BRK-012C's original ordering
    // (`docs/CALCULATIONS.md` §2's MKT-012 note).
    // Freshness is bounded by the read gate immediately above
    // (`ensureSharesightPriceFreshness`), which piggybacks the SAME
    // accretion write this query now reads. The snapshot/historical path
    // (`db/repositories/snapshots.ts`) keeps its OWN identical predicate --
    // that exclusion is untouched by this task (EOD semantics for
    // historical valuations, per TASKS.md's BRK-012C ruling).
    `SELECT count(*) AS count FROM price_observations po WHERE po.adjustment_state = 'raw' AND po.market_date BETWEEN date(?, '-${MAX_SELECTION_LOOKBACK_DAYS} days') AND ? AND po.observation_at <= ? AND po.ingested_at <= ? AND ((po.access_scope = 'deployment' AND po.scope_user_id IS NULL) OR (po.access_scope = 'user' AND po.scope_user_id = ?)) AND EXISTS (SELECT 1 FROM portfolio_securities ps WHERE ps.security_id = po.security_id AND ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held')`,
    [asOf, asOf, nowIso, nowIso, userId, userId, portfolioId],
  );
  const priceCount = integer(priceCountRow ?? {}, "count");
  if (priceCount > MAX_OBSERVATIONS)
    throw new Error("too_many_price_observations");
  const prices = await client.all<Row>(
    // See the count query above -- BRK-012C lifted the `provider_id <>
    // 'sharesight'` exclusion here too; both queries must agree or
    // `priceCount`/`prices.length` could diverge.
    `SELECT po.* FROM price_observations po WHERE po.adjustment_state = 'raw' AND po.market_date BETWEEN date(?, '-${MAX_SELECTION_LOOKBACK_DAYS} days') AND ? AND po.observation_at <= ? AND po.ingested_at <= ? AND ((po.access_scope = 'deployment' AND po.scope_user_id IS NULL) OR (po.access_scope = 'user' AND po.scope_user_id = ?)) AND EXISTS (SELECT 1 FROM portfolio_securities ps WHERE ps.security_id = po.security_id AND ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held') ORDER BY po.security_id, po.market_date DESC, po.observation_at DESC LIMIT ?`,
    [
      asOf,
      asOf,
      nowIso,
      nowIso,
      userId,
      userId,
      portfolioId,
      MAX_OBSERVATIONS + 1,
    ],
  );
  if (prices.length > MAX_OBSERVATIONS)
    throw new Error("too_many_price_observations");
  const priceObservations = prices.map(mapPrice);
  const cashCurrencies = (
    await client.all<Row>(
      `SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ? AND status = 'active' ORDER BY id LIMIT ?`,
      [userId, portfolioId, MAX_CASH_ACCOUNTS + 1],
    )
  ).map((row) => requiredText(row, "currency_code", CURRENCY));
  if (cashCurrencies.length > MAX_CASH_ACCOUNTS)
    throw new Error("too_many_cash_accounts");
  const relevantCurrencies = [
    ...new Set([
      homeCurrencyCode,
      ...identities.map((identity) => identity.currencyCode),
      ...cashCurrencies,
    ]),
  ];
  const fxPredicate = `(
    fx.base_currency_code <> fx.quote_currency_code AND
    (fx.base_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
      AND fx.quote_currency_code IN (
        SELECT s.primary_currency_code FROM portfolio_securities ps JOIN securities s ON s.id = ps.security_id WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held'
        UNION SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ? AND status = 'active'
      ))
    OR
    (fx.quote_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
      AND fx.base_currency_code IN (
        SELECT s.primary_currency_code FROM portfolio_securities ps JOIN securities s ON s.id = ps.security_id WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held'
        UNION SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ? AND status = 'active'
      ))
  )`;
  const fxPredicateParams = [
    portfolioId,
    userId,
    userId,
    portfolioId,
    userId,
    portfolioId,
    portfolioId,
    userId,
    userId,
    portfolioId,
    userId,
    portfolioId,
  ];
  const fxCountRow = await client.get<Row>(
    `SELECT count(*) AS count FROM fx_rate_observations fx WHERE fx.market_date BETWEEN date(?, '-${MAX_SELECTION_LOOKBACK_DAYS} days') AND ? AND fx.observed_at <= ? AND fx.ingested_at <= ? AND ((fx.access_scope = 'deployment' AND fx.scope_user_id IS NULL) OR (fx.access_scope = 'user' AND fx.scope_user_id = ?)) AND ${fxPredicate}`,
    [asOf, asOf, nowIso, nowIso, userId, ...fxPredicateParams],
  );
  const fxCount = integer(fxCountRow ?? {}, "count");
  if (fxCount > MAX_OBSERVATIONS) throw new Error("too_many_fx_observations");
  const fxRows = (
    await client.all<Row>(
      `SELECT fx.* FROM fx_rate_observations fx WHERE fx.market_date BETWEEN date(?, '-${MAX_SELECTION_LOOKBACK_DAYS} days') AND ? AND fx.observed_at <= ? AND fx.ingested_at <= ? AND ((fx.access_scope = 'deployment' AND fx.scope_user_id IS NULL) OR (fx.access_scope = 'user' AND fx.scope_user_id = ?)) AND ${fxPredicate} ORDER BY fx.market_date DESC, fx.observed_at DESC LIMIT ?`,
      [
        asOf,
        asOf,
        nowIso,
        nowIso,
        userId,
        ...fxPredicateParams,
        MAX_OBSERVATIONS + 1,
      ],
    )
  ).map(mapFx);
  if (fxRows.length > MAX_OBSERVATIONS)
    throw new Error("too_many_fx_observations");
  const overrideRepo = createOwnedManualOverrideRepository(client);
  const overrideTargets = [
    ...identities.map((identity) => identity.securityId),
    ...relevantCurrencies
      .filter((currency) => currency !== homeCurrencyCode)
      .map((currency) => `${homeCurrencyCode}/${currency}`),
  ];
  const uniqueOverrideTargets = [...new Set(overrideTargets)];
  const overrideLists: Awaited<
    ReturnType<typeof overrideRepo.listBoundedRelevant>
  >[] = [];
  let overrideRemaining = MAX_OBSERVATIONS;
  for (
    let index = 0;
    index < uniqueOverrideTargets.length;
    index += OVERRIDE_TARGET_CHUNK
  ) {
    const list = await overrideRepo.listBoundedRelevant(
      userId,
      uniqueOverrideTargets.slice(index, index + OVERRIDE_TARGET_CHUNK),
      overrideRemaining + 1,
    );
    if (list.length > overrideRemaining) throw new Error("too_many_overrides");
    overrideLists.push(list);
    overrideRemaining -= list.length;
  }
  const overrides = overrideLists
    .flat()
    .filter(
      (row) =>
        (row.type === "price" || row.type === "fx_rate") &&
        (row.portfolioId === null || row.portfolioId === portfolioId),
    );
  const projectionBySecurity = new Map(
    projections.map((row) => [row.portfolioSecurityId, row]),
  );
  const tradeRows = await client.all<Row>(
    `SELECT portfolio_security_id, local_trade_date, trade_at, status FROM transactions WHERE user_id = ? AND portfolio_id = ? AND local_trade_date BETWEEN date(?, '-${MAX_SELECTION_LOOKBACK_DAYS} days') AND ? AND status IN ('posted', 'reversed') ORDER BY local_trade_date, trade_at, id LIMIT ?`,
    [userId, portfolioId, asOf, asOf, MAX_OBSERVATIONS + 1],
  );
  if (tradeRows.length > MAX_OBSERVATIONS)
    throw new Error("too_many_trade_facts");
  const trades = tradeRows.map((row) => ({
    securityId: optionalText(row, "portfolio_security_id"),
    localDate: requiredText(row, "local_trade_date", DATE),
    tradeAt: requiredText(row, "trade_at", ISO),
    status: enumValue(requiredText(row, "status"), "transaction_status", [
      "posted",
      "reversed",
    ]),
  }));
  // MKT-009B: one PK lookup, reused for every held security below rather
  // than re-queried per row. Missing settings (should not happen for an
  // owner with a live portfolio) fails HONEST, not silent -- the same
  // `sharesight_delayed` default the column itself carries, never a thrown
  // error over a preference lookup alone.
  const userSettings =
    await createOwnedUserSettingsRepository(client).get(userId);
  const priceSourcePreference: PriceSourcePreference =
    userSettings?.priceSourcePreference ?? "sharesight_delayed";
  const preferredProviderIds = providerIdsForPreference(priceSourcePreference);
  const rows = await Promise.all(
    identities.map(async (identity): Promise<OwnedHoldingRow> => {
      const projection = projectionBySecurity.get(identity.id);
      if (!projection) throw new Error("missing_projection_row");
      const quantity = projection.quantity;
      const zero = isZero(parseDecimalResult(quantity));
      const nativeBasis = projection.nativeBasis;
      const homeBasis = projection.homeBasis;
      const priceSelection = await choosePrice(
        {
          asOf,
          portfolioTimezone: timezone,
          now: nowIso,
          targetKey: identity.securityId,
          userId,
          scope: { kind: "deployment", userId: null },
          currencyCode: identity.currencyCode,
          observations: priceObservations.filter(
            (row) => row.securityId === identity.securityId,
          ),
          overrides: overrides.filter(
            (row) =>
              row.targetKey === identity.securityId &&
              (row.portfolioId === null || row.portfolioId === portfolioId),
          ),
          preferredProviderIds,
        },
        userId,
      );
      const price = priceSelection.selected?.closeDecimal ?? null;
      const marketDate = priceSelection.selected?.marketDate ?? asOf;
      const previousSelection = await choosePrice(
        {
          asOf: priorDate(marketDate),
          portfolioTimezone: timezone,
          now: nowIso,
          targetKey: identity.securityId,
          userId,
          scope: { kind: "deployment", userId: null },
          currencyCode: identity.currencyCode,
          observations: priceObservations.filter(
            (row) => row.securityId === identity.securityId,
          ),
          overrides: overrides.filter(
            (row) =>
              row.targetKey === identity.securityId &&
              (row.portfolioId === null || row.portfolioId === portfolioId),
          ),
          preferredProviderIds,
        },
        userId,
      );
      const previousPrice = previousSelection.selected?.closeDecimal ?? null;
      const fxSelection = chooseFx(
        {
          asOf: marketDate,
          portfolioTimezone: timezone,
          baseCurrencyCode: homeCurrencyCode,
          quoteCurrencyCode: identity.currencyCode,
          targetKey: `${homeCurrencyCode}/${identity.currencyCode}`,
          userId,
          scope: { kind: "deployment", userId: null },
          observations: fxRows,
          overrides: overrides.filter(
            (row) =>
              row.type === "fx_rate" &&
              row.targetKey ===
                `${homeCurrencyCode}/${identity.currencyCode}` &&
              (row.portfolioId === null || row.portfolioId === portfolioId),
          ),
        },
        userId,
      );
      const currentFx = evidence(fxSelection);
      const previousFxSelection = previousSelection.selected
        ? chooseFx(
            {
              asOf: previousSelection.selected.marketDate,
              portfolioTimezone: timezone,
              baseCurrencyCode: homeCurrencyCode,
              quoteCurrencyCode: identity.currencyCode,
              targetKey: `${homeCurrencyCode}/${identity.currencyCode}`,
              userId,
              scope: { kind: "deployment", userId: null },
              observations: fxRows,
              overrides: overrides.filter(
                (row) =>
                  row.type === "fx_rate" &&
                  row.targetKey ===
                    `${homeCurrencyCode}/${identity.currencyCode}` &&
                  (row.portfolioId === null || row.portfolioId === portfolioId),
              ),
            },
            userId,
          )
        : unavailableFxSelection("previous_price_unavailable");
      const previousFx = evidence(previousFxSelection);
      const currentPriceObservation = priceSelection.selected?.observation;
      const previousPriceObservation = previousSelection.selected?.observation;
      // MKT-016 (owner ruling, 2026-08-22, verbatim: "This is actually
      // fine, the historical prices are closing prices. And if they are
      // wrong it is a minor and temporary issue."): a previous-day
      // `eod`-class close is ALWAYS an acceptable baseline for the current
      // price, regardless of source/provider/quality -- an end-of-day
      // closing print means the same thing no matter which feed produced
      // it (owner-import CSV, Yahoo-compatible, or any future EOD
      // provider), so sharesight-delayed-today vs owner-import-eod-
      // yesterday now computes a real day change instead of being refused.
      // The strict same-source/provider/interval/quality/mapping rule
      // REMAINS for every other pairing -- in particular two different
      // `delayed` feeds on the same day (cross-provider delayed-vs-delayed)
      // are still not a genuine movement, since neither side is a settled
      // closing price. `mappingId` equality is deliberately dropped from
      // the relaxed eod-baseline branch: an owner-import or other-provider
      // close necessarily resolves through its OWN provider mapping row
      // for the same security (see `db/repositories/price-uploads.ts`),
      // so requiring the same `mappingId` there would silently re-impose
      // the strict rule and defeat the ruling. `adjustmentState` equality
      // stays required in BOTH branches -- comparing a raw close against a
      // split/total-return-adjusted one is never a genuine movement,
      // whatever the provider basis.
      const priceClassBasisComparable =
        previousSelection.selected?.interval === "eod" &&
        (priceSelection.selected?.interval === "delayed" ||
          priceSelection.selected?.interval === "eod")
          ? true
          : priceSelection.selected?.source ===
              previousSelection.selected?.source &&
            priceSelection.selected?.providerId ===
              previousSelection.selected?.providerId &&
            priceSelection.selected?.interval ===
              previousSelection.selected?.interval &&
            priceSelection.selected?.quality ===
              previousSelection.selected?.quality &&
            (currentPriceObservation?.mappingId ?? identity.securityId) ===
              (previousPriceObservation?.mappingId ?? identity.securityId);
      const priceClassComparable =
        Boolean(priceSelection.selected && previousSelection.selected) &&
        priceClassBasisComparable &&
        (currentPriceObservation?.adjustmentState ?? "manual") ===
          (previousPriceObservation?.adjustmentState ?? "manual");
      const fxClassComparable =
        Boolean(fxSelection.selected && previousFxSelection.selected) &&
        fxSelection.selected?.source === previousFxSelection.selected?.source &&
        fxSelection.selected?.providerId ===
          previousFxSelection.selected?.providerId &&
        fxSelection.selected?.interval ===
          previousFxSelection.selected?.interval &&
        fxSelection.selected?.quality ===
          previousFxSelection.selected?.quality &&
        fxSelection.selected?.baseCurrencyCode ===
          previousFxSelection.selected?.baseCurrencyCode &&
        fxSelection.selected?.quoteCurrencyCode ===
          previousFxSelection.selected?.quoteCurrencyCode;
      const quantityTiming = (() => {
        const previousObservedAt = previousSelection.selected?.observationAt;
        const currentObservedAt = priceSelection.selected?.observationAt;
        if (
          !previousSelection.selected ||
          !priceSelection.selected ||
          !currentObservedAt ||
          !previousObservedAt
        )
          return "incomplete" as const;
        return trades.some(
          (trade) =>
            trade.securityId === identity.id &&
            trade.tradeAt > previousObservedAt &&
            trade.tradeAt <= nowIso,
        )
          ? ("incomplete" as const)
          : ("comparable" as const);
      })();
      const holding = zero
        ? null
        : calculateNativeHomeHolding({
            quantityDecimal: quantity,
            nativePriceDecimal: price,
            nativeCurrencyCode: identity.currencyCode,
            homeCurrencyCode,
            valuationFx: currentFx,
          });
      const nativeValue = zero
        ? "0"
        : holding?.facts.nativeMarketValue.status === "available"
          ? holding.facts.nativeMarketValue.valueDecimal
          : null;
      const homePrice = zero
        ? holding?.facts.homePrice.status === "available"
          ? holding.facts.homePrice.valueDecimal
          : null
        : holding?.facts.homePrice.status === "available"
          ? holding.facts.homePrice.valueDecimal
          : null;
      const homeValue = zero
        ? "0"
        : holding?.facts.homeMarketValue.status === "available"
          ? holding.facts.homeMarketValue.valueDecimal
          : null;
      // BRK-012C review round (2026-08-20, B3 fix; HISTORY -- superseded in
      // part by MKT-016 below): `priceClassComparable` was originally kept
      // fully STRICT -- a cross-basis delta (e.g. today's price from
      // Sharesight-delayed, yesterday's from the Yahoo-compatible EOD feed)
      // was treated as genuinely not a comparable movement and never
      // computed. The HONESTY fix at the time was the REASON label: this
      // specific cause (both days' prices are known, just on different
      // bases) is distinct from a genuinely missing previous price/FX --
      // `!priceClassComparable` alone is NOT sufficient here, since it is
      // equally true when the PRICE side is comparable but the previous FX
      // observation is the one genuinely missing/mismatched (that case
      // correctly keeps the pre-existing "missing_previous_fx"/
      // "zero_previous_value" reasons below). Requiring both selections to
      // actually exist excludes the separate "missing_previous" actionStatus
      // case, which already has its own honest handling.
      //
      // MKT-016 (owner ruling, 2026-08-22): the sharesight-delayed-today vs
      // yahoo/owner-import-eod-yesterday case described above is NO LONGER
      // refused -- `priceClassComparable` (see its definition above) now
      // treats a previous-day `eod` close as an acceptable baseline for any
      // current price, so that pairing computes a real movement. This
      // `priceBasisChanged`/`price_basis_changed` reason path below is
      // unchanged in mechanism and still fires whenever both selections
      // exist but `priceClassComparable` is false -- which, post-MKT-016,
      // only happens for the pairings the guard still refuses (e.g.
      // cross-provider `delayed`-vs-`delayed`, or an adjustment-state/
      // mapping mismatch).
      const priceBasisChanged =
        !zero &&
        !priceClassComparable &&
        Boolean(priceSelection.selected) &&
        Boolean(previousSelection.selected);
      const dailyResult = zero
        ? null
        : !priceClassComparable || !fxClassComparable
          ? null
          : calculateDailyMovement({
              quantityDecimal: quantity,
              currentPriceDecimal: price,
              previousPriceDecimal: previousPrice,
              nativeCurrencyCode: identity.currencyCode,
              homeCurrencyCode,
              currentFx,
              previousFx,
              quantityTiming,
            });
      const daily = zero
        ? "0"
        : dailyResult?.compact.homeMovement.status === "available"
          ? dailyResult.compact.homeMovement.valueDecimal
          : null;
      const dailyPercent = zero
        ? null
        : dailyResult?.compact.homePercent.status === "available"
          ? dailyResult.compact.homePercent.valueDecimal
          : null;
      const gain =
        homeValue !== null && homeBasis !== null
          ? formatDecimalExact(
              subtractDecimal(
                parseDecimalResult(homeValue),
                parseDecimalResult(homeBasis),
              ),
            )
          : null;
      const gainPercent =
        gain !== null &&
        homeBasis !== null &&
        !isZero(parseDecimalResult(homeBasis))
          ? formatDecimalTrimmed(
              multiplyDecimal(
                divideDecimal(
                  parseDecimalResult(gain),
                  parseDecimalResult(homeBasis),
                ),
                parseDecimalResult("100"),
              ),
              2,
            )
          : null;
      const average =
        nativeBasis !== null && !zero
          ? formatDecimalTrimmed(
              divideDecimal(
                parseDecimalResult(nativeBasis),
                parseDecimalResult(quantity),
              ),
              12,
            )
          : null;
      const nativeCurrency = identity.currencyCode;
      const fxDetail = holding?.explanation.fx.explanation;
      // MKT-009B (review round-1 fix, B2): an owner who picked
      // `yahoo_authenticated` gets an explicit, FIRST-CLASS action-required
      // state (surfaced through the SAME `actionStatus` mechanism every
      // other action-required condition on this row uses -- see below --
      // not merely an sr-only explanation string) whenever the selected
      // price is NOT tagged `session:authenticated`. This must fire in
      // BOTH failing shapes: (a) a yahoo-compatible observation WAS
      // selected but isn't authenticated (absent/expired cookies, or the
      // adapter's own 401 degrade -- see `domain/market-data/
      // yahoo-compatible.ts`), and (b) the preferred provider supplied NO
      // price at all for this security, so some OTHER source's price is
      // being shown via honest fallback -- `selectedYahoo` is `null` in
      // that case, which the `!== "session:authenticated"` check below
      // already treats as unmet.
      const selectedYahoo =
        priceSelection.selected?.providerId === "yahoo-compatible"
          ? (priceSelection.selected.observation ?? null)
          : null;
      const yahooAuthPreferenceUnmet =
        priceSourcePreference === "yahoo_authenticated" &&
        selectedYahoo?.providerRevisionId !== "session:authenticated";
      // F2 (folded review follow-up): distinguish "cookies never
      // configured on this deployment" from "configured, but the current
      // session is anonymous" (expired/invalid cookies or a 401 degrade) --
      // never tell the owner to re-export a cookie pair that was never
      // configured. `session:anonymous` is ONLY ever recorded when
      // `options.auth` was actually configured for that write (see
      // `yahoo-compatible.ts`'s `normalizeChartPrice` call sites) so it is
      // a precise "was configured, now degraded" signal; `null` (or no
      // Yahoo observation at all) is the honest default bucket -- it
      // cannot distinguish "never configured" from "an old accretion row
      // predating a very recent config change", so it reads as the
      // less alarming, more broadly-true "not configured" message rather
      // than falsely implying the owner once had a working session.
      const yahooAuthActionStatus:
        "yahoo_auth_not_configured" | "yahoo_auth_expired" | null =
        !yahooAuthPreferenceUnmet
          ? null
          : selectedYahoo?.providerRevisionId === "session:anonymous"
            ? "yahoo_auth_expired"
            : "yahoo_auth_not_configured";
      const priceDetail = priceSelection.selected
        ? `current price source ${priceSelection.explanation.source} ${priceSelection.explanation.providerId ?? "identity"}, source ID ${priceSelection.selected.observation?.mappingId ?? "not supplied"}, value ${priceSelection.selected.closeDecimal}, market date ${priceSelection.selected.marketDate}, observation ${priceSelection.selected.observationAt ?? "not supplied"}, interval ${priceIntervalLabel(priceSelection.selected)}, quality ${priceSelection.selected.quality}, selector ${priceSelection.status}, fallback ${priceSelection.explanation.fallback}, reason ${priceSelection.explanation.reason}`
        : `price unavailable: ${priceSelection.explanation.reason}`;
      const previousPriceDetail = previousSelection.selected
        ? `previous price source ${previousSelection.explanation.source} ${previousSelection.explanation.providerId ?? "identity"}, source ID ${previousSelection.selected.observation?.mappingId ?? "not supplied"}, value ${previousSelection.selected.closeDecimal}, market date ${previousSelection.selected.marketDate}, observation ${previousSelection.selected.observationAt ?? "not supplied"}, interval ${priceIntervalLabel(previousSelection.selected)}, quality ${previousSelection.selected.quality}, selector ${previousSelection.status}, fallback ${previousSelection.explanation.fallback}, reason ${previousSelection.explanation.reason}`
        : `previous price unavailable, selector unavailable, reason ${previousSelection.explanation.reason}, actionability action_required`;
      const previousFxDetail = previousFx
        ? `previous FX source ${previousFx.source} ${previousFx.sourceId ?? "identity"}, supplied direction ${previousFx.baseCurrencyCode}/${previousFx.quoteCurrencyCode}, requested native→home ${nativeCurrency}/${homeCurrencyCode}, supplied rate ${previousFx.rateDecimal}, market date ${previousFx.marketDate}, observation ${previousFx.observedAt ?? "not supplied"}, inverted ${homeCurrencyCode === nativeCurrency ? "false" : previousFx.baseCurrencyCode === homeCurrencyCode && previousFx.quoteCurrencyCode === nativeCurrency ? "true" : "false"}, selector ${previousFxSelection.status}, quality ${previousFx.quality ?? "none"}, fallback ${previousFx.fallback}, reason ${previousFx.selectionReason ?? "none"}, actionability ${previousFxSelection.status === "stale" || previousFxSelection.status === "fallback" || previousFxSelection.selected?.source === "manual" || previousFx.quality === "indicative" || previousFx.quality === "corrected" || previousFx.quality === "stale_candidate" ? "explanation" : "none"}`
        : `previous FX unavailable, supplied rate unavailable, inversion unavailable/not applicable, selector unavailable, reason ${previousFxSelection.explanation.reason}, actionability action_required`;
      const fxDetailText = fxDetail
        ? `FX source ${fxDetail.source} ${fxDetail.sourceId ?? "identity"}, supplied ${fxDetail.suppliedBaseCurrencyCode ?? homeCurrencyCode}/${fxDetail.suppliedQuoteCurrencyCode ?? nativeCurrency} ${fxDetail.suppliedRateDecimal ?? "supplied rate unavailable"}, market date ${fxDetail.marketDate ?? marketDate}, observation ${fxDetail.observedAt ?? "not supplied"}, inverted ${fxDetail.inverted}, selector ${fxDetail.selectionState}, quality ${fxDetail.quality ?? "none"}, fallback ${fxDetail.fallback}, reason ${fxDetail.selectionReason ?? "none"}, actionability ${fxDetail.actionability}`
        : `FX unavailable: supplied rate unavailable, inversion unavailable/not applicable, selector unavailable, reason ${fxSelection.explanation.reason}, actionability action_required`;
      // F2/B2: a clean trailing sentence per action-required condition,
      // matching the established "Action required: …" convention (never a
      // mid-string clause woven into `priceDetail` above).
      const yahooAuthActionSentence =
        yahooAuthActionStatus === "yahoo_auth_expired"
          ? "Action required: the Yahoo login session is anonymous -- re-export YAHOO_COOKIE_T/YAHOO_COOKIE_Y."
          : yahooAuthActionStatus === "yahoo_auth_not_configured"
            ? "Action required: no Yahoo login is configured for this deployment."
            : "";
      const explanation = `${priceDetail}; ${previousPriceDetail}; ${fxDetailText}; ${previousFxDetail}. ${priceSelection.status === "stale" || fxSelection.status === "stale" ? "Action required: stale data." : ""}${yahooAuthActionSentence}`;
      return {
        id: identity.id,
        securityId: identity.securityId,
        symbol: identity.symbol,
        name: identity.name,
        exchange: identity.exchange,
        currencyCode: nativeCurrency,
        quantity,
        averageNativeCost: average,
        nativeBasis: money(nativeBasis, nativeCurrency, "missing_basis"),
        homeBasis: money(homeBasis, homeCurrencyCode, "missing_basis"),
        nativePrice: price,
        nativeValue: money(nativeValue, nativeCurrency, "missing_price"),
        homePrice: money(homePrice, homeCurrencyCode, "missing_fx"),
        homeValue: money(homeValue, homeCurrencyCode, "missing_fx"),
        dailyMovement: money(
          daily,
          homeCurrencyCode,
          priceBasisChanged ? "price_basis_changed" : "missing_previous_fx",
        ),
        dailyPercent: money(
          dailyPercent,
          "%",
          priceBasisChanged ? "price_basis_changed" : "zero_previous_value",
        ),
        unrealisedGain: money(gain, homeCurrencyCode, "missing_basis"),
        unrealisedPercent: money(gainPercent, "%", "zero_basis"),
        dailyTone: tone(daily),
        gainTone: tone(gain),
        priceState: priceSelection.status,
        actionStatus: zero
          ? "none"
          : priceSelection.status === "stale" || fxSelection.status === "stale"
            ? "stale"
            : priceSelection.status === "unavailable"
              ? "missing_price"
              : fxSelection.status === "unavailable"
                ? "missing_fx"
                : !previousSelection.selected || !previousFxSelection.selected
                  ? "missing_previous"
                  : !priceClassComparable ||
                      !fxClassComparable ||
                      quantityTiming === "incomplete"
                    ? "incomparable"
                    : yahooAuthActionStatus !== null
                      ? yahooAuthActionStatus
                      : "none",
        explanation,
        sort: {
          ticker: identity.symbol,
          value: homeValue,
          daily: dailyPercent,
          gain: gainPercent,
        },
      };
    }),
  );
  const cash = await loadCash(
    client,
    userId,
    portfolioId,
    homeCurrencyCode,
    asOf,
    nowIso,
    timezone,
    fxRows,
    overrides,
  );
  const securityCoverage = {
    total: rows.length,
    nonZero: rows.filter((row) => !isZero(parseDecimalResult(row.quantity)))
      .length,
    zero: rows.filter((row) => isZero(parseDecimalResult(row.quantity))).length,
    priced: rows.filter((row) => row.nativePrice !== null).length,
    converted: rows.filter(
      (row) =>
        row.homeValue.status === "available" &&
        !isZero(parseDecimalResult(row.quantity)),
    ).length,
    basis: rows.filter(
      (row) =>
        row.homeBasis.status === "available" &&
        !isZero(parseDecimalResult(row.quantity)),
    ).length,
  };
  const knownSecurityValues = rows.filter(
    (row) =>
      row.homeValue.status === "available" &&
      !isZero(parseDecimalResult(row.quantity)),
  );
  const securitiesSubtotal = knownSecurityValues.reduce(
    (total, row) =>
      addDecimal(total, parseDecimalResult(row.homeValue.value ?? "0")),
    parseDecimalResult("0"),
  );
  const securitiesKnown =
    securityCoverage.converted > 0 ||
    (securityCoverage.total > 0 && securityCoverage.nonZero === 0);
  const cashKnown = cash.cashSubtotal !== null;
  const knownComponentCount = (securitiesKnown ? 1 : 0) + (cashKnown ? 1 : 0);
  const knownTotal =
    knownComponentCount > 0
      ? formatDecimalExact(
          addDecimal(
            securitiesKnown ? securitiesSubtotal : parseDecimalResult("0"),
            cashKnown
              ? parseDecimalResult(cash.cashSubtotal!)
              : parseDecimalResult("0"),
          ),
        )
      : null;
  const coveragePartial =
    rows.some(
      (row) =>
        !isZero(parseDecimalResult(row.quantity)) &&
        (row.homeValue.status === "unavailable" ||
          row.homeBasis.status === "unavailable"),
    ) || cash.status !== "complete";
  // UI-031: the holdings summary row's first two lines, computed from the
  // SAME `rows` array the holdings list itself renders -- no second read,
  // no re-derivation of any per-row fact. Cash is deliberately excluded
  // (`cashAccounts: []`) -- it is already shown separately in the
  // portfolio-summary aside ("Cash is not included in security rows"), and
  // the owner's "Unrealised" line is specifically about holdings.
  const unrealisedSummaryValue: PortfolioTotalsResult = composePortfolioTotals({
    holdings: rows.map((row) => ({
      id: row.id,
      quantityDecimal: row.quantity,
      homeMarketValue: toCalculationValue(row.homeValue),
      homeOpenBasis: toCalculationValue(row.homeBasis),
    })),
    cashAccounts: [],
  });
  const unrealisedSummaryDaily: PortfolioDailyMovementResult =
    composePortfolioDailyMovementTotal({
      holdings: rows.map((row) => ({
        id: row.id,
        quantityDecimal: row.quantity,
        homeMarketValue: toCalculationValue(row.homeValue),
        homeDailyMovement: toCalculationValue(row.dailyMovement),
      })),
    });
  return {
    status: coveragePartial ? "partial" : "complete",
    homeCurrencyCode,
    rows,
    coverage: securityCoverage,
    cash: {
      ...cash,
      securitiesSubtotal: securitiesKnown
        ? formatDecimalExact(securitiesSubtotal)
        : null,
      knownTotal,
      status: coveragePartial ? "partial" : cash.status,
    },
    unrealisedSummary: {
      value: unrealisedSummaryValue,
      daily: unrealisedSummaryDaily,
    },
  };
}

async function loadCash(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  homeCurrencyCode: string,
  asOf: string,
  nowIso: string,
  timezone: string,
  fxRows: FxObservation[] = [],
  overrides: Awaited<
    ReturnType<ReturnType<typeof createOwnedManualOverrideRepository>["list"]>
  > = [],
): Promise<OwnedCashSummary> {
  const accounts = await client.all<Row>(
    `SELECT id, currency_code, completeness, status FROM cash_accounts WHERE user_id = ? AND portfolio_id = ? AND status = 'active' ORDER BY id LIMIT ?`,
    [userId, portfolioId, MAX_CASH_ACCOUNTS + 1],
  );
  if (accounts.length > MAX_CASH_ACCOUNTS)
    throw new Error("cash_account_limit");
  if (fxRows.length === 0) {
    const currencies = [
      ...new Set([
        homeCurrencyCode,
        ...accounts.map((row) => requiredText(row, "currency_code", CURRENCY)),
      ]),
    ];
    const cashFxPredicate = `(
      fx.base_currency_code <> fx.quote_currency_code AND
      (fx.base_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
        AND fx.quote_currency_code IN (
          SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ? AND status = 'active'
        ))
      OR
      (fx.quote_currency_code = (SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ?)
        AND fx.base_currency_code IN (
          SELECT currency_code FROM cash_accounts WHERE user_id = ? AND portfolio_id = ? AND status = 'active'
        ))
    )`;
    const cashFxPredicateParams = [
      portfolioId,
      userId,
      userId,
      portfolioId,
      portfolioId,
      userId,
      userId,
      portfolioId,
    ];
    const cashFxCount = await client.get<Row>(
      `SELECT count(*) AS count FROM fx_rate_observations fx WHERE fx.market_date BETWEEN date(?, '-${MAX_SELECTION_LOOKBACK_DAYS} days') AND ? AND fx.observed_at <= ? AND fx.ingested_at <= ? AND ((fx.access_scope = 'deployment' AND fx.scope_user_id IS NULL) OR (fx.access_scope = 'user' AND fx.scope_user_id = ?)) AND ${cashFxPredicate}`,
      [asOf, asOf, nowIso, nowIso, userId, ...cashFxPredicateParams],
    );
    if (integer(cashFxCount ?? {}, "count") > MAX_OBSERVATIONS)
      throw new Error("too_many_fx_observations");
    const cashFxRows = await client.all<Row>(
      `SELECT fx.* FROM fx_rate_observations fx WHERE fx.market_date BETWEEN date(?, '-${MAX_SELECTION_LOOKBACK_DAYS} days') AND ? AND fx.observed_at <= ? AND fx.ingested_at <= ? AND ((fx.access_scope = 'deployment' AND fx.scope_user_id IS NULL) OR (fx.access_scope = 'user' AND fx.scope_user_id = ?)) AND ${cashFxPredicate} ORDER BY fx.market_date DESC, fx.observed_at DESC LIMIT ?`,
      [
        asOf,
        asOf,
        nowIso,
        nowIso,
        userId,
        ...cashFxPredicateParams,
        MAX_OBSERVATIONS + 1,
      ],
    );
    if (cashFxRows.length > MAX_OBSERVATIONS)
      throw new Error("too_many_fx_observations");
    fxRows = cashFxRows.map(mapFx);
    const overrideRepo = createOwnedManualOverrideRepository(client);
    const overrideTargets = currencies
      .filter((currency) => currency !== homeCurrencyCode)
      .map((currency) => `${homeCurrencyCode}/${currency}`);
    const overrideLists: Awaited<
      ReturnType<typeof overrideRepo.listBoundedRelevant>
    >[] = [];
    let overrideRemaining = MAX_OBSERVATIONS;
    for (
      let index = 0;
      index < overrideTargets.length;
      index += OVERRIDE_TARGET_CHUNK
    ) {
      const list = await overrideRepo.listBoundedRelevant(
        userId,
        overrideTargets.slice(index, index + OVERRIDE_TARGET_CHUNK),
        overrideRemaining + 1,
      );
      if (list.length > overrideRemaining)
        throw new Error("too_many_overrides");
      overrideLists.push(list);
      overrideRemaining -= list.length;
    }
    overrides = overrideLists.flat().filter((row) => row.type === "fx_rate");
  }
  const entries = await client.all<Row>(
    `SELECT cle.cash_account_id, cle.signed_amount_decimal, cle.status, cle.local_effective_date, cle.effective_at FROM cash_ledger_entries cle JOIN cash_accounts ca ON ca.id = cle.cash_account_id AND ca.user_id = cle.user_id AND ca.portfolio_id = cle.portfolio_id WHERE cle.user_id = ? AND cle.portfolio_id = ? AND ca.status = 'active' AND cle.local_effective_date <= ? AND cle.effective_at <= ? ORDER BY cle.cash_account_id, cle.local_effective_date, cle.effective_at, cle.id LIMIT ?`,
    [userId, portfolioId, asOf, nowIso, MAX_CASH_ENTRIES + 1],
  );
  if (entries.length > MAX_CASH_ENTRIES) throw new Error("cash_entry_limit");
  const entriesByAccount = new Map<string, Row[]>();
  for (const entry of entries) {
    const id = requiredText(entry, "cash_account_id");
    const list = entriesByAccount.get(id) ?? [];
    list.push(entry);
    entriesByAccount.set(id, list);
  }
  let cashTotal: string | null = "0";
  let knownAccounts = 0;
  let nonZeroAccounts = 0;
  let zeroAccounts = 0;
  let convertedAccounts = 0;
  let incomplete = false;
  for (const account of accounts) {
    const id = requiredText(account, "id");
    const currency = requiredText(account, "currency_code", CURRENCY);
    const completeness = requiredText(account, "completeness");
    if (!["complete", "opening_balance", "incomplete"].includes(completeness))
      throw new Error("invalid_cash_completeness");
    let balance = "0";
    for (const entry of entriesByAccount.get(id) ?? []) {
      const status = requiredText(entry, "status");
      if (status !== "posted" && status !== "reversed")
        throw new Error("invalid_cash_entry_status");
      if (status !== "posted") continue;
      balance = formatDecimalExact(
        addDecimal(
          parseDecimalResult(balance),
          parseDecimalResult(
            signedSourceDecimal(
              requiredText(entry, "signed_amount_decimal"),
              "signed_amount_decimal",
            ),
          ),
        ),
      );
    }
    if (completeness === "incomplete") incomplete = true;
    if (isZero(parseDecimalResult(balance))) {
      knownAccounts += 1;
      zeroAccounts += 1;
      continue;
    }
    nonZeroAccounts += 1;
    const selection = chooseFx(
      {
        asOf,
        portfolioTimezone: timezone,
        baseCurrencyCode: homeCurrencyCode,
        quoteCurrencyCode: currency,
        targetKey: `${homeCurrencyCode}/${currency}`,
        userId,
        scope: { kind: "deployment", userId: null },
        observations: fxRows,
        overrides: overrides.filter(
          (row) =>
            row.type === "fx_rate" &&
            row.targetKey === `${homeCurrencyCode}/${currency}`,
        ),
      },
      userId,
    );
    const converted = calculateCashConversion({
      balanceDecimal: balance,
      currencyCode: currency,
      homeCurrencyCode,
      valuationFx: evidence(selection),
    });
    if (converted.compact.homeValue.status !== "available") {
      incomplete = true;
      continue;
    }
    knownAccounts += 1;
    convertedAccounts += 1;
    cashTotal = formatDecimalExact(
      addDecimal(
        parseDecimalResult(cashTotal),
        parseDecimalResult(converted.compact.homeValue.valueDecimal),
      ),
    );
  }
  return {
    currencyCode: homeCurrencyCode,
    securitiesSubtotal: null,
    cashSubtotal: knownAccounts === 0 ? null : cashTotal,
    knownTotal: knownAccounts === 0 ? null : cashTotal,
    status: incomplete ? "partial" : "complete",
    explanation: incomplete
      ? "Cash is partial because an account, entry, or attributable FX observation is incomplete."
      : "Cash is the bounded sum of posted owner-scoped entries.",
    coverage: {
      total: accounts.length,
      nonZero: nonZeroAccounts,
      zero: zeroAccounts,
      converted: convertedAccounts,
    },
  };
}

export function formatOwnedHoldingDecimal(
  value: string | null,
  scale = 2,
): string {
  return value === null
    ? "—"
    : formatDecimalFixed(parseDecimalResult(value), scale);
}
export function formatOwnedHoldingPrice(value: string | null): string {
  return value === null
    ? "unavailable"
    : formatDecimalTrimmed(parseDecimalResult(value), 6, {
        trimTrailingZeros: true,
      });
}
