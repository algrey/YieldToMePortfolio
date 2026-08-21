import { changeDailyCaptureSourceAction } from "../../../portfolio-actions";
import { rejectCrossSiteMutation } from "../../../mutation-request";

export async function PATCH(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  const result = await changeDailyCaptureSourceAction(
    await request.json().catch(() => null),
  );
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
