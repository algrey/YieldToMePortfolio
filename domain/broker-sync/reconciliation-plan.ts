// SPK-003 design-spike: pure planning functions for broker-sync ledger
// staging, account-mapping ownership, and position reconciliation.
//
// These functions never write to the ledger and never call a broker or
// market-data provider. They plan what a future staging/commit path
// (analogous to `domain/imports/reconciliation.ts`) would do, so the
// idempotency, correction, and reconciliation rules can be validated and
// tested before that path exists. Position/quantity comparisons reuse the
// exact-decimal representation in `domain/calculations/decimal.ts` (the
// same `parseDecimal`/`compareDecimal` pattern used by
// `domain/ledger/fifo.ts` and `domain/ledger/projections.ts`), so "50" and
// "50.000" compare equal; this module intentionally does not duplicate
// FIFO/valuation math.

import { compareDecimal, parseDecimal } from "../calculations/decimal.ts";
import type {
  BrokerAccountMappingInput,
  BrokerAccountMappingResult,
  BrokerLedgerRecord,
  BrokerPositionRecord,
  ExternalRecordMappingRecord,
  LedgerHoldingSnapshot,
} from "./contracts.ts";

/**
 * Confirms a broker connection/account/portfolio triple belongs to the
 * acting user, that the account actually belongs to the given connection,
 * and that the connection is still active, before any sync request is
 * allowed to run. Every ownership comparison uses the caller-supplied
 * `actingUserId` (sourced from the authenticated principal) as the only
 * trusted owner — never a value read off the connection/account/portfolio
 * records themselves. A revoked or expired connection is rejected here so
 * disconnection takes effect at the validation layer, not only by an
 * adapter choosing not to call a revoked token.
 */
export function validateBrokerAccountMapping(
  input: BrokerAccountMappingInput,
): BrokerAccountMappingResult {
  if (input.connection.userId !== input.actingUserId) {
    return { ok: false, reason: "connection_owner_mismatch" };
  }
  if (input.account.userId !== input.actingUserId) {
    return { ok: false, reason: "account_owner_mismatch" };
  }
  if (input.portfolio.userId !== input.actingUserId) {
    return { ok: false, reason: "portfolio_owner_mismatch" };
  }
  if (input.account.connectionId !== input.connection.id) {
    return { ok: false, reason: "account_connection_mismatch" };
  }
  if (input.connection.status !== "active") {
    return { ok: false, reason: "connection_not_active" };
  }
  return { ok: true };
}

/**
 * The *lookup* key planning groups records by. This is deliberately the
 * 5-tuple from `docs/DATA_MODEL.md` §8 (`user_id, provider, broker_account_id,
 * external_type, external_id`) WITHOUT `external_version`: the persisted
 * `external_record_mappings` table is unique on the full 6-tuple (one row
 * per reported version, kept for audit history), but planning must resolve
 * "what does this external record currently look like" by selecting the
 * single *active* row within that 5-tuple's version history
 * (`selectActiveMapping`) rather than by re-deriving identity from a
 * version-qualified key, which would make two mapping rows for the same
 * external record collide unpredictably. See `docs/ARCHITECTURE.md` §8.1
 * and `docs/SPK-003_THREAT_MODEL.md` T5–T7 for the same distinction.
 */
function mappingLookupKey(key: {
  userId: string;
  providerCode: string;
  brokerAccountId: string;
  externalType: string;
  externalId: string;
}): string {
  return [
    key.userId,
    key.providerCode,
    key.brokerAccountId,
    key.externalType,
    key.externalId,
  ].join("|");
}

/**
 * Compares two provider-reported version strings. Broker version counters
 * are ordinary (non-fractional) integers in every documented case, so a
 * `BigInt` comparison is used; a non-numeric version string falls back to a
 * stable lexicographic comparison rather than throwing, since a planning
 * function must never crash on an unexpected provider value.
 */
function compareExternalVersion(left: string, right: string): number {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  } catch {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
}

/**
 * Selects the single active mapping (if any) for a group of persisted
 * mapping rows that share the same 5-tuple lookup key. Selection is
 * deterministic regardless of the input array's order: it ignores every
 * non-`active` row (superseded/reversed history) and, in the defensive case
 * of more than one active row, picks the highest `external_version`. This
 * is what makes replaying an already-committed correction produce zero new
 * effects no matter what order a caller's D1 `SELECT` happens to return
 * rows in (there is no `ORDER BY` guarantee to rely on).
 */
function selectActiveMapping(
  mappings: readonly ExternalRecordMappingRecord[],
): ExternalRecordMappingRecord | null {
  let selected: ExternalRecordMappingRecord | null = null;
  for (const mapping of mappings) {
    if (mapping.status !== "active") continue;
    if (
      selected === null ||
      compareExternalVersion(
        mapping.key.externalVersion,
        selected.key.externalVersion,
      ) > 0
    ) {
      selected = mapping;
    }
  }
  return selected;
}

/**
 * Highest `external_version` among a group of mapping rows, regardless of
 * status. Used only when a group has no `active` row (see
 * `ExternalRecordMappingRecord`'s persistence-invariant docstring): after a
 * `reverse_only`, every row for that identity ends up non-`active`
 * (`"reversed"`), so "no active row" must NOT be treated the same as "never
 * seen" — that conflation is exactly what let a re-served old page
 * resurrect a deleted record. Returns `null` only for an empty group.
 */
function highestKnownVersion(
  mappings: readonly ExternalRecordMappingRecord[],
): string | null {
  let highest: ExternalRecordMappingRecord | null = null;
  for (const mapping of mappings) {
    if (
      highest === null ||
      compareExternalVersion(
        mapping.key.externalVersion,
        highest.key.externalVersion,
      ) > 0
    ) {
      highest = mapping;
    }
  }
  return highest === null ? null : highest.key.externalVersion;
}

export type BrokerLedgerSyncEffect =
  | Readonly<{
      action: "create";
      record: BrokerLedgerRecord;
      reason: "new_external_record";
    }>
  | Readonly<{
      action: "skip_duplicate";
      record: BrokerLedgerRecord;
      reason: "unchanged_version";
    }>
  | Readonly<{
      action: "skip_stale_version";
      record: BrokerLedgerRecord;
      reason: "older_than_active_version";
    }>
  | Readonly<{
      action: "skip_deleted_unseen";
      record: BrokerLedgerRecord;
      reason: "no_active_record_to_reverse";
    }>
  | Readonly<{
      action: "skip_reversed_history";
      record: BrokerLedgerRecord;
      reason: "already_fully_reversed";
    }>
  | Readonly<{
      action: "reverse_and_replace";
      record: BrokerLedgerRecord;
      priorNormalizedRecordId: string;
      reason: "corrected_payload";
    }>
  | Readonly<{
      action: "reverse_only";
      record: BrokerLedgerRecord;
      priorNormalizedRecordId: string;
      reason: "deleted_upstream";
    }>
  | Readonly<{
      action: "deny_cross_user";
      record: BrokerLedgerRecord;
      reason: "owner_mismatch";
    }>;

export type BrokerLedgerSyncPlan = Readonly<{
  effects: readonly BrokerLedgerSyncEffect[];
  counts: Readonly<{
    create: number;
    skipDuplicate: number;
    skipStaleVersion: number;
    skipDeletedUnseen: number;
    skipReversedHistory: number;
    reverseAndReplace: number;
    reverseOnly: number;
    denyCrossUser: number;
  }>;
}>;

/**
 * Plans ledger staging effects for a page of broker-reported records against
 * already-persisted `external_record_mappings` evidence. This is the
 * idempotency and correction/deletion contract required by BRK-001:
 *
 * - Identity is the 5-tuple `(user_id, provider, broker_account_id,
 *   external_type, external_id)`; the currently-effective state for that
 *   identity is the *active* mapping row selected by `selectActiveMapping`,
 *   never whichever row a caller's array happens to list first (fixes a
 *   real map-overwrite bug where D1's unordered `SELECT` could pick either
 *   the superseded or the active row for the same identity).
 * - `external_version` is compared numerically against the active mapping's
 *   version before any ledger effect is planned. A record at or below the
 *   active version is always a no-op — `skip_duplicate` when the version is
 *   unchanged (an exact cursor-page replay), `skip_stale_version` when it is
 *   strictly older (a cursor restart re-serving a page already superseded
 *   by a later correction) — so neither can ever churn a reversal.
 * - A record with a strictly newer version than the active mapping plans a
 *   reversal of the prior normalized record plus a replacement create
 *   (`reverse_and_replace`) — never an in-place rewrite of ledger facts.
 * - A `deleted` record with a newer version than the active mapping plans a
 *   reversal only (`reverse_only`). A `deleted` record with no active
 *   mapping to reverse — including one never seen before at all — plans an
 *   explicit no-op (`skip_deleted_unseen`), never a `create`.
 * - A group can have history but no `active` row at all: per the
 *   persistence invariant on `ExternalRecordMappingRecord`, that always
 *   means the identity was already fully reversed (`reverse_only` leaves
 *   every row for it `"reversed"`), never that it was "never seen". Such a
 *   group's highest known `external_version` (regardless of row status)
 *   still governs replay safety: a record at or below it plans
 *   `skip_reversed_history` — a no-op — so a re-served old page can never
 *   resurrect a deleted record and a replayed deletion can never re-plan
 *   itself. Only a record with a version strictly above the group's
 *   highest known version may plan a fresh `create`, representing a
 *   genuine broker re-issue of the same external ID. An empty group (no
 *   history at all) is the only case treated as truly unseen.
 * - Only rows whose key `userId` matches `userId` are ever planned; any
 *   other row is denied (`deny_cross_user`) rather than silently ignored,
 *   so a cross-user-tainted batch cannot slip a ledger effect into this
 *   user's plan.
 */
export function planBrokerLedgerSync(input: {
  userId: string;
  existingMappings: readonly ExternalRecordMappingRecord[];
  incoming: readonly BrokerLedgerRecord[];
}): BrokerLedgerSyncPlan {
  const groupedByLookupKey = new Map<string, ExternalRecordMappingRecord[]>();
  for (const mapping of input.existingMappings) {
    const lookupKey = mappingLookupKey(mapping.key);
    const group = groupedByLookupKey.get(lookupKey);
    if (group) {
      group.push(mapping);
    } else {
      groupedByLookupKey.set(lookupKey, [mapping]);
    }
  }

  const effects: BrokerLedgerSyncEffect[] = [];
  const counts = {
    create: 0,
    skipDuplicate: 0,
    skipStaleVersion: 0,
    skipDeletedUnseen: 0,
    skipReversedHistory: 0,
    reverseAndReplace: 0,
    reverseOnly: 0,
    denyCrossUser: 0,
  };

  for (const record of input.incoming) {
    if (record.key.userId !== input.userId) {
      counts.denyCrossUser += 1;
      effects.push({
        action: "deny_cross_user",
        record,
        reason: "owner_mismatch",
      });
      continue;
    }

    const group = groupedByLookupKey.get(mappingLookupKey(record.key)) ?? [];
    const active = selectActiveMapping(group);

    if (record.status === "deleted") {
      if (active !== null) {
        const comparison = compareExternalVersion(
          record.key.externalVersion,
          active.key.externalVersion,
        );
        if (comparison <= 0) {
          counts.skipStaleVersion += 1;
          effects.push({
            action: "skip_stale_version",
            record,
            reason: "older_than_active_version",
          });
          continue;
        }
        counts.reverseOnly += 1;
        effects.push({
          action: "reverse_only",
          record,
          priorNormalizedRecordId: active.normalizedRecordId,
          reason: "deleted_upstream",
        });
        continue;
      }
      // No active mapping: there is nothing to reverse either way. Distinguish
      // "never seen at all" from "history exists but was already fully
      // reversed" only for a more informative action — both are no-ops.
      if (group.length === 0) {
        counts.skipDeletedUnseen += 1;
        effects.push({
          action: "skip_deleted_unseen",
          record,
          reason: "no_active_record_to_reverse",
        });
        continue;
      }
      counts.skipReversedHistory += 1;
      effects.push({
        action: "skip_reversed_history",
        record,
        reason: "already_fully_reversed",
      });
      continue;
    }

    // record.status is "active" or "corrected".
    if (active !== null) {
      const comparison = compareExternalVersion(
        record.key.externalVersion,
        active.key.externalVersion,
      );

      if (comparison < 0) {
        counts.skipStaleVersion += 1;
        effects.push({
          action: "skip_stale_version",
          record,
          reason: "older_than_active_version",
        });
        continue;
      }

      if (comparison === 0) {
        counts.skipDuplicate += 1;
        effects.push({
          action: "skip_duplicate",
          record,
          reason: "unchanged_version",
        });
        continue;
      }

      counts.reverseAndReplace += 1;
      effects.push({
        action: "reverse_and_replace",
        record,
        priorNormalizedRecordId: active.normalizedRecordId,
        reason: "corrected_payload",
      });
      continue;
    }

    if (group.length === 0) {
      // Truly unseen: no row of any status exists for this identity.
      counts.create += 1;
      effects.push({ action: "create", record, reason: "new_external_record" });
      continue;
    }

    // History exists but every row is non-active (fully reversed). Only a
    // version strictly newer than anything on record may plan a fresh
    // create (a genuine broker re-issue); anything at or below it is a
    // replay of an already-reversed identity and must not resurrect it.
    const highestVersion = highestKnownVersion(group)!;
    const comparison = compareExternalVersion(
      record.key.externalVersion,
      highestVersion,
    );

    if (comparison <= 0) {
      counts.skipReversedHistory += 1;
      effects.push({
        action: "skip_reversed_history",
        record,
        reason: "already_fully_reversed",
      });
      continue;
    }

    counts.create += 1;
    effects.push({ action: "create", record, reason: "new_external_record" });
  }

  return { effects, counts };
}

export type BrokerPositionDriftEntry =
  | Readonly<{
      status: "match";
      securityId: string;
      quantityDecimal: string;
    }>
  | Readonly<{
      status: "drift";
      securityId: string;
      brokerQuantityDecimal: string;
      ledgerQuantityDecimal: string;
    }>
  | Readonly<{
      status: "broker_only";
      securityId: string;
      brokerQuantityDecimal: string;
    }>
  | Readonly<{
      status: "ledger_only";
      securityId: string;
      ledgerQuantityDecimal: string;
    }>
  | Readonly<{
      status: "unresolved_security";
      symbol: string;
      brokerQuantityDecimal: string;
    }>
  | Readonly<{
      status: "unparseable_quantity";
      securityId: string;
      brokerQuantityDecimal: string;
      ledgerQuantityDecimal: string;
    }>;

export type BrokerPositionReconciliationReport = Readonly<{
  entries: readonly BrokerPositionDriftEntry[];
  hasDrift: boolean;
}>;

/**
 * Compares broker-reported positions against ledger-derived holdings for
 * one portfolio and reports drift. This is reconciliation evidence only —
 * it never plans or performs a ledger write, matching BRK-001's "positions
 * reconcile against, but never silently overwrite, ledger-derived holdings."
 * Quantity comparison uses `parseDecimal`/`compareDecimal`
 * (`domain/calculations/decimal.ts`) rather than string equality, so
 * differently-formatted equal quantities (`"50"` vs `"50.000"`) never
 * report a false drift.
 *
 * A broker position whose security has not been resolved to an internal
 * `securityId` (`securityId: null`, e.g. a symbol the mapping workflow
 * hasn't matched yet) cannot be compared against a ledger holding by ID, but
 * it must not be silently dropped — an unresolved broker holding is itself
 * a reconciliation gap. It always contributes an explicit
 * `unresolved_security` entry and always sets `hasDrift`.
 *
 * `quantityDecimal` values arrive from an adapter boundary (a future
 * broker's API response, or an upstream ledger read) and are not guaranteed
 * to be canonical decimal strings — `parseDecimal` throws on `""`, `"N/A"`,
 * exponent notation, or thousands separators. Per AGENTS.md's
 * validate-unknown-at-boundaries rule (and mirroring
 * `compareExternalVersion`'s own never-throw policy above), a value that
 * fails to parse never crashes this function: it is reported as an explicit
 * `unparseable_quantity` entry and always sets `hasDrift`, rather than
 * silently comparing as equal or throwing and losing the entire report.
 */
export function planPositionReconciliation(input: {
  portfolioId: string;
  brokerPositions: readonly BrokerPositionRecord[];
  ledgerHoldings: readonly LedgerHoldingSnapshot[];
}): BrokerPositionReconciliationReport {
  const brokerBySecurity = new Map<string, string>();
  const unresolvedBrokerPositions: BrokerPositionRecord[] = [];
  for (const position of input.brokerPositions) {
    if (position.portfolioId !== input.portfolioId) continue;
    if (position.securityId === null) {
      unresolvedBrokerPositions.push(position);
      continue;
    }
    brokerBySecurity.set(position.securityId, position.quantityDecimal);
  }

  const ledgerBySecurity = new Map<string, string>();
  for (const holding of input.ledgerHoldings) {
    if (holding.portfolioId !== input.portfolioId) continue;
    ledgerBySecurity.set(holding.securityId, holding.quantityDecimal);
  }

  const securityIds = new Set([
    ...brokerBySecurity.keys(),
    ...ledgerBySecurity.keys(),
  ]);

  const entries: BrokerPositionDriftEntry[] = [];
  let hasDrift = false;

  for (const securityId of securityIds) {
    const brokerQuantity = brokerBySecurity.get(securityId);
    const ledgerQuantity = ledgerBySecurity.get(securityId);

    if (brokerQuantity !== undefined && ledgerQuantity !== undefined) {
      let quantitiesMatch: boolean;
      try {
        quantitiesMatch =
          compareDecimal(
            parseDecimal(brokerQuantity),
            parseDecimal(ledgerQuantity),
          ) === 0;
      } catch {
        hasDrift = true;
        entries.push({
          status: "unparseable_quantity",
          securityId,
          brokerQuantityDecimal: brokerQuantity,
          ledgerQuantityDecimal: ledgerQuantity,
        });
        continue;
      }
      if (quantitiesMatch) {
        entries.push({
          status: "match",
          securityId,
          quantityDecimal: brokerQuantity,
        });
      } else {
        hasDrift = true;
        entries.push({
          status: "drift",
          securityId,
          brokerQuantityDecimal: brokerQuantity,
          ledgerQuantityDecimal: ledgerQuantity,
        });
      }
      continue;
    }

    if (brokerQuantity !== undefined) {
      hasDrift = true;
      entries.push({
        status: "broker_only",
        securityId,
        brokerQuantityDecimal: brokerQuantity,
      });
      continue;
    }

    if (ledgerQuantity !== undefined) {
      hasDrift = true;
      entries.push({
        status: "ledger_only",
        securityId,
        ledgerQuantityDecimal: ledgerQuantity,
      });
    }
  }

  for (const position of unresolvedBrokerPositions) {
    hasDrift = true;
    entries.push({
      status: "unresolved_security",
      symbol: position.symbol,
      brokerQuantityDecimal: position.quantityDecimal,
    });
  }

  return { entries, hasDrift };
}
