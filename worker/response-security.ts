const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
  ].join("; "),
  "permissions-policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const PRIVATE_CACHE_CONTROL = "private, no-store";

export function isPrivateRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);

  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/portfolio" ||
    pathname.startsWith("/portfolio/")
  );
}

export function applyResponseSecurityHeaders(
  request: Request,
  response: Response,
): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  if (isPrivateRequest(request)) {
    headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export { PRIVATE_CACHE_CONTROL, SECURITY_HEADERS };
