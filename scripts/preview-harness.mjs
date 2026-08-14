import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccessJwtFixture } from "../tests/fixtures/access-jwt.ts";
import { readPreviewAsset } from "./preview-asset-resolver.mjs";
import { findMissingManifestAssets } from "./preview-manifest-guard.mjs";

const port = Number(process.env.PREVIEW_HARNESS_PORT ?? "8788");
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = createAccessJwtFixture();
const originalFetch = globalThis.fetch;
const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname.endsWith("cloudflareaccess.com")) {
    return fixture.createJwks().clone();
  }
  return originalFetch(input, init);
};

// Startup guard: refuse to start on a mismatched build. `dist/server`'s
// assets manifest and `dist/client`'s built assets must come from the same
// `npm run build` -- e.g. rebuilding only the client (or only the server)
// leaves the other half stale, and every asset the stale half references
// would otherwise only fail at request time as an opaque 503 from
// `fetchAsset` below. Checked once, before the worker is even imported.
{
  let assetsManifest;
  try {
    ({ default: assetsManifest } =
      await import("../dist/server/__vite_rsc_assets_manifest.js"));
  } catch {
    // A completely missing/unbuilt dist/server (e.g. never built, or wiped
    // mid-rebuild) is the SAME "run npm run build" hazard as a mismatched
    // pair -- surface the same clean message instead of a raw ERR_MODULE_NOT_FOUND
    // stack, which would otherwise be the only signal a developer sees.
    console.error(
      "dist/server and dist/client are from different builds -- run npm run build.\n" +
        "(dist/server/__vite_rsc_assets_manifest.js could not be loaded -- dist/server may be missing or incomplete.)",
    );
    process.exit(1);
  }
  const missing = findMissingManifestAssets(
    assetsManifest,
    join(repositoryRoot, "dist/client"),
  );
  if (missing.length > 0) {
    console.error(
      "dist/server and dist/client are from different builds -- run npm run build.\n" +
        `Missing from dist/client: ${missing.join(", ")}`,
    );
    process.exit(1);
  }
}

const { default: worker } = await import("../dist/server/index.js");

async function fetchAsset(input) {
  const assetUrl = new URL(
    input instanceof Request ? input.url : String(input),
  );
  const relativePath = assetUrl.pathname.replace(/^\//, "");

  const asset = await readPreviewAsset(
    join(repositoryRoot, "dist/client"),
    relativePath,
  );
  if (asset) {
    return new Response(asset.body, {
      headers: {
        "content-type":
          contentTypes[extname(relativePath)] ?? "application/octet-stream",
        ...(asset.fallback
          ? { "x-preview-asset-fallback": "current-css" }
          : {}),
      },
    });
  }
  return new Response(
    "Preview asset unavailable; rebuild and restart the harness.",
    {
      status: 503,
      headers: { "content-type": "text/plain" },
    },
  );
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    if (url.pathname.startsWith("/assets/")) {
      const assetResponse = await fetchAsset(url);
      response.statusCode = assetResponse.status;
      assetResponse.headers.forEach((value, key) =>
        response.setHeader(key, value),
      );
      response.end(Buffer.from(await assetResponse.arrayBuffer()));
      return;
    }

    const method = request.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    let body;
    if (hasBody) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }

    const forwardedHeaders = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      // `host` would point at this harness, not the worker's own origin;
      // `cf-access-jwt-assertion` is always the harness-injected test
      // principal below, never a client-supplied value.
      if (key === "host" || key === "cf-access-jwt-assertion") continue;
      forwardedHeaders.set(
        key,
        Array.isArray(value) ? value.join(", ") : value,
      );
    }
    if (!forwardedHeaders.has("accept")) {
      forwardedHeaders.set("accept", "text/html");
    }
    forwardedHeaders.set("Cf-Access-Jwt-Assertion", fixture.signToken());

    const workerResponse = await worker.fetch(
      new Request(url, {
        method,
        headers: forwardedHeaders,
        body,
      }),
      {
        ASSETS: { fetch: fetchAsset },
        YIELDTOME_RUNTIME_ENV: "local",
        YIELDTOME_WORKERS_PLAN: "free",
        MARKET_DATA_PROVIDER: "disabled",
        CLOUDFLARE_ACCESS_ISSUER: fixture.issuer,
        CLOUDFLARE_ACCESS_AUDIENCE: fixture.audience,
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );

    response.statusCode = workerResponse.status;
    workerResponse.headers.forEach((value, key) =>
      response.setHeader(key, value),
    );
    response.end(Buffer.from(await workerResponse.arrayBuffer()));
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Preview harness listening on http://127.0.0.1:${port}`);
});
