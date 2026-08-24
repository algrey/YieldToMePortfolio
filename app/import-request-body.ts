// IMP-010B: pure, DB/auth-free request-body parsing for the ledger CSV
// import preview action (`import-actions.ts`) -- split out for the same
// testability reason as `price-upload-request-body.ts` (see that module's
// header comment): this file has no `next/headers`/D1-binding import, so
// `tests/imp-010b.test.ts` can import and directly unit-test it under
// Node's `--experimental-strip-types` test runner.
//
// `readJsonBody`/`UploadRequestFailure` are IMP-010A's own generic,
// domain-free "read an untrusted JSON body, honestly measuring its real
// byte length rather than trusting a `content-length` header" helper --
// reused HERE unchanged rather than forked, per AGENTS.md ("shared
// modules, never a fork"). Its actual size ceiling for THIS upload shape
// is `MAX_IMPORT_UPLOAD_REQUEST_BYTES` below, not price-upload's own
// constants.
export {
  readJsonBody,
  type UploadRequestFailure,
} from "./price-upload-request-body.ts";

// IMP-010B: the 17-column ledger CSV's browser-parsed upload payload is a
// JSON ARRAY of plain string arrays (`rows: string[][]`, one array per
// physical CSV row, header included) rather than a named-field object per
// row -- much cheaper per byte than IMP-010A's price-backup JSON shape.
// Measured (see tests/imp-010b.test.ts's expansion-factor drill): at the
// row/byte density that saturates BOTH `DEFAULT_IMPORT_LIMITS.maxBytes`
// (10 MiB) and `.maxRows` (100,000) simultaneously -- the true worst case,
// since neither bound alone determines it -- the JSON payload measures
// ~13.16 MiB (~1.34x the equivalent CSV bytes; per-row JSON quoting/comma
// overhead is roughly CONSTANT regardless of field content length, so
// SHORT fields produce a higher per-row RATIO but can never reach the full
// 10 MiB total while also staying under the 100,000-row cap -- see the
// test for the arithmetic). 24 MiB covers that ~13.16 MiB honest worst
// case with real headroom (~1.8x), and stays well under Cloudflare's
// ~100 MB platform request-body limit; `db/repositories/import-staging.ts`'s
// existing single atomic `client.batch()` write (bounded by the SAME
// `maxRows` cap) is unaffected by this request-level ceiling.
export const MAX_IMPORT_UPLOAD_REQUEST_BYTES = 24 * 1024 * 1024;

const MAX_FILENAME_LENGTH = 255;
const FILE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function filenameFromImportBody(body: Record<string, unknown>): string {
  const filename =
    typeof body.filename === "string" ? body.filename.trim() : "";
  return filename.length > 0
    ? filename.slice(0, MAX_FILENAME_LENGTH)
    : "upload.csv";
}

export function targetPortfolioIdFromImportBody(
  body: Record<string, unknown>,
): string {
  return typeof body.targetPortfolioId === "string"
    ? body.targetPortfolioId.trim()
    : "";
}

export function supersedesBatchIdFromImportBody(
  body: Record<string, unknown>,
): string {
  return typeof body.supersedesBatchId === "string"
    ? body.supersedesBatchId.trim()
    : "";
}

export type ImportUploadFileMetadata = Readonly<{
  filename: string;
  // IMP-010B critical investigation #1: this path's `import_batches` table
  // already keyed idempotent re-upload dedupe/resume on `file_sha256` (a
  // hash of the RAW FILE BYTES -- see `db/repositories/import-staging.ts`'s
  // `ON CONFLICT(user_id, file_sha256, parser_format, parser_version)`).
  // The server no longer receives those raw bytes (that is the whole point
  // of this task -- text decode/split now runs client-side), so it cannot
  // recompute this hash itself; the browser computes it (same SHA-256
  // algorithm, `crypto.subtle.digest` over the ORIGINAL `File`, before any
  // parsing) and this field carries it through UNVERIFIED. This hash is a
  // NATURAL-KEY DEDUP HINT ONLY, scoped per-`user_id` by the same unique
  // constraint -- it is never a financial-correctness or cross-user
  // security boundary. A client that lies about it can, at worst, cause
  // ITS OWN upload to wrongly dedupe against (or fail to dedupe against) a
  // PRIOR upload from the SAME account; every row is independently
  // re-derived by the SERVER's `classifyImportRows` regardless of what
  // this hash claims, so a forged hash can never cause unvalidated content
  // to reach staging. See CSV_IMPORT_SPEC.md's IMP-010B section for the
  // full ruling.
  fileSha256: string;
  // IMP-010B review round (fold 1, corrects a false claim in the original
  // comment): this field BECOMES a bare client-CLAIMED number here, unlike
  // its pre-IMP-010B history. Before this task, the server read `file.size`
  // straight off the real `File`/`Blob` object inside a `multipart/
  // form-data` upload -- a property intrinsic to the actual bytes the
  // browser transmitted, not an independently declarable claim disconnected
  // from the data. Now it arrives as an ordinary JSON number with no tie to
  // the `rows` payload's real content, so a hostile (or buggy) client can
  // set it to anything. It is bounded above by `MAX_IMPORT_UPLOAD_REQUEST_BYTES`
  // (any larger claim is rejected outright) but is otherwise DISPLAY/AUDIT-ONLY
  // (`import_batches.byte_size`) -- never used for any security-critical
  // enforcement; the request-body byte ceiling and `classifyImportRows`'s
  // own row-count/field-length/byte-volume bounds are independent of
  // whatever this field claims.
  byteSize: number;
}>;

/** Validates the browser-supplied file identity fields -- `unknown` because
 * they arrived as untrusted JSON. Returns `null` if any field is missing or
 * malformed (the caller responds 400). `byteSize` is bounded above by
 * `MAX_IMPORT_UPLOAD_REQUEST_BYTES` (fold 2) -- it can never itself be the
 * REAL upload's byte size once that exceeds the request body ceiling, so an
 * honest client's genuine `byteSize` is always already smaller than that. */
export function fileMetadataFromImportBody(
  body: Record<string, unknown>,
): ImportUploadFileMetadata | null {
  const fileSha256 =
    typeof body.fileSha256 === "string"
      ? body.fileSha256.trim().toLowerCase()
      : "";
  if (!FILE_SHA256_PATTERN.test(fileSha256)) {
    return null;
  }
  const byteSize = body.byteSize;
  if (
    typeof byteSize !== "number" ||
    !Number.isInteger(byteSize) ||
    byteSize < 0 ||
    byteSize > MAX_IMPORT_UPLOAD_REQUEST_BYTES
  ) {
    return null;
  }
  return {
    filename: filenameFromImportBody(body),
    fileSha256,
    byteSize,
  };
}

/**
 * Coerces the browser-split `rows` field (untrusted JSON) into a plain
 * `string[][]` shape, or `null` if it is not one -- pure shape/type
 * checking only. Content-level validation (row-count/field-length/
 * byte-volume bounds, header shape, per-field grammar) is
 * `classifyImportRows`'s job (`domain/imports/strict-versioned-parser.ts`)
 * -- never duplicated here.
 *
 * IMP-010B review round (B1 fix, corrects a false claim in the original
 * comment): `classifyImportRows` is NEVER called from the browser. The
 * browser only SPLITS a file into this `rows: string[][]` shape (via
 * `splitStrictVersionedCsvRows`) and never classifies it -- classification
 * happens exactly once, here on the server, for every upload, honest or
 * hostile alike. This is a single-authority shape, not a shared-execution
 * one: there is no second, browser-side run of `classifyImportRows` this
 * one could ever disagree with.
 *
 * `maxRows` bounds the cheap length check BEFORE the (potentially large)
 * per-cell type-check loop runs, so a hostile array that is merely
 * oversized (rather than malformed) is rejected without walking every cell.
 */
export function rawRowsFromImportBody(
  body: Record<string, unknown>,
  maxRows: number,
): string[][] | null {
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length > maxRows + 1) {
    return null;
  }
  const result: string[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      return null;
    }
    const fields: string[] = [];
    for (const field of row) {
      if (typeof field !== "string") {
        return null;
      }
      fields.push(field);
    }
    result.push(fields);
  }
  return result;
}
