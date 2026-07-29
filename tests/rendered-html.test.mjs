import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAccessJwtFixture } from "./fixtures/access-jwt.ts";

const accessFixture = createAccessJwtFixture();

async function render(path = "/", options = {}) {
  const { token = null, fetch = null, env = {} } = options;
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const originalFetch = globalThis.fetch;
  if (fetch !== null) {
    globalThis.fetch = fetch;
  }

  try {
    const { default: worker } = await import(workerUrl.href);

    return await worker.fetch(
      new Request(new URL(path, "http://localhost"), {
        headers: {
          accept: "text/html",
          ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
        },
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
        YIELDTOME_RUNTIME_ENV: "local",
        YIELDTOME_WORKERS_PLAN: "free",
        MARKET_DATA_PROVIDER: "disabled",
        CLOUDFLARE_ACCESS_ISSUER: accessFixture.issuer,
        CLOUDFLARE_ACCESS_AUDIENCE: accessFixture.audience,
        ...env,
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
  } finally {
    if (fetch !== null) {
      globalThis.fetch = originalFetch;
    }
  }
}

test("server-renders the YieldToMe static prototype", async () => {
  const response = await render("/", {
    token: accessFixture.signToken(),
    fetch: async () => accessFixture.createJwks().clone(),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>YieldToMe<\/title>/i);
  assert.match(html, /All portfolios · AUD/);
  assert.match(html, /A\$1,695,575\.90/);
  assert.match(html, /Portfolio history/);
  assert.match(html, /Aus Stocks/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("server denies unauthenticated requests before rendering private content", async () => {
  const response = await render("/");
  assert.equal(response.status, 401);

  const body = await response.text();
  assert.doesNotMatch(body, /user@example\.com|sub|audience|portfolio/i);
});

test("server-renders a direct portfolio section route", async () => {
  for (const environment of ["local", "preview"]) {
    const response = await render("/portfolio/preview/holdings", {
      token: accessFixture.signToken(),
      fetch: async (input) => {
        const requestUrl = new URL(
          input instanceof Request ? input.url : input,
        );
        assert.match(requestUrl.hostname, /cloudflareaccess\.com$/i);
        return accessFixture.createJwks().clone();
      },
      env: {
        YIELDTOME_RUNTIME_ENV: environment,
      },
    });
    assert.equal(response.status, 200);

    const html = await response.text();
    assert.match(html, /Fixture market data/);
    assert.match(html, /PLS\.AX/);
    assert.match(html, /Value \/ cost/);
    assert.match(html, /A\$1\.965 × 20,000 shares/);
    assert.match(html, /Unrealised/);
    assert.match(html, /A\$1,266,664/);
    assert.match(html, /Realised/);
    assert.match(html, /\+A\$15,000/);
    assert.match(html, /All-Time/);
    assert.match(html, /\+A\$277,423/);
    assert.doesNotMatch(html, /Hide details|Show details/);
    assert.match(
      html,
      /overview[\s\S]*news[\s\S]*quotes[\s\S]*holdings[\s\S]*details/i,
    );
    assert.match(
      html,
      /href="\/portfolio\/preview\/holdings"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/portfolio\/preview\/holdings"/,
    );
  }
});

test("production hides the preview sample route", async () => {
  const response = await render("/portfolio/preview/holdings", {
    token: accessFixture.signToken(),
    fetch: async () => accessFixture.createJwks().clone(),
    env: {
      YIELDTOME_RUNTIME_ENV: "production",
      YIELDTOME_WORKERS_PLAN: "paid",
    },
  });

  assert.equal(response.status, 404);
  const html = await response.text();
  assert.doesNotMatch(html, /Fixture market data|PLS\.AX|Value \/ cost/);
});

test("server-renders quote and detail prototype routes", async () => {
  const quotesResponse = await render("/portfolio/preview/quotes", {
    token: accessFixture.signToken(),
    fetch: async () => accessFixture.createJwks().clone(),
  });
  assert.equal(quotesResponse.status, 200);
  const quotesHtml = await quotesResponse.text();
  assert.match(quotesHtml, /AUDUSD=X/);
  assert.match(quotesHtml, /Last price/);

  const detailsResponse = await render("/portfolio/preview/details", {
    token: accessFixture.signToken(),
    fetch: async () => accessFixture.createJwks().clone(),
  });
  assert.equal(detailsResponse.status, 200);
  const detailsHtml = await detailsResponse.text();
  assert.match(detailsHtml, /Portfolio value/);
  assert.match(detailsHtml, /Largest positions/);
  assert.match(detailsHtml, /FIFO/);
});

test("service worker only caches the public offline allowlist", async () => {
  const serviceWorker = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );

  assert.match(serviceWorker, /PUBLIC_ASSETS/);
  assert.match(serviceWorker, /"\/favicon\.svg"/);
  assert.match(serviceWorker, /"\/offline\.html"/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.doesNotMatch(serviceWorker, /\/api\/|portfolio\/preview|caches\.put/);
});
