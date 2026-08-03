import {
  listManualOverrideAction,
  removeManualOverrideAction,
  saveManualOverrideAction,
} from "../../../market-data-actions";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const result = await listManualOverrideAction(
    url.searchParams.get("portfolioId") ?? "",
    url.searchParams.get("targetKey") ?? undefined,
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const result = await saveManualOverrideAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 201 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const input = (await request.json().catch(() => null)) as {
    overrideId?: unknown;
  } | null;
  const result = await removeManualOverrideAction(
    typeof input?.overrideId === "string" ? input.overrideId : "",
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
