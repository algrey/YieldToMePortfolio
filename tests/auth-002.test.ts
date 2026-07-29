import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { VerifiedAccessPrincipal } from "../domain/auth/access-jwt.ts";
import {
  createIdentityLifecycleService,
  type IdentityLifecycleOptions,
} from "../domain/auth/identity-lifecycle.ts";
import { resolveAuthenticatedRequestContext } from "../domain/auth/request-context.ts";
import { createSqliteSqlClient } from "../db/repositories/index.ts";

async function createMigratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const migrationFiles = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    database.exec(
      await readFile(
        new URL(`../drizzle/${migrationFile}`, import.meta.url),
        "utf8",
      ),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
  `);
  return database;
}

function principal(subject: string, email: string): VerifiedAccessPrincipal {
  return {
    issuer: "https://team.cloudflareaccess.com",
    audience: "portfolio-audience",
    subject,
    email,
    tokenType: "app",
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 2_000,
    keyId: "access-key",
  };
}

function lifecycleOptions(
  provisioning: IdentityLifecycleOptions["provisioning"] = "active",
): IdentityLifecycleOptions {
  return {
    provisioning,
    defaultHomeCurrencyCode: "AUD",
    defaultTimezone: "Australia/Sydney",
    now: () => "2026-07-29T12:00:00.000Z",
  };
}

test("first Access login provisions an active user and repeat login updates email metadata", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const service = createIdentityLifecycleService(client, lifecycleOptions());

  const first = await service.resolve(
    principal("subject-a", "Alice@example.com"),
  );
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }

  assert.equal(first.provisioned, true);
  assert.equal(first.user.status, "active");
  assert.equal(first.user.primaryEmail, "alice@example.com");

  const repeat = await service.resolve(
    principal("subject-a", "alice+changed@example.com"),
  );
  assert.equal(repeat.ok, true);
  if (!repeat.ok) {
    return;
  }

  assert.equal(repeat.provisioned, false);
  assert.equal(repeat.user.id, first.user.id);
  assert.equal(repeat.user.primaryEmail, "alice+changed@example.com");
  assert.equal(
    database.prepare("SELECT email_at_link FROM user_identities LIMIT 1").get()
      ?.email_at_link,
    "alice@example.com",
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM users").get()?.count,
    1,
  );
});

test("a changed Access subject never claims the old user by email", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const service = createIdentityLifecycleService(client, lifecycleOptions());

  const original = await service.resolve(
    principal("subject-original", "owner@example.com"),
  );
  const replacement = await service.resolve(
    principal("subject-replacement", "owner@example.com"),
  );

  assert.equal(original.ok, true);
  assert.equal(replacement.ok, true);
  if (!original.ok || !replacement.ok) {
    return;
  }

  assert.notEqual(replacement.user.id, original.user.id);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM user_identities").get()
      ?.count,
    2,
  );
});

test("revoked identities and disabled users cannot create an authenticated context", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const service = createIdentityLifecycleService(client, lifecycleOptions());

  const revoked = await service.resolve(
    principal("subject-revoked", "revoked@example.com"),
  );
  assert.equal(revoked.ok, true);
  if (!revoked.ok) {
    return;
  }

  database
    .prepare("UPDATE user_identities SET status = 'revoked' WHERE user_id = ?")
    .run(revoked.user.id);
  const revokedResult = await service.resolve(
    principal("subject-revoked", "revoked@example.com"),
  );
  assert.deepEqual(revokedResult, { ok: false, reason: "identity-revoked" });

  const disabled = await service.resolve(
    principal("subject-disabled", "disabled@example.com"),
  );
  assert.equal(disabled.ok, true);
  if (!disabled.ok) {
    return;
  }

  database
    .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
    .run(disabled.user.id);
  const disabledResult = await service.resolve(
    principal("subject-disabled", "disabled@example.com"),
  );
  assert.deepEqual(disabledResult, { ok: false, reason: "user-not-active" });
});

test("JIT policy supports admin-invited identities and does not admit service principals", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);

  const disabledJit = createIdentityLifecycleService(
    client,
    lifecycleOptions("disabled"),
  );
  assert.deepEqual(
    await disabledJit.resolve(principal("subject-new", "new@example.com")),
    { ok: false, reason: "jit-disabled" },
  );

  const pendingJit = createIdentityLifecycleService(
    client,
    lifecycleOptions("pending"),
  );
  assert.deepEqual(
    await pendingJit.resolve(
      principal("subject-pending", "pending@example.com"),
    ),
    { ok: false, reason: "provisioning-pending" },
  );

  const servicePrincipal = principal("", "service@example.com");
  const serviceResult = await createIdentityLifecycleService(
    client,
    lifecycleOptions(),
  ).resolve(servicePrincipal);
  assert.deepEqual(serviceResult, { ok: false, reason: "invalid-principal" });
});

test("request context resolves only an owned active portfolio", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const service = createIdentityLifecycleService(client, lifecycleOptions());
  const identity = await service.resolve(
    principal("subject-context", "context@example.com"),
  );
  assert.equal(identity.ok, true);
  if (!identity.ok) {
    return;
  }

  database
    .prepare(
      `
        INSERT INTO portfolios (
          id, user_id, code, name, base_currency_code, timezone,
          accounting_method, history_complete_from, status, created_at,
          updated_at, version
        ) VALUES (?, ?, 'MAIN', 'Main portfolio', 'AUD', 'Australia/Sydney',
                  'fifo', NULL, 'active', ?, ?, 1)
      `,
    )
    .run(
      "portfolio-owned",
      identity.user.id,
      "2026-07-29T12:00:00.000Z",
      "2026-07-29T12:00:00.000Z",
    );

  const otherIdentity = await service.resolve(
    principal("subject-other", "other@example.com"),
  );
  assert.equal(otherIdentity.ok, true);
  if (!otherIdentity.ok) {
    return;
  }

  database
    .prepare(
      `
        INSERT INTO portfolios (
          id, user_id, code, name, base_currency_code, timezone,
          accounting_method, history_complete_from, status, created_at,
          updated_at, version
        ) VALUES (?, ?, 'OTHER', 'Other portfolio', 'AUD', 'Australia/Sydney',
                  'fifo', NULL, 'active', ?, ?, 1)
      `,
    )
    .run(
      "portfolio-other",
      otherIdentity.user.id,
      "2026-07-29T12:00:00.000Z",
      "2026-07-29T12:00:00.000Z",
    );

  const context = await resolveAuthenticatedRequestContext(
    client,
    principal("subject-context", "context@example.com"),
    "portfolio-owned",
    lifecycleOptions(),
  );
  assert.equal(context.ok, true);
  if (!context.ok) {
    return;
  }

  assert.equal(context.context.user.id, identity.user.id);
  assert.equal(context.context.activePortfolio?.id, "portfolio-owned");

  const crossUser = await resolveAuthenticatedRequestContext(
    client,
    principal("subject-context", "context@example.com"),
    "portfolio-other",
    lifecycleOptions(),
  );
  assert.deepEqual(crossUser, { ok: false, reason: "portfolio-not-found" });
});
