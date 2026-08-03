import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  type ImportMappingConfidence,
  type ImportMappingKind,
  type ImportMappingScope,
} from "../db/repositories";
import { getAuthenticatedSqlContext } from "./portfolio-actions";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "./import-preview";
import {
  assessCsvImportUploadStart,
  parseStrictVersionedCsvImport,
} from "../domain/imports";
import type {
  ImportPreviewPortfolio,
  ImportPreviewSecurityCandidate,
} from "../domain/imports/reconciliation";

type ImportActionFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

export type ImportActionSuccess = { ok: true; review: ImportReviewPreview };

async function loadReview(
  client: Parameters<typeof createOwnedImportStagingRepository>[0],
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview | ImportActionFailure> {
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
  const previewPortfolios: ImportPreviewPortfolio[] = portfolios.map(
    (item) => ({
      id: item.id,
      name: item.name,
      homeCurrencyCode: item.homeCurrencyCode,
      historyCompleteFrom: item.historyCompleteFrom,
    }),
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
  return buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: previewPortfolios,
    securityCandidates,
  });
}

async function runtimePlan(): Promise<"free" | "paid"> {
  const { env } = await import("cloudflare:workers");
  return (env as typeof env & { YIELDTOME_WORKERS_PLAN?: unknown })
    .YIELDTOME_WORKERS_PLAN === "paid"
    ? "paid"
    : "free";
}

export async function createImportPreviewAction(
  request: Request,
): Promise<ImportActionSuccess | ImportActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const assessment = assessCsvImportUploadStart({
    workersPlan: await runtimePlan(),
    contentLength: null,
  });
  if (!assessment.ok)
    return {
      ok: false,
      status: assessment.status as 403 | 413,
      message: assessment.message,
    };
  try {
    const form = await request.formData();
    const file = form.get("file");
    const targetPortfolioId = String(
      form.get("targetPortfolioId") ?? "",
    ).trim();
    const supersedesBatchId = String(
      form.get("supersedesBatchId") ?? "",
    ).trim();
    if (!(file instanceof File) || !targetPortfolioId) {
      return {
        ok: false,
        status: 400,
        message: "Choose a CSV file and portfolio.",
      };
    }
    const fileAssessment = assessCsvImportUploadStart({
      workersPlan: await runtimePlan(),
      contentLength: file.size,
    });
    if (!fileAssessment.ok) {
      return {
        ok: false,
        status: fileAssessment.status as 403 | 413,
        message: fileAssessment.message,
      };
    }
    const portfolio = await createOwnedPortfolioRepository(context.client).get(
      context.userId,
      targetPortfolioId,
    );
    if (!portfolio)
      return { ok: false, status: 404, message: "Portfolio not found." };
    const parseResult = await parseStrictVersionedCsvImport(
      new Uint8Array(await file.arrayBuffer()),
      { maxBytes: fileAssessment.maxBytes, maxRows: fileAssessment.maxRows },
    );
    const parserVersion = parseResult.parserVersion;
    const started = await createOwnedImportStagingRepository(
      context.client,
    ).startUpload(context.userId, {
      targetPortfolioId,
      supersedesBatchId: supersedesBatchId || null,
      parserFormat: "strict-versioned-csv",
      parserVersion,
      filename: file.name,
      byteSize: file.size,
      fileSha256: parseResult.fileFingerprint,
    });
    if (!started.ok) {
      return {
        ok: false,
        status: started.reason === "not_found" ? 404 : 409,
        message:
          started.reason === "not_found"
            ? "The import batch to correct was not found."
            : "A corrected import must supersede a reversed batch in the same portfolio.",
      };
    }
    if (!started.reused && started.batch.status === "uploaded") {
      const recorded = await createOwnedImportStagingRepository(
        context.client,
      ).recordParseResult(context.userId, started.batch.id, {
        expectedVersion: started.batch.version,
        parseResult,
      });
      if (!recorded.ok) {
        return {
          ok: false,
          status: 409,
          message: "The uploaded preview changed while it was being prepared.",
        };
      }
    }
    const review = await loadReview(
      context.client,
      context.userId,
      started.batch.id,
    );
    return "ok" in review ? review : { ok: true, review };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Import preview is temporarily unavailable.",
    };
  }
}

export async function saveImportMappingAction(
  batchId: string,
  value: unknown,
): Promise<ImportActionSuccess | ImportActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const input = value as Record<string, unknown>;
  const kind = input?.kind;
  const scope = input?.scope;
  const confidence = input?.confidence;
  const sourceKey =
    typeof input?.sourceKey === "string" ? input.sourceKey.trim() : "";
  const normalizedSourceValue =
    typeof input?.normalizedSourceValue === "string"
      ? input.normalizedSourceValue.trim()
      : "";
  if (
    !["portfolio", "security", "currency", "transaction_type", "fx"].includes(
      String(kind),
    ) ||
    !["row", "batch", "user_future"].includes(String(scope)) ||
    !["user", "exact_identifier", "system_candidate"].includes(
      String(confidence),
    ) ||
    !sourceKey ||
    !normalizedSourceValue
  ) {
    return {
      ok: false,
      status: 400,
      message: "Complete the labelled mapping fields.",
    };
  }
  const staging = createOwnedImportStagingRepository(context.client);
  const batch = await staging.get(context.userId, batchId);
  if (!batch)
    return { ok: false, status: 404, message: "Import batch not found." };
  const expectedVersion = input?.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    expectedVersion !== batch.version
  ) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before mapping.",
    };
  }
  const currentReview = await loadReview(
    context.client,
    context.userId,
    batchId,
  );
  if ("ok" in currentReview) return currentReview;
  if (
    typeof input?.expectedPreviewVersion !== "string" ||
    input.expectedPreviewVersion !== currentReview.previewVersion
  ) {
    return {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before mapping.",
    };
  }
  try {
    await createOwnedImportMappingDecisionRepository(context.client).save(
      context.userId,
      {
        batchId,
        kind: kind as ImportMappingKind,
        scope: scope as ImportMappingScope,
        confidence: confidence as ImportMappingConfidence,
        source: "user",
        sourceKey,
        normalizedSourceValue,
        targetId: typeof input?.targetId === "string" ? input.targetId : null,
        targetValue:
          typeof input?.targetValue === "string" ? input.targetValue : null,
      },
    );
    const review = await loadReview(context.client, context.userId, batchId);
    return "ok" in review ? review : { ok: true, review };
  } catch {
    return {
      ok: false,
      status: 503,
      message: "The mapping service is temporarily unavailable.",
    };
  }
}
