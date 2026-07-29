import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAccessJwtFixture } from "../tests/fixtures/access-jwt.ts";

const outputDirectory = process.argv[2] ?? "/private/tmp/yieldtome-captures";
const fixture = createAccessJwtFixture();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname.endsWith("cloudflareaccess.com")) {
    return fixture.createJwks().clone();
  }
  return originalFetch(input, init);
};
const { default: worker } = await import("../dist/server/index.js");
const cssFile = (
  await readdir(join(process.cwd(), "dist/client", "assets"))
).find((file) => file.endsWith(".css"));
if (!cssFile) {
  throw new Error("Built CSS asset not found");
}

const css = await readFile(
  join(process.cwd(), "dist/client", "assets", cssFile),
  "utf8",
);
const routes = [
  ["overview", "/portfolio/preview/overview"],
  ["holdings", "/portfolio/preview/holdings"],
  ["holding-detail", "/portfolio/preview/holdings/PLS.AX"],
];

await Promise.all(
  routes.map(async ([name, path]) => {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, {
        headers: {
          accept: "text/html",
          "Cf-Access-Jwt-Assertion": fixture.signToken(),
        },
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
        YIELDTOME_RUNTIME_ENV: "local",
        YIELDTOME_WORKERS_PLAN: "free",
        MARKET_DATA_PROVIDER: "disabled",
        CLOUDFLARE_ACCESS_ISSUER: fixture.issuer,
        CLOUDFLARE_ACCESS_AUDIENCE: fixture.audience,
      },
      { waitUntil() {}, passThroughOnException() {} },
    );
    const html = await response.text();
    const standalone = html.replace(
      /<link rel="stylesheet"[^>]*>/,
      `<style>${css}</style>`,
    );
    await writeFile(join(outputDirectory, `${name}.html`), standalone);
  }),
);
