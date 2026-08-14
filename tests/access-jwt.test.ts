import assert from "node:assert/strict";
import test from "node:test";
import { createAccessJwtVerifier } from "../domain/auth/access-jwt.ts";
import { createAccessJwtFixture } from "./fixtures/access-jwt.ts";

function createRequest(token?: string) {
  return new Request("https://example.invalid/portfolio/preview/holdings", {
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : undefined,
  });
}

test("verifies a valid Cloudflare Access application token", async () => {
  const fixture = createAccessJwtFixture();
  const verifier = createAccessJwtVerifier({
    fetch: async () => fixture.createJwks().clone(),
    now: () => Date.now(),
  });

  const result = await verifier.verify(createRequest(fixture.signToken()), {
    issuer: fixture.issuer,
    audience: fixture.audience,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.principal.issuer, fixture.issuer);
  assert.equal(result.principal.audience, fixture.audience);
  assert.equal(result.principal.subject, "user-123");
  assert.equal(result.principal.tokenType, "app");
});

test("rejects missing configuration, missing token, malformed tokens, and bad claims", async () => {
  const fixture = createAccessJwtFixture();
  const verifier = createAccessJwtVerifier({
    fetch: async () => fixture.createJwks().clone(),
    now: () => Date.now(),
  });

  const missingConfig = await verifier.verify(
    createRequest(fixture.signToken()),
    {
      issuer: null,
      audience: fixture.audience,
    },
  );
  assert.equal(missingConfig.ok, false);
  if (!missingConfig.ok) {
    assert.equal(missingConfig.status, 503);
  }

  const missingToken = await verifier.verify(createRequest(), {
    issuer: fixture.issuer,
    audience: fixture.audience,
  });
  assert.equal(missingToken.ok, false);
  if (!missingToken.ok) {
    assert.equal(missingToken.status, 401);
  }

  const malformed = await verifier.verify(createRequest("not-a-jwt"), {
    issuer: fixture.issuer,
    audience: fixture.audience,
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.status, 401);
  }

  const wrongIssuer = await verifier.verify(
    createRequest(
      fixture.signToken({ claims: { iss: "https://wrong.example" } }),
    ),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(wrongIssuer.ok, false);
  if (!wrongIssuer.ok) {
    assert.equal(wrongIssuer.status, 403);
  }

  const wrongAudience = await verifier.verify(
    createRequest(fixture.signToken({ claims: { aud: ["other-audience"] } })),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(wrongAudience.ok, false);
  if (!wrongAudience.ok) {
    assert.equal(wrongAudience.status, 403);
  }
});

test("rejects expired, not-yet-valid, service-token, and signature-mismatched JWTs", async () => {
  const fixture = createAccessJwtFixture();
  const verifier = createAccessJwtVerifier({
    fetch: async () => fixture.createJwks().clone(),
    now: () => Date.now(),
  });

  const now = Math.floor(Date.now() / 1000);

  const expired = await verifier.verify(
    createRequest(
      fixture.signToken({ claims: { exp: now - 90, nbf: now - 120 } }),
    ),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.status, 403);
  }

  const notYetValid = await verifier.verify(
    createRequest(
      fixture.signToken({ claims: { nbf: now + 120, exp: now + 360 } }),
    ),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(notYetValid.ok, false);
  if (!notYetValid.ok) {
    assert.equal(notYetValid.status, 403);
  }

  const serviceToken = await verifier.verify(
    createRequest(
      fixture.signToken({
        claims: {
          sub: "",
          type: "app",
          email: "service-token@example.com",
        },
      }),
    ),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(serviceToken.ok, false);
  if (!serviceToken.ok) {
    assert.equal(serviceToken.status, 403);
  }

  const signedToken = fixture.signToken();
  const signatureParts = signedToken.split(".");
  const signature = signatureParts[2] ?? "";
  const tamperIndex = Math.max(1, Math.floor(signature.length / 2));
  const tamperedSignature =
    signature.slice(0, tamperIndex) +
    (signature[tamperIndex] === "A" ? "B" : "A") +
    signature.slice(tamperIndex + 1);
  const badSignature = await verifier.verify(
    createRequest(
      `${signatureParts[0]}.${signatureParts[1]}.${tamperedSignature}`,
    ),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(badSignature.ok, false);
  if (!badSignature.ok) {
    assert.equal(badSignature.status, 403);
  }
});

test("caches current and rotated Access signing keys without trusting arbitrary issuers", async () => {
  const fixture = createAccessJwtFixture();
  const requestLog: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requestLog.push(url);
    if (requestLog.length === 1) {
      return fixture.createJwks([fixture.currentKey]).clone();
    }

    return fixture.createJwks([fixture.previousKey]).clone();
  };
  const verifier = createAccessJwtVerifier({
    fetch,
    now: () => Date.now(),
  });

  const currentResult = await verifier.verify(
    createRequest(fixture.signToken({ key: fixture.currentKey })),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(currentResult.ok, true);

  const rotatedResult = await verifier.verify(
    createRequest(fixture.signToken({ key: fixture.previousKey })),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(rotatedResult.ok, true);

  const cachedCurrentResult = await verifier.verify(
    createRequest(fixture.signToken({ key: fixture.currentKey })),
    {
      issuer: fixture.issuer,
      audience: fixture.audience,
    },
  );
  assert.equal(cachedCurrentResult.ok, true);

  assert.equal(requestLog.length, 2);
  assert.match(requestLog[0] ?? "", /\/cdn-cgi\/access\/certs$/);
  assert.match(requestLog[1] ?? "", /\/cdn-cgi\/access\/certs$/);
});

test("fixture key IDs default to current-kid/previous-kid and stay stable with no suffix argument", () => {
  const fixture = createAccessJwtFixture();

  assert.equal(fixture.currentKey.kid, "current-kid");
  assert.equal(fixture.previousKey.kid, "previous-kid");
});

test("keyIdSuffix isolates fixtures so a stale gateway process cannot poison the Worker's JWKS cache", async () => {
  // Regression test for the dev-auth-gateway restart trap: two fixtures with
  // different suffixes simulate two gateway process instances (e.g. before
  // and after a restart). Their kids must never collide, and a verifier
  // whose cache only knows one suffix's keys must fail closed (unknown key,
  // not a signature error) on a token signed by the other suffix.
  const fixtureA = createAccessJwtFixture({ keyIdSuffix: "A" });
  const fixtureB = createAccessJwtFixture({ keyIdSuffix: "B" });

  assert.equal(fixtureA.currentKey.kid, "current-kid-A");
  assert.equal(fixtureA.previousKey.kid, "previous-kid-A");
  assert.equal(fixtureB.currentKey.kid, "current-kid-B");
  assert.equal(fixtureB.previousKey.kid, "previous-kid-B");

  const verifierForA = createAccessJwtVerifier({
    fetch: async () => fixtureA.createJwks().clone(),
    now: () => Date.now(),
  });

  const crossSuffixResult = await verifierForA.verify(
    createRequest(fixtureB.signToken()),
    {
      issuer: fixtureB.issuer,
      audience: fixtureB.audience,
    },
  );
  assert.equal(crossSuffixResult.ok, false);
  if (!crossSuffixResult.ok) {
    assert.equal(crossSuffixResult.code, "unknown-access-key");
    assert.equal(crossSuffixResult.status, 403);
  }

  const sameSuffixResult = await verifierForA.verify(
    createRequest(fixtureA.signToken()),
    {
      issuer: fixtureA.issuer,
      audience: fixtureA.audience,
    },
  );
  assert.equal(sameSuffixResult.ok, true);
});
