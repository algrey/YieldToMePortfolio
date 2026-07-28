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

test("server-renders the YieldToMe foundation shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>YieldToMe<\/title>/i);
  assert.match(html, /Private portfolio workspace/);
  assert.match(html, /Portfolio scaffold/);
  assert.match(html, /Overview foundation/);
  assert.match(html, /Foundation ready/);
  assert.match(html, /Not implemented/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("server-renders a direct portfolio section route", async () => {
  const response = await render("/portfolio/preview/holdings");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Holdings foundation/);
  assert.match(
    html,
    /href="\/portfolio\/preview\/holdings"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/portfolio\/preview\/holdings"/,
  );
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
