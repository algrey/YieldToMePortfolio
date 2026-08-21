// MKT-008: shared UTF-8/UTF-16 text detection+decoding for the "Historical
// Data" section's two CSV parsers (`price-csv.ts`, `price-backup-csv.ts`).
// Extracted into its own module rather than duplicated -- both parsers face
// the same owner-facing risk: a spreadsheet application's default "Unicode
// Text" export/re-export is UTF-16, not UTF-8.
//
// Owner-reported bug (post-commit, HEAD 566a2cd): the owner's real
// Intelligent Investor export is UTF-16 (Excel's default TSV encoding), not
// UTF-8. Two failure shapes were reproduced:
//   - UTF-16LE WITHOUT a BOM decodes "successfully" as UTF-8 -- null bytes
//     (every other byte, in ASCII-range UTF-16) are themselves valid UTF-8
//     code points -- producing mojibake ("D\0a\0t\0e...") that then fails a
//     downstream header/shape check with a misleading error, never hinting
//     the real problem is the file's ENCODING.
//   - UTF-16LE/BE WITH a BOM fails outright as "not valid UTF-8" (the BOM
//     bytes themselves are invalid UTF-8 lead bytes), an honest but
//     unhelpful DECODE_FAILED for a file that could actually be read.
// `detectEncoding` runs BEFORE any decode attempt so both shapes are read
// correctly instead of silently misinterpreted.

export type DetectedTextEncoding = "utf-8" | "utf-16le" | "utf-16be";

/**
 * BOM sniff first (authoritative when present): `FF FE` -> UTF-16LE,
 * `FE FF` -> UTF-16BE, `EF BB BF` -> UTF-8. Absent a BOM, a null-byte
 * heuristic over the first ~64 bytes: both file shapes this module ever
 * decodes are ASCII-range CSV/TSV (digits, letters, `,`/`\t`/`\r`/`\n`/
 * `.`/`:`/`-`/`_`), so a genuine UTF-16 encoding of one alternates a real
 * byte with a `0x00` byte for EVERY character -- UTF-16LE puts the null
 * second (odd byte offsets), UTF-16BE puts it first (even offsets). A
 * strong majority of nulls at exactly ONE parity, and none at the other, is
 * treated as that UTF-16 byte order; anything else (including a short
 * file, or one whose null bytes don't cleanly alternate) falls through to
 * UTF-8, the baseline assumption. This is a heuristic, not a guarantee --
 * honestly documented: a UTF-8 file that happens to contain genuine
 * embedded null bytes in its first 64 bytes could misdetect, but no real
 * CSV/TSV of this shape ever does, and the alternative (assuming UTF-8
 * unconditionally) is the exact bug being fixed here.
 */
export function detectEncoding(bytes: Uint8Array): DetectedTextEncoding {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return "utf-8";
  }

  const sampleLength = Math.min(bytes.length, 64);
  let nullAtEven = 0;
  let nullAtOdd = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) nullAtEven += 1;
    else nullAtOdd += 1;
  }
  const halfLength = Math.floor(sampleLength / 2);
  const MAJORITY_FRACTION = 0.6;
  if (
    halfLength > 0 &&
    nullAtOdd >= halfLength * MAJORITY_FRACTION &&
    nullAtEven === 0
  ) {
    return "utf-16le";
  }
  if (
    halfLength > 0 &&
    nullAtEven >= halfLength * MAJORITY_FRACTION &&
    nullAtOdd === 0
  ) {
    return "utf-16be";
  }
  return "utf-8";
}

function byteSwap16(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes.length);
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  if (bytes.length % 2 === 1)
    swapped[bytes.length - 1] = bytes[bytes.length - 1]!;
  return swapped;
}

/**
 * Decodes UTF-16 in the given byte order. `fatal: true` throws on a
 * genuinely malformed byte sequence -- that failure is NEVER swallowed into
 * a fallback reinterpretation (an honest decode failure instead, returned
 * as `null`). The ONLY fallback here is for a runtime that does not
 * recognise the `"utf-16be"` label at all (a `TextDecoder` CONSTRUCTION
 * failure, distinct from a decode failure): `"utf-16le"` is a
 * WHATWG-mandatory label every conforming implementation must support, so
 * byte-swapping to little-endian and decoding via that universally-supported
 * label recovers the same text. Verified present in this project's Node
 * test runtime (`utf-16le` and `utf-16be` both construct and decode
 * correctly); the fallback exists as a defensive measure for the Cloudflare
 * Workers/V8 production runtime in case its label support ever differs.
 */
export function decodeUtf16(
  bytes: Uint8Array,
  order: "le" | "be",
): string | null {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(order === "le" ? "utf-16le" : "utf-16be", {
      fatal: true,
    });
  } catch {
    if (order === "le") return null;
    return decodeUtf16(byteSwap16(bytes), "le");
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Detects then decodes -- the one entry point both parsers call. */
export function decodeText(bytes: Uint8Array): string | null {
  const encoding = detectEncoding(bytes);
  if (encoding === "utf-16le") return decodeUtf16(bytes, "le");
  if (encoding === "utf-16be") return decodeUtf16(bytes, "be");
  return decodeUtf8(bytes);
}

/** Strips a leading U+FEFF left over after decode -- a defensive no-op on
 * most runtimes (their UTF-8/UTF-16LE/UTF-16BE decoders already strip a
 * matching BOM per the WHATWG Encoding spec's default `ignoreBOM: false`
 * behavior), kept for defense-in-depth across environments. */
export function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
