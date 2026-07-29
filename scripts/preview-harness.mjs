import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccessJwtFixture } from "../tests/fixtures/access-jwt.ts";

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
const { default: worker } = await import("../dist/server/index.js");

async function fetchAsset(input) {
  const assetUrl = new URL(
    input instanceof Request ? input.url : String(input),
  );
  const relativePath = assetUrl.pathname.replace(/^\//, "");

  try {
    const body = await readFile(
      join(repositoryRoot, "dist/client", relativePath),
    );
    return new Response(body, {
      headers: {
        "content-type":
          contentTypes[extname(relativePath)] ?? "application/octet-stream",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
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

    const workerResponse = await worker.fetch(
      new Request(url, {
        headers: {
          accept: request.headers.accept ?? "text/html",
          "Cf-Access-Jwt-Assertion": fixture.signToken(),
        },
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
