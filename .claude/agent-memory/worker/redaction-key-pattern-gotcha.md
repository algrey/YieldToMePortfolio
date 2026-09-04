---
name: redaction-key-pattern-gotcha
description: domain/observability/redaction.ts's SENSITIVE_KEY regex auto-redacts any metadata key matching user.?id, portfolio.?id, security.?id, or target.?id -- passing these as emitStructuredLog metadata keys silently yields "[REDACTED]", by design.
metadata:
  type: project
---

`domain/observability/redaction.ts`'s `SENSITIVE_KEY` regex is
`/(token|api.?key|authorization|cookie|secret|password|email|amount|price|
quantity|balance|cost|value|user.?id|portfolio.?id|security.?id|
target.?id|csv.*(row|data|content|text)|raw.*payload|
provider.*payload)/i`. Any `emitStructuredLog`/audit metadata key matching
this (case-insensitive substring, not exact match) gets its VALUE
replaced with `"[REDACTED]"` before it ever reaches a sink -- this is
automatic and happens inside `createStructuredLogEvent`/`redactMetadata`,
not something a caller opts into.

Practical consequence: if a task instructs you to log `portfolioId` (or
`userId`, `securityId`, `targetId`) in structured-log metadata "for
diagnosis", the value will actually render as `[REDACTED]` in the log --
useless for correlation by value, but this is INTENTIONAL per AGENTS.md's
"keep secrets/PII out of logs" rule, not a bug to route around. Don't
"fix" this by renaming the key (e.g. `pid` instead of `portfolioId`) to
dodge the filter -- that would defeat the privacy rule the pattern
exists to enforce. Instead:
- If the task explicitly lists `portfolioId` as required metadata, log it
  as asked and let it redact -- the test should assert the redacted
  value, not the real one.
- If you need an actually-useful correlator, prefer a non-PII-shaped key
  name for a genuinely non-sensitive identifier that doesn't match the
  regex (e.g. a `calculation_runs.id` under a key like `pendingRunId` --
  "run" is not in the sensitive list, so it passes through unredacted).

Verify with a one-liner before assuming either way:
`node --experimental-strip-types -e 'import("./domain/observability/index.ts").then(({redactMetadata}) => console.log(JSON.stringify(redactMetadata({...}))))'`

Existing test pattern for capturing `emitStructuredLog`'s default
`console.log` sink: monkey-patch `console.log` to push lines into an
array, restore in a `finally`, then `JSON.parse` each line and filter by
`event`/`action`. See `tests/imp-003b.test.ts`'s
"BUG-016: a reversal over more dividend-bearing portfolios..." test for
the canonical example; `tests/ops-001.test.ts` tests
`createStructuredLogEvent` directly instead (no sink capture) for pure
redaction assertions.

Related: [[bug-017-newer-than-published-run-pattern]].
