import { randomUUID } from "node:crypto";
import type { VerifiedAccessPrincipal } from "./access-jwt.ts";
import {
  createIdentityRepository,
  type InternalIdentityRecord,
  type InternalUserStatus,
} from "../../db/repositories/identity.ts";
import type { SqlClient } from "../../db/repositories/sql-client.ts";

export type IdentityProvisioningPolicy = "active" | "pending" | "disabled";

export type InternalUser = {
  id: string;
  status: InternalUserStatus;
  displayName: string | null;
  primaryEmail: string;
  locale: string;
  timezone: string;
  identity: {
    provider: "cloudflare_access";
    issuer: string;
    subject: string;
    status: "active" | "revoked";
  };
};

export type IdentityLifecycleFailureReason =
  | "invalid-principal"
  | "missing-email"
  | "jit-disabled"
  | "identity-revoked"
  | "user-not-active"
  | "provisioning-pending";

export type IdentityLifecycleResult =
  | { ok: true; user: InternalUser; provisioned: boolean }
  | { ok: false; reason: IdentityLifecycleFailureReason };

export type IdentityLifecycleOptions = {
  provisioning?: IdentityProvisioningPolicy;
  defaultHomeCurrencyCode?: string;
  defaultTimezone?: string;
  now?: () => string;
  requestId?: string;
  // PRF-004 (owner-reported: tab navigation still 3-10+s on Workers Free):
  // `resolve` below already knows the authenticated `userId` as soon as
  // `findAccessIdentity` returns an ACTIVE, non-revoked record -- BEFORE
  // `touchWithAudit`'s write batch (a full D1 round trip) even starts. A
  // caller that needs that same `userId` for its OWN next read (e.g.
  // `request-context.ts`'s portfolio lookup) previously had to wait for the
  // ENTIRE `resolve()` call -- including the audit write -- to return,
  // paying a real, avoidable sequential hop: the portfolio lookup's SQL
  // depends only on `userId`, never on anything `touchWithAudit` produces.
  // This optional hook fires SYNCHRONOUSLY at that exact point (never in the
  // `provisioning` branch below -- a brand-new user's `userId` is not known
  // until its own INSERT completes, a genuinely rare one-time path this
  // optimization does not target), letting the caller fire its own
  // independent read immediately so it runs CONCURRENTLY with the audit
  // write rather than after it. Never invoked when `resolve` is about to
  // return `ok: false` (the revoked/not-active checks above already
  // returned by the time this could fire).
  onIdentityKnown?: (userId: string) => void;
};

function normalizeEmail(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const email = value.trim().toLowerCase();
  return email.length > 0 ? email : null;
}

function toInternalUser(record: InternalIdentityRecord): InternalUser {
  return {
    id: record.userId,
    status: record.userStatus,
    displayName: record.displayName,
    primaryEmail: record.primaryEmail,
    locale: record.locale,
    timezone: record.timezone,
    identity: {
      provider: "cloudflare_access",
      issuer: record.issuer,
      subject: record.subject,
      status: record.identityStatus,
    },
  };
}

function isActive(record: InternalIdentityRecord): boolean {
  return record.identityStatus === "active" && record.userStatus === "active";
}

export function createIdentityLifecycleService(
  client: SqlClient,
  options: IdentityLifecycleOptions = {},
) {
  const repository = createIdentityRepository(client);
  const provisioning = options.provisioning ?? "active";
  const defaultHomeCurrencyCode = options.defaultHomeCurrencyCode ?? "AUD";
  const defaultTimezone = options.defaultTimezone ?? "Australia/Sydney";
  const now = options.now ?? (() => new Date().toISOString());
  const requestId = options.requestId ?? randomUUID();

  return {
    async resolve(
      principal: VerifiedAccessPrincipal,
    ): Promise<IdentityLifecycleResult> {
      if (
        principal.tokenType !== "app" ||
        principal.subject.trim().length === 0
      ) {
        return { ok: false, reason: "invalid-principal" };
      }

      const email = normalizeEmail(principal.email);
      if (email === null) {
        return { ok: false, reason: "missing-email" };
      }

      const existing = await repository.findAccessIdentity(
        principal.issuer,
        principal.subject,
      );
      if (existing !== null) {
        if (existing.identityStatus === "revoked") {
          return { ok: false, reason: "identity-revoked" };
        }

        if (!isActive(existing)) {
          return existing.userStatus === "pending"
            ? { ok: false, reason: "provisioning-pending" }
            : { ok: false, reason: "user-not-active" };
        }

        options.onIdentityKnown?.(existing.userId);
        const authenticatedAt = now();
        const updated = await repository.touchWithAudit(
          existing,
          email,
          authenticatedAt,
          {
            actorUserId: existing.userId,
            targetOwnerUserId: existing.userId,
            action: "auth.login",
            targetType: "user_identity",
            targetId: existing.identityId,
            requestId,
            result: "success",
            metadata: { provisioned: false },
            occurredAt: authenticatedAt,
          },
        );
        return {
          ok: true,
          user: toInternalUser(updated),
          provisioned: false,
        };
      }

      if (provisioning === "disabled") {
        return { ok: false, reason: "jit-disabled" };
      }

      const provisioned = await repository.provisionWithAudit(
        {
          principal: { ...principal, email },
          userStatus: provisioning,
          defaultHomeCurrencyCode,
          defaultTimezone,
          now: now(),
        },
        {
          actorUserId: "",
          targetOwnerUserId: "",
          action: "auth.provision",
          targetType: "user_identity",
          targetId: "",
          requestId,
          result: "success",
          metadata: { provisioned: true },
          occurredAt: now(),
        },
      );

      if (provisioned.userStatus !== "active") {
        return { ok: false, reason: "provisioning-pending" };
      }

      return {
        ok: true,
        user: toInternalUser(provisioned),
        provisioned: true,
      };
    },
  };
}
