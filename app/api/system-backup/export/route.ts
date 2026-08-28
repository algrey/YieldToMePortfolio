import {
  exportSystemBackupAction,
  exportSystemBackupCoreAction,
} from "../../../system-backup-actions.ts";
import { exportPriceHistoryPageAction } from "../../../price-upload-actions.ts";

// EXP-002: a plain authenticated GET download (no mutation, no CSRF gate),
// mirroring `app/api/portfolio-bundle/[portfolioId]/export/route.ts`'s
// EXP-001 precedent -- ONE JSON attachment covering every portfolio plus
// account-level data.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  if (mode === "prices") {
    const rawOffset = url.searchParams.get("offset") ?? "0";
    const offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 130_000) {
      return Response.json(
        { ok: false, message: "The export page cursor is invalid." },
        { status: 400, headers: { "cache-control": "private, no-store" } },
      );
    }
    const page = await exportPriceHistoryPageAction(offset);
    return Response.json(page, {
      status: page.ok ? 200 : page.status,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const result =
    mode === "core"
      ? await exportSystemBackupCoreAction()
      : await exportSystemBackupAction();
  if (!result.ok) {
    return Response.json(result, {
      status: result.status,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const dateStamp = result.backup.exportedAt.slice(0, 10);
  const filename = `yieldtome-system-backup-${dateStamp}.json`;
  return new Response(JSON.stringify(result.backup), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
