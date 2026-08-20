import { listPriceUploadsAction } from "../../../price-upload-actions.ts";

export async function GET(): Promise<Response> {
  const result = await listPriceUploadsAction();
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
