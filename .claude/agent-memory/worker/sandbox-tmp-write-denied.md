---
name: sandbox-tmp-write-denied
description: Writing to /tmp directly (heredoc via Bash, or tsx's own IPC pipe) silently fails or throws EPERM under this environment's sandbox -- use the session scratchpad directory instead for ad hoc measurement/throwaway scripts.
metadata:
  type: feedback
---

A `cat > /tmp/foo.mjs << 'EOF' ... EOF` heredoc write can silently produce a zero-byte or missing file (no visible error at the point of the write), and `npx tsx /tmp/foo.mjs` fails outright with `EPERM: operation not permitted` trying to set up its own IPC pipe under `/tmp/claude-501/...`. Both are sandbox filesystem-write restrictions on `/tmp`, not script bugs.

**Why:** this environment's Bash sandbox only allows writes under specific paths (the session's scratchpad directory, `$TMPDIR`, a few others) -- plain `/tmp` is not among them even though it looks writable.

**How to apply:** for any throwaway measurement/verification script (e.g. "run this loader directly and print its statement count" ad hoc probes, used here to get exact before/after PRF-011 figures for docs before writing them down), write the file with the `Write` tool (not a Bash heredoc) into the session's scratchpad directory (given in the system prompt), then `node <scratchpad-path>/script.mjs` directly rather than `tsx` (plain `node` on a recent version handles `.ts` imports/type-stripping fine for straightforward module graphs and avoids tsx's IPC-server EPERM entirely). Delete the scratchpad file when done since it isn't part of the repo.
