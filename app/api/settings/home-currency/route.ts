import { changeHomeCurrencyAction } from "../../../portfolio-actions";

export async function PATCH(request: Request): Promise<Response> {
  const result = await changeHomeCurrencyAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
