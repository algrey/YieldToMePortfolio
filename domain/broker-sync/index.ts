export type {
  BrokerAccountMappingDenialReason,
  BrokerAccountMappingInput,
  BrokerAccountMappingResult,
  BrokerAccountRecord,
  BrokerAdapter,
  BrokerAdapterCapabilities,
  BrokerAdapterError,
  BrokerAdapterErrorKind,
  BrokerAdapterResult,
  BrokerAuthorizationInput,
  BrokerCapability,
  BrokerConnectionGrant,
  BrokerConnectionRecord,
  BrokerConnectionStatus,
  BrokerExternalRecordKey,
  BrokerLedgerRecord,
  BrokerLedgerRecordPage,
  BrokerPositionRecord,
  BrokerQuoteRequest,
  BrokerSyncRequest,
  ExternalRecordMappingRecord,
  LedgerHoldingSnapshot,
  TokenEnvelopeRef,
} from "./contracts.ts";

export {
  planBrokerLedgerSync,
  planPositionReconciliation,
  validateBrokerAccountMapping,
  type BrokerLedgerSyncEffect,
  type BrokerLedgerSyncPlan,
  type BrokerPositionDriftEntry,
  type BrokerPositionReconciliationReport,
} from "./reconciliation-plan.ts";

export {
  REDACTED_MARKER,
  redactBrokerPayload,
  redactBrokerPayloadToJson,
} from "./redaction.ts";

// Fixtures (`./fixtures.ts`) are deliberately NOT re-exported here. This
// barrel is what a future runtime import path (an adapter registry, a route,
// a job) would pull in; fixture/sample data must only ever be reachable by
// importing `./fixtures.ts` directly (as `tests/spk-003.test.ts` does), so a
// runtime import of `domain/broker-sync` can never drag it in.
