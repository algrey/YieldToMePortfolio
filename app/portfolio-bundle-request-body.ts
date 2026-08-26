// EXP-001: request-body parsing for the portfolio-bundle import actions,
// split out DB/auth-free (mirrors `app/price-upload-request-body.ts`'s
// header comment on why this split exists -- testability under the plain
// Node test runner, which cannot resolve `next/headers`).
import { MAX_BUNDLE_REQUEST_BYTES } from "../domain/exports/portfolio-bundle.ts";

export type BundleRequestFailure = Readonly<{
  ok: false;
  status: 400 | 413;
  message: string;
}>;

const MAX_FILENAME_LENGTH = 255;

/** Mirrors `price-upload-request-body.ts`'s `readJsonBody` byte-accounting
 * discipline exactly (measures the ACTUAL received body, never trusts
 * `content-length` alone) -- see that module's header comment. Returns the
 * raw text alongside the parsed body so the caller can record the exact
 * byte length on the `import_batches` row without re-serializing. */
export async function readBundleRequestBody(
  request: Request,
): Promise<
  | { ok: true; body: Record<string, unknown>; byteLength: number }
  | BundleRequestFailure
> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BUNDLE_REQUEST_BYTES
  ) {
    return { ok: false, status: 413, message: "The bundle file is too large." };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      status: 400,
      message: "The bundle file could not be read.",
    };
  }
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_BUNDLE_REQUEST_BYTES) {
    return { ok: false, status: 413, message: "The bundle file is too large." };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: 400,
      message: "The bundle file could not be read.",
    };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      message: "The bundle file could not be read.",
    };
  }
  return { ok: true, body: body as Record<string, unknown>, byteLength };
}

export function bundleFilenameFromBody(body: Record<string, unknown>): string {
  const filename =
    typeof body.filename === "string" ? body.filename.trim() : "";
  return filename.length > 0
    ? filename.slice(0, MAX_FILENAME_LENGTH)
    : "portfolio-bundle.json";
}

export function bundleFromBody(body: Record<string, unknown>): unknown {
  return body.bundle;
}
