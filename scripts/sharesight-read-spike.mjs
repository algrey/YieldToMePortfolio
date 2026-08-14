// BRK-008: Sharesight live read spike (owner-assisted, local-only tooling).
//
// WHAT THIS IS FOR
//   Proves the owner's Sharesight User API v3 account is readable via
//   BRK-003's GET-only client: acquire a client-credentials token, list
//   portfolios, then fetch holdings/trades/payouts for each portfolio.
//   Records which endpoints work, the response shape (field NAMES only),
//   and the two BRK-003 TODOs the client's `parse.ts` flagged as needing a
//   live response to confirm (id numeric-vs-string shape; decimal
//   exponential-notation magnitude). Go/no-go evidence for BRK-004/005.
//
// HOW TO RUN
//   node --experimental-strip-types scripts/sharesight-read-spike.mjs
//
//   Requires SHARESIGHT_CLIENT_ID / SHARESIGHT_CLIENT_SECRET (Sharesight
//   Settings -> API tab, the owner's MAIN PAID account -- BRK-008). Reads
//   them from a gitignored `.dev.vars` file at the repo root (KEY=VALUE per
//   line, `#`-prefixed comments and blank lines ignored -- same shape
//   `wrangler`/`vinext dev` read, though this script parses it itself since
//   it runs outside that toolchain) or from `process.env`, which takes
//   precedence over `.dev.vars` when both are set. `.dev.vars`'s path can
//   be overridden with `SHARESIGHT_DEV_VARS_PATH` (used by this script's
//   own missing-credentials test so it never depends on the ambient
//   repo-root file).
//
// THE NO-VALUES RULE
//   This script reads the owner's real portfolio/holdings/trade/payout
//   data -- tax data (AGENTS.md non-negotiable: secrets/PII never in logs).
//   It NEVER prints a field VALUE from a Sharesight response, only: typed
//   outcome kinds, item counts, `payloadSha256` hash evidence (already a
//   one-way digest, not a value -- see `SharesightFetchEvidence`), the
//   `typeof` of the first item's `id` field (never its value), a boolean
//   "does this decimal string look exponential" flag (never the decimal
//   itself), and a recursive field-NAME-only shape dump (`Object.keys`,
//   never the corresponding values) of the first item in each list. Do not
//   add a `console.log` anywhere in this file that could print an actual
//   Sharesight field value, a token, or a client secret.
//
// This script only ever reaches Sharesight through `domain/sharesight`'s
// public barrel (`createSharesightTokenProvider` + `createSharesightClient`)
// -- never `transport.ts`'s raw `sharesightGet` primitive directly, which
// the barrel deliberately does not re-export and an ESLint rule bars
// importing outside the package (BRK-004 review). The barrel's client is
// GET-only by construction (BRK-003): this script cannot issue a write to
// Sharesight even if it tried.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSharesightClient,
  createSharesightTokenProvider,
} from "../domain/sharesight/index.ts";
import { parseDevVars } from "./dev-vars.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const devVarsPath =
  process.env.SHARESIGHT_DEV_VARS_PATH ?? join(repoRoot, ".dev.vars");
const devVars = parseDevVars(devVarsPath);

// process.env always wins over `.dev.vars` (matches this repo's other
// scripts, e.g. dev-auth-gateway.mjs's `process.env.X ?? default` pattern).
const clientId =
  process.env.SHARESIGHT_CLIENT_ID || devVars.SHARESIGHT_CLIENT_ID;
const clientSecret =
  process.env.SHARESIGHT_CLIENT_SECRET || devVars.SHARESIGHT_CLIENT_SECRET;

if (!clientId || !clientSecret) {
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
      "MAIN PAID account (see TASKS.md BRK-008). Never commit .dev.vars,",
      "paste these values into a shared shell, or add them to a fixture.",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// From here on this is the live-read spike itself. Not exercised by
// tests -- tests/brk-008.test.ts only drives the missing-credentials path
// above, which exits before any of this runs.
// ---------------------------------------------------------------------------

/** Recursively collects field NAMES (never values) from a parsed Sharesight
 * item, mirroring `Object.keys` at every nesting level. Leaves are replaced
 * by their `typeof` (or the literal string "null"), never their value. */
function fieldShape(value, seen = new Set()) {
  if (Array.isArray(value)) {
    return value.length > 0 ? [fieldShape(value[0], seen)] : [];
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    /** @type {Record<string, unknown>} */
    const shape = {};
    for (const key of Object.keys(value).sort()) {
      shape[key] = fieldShape(value[key], seen);
    }
    return shape;
  }
  return value === null ? "null" : typeof value;
}

function looksExponential(value) {
  return typeof value === "string" && /e/i.test(value);
}

/** Human-readable hint for each typed error kind, since the sealed client
 * deliberately discards the raw HTTP status in favour of a typed kind
 * (BRK-003) -- this maps back to the HTTP shape a guest/entitlement gap
 * would show up as, without reaching for anything the client doesn't
 * expose. */
const KIND_HINTS = {
  authentication: "authentication rejected, HTTP 401/400-shaped",
  entitlement: "entitlement/plan gap, HTTP 403-shaped",
  rate_limit: "rate limited, HTTP 429-shaped",
  invalid_response: "response did not match the expected shape",
  timeout: "request timed out",
  transient_upstream: "transient upstream error, HTTP 5xx-shaped",
  non_get_rejected: "a non-GET request was structurally rejected pre-send",
};

/** Prints a typed GET result's outcome, item count, and (on success) the
 * first item's field-shape / TODO(BRK-008) diagnostics -- never a value. */
function printOutcome(label, result) {
  if (!result.ok) {
    const hint = KIND_HINTS[result.error.kind] ?? result.error.kind;
    console.log(
      `${label}: unavailable (${result.error.kind} -- ${hint}${
        result.error.retryable ? ", retryable" : ", not retryable"
      })`,
    );
    return;
  }
  const items = result.value;
  console.log(`${label}: ok, ${items.length} item(s)`);
  if (items.length === 0) return;

  const first = items[0];
  console.log(`${label}: first-item field shape (names only, no values):`);
  console.log(JSON.stringify(fieldShape(first), null, 2));

  // TODO(BRK-008) confirmation 1: numeric-vs-string id shape
  // (domain/sharesight/parse.ts). Post-parse, `id` is ALWAYS "string" by
  // construction -- `requiredString` rejects a non-string id outright, so a
  // parse success here only confirms the raw id WAS shaped as a JSON
  // string, never disproves a numeric id (that would instead show up as
  // "unavailable (invalid_response -- ...)" above, with parse.ts's
  // malformed-entry message). This sealed client has no way to inspect the
  // raw un-parsed JSON to go further than that -- see parse.ts's TODO.
  if ("id" in first) {
    console.log(
      `${label}: id typeof = ${typeof first.id} (TODO(BRK-008) numeric-vs-string id confirmation; see parse.ts)`,
    );
  }

  // TODO(BRK-008) confirmation 2: decimal exponential-notation magnitude
  // (domain/sharesight/parse.ts's decimalString). Reports only whether the
  // parsed decimal STRING contains an "e"/"E" -- never the string itself.
  for (const [field, sample] of Object.entries(first)) {
    if (typeof sample === "string" && /decimal$/i.test(field)) {
      console.log(
        `${label}: ${field} exponential-notation observed = ${looksExponential(
          sample,
        )} (TODO(BRK-008) exponent-decimal confirmation; see parse.ts)`,
      );
    }
  }
}

async function main() {
  const tokenProvider = createSharesightTokenProvider({
    clientId,
    clientSecret,
  });

  // Correlates onFetchEvidence callbacks (fired once per successful GET)
  // back to the endpoint that triggered them. Safe because every call below
  // is sequentially awaited -- never concurrent.
  let evidenceLabel = "unknown";
  const client = createSharesightClient({
    tokenProvider,
    onFetchEvidence: (evidence) => {
      console.log(
        `${evidenceLabel}: evidence payloadSha256=${evidence.payloadSha256} ingestedAt=${evidence.ingestedAt}`,
      );
    },
  });

  async function call(label, fn) {
    evidenceLabel = label;
    try {
      return await fn();
    } finally {
      evidenceLabel = "unknown";
    }
  }

  console.log("acquire token: attempting...");
  const tokenResult = await tokenProvider.getAccessToken();
  if (!tokenResult.ok) {
    const hint = KIND_HINTS[tokenResult.error.kind] ?? tokenResult.error.kind;
    console.log(
      `acquire token: unavailable (${tokenResult.error.kind} -- ${hint}${
        tokenResult.error.retryable ? ", retryable" : ", not retryable"
      })`,
    );
    console.error("Cannot proceed without a token; stopping.");
    process.exit(1);
  }
  console.log("acquire token: ok");

  const portfoliosResult = await call("portfolios", () =>
    client.listPortfolios(),
  );
  printOutcome("portfolios", portfoliosResult);
  if (!portfoliosResult.ok) {
    console.error("Cannot proceed without a portfolio list; stopping.");
    return;
  }

  let index = 0;
  for (const portfolio of portfoliosResult.value) {
    index += 1;
    console.log(`\n--- portfolio #${index} ---`);

    const holdings = await call(`portfolio #${index} holdings`, () =>
      client.getPortfolioHoldings(portfolio.id),
    );
    printOutcome(`portfolio #${index} holdings`, holdings);

    const trades = await call(`portfolio #${index} trades`, () =>
      client.listTrades(portfolio.id),
    );
    printOutcome(`portfolio #${index} trades`, trades);

    const payouts = await call(`portfolio #${index} payouts`, () =>
      client.listPayouts(portfolio.id),
    );
    printOutcome(`portfolio #${index} payouts`, payouts);
  }
}

await main();
