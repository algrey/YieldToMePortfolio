---
name: edit-tool-unicode-dash-mismatch
description: Edit tool old_string mismatches on docs using em-dash/arrow unicode characters even when copied from Read output; use a Python script keyed by line-range extraction instead.
metadata:
  type: feedback
---

Editing prose in `docs/*.md` (e.g. `docs/BACKUP_FORMAT.md`) that contains
typographic characters — em dash `—` (U+2014), right arrow `→` (U+2192) —
can fail the Edit tool's exact-match `old_string` even when the text was
copied verbatim from a prior `Read` tool call's output. The Read tool's
rendering doesn't always round-trip byte-identically back into the Edit
tool's matcher for these characters.

**Why:** confirmed via `hexdump -C` on the raw file bytes: the file's own
`—`/`→` bytes (e2 80 94 / e2 86 92) did not match what was typed into
`old_string`, despite looking identical on screen.

**How to apply:** when an Edit on prose with em dashes/arrows fails with "old
string not found," don't retry Edit with minor variations. Instead read the
exact block with `sed -n '<start>,<end>p' file`, pipe through `hexdump -C` if
still suspicious, then do the replacement via a `python3 - <<'PYEOF'` heredoc
that reads the file as UTF-8, does a plain `str.replace(old, new, 1)` with an
`assert old in content` guard, and writes it back. This sidesteps whatever
normalization the Edit tool's matcher applies. (Note: this sandbox's `python3`
prints a harmless `xcrun_db` cache-file warning to stderr on every invocation
— ignore it, the script still runs.)
