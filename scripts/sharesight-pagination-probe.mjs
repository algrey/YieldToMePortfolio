// BRK-017 step 1: Sharesight list-endpoint pagination PROBE tooling
// (owner-assisted, local-only, evidence-gathering only -- this script never
// changes production behaviour and does not implement the fail-closed
// guard or client-side paging; that is BRK-017 step 2, after this probe's
// live evidence exists, see TASKS.md).
//
// WHAT THIS IS FOR
//   `domain/sharesight/client.ts` sends `listTrades`/`listPayouts` with
//   only `start_date`/`end_date`, and `parse.ts`'s `parseItemList` reads
//   only the envelope's list key, ignoring every sibling key (`links`, any
//   `total`/`page` metadata). If any of trades/payouts/user_instruments
//   paginates server-side, everything past page 1 is silently dropped with
//   no diagnostic today. This script asks each endpoint two questions:
//     1. Does its envelope carry any sibling key that LOOKS like pagination
//        metadata (a name matching `PAGINATION_META_PATTERN` below --
///       `links`/`page`/`total`/`count`/`next`/`prev`/`per_page`/`offset`/
//        `cursor`/`meta`)?
//     2. Does the endpoint's response actually CHANGE when explicit
//        `page`/`per_page` query parameters are sent (`page=1&per_page=1`
//        vs `page=2`), compared to an un-paged wide-window call? An
//        endpoint that ignores these entirely returns the identical
//        (full) list every time -- exactly BRK-015's `from`/`to` silent-
//        ignore precedent, which this probe deliberately mirrors.
//   Go/no-go evidence for BRK-017 step 2's guard/paging design.
//
// HOW THIS REACHES SHARESIGHT
//   Every read goes through `domain/sharesight/index.ts`'s
//   `createSharesightClient` -- never a raw `fetch()` (AGENTS.md: "all
//   Sharesight traffic goes through the dedicated GET-only client
//   module"; BRK-011 review finding B1 blocked an earlier spike for this
//   exact violation). `listPortfolios()` is the already-typed production
//   method; the three list bodies are inspected via the spike-only RAW
//   passthrough accessors this task adds (`getTradesRaw`/`getPayoutsRaw`/
//   `getUserInstrumentsRaw`, mirroring BRK-011's `getPayoutsRaw`
//   precedent exactly) so this probe can see envelope sibling keys
//   `parse.ts`'s typed `listTrades`/`listPayouts`/`listUserInstruments`
//   would silently discard.
//
// WHAT THIS SCRIPT CANNOT SEE (recorded honestly, not worked around)
//   `getJson` (`client.ts`) only ever returns the parsed JSON body or a
//   typed `SharesightError` -- it does not surface the raw HTTP response
//   headers to any caller. This probe therefore cannot inspect header-based
//   pagination metadata (a `Link` header, `X-Total-Count`, etc.); it can
//   only inspect the JSON body's own top-level keys. If step 2 needs header
//   evidence, that requires a deliberate, reviewed extension to `client.ts`
//   beyond this step's RAW-body-only accessors -- out of scope here.
//   Likewise, the client discards the raw HTTP status in favour of a typed
//   `SharesightError.kind`; "status" below is that typed kind, not a
//   literal status code (matching every existing Sharesight spike's
//   convention -- see `sharesight-read-spike.mjs`'s `KIND_HINTS`).
//
// THE NO-VALUES RULE, NARROWED FOR THIS SPIKE
//   This script prints: typed outcome kinds, envelope top-level key NAMES
//   (never values, via `Object.keys`), array LENGTHS (a count, not
//   values), and -- ONLY for a top-level sibling key whose NAME matches
//   `PAGINATION_META_PATTERN` -- that key's VALUE. Pagination metadata
//   (a page number, a total count, a `next` link/cursor) is not tax data
//   and is the one thing this probe needs to see to answer its question;
//   it never descends into an item array to print anything from an actual
//   trade/payout/instrument record, and never prints a value from any
//   OTHER sibling key. No amount, id, ticker, holding, or portfolio name
//   is ever printed -- a printed pagination-meta value also passes through
//   `redactPortfolioIds` first (BRK-017 correction round F1; broadened in
//   the 2026-09-04 follow-up round), which rewrites: any
//   `/portfolios/<digits>` or `/holdings/<digits>` path segment (e.g. inside
//   a `links.self` URL) to the equivalent `<id>` placeholder path segment;
//   any `portfolio_id=`/`holding_id=` query value to `portfolio_id=<id>` /
//   `holding_id=<id>`; and any numeric value found under a key named `id`
//   or ending in `_id` (at any nesting depth) to the literal `<id>` --
//   before any of it is stringified.
//
// HOW TO RUN
//   node --experimental-strip-types scripts/sharesight-pagination-probe.mjs
//   node --experimental-strip-types scripts/sharesight-pagination-probe.mjs --dry-run
//
//   Requires the same credentials as `sharesight-read-spike.mjs` (see that
//   file's header comment for the full story): SHARESIGHT_CLIENT_ID /
//   SHARESIGHT_CLIENT_SECRET always, plus SHARESIGHT_REFRESH_TOKEN or
//   SHARESIGHT_AUTH_CODE + SHARESIGHT_REDIRECT_URI depending on which
//   grant this app registration supports. Read from process.env or a
//   gitignored `.dev.vars` file at the repo root -- never printed. Fails
//   closed with a clear, exit-1 message before any network call when no
//   credentials are configured.
//
//   `--dry-run` skips credentials/network entirely and runs the identical
//   probe/formatting logic against an in-process FAKE client with fixed
//   canned responses (see `buildFakeClient` below) -- lets this tooling be
//   exercised offline/in CI (`tests/brk-017.test.ts`) without ever
//   touching the owner's real account.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createSharesightClient,
  createSharesightTokenProvider,
} from "../domain/sharesight/index.ts";
import { shouldFallBackToAuthorizationCode } from "../domain/sharesight/token-strategy.ts";
import { parseDevVars } from "./dev-vars.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const KIND_HINTS = {
  authentication: "authentication rejected, HTTP 401/400-shaped",
  entitlement: "entitlement/plan gap, HTTP 403-shaped",
  rate_limit: "rate limited, HTTP 429-shaped",
  invalid_response: "response did not match the expected shape",
  timeout: "request timed out",
  transient_upstream: "transient upstream error, HTTP 5xx-shaped",
  non_get_rejected: "a non-GET request was structurally rejected pre-send",
};

/** BRK-017: which top-level sibling-key NAMES this probe is willing to
 * print the VALUE of -- pagination metadata only (see the no-values-rule
 * comment above). Deliberately broad within that one category (this probe
 * exists specifically to discover an UNKNOWN pagination shape, so an
 * allowlist of exact field names would defeat the point) but never matches
 * anything item-shaped (`trades`/`payouts`/`instruments`/`portfolios` are
 * excluded explicitly by the caller, which only ever looks at SIBLING keys
 * of the envelope key, never the envelope key itself). */
export const PAGINATION_META_PATTERN =
  /link|page|total|count|next|prev|per_page|offset|cursor|meta/i;

/** BRK-017: derives the envelope-shape evidence this probe records from one
 * successfully parsed JSON body -- top-level key names, the array length
 * under `envelopeKey`, the names of every OTHER top-level ("sibling") key,
 * and the VALUES of any sibling key whose name matches
 * `PAGINATION_META_PATTERN` (see the no-values rule above). Pure/no I/O so
 * it can be unit tested directly. Returns `null` if `body` isn't a plain
 * object or `envelopeKey`'s value on it isn't an array (an unexpected
 * shape -- the caller reports that as its own evidence). */
export function deriveEnvelopeEvidence(body, envelopeKey) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const list = body[envelopeKey];
  if (!Array.isArray(list)) return null;

  const topLevelKeys = Object.keys(body).sort();
  const siblingKeys = topLevelKeys.filter((key) => key !== envelopeKey);
  /** @type {Record<string, unknown>} */
  const paginationMetaValues = {};
  for (const key of siblingKeys) {
    if (PAGINATION_META_PATTERN.test(key)) {
      paginationMetaValues[key] = body[key];
    }
  }

  return {
    topLevelKeys,
    envelopeKey,
    arrayLength: list.length,
    siblingKeys,
    paginationMetaValues,
  };
}

/** BRK-017: runs one probe endpoint's three calls (a wide-window/unpaged
 * call, `page=1&per_page=1`, and `page=2`) against `client`'s given RAW
 * method and formats the envelope evidence for each, plus whether the
 * array length or any pagination-metadata value differs between them --
 * the load-bearing "does this endpoint honour paging at all" signal. Takes
 * plain call functions (not the client directly) so both the live client's
 * bound methods and the fake client's methods work identically. */
export async function probeEndpoint(label, envelopeKey, calls) {
  /** @type {Record<string, any>} */
  const outcomes = {};
  for (const [callLabel, fn] of Object.entries(calls)) {
    const result = await fn();
    if (!result.ok) {
      outcomes[callLabel] = {
        ok: false,
        kind: result.error.kind,
        hint: KIND_HINTS[result.error.kind] ?? result.error.kind,
      };
      continue;
    }
    const evidence = deriveEnvelopeEvidence(result.value, envelopeKey);
    outcomes[callLabel] = evidence
      ? { ok: true, ...evidence }
      : { ok: true, unexpectedShape: true };
  }

  const wide = outcomes.wide;
  const page1 = outcomes.page1;
  const page2 = outcomes.page2;
  let pagingEffect = "not computable";
  if (
    wide?.ok &&
    page1?.ok &&
    !wide.unexpectedShape &&
    !page1.unexpectedShape
  ) {
    const lengthChanged = wide.arrayLength !== page1.arrayLength;
    const metaChanged =
      JSON.stringify(wide.paginationMetaValues) !==
      JSON.stringify(page1.paginationMetaValues);
    // Array length is the ONLY signal that paging truncated the list; a
    // change confined to the pagination-shaped metadata (e.g. a `links.self`
    // that merely echoes the query string back) is reported separately so
    // it can never be mistaken for real server-side paging.
    let lengthChangedAcrossPages = false;
    let metaChangedAcrossPages = false;
    if (page2?.ok && !page2.unexpectedShape) {
      lengthChangedAcrossPages = page1.arrayLength !== page2.arrayLength;
      metaChangedAcrossPages =
        JSON.stringify(page1.paginationMetaValues) !==
        JSON.stringify(page2.paginationMetaValues);
    }
    const page2Note =
      page2?.ok && !page2.unexpectedShape ? "" : ", page 2 unavailable";
    if (lengthChanged || lengthChangedAcrossPages) {
      pagingEffect = `honours paging (array length changed${page2Note})`;
    } else if (metaChanged || metaChangedAcrossPages) {
      pagingEffect = `ignores paging (counts identical; only metadata echoed the query${page2Note})`;
    } else {
      pagingEffect = `ignores paging (response identical${page2Note})`;
    }
  }

  return { label, envelopeKey, outcomes, pagingEffect };
}

/** BRK-017 correction round (F1) / follow-up round (2026-09-04, confirmation
 * review): redacts identifier-shaped content inside a value about to be
 * printed. The pagination-meta values section below prints whatever a
 * matched sibling key (e.g. `links`) contains, and that value can carry the
 * owner's real Sharesight portfolio/holding id in several shapes -- a
 * `links.self` URL path segment, a query-string parameter, or (in a nested
 * `meta`/`pagination` object) a bare numeric field named `id` or ending in
 * `_id` -- exactly the kind of value this script's header promises never to
 * print. F1 only rewrote `/portfolios/<digits>` path segments; the
 * follow-up round found that left three other id-shaped encodings
 * unredacted, so this now also rewrites `/holdings/<digits>` path segments,
 * `portfolio_id=`/`holding_id=` query values, and any numeric value found
 * under a key named `id` or ending in `_id` (at any nesting depth) --
 * all replaced with the literal `<id>`. Recurses through
 * plain-object/array shapes, tracking each value's own key so the
 * key-name-based rule can apply; string leaves get the path/query
 * replacements, everything else passes through unchanged. Pure/no I/O so it
 * is unit tested directly (`tests/brk-017.test.ts`). */
export function redactPortfolioIds(value) {
  return redactIdentifiers(value, null);
}

const ID_KEY_PATTERN = /(^id$|_id$)/i;

function redactIdentifiers(value, key) {
  if (typeof value === "string") {
    return value
      .replace(/\/portfolios\/\d+/g, "/portfolios/<id>")
      .replace(/\/holdings\/\d+/g, "/holdings/<id>")
      .replace(/\b(portfolio_id|holding_id)=[^&]+/gi, "$1=<id>");
  }
  if (typeof value === "number" && key !== null && ID_KEY_PATTERN.test(key)) {
    return "<id>";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactIdentifiers(item, key));
  }
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      result[entryKey] = redactIdentifiers(entry, entryKey);
    }
    return result;
  }
  return value;
}

/** BRK-017: formats one `probeEndpoint` result plus the whole run's probe
 * results into the compact, pasteable summary table this script prints at
 * the end. Pure/no I/O so it is unit tested directly against fixed input
 * (`tests/brk-017.test.ts`). `nowIso` is injected (rather than read via
 * `new Date()` internally) purely so the dated timestamp line is
 * deterministic under test. */
export function formatSummaryTable(probeResults, nowIso) {
  const lines = [];
  lines.push(`BRK-017 pagination probe -- ${nowIso}`);
  lines.push(
    "endpoint | wide count | p1(pp=1) count | p2 count | sibling keys (non-array) | pagination-meta keys | paging effect",
  );
  for (const probe of probeResults) {
    const wide = probe.outcomes.wide;
    const page1 = probe.outcomes.page1;
    const page2 = probe.outcomes.page2;
    const countOf = (outcome) =>
      outcome?.ok && !outcome.unexpectedShape
        ? String(outcome.arrayLength)
        : outcome?.ok
          ? "unexpected shape"
          : `unavailable (${outcome?.kind ?? "not run"})`;
    const siblingKeysOf = (outcome) =>
      outcome?.ok && !outcome.unexpectedShape && outcome.siblingKeys.length > 0
        ? outcome.siblingKeys.join(",")
        : outcome?.ok && !outcome.unexpectedShape
          ? "(none)"
          : "?";
    const paginationMetaKeysOf = (outcome) =>
      outcome?.ok && !outcome.unexpectedShape
        ? Object.keys(outcome.paginationMetaValues).join(",") || "(none)"
        : "?";
    lines.push(
      [
        probe.label,
        countOf(wide),
        countOf(page1),
        countOf(page2),
        siblingKeysOf(wide),
        paginationMetaKeysOf(wide),
        probe.pagingEffect,
      ].join(" | "),
    );
  }
  // Pagination-shaped metadata VALUES (never item bodies) per call, so the
  // recorded evidence shows exactly what e.g. `links` contained.
  lines.push("");
  lines.push("pagination-meta values (wide / p1 / p2):");
  for (const probe of probeResults) {
    for (const call of ["wide", "page1", "page2"]) {
      const outcome = probe.outcomes[call];
      const rendered =
        outcome?.ok && !outcome.unexpectedShape
          ? JSON.stringify(redactPortfolioIds(outcome.paginationMetaValues))
          : "?";
      lines.push(`${probe.label} [${call}]: ${rendered}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fake client for `--dry-run` -- fixed, deterministic canned responses, no
// network, no credentials. Shares `probeEndpoint`/`formatSummaryTable` with
// the live path so a dry run exercises the SAME formatting/comparison logic
// the live run does (tests/brk-017.test.ts's own coverage target).
// ---------------------------------------------------------------------------

function ok(value) {
  return { ok: true, value };
}

/** BRK-017: builds a fake `SharesightClient`-shaped object with fixed,
 * synthetic responses standing in for a live account -- one portfolio,
 * a "trades" endpoint whose envelope has no pagination-shaped sibling key
 * and returns the identical list regardless of `page`/`per_page` (models
 * "ignores paging"), and a "payouts" endpoint whose envelope carries a
 * `total_pages`/`per_page` sibling pair and DOES shrink under
 * `per_page=1` (models "honours paging") -- so the dry run exercises both
 * branches of `probeEndpoint`'s comparison logic. `user_instruments` has
 * no pagination-shaped metadata and no page-dependent behaviour, same
 * shape as the fake trades endpoint. No real Sharesight field values
 * appear anywhere in this fixture -- it is entirely synthetic. */
export function buildFakeClient() {
  const fakeTrades = [{ id: "1" }, { id: "2" }, { id: "3" }];
  const fakePayoutsAll = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];

  return {
    async listPortfolios() {
      return ok([{ id: "1001", name: "fake", currencyCode: "AUD" }]);
    },
    async getTradesRaw() {
      // Ignores paging entirely -- identical list and no metadata sibling
      // key regardless of params, mirroring BRK-015's `from`/`to`
      // silent-ignore precedent.
      return ok({ trades: fakeTrades });
    },
    async getPayoutsRaw(_portfolioId, params) {
      const perPage = params?.perPage;
      const page = params?.page;
      if (perPage !== undefined) {
        const start = ((page ?? 1) - 1) * perPage;
        return ok({
          payouts: fakePayoutsAll.slice(start, start + perPage),
          total_pages: Math.ceil(fakePayoutsAll.length / perPage),
          per_page: perPage,
        });
      }
      return ok({
        payouts: fakePayoutsAll,
        total_pages: 1,
        per_page: fakePayoutsAll.length,
      });
    },
    async getUserInstrumentsRaw() {
      return ok({ instruments: [{ id: "1" }, { id: "2" }] });
    },
  };
}

// ---------------------------------------------------------------------------
// Live token acquisition -- identical strategy/precedent to
// sharesight-read-spike.mjs / sharesight-franking-fx-spike.mjs. Duplicated
// rather than shared, matching this codebase's existing per-spike
// convention (see those two files).
// ---------------------------------------------------------------------------

function printRotatedRefreshToken(token) {
  console.log("");
  console.log(
    "=== SHARESIGHT REFRESH TOKEN ISSUED -- SAVE THIS NOW, IT WILL NOT BE SHOWN AGAIN ===",
  );
  console.log(`SHARESIGHT_REFRESH_TOKEN=${token}`);
  console.log(
    "=== add the line above to your local .dev.vars (gitignored) -- never commit it ===",
  );
  console.log("");
}

async function acquireSharesightToken(credentials) {
  const { clientId, clientSecret, authCode, redirectUri, refreshToken } =
    credentials;

  if (refreshToken) {
    console.log("token strategy: using SHARESIGHT_REFRESH_TOKEN.");
    const provider = createSharesightTokenProvider({
      clientId,
      clientSecret,
      grantType: "refresh_token",
      refreshToken,
      onRefreshTokenRotated: printRotatedRefreshToken,
    });
    return {
      provider,
      grantUsed: "refresh_token",
      result: await provider.getAccessToken(),
    };
  }

  console.log(
    "token strategy: no refresh token configured -- trying client_credentials first.",
  );
  const clientCredentialsProvider = createSharesightTokenProvider({
    clientId,
    clientSecret,
    grantType: "client_credentials",
    onRefreshTokenRotated: printRotatedRefreshToken,
  });
  const clientCredentialsResult =
    await clientCredentialsProvider.getAccessToken();
  if (clientCredentialsResult.ok) {
    return {
      provider: clientCredentialsProvider,
      grantUsed: "client_credentials",
      result: clientCredentialsResult,
    };
  }
  if (
    !shouldFallBackToAuthorizationCode(
      clientCredentialsResult.error,
      Boolean(authCode),
    )
  ) {
    return {
      provider: clientCredentialsProvider,
      grantUsed: "client_credentials",
      result: clientCredentialsResult,
    };
  }
  if (!redirectUri) {
    console.log(
      "token strategy: client_credentials was rejected and SHARESIGHT_AUTH_CODE is set, but SHARESIGHT_REDIRECT_URI is missing -- cannot fall back.",
    );
    return {
      provider: clientCredentialsProvider,
      grantUsed: "client_credentials",
      result: clientCredentialsResult,
    };
  }
  console.log(
    `token strategy: client_credentials was rejected (${clientCredentialsResult.error.kind}) -- falling back to authorization_code.`,
  );
  const authCodeProvider = createSharesightTokenProvider({
    clientId,
    clientSecret,
    grantType: "authorization_code",
    code: authCode,
    redirectUri,
    onRefreshTokenRotated: printRotatedRefreshToken,
  });
  return {
    provider: authCodeProvider,
    grantUsed: "authorization_code",
    result: await authCodeProvider.getAccessToken(),
  };
}

function readCredentials(devVarsPath) {
  const devVars = parseDevVars(devVarsPath);
  return {
    clientId: process.env.SHARESIGHT_CLIENT_ID || devVars.SHARESIGHT_CLIENT_ID,
    clientSecret:
      process.env.SHARESIGHT_CLIENT_SECRET || devVars.SHARESIGHT_CLIENT_SECRET,
    authCode: process.env.SHARESIGHT_AUTH_CODE || devVars.SHARESIGHT_AUTH_CODE,
    redirectUri:
      process.env.SHARESIGHT_REDIRECT_URI || devVars.SHARESIGHT_REDIRECT_URI,
    refreshToken:
      process.env.SHARESIGHT_REFRESH_TOKEN || devVars.SHARESIGHT_REFRESH_TOKEN,
  };
}

/** Widest window this probe requests -- 1990-01-01 predates any real
 * portfolio-inception date on this owner's account, so this is
 * functionally "everything" under the documented `start_date`/`end_date`
 * filter (BRK-015). */
const WIDE_WINDOW_FROM = "1990-01-01";

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/** BRK-017: runs the full probe against `client` (live or fake) and
 * returns the list of `probeEndpoint` results -- one per portfolio for
 * trades/payouts, plus one global user_instruments probe. Exported for
 * direct testing without going through `main`'s credential/CLI handling. */
export async function runProbe(client) {
  const results = [];
  const portfoliosResult = await client.listPortfolios();
  if (!portfoliosResult.ok) {
    console.error(
      `Cannot proceed without a portfolio list; stopping (${portfoliosResult.error.kind}).`,
    );
    return results;
  }
  const portfolios = portfoliosResult.value;
  console.log(`portfolios: ${portfolios.length} found.`);

  const wideWindow = { from: WIDE_WINDOW_FROM, to: todayIsoDate() };

  let index = 0;
  for (const portfolio of portfolios) {
    index += 1;
    const portfolioId = portfolio.id;

    results.push(
      await probeEndpoint(`portfolio #${index} trades`, "trades", {
        wide: () => client.getTradesRaw(portfolioId, wideWindow),
        page1: () => client.getTradesRaw(portfolioId, { page: 1, perPage: 1 }),
        page2: () => client.getTradesRaw(portfolioId, { page: 2 }),
      }),
    );

    results.push(
      await probeEndpoint(`portfolio #${index} payouts`, "payouts", {
        wide: () => client.getPayoutsRaw(portfolioId, wideWindow),
        page1: () => client.getPayoutsRaw(portfolioId, { page: 1, perPage: 1 }),
        page2: () => client.getPayoutsRaw(portfolioId, { page: 2 }),
      }),
    );
  }

  if (typeof client.getUserInstrumentsRaw === "function") {
    results.push(
      await probeEndpoint("user_instruments (account-wide)", "instruments", {
        wide: () => client.getUserInstrumentsRaw(),
        page1: () => client.getUserInstrumentsRaw({ page: 1, perPage: 1 }),
        page2: () => client.getUserInstrumentsRaw({ page: 2 }),
      }),
    );
  }

  return results;
}

async function runDryRun() {
  console.log("--dry-run: using an in-process fake client, no network.");
  const client = buildFakeClient();
  const results = await runProbe(client);
  console.log("");
  console.log(formatSummaryTable(results, new Date().toISOString()));
}

async function runLive() {
  const devVarsPath =
    process.env.SHARESIGHT_DEV_VARS_PATH ?? join(repoRoot, ".dev.vars");
  const credentials = readCredentials(devVarsPath);

  if (!credentials.clientId || !credentials.clientSecret) {
    console.error(
      [
        "Missing Sharesight credentials -- nothing was sent.",
        "",
        "Set SHARESIGHT_CLIENT_ID and SHARESIGHT_CLIENT_SECRET, either:",
        "  - as process environment variables, or",
        `  - in a gitignored .dev.vars file at the repo root (${devVarsPath}),`,
        "    one KEY=VALUE per line.",
        "",
        "These come from the owner's Sharesight Settings -> API tab on the",
        "MAIN PAID account. Never commit .dev.vars, paste these values into",
        "a shared shell, or add them to a fixture.",
        "",
        "Optionally, also set (see sharesight-read-spike.mjs's header",
        "comment for the full grant-fallback story):",
        "  SHARESIGHT_REFRESH_TOKEN, or SHARESIGHT_AUTH_CODE +",
        "  SHARESIGHT_REDIRECT_URI, depending on which grant(s) this app",
        "  registration supports.",
        "",
        "Use --dry-run to exercise this tool's probe/formatting logic",
        "offline against a fake client instead.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log("acquire token: attempting...");
  const {
    grantUsed,
    result: tokenResult,
    provider: tokenProvider,
  } = await acquireSharesightToken(credentials);
  if (!tokenResult.ok) {
    const hint = KIND_HINTS[tokenResult.error.kind] ?? tokenResult.error.kind;
    console.log(
      `acquire token: unavailable via ${grantUsed} (${tokenResult.error.kind} -- ${hint}${
        tokenResult.error.retryable ? ", retryable" : ", not retryable"
      })`,
    );
    console.error("Cannot proceed without a token; stopping.");
    process.exit(1);
  }
  console.log(`acquire token: ok via ${grantUsed} grant.`);

  const client = createSharesightClient({ tokenProvider });
  const results = await runProbe(client);
  console.log("");
  console.log(formatSummaryTable(results, new Date().toISOString()));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    await runDryRun();
  } else {
    await runLive();
  }
}

// Only run the CLI entry point when this file is executed directly (`node
// scripts/sharesight-pagination-probe.mjs [...]`), never when its pure
// helpers (`deriveEnvelopeEvidence`/`probeEndpoint`/`formatSummaryTable`/
// `runProbe`) are imported by a test -- importing this module must never,
// by itself, touch the network, read credentials, or call `process.exit`.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
