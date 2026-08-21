const PRIVATE_CACHE_CONTROL = "private, no-store";

function createContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // UI-023B (owner directive 2026-08-22): the per-holding News tab embeds
    // the owner's own news site in an <iframe>. `frame-src` governs what THIS
    // app may embed -- the inverse `frame-ancestors 'none'` (nobody may embed
    // this app) is unchanged. Exactly one external origin, no wildcards.
    "frame-src 'self' https://greeninvestments.au",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
  ].join("; ");
}

const SECURITY_HEADERS = {
  "permissions-policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return btoa(String.fromCharCode(...bytes));
}

function addNonceToInlineScripts(html: string, nonce: string): string {
  return html.replace(/<script\b([^>]*)>/gi, (tag, attributes: string) => {
    if (/(?:^|\s)(?:src|nonce)\s*=/i.test(attributes)) {
      return tag;
    }

    return `<script nonce="${nonce}"${attributes}>`;
  });
}

function isHtmlResponse(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("text/html") ?? false
  );
}

export function isPrivateRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);

  return (
    pathname === "/" ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/import" ||
    pathname.startsWith("/import/") ||
    pathname === "/portfolio" ||
    pathname.startsWith("/portfolio/")
  );
}

export async function applyResponseSecurityHeaders(
  request: Request,
  response: Response,
  nonce: string,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", createContentSecurityPolicy(nonce));

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  if (isPrivateRequest(request)) {
    headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  }

  const shouldRewriteHtml = isHtmlResponse(response);
  if (shouldRewriteHtml) {
    // The nonce rewrite changes the representation received by the client.
    headers.delete("content-length");
    headers.delete("etag");
  }

  const body = shouldRewriteHtml
    ? addNonceToInlineScripts(await response.text(), nonce)
    : response.body;

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export { PRIVATE_CACHE_CONTROL, SECURITY_HEADERS };
