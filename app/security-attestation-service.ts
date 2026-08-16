import { createAuditInsertStatement } from "../db/repositories/audit.ts";
import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createOwnedSecurityAttestationRepository,
  listAttestedSecurityIds,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview.ts";
import type { ImportPreviewSecurityCandidate } from "../domain/imports/reconciliation.ts";
import { normalizeToken } from "../domain/securities/verify-identity.ts";

// Only the statuses `attestSecurityCandidateWithContext` itself ever
// constructs -- deliberately NOT 401/503, which can only ever reach a
// caller via `getAuthenticatedSqlContext()`'s own auth-context-resolution
// failure pass-through at the ACTION layer (`attestSecurityCandidateAction`
// in `app/import-actions.ts`), never from this function's own logic.
// Mirrors `ImportReadyActionFailure` (`app/import-ready-service.ts`), which
// draws the identical line for the identical reason (its 503 slot IS kept
// there, but only because `markImportReadyWithContext` itself legitimately
// returns one internally -- this module never does).
export type SecurityAttestActionFailure = {
  ok: false;
  status: 400 | 404 | 409;
  message: string;
};

export type SecurityAttestActionSuccess = {
  ok: true;
  review: ImportReviewPreview;
};

export type SecurityAttestActionContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

export type SecurityAttestActionOptions = {
  now?: () => string;
};

// A standalone copy of `loadReview` (app/import-actions.ts) for the same
// reason `security-verification-service.ts`, `import-ready-service.ts`, and
// `import-row-exclusion-service.ts` each keep their own: this module must
// stay importable and directly testable against a plain sqlite-backed
// `SqlClient`, never pulling in `./portfolio-actions.ts` (and the
// `next/headers`/D1-binding resolution it carries).
async function loadImportReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | SecurityAttestActionFailure> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows(userId, batchId),
      staging.listIssues(userId, batchId),
      createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
      createOwnedPortfolioRepository(client).list(userId),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
        source_currency_code, security_id
       FROM portfolio_securities
       WHERE user_id = ?
       ORDER BY source_symbol ASC, id ASC`,
        [userId],
      ),
    ],
  );
  const securityCandidates: ImportPreviewSecurityCandidate[] =
    candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    }));
  const attestedSecurityIds = await listAttestedSecurityIds(
    client,
    securityCandidates
      .map((candidate) => candidate.securityId)
      .filter((id): id is string => id !== null),
  );
  return buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates,
    attestedSecurityIds,
  });
}

// Implements IMP-009: an owner-attested manual security resolution, used
// when the market-data provider is unavailable or a ticker is delisted and
// can never be provider-verified, yet its real transaction/dividend history
// must still be recorded (Orchestrator ruling, TASKS.md). Mirrors
// `verifySecurityCandidateWithContext`'s discipline exactly minus the
// provider round trip: the candidate identity is re-derived from the
// server's own current, database-backed preview (never trusted client
// fields), the same version/previewVersion staleness guards apply, and the
// only production write path into the shared `securities` master this
// action uses is `createOwnedSecurityAttestationRepository` (creation-only/
// dedupe/atomicity guarantees documented there). UNLIKE verify, this never
// writes a `security_provider_mappings` row -- see that repository's header
// comment for the provenance-honesty rationale.
export async function attestSecurityCandidateWithContext(
  context: SecurityAttestActionContext,
  batchId: string,
  value: unknown,
  options: SecurityAttestActionOptions = {},
): Promise<SecurityAttestActionSuccess | SecurityAttestActionFailure> {
  const now = options.now ?? (() => new Date().toISOString());
  const input = value as Record<string, unknown>;
  const portfolioId =
    typeof input?.portfolioId === "string" ? input.portfolioId.trim() : "";
  const sourceSymbol =
    typeof input?.sourceSymbol === "string" ? input.sourceSymbol.trim() : "";
  const sourceExchangeAlias =
    typeof input?.sourceExchangeAlias === "string" &&
    input.sourceExchangeAlias.trim().length > 0
      ? input.sourceExchangeAlias.trim()
      : null;
  // Upper-normalized exactly like IMP-004B's `evaluateSecurityIdentityCandidates`
  // normalizes the provider's currency before publication (`normalizeToken`,
  // `domain/securities/verify-identity.ts`) -- a lower-case value must not
  // pass this action's own eligibility check by case alone and then hit the
  // `securities_primary_currency_code_currencies_code_fk` constraint raw
  // inside the repository's write.
  const sourceCurrencyCode =
    typeof input?.sourceCurrencyCode === "string"
      ? normalizeToken(input.sourceCurrencyCode)
      : "";
  // Owner supplies/confirms a display name; defaults to the symbol when
  // omitted or blank, per the Orchestrator ruling. Bounded/validated the
  // same way any owner-typed free-text field in this app is: a length cap
  // (`securities.canonical_name` has no DB-level CHECK constraint on
  // length, so this is the only guard) and a reject on control characters
  // (a name is a single display line, never carrying tabs/newlines/other
  // C0 control bytes or DEL).
  const displayNameInput =
    typeof input?.displayName === "string" ? input.displayName.trim() : "";
  const MAX_DISPLAY_NAME_LENGTH = 120;
  // Rejects C0 control bytes (0x00-0x1F) and DEL (0x7F) in an owner-typed
  // display name -- a name is a single display line, never carrying
  // tabs/newlines/other control bytes.
  const CONTROL_CHARACTER_PATTERN = new RegExp("[\\x00-\\x1f\\x7f]");
  if (
    displayNameInput.length > MAX_DISPLAY_NAME_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(displayNameInput)
  ) {
    return {
      ok: false,
      status: 400,
      message:
        "The display name must be 120 characters or fewer and contain no control characters.",
    };
  }
  const expectedVersion = input?.expectedVersion;
  const expectedPreviewVersion = input?.expectedPreviewVersion;
  if (
    !portfolioId ||
    !sourceSymbol ||
    !sourceCurrencyCode ||
    typeof expectedVersion !== "number" ||
    typeof expectedPreviewVersion !== "string"
  ) {
    return {
      ok: false,
      status: 400,
      message: "Complete the labelled attestation fields.",
    };
  }
  const displayName =
    displayNameInput.length > 0 ? displayNameInput : sourceSymbol;

  // Validate the normalized currency exists BEFORE any write is attempted,
  // so an unknown code fails with an honest, specific message here rather
  // than surfacing as the repository's generic conflict once its INSERT
  // hits the `currencies` FK deep inside a swallowed `catch` (see
  // `attestAndLink`'s "fall through to the unconditional re-read" comments
  // -- that catch cannot distinguish an FK violation from a genuine
  // concurrent-writer race, so it must never be the only signal for this).
  const currencyRow = await context.client.get<{ code: string }>(
    `SELECT code FROM currencies WHERE code = ? LIMIT 1`,
    [sourceCurrencyCode],
  );
  if (!currencyRow) {
    return {
      ok: false,
      status: 400,
      message: `"${sourceCurrencyCode}" is not a recognized currency code.`,
    };
  }

  const staging = createOwnedImportStagingRepository(context.client);
  const batch = await staging.get(context.userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  if (batch.version !== expectedVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before attesting.",
    };
  }

  const review = await loadImportReview(
    context.client,
    context.userId,
    batchId,
  );
  if ("ok" in review) return review;
  if (review.previewVersion !== expectedPreviewVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before attesting.",
    };
  }

  const portfolio = await createOwnedPortfolioRepository(context.client).get(
    context.userId,
    portfolioId,
  );
  if (!portfolio)
    return { ok: false, status: 404, message: "Portfolio not found." };

  // Re-derive the request server-side from the current, database-backed
  // preview, exactly like `verifySecurityCandidateWithContext`: only a
  // symbol the server itself currently reports as an unresolved candidate
  // is eligible for attestation.
  const candidateStillUnresolved = review.preview.unresolvedCandidates.some(
    (candidate) =>
      candidate.portfolioId === portfolioId &&
      candidate.sourceSymbol === sourceSymbol &&
      (candidate.sourceExchangeAlias ?? null) === sourceExchangeAlias &&
      candidate.sourceCurrencyCode === sourceCurrencyCode &&
      candidate.securityId === null,
  );
  if (!candidateStillUnresolved) {
    return {
      ok: false,
      status: 409,
      message:
        "This symbol is no longer an unresolved candidate. Reload the preview.",
    };
  }

  const repository = createOwnedSecurityAttestationRepository(
    context.client,
    now,
  );
  const link = await repository.attestAndLink(
    context.userId,
    { symbol: sourceSymbol, currencyCode: sourceCurrencyCode, displayName },
    { portfolioId, sourceSymbol, sourceExchangeAlias, sourceCurrencyCode },
  );
  if (!link.ok) {
    if (link.reason === "currency_mismatch") {
      return {
        ok: false,
        status: 409,
        message:
          "An existing security for this identity has a different currency than what you entered.",
      };
    }
    return {
      ok: false,
      status: 409,
      message:
        "This security could not be linked; it may already be linked to another symbol in this portfolio.",
    };
  }

  // Owner-attributed audit event naming the batch (`target_id`), the
  // candidate identity, and the created/linked security id (Orchestrator
  // ruling) -- the durable historical record of the attestation decision,
  // distinct from (and in addition to) the queryable absence-of-mapping
  // signal `listAttestedSecurityIds` reads at render time. Like every audit
  // event in this app, `createAuditInsertStatement` passes this metadata
  // through `redactMetadata` before storing it: `securityId`/
  // `portfolioSecurityId`/`portfolioId` are redacted at rest (matching
  // IMP-008's identical precedent), while the candidate identity fields
  // survive -- `portfolio_securities.security_id` remains the durable,
  // unredacted, always-current answer to "which security". Best-effort: an
  // audit write failure must not undo an attestation that already
  // committed.
  try {
    const auditStatement = createAuditInsertStatement({
      actorUserId: context.userId,
      targetOwnerUserId: context.userId,
      action: "import.security.attest",
      targetType: "import_batch",
      targetId: batchId,
      requestId: context.requestId,
      result: "success",
      metadata: {
        portfolioId,
        sourceSymbol,
        sourceExchangeAlias,
        sourceCurrencyCode,
        displayName,
        securityId: link.securityId,
        portfolioSecurityId: link.portfolioSecurityId,
        created: link.created,
      },
    });
    await context.client.run(auditStatement.sql, auditStatement.params);
  } catch {
    // See comment above -- never fails the already-committed attestation.
  }

  const refreshed = await loadImportReview(
    context.client,
    context.userId,
    batchId,
  );
  return "ok" in refreshed ? refreshed : { ok: true, review: refreshed };
}
