// BRK-009C: the pure, DB-free derivation behind the "Review securities"
// table on the pre-acceptance review screen for `sharesight_sync` batches
// ONLY -- CSV batches never call this (the caller gates on
// `batch.parserFormat`, see `app/import-preview.ts`). A Sharesight row
// always carries a genuine instrument identity (symbol/exchange/currency),
// unlike a CSV row, so grouping the batch's own rows by that identity is
// enough to answer "which DISTINCT securities does this batch touch, and
// how many rows reference each one" without any reconciliation replay.
//
// Kept deliberately decoupled from `db/repositories/import-staging.ts`'s
// `ImportRowRecord`/`ImportIssueRecord` and `domain/imports/reconciliation.ts`'s
// `ImportPreviewSecurityCandidate` types (this file only imports the one
// shared row shape it truly needs) so it stays a plain, synchronously
// testable function -- every caller (`app/import-preview.ts`'s
// `buildImportReviewPreview`, threaded through six mutation-service
// `loadImportReview` copies) does its own DB reads first and passes in
// already-fetched, already-shaped data.
import type { NormalizedImportRow } from "./strict-versioned-parser.ts";

export type SharesightSecuritySummaryRow = Readonly<{
  id: string;
  rowClass:
    "portfolio_security_definition" | "transaction" | "blank" | "unsupported";
  normalizedFields: Pick<
    NormalizedImportRow,
    "symbol" | "exchange" | "currency" | "instrumentName"
  > | null;
  // IMP-008: an owner-excluded row contributes to no security's row count
  // and can never be the sole reason a security appears in this summary --
  // mirrors `domain/imports/review.ts`'s `buildImportReview`, which drops
  // an excluded row before reconciliation ever sees it.
  excludedByOwnerAt: string | null;
}>;

export type SharesightSecuritySummaryCandidate = Readonly<{
  portfolioId: string;
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
  securityId: string | null;
}>;

// "conflict" and "unresolved" are BOTH genuinely observable states, not a
// binary "resolved or not": a `sharesight_sync` batch's security-resolution
// pass (`app/security-resolution-service.ts`) runs automatically right
// after staging and again at accept time, but never at plain preview-read
// time (`app/import-preview.ts`'s own header comment: "resolution is always
// an explicit write step, never a side effect of reading a preview") -- so
// a batch can genuinely be viewed here BEFORE that pass has ever run (an
// older already-staged batch, or between staging and the owner's first
// accept click). Reporting such a group as "conflict" would fabricate a
// blocking issue that does not exist; "unresolved" reports the true,
// non-blocking state honestly instead.
export type SharesightSecuritySummaryState =
  "resolved" | "created" | "conflict" | "unresolved";

export type SharesightSecuritySummaryEntry = Readonly<{
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
  name: string | null;
  // `null` whenever `state !== "resolved" && state !== "created"` -- in
  // particular, ALSO `null` for a candidate row whose `security_id` column
  // still carries a stale/disputed link (B2 in `security-resolution.ts`'s
  // own review round: a pre-existing link is re-validated for currency
  // agreement and reported as a `conflict`, WITHOUT clearing the column) --
  // see the conflict-checked-first ordering below (BRK-009C review round
  // finding F1). Never trust a disputed identity even when a raw column
  // value is present.
  securityId: string | null;
  rowCount: number;
  state: SharesightSecuritySummaryState;
  // BRK-009C review round (finding B1): true only when the name-edit route
  // would ACTUALLY accept an edit for this security -- `state === "created"`
  // AND no other owner is linked to it AND no active verified
  // `security_provider_mappings` row exists. The UI reads this to decide
  // whether to OFFER the edit control at all; the route's own guarded
  // `UPDATE ... WHERE` re-enforces the identical three predicates
  // server-side regardless (this field is a UX convenience, never the sole
  // guard).
  nameEditable: boolean;
}>;

// Mirrors `normalized()` in `domain/imports/reconciliation.ts` (trim +
// lower-case) so this module's grouping key recognizes the SAME rows as
// one distinct security that reconciliation's own `securityKey` would.
function normalizedKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

type Group = {
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
  instrumentName: string | null;
  rowIds: string[];
};

export function deriveSharesightSecuritiesSummary(input: {
  rows: readonly SharesightSecuritySummaryRow[];
  targetPortfolioId: string | null;
  securityCandidates: readonly SharesightSecuritySummaryCandidate[];
  // Rows with a currently-unresolved `SECURITY_RESOLUTION_CONFLICT` issue
  // (persisted `import_issues`, not a computed reconciliation issue) --
  // the caller derives this set from `ImportReviewPreview.issues`.
  conflictedRowIds: ReadonlySet<string>;
  // `securities.id` -> `canonical_name`, for every candidate this batch's
  // rows could reference. Only consulted for a group that resolved to a
  // `securityId` -- `canonical_name` is `NOT NULL` in the schema, so this
  // map should always have an entry for a linked security; a missing entry
  // (should not happen) degrades to `null`, never a fabricated placeholder.
  securityNames: ReadonlyMap<string, string>;
  // `securities.id` values whose canonical `ticker` identifier carries
  // `source = 'sharesight'` -- the durable, schema-level signal that THIS
  // app's own BRK-009B auto-resolution created the security (as opposed to
  // matching one that already existed), mirroring
  // `listAttestedSecurityIds`'s identical absence/presence-of-identifier
  // technique. See `db/repositories/security-resolution.ts`'s
  // `listAutoCreatedSecurityIds`.
  autoCreatedSecurityIds: ReadonlySet<string>;
  // `securities.id` values eligible for THIS user's name edit right now --
  // auto-created AND sole-linked to this user AND no active verified
  // provider mapping (see `listNameEditableSecurityIds`, user-scoped unlike
  // `autoCreatedSecurityIds` above). Always a subset of
  // `autoCreatedSecurityIds`.
  nameEditableSecurityIds: ReadonlySet<string>;
}): SharesightSecuritySummaryEntry[] {
  const groups = new Map<string, Group>();
  for (const row of input.rows) {
    if (row.rowClass !== "transaction") continue;
    if (row.excludedByOwnerAt !== null) continue;
    const symbol = row.normalizedFields?.symbol ?? null;
    const currency = row.normalizedFields?.currency ?? null;
    // Defensive only -- see `domain/sharesight/parse.ts`'s `requiredString`
    // gate on both `symbol`/`instrumentCode` and `currency_code`: a
    // Sharesight trade/payout with no symbol or currency never becomes a
    // `SharesightTrade`/`SharesightPayout` in the first place, so this
    // branch should be unreachable for a genuine `sharesight_sync` row.
    if (!symbol || !currency) continue;
    const exchange = row.normalizedFields?.exchange ?? null;
    const key = [
      normalizedKeyPart(symbol),
      normalizedKeyPart(exchange ?? ""),
      normalizedKeyPart(currency),
    ].join("|");
    let group = groups.get(key);
    if (!group) {
      group = {
        sourceSymbol: symbol,
        sourceExchangeAlias: exchange,
        sourceCurrencyCode: currency,
        instrumentName: null,
        rowIds: [],
      };
      groups.set(key, group);
    }
    group.rowIds.push(row.id);
    if (group.instrumentName === null && row.normalizedFields?.instrumentName) {
      group.instrumentName = row.normalizedFields.instrumentName;
    }
  }

  const entries: SharesightSecuritySummaryEntry[] = [];
  for (const group of groups.values()) {
    const candidate = input.securityCandidates.find(
      (item) =>
        item.portfolioId === input.targetPortfolioId &&
        normalizedKeyPart(item.sourceSymbol) ===
          normalizedKeyPart(group.sourceSymbol) &&
        normalizedKeyPart(item.sourceExchangeAlias ?? "") ===
          normalizedKeyPart(group.sourceExchangeAlias ?? "") &&
        normalizedKeyPart(item.sourceCurrencyCode) ===
          normalizedKeyPart(group.sourceCurrencyCode),
    );
    const linkedSecurityId = candidate?.securityId ?? null;
    // F1 (BRK-009C review round): a conflict check runs BEFORE trusting a
    // non-null `security_id` -- `security-resolution.ts`'s own B2 fix
    // re-validates a PRE-EXISTING link's currency agreement and reports
    // `existing_link_currency_mismatch` as a conflict WITHOUT ever clearing
    // the disputed `portfolio_securities.security_id` column, so a row can
    // be genuinely blocked while its candidate still carries a (stale,
    // disputed) linked id. Checking conflict first, unconditionally,
    // ensures that case reports `state: "conflict"` (never "resolved"/
    // "created") and NEVER exposes the disputed id/name to the summary.
    const hasConflict = group.rowIds.some((id) =>
      input.conflictedRowIds.has(id),
    );
    let state: SharesightSecuritySummaryState;
    let name: string | null;
    let securityId: string | null;
    if (hasConflict) {
      state = "conflict";
      securityId = null;
      name = group.instrumentName;
    } else if (linkedSecurityId !== null) {
      state = input.autoCreatedSecurityIds.has(linkedSecurityId)
        ? "created"
        : "resolved";
      securityId = linkedSecurityId;
      name = input.securityNames.get(linkedSecurityId) ?? null;
    } else {
      state = "unresolved";
      securityId = null;
      name = group.instrumentName;
    }
    entries.push({
      sourceSymbol: group.sourceSymbol,
      sourceExchangeAlias: group.sourceExchangeAlias,
      sourceCurrencyCode: group.sourceCurrencyCode,
      name,
      securityId,
      rowCount: group.rowIds.length,
      state,
      nameEditable:
        state === "created" &&
        securityId !== null &&
        input.nameEditableSecurityIds.has(securityId),
    });
  }

  return entries.sort((left, right) => {
    const bySymbol = left.sourceSymbol.localeCompare(right.sourceSymbol);
    if (bySymbol !== 0) return bySymbol;
    return (left.sourceExchangeAlias ?? "").localeCompare(
      right.sourceExchangeAlias ?? "",
    );
  });
}
