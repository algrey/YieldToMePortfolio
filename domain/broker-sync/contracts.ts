// SPK-003 design-spike contract types for a future broker/OAuth sync adapter.
//
// These types validate the adapter boundary documented in
// `docs/ARCHITECTURE.md` §8 ("Future broker synchronization boundary") and
// `docs/DATA_MODEL.md` §8 ("Future broker-sync extension") before any
// broker-specific dependency, network call, or credential store exists.
// Nothing here performs I/O, stores a token, or calls a broker API.
//
// Non-negotiables encoded by this contract (see AGENTS.md and BRK-001):
// - Broker credentials are modelled as opaque, already-encrypted token
//   *references* (`TokenEnvelopeRef`). No field anywhere in this module can
//   hold a raw token/secret value.
// - Every owner-scoped structure carries `userId` sourced from the
//   authenticated principal, never a client-supplied value.
// - Positions/cash are reconciliation evidence only; nothing in this module
//   produces a direct ledger write. Ledger effects flow through the same
//   staging/validation/reversal-or-supersession model as CSV/manual sources.
// - Optional quotes reuse `PriceObservation` from the existing market-data
//   abstraction rather than defining a parallel quote shape.

import type { PriceObservation } from "../market-data/contracts.ts";
import type {
  CashLedgerEntryType,
  LedgerTransactionType,
} from "../ledger/event-validation.ts";

/** Matches `broker_sync_runs.capability` in `docs/DATA_MODEL.md` §8. */
export type BrokerCapability = "transactions" | "cash" | "positions" | "quotes";

export type BrokerConnectionStatus = "active" | "expired" | "revoked";

/**
 * A reference to encrypted-at-rest token/credential material. The envelope
 * itself (encryption, storage, rotation) is out of scope for this spike; the
 * contract only ever carries this opaque reference so a raw token can never
 * flow through fixtures, logs, or error payloads.
 */
export type TokenEnvelopeRef = Readonly<{
  envelopeId: string;
  expiresAt: string | null;
  status: BrokerConnectionStatus;
}>;

export type BrokerConnectionRecord = Readonly<{
  id: string;
  userId: string;
  providerCode: string;
  status: BrokerConnectionStatus;
  grantedScopes: readonly string[];
  tokenRef: TokenEnvelopeRef;
  lastAuthenticatedAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}>;

export type BrokerAccountRecord = Readonly<{
  id: string;
  userId: string;
  connectionId: string;
  providerAccountIdHash: string;
  displayLabel: string;
  accountCurrencyCode: string;
  accountType: string;
  mappedPortfolioId: string | null;
  status: "active" | "disconnected";
  lastSyncedAt: string | null;
}>;

/**
 * Owner references passed to `validateBrokerAccountMapping`. Each side
 * carries its own `userId` so the validator can detect a cross-user mapping
 * even if a caller mistakenly passes rows from different owners. The
 * connection also carries its own lifecycle `status` so a revoked/expired
 * connection is rejected for sync at this same validation layer, not only
 * by an adapter implementation choosing not to use a revoked token.
 */
export type BrokerAccountMappingInput = Readonly<{
  actingUserId: string;
  connection: Readonly<{
    id: string;
    userId: string;
    status: BrokerConnectionStatus;
  }>;
  account: Readonly<{ id: string; userId: string; connectionId: string }>;
  portfolio: Readonly<{ id: string; userId: string }>;
}>;

export type BrokerAccountMappingDenialReason =
  | "connection_owner_mismatch"
  | "account_owner_mismatch"
  | "portfolio_owner_mismatch"
  | "account_connection_mismatch"
  | "connection_not_active";

export type BrokerAccountMappingResult =
  { ok: true } | { ok: false; reason: BrokerAccountMappingDenialReason };

/**
 * Identifies one broker-reported record for idempotent staging.
 *
 * `externalVersion` makes this a 6-tuple that is unique per persisted
 * `external_record_mappings` row (`docs/DATA_MODEL.md` §8): every reported
 * version of an external record gets its own row, preserving audit history
 * across corrections. Planning (`planBrokerLedgerSync` in
 * `reconciliation-plan.ts`) instead groups by the 5-tuple WITHOUT
 * `externalVersion` and resolves the current state via the single *active*
 * row in that group — see that function's `mappingLookupKey`/
 * `selectActiveMapping` for why the version is deliberately excluded from
 * the lookup key.
 */
export type BrokerExternalRecordKey = Readonly<{
  userId: string;
  providerCode: string;
  brokerAccountId: string;
  externalType: "transaction" | "cash";
  externalId: string;
  externalVersion: string;
}>;

/**
 * A broker-reported ledger candidate awaiting staging. Mirrors
 * `LedgerTransactionInput`/`CashLedgerEntryInput` closely enough to reuse
 * `domain/ledger/event-validation.ts` once this spike is promoted, without
 * duplicating its validation rules here.
 */
export type BrokerLedgerRecord = Readonly<{
  key: BrokerExternalRecordKey;
  recordKind: "transaction" | "cash";
  transactionType: LedgerTransactionType | null;
  cashEntryType: CashLedgerEntryType | null;
  portfolioSecurityId: string | null;
  quantityDecimal: string | null;
  unitPriceDecimal: string | null;
  amountDecimal: string;
  feeAmountDecimal: string;
  taxAmountDecimal: string;
  currencyCode: string;
  observedAt: string;
  ingestedAt: string;
  payloadSha256: string;
  status: "active" | "corrected" | "deleted";
}>;

/**
 * Persisted idempotency evidence, mirroring `external_record_mappings`. One
 * row exists per reported `external_version` (unique on the full 6-tuple
 * `key`); `status` distinguishes the single currently-effective row
 * (`active`) from prior versions kept only for audit history
 * (`superseded` after a correction, `reversed` after a deletion).
 *
 * Persistence invariant (what applying a `BrokerLedgerSyncEffect` from
 * `planBrokerLedgerSync` leaves behind — see `reconciliation-plan.ts` for
 * the corresponding planning logic and `docs/DATA_MODEL.md` §8.1):
 * - `create`: insert one new row at the record's version, `status: "active"`.
 * - `reverse_and_replace`: the previously-`active` row's `status` becomes
 *   `"superseded"`; insert one new row at the corrected version,
 *   `status: "active"`. Exactly one `active` row exists for the identity
 *   afterward.
 * - `reverse_only`: the previously-`active` row's `status` becomes
 *   `"reversed"`, AND a new row is inserted at the deletion's version, also
 *   `status: "reversed"` (it represents the deletion event itself, not a
 *   replacement). **No row for that 5-tuple identity is ever `"active"`
 *   again afterward** — a group with history but no active row means the
 *   identity was fully reversed, not that it was never seen. This state is
 *   permanent for any replay at or below the highest version on record: only
 *   a strictly newer version can plan a fresh `create` (a genuine broker
 *   re-issue of the same external ID), never a resurrection of the deleted
 *   record from a lower/equal version replay.
 */
export type ExternalRecordMappingRecord = Readonly<{
  key: BrokerExternalRecordKey;
  normalizedRecordId: string;
  payloadSha256: string;
  status: "active" | "superseded" | "reversed";
  supersedesMappingId: string | null;
}>;

export type BrokerPositionRecord = Readonly<{
  userId: string;
  providerCode: string;
  brokerAccountId: string;
  portfolioId: string;
  securityId: string | null;
  symbol: string;
  quantityDecimal: string;
  observedAt: string;
  ingestedAt: string;
}>;

export type LedgerHoldingSnapshot = Readonly<{
  portfolioId: string;
  securityId: string;
  quantityDecimal: string;
}>;

export type BrokerAdapterErrorKind =
  | "authentication"
  | "entitlement"
  | "rate_limit"
  | "unavailable_capability"
  | "account_not_found"
  | "invalid_response"
  | "timeout"
  | "transient_upstream";

export type BrokerAdapterError = Readonly<{
  kind: BrokerAdapterErrorKind;
  message: string;
  retryable: boolean;
}>;

export type BrokerAdapterResult<T> =
  { ok: true; value: T } | { ok: false; error: BrokerAdapterError };

export type BrokerAdapterCapabilities = Readonly<{
  providerCode: string;
  supportsTransactions: boolean;
  supportsCash: boolean;
  supportsPositions: boolean;
  supportsQuotes: boolean;
  accountCurrencies: readonly string[];
}>;

export type BrokerAuthorizationInput = Readonly<{
  userId: string;
  redirectUri: string;
  requestedScopes: readonly string[];
}>;

export type BrokerConnectionGrant = Readonly<{
  connectionId: string;
  userId: string;
  providerCode: string;
  grantedScopes: readonly string[];
  tokenRef: TokenEnvelopeRef;
  authorizedAt: string;
}>;

export type BrokerSyncRequest = Readonly<{
  userId: string;
  connectionId: string;
  accountId: string;
  portfolioId: string;
  capability: BrokerCapability;
  cursor: string | null;
  fromDate: string | null;
  toDate: string | null;
}>;

export type BrokerLedgerRecordPage = Readonly<{
  records: readonly BrokerLedgerRecord[];
  nextCursor: string | null;
  providerHighWaterVersion: string | null;
}>;

export type BrokerQuoteRequest = Readonly<{
  userId: string;
  connectionId: string;
  accountId: string;
  securityId: string;
}>;

/**
 * The adapter boundary itself. An implementation is deliberately absent from
 * this spike: no broker SDK, network call, or credential store is
 * introduced until a future task selects and approves a specific provider.
 */
export type BrokerAdapter = Readonly<{
  capabilities(): BrokerAdapterCapabilities;
  authorize(
    input: BrokerAuthorizationInput,
  ): Promise<BrokerAdapterResult<BrokerConnectionGrant>>;
  listAccounts(
    connectionId: string,
  ): Promise<BrokerAdapterResult<readonly BrokerAccountRecord[]>>;
  syncTransactions(
    request: BrokerSyncRequest,
  ): Promise<BrokerAdapterResult<BrokerLedgerRecordPage>>;
  syncCash(
    request: BrokerSyncRequest,
  ): Promise<BrokerAdapterResult<BrokerLedgerRecordPage>>;
  syncPositions(
    request: BrokerSyncRequest,
  ): Promise<BrokerAdapterResult<readonly BrokerPositionRecord[]>>;
  getEntitledQuotes?(
    request: BrokerQuoteRequest,
  ): Promise<BrokerAdapterResult<readonly PriceObservation[]>>;
  revoke(connectionId: string): Promise<BrokerAdapterResult<void>>;
}>;
