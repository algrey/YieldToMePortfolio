import {
  requestAccountLifecycleAction,
  type AccountLifecycleActionType,
} from "../../../account-lifecycle-actions.ts";
import { rejectCrossSiteMutation } from "../../../mutation-request.ts";

function lifecycleType(value: unknown): AccountLifecycleActionType | null {
  return value === "disable" || value === "deletion" || value === "export"
    ? value
    : null;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    if (new TextEncoder().encode(text).byteLength > 4096)
      throw new Error("body_too_large");
    if (text.length === 0) return null;
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteMutation(request);
  if (rejected) return rejected;
  let body: {
    type?: unknown;
    idempotencyKey?: unknown;
    includeExport?: unknown;
  } | null;
  try {
    body = (await readBoundedJson(request)) as typeof body;
  } catch (error) {
    return Response.json(
      {
        ok: false,
        message:
          error instanceof Error && error.message === "body_too_large"
            ? "Lifecycle request is too large."
            : "Lifecycle request is invalid.",
      },
      {
        status:
          error instanceof Error && error.message === "body_too_large"
            ? 413
            : 400,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
  const type = lifecycleType(body?.type);
  if (!type) {
    return Response.json(
      { ok: false, message: "A lifecycle request type is required." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const result = await requestAccountLifecycleAction(type, body);
  return Response.json(result, {
    status: result.ok ? 200 : result.status,
    headers: { "cache-control": "private, no-store" },
  });
}
