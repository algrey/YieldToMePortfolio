import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  applyResponseSecurityHeaders,
  PRIVATE_CACHE_CONTROL,
} from "../worker/response-security.ts";

async function renderProtectedFixture() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/portfolio/preview/holdings", {
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

async function readFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? readFiles(path) : [path];
    }),
  );

  return nestedFiles.flat();
}

test("security policy applies restrictive headers and private caching", () => {
  const privateResponse = applyResponseSecurityHeaders(
    new Request("https://yieldtome.example/portfolio/owned/overview"),
    new Response("private response", {
      headers: { "cache-control": "max-age=3600" },
    }),
  );

  assert.equal(
    privateResponse.headers.get("cache-control"),
    PRIVATE_CACHE_CONTROL,
  );
  assert.equal(privateResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(privateResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(
    privateResponse.headers.get("x-content-type-options"),
    "nosniff",
  );
  assert.match(
    privateResponse.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.match(
    privateResponse.headers.get("permissions-policy") ?? "",
    /camera=\(\)/,
  );
});

test("rendered protected-route fixture returns no-store and security headers", async () => {
  const response = await renderProtectedFixture();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), PRIVATE_CACHE_CONTROL);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.match(
    response.headers.get("permissions-policy") ?? "",
    /microphone=\(\)/,
  );
});

test("client output contains no Cloudflare Access configuration", async () => {
  const clientDirectory = new URL("../dist/client/", import.meta.url);
  const files = await readFiles(clientDirectory.pathname);
  const output = await Promise.all(files.map((file) => readFile(file, "utf8")));

  assert.doesNotMatch(output.join("\n"), /CLOUDFLARE_ACCESS_(ISSUER|AUDIENCE)/);
});
