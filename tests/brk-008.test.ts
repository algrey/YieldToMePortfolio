/** BRK-008 -- Sharesight live read spike script.
 *
 * The spike (`scripts/sharesight-read-spike.mjs`) is not run against a real
 * Sharesight account in this suite -- no credentials exist yet (BRK-008 is
 * BLOCKED pending owner-supplied `.dev.vars` credentials) and it performs
 * live network I/O against the owner's real account, which must never
 * happen unattended in a test run. This file exercises ONLY the
 * missing-credentials dry path: run the script with no credentials
 * available and confirm it fails closed with a clear, exit-1 message
 * before attempting any network call.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseDevVars } from "../scripts/dev-vars.mjs";
import {
  createSharesightClient,
  deriveShapeEvidence,
  type SharesightTokenProvider,
} from "../domain/sharesight/index.ts";

const scriptPath = fileURLToPath(
  new URL("../scripts/sharesight-read-spike.mjs", import.meta.url),
);

function runWithoutCredentials(devVarsPath: string) {
  // Strip any ambient SHARESIGHT_* env vars and point the script at a
  // dev-vars file with no Sharesight credentials, so this test's result
  // never depends on whether the real repo-root `.dev.vars` happens to have
  // credentials in it (it does not today, but must not be load-bearing).
  const env = { ...process.env };
  delete env.SHARESIGHT_CLIENT_ID;
  delete env.SHARESIGHT_CLIENT_SECRET;
  env.SHARESIGHT_DEV_VARS_PATH = devVarsPath;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", scriptPath],
    { encoding: "utf8", env },
  );
}

test("BRK-008: the spike exits 1 with a clear message when no credentials are configured (no .dev.vars file at all)", () => {
  const result = runWithoutCredentials(
    join(tmpdir(), "yieldtome-brk-008-nonexistent", ".dev.vars"),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing Sharesight credentials/);
  assert.match(result.stderr, /SHARESIGHT_CLIENT_ID/);
  assert.match(result.stderr, /SHARESIGHT_CLIENT_SECRET/);
  // Never attempted a request -- no token/portfolio output on stdout.
  assert.doesNotMatch(result.stdout, /acquire token/);
});

test("BRK-008: the spike exits 1 with a clear message when .dev.vars exists but has no Sharesight keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldtome-brk-008-"));
  try {
    const devVarsPath = join(dir, ".dev.vars");
    await writeFile(
      devVarsPath,
      "CLOUDFLARE_ACCESS_ISSUER=http://127.0.0.1:8799\n# a comment\n\n",
    );
    const result = runWithoutCredentials(devVarsPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing Sharesight credentials/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BRK-008: parseDevVars reads KEY=VALUE pairs, ignores comments/blank lines, and strips matching quotes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldtome-brk-008-parse-"));
  try {
    const devVarsPath = join(dir, ".dev.vars");
    await writeFile(
      devVarsPath,
      [
        "# a comment",
        "",
        "SHARESIGHT_CLIENT_ID=abc123",
        'SHARESIGHT_CLIENT_SECRET="quoted value"',
        "  SPACED_KEY = spaced value  ",
      ].join("\n"),
    );
    const parsed = parseDevVars(devVarsPath);
    assert.equal(parsed.SHARESIGHT_CLIENT_ID, "abc123");
    assert.equal(parsed.SHARESIGHT_CLIENT_SECRET, "quoted value");
    assert.equal(parsed.SPACED_KEY, "spaced value");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BRK-008: parseDevVars returns an empty object for a missing file (never throws)", () => {
  const parsed = parseDevVars(
    join(tmpdir(), "yieldtome-brk-008-definitely-missing", ".dev.vars"),
  );
  assert.deepEqual(parsed, {});
});

// Deliberately NOT tested here: env-var precedence over `.dev.vars` once
// credentials are present. Proving that would require running the script
// past the missing-credentials check, which immediately attempts a real
// network call to Sharesight -- exactly what BRK-008's "do not run it, no
// credentials exist" constraint and this suite's no-live-network rule
// (mirroring tests/brk-003.test.ts) forbid. `SHARESIGHT_CLIENT_ID ||
// devVars.SHARESIGHT_CLIENT_ID` in the script is a one-line, visually
// self-evident precedence rule; see the script's header comment.

// ---------------------------------------------------------------------------
// BRK-008 shape-evidence diagnostic: `deriveShapeEvidence`
// (domain/sharesight/shape-evidence.ts) and the client's `onShapeEvidence`
// wiring (domain/sharesight/client.ts). Fixture/mock based, no live network
// -- mirrors tests/brk-003.test.ts's conventions. See shape-evidence.ts's
// header comment for the privacy contract these tests hold it to: no field
// VALUE from the input -- including one used AS A KEY -- may ever appear in
// a derived shape.
//
// Every object `deriveShapeEvidence` returns is built with
// `Object.create(null)` (review fix -- see shape-evidence.ts's module doc),
// so it does not share `Object.prototype`; `assert.deepEqual`/
// `deepStrictEqual` treat that as a DIFFERENT object shape than an ordinary
// `{}` literal even when every own property matches. `toPlain` round-trips
// through JSON (which `deriveShapeEvidence`'s own contract already promises
// is safe) before comparing against a plain-object-literal expectation --
// this is also the most faithful test of the real contract, since every
// actual consumer (the client's `onShapeEvidence` callback,
// `sharesight-read-spike.mjs`) only ever `JSON.stringify`s the result.
// ---------------------------------------------------------------------------

function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("BRK-008 shape evidence: nests object/array key names and typeof leaves, never a value", () => {
  const shape = deriveShapeEvidence({
    id: "abc-123",
    active: true,
    tags: ["alpha", "beta"],
    nested: { count: 3, label: "x" },
  });
  assert.deepEqual(toPlain(shape), {
    active: "boolean",
    id: "string",
    nested: { count: "number", label: "string" },
    tags: ["string", "length:2"],
  });
});

test("BRK-008 shape evidence: an empty array reports its length with no first-element shape", () => {
  assert.deepEqual(toPlain(deriveShapeEvidence({ items: [] })), {
    items: ["length:0"],
  });
});

test('BRK-008 shape evidence: null/undefined/number/string/boolean leaves report typeof (or the literal "null"), never the value', () => {
  // Note: the shape's own reported value is always the LITERAL STRING
  // "undefined" (a normal JSON-safe string), never the actual JS
  // `undefined` -- so, unlike a real `undefined` property, it survives the
  // `toPlain` JSON round-trip like every other leaf here.
  assert.deepEqual(
    toPlain(
      deriveShapeEvidence({ a: null, b: undefined, c: 1, d: "s", e: false }),
    ),
    { a: "null", b: "undefined", c: "number", d: "string", e: "boolean" },
  );
});

test("BRK-008 shape evidence: depth is capped (default 6) and replaces deeper structure with a truncation marker", () => {
  // Nest 8 levels deep -- one deeper than the default cap allows.
  let deepest: unknown = { leaf: "value" };
  for (let i = 0; i < 8; i += 1) {
    deepest = { nested: deepest };
  }
  let cursor: unknown = deriveShapeEvidence(deepest);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(typeof cursor, "object", `level ${i}`);
    cursor = (cursor as Record<string, unknown>).nested;
  }
  assert.equal(cursor, "…truncated");
});

test("BRK-008 shape evidence: a custom maxDepth is honoured", () => {
  const shape = deriveShapeEvidence({ a: { b: { c: "x" } } }, { maxDepth: 1 });
  assert.deepEqual(toPlain(shape), { a: "…truncated" });
});

test("BRK-008 shape evidence: field-shaped keys are capped (default 64) with a count-only truncation marker, never naming an omitted key", () => {
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 70; i += 1) {
    wide[`field_${String(i).padStart(3, "0")}`] = i;
  }
  const shape = deriveShapeEvidence(wide) as Record<string, unknown>;
  const keys = Object.keys(shape);
  // 64 kept keys + 1 truncation-marker key.
  assert.equal(keys.length, 65);
  assert.equal(shape["…truncated"], "6 more key(s)");
  for (const key of keys) {
    if (key === "…truncated") continue;
    assert.ok(key in wide, key);
  }
});

test("BRK-008 shape evidence: a custom maxKeys is honoured", () => {
  const shape = deriveShapeEvidence({ a: 1, b: 2, c: 3 }, { maxKeys: 2 });
  assert.deepEqual(toPlain(shape), {
    a: "number",
    b: "number",
    "…truncated": "1 more key(s)",
  });
});

test("BRK-008 shape evidence: decimal-like / exponent-notation format-class annotations are derived from shape only, never the value", () => {
  // Field-shaped (lower_snake_case) keys throughout -- this test is about
  // the format-class annotation, not the key-shape gate covered elsewhere.
  const shape = deriveShapeEvidence({
    plain_number: 42,
    decimal_number: 12.5,
    exponent_number: 1e21,
    plain_string: "hello",
    decimal_string: "123.45",
    exponent_string: "1.5e10",
    integer_like_string: "123",
  });
  assert.deepEqual(toPlain(shape), {
    plain_number: "number",
    decimal_number: "number(decimal-like)",
    exponent_number: "number(exponent-notation)",
    plain_string: "string",
    decimal_string: "string(decimal-like)",
    exponent_string: "string(exponent-notation)",
    integer_like_string: "string",
  });
});

test("BRK-008 shape evidence: no field VALUE ever appears in the derived shape, even a distinctive secret string", () => {
  const SECRET = "sk_live_do_not_leak_9f3c7a1b2d4e";
  const payload = {
    portfolios: [
      {
        id: "1",
        name: "My Portfolio",
        api_key: SECRET,
        balance: 1234.56,
        notes: `token=${SECRET}`,
      },
    ],
  };
  const shape = deriveShapeEvidence(payload);
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes(SECRET), false, serialized);
  assert.equal(serialized.includes("My Portfolio"), false, serialized);
  assert.equal(serialized.includes("1234.56"), false, serialized);
});

// --- Review fix: a VALUE used AS AN OBJECT KEY must never be echoed -------
//
// `Object.keys` cannot distinguish a genuine field name from a value the
// payload happens to be keyed by. Before this fix, `deriveShapeEvidence`
// echoed every object key verbatim, so a ticker-, amount-, id-, or
// secret-keyed payload leaked that value straight into the "shape". Each
// case below plants a distinctive string in KEY position (never in value
// position -- these are exactly the probes the earlier, value-position-only
// tests could not catch) and greps the fully serialized shape for it.

test("BRK-008 shape evidence: a ticker/symbol used as an object key is never echoed (folds into the aggregated non-field-shaped-key marker)", () => {
  const TICKER = "BHP.AX";
  const shape = deriveShapeEvidence({ [TICKER]: { quantity: 10 } });
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes(TICKER), false, serialized);
  assert.deepEqual(toPlain(shape), {
    "<1 non-field-shaped key(s)>": { quantity: "number" },
  });
});

test("BRK-008 shape evidence: a decimal amount used as an object key is never echoed", () => {
  const AMOUNT_KEY = "12345.67";
  const shape = deriveShapeEvidence({ [AMOUNT_KEY]: { currency: "AUD" } });
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes(AMOUNT_KEY), false, serialized);
  assert.deepEqual(toPlain(shape), {
    "<1 non-field-shaped key(s)>": { currency: "string" },
  });
});

test("BRK-008 shape evidence: an id (UUID) used as an object key is never echoed", () => {
  const ID_KEY = "9f3c7a1b-2d4e-4a11-9c3f-6b1e2d3c4f5a";
  const shape = deriveShapeEvidence({ [ID_KEY]: { name: "x" } });
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes(ID_KEY), false, serialized);
  assert.deepEqual(toPlain(shape), {
    "<1 non-field-shaped key(s)>": { name: "string" },
  });
});

test("BRK-008 shape evidence: a secret-shaped string used as an object key is never echoed", () => {
  // A realistic secret token (mixed-case, like a real API key/access token)
  // rather than a purely lower_snake_case string: `FIELD_NAME_KEY_PATTERN`
  // is deliberately narrow (lower_snake_case only), so a secret that
  // happened to be ALL lowercase letters/digits/underscores would itself
  // pass it -- that is the documented, reviewed shape of the classifier,
  // not a gap this test is meant to paper over. Mixed case is what a real
  // high-entropy secret actually looks like, and is what this test proves
  // is never echoed. (An earlier revision used Stripe's public
  // documentation example key here, which tripped GitHub push protection
  // as a false positive -- this fixture is deliberately NOT shaped like
  // any real provider's key format for that reason.)
  const SECRET_KEY = "fk_FAKE_4eC39HqLyjWDarjtT1zdp7dc";
  const shape = deriveShapeEvidence({ [SECRET_KEY]: { active: true } });
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes(SECRET_KEY), false, serialized);
  assert.deepEqual(toPlain(shape), {
    "<1 non-field-shaped key(s)>": { active: "boolean" },
  });
});

test("BRK-008 shape evidence: multiple non-field-shaped keys on one object collapse to a single aggregated marker carrying only the FIRST (sorted) key's value shape", () => {
  const TICKER_A = "AAA.AX";
  const TICKER_B = "ZZZ.AX";
  const shape = deriveShapeEvidence({
    [TICKER_A]: { quantity: 1 },
    [TICKER_B]: { quantity: "should-never-be-picked" },
    id: "portfolio-1",
  });
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes(TICKER_A), false, serialized);
  assert.equal(serialized.includes(TICKER_B), false, serialized);
  assert.deepEqual(toPlain(shape), {
    id: "string",
    // "AAA.AX" sorts before "ZZZ.AX" -- its value's shape is the
    // representative sample; "ZZZ.AX"'s value never contributes anything,
    // not even its typeof.
    "<2 non-field-shaped key(s)>": { quantity: "number" },
  });
});

test("BRK-008 shape evidence: a JSON.parse'd \"__proto__\" own-key (a genuine own-enumerable data property, not a prototype override) never leaks its value and never pollutes the returned shape object's own prototype", () => {
  const parsed: unknown = JSON.parse('{"__proto__":{"leak":"V"},"ok":1}');
  // Sanity: this is JSON.parse's well-known special case -- "__proto__" is
  // an ordinary OWN property here, not a live prototype override. If this
  // assumption ever stopped holding, the rest of this test would be
  // exercising the wrong scenario.
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);

  const shape = deriveShapeEvidence(parsed);
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes("V"), false, serialized);
  assert.equal(serialized.includes("__proto__"), false, serialized);
  // The returned shape object's OWN prototype was never reassigned by a
  // `shape["__proto__"] = ...` style assignment (review fix: every object
  // this function builds uses `Object.create(null)`).
  assert.equal(Object.getPrototypeOf(shape), null);
  assert.deepEqual(toPlain(shape), {
    ok: "number",
    "<1 non-field-shaped key(s)>": { leak: "string" },
  });
});

// --- onShapeEvidence wiring in domain/sharesight/client.ts -----------------

const FIXTURE_ACCESS_TOKEN = "brk-008-fixture-access-token";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function alwaysValidTokenProvider(): Promise<SharesightTokenProvider> {
  return {
    getAccessToken: async () => ({ ok: true, value: FIXTURE_ACCESS_TOKEN }),
  };
}

test("BRK-008 onShapeEvidence: fires with a derived shape, labelled by the static endpoint name, when a parser fails closed with invalid_response", async () => {
  const provider = await alwaysValidTokenProvider();
  const calls: Array<{ endpoint: string; shape: unknown }> = [];
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { portfolios: "not-an-array" }),
    onShapeEvidence: (endpoint, shape) => {
      calls.push({ endpoint, shape });
    },
  });

  const result = await client.listPortfolios();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid_response");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, "listPortfolios");
  assert.deepEqual(toPlain(calls[0].shape), { portfolios: "string" });
});

test("BRK-008 onShapeEvidence: does not fire on a successful parse", async () => {
  const provider = await alwaysValidTokenProvider();
  let called = false;
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async () =>
      jsonResponse(200, {
        // Matches live shape evidence 2026-08-15: numeric id, currency_code.
        portfolios: [{ id: 1, name: "P1", currency_code: "USD" }],
      }),
    onShapeEvidence: () => {
      called = true;
    },
  });
  const result = await client.listPortfolios();
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

test("BRK-008 onShapeEvidence: does not fire for a transport-level failure with no parsed JSON to derive a shape from (non-2xx status, malformed JSON body, timeout)", async () => {
  const provider = await alwaysValidTokenProvider();
  let called = false;
  const onShapeEvidence = () => {
    called = true;
  };

  const result500 = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(500, { message: "boom" }),
    onShapeEvidence,
  }).listPortfolios();
  assert.equal(result500.ok, false);
  if (!result500.ok) assert.equal(result500.error.kind, "transient_upstream");

  const result404 = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(404, {}),
    onShapeEvidence,
  }).listPortfolios();
  assert.equal(result404.ok, false);
  if (!result404.ok) assert.equal(result404.error.kind, "invalid_response");

  const resultMalformed = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => new Response("<not json>", { status: 200 }),
    onShapeEvidence,
  }).listPortfolios();
  assert.equal(resultMalformed.ok, false);
  if (!resultMalformed.ok) {
    assert.equal(resultMalformed.error.kind, "invalid_response");
  }

  const resultTimeout = await createSharesightClient({
    tokenProvider: provider,
    timeoutMs: 15,
    fetcher: () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(jsonResponse(200, { portfolios: [] })), 250);
      }),
    onShapeEvidence,
  }).listPortfolios();
  assert.equal(resultTimeout.ok, false);
  if (!resultTimeout.ok) assert.equal(resultTimeout.error.kind, "timeout");

  assert.equal(
    called,
    false,
    "onShapeEvidence must never fire when there is no parsed JSON to derive a shape from",
  );
});

test("BRK-008 onShapeEvidence: a throwing callback is caught and discarded, never failing the parse result it reacted to", async () => {
  const provider = await alwaysValidTokenProvider();
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { portfolios: "not-an-array" }),
    onShapeEvidence: () => {
      throw new Error("boom -- caller-side diagnostic failure");
    },
  });
  const result = await client.listPortfolios();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid_response");
});

test("BRK-008 onShapeEvidence: no field value from the raw payload leaks into the reported shape", async () => {
  const provider = await alwaysValidTokenProvider();
  const SECRET = "sk_live_do_not_leak_4e8b1c";
  let capturedShape: unknown;
  const client = createSharesightClient({
    tokenProvider: provider,
    // A malformed envelope (portfolios must be an array) that still carries
    // a realistic-looking secret-shaped field, to prove the derived shape
    // never echoes it.
    fetcher: async () =>
      jsonResponse(200, { portfolios: "not-an-array", api_key: SECRET }),
    onShapeEvidence: (_endpoint, shape) => {
      capturedShape = shape;
    },
  });
  await client.listPortfolios();
  const serialized = JSON.stringify(capturedShape);
  assert.equal(serialized.includes(SECRET), false, serialized);
});

// --- BRK-008 (2026-08-15 follow-up): callback-wiring regression ------------
//
// The live payouts symptom (invalid_response, no diagnostic evidence at all)
// was initially suspected to be a dropped `onShapeEvidence` wire-up specific
// to `listPayouts` -- the actual root cause turned out to be a genuinely
// diagnostic-less branch shared by ALL FOUR methods (see
// tests/brk-003.test.ts's non-2xx `onBodyParseDiagnostic` tests), not a
// per-method wiring gap. This test still pins the class of bug that WAS
// suspected -- a future endpoint/URL change silently dropping
// `reportShapeEvidenceIfInvalid` for exactly one method -- since nothing
// else in this suite exercises `onShapeEvidence` for
// getPortfolioHoldings/listTrades/listPayouts (only listPortfolios, above).

test("BRK-008 onShapeEvidence wiring regression: ALL FOUR client methods fire onShapeEvidence when their own parser fails closed with invalid_response", async () => {
  const provider = await alwaysValidTokenProvider();
  const calls: string[] = [];
  const onShapeEvidence = (endpoint: string) => {
    calls.push(endpoint);
  };

  const portfolios = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { portfolios: "not-an-array" }),
    onShapeEvidence,
  }).listPortfolios();
  assert.equal(portfolios.ok, false);

  const holdings = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { holdings: "not-an-array" }),
    onShapeEvidence,
  }).getPortfolioHoldings("port_1");
  assert.equal(holdings.ok, false);

  const trades = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { trades: "not-an-array" }),
    onShapeEvidence,
  }).listTrades("port_1");
  assert.equal(trades.ok, false);

  const payouts = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { payouts: "not-an-array" }),
    onShapeEvidence,
  }).listPayouts("port_1");
  assert.equal(payouts.ok, false);

  assert.deepEqual(calls, [
    "listPortfolios",
    "getPortfolioHoldings",
    "listTrades",
    "listPayouts",
  ]);
});

// --- BRK-008 (2026-08-15 follow-up): failing-item diagnostics --------------
//
// `parse.ts` now identifies WHICH item in a list and WHICH field failed
// (`SharesightError.itemFailure`), and the client's opt-in
// `onItemFailureEvidence` additionally reports that one item's own derived
// shape. Names/enums/shape only -- never a value -- see
// `contracts.ts`'s `SharesightItemFailureDetail`/`SharesightItemFailureEvidence`
// doc comments for the privacy contract these tests hold it to.

/** A minimal, otherwise-fully-valid raw (wire-shaped) Sharesight trade item
 * -- see `parse.ts`'s `parseTradeItem` for the exact required fields. */
function validRawTrade(id: number): Record<string, unknown> {
  return {
    id,
    instrument: { code: "BHP", market_code: "ASX", currency_code: "AUD" },
    transaction_date: "2026-01-01",
    quantity: 10,
    price: 55.5,
    holding_id: 100,
    portfolio_id: 42,
  };
}

function withoutField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const clone = { ...record };
  delete clone[field];
  return clone;
}

test("BRK-008 itemFailure/onItemFailureEvidence: identifies the exact item index and field name for a MISSING required field, several valid items deep into the list", async () => {
  const provider = await alwaysValidTokenProvider();
  const items = [
    validRawTrade(1),
    validRawTrade(2),
    withoutField(validRawTrade(3), "quantity"),
  ];
  const calls: Array<{
    endpoint: string;
    itemIndex: number;
    fieldName: string;
    reason: string;
    itemShape: unknown;
  }> = [];
  const result = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { trades: items }),
    onItemFailureEvidence: (endpoint, evidence) => {
      calls.push({ endpoint, ...evidence });
    },
  }).listTrades("42");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invalid_response");
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 2, // 0-based -- the third item, after two valid ones
      fieldName: "quantity",
      reason: "missing",
    });
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, "listTrades");
  assert.equal(calls[0].itemIndex, 2);
  assert.equal(calls[0].fieldName, "quantity");
  assert.equal(calls[0].reason, "missing");
  // The failing item's OWN shape (not the whole payload's) -- `quantity`
  // must be absent from it (that's the failure), `price` must be present.
  const itemShape = toPlain(calls[0].itemShape) as Record<string, unknown>;
  assert.equal("quantity" in itemShape, false);
  assert.equal(itemShape.price, "number(decimal-like)");
});

test("BRK-008 itemFailure: a mismatch reason (trade's own portfolio_id disagreeing with the queried portfolio) is identified by field name, not conflated with missing/wrong_type", async () => {
  const provider = await alwaysValidTokenProvider();
  const items = [validRawTrade(1), { ...validRawTrade(2), portfolio_id: 999 }];
  const result = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { trades: items }),
  }).listTrades("42");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 1,
      fieldName: "portfolio_id",
      reason: "mismatch",
    });
  }
});

test('BRK-008 itemFailure: a malformed nested instrument field reports a dotted field name ("instrument.code"), not just "instrument"', async () => {
  const provider = await alwaysValidTokenProvider();
  const items = [
    {
      ...validRawTrade(1),
      instrument: { market_code: "ASX", currency_code: "AUD" },
    },
  ];
  const result = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { trades: items }),
  }).listTrades("42");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 0,
      fieldName: "instrument.code",
      reason: "missing",
    });
  }
});

test("BRK-008 itemFailure: never present on an envelope-level failure (the list key itself is missing/not an array); onItemFailureEvidence never fires", async () => {
  const provider = await alwaysValidTokenProvider();
  let called = false;
  const result = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { trades: "not-an-array" }),
    onItemFailureEvidence: () => {
      called = true;
    },
  }).listTrades("42");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.itemFailure, undefined);
  assert.equal(called, false);
});

test("BRK-008 itemFailure/onItemFailureEvidence: no field VALUE from the failing item ever leaks -- plant distinctive secrets in both a valid and the failing field of that item and grep everywhere a value could hide", async () => {
  const provider = await alwaysValidTokenProvider();
  const SECRET_IN_VALID_FIELD = "sk_live_planted_in_valid_field_9f3c";
  const SECRET_IN_FAILING_FIELD = "sk_live_planted_in_failing_field_2d4e";
  const items = [
    validRawTrade(1),
    {
      ...validRawTrade(2),
      // A present-but-unparseable decimal -- fails closed as
      // "invalid_decimal", never silently treated as absent. The secret
      // lives in the very value that triggers the failure.
      quantity: SECRET_IN_FAILING_FIELD,
      // A valid optional string field, also carrying a secret, to prove even
      // a NON-failing field's value on the failing item never leaks via the
      // item shape (deriveShapeEvidence is value-safe by construction, but
      // this is the end-to-end proof, not just a unit test of that module).
      state: SECRET_IN_VALID_FIELD,
    },
  ];
  let capturedEvidence: unknown;
  const result = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { trades: items }),
    onItemFailureEvidence: (_endpoint, evidence) => {
      capturedEvidence = evidence;
    },
  }).listTrades("42");

  assert.equal(result.ok, false);
  const serializedError = JSON.stringify(result);
  const serializedEvidence = JSON.stringify(capturedEvidence);
  for (const secret of [SECRET_IN_VALID_FIELD, SECRET_IN_FAILING_FIELD]) {
    assert.equal(serializedError.includes(secret), false, serializedError);
    assert.equal(
      serializedEvidence.includes(secret),
      false,
      serializedEvidence,
    );
  }
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 1,
      fieldName: "quantity",
      reason: "invalid_decimal",
    });
  }
});
