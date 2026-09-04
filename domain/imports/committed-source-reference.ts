// BRK-022 slice 2 review round (B2, BLOCKING): the SINGLE place that mints a
// committed row's `import-fingerprint:<fingerprint>` `source_reference` --
// extracted out of `db/repositories/import-commit.ts` (which had two
// hand-written copies of the identical template literal, one for the
// dividend-reconciliation matching pool, one for the actual commit insert)
// so it can also be the SINGLE place a caller OUTSIDE `import-commit.ts`
// (`app/sharesight-sync-service.ts`'s `classifySharesightRow`, and slice 3's
// pending-vs-committed suppression check) computes the identical string,
// rather than re-deriving the `import-fingerprint:` prefix by hand a third
// or fourth time.
//
// This closes a review finding: `docs/DATA_MODEL.md` and
// `docs/CSV_IMPORT_SPEC.md` both claimed `sharesight_pending_payouts.source_reference`
// and the LATER committed `dividend_manual_records.source_reference` "share
// exactly one key" / are the "SAME payoutIdentityKey". They are not
// byte-equal -- `sharesight_pending_payouts` stores the BARE
// `payoutIdentityKey` (the Sharesight identity itself), while a committed
// row's `source_reference` is that SAME key wrapped in this import-pipeline
// prefix (`import-commit.ts`'s commit-time identity scheme, shared by every
// staged row regardless of source -- CSV or Sharesight). The two values are
// related by exactly this function, never literally equal. Slice 3's
// pending-row suppression (a pending row must be skipped once a committed
// row exists under "the same" identity) MUST compare
// `committedSourceReferenceForFingerprint(pending.sourceReference)` against
// the committed row's own `source_reference`, never the bare key against the
// prefixed one directly.
export function committedSourceReferenceForFingerprint(
  fingerprint: string,
): string {
  return `import-fingerprint:${fingerprint}`;
}
