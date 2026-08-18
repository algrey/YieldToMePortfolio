import { createAuditInsertStatement } from "../db/repositories/audit.ts";
import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  listAttestedSecurityIds,
  listAutoCreatedSecurityIds,
  listNameEditableSecurityIds,
  sanitizeCanonicalName,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview.ts";
import type { ImportPreviewSecurityCandidate } from "../domain/imports/reconciliation.ts";
import { SHARESIGHT_SYNC_PARSER_FORMAT } from "../domain/sharesight-sync/index.ts";

// BRK-009C: edits the ONE owner-fillable display field the "Review
// securities" table exposes -- an auto-created security's
// `canonical_name`, NEVER `security_id` (identity). Exchange and currency
// both have NO edit path at all (BRK-009C review round, finding B2): a
// Sharesight row's `market_code`/`currency_code` are both `requiredString`
// gated at the parse boundary (`domain/sharesight/parse.ts`), so neither
// can ever be missing on a `sharesight_sync` row -- building an edit
// control for either would be dead UI. See `docs/CSV_IMPORT_SPEC.md`'s
// "Review securities" section for the full inspection finding.
export type ImportSecurityMetadataActionContext = {
  client: SqlClient;
  userId: string;
  requestId: string;
};

export type ImportSecurityMetadataActionFailure = {
  ok: false;
  status: 400 | 404 | 409;
  message: string;
};

export type ImportSecurityMetadataActionSuccess = {
  ok: true;
  review: ImportReviewPreview;
};

export type ImportSecurityMetadataActionOptions = { now?: () => string };

// A standalone copy of `loadReview` (app/import-actions.ts), for the same
// testability reason every other mutation service in this app keeps its
// own: stays importable and directly exercisable against a plain
// sqlite-backed `SqlClient`, never pulling in `./portfolio-actions.ts`.
async function loadImportReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | ImportSecurityMetadataActionFailure> {
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
        `SELECT ps.id, ps.portfolio_id, ps.source_symbol, ps.source_exchange_alias,
        ps.source_currency_code, ps.security_id, s.canonical_name
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       WHERE ps.user_id = ?
       ORDER BY ps.source_symbol ASC, ps.id ASC`,
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
  const linkedSecurityIds = securityCandidates
    .map((candidate) => candidate.securityId)
    .filter((id): id is string => id !== null);
  const securityNames = new Map<string, string>();
  for (const row of candidateRows) {
    if (row.security_id !== null && row.canonical_name !== null) {
      securityNames.set(String(row.security_id), String(row.canonical_name));
    }
  }
  const [attestedSecurityIds, autoCreatedSecurityIds, nameEditableSecurityIds] =
    await Promise.all([
      listAttestedSecurityIds(client, linkedSecurityIds),
      listAutoCreatedSecurityIds(client, linkedSecurityIds),
      listNameEditableSecurityIds(client, userId, linkedSecurityIds),
    ]);
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
    securityNames,
    autoCreatedSecurityIds,
    nameEditableSecurityIds,
  });
}

export async function updateImportSecurityMetadataWithContext(
  context: ImportSecurityMetadataActionContext,
  batchId: string,
  value: unknown,
  options: ImportSecurityMetadataActionOptions = {},
): Promise<
  ImportSecurityMetadataActionSuccess | ImportSecurityMetadataActionFailure
> {
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
  const sourceCurrencyCode =
    typeof input?.sourceCurrencyCode === "string"
      ? input.sourceCurrencyCode.trim()
      : "";
  const securityId =
    typeof input?.securityId === "string" && input.securityId.trim().length > 0
      ? input.securityId.trim()
      : null;
  const nameInput =
    typeof input?.name === "string" && input.name.trim().length > 0
      ? input.name
      : undefined;
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
      message: "Complete the labelled security identity fields.",
    };
  }
  if (nameInput === undefined) {
    return {
      ok: false,
      status: 400,
      message: "Provide a name to update.",
    };
  }

  const staging = createOwnedImportStagingRepository(context.client);
  const batch = await staging.get(context.userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  if (batch.parserFormat !== SHARESIGHT_SYNC_PARSER_FORMAT) {
    return {
      ok: false,
      status: 400,
      message:
        "Editing security metadata is available for Sharesight sync imports only.",
    };
  }
  // BRK-009C review round (B2 follow-up): the request's own `portfolioId`
  // is never trusted as the authority for WHICH portfolio this edit targets
  // -- it must agree with the batch's own server-recorded target portfolio,
  // exactly like every write this batch's resolution/accept pipeline
  // performs. A mismatch is a client bug/tamper attempt, not a legitimate
  // "different portfolio" request (a batch has exactly one target
  // portfolio for its whole lifetime).
  if (portfolioId !== batch.targetPortfolioId) {
    return {
      ok: false,
      status: 400,
      message: "This security does not belong to this batch's portfolio.",
    };
  }
  if (batch.version !== expectedVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before editing.",
    };
  }

  const review = await loadImportReview(
    context.client,
    context.userId,
    batchId,
  );
  if ("ok" in review) return review;
  // F2 (BRK-009C review round): NOT a previewVersion staleness guard in the
  // usual sense -- `canonical_name` is deliberately excluded from
  // `previewVersion`'s hash (`domain/imports/review.ts`'s canonical
  // evidence never includes it; it is display metadata, not a fact that
  // changes what would commit). A name edit therefore never itself changes
  // `previewVersion`, so this comparison only ever catches a GENUINE
  // staleness on hashed evidence (rows/candidates/issues changed under the
  // owner) -- never a false conflict between two concurrent name edits
  // against the same still-current preview, which simply last-write-win
  // instead. Safe because `accept` re-derives resolution state fresh and
  // never reads `canonical_name` as identity evidence.
  if (review.previewVersion !== expectedPreviewVersion) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before editing.",
    };
  }

  // Re-derive batch membership server-side, exactly like every other
  // mutation on this preview: the client's identity tuple must match one of
  // the DISTINCT securities THIS batch's own rows currently reference (the
  // same summary the table itself renders from) -- never trusted alone.
  // F4 (BRK-009C review round): currency compared case-insensitively here
  // too, matching `security-resolution.ts`'s own `normalizeToken`/`UPPER()`
  // identity convention throughout.
  const normalizedKeyPart = (text: string) => text.trim().toLowerCase();
  const entry = review.securities.find(
    (item) =>
      normalizedKeyPart(item.sourceSymbol) ===
        normalizedKeyPart(sourceSymbol) &&
      normalizedKeyPart(item.sourceExchangeAlias ?? "") ===
        normalizedKeyPart(sourceExchangeAlias ?? "") &&
      normalizedKeyPart(item.sourceCurrencyCode) ===
        normalizedKeyPart(sourceCurrencyCode),
  );
  if (!entry) {
    return {
      ok: false,
      status: 404,
      message: "This security is not part of this batch's current preview.",
    };
  }

  // Ruling: only an auto-CREATED, sole-owned, not-yet-provider-verified
  // security's fallback name is editable here -- `entry.nameEditable` is
  // this UX-convenience precondition (see
  // `domain/imports/security-summary.ts`'s doc comment); the real
  // enforcement is the guarded `UPDATE ... WHERE` below, which
  // re-establishes the identical three predicates AT THE SQL LEVEL so a
  // service-side derivation bug or a stale read can never rename a
  // security the WHERE clause itself would reject.
  if (!entry.nameEditable || entry.securityId === null) {
    return {
      ok: false,
      status: 409,
      message:
        "This security is shared or provider-verified; its name can no longer be edited here.",
    };
  }
  if (securityId !== null && securityId !== entry.securityId) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before editing.",
    };
  }

  const canonicalName = sanitizeCanonicalName(nameInput);
  const nowIso = now();
  // B1 (BLOCKING, BRK-009C review round): the SQL WHERE clause is the
  // sole authority, not `entry.nameEditable` above (a read that can be
  // milliseconds stale). Three predicates, ALL required:
  //   (a) this security's canonical `ticker` identifier still carries
  //       `source = 'sharesight'` (BRK-009B auto-created it, never a
  //       provider/owner-attested identity);
  //   (b) no ACTIVE VERIFIED `security_provider_mappings` row exists for
  //       it (a later provider verification makes the provider's own
  //       naming authoritative -- never silently overwritten here);
  //   (c) no OTHER user's `portfolio_securities` links to it (a security
  //       any other owner also holds is shared canon, not privately
  //       renameable from one owner's review screen).
  // Zero rows updated -> an honest 409, never a silent no-op.
  const result = await context.client.run(
    `UPDATE securities
        SET canonical_name = ?, updated_at = ?
      WHERE id = ?
        AND EXISTS (
              SELECT 1 FROM security_identifiers si
               WHERE si.security_id = securities.id AND si.scheme = 'ticker'
                 AND si.source = 'sharesight' AND si.valid_to IS NULL
            )
        AND NOT EXISTS (
              SELECT 1 FROM security_provider_mappings spm
               WHERE spm.security_id = securities.id
                 AND spm.valid_to IS NULL AND spm.status = 'verified'
            )
        AND NOT EXISTS (
              SELECT 1 FROM portfolio_securities ps
               WHERE ps.security_id = securities.id AND ps.user_id <> ?
            )`,
    [canonicalName, nowIso, entry.securityId, context.userId],
  );
  if (result.changes === 0) {
    return {
      ok: false,
      status: 409,
      message:
        "This security is shared or provider-verified; its name can no longer be edited here.",
    };
  }

  // Owner-attributed audit event -- best-effort, matching every other
  // mutation service's identical precedent (an audit write failure must
  // never undo an already-committed edit).
  try {
    const auditStatement = createAuditInsertStatement({
      actorUserId: context.userId,
      targetOwnerUserId: context.userId,
      action: "import.security.update_metadata",
      targetType: "import_batch",
      targetId: batchId,
      requestId: context.requestId,
      result: "success",
      metadata: {
        portfolioId,
        sourceSymbol,
        sourceExchangeAlias,
        sourceCurrencyCode,
        securityId: entry.securityId,
        canonicalName,
      },
    });
    await context.client.run(auditStatement.sql, auditStatement.params);
  } catch {
    // See comment above -- never fails the already-committed edit.
  }

  const refreshed = await loadImportReview(
    context.client,
    context.userId,
    batchId,
  );
  return "ok" in refreshed ? refreshed : { ok: true, review: refreshed };
}
