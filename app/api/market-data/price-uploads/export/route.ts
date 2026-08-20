import { exportPriceHistoryAction } from "../../../../price-upload-actions.ts";

// MKT-008: backup export download -- a plain authenticated GET (no
// mutation, so no CSRF gate; matches the read-only precedent elsewhere in
// this API surface). Streams the owner's full user-scoped price history as
// one `text/csv` attachment; `content-disposition` names the file so a
// browser download keeps a sensible extension.
export async function GET(): Promise<Response> {
  const result = await exportPriceHistoryAction();
  if (!result.ok) {
    return Response.json(result, {
      status: result.status,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const filename = `yieldtome-price-history-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(result.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
