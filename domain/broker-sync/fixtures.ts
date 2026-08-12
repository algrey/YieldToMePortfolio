// SPK-003 design-spike: sanitized static fixtures for the broker-candidate
// archetype documented in `docs/ARCHITECTURE.md` §8.1. Everything here is
// invented test data. No network call, credential store, or broker SDK is
// used or implied — `createFixtureBrokerAdapter` returns fixed values
// synchronously (wrapped in `Promise.resolve`) so it can stand in for a real
// `BrokerAdapter` in contract tests.
//
// Token material: `FIXTURE_TOKEN_ENVELOPE` and `RAW_UPSTREAM_PAYLOAD_SAMPLE`
// use an obviously-fake placeholder string, never a real secret shape, and
// `RAW_UPSTREAM_PAYLOAD_SAMPLE` exists specifically so redaction can be
// exercised in tests.

import type {
  BrokerAccountRecord,
  BrokerAdapter,
  BrokerConnectionRecord,
  BrokerLedgerRecord,
  BrokerPositionRecord,
  ExternalRecordMappingRecord,
  TokenEnvelopeRef,
} from "./contracts.ts";

export const FIXTURE_USER_ID = "user_fixture_1";
export const OTHER_USER_ID = "user_fixture_2";

/** Assumption archetype only — see docs/ARCHITECTURE.md §8.1. Not a real provider. */
export const FIXTURE_PROVIDER_CODE = "au-chess-oauth-generic";

export const FIXTURE_TOKEN_ENVELOPE: TokenEnvelopeRef = {
  envelopeId: "envelope_fixture_1",
  expiresAt: "2026-09-01T00:00:00.000Z",
  status: "active",
};

export const FIXTURE_CONNECTION: BrokerConnectionRecord = {
  id: "conn_fixture_1",
  userId: FIXTURE_USER_ID,
  providerCode: FIXTURE_PROVIDER_CODE,
  status: "active",
  grantedScopes: ["read_transactions", "read_positions", "read_cash"],
  tokenRef: FIXTURE_TOKEN_ENVELOPE,
  lastAuthenticatedAt: "2026-08-01T00:00:00.000Z",
  lastSyncedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  revokedAt: null,
};

/** The same connection after the user disconnects it. */
export const FIXTURE_CONNECTION_REVOKED: BrokerConnectionRecord = {
  ...FIXTURE_CONNECTION,
  status: "revoked",
  updatedAt: "2026-08-05T00:00:00.000Z",
  revokedAt: "2026-08-05T00:00:00.000Z",
};

export const FIXTURE_PORTFOLIO_ID = "portfolio_fixture_1";

export const FIXTURE_ACCOUNT: BrokerAccountRecord = {
  id: "acct_fixture_1",
  userId: FIXTURE_USER_ID,
  connectionId: FIXTURE_CONNECTION.id,
  providerAccountIdHash: "sha256:fixture-account-hash",
  displayLabel: "Fixture Trading Account",
  accountCurrencyCode: "AUD",
  accountType: "brokerage",
  mappedPortfolioId: FIXTURE_PORTFOLIO_ID,
  status: "active",
  lastSyncedAt: null,
};

/**
 * A raw upstream API-shaped payload containing an obviously-fake token
 * field, used only to exercise `redactBrokerPayload`. This string is never
 * a real credential; `PLACEHOLDER_TOKEN_DO_NOT_USE_REAL_SECRET` marks it as
 * synthetic test fixture data.
 */
export const RAW_UPSTREAM_PAYLOAD_SAMPLE = {
  accountId: FIXTURE_ACCOUNT.providerAccountIdHash,
  accessToken: "PLACEHOLDER_TOKEN_DO_NOT_USE_REAL_SECRET",
  refreshToken: "PLACEHOLDER_REFRESH_DO_NOT_USE_REAL_SECRET",
  status: "ok",
};

export const FIXTURE_BUY_RECORD: BrokerLedgerRecord = {
  key: {
    userId: FIXTURE_USER_ID,
    providerCode: FIXTURE_PROVIDER_CODE,
    brokerAccountId: FIXTURE_ACCOUNT.id,
    externalType: "transaction",
    externalId: "ext-txn-1",
    externalVersion: "1",
  },
  recordKind: "transaction",
  transactionType: "buy",
  cashEntryType: null,
  portfolioSecurityId: "portfolio_security_fixture_vas",
  quantityDecimal: "50",
  unitPriceDecimal: "95.20",
  amountDecimal: "4760.00",
  feeAmountDecimal: "9.95",
  taxAmountDecimal: "0",
  currencyCode: "AUD",
  observedAt: "2026-08-01T00:30:00.000Z",
  ingestedAt: "2026-08-01T01:00:00.000Z",
  payloadSha256: "sha256:fixture-buy-v1",
  status: "active",
};

export const FIXTURE_BUY_RECORD_CORRECTED: BrokerLedgerRecord = {
  ...FIXTURE_BUY_RECORD,
  key: { ...FIXTURE_BUY_RECORD.key, externalVersion: "2" },
  quantityDecimal: "55",
  amountDecimal: "5236.00",
  payloadSha256: "sha256:fixture-buy-v2-corrected",
  status: "corrected",
};

export const FIXTURE_BUY_RECORD_DELETED: BrokerLedgerRecord = {
  ...FIXTURE_BUY_RECORD,
  key: { ...FIXTURE_BUY_RECORD.key, externalVersion: "3" },
  payloadSha256: "sha256:fixture-buy-v3-deleted",
  status: "deleted",
};

/** The idempotency evidence that would exist after `FIXTURE_BUY_RECORD` is committed once. */
export const FIXTURE_MAPPING_AFTER_FIRST_SYNC: ExternalRecordMappingRecord = {
  key: FIXTURE_BUY_RECORD.key,
  normalizedRecordId: "txn_normalized_fixture_1",
  payloadSha256: FIXTURE_BUY_RECORD.payloadSha256,
  status: "active",
  supersedesMappingId: null,
};

/**
 * The mapping-history rows that would exist after `FIXTURE_BUY_RECORD` (v1)
 * was committed and then corrected by `FIXTURE_BUY_RECORD_CORRECTED` (v2):
 * the v1 row survives only as superseded audit history, and a new v2 row is
 * the currently-effective (`active`) mapping. Both rows share the same
 * 5-tuple external identity but a different `externalVersion`, which is
 * exactly the case `selectActiveMapping` must resolve deterministically
 * regardless of which order a caller lists them in.
 */
export const FIXTURE_MAPPING_V1_SUPERSEDED: ExternalRecordMappingRecord = {
  key: FIXTURE_MAPPING_AFTER_FIRST_SYNC.key,
  normalizedRecordId: FIXTURE_MAPPING_AFTER_FIRST_SYNC.normalizedRecordId,
  payloadSha256: FIXTURE_MAPPING_AFTER_FIRST_SYNC.payloadSha256,
  status: "superseded",
  supersedesMappingId: null,
};

export const FIXTURE_MAPPING_V2_ACTIVE: ExternalRecordMappingRecord = {
  key: FIXTURE_BUY_RECORD_CORRECTED.key,
  normalizedRecordId: "txn_normalized_fixture_1_corrected",
  payloadSha256: FIXTURE_BUY_RECORD_CORRECTED.payloadSha256,
  status: "active",
  supersedesMappingId: FIXTURE_MAPPING_AFTER_FIRST_SYNC.normalizedRecordId,
};

/**
 * The mapping-history rows that would exist after `FIXTURE_BUY_RECORD` (v1)
 * was committed and then reversed (never replaced) by
 * `FIXTURE_BUY_RECORD_DELETED` (v3): per the persistence invariant on
 * `ExternalRecordMappingRecord`, a `reverse_only` leaves BOTH the
 * previously-active v1 row and the new v3 deletion-event row with
 * `status: "reversed"` — there is no longer any `active` row for this
 * identity. A group in this shape must never be mistaken for "never seen".
 */
export const FIXTURE_MAPPING_V1_REVERSED: ExternalRecordMappingRecord = {
  key: FIXTURE_MAPPING_AFTER_FIRST_SYNC.key,
  normalizedRecordId: FIXTURE_MAPPING_AFTER_FIRST_SYNC.normalizedRecordId,
  payloadSha256: FIXTURE_MAPPING_AFTER_FIRST_SYNC.payloadSha256,
  status: "reversed",
  supersedesMappingId: null,
};

export const FIXTURE_MAPPING_V3_REVERSED: ExternalRecordMappingRecord = {
  key: FIXTURE_BUY_RECORD_DELETED.key,
  normalizedRecordId: FIXTURE_MAPPING_AFTER_FIRST_SYNC.normalizedRecordId,
  payloadSha256: FIXTURE_BUY_RECORD_DELETED.payloadSha256,
  status: "reversed",
  supersedesMappingId: FIXTURE_MAPPING_AFTER_FIRST_SYNC.normalizedRecordId,
};

/**
 * A genuine broker re-issue of the same external ID at a version strictly
 * newer than anything in the fully-reversed `FIXTURE_MAPPING_V1_REVERSED`/
 * `FIXTURE_MAPPING_V3_REVERSED` history (highest known version "3").
 */
export const FIXTURE_BUY_RECORD_REISSUED: BrokerLedgerRecord = {
  ...FIXTURE_BUY_RECORD,
  key: { ...FIXTURE_BUY_RECORD.key, externalVersion: "4" },
  payloadSha256: "sha256:fixture-buy-v4-reissued",
  status: "active",
};

/**
 * Fixtures pinning numeric (not lexicographic) `externalVersion` ordering.
 * A lexicographic string comparison would wrongly rank "10" below "9" (and
 * "9" above "10"), which would silently regress `compareExternalVersion`
 * back to string-order without any single-digit-version test catching it.
 */
const VERSION_ORDER_EXTERNAL_ID = "ext-txn-version-order";

export const FIXTURE_MAPPING_V9_ACTIVE: ExternalRecordMappingRecord = {
  key: {
    ...FIXTURE_BUY_RECORD.key,
    externalId: VERSION_ORDER_EXTERNAL_ID,
    externalVersion: "9",
  },
  normalizedRecordId: "txn_normalized_fixture_version_order_v9",
  payloadSha256: "sha256:fixture-version-order-v9",
  status: "active",
  supersedesMappingId: null,
};

export const FIXTURE_MAPPING_V10_ACTIVE: ExternalRecordMappingRecord = {
  key: {
    ...FIXTURE_BUY_RECORD.key,
    externalId: VERSION_ORDER_EXTERNAL_ID,
    externalVersion: "10",
  },
  normalizedRecordId: "txn_normalized_fixture_version_order_v10",
  payloadSha256: "sha256:fixture-version-order-v10",
  status: "active",
  supersedesMappingId: null,
};

export const FIXTURE_RECORD_VERSION_9: BrokerLedgerRecord = {
  ...FIXTURE_BUY_RECORD,
  key: {
    ...FIXTURE_BUY_RECORD.key,
    externalId: VERSION_ORDER_EXTERNAL_ID,
    externalVersion: "9",
  },
  payloadSha256: "sha256:fixture-version-order-v9",
  status: "active",
};

export const FIXTURE_RECORD_VERSION_10: BrokerLedgerRecord = {
  ...FIXTURE_BUY_RECORD,
  key: {
    ...FIXTURE_BUY_RECORD.key,
    externalId: VERSION_ORDER_EXTERNAL_ID,
    externalVersion: "10",
  },
  payloadSha256: "sha256:fixture-version-order-v10",
  status: "active",
};

export const FIXTURE_POSITION_MATCHING: BrokerPositionRecord = {
  userId: FIXTURE_USER_ID,
  providerCode: FIXTURE_PROVIDER_CODE,
  brokerAccountId: FIXTURE_ACCOUNT.id,
  portfolioId: FIXTURE_PORTFOLIO_ID,
  securityId: "security_fixture_vas",
  symbol: "VAS",
  quantityDecimal: "50",
  observedAt: "2026-08-02T00:00:00.000Z",
  ingestedAt: "2026-08-02T00:05:00.000Z",
};

export const FIXTURE_POSITION_DRIFTED: BrokerPositionRecord = {
  ...FIXTURE_POSITION_MATCHING,
  securityId: "security_fixture_bhp",
  symbol: "BHP",
  quantityDecimal: "120",
};

/** A broker-reported holding whose security has not been resolved yet. */
export const FIXTURE_POSITION_UNRESOLVED: BrokerPositionRecord = {
  ...FIXTURE_POSITION_MATCHING,
  securityId: null,
  symbol: "UNRESOLVED_SYMBOL",
  quantityDecimal: "10",
};

/**
 * A broker-reported holding with a non-canonical quantity string. Adapter
 * boundary values are not guaranteed to already be validated decimal
 * strings; `parseDecimal` throws on this shape, which is exactly what
 * `planPositionReconciliation` must survive without crashing the whole
 * report.
 */
export const FIXTURE_POSITION_MALFORMED_QUANTITY: BrokerPositionRecord = {
  ...FIXTURE_POSITION_MATCHING,
  securityId: "security_fixture_malformed",
  symbol: "MALFORMED",
  quantityDecimal: "N/A",
};

export function createFixtureBrokerAdapter(): BrokerAdapter {
  return {
    capabilities: () => ({
      providerCode: FIXTURE_PROVIDER_CODE,
      supportsTransactions: true,
      supportsCash: true,
      supportsPositions: true,
      supportsQuotes: false,
      accountCurrencies: ["AUD"],
    }),
    authorize: async (input) => ({
      ok: true,
      value: {
        connectionId: FIXTURE_CONNECTION.id,
        userId: input.userId,
        providerCode: FIXTURE_PROVIDER_CODE,
        grantedScopes: input.requestedScopes,
        tokenRef: FIXTURE_TOKEN_ENVELOPE,
        authorizedAt: FIXTURE_CONNECTION.createdAt,
      },
    }),
    listAccounts: async () => ({ ok: true, value: [FIXTURE_ACCOUNT] }),
    syncTransactions: async () => ({
      ok: true,
      value: {
        records: [FIXTURE_BUY_RECORD],
        nextCursor: "cursor-2",
        providerHighWaterVersion: "1",
      },
    }),
    syncCash: async () => ({
      ok: true,
      value: { records: [], nextCursor: null, providerHighWaterVersion: "1" },
    }),
    syncPositions: async () => ({
      ok: true,
      value: [FIXTURE_POSITION_MATCHING],
    }),
    revoke: async () => ({ ok: true, value: undefined }),
  };
}
