type AccessJwtHeader = {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
};

type AccessJwtPayload = {
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
  type?: unknown;
};

export type AccessConfig = {
  issuer: string | null;
  audience: string | null;
};

export type VerifiedAccessPrincipal = {
  issuer: string;
  audience: string;
  subject: string;
  email: string | null;
  tokenType: "app";
  issuedAt: number | null;
  notBefore: number;
  expiresAt: number;
  keyId: string;
};

export type AccessVerificationFailure = {
  ok: false;
  status: 401 | 403 | 503;
  code: string;
  message: string;
};

export type AccessVerificationSuccess = {
  ok: true;
  principal: VerifiedAccessPrincipal;
};

export type AccessVerificationResult =
  AccessVerificationFailure | AccessVerificationSuccess;

type RemoteFetch = typeof fetch;

type CachedKey = {
  key: CryptoKey;
  insertedAt: number;
};

type AccessVerifierOptions = {
  fetch?: RemoteFetch;
  now?: () => number;
  clockSkewSeconds?: number;
  maxCachedKeys?: number;
  cacheTtlMs?: number;
};

const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_MAX_CACHED_KEYS = 4;
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function failure(
  status: AccessVerificationFailure["status"],
  code: string,
  message: string,
): AccessVerificationFailure {
  return { ok: false, status, code, message };
}

function normalizeIssuer(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizeAudience(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function normalizeTokenAudiences(value: unknown): string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : null;
  }

  if (isStringArray(value)) {
    const normalized = value
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized : null;
  }

  return null;
}

function parseJwt(
  token: string,
):
  | { ok: true; header: AccessJwtHeader; payload: AccessJwtPayload }
  | { ok: false; code: string; message: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      code: "malformed-token",
      message: "The Access JWT is malformed.",
    };
  }

  try {
    const header = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parts[0])),
    ) as AccessJwtHeader;
    const payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parts[1])),
    ) as AccessJwtPayload;

    return { ok: true, header, payload };
  } catch {
    return {
      ok: false,
      code: "malformed-token",
      message: "The Access JWT is malformed.",
    };
  }
}

async function importVerificationKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function validateClaimString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateClaimNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.trunc(value);
}

class RemoteJwksCache {
  private readonly keys = new Map<string, CachedKey>();
  private readonly fetch: RemoteFetch;
  private readonly now: () => number;
  private readonly maxCachedKeys: number;
  private readonly cacheTtlMs: number;

  public constructor(
    options: Required<Pick<AccessVerifierOptions, "fetch">> & {
      now: () => number;
      maxCachedKeys: number;
      cacheTtlMs: number;
    },
  ) {
    this.fetch = options.fetch;
    this.now = options.now;
    this.maxCachedKeys = options.maxCachedKeys;
    this.cacheTtlMs = options.cacheTtlMs;
  }

  public async get(
    issuer: string,
    keyId: string,
  ): Promise<CryptoKey | null | AccessVerificationFailure> {
    const cached = this.keys.get(keyId);
    if (cached && cached.insertedAt + this.cacheTtlMs > this.now()) {
      return cached.key;
    }

    const fetched = await this.refresh(issuer);
    if (!fetched.ok) {
      return fetched;
    }

    return this.keys.get(keyId)?.key ?? null;
  }

  private async refresh(
    issuer: string,
  ): Promise<{ ok: true } | AccessVerificationFailure> {
    let response: Response;
    try {
      response = await this.fetch(`${issuer}/cdn-cgi/access/certs`);
    } catch {
      return failure(
        503,
        "jwks-unavailable",
        "Cloudflare Access signing keys are unavailable.",
      );
    }

    if (!response.ok) {
      return failure(
        503,
        "jwks-unavailable",
        "Cloudflare Access signing keys are unavailable.",
      );
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      return failure(
        503,
        "jwks-unavailable",
        "Cloudflare Access signing keys are unavailable.",
      );
    }

    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { keys?: unknown }).keys)
    ) {
      return failure(
        503,
        "jwks-unavailable",
        "Cloudflare Access signing keys are unavailable.",
      );
    }

    const now = this.now();
    const keys = (body as { keys: unknown[] }).keys;
    for (const candidate of keys) {
      const jwk = candidate as JsonWebKey & { kid: string; kty: string };
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        typeof jwk.kid !== "string" ||
        typeof jwk.kty !== "string"
      ) {
        continue;
      }

      try {
        const key = await importVerificationKey(jwk);
        this.keys.set(jwk.kid, { key, insertedAt: now });
      } catch {
        continue;
      }
    }

    while (this.keys.size > this.maxCachedKeys) {
      const oldestKey = [...this.keys.entries()].sort(
        (left, right) => left[1].insertedAt - right[1].insertedAt,
      )[0]?.[0];
      if (!oldestKey) {
        break;
      }

      this.keys.delete(oldestKey);
    }

    return { ok: true };
  }
}

export function createAccessJwtVerifier(options: AccessVerifierOptions = {}) {
  const fetcher = options.fetch ?? fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const clockSkewSeconds =
    options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const cache = new RemoteJwksCache({
    fetch: fetcher,
    now,
    maxCachedKeys: options.maxCachedKeys ?? DEFAULT_MAX_CACHED_KEYS,
    cacheTtlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  });

  return {
    async verify(
      request: Request,
      config: AccessConfig,
    ): Promise<AccessVerificationResult> {
      const issuer = normalizeIssuer(config.issuer);
      const audience = normalizeAudience(config.audience);
      if (issuer === null || audience === null) {
        return failure(
          503,
          "missing-access-configuration",
          "Cloudflare Access configuration is unavailable.",
        );
      }

      const token = request.headers.get("cf-access-jwt-assertion");
      if (token === null || token.trim().length === 0) {
        return failure(
          401,
          "missing-access-jwt",
          "Cloudflare Access authentication is required.",
        );
      }

      const parsed = parseJwt(token);
      if (!parsed.ok) {
        return failure(401, parsed.code, parsed.message);
      }

      const tokenType = validateClaimString(parsed.payload.type);
      const subject = validateClaimString(parsed.payload.sub);
      const tokenIssuer = validateClaimString(parsed.payload.iss);
      const audiences = normalizeTokenAudiences(parsed.payload.aud);
      const expiresAt = validateClaimNumber(parsed.payload.exp);
      const notBefore = validateClaimNumber(parsed.payload.nbf);
      const issuedAtRaw = parsed.payload.iat;
      const issuedAt =
        issuedAtRaw === undefined || issuedAtRaw === null
          ? null
          : validateClaimNumber(issuedAtRaw);
      const keyId = validateClaimString(parsed.header.kid);

      if (
        tokenType === null ||
        subject === null ||
        tokenIssuer === null ||
        audiences === null ||
        expiresAt === null ||
        notBefore === null ||
        (issuedAtRaw !== undefined &&
          issuedAtRaw !== null &&
          issuedAt === null) ||
        keyId === null
      ) {
        return failure(
          403,
          "invalid-access-claims",
          "Cloudflare Access authentication failed.",
        );
      }

      if (parsed.header.alg !== "RS256") {
        return failure(
          403,
          "invalid-access-algorithm",
          "Cloudflare Access authentication failed.",
        );
      }

      if (tokenType !== "app") {
        return failure(
          403,
          "invalid-access-token-type",
          "Cloudflare Access authentication failed.",
        );
      }

      if (tokenIssuer !== issuer) {
        return failure(
          403,
          "invalid-access-issuer",
          "Cloudflare Access authentication failed.",
        );
      }

      if (!audiences.includes(audience)) {
        return failure(
          403,
          "invalid-access-audience",
          "Cloudflare Access authentication failed.",
        );
      }

      const nowSeconds = Math.floor(now() / 1000);
      if (expiresAt <= nowSeconds - clockSkewSeconds) {
        return failure(
          403,
          "expired-access-token",
          "Cloudflare Access authentication failed.",
        );
      }

      if (notBefore > nowSeconds + clockSkewSeconds) {
        return failure(
          403,
          "not-yet-valid-access-token",
          "Cloudflare Access authentication failed.",
        );
      }

      const key = await cache.get(issuer, keyId);
      if (key === null) {
        return failure(
          403,
          "unknown-access-key",
          "Cloudflare Access authentication failed.",
        );
      }

      if ("status" in key) {
        return key;
      }

      const [encodedHeader, encodedPayload, encodedSignature] =
        token.split(".");
      const signature = decodeBase64Url(encodedSignature ?? "");
      const signatureBytes = signature.buffer.slice(
        signature.byteOffset,
        signature.byteOffset + signature.byteLength,
      ) as ArrayBuffer;
      const verified = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signatureBytes,
        new TextEncoder().encode(
          `${encodedHeader ?? ""}.${encodedPayload ?? ""}`,
        ),
      );

      if (!verified) {
        return failure(
          403,
          "invalid-access-signature",
          "Cloudflare Access authentication failed.",
        );
      }

      return {
        ok: true,
        principal: {
          issuer,
          audience,
          subject,
          email: validateClaimString(parsed.payload.email) ?? null,
          tokenType: "app",
          issuedAt,
          notBefore,
          expiresAt,
          keyId,
        },
      };
    },
  };
}

export function encodeAccessJwtBase64Url(value: unknown): string {
  return encodeBase64UrlJson(value);
}

export function decodeAccessJwtBase64Url(value: string): unknown {
  return JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as unknown;
}
