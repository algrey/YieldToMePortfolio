import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(path, "http://localhost"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the YieldToMe static prototype", async () => {
  const response = await render();
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

test("server-renders a direct portfolio section route", async () => {
  const response = await render("/portfolio/preview/holdings");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /PLS\.AX/);
  assert.match(html, /Value \/ cost/);
  assert.match(html, /A\$1\.965 × 20,000 shares/);
  assert.match(html, /Unrealised/);
  assert.match(
    html,
    /href="\/portfolio\/preview\/holdings"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/portfolio\/preview\/holdings"/,
  );
});

test("server-renders quote and detail prototype routes", async () => {
  const quotesResponse = await render("/portfolio/preview/quotes");
  assert.equal(quotesResponse.status, 200);
  const quotesHtml = await quotesResponse.text();
  assert.match(quotesHtml, /AUDUSD=X/);
  assert.match(quotesHtml, /Last price/);

  const detailsResponse = await render("/portfolio/preview/details");
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
