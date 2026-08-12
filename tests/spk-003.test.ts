import assert from "node:assert/strict";
import test from "node:test";

// SPK-003: contract tests for the future broker-sync adapter boundary
// (BRK-001). These exercise pure TypeScript types and planning functions
// only — no network call, broker SDK, or credential store exists yet. See
// docs/ARCHITECTURE.md §8/§8.1 and docs/DATA_MODEL.md §8 for the design
// this validates, and docs/SPK-003_THREAT_MODEL.md for the security
// analysis behind the cross-user, revocation, and token-redaction cases
// below.
//
// Contract/planning functions come from the `domain/broker-sync` barrel;
// fixtures are imported from `./fixtures.ts` directly rather than through
// the barrel, so a real runtime import of `domain/broker-sync` can never
// pull in fixture/sample data (see `domain/broker-sync/index.ts`).

import {
  planBrokerLedgerSync,
  planPositionReconciliation,
  redactBrokerPayload,
  redactBrokerPayloadToJson,
  validateBrokerAccountMapping,
  type LedgerHoldingSnapshot,
} from "../domain/broker-sync/index.ts";
import {
  createFixtureBrokerAdapter,
  FIXTURE_ACCOUNT,
  FIXTURE_BUY_RECORD,
  FIXTURE_BUY_RECORD_CORRECTED,
  FIXTURE_BUY_RECORD_DELETED,
  FIXTURE_BUY_RECORD_REISSUED,
  FIXTURE_CONNECTION,
  FIXTURE_CONNECTION_REVOKED,
  FIXTURE_MAPPING_AFTER_FIRST_SYNC,
  FIXTURE_MAPPING_V1_REVERSED,
  FIXTURE_MAPPING_V1_SUPERSEDED,
  FIXTURE_MAPPING_V2_ACTIVE,
  FIXTURE_MAPPING_V3_REVERSED,
  FIXTURE_MAPPING_V9_ACTIVE,
  FIXTURE_MAPPING_V10_ACTIVE,
  FIXTURE_PORTFOLIO_ID,
  FIXTURE_POSITION_DRIFTED,
  FIXTURE_POSITION_MALFORMED_QUANTITY,
  FIXTURE_POSITION_MATCHING,
  FIXTURE_POSITION_UNRESOLVED,
  FIXTURE_RECORD_VERSION_9,
  FIXTURE_RECORD_VERSION_10,
  FIXTURE_USER_ID,
  OTHER_USER_ID,
  RAW_UPSTREAM_PAYLOAD_SAMPLE,
} from "../domain/broker-sync/fixtures.ts";

test("fixture adapter satisfies the BrokerAdapter contract shape", async () => {
  const adapter = createFixtureBrokerAdapter();

  assert.equal(typeof adapter.capabilities, "function");
  assert.equal(typeof adapter.authorize, "function");
  assert.equal(typeof adapter.listAccounts, "function");
  assert.equal(typeof adapter.syncTransactions, "function");
  assert.equal(typeof adapter.syncCash, "function");
  assert.equal(typeof adapter.syncPositions, "function");
  assert.equal(typeof adapter.revoke, "function");
  // Quotes are optional on the contract (only entitled connections expose
  // them); this fixture adapter deliberately omits it.
  assert.equal(adapter.getEntitledQuotes, undefined);

  const capabilities = adapter.capabilities();
  assert.equal(capabilities.supportsQuotes, false);
  assert.deepEqual(capabilities.accountCurrencies, ["AUD"]);

  const accounts = await adapter.listAccounts(FIXTURE_CONNECTION.id);
  assert.equal(accounts.ok, true);
  if (accounts.ok) {
    assert.equal(accounts.value.length, 1);
    assert.equal(accounts.value[0]?.id, FIXTURE_ACCOUNT.id);
  }

  const revoked = await adapter.revoke(FIXTURE_CONNECTION.id);
  assert.equal(revoked.ok, true);
});

function mappingInput(
  overrides: Partial<{
    connectionStatus: "active" | "expired" | "revoked";
  }> = {},
) {
  return {
    actingUserId: FIXTURE_USER_ID,
    connection: {
      id: FIXTURE_CONNECTION.id,
      userId: FIXTURE_USER_ID,
      status: overrides.connectionStatus ?? "active",
    },
    account: {
      id: FIXTURE_ACCOUNT.id,
      userId: FIXTURE_USER_ID,
      connectionId: FIXTURE_CONNECTION.id,
    },
    portfolio: { id: FIXTURE_PORTFOLIO_ID, userId: FIXTURE_USER_ID },
  };
}

test("account mapping validation accepts a matching owner across connection/account/portfolio", () => {
  const result = validateBrokerAccountMapping(mappingInput());
  assert.deepEqual(result, { ok: true });
});

test("account mapping validation denies a cross-user account, connection, or portfolio", () => {
  const baseInput = mappingInput();

  assert.deepEqual(
    validateBrokerAccountMapping({
      ...baseInput,
      connection: { ...baseInput.connection, userId: OTHER_USER_ID },
    }),
    { ok: false, reason: "connection_owner_mismatch" },
  );

  assert.deepEqual(
    validateBrokerAccountMapping({
      ...baseInput,
      account: { ...baseInput.account, userId: OTHER_USER_ID },
    }),
    { ok: false, reason: "account_owner_mismatch" },
  );

  assert.deepEqual(
    validateBrokerAccountMapping({
      ...baseInput,
      portfolio: { ...baseInput.portfolio, userId: OTHER_USER_ID },
    }),
    { ok: false, reason: "portfolio_owner_mismatch" },
  );

  assert.deepEqual(
    validateBrokerAccountMapping({
      ...baseInput,
      account: { ...baseInput.account, connectionId: "conn_other" },
    }),
    { ok: false, reason: "account_connection_mismatch" },
  );
});

test("account mapping validation rejects sync for a revoked or expired connection", () => {
  // Approved follow-up: exercise the active -> revoked lifecycle transition
  // and confirm a revoked connection is rejected at the validation layer,
  // not only by an adapter implementation declining to use a dead token.
  assert.equal(FIXTURE_CONNECTION.status, "active");
  assert.equal(FIXTURE_CONNECTION_REVOKED.status, "revoked");

  const revoked = validateBrokerAccountMapping(
    mappingInput({ connectionStatus: "revoked" }),
  );
  assert.deepEqual(revoked, { ok: false, reason: "connection_not_active" });

  const expired = validateBrokerAccountMapping(
    mappingInput({ connectionStatus: "expired" }),
  );
  assert.deepEqual(expired, { ok: false, reason: "connection_not_active" });

  // Ownership is still checked first: a cross-user connection is denied for
  // its own reason even if it also happens to be revoked.
  const crossUserAndRevoked = validateBrokerAccountMapping({
    ...mappingInput({ connectionStatus: "revoked" }),
    connection: {
      id: FIXTURE_CONNECTION.id,
      userId: OTHER_USER_ID,
      status: "revoked",
    },
  });
  assert.deepEqual(crossUserAndRevoked, {
    ok: false,
    reason: "connection_owner_mismatch",
  });
});

test("a first sync plans a single ledger create for a new external record", () => {
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [],
    incoming: [FIXTURE_BUY_RECORD],
  });

  assert.equal(plan.counts.create, 1);
  assert.equal(plan.counts.skipDuplicate, 0);
  assert.equal(plan.effects[0]?.action, "create");
});

test("replaying the same cursor page after commit plans zero new ledger effects", () => {
  // Simulate the state after the first sync's `create` effect above was
  // applied: an external_record_mappings row now exists with the same
  // version as the incoming record.
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [FIXTURE_MAPPING_AFTER_FIRST_SYNC],
    incoming: [FIXTURE_BUY_RECORD],
  });

  assert.equal(plan.counts.create, 0);
  assert.equal(plan.counts.reverseAndReplace, 0);
  assert.equal(plan.counts.reverseOnly, 0);
  assert.equal(plan.counts.skipStaleVersion, 0);
  assert.equal(plan.counts.skipDuplicate, 1);
  assert.equal(plan.effects[0]?.action, "skip_duplicate");

  // Replaying a second time stays idempotent too.
  const secondReplay = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [FIXTURE_MAPPING_AFTER_FIRST_SYNC],
    incoming: [FIXTURE_BUY_RECORD],
  });
  assert.equal(secondReplay.counts.create, 0);
  assert.equal(secondReplay.counts.skipDuplicate, 1);
});

test("a corrected broker record plans reversal-and-replacement, never an in-place rewrite", () => {
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [FIXTURE_MAPPING_AFTER_FIRST_SYNC],
    incoming: [FIXTURE_BUY_RECORD_CORRECTED],
  });

  assert.equal(plan.counts.reverseAndReplace, 1);
  const effect = plan.effects[0];
  assert.equal(effect?.action, "reverse_and_replace");
  if (effect?.action === "reverse_and_replace") {
    assert.equal(
      effect.priorNormalizedRecordId,
      FIXTURE_MAPPING_AFTER_FIRST_SYNC.normalizedRecordId,
    );
  }
});

test("B1 — a deleted record never before seen plans an explicit no-op, never a create", () => {
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [],
    incoming: [FIXTURE_BUY_RECORD_DELETED],
  });

  assert.equal(plan.counts.create, 0);
  assert.equal(plan.counts.reverseOnly, 0);
  assert.equal(plan.counts.skipDeletedUnseen, 1);
  assert.equal(plan.effects[0]?.action, "skip_deleted_unseen");
});

test("a deleted broker record with an active mapping plans a reversal only, with no replacement create", () => {
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [FIXTURE_MAPPING_AFTER_FIRST_SYNC],
    incoming: [FIXTURE_BUY_RECORD_DELETED],
  });

  assert.equal(plan.counts.reverseOnly, 1);
  assert.equal(plan.counts.create, 0);
  const effect = plan.effects[0];
  assert.equal(effect?.action, "reverse_only");
  if (effect?.action === "reverse_only") {
    assert.equal(
      effect.priorNormalizedRecordId,
      FIXTURE_MAPPING_AFTER_FIRST_SYNC.normalizedRecordId,
    );
  }
});

test("B2 — replaying an already-committed correction plans zero new effects regardless of mapping array order", () => {
  const incoming = [FIXTURE_BUY_RECORD_CORRECTED];

  const forwardOrder = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [
      FIXTURE_MAPPING_V1_SUPERSEDED,
      FIXTURE_MAPPING_V2_ACTIVE,
    ],
    incoming,
  });
  const reverseOrder = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [
      FIXTURE_MAPPING_V2_ACTIVE,
      FIXTURE_MAPPING_V1_SUPERSEDED,
    ],
    incoming,
  });

  for (const plan of [forwardOrder, reverseOrder]) {
    assert.equal(plan.counts.create, 0);
    assert.equal(plan.counts.reverseAndReplace, 0);
    assert.equal(plan.counts.reverseOnly, 0);
    assert.equal(plan.counts.skipDuplicate, 1);
    assert.equal(plan.effects[0]?.action, "skip_duplicate");
  }
});

test("B3 — a re-served older page after a later correction is committed plans zero reversal churn", () => {
  // v1 (FIXTURE_BUY_RECORD) is re-served by a restarted cursor after v2 was
  // already committed as the active mapping. This must never plan another
  // reverse_and_replace of the already-superseded v1 payload.
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [FIXTURE_MAPPING_V2_ACTIVE],
    incoming: [FIXTURE_BUY_RECORD],
  });

  assert.equal(plan.counts.reverseAndReplace, 0);
  assert.equal(plan.counts.create, 0);
  assert.equal(plan.counts.skipStaleVersion, 1);
  assert.equal(plan.effects[0]?.action, "skip_stale_version");
});

test("C1 — a re-served old page against an all-reversed group never resurrects the deleted record", () => {
  // v1 was created, then fully reversed by a v3 deletion (both rows end up
  // status "reversed" per the persistence invariant — no active row
  // remains). A restarted cursor re-serving the original v1 page must not
  // plan a `create` just because there is no active mapping.
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [
      FIXTURE_MAPPING_V1_REVERSED,
      FIXTURE_MAPPING_V3_REVERSED,
    ],
    incoming: [FIXTURE_BUY_RECORD],
  });

  assert.equal(plan.counts.create, 0);
  assert.equal(plan.counts.reverseAndReplace, 0);
  assert.equal(plan.counts.reverseOnly, 0);
  assert.equal(plan.counts.skipReversedHistory, 1);
  assert.equal(plan.effects[0]?.action, "skip_reversed_history");
});

test("C1 — replaying the deletion itself against an all-reversed group is also a no-op", () => {
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [
      FIXTURE_MAPPING_V1_REVERSED,
      FIXTURE_MAPPING_V3_REVERSED,
    ],
    incoming: [FIXTURE_BUY_RECORD_DELETED],
  });

  assert.equal(plan.counts.create, 0);
  assert.equal(plan.counts.reverseOnly, 0);
  assert.equal(plan.counts.skipDeletedUnseen, 0);
  assert.equal(plan.counts.skipReversedHistory, 1);
  assert.equal(plan.effects[0]?.action, "skip_reversed_history");
});

test("C1 — a genuinely newer version after a full deletion is allowed to create (broker re-issue)", () => {
  // FIXTURE_BUY_RECORD_REISSUED is version "4", strictly newer than the
  // group's highest known version "3" (FIXTURE_MAPPING_V3_REVERSED). This is
  // the one case where a group with no active row still plans a `create`.
  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [
      FIXTURE_MAPPING_V1_REVERSED,
      FIXTURE_MAPPING_V3_REVERSED,
    ],
    incoming: [FIXTURE_BUY_RECORD_REISSUED],
  });

  assert.equal(plan.counts.create, 1);
  assert.equal(plan.counts.skipReversedHistory, 0);
  assert.equal(plan.effects[0]?.action, "create");
});

test('version comparison is numeric, not lexicographic (pins "9" vs "10" in both directions)', () => {
  // A lexicographic regression would rank "10" below "9" (wrong) and "9"
  // above "10" (also wrong); single-digit-only fixtures elsewhere in this
  // file cannot catch that. Both directions are asserted here.
  const ascending = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [FIXTURE_MAPPING_V9_ACTIVE],
    incoming: [FIXTURE_RECORD_VERSION_10],
  });
  assert.equal(ascending.counts.reverseAndReplace, 1);
  assert.equal(ascending.counts.skipStaleVersion, 0);
  assert.equal(ascending.effects[0]?.action, "reverse_and_replace");

  const descending = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [FIXTURE_MAPPING_V10_ACTIVE],
    incoming: [FIXTURE_RECORD_VERSION_9],
  });
  assert.equal(descending.counts.skipStaleVersion, 1);
  assert.equal(descending.counts.reverseAndReplace, 0);
  assert.equal(descending.effects[0]?.action, "skip_stale_version");
});

test("a record whose key belongs to another user is denied rather than planned", () => {
  const crossUserRecord = {
    ...FIXTURE_BUY_RECORD,
    key: { ...FIXTURE_BUY_RECORD.key, userId: OTHER_USER_ID },
  };

  const plan = planBrokerLedgerSync({
    userId: FIXTURE_USER_ID,
    existingMappings: [],
    incoming: [crossUserRecord],
  });

  assert.equal(plan.counts.create, 0);
  assert.equal(plan.counts.denyCrossUser, 1);
  assert.equal(plan.effects[0]?.action, "deny_cross_user");
});

test("position reconciliation reports a matching position without planning a ledger write", () => {
  const ledgerHoldings: LedgerHoldingSnapshot[] = [
    {
      portfolioId: FIXTURE_PORTFOLIO_ID,
      securityId: "security_fixture_vas",
      quantityDecimal: "50",
    },
  ];

  const report = planPositionReconciliation({
    portfolioId: FIXTURE_PORTFOLIO_ID,
    brokerPositions: [FIXTURE_POSITION_MATCHING],
    ledgerHoldings,
  });

  assert.equal(report.hasDrift, false);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]?.status, "match");
});

test("B4 — position reconciliation compares quantities as decimals, not as strings", () => {
  const ledgerHoldings: LedgerHoldingSnapshot[] = [
    {
      portfolioId: FIXTURE_PORTFOLIO_ID,
      securityId: "security_fixture_vas",
      // Differently formatted but decimally-equal to the broker's "50".
      quantityDecimal: "50.000",
    },
  ];

  const report = planPositionReconciliation({
    portfolioId: FIXTURE_PORTFOLIO_ID,
    brokerPositions: [FIXTURE_POSITION_MATCHING],
    ledgerHoldings,
  });

  assert.equal(report.hasDrift, false);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]?.status, "match");
});

test("position reconciliation flags drift, broker-only, and ledger-only positions", () => {
  const ledgerHoldings: LedgerHoldingSnapshot[] = [
    {
      portfolioId: FIXTURE_PORTFOLIO_ID,
      securityId: "security_fixture_bhp",
      // Ledger says 100 shares; the broker fixture reports 120.
      quantityDecimal: "100",
    },
    {
      portfolioId: FIXTURE_PORTFOLIO_ID,
      securityId: "security_fixture_ledger_only",
      quantityDecimal: "10",
    },
  ];

  const report = planPositionReconciliation({
    portfolioId: FIXTURE_PORTFOLIO_ID,
    brokerPositions: [
      FIXTURE_POSITION_DRIFTED,
      {
        ...FIXTURE_POSITION_MATCHING,
        securityId: "security_fixture_broker_only",
        symbol: "BROKER_ONLY",
        quantityDecimal: "5",
      },
    ],
    ledgerHoldings,
  });

  assert.equal(report.hasDrift, true);
  const statuses = report.entries.map((entry) => entry.status).sort();
  assert.deepEqual(statuses, ["broker_only", "drift", "ledger_only"]);

  const drift = report.entries.find((entry) => entry.status === "drift");
  assert.equal(drift?.status, "drift");
  if (drift?.status === "drift") {
    assert.equal(drift.brokerQuantityDecimal, "120");
    assert.equal(drift.ledgerQuantityDecimal, "100");
  }
});

test("B5 — an unresolved-security broker position is reported as drift, never silently dropped", () => {
  const report = planPositionReconciliation({
    portfolioId: FIXTURE_PORTFOLIO_ID,
    brokerPositions: [FIXTURE_POSITION_UNRESOLVED],
    ledgerHoldings: [],
  });

  assert.equal(report.hasDrift, true);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]?.status, "unresolved_security");
  if (report.entries[0]?.status === "unresolved_security") {
    assert.equal(report.entries[0].symbol, FIXTURE_POSITION_UNRESOLVED.symbol);
    assert.equal(
      report.entries[0].brokerQuantityDecimal,
      FIXTURE_POSITION_UNRESOLVED.quantityDecimal,
    );
  }
});

test("C2 — a malformed broker-side quantity is flagged, not thrown", () => {
  const ledgerHoldings: LedgerHoldingSnapshot[] = [
    {
      portfolioId: FIXTURE_PORTFOLIO_ID,
      securityId: FIXTURE_POSITION_MALFORMED_QUANTITY.securityId!,
      quantityDecimal: "50",
    },
  ];

  const report = planPositionReconciliation({
    portfolioId: FIXTURE_PORTFOLIO_ID,
    brokerPositions: [FIXTURE_POSITION_MALFORMED_QUANTITY],
    ledgerHoldings,
  });

  assert.equal(report.hasDrift, true);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]?.status, "unparseable_quantity");
  if (report.entries[0]?.status === "unparseable_quantity") {
    assert.equal(
      report.entries[0].brokerQuantityDecimal,
      FIXTURE_POSITION_MALFORMED_QUANTITY.quantityDecimal,
    );
    assert.equal(report.entries[0].ledgerQuantityDecimal, "50");
  }
});

test("C2 — a malformed ledger-side quantity is flagged, not thrown", () => {
  const ledgerHoldings: LedgerHoldingSnapshot[] = [
    {
      portfolioId: FIXTURE_PORTFOLIO_ID,
      securityId: "security_fixture_vas",
      quantityDecimal: "1e5",
    },
  ];

  const report = planPositionReconciliation({
    portfolioId: FIXTURE_PORTFOLIO_ID,
    brokerPositions: [FIXTURE_POSITION_MATCHING],
    ledgerHoldings,
  });

  assert.equal(report.hasDrift, true);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]?.status, "unparseable_quantity");
  if (report.entries[0]?.status === "unparseable_quantity") {
    assert.equal(
      report.entries[0].brokerQuantityDecimal,
      FIXTURE_POSITION_MATCHING.quantityDecimal,
    );
    assert.equal(report.entries[0].ledgerQuantityDecimal, "1e5");
  }
});

test("C2 — never throws across a battery of malformed quantity shapes", () => {
  const malformedValues = ["", "N/A", "1e5", "50,000"];

  for (const malformed of malformedValues) {
    assert.doesNotThrow(
      () => {
        const report = planPositionReconciliation({
          portfolioId: FIXTURE_PORTFOLIO_ID,
          brokerPositions: [
            { ...FIXTURE_POSITION_MATCHING, quantityDecimal: malformed },
          ],
          ledgerHoldings: [
            {
              portfolioId: FIXTURE_PORTFOLIO_ID,
              securityId: "security_fixture_vas",
              quantityDecimal: "50",
            },
          ],
        });
        assert.equal(report.entries[0]?.status, "unparseable_quantity");
      },
      `expected no throw for malformed quantity ${JSON.stringify(malformed)}`,
    );
  }
});

test("redacting a raw upstream payload strips every secret-shaped field", () => {
  const redacted = redactBrokerPayload(RAW_UPSTREAM_PAYLOAD_SAMPLE) as Record<
    string,
    unknown
  >;

  assert.equal(redacted.accessToken, "[redacted]");
  assert.equal(redacted.refreshToken, "[redacted]");
  // Non-secret fields survive untouched.
  assert.equal(redacted.status, "ok");
  assert.equal(redacted.accountId, RAW_UPSTREAM_PAYLOAD_SAMPLE.accountId);
});

test("serializing a redacted payload never yields the placeholder secret marker", () => {
  const serialized = redactBrokerPayloadToJson(RAW_UPSTREAM_PAYLOAD_SAMPLE);

  assert.equal(
    serialized.includes("PLACEHOLDER_TOKEN_DO_NOT_USE_REAL_SECRET"),
    false,
  );
  assert.equal(
    serialized.includes("PLACEHOLDER_REFRESH_DO_NOT_USE_REAL_SECRET"),
    false,
  );
  assert.equal(serialized.includes("[redacted]"), true);
});

test("serializing an unredacted error payload verbatim would have leaked the placeholder (control case)", () => {
  // Sanity control: proves the assertions above are testing something real
  // — a naive `JSON.stringify` of the same fixture *does* contain the
  // placeholder secret text, so `redactBrokerPayload` is doing real work.
  const naive = JSON.stringify(RAW_UPSTREAM_PAYLOAD_SAMPLE);
  assert.equal(
    naive.includes("PLACEHOLDER_TOKEN_DO_NOT_USE_REAL_SECRET"),
    true,
  );
});
