// IMP-010A: pure, DB/auth-free request-body parsing for the price-CSV
// upload actions (`price-upload-actions.ts`) -- split into its own module
// so `tests/imp-010a.test.ts` can import and directly unit-test this logic
// under Node's `--experimental-strip-types` test runner, which CANNOT
// resolve `next/headers` (a Next.js-only virtual export
// `price-upload-actions.ts` pulls in transitively via its STATIC top-level
// import of `./portfolio-actions.ts` -- confirmed: importing
// `price-upload-actions.ts` directly throws `ERR_MODULE_NOT_FOUND` for
// `next/headers` under the plain Node test runner). Mirrors this
// codebase's established split pattern (see
// `app/price-history-coverage-format.ts`'s header comment for the
// identical DB/auth-free-module-for-testability rationale, applied there
// to a different surface).

export type UploadRequestFailure = Readonly<{
  ok: false;
  status: 400 | 413;
  message: string;
}>;

// IMP-010A: a single owner-uploaded price CSV is one security's full
// history -- much smaller than the ledger CSV's multi-portfolio-transaction
// scope, so a flat 8 MiB JSON-request-body ceiling (well above
// `price-csv.ts`'s own 2 MiB file cap, leaving room for the browser's
// already-parsed row JSON, which is larger per byte than the raw CSV it
// came from) is enough without a runtime-plan lookup the way
// `assessCsvImportUploadStart` needs. The server never sees the original
// file's byte size directly (that cap is enforced client-side, before
// parsing, by the SAME `parsePriceCsv`/`parsePriceBackupCsv` limits the
// server used to enforce -- see `price-upload-service.ts`'s IMP-010A header
// note); the server-side re-checks that still apply are this request-body
// ceiling AND the ROW COUNT budget, enforced inside
// `validateUploadedPriceCsvPayload`/`validateUploadedPriceBackupPayload`
// (`domain/market-data/`) once the body is parsed. Documented in
// `docs/CSV_IMPORT_SPEC.md`.
export const MAX_UPLOAD_REQUEST_BYTES = 8 * 1024 * 1024;
// Review B1 fix (BLOCKING, 2026-08-25): the reviewer measured IMP-010A's
// JSON row payload at ~2.30x the byte size of the equivalent raw backup
// CSV (`domain/market-data/price-backup-csv.ts`'s `formatPriceBackupCsv`
// output, field-name overhead repeated per row) -- the UNCHANGED 24 MiB
// ceiling from before this task silently rejected any backup export over
// ~10.35 MiB with an opaque 413, a genuine disaster-recovery regression
// (the export/backup flow's whole purpose). 64 MiB covers the 20 MiB
// client-side file cap (`DEFAULT_PRICE_BACKUP_LIMITS.maxBytes`) at the
// measured expansion factor (20 * 2.30 = 46 MiB) with real headroom, and
// stays well under Cloudflare's ~100 MB platform request-body limit;
// `db/repositories/price-uploads.ts`'s existing D1 write chunking
// (`PRICE_UPLOAD_WRITE_LIMITS`) already handles turning a large accepted
// payload into bounded D1 `batch()` calls, so no request-level chunking is
// needed to stay under that limit.
export const MAX_BACKUP_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 255;

/**
 * Reads the browser-parsed upload payload as JSON -- IMP-010A replaces the
 * old `multipart/form-data` `file` field (raw CSV bytes) with structured
 * row JSON the client already parsed/normalized. `body` stays `unknown`
 * field-by-field past this point: every field is untrusted input per
 * AGENTS.md, re-validated by `price-upload-service.ts`'s
 * `validateUploadedPriceCsvPayload`/`validateUploadedPriceBackupPayload`
 * (via `domain/market-data/`), never trusted just because it parsed as
 * JSON.
 *
 * Review B2 fix (BLOCKING, 2026-08-25): the size check previously trusted
 * the `content-length` HEADER alone -- attacker-controlled, and simply
 * ABSENT on a `Transfer-Encoding: chunked` request, so a chunked body of
 * any size sailed straight past that check into `request.json()`. This now
 * reads the body as text FIRST and measures its ACTUAL byte length (via
 * `TextEncoder`, the same Web-standard API `domain/market-data/
 * text-encoding.ts` already uses -- no Node-only `Buffer`) before ever
 * calling `JSON.parse`, so the real received size is what gets checked,
 * regardless of what headers claimed or whether a header was even present.
 * A `content-length` pre-check still runs FIRST as a cheap fast-reject when
 * an honest client sends one (skips reading a body already known to be too
 * large), but it is never the ONLY gate.
 */
export async function readJsonBody(
  request: Request,
  ceiling: number,
): Promise<{ ok: true; body: Record<string, unknown> } | UploadRequestFailure> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > ceiling) {
    return { ok: false, status: 413, message: "The upload is too large." };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, message: "The upload could not be read." };
  }
  if (new TextEncoder().encode(text).length > ceiling) {
    return { ok: false, status: 413, message: "The upload is too large." };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: "The upload could not be read." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, message: "The upload could not be read." };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

export function settingsFromBody(body: Record<string, unknown>) {
  const exchangeAlias =
    typeof body.exchangeAlias === "string" ? body.exchangeAlias.trim() : "";
  const currencyCode =
    typeof body.currencyCode === "string" ? body.currencyCode.trim() : "";
  return {
    exchangeAlias: exchangeAlias || "ASX",
    currencyCode: currencyCode || "AUD",
  };
}

export function filenameFromBody(body: Record<string, unknown>): string {
  const filename =
    typeof body.filename === "string" ? body.filename.trim() : "";
  return filename.length > 0
    ? filename.slice(0, MAX_FILENAME_LENGTH)
    : "upload.csv";
}
