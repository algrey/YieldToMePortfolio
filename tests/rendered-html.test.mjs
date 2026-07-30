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

test("server-renders the private shell without exposing mock portfolio values", async () => {
  const response = await render("/", {
    token: accessFixture.signToken(),
    fetch: async () => accessFixture.createJwks().clone(),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>YieldToMe<\/title>/i);
  assert.match(html, /Portfolio data unavailable/);
  assert.doesNotMatch(html, /A\$1,695,575\.90|Aus Stocks|All portfolios · AUD/);
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
    assert.match(html, /A\$921,536/);
    assert.match(html, /A\$900,780/);
    assert.match(html, /\+34,871/);
    assert.match(html, /Realised/);
    assert.match(html, /\+A\$15,000/);
    assert.match(html, /All-Time/);
    assert.match(html, /\+A\$35,756/);
    assert.doesNotMatch(html, /Hide details|Show details/);
    assert.match(
      html,
      /overview[\s\S]*news[\s\S]*quotes[\s\S]*holdings[\s\S]*details/i,
    );
    assert.match(
      html,
      /href="\/portfolio\/preview\/holdings"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/portfolio\/preview\/holdings"/,
    );
    assert.match(html, /href="\/portfolio\/preview\/overview"/);
    assert.match(html, /href="\/portfolio\/preview\/holdings\/PLS\.AX"/);
  }
});

test("server-renders a direct holding detail route from the shared valuation", async () => {
  const response = await render("/portfolio/preview/holdings/PLS.AX", {
    token: accessFixture.signToken(),
    fetch: async () => accessFixture.createJwks().clone(),
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /PLS\.AX/);
  assert.match(html, /Plsgroup Fpo \[pls\]/);
  assert.match(html, /ASX[\s\S]*AUD/);
  assert.match(html, /A\$2\.09/);
  assert.match(html, /Market value[\s\S]*A\$41800\.00/);
  assert.match(html, /Open cost[\s\S]*A\$39300\.00/);
  assert.match(html, /\+A\$4200\.00/);
  assert.match(html, /Total gain[\s\S]*\+A\$2500\.00/);
  assert.match(html, /A\$1\.965 × 20,000 shares/);
  assert.match(html, /Fixture market data/);
  assert.match(html, /Back to holdings/);
});

test("server-renders the preview overview route", async () => {
  const response = await render("/portfolio/preview/overview", {
    token: accessFixture.signToken(),
    fetch: async () => accessFixture.createJwks().clone(),
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Fixture market data/);
  assert.match(html, /Aus Stocks · AUD/);
  assert.match(html, /A\$921536\.34/);
  assert.match(html, /A\$900780\.12/);
  assert.match(html, /Portfolio history/);
  assert.match(html, /Aus Stocks/);
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
  assert.match(quotesHtml, /Fixture market data/);
  assert.match(quotesHtml, /PLS\.AX/);
  assert.match(quotesHtml, /A\$2\.09/);
  assert.match(quotesHtml, /\+A\$0\.21/);
  assert.match(quotesHtml, /29 Jul/);
  assert.match(quotesHtml, /\+11\.17%/);
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
  assert.match(serviceWorker, /"\/icons\/icon-192\.png"/);
  assert.match(serviceWorker, /SKIP_WAITING/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.doesNotMatch(serviceWorker, /\/api\/|portfolio\/preview|caches\.put/);
});

test("PWA metadata uses standalone raster install icons", async () => {
  const manifest = await readFile(
    new URL("../app/manifest.ts", import.meta.url),
    "utf8",
  );
  const layout = await readFile(
    new URL("../app/layout.tsx", import.meta.url),
    "utf8",
  );
  assert.match(manifest, /icon-192\.png/);
  assert.match(manifest, /icon-512\.png/);
  assert.match(layout, /apple-touch-icon-180\.png/);

  for (const [file, width, height] of [
    ["apple-touch-icon-180.png", 180, 180],
    ["icon-192.png", 192, 192],
    ["icon-512.png", 512, 512],
  ]) {
    const bytes = await readFile(
      new URL(`../public/icons/${file}`, import.meta.url),
    );
    assert.deepEqual(
      bytes.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
  }
});
