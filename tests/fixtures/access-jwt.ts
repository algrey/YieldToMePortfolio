import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { encodeAccessJwtBase64Url } from "../../domain/auth/access-jwt.ts";

type JwtClaimOverrides = {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
  type?: string;
};

type JwtHeaderOverrides = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type AccessKeyPair = {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey & { alg: "RS256"; kid: string; use: "sig" };
};

export type AccessJwtFixture = {
  issuer: string;
  audience: string;
  currentKey: AccessKeyPair;
  previousKey: AccessKeyPair;
  createJwks(keys?: AccessKeyPair[]): Response;
  createFetchSequence(responses: Response[]): typeof fetch;
  signToken(options?: {
    claims?: JwtClaimOverrides;
    header?: JwtHeaderOverrides;
    key?: AccessKeyPair;
  }): string;
};

function createKeyPair(kid: string): AccessKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });

  return {
    kid,
    privateKey,
    publicJwk: {
      ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
      alg: "RS256",
      kid,
      use: "sig",
    },
  };
}

function encodeTokenSegment(value: unknown): string {
  return encodeAccessJwtBase64Url(value);
}

function signJwt(
  key: AccessKeyPair,
  header: JwtHeaderOverrides,
  payload: Record<string, unknown>,
): string {
  const encodedHeader = encodeTokenSegment(header);
  const encodedPayload = encodeTokenSegment(payload);
  const signer = createSign("RSA-SHA256")
    .update(`${encodedHeader}.${encodedPayload}`)
    .sign(key.privateKey);

  return `${encodedHeader}.${encodedPayload}.${Buffer.from(signer).toString(
    "base64url",
  )}`;
}

export function createAccessJwtFixture(): AccessJwtFixture {
  const issuer = "https://example.cloudflareaccess.com";
  const audience = "test-audience";
  const currentKey = createKeyPair("current-kid");
  const previousKey = createKeyPair("previous-kid");

  return {
    issuer,
    audience,
    currentKey,
    previousKey,
    createJwks(keys = [currentKey, previousKey]) {
      return new Response(
        JSON.stringify({ keys: keys.map((key) => key.publicJwk) }),
        {
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
    createFetchSequence(responses: Response[]) {
      let index = 0;

      return async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (!url.endsWith("/cdn-cgi/access/certs")) {
          throw new Error(`Unexpected fetch target: ${url}`);
        }

        const response = responses[index] ?? responses[responses.length - 1];
        if (index < responses.length - 1) {
          index += 1;
        }

        return response.clone();
      };
    },
    signToken({ claims = {}, header = {}, key = currentKey } = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        aud: [audience],
        email: "user@example.com",
        exp: now + 300,
        iat: now,
        iss: issuer,
        nbf: now - 30,
        sub: "user-123",
        type: "app",
        ...claims,
      };
      const tokenHeader = {
        alg: "RS256",
        kid: key.kid,
        typ: "JWT",
        ...header,
      };

      return signJwt(key, tokenHeader, payload);
    },
  };
}
