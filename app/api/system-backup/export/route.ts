import { exportSystemBackupAction } from "../../../system-backup-actions.ts";

// EXP-002: a plain authenticated GET download (no mutation, no CSRF gate),
// mirroring `app/api/portfolio-bundle/[portfolioId]/export/route.ts`'s
// EXP-001 precedent -- ONE JSON attachment covering every portfolio plus
// account-level data.
export async function GET(): Promise<Response> {
  const result = await exportSystemBackupAction();
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
