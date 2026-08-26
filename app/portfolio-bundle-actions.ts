// EXP-001: Request-handling actions for the single-portfolio export/import
// bundle, mirroring `app/price-upload-actions.ts`'s split (this module owns
// `getAuthenticatedSqlContext`/`next/headers`-dependent wiring; the DB-free
// validation/orchestration lives in `app/portfolio-bundle-service.ts` and
// `domain/exports/portfolio-bundle.ts` so they stay testable under the
// plain Node test runner).
import { getAuthenticatedSqlContext } from "./portfolio-actions.ts";
import {
  bundleFilenameFromBody,
  bundleFromBody,
  readBundleRequestBody,
} from "./portfolio-bundle-request-body.ts";
import {
  commitPortfolioBundleImport,
  exportPortfolioBundle,
  previewPortfolioBundleImport,
  type BundleCommitResult,
  type BundlePreview,
} from "./portfolio-bundle-service.ts";
import type { PortfolioBundleV1 } from "../domain/exports/portfolio-bundle.ts";

type ActionFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  message: string;
};

export async function exportPortfolioBundleAction(
  portfolioId: string,
): Promise<{ ok: true; bundle: PortfolioBundleV1 } | ActionFailure> {
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) return context;
  return exportPortfolioBundle(
    {
      client: context.client,
      userId: context.userId,
      requestId: context.requestId,
    },
    portfolioId,
  );
}

export async function previewPortfolioBundleImportAction(
  request: Request,
): Promise<{ ok: true; preview: BundlePreview } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readBundleRequestBody(request);
  if (!read.ok) return read;
  return previewPortfolioBundleImport(
    {
      client: context.client,
      userId: context.userId,
      requestId: context.requestId,
    },
    bundleFromBody(read.body),
  );
}

export async function commitPortfolioBundleImportAction(
  request: Request,
): Promise<{ ok: true; result: BundleCommitResult } | ActionFailure> {
  const context = await getAuthenticatedSqlContext();
  if (!context.ok) return context;
  const read = await readBundleRequestBody(request);
  if (!read.ok) return read;
  return commitPortfolioBundleImport(
    {
      client: context.client,
      userId: context.userId,
      requestId: context.requestId,
    },
    bundleFromBody(read.body),
    bundleFilenameFromBody(read.body),
    read.byteLength,
  );
}
