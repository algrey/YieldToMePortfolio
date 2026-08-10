// Local development auth gateway.
//
// The Worker fails closed on Cloudflare Access for every request, by design. To
// exercise the real DB-backed app locally WITHOUT weakening the Worker, this
// gateway sits in front of `vinext dev` and:
//   1. serves a deterministic JWKS at the configured issuer origin
//      (`/cdn-cgi/access/certs`), which the Worker fetches to verify tokens; and
//   2. injects a freshly signed `cf-access-jwt-assertion` on every proxied
//      request, so the Worker's real verifier accepts the request.
//
// It preserves the original Host header when proxying, so the Worker sees the
// gateway's origin as its own. That matters: the app's cross-site mutation guard
// compares the browser Origin header against the request URL origin, and its
// Content-Security-Policy is `'self'`. If the Worker thought its origin were the
// upstream port, every POST would be rejected as cross-site and assets/actions
// would violate CSP.
//
// The signing key + JWKS come from the existing test fixture. Values here MUST
// match `.dev.vars` (CLOUDFLARE_ACCESS_ISSUER / CLOUDFLARE_ACCESS_AUDIENCE).
// Loopback-only, no production credentials; never expose publicly.

import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { createAccessJwtFixture } from "../tests/fixtures/access-jwt.ts";

const gatewayPort = Number(process.env.DEV_GATEWAY_PORT ?? "8799");
const upstreamHost = process.env.DEV_UPSTREAM_HOST ?? "127.0.0.1";
const upstreamPort = Number(process.env.DEV_UPSTREAM_PORT ?? "3000");
const issuerOrigin =
  process.env.DEV_ACCESS_ISSUER ?? `http://127.0.0.1:${gatewayPort}`;
const audience = process.env.DEV_ACCESS_AUDIENCE ?? "yieldtome-local-dev";

const fixture = createAccessJwtFixture();
const jwksBody = await fixture.createJwks().text();

function signPrincipalToken() {
  const now = Math.floor(Date.now() / 1000);
  return fixture.signToken({
    claims: {
      iss: issuerOrigin,
      aud: [audience],
      iat: now,
      nbf: now - 60,
      exp: now + 3600,
      sub: "local-dev-user",
      email: "local-dev@example.com",
    },
  });
}

const server = createServer((clientReq, clientRes) => {
  const url = new URL(clientReq.url ?? "/", `http://127.0.0.1:${gatewayPort}`);

  // Serve the JWKS the Worker fetches at `${issuer}/cdn-cgi/access/certs`.
  if (url.pathname === "/cdn-cgi/access/certs") {
    clientRes.statusCode = 200;
    clientRes.setHeader("content-type", "application/json");
    clientRes.end(jwksBody);
    return;
  }

  // Forward to the dev server, preserving the original Host header and adding a
  // signed Access token. Streaming (no buffering) so uploads and RSC work.
  const headers = { ...clientReq.headers };
  delete headers["cf-access-jwt-assertion"];
  headers["cf-access-jwt-assertion"] = signPrincipalToken();

  const proxyReq = httpRequest(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: clientReq.method,
      path: clientReq.url,
      headers, // keeps the gateway's Host, so the Worker's origin matches
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );
  proxyReq.on("error", (error) => {
    clientRes.statusCode = 502;
    clientRes.setHeader("content-type", "text/plain");
    clientRes.end(`Dev auth gateway error: ${String(error)}`);
  });
  clientReq.pipe(proxyReq);
});

// Proxy the Vite HMR websocket so hot reload works and CSP stays same-origin.
server.on("upgrade", (req, socket, head) => {
  const headers = { ...req.headers };
  delete headers["cf-access-jwt-assertion"];
  headers["cf-access-jwt-assertion"] = signPrincipalToken();

  const upstream = netConnect(upstreamPort, upstreamHost, () => {
    const requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    const headerLines = Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join("");
    upstream.write(requestLine + headerLines + "\r\n");
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(gatewayPort, "127.0.0.1", () => {
  console.log(
    `Dev auth gateway on http://127.0.0.1:${gatewayPort} -> http://${upstreamHost}:${upstreamPort}`,
  );
  console.log(`Issuer ${issuerOrigin} | audience ${audience}`);
});
