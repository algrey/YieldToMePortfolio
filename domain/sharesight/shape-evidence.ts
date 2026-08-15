// BRK-008: derives a JSON-safe SHAPE description of a Sharesight response --
// field NAMES and `typeof` leaves only -- so a live payload's real structure
// can be inspected as evidence without any field VALUE ever leaving
// `domain/sharesight/`.
//
// PRIVACY CONTRACT (read this before changing anything below):
//   `deriveShapeEvidence` NEVER includes a value from the input anywhere in
//   its output -- not a string, not a number, not a boolean, not a string's
//   length, not an array's contents, AND NOT A VALUE USED AS AN OBJECT KEY
//   (see the key-echoing rule below -- this is the one place an earlier
//   version of this module got the contract wrong: `Object.keys` doesn't
//   know the difference between a genuine field name and a value the
//   payload happens to be keyed by, e.g. `{"BHP.AX": {...}}`,
//   `{"9f3c7a1b-...": {...}}`, or `{"<a-secret>": {...}}` -- all of those
//   ARE values, not field names, even though they occupy key position).
//   The only things this module ever emits are:
//     - an object KEY, echoed VERBATIM, ONLY when it matches
//       `FIELD_NAME_KEY_PATTERN` below (lower_snake_case: `/^[a-z][a-z0-9_]*$/`
//       -- starts with a lowercase letter, then only lowercase
//       letters/digits/underscores). This is deliberately NARROWER than "is
//       this an identifier" -- a bare ticker (`BHP`), a UUID, a numeric key
//       (`12345`, `12345.67`), or an id/secret string used as a key would
//       all pass a looser identifier check while still BEING a value, so
//       they are excluded too. A key that does NOT match this pattern is
//       never echoed, in whole or in part; it is folded into the
//       aggregated non-field-shaped-key marker described below instead.
//       This is deliberate: the whole point of this diagnostic is
//       confirming which FIELD NAMES a live Sharesight response actually
//       uses (e.g. distinguishing `id` from `holding_id`) -- genuine field
//       names are evidence, not values, and are the one thing this module
//       is allowed to echo;
//     - for the keys on one object that do NOT match
//       `FIELD_NAME_KEY_PATTERN` (there may be zero, one, or many -- e.g. an
//       object literally keyed by ticker or id), a SINGLE aggregated marker
//       key of the form `"<N non-field-shaped key(s)>"` (N is a count, not
//       any of the actual keys), whose value is the derived shape of the
//       FIRST such key's VALUE ONLY (sorted key order) -- never any of the
//       keys' own text, and never more than that one representative value's
//       shape;
//     - `typeof` of each primitive leaf (`"string"` / `"number"` /
//       `"boolean"`), or the literal `"null"` for `null` (and `"undefined"`
//       for `undefined`, defensively -- `JSON.parse` never actually produces
//       one, but a caller could hand this function an arbitrary in-memory
//       value);
//     - a `(decimal-like)` / `(exponent-notation)` annotation appended to a
//       `number`/`string` leaf's `typeof`, e.g. `"number(decimal-like)"` --
//       derived ONLY from the value's FORMAT CLASS via a fixed regex (does
//       it look like `-123.45`? does its string form contain an `e`/`E`?),
//       never from its content. This is the one narrow exception to "no
//       values": a format class is not the value itself (nothing here could
//       reconstruct the original string/number from the annotation alone).
//       This annotation is what let BRK-008's live spike confirm whether a
//       real money/quantity field could ever arrive in exponential
//       notation -- resolved (see `parse.ts`'s `decimalString`: such a
//       value is now REJECTED, fail-closed, rather than reformatted) --
//       and it remains live diagnostic value for any FUTURE shape-evidence
//       failure, not a pending question anymore;
//     - array LENGTH, as the literal string `"length:N"` (a count, not a
//       value);
//     - the literal marker `"…truncated"`, when depth or the field-shaped
//       key-count limit below are hit.
//   An array's contents beyond its first element are never inspected at
//   all -- only `arr[0]`'s shape and `arr.length` are ever produced -- and a
//   depth/key-cap-truncated object's OMITTED field-shaped keys are never
//   named, only counted.
//
//   Every object this function builds (at every nesting level) is created
//   with `Object.create(null)`, never a plain `{}` object literal -- so
//   even a payload key of literally `"__proto__"` (which, when it comes
//   from `JSON.parse`, is a genuine own-enumerable data property, not a
//   prototype override -- see this module's tests) can never cause a
//   `shape[key] = ...` assignment to silently reassign the RESULT object's
//   own prototype rather than setting a property on it. Belt-and-braces:
//   `"__proto__"` also never matches `FIELD_NAME_KEY_PATTERN` (it starts
//   with `_`, not a lowercase letter), so it is never used as a literal
//   key in a `shape[key] = ...` assignment in the first place -- this
//   defense holds even if that pattern is ever loosened later.
//
// Depth- and key-capped (defaults below) so a pathological or hostile
// payload can never make this function do unbounded work: depth strictly
// increases on every recursive call regardless of the input's actual
// structure, so this also can never loop forever on a circular reference
// (a `JSON.parse` result can't contain one, but this function is otherwise
// general-purpose over `unknown`, so it doesn't rely on that).
//
// Pure and side-effect free: no fetch, no I/O, nothing here can reach
// Sharesight or any other network target. Safe to export from the public
// barrel (`index.ts`) on that basis alone, unlike `transport.ts`'s raw
// `sharesightGet` primitive.

export type DeriveShapeEvidenceOptions = Readonly<{
  /** Maximum object/array nesting level this function will descend into.
   * Beyond this depth, an object or array is replaced by the `"…truncated"`
   * marker rather than expanded further. Defaults to 6. */
  maxDepth?: number;
  /** Maximum number of an object's FIELD-SHAPED keys (see
   * `FIELD_NAME_KEY_PATTERN`) this function will echo verbatim. Beyond this
   * count, the remaining field-shaped keys are represented by a single
   * `"…truncated"` marker key naming only HOW MANY keys were omitted, never
   * which ones. Does not bound non-field-shaped keys, which are never
   * echoed individually regardless of count -- see the module doc comment.
   * Defaults to 64. */
  maxKeys?: number;
}>;

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_KEYS = 64;
const TRUNCATED_MARKER = "…truncated";

/**
 * Only a key SHAPED like a lower_snake_case field name (Sharesight's own
 * convention throughout `parse.ts` -- e.g. `average_cost`,
 * `transaction_type`, `id`) is ever echoed verbatim as an object key in the
 * derived shape: starts with a lowercase letter, then only lowercase
 * letters/digits/underscores. This is deliberately NARROWER than "looks
 * like an identifier" -- a bare ticker (`BHP`), an exchange-qualified
 * ticker (`BHP.AX`), a UUID, or a purely numeric key (`12345`, `12345.67`)
 * would all pass a looser identifier check while still BEING a value the
 * payload happens to be keyed by, not a field name -- see the module doc
 * comment's PRIVACY CONTRACT.
 */
const FIELD_NAME_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The aggregated marker key standing in for every key on one object that
 * failed `FIELD_NAME_KEY_PATTERN` -- `count` is a count, never any of the
 * actual key text. */
function nonFieldShapedKeyMarker(count: number): string {
  return `<${count} non-field-shaped key(s)>`;
}

/** Matches a bare, non-exponential decimal string shape (e.g. `-123.45`) --
 * a FORMAT CLASS check, not a value check: it never inspects the digits'
 * meaning, only whether the string is shaped like a fractional decimal. */
const DECIMAL_LIKE_PATTERN = /^-?\d+\.\d+$/;
/** Matches a full exponential-number shape (e.g. `1e21`, `-1.5E-7`) --
 * unlike `sharesight-read-spike.mjs`'s narrower `looksExponential` (which is
 * only ever applied to a field already known by NAME to hold a decimal, so
 * a bare `/e/i` presence check is safe there), this function runs over
 * ARBITRARY string leaves from an unknown payload, where a loose `/e/i`
 * check would misfire on an ordinary word containing the letter "e" (e.g.
 * "hello", "Delaware") and falsely flag it as exponent-notation. Anchored
 * end-to-end so only a string actually SHAPED like a full exponential
 * number matches -- this is the same exponent-notation signal that let
 * BRK-008's live spike confirm `parse.ts`'s `decimalString` question
 * (resolved: exponential notation is now rejected, fail-closed, rather
 * than reformatted), without over-triggering on unrelated text. Still live
 * diagnostic value for any future shape-evidence failure. */
const EXPONENT_PATTERN = /^-?\d+(\.\d+)?e[+-]?\d+$/i;

/**
 * Classifies a primitive's STRING FORM by regex shape only -- never by its
 * numeric/string content -- for the `decimalLike`/exponent-notation
 * annotation. Returns `null` when neither format class applies (the leaf's
 * `typeof` is reported with no annotation in that case).
 */
function formatClassOf(
  raw: string,
): "decimal-like" | "exponent-notation" | null {
  if (EXPONENT_PATTERN.test(raw)) return "exponent-notation";
  if (DECIMAL_LIKE_PATTERN.test(raw)) return "decimal-like";
  return null;
}

function primitiveShape(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "number";
    const formatClass = formatClassOf(String(value));
    return formatClass ? `number(${formatClass})` : "number";
  }
  if (typeof value === "string") {
    const formatClass = formatClassOf(value);
    return formatClass ? `string(${formatClass})` : "string";
  }
  // typeof value for boolean/undefined/etc -- never annotated, and never
  // carries the value itself (e.g. a boolean leaf is always exactly
  // "boolean", never "true"/"false").
  return typeof value;
}

function shapeOf(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxKeys: number,
): unknown {
  if (Array.isArray(value)) {
    if (depth >= maxDepth) return TRUNCATED_MARKER;
    if (value.length === 0) return [`length:0`];
    // Only the FIRST element's shape is ever produced -- the rest of the
    // array's contents are never inspected, only its length.
    return [
      shapeOf(value[0], depth + 1, maxDepth, maxKeys),
      `length:${value.length}`,
    ];
  }
  if (value !== null && typeof value === "object") {
    if (depth >= maxDepth) return TRUNCATED_MARKER;
    const record = value as Record<string, unknown>;
    const allKeys = Object.keys(record).sort();
    const fieldShapedKeys: string[] = [];
    const nonFieldShapedKeys: string[] = [];
    for (const key of allKeys) {
      (FIELD_NAME_KEY_PATTERN.test(key)
        ? fieldShapedKeys
        : nonFieldShapedKeys
      ).push(key);
    }

    // `Object.create(null)`, never `{}` -- see the module doc comment's
    // prototype-safety note. Every `shape[...] = ...` assignment below uses
    // either a real field-shaped key (which, by construction, can never be
    // "__proto__" -- that starts with `_`, not a lowercase letter) or one
    // of this function's own fixed marker strings, so this is
    // belt-and-braces, not load-bearing for correctness -- but it is what
    // makes that guarantee hold even if the pattern is ever loosened later.
    const shape: Record<string, unknown> = Object.create(null);

    const kept = fieldShapedKeys.slice(0, maxKeys);
    for (const key of kept) {
      shape[key] = shapeOf(record[key], depth + 1, maxDepth, maxKeys);
    }
    const omittedFieldShapedCount = fieldShapedKeys.length - kept.length;
    if (omittedFieldShapedCount > 0) {
      // Names only HOW MANY field-shaped keys were omitted -- never which.
      shape[TRUNCATED_MARKER] = `${omittedFieldShapedCount} more key(s)`;
    }

    if (nonFieldShapedKeys.length > 0) {
      // None of these keys' own text is ever echoed (see the module doc
      // comment) -- only a count, plus the derived shape of the FIRST such
      // key's VALUE (sorted order), as a representative sample.
      const representativeKey = nonFieldShapedKeys[0];
      shape[nonFieldShapedKeyMarker(nonFieldShapedKeys.length)] = shapeOf(
        record[representativeKey],
        depth + 1,
        maxDepth,
        maxKeys,
      );
    }

    return shape;
  }
  return primitiveShape(value);
}

/**
 * Derives a JSON-safe shape description of `value`: an object's
 * FIELD-SHAPED keys (`FIELD_NAME_KEY_PATTERN`) become `{key: shape}`
 * verbatim, while any other keys on that object (a ticker, a UUID, a
 * numeric key -- values used as keys) are folded into one aggregated
 * `"<N non-field-shaped key(s)>"` marker carrying only a count and the
 * first such key's VALUE shape, never any key text. Arrays become
 * `[shapeOfFirstElement, "length:N"]`, and primitive leaves become their
 * `typeof` (or `"null"`), optionally annotated with a format-class-only
 * `(decimal-like)` / `(exponent-notation)` suffix for `number`/`string`
 * leaves. See this module's header comment for the full privacy contract --
 * no field VALUE, including one used as a key, is ever present in the
 * result, only field names, `typeof`s, format classes, lengths, counts, and
 * truncation markers.
 */
export function deriveShapeEvidence(
  value: unknown,
  options?: DeriveShapeEvidenceOptions,
): unknown {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxKeys = options?.maxKeys ?? DEFAULT_MAX_KEYS;
  return shapeOf(value, 0, maxDepth, maxKeys);
}
