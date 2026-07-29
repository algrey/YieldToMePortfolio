import { randomUUID } from "node:crypto";
import type { VerifiedAccessPrincipal } from "../../domain/auth/access-jwt.ts";
import type { SqlClient } from "./sql-client.ts";

export type InternalUserStatus =
  "pending" | "active" | "disabled" | "deletion_pending" | "purged";

export type InternalIdentityStatus = "active" | "revoked";

export type InternalIdentityRecord = {
  userId: string;
  userStatus: InternalUserStatus;
  displayName: string | null;
  primaryEmail: string;
  locale: string;
  timezone: string;
  userCreatedAt: string;
  userUpdatedAt: string;
  userVersion: number;
  identityId: string;
  identityStatus: InternalIdentityStatus;
  issuer: string;
  subject: string;
  emailAtLink: string | null;
  lastAuthenticatedAt: string | null;
};

export type ProvisionInternalIdentityInput = {
  principal: Omit<VerifiedAccessPrincipal, "email"> & { email: string };
  userStatus: Extract<InternalUserStatus, "pending" | "active">;
  defaultHomeCurrencyCode: string;
  defaultTimezone: string;
  now: string;
};

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function createIdentityRecord(
  row: Record<string, unknown>,
): InternalIdentityRecord {
  return {
    userId: String(row.user_id),
    userStatus: String(row.user_status) as InternalUserStatus,
    displayName: nullableString(row.display_name),
    primaryEmail: String(row.primary_email),
    locale: String(row.locale),
    timezone: String(row.timezone),
    userCreatedAt: String(row.user_created_at),
    userUpdatedAt: String(row.user_updated_at),
    userVersion: Number(row.user_version),
    identityId: String(row.identity_id),
    identityStatus: String(row.identity_status) as InternalIdentityStatus,
    issuer: String(row.issuer),
    subject: String(row.subject),
    emailAtLink: nullableString(row.email_at_link),
    lastAuthenticatedAt: nullableString(row.last_authenticated_at),
  };
}

const IDENTITY_COLUMNS = `
  u.id AS user_id,
  u.status AS user_status,
  u.display_name,
  u.primary_email,
  u.locale,
  u.timezone,
  u.created_at AS user_created_at,
  u.updated_at AS user_updated_at,
  u.version AS user_version,
  ui.id AS identity_id,
  ui.status AS identity_status,
  ui.issuer,
  ui.subject,
  ui.email_at_link,
  ui.last_authenticated_at
`;

export function createIdentityRepository(client: SqlClient) {
  return {
    async findAccessIdentity(
      issuer: string,
      subject: string,
    ): Promise<InternalIdentityRecord | null> {
      const row = await client.get<Record<string, unknown>>(
        `
          SELECT ${IDENTITY_COLUMNS}
          FROM user_identities AS ui
          INNER JOIN users AS u ON u.id = ui.user_id
          WHERE ui.provider = 'cloudflare_access'
            AND ui.issuer = ?
            AND ui.subject = ?
          LIMIT 1
        `,
        [issuer, subject],
      );

      return row ? createIdentityRecord(row) : null;
    },

    async provision(
      input: ProvisionInternalIdentityInput,
    ): Promise<InternalIdentityRecord> {
      const userId = randomUUID();
      const identityId = randomUUID();
      const email = input.principal.email;

      await client.run(
        `
          INSERT INTO users (
            id, status, display_name, primary_email, locale, timezone,
            terms_accepted_at, last_seen_at, created_at, updated_at, version
          ) VALUES (?, ?, NULL, ?, 'en-AU', ?, NULL, ?, ?, ?, 1)
        `,
        [
          userId,
          input.userStatus,
          email,
          input.defaultTimezone,
          input.now,
          input.now,
          input.now,
        ],
      );

      await client.run(
        `
          INSERT INTO user_settings (
            user_id, home_currency_code, timezone,
            default_holding_currency_view, created_at, updated_at, version
          ) VALUES (?, ?, ?, 'native', ?, ?, 1)
        `,
        [
          userId,
          input.defaultHomeCurrencyCode,
          input.defaultTimezone,
          input.now,
          input.now,
        ],
      );

      await client.run(
        `
          INSERT INTO user_identities (
            id, user_id, provider, issuer, subject, email_at_link, status,
            last_authenticated_at, created_at, updated_at, version
          ) VALUES (?, ?, 'cloudflare_access', ?, ?, ?, 'active', ?, ?, ?, 1)
        `,
        [
          identityId,
          userId,
          input.principal.issuer,
          input.principal.subject,
          email,
          input.now,
          input.now,
          input.now,
        ],
      );

      const record = await this.findAccessIdentity(
        input.principal.issuer,
        input.principal.subject,
      );
      if (record === null) {
        throw new Error("Provisioned Access identity could not be reloaded.");
      }

      return record;
    },

    async touch(
      record: InternalIdentityRecord,
      email: string,
      authenticatedAt: string,
    ): Promise<InternalIdentityRecord> {
      await client.run(
        `
          UPDATE users
          SET primary_email = ?, last_seen_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND status = 'active'
        `,
        [email, authenticatedAt, authenticatedAt, record.userId],
      );
      await client.run(
        `
          UPDATE user_identities
          SET last_authenticated_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND status = 'active'
        `,
        [authenticatedAt, authenticatedAt, record.identityId, record.userId],
      );

      const updated = await this.findAccessIdentity(
        record.issuer,
        record.subject,
      );
      if (updated === null) {
        throw new Error("Authenticated Access identity could not be reloaded.");
      }

      return updated;
    },
  };
}
