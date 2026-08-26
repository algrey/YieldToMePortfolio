import type { NormalizedImportRow } from "./strict-versioned-parser.ts";
// DIV-004: reuse DIV-001's documented proximity window rather than
// re-deriving a second "how close counts as a duplicate" constant.
import { PROXIMITY_WINDOW_DAYS } from "../dividends/history.ts";
// DIV-016 part C: the shared matching algorithm -- see that module's header
// comment for the owner rulings and tolerance decision it implements.
import {
  cashTotalsWithinTolerance,
  computeDividendCashTotal,
  computeDividendReconciliation,
} from "./dividend-reconciliation.ts";

type Decimal = { coefficient: bigint; scale: number };

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

function decimal(value: string): Decimal {
  if (!DECIMAL.test(value)) throw new Error(`Invalid decimal: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function power(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function align(left: Decimal, right: Decimal): [bigint, bigint] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * power(scale - left.scale),
    right.coefficient * power(scale - right.scale),
  ];
}

function add(left: string, right: string): string {
  const a = decimal(left);
  const b = decimal(right);
  const [leftCoefficient, rightCoefficient] = align(a, b);
  const scale = Math.max(a.scale, b.scale);
  return normalize({ coefficient: leftCoefficient + rightCoefficient, scale });
}

function subtract(left: string, right: string): string | null {
  const a = decimal(left);
  const b = decimal(right);
  const [leftCoefficient, rightCoefficient] = align(a, b);
  if (leftCoefficient < rightCoefficient) return null;
  return normalize({
    coefficient: leftCoefficient - rightCoefficient,
    scale: Math.max(a.scale, b.scale),
  });
}

function normalize(value: Decimal): string {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

// Plain calendar-day difference, matching `domain/dividends/history.ts`'s
// private `daysBetween` exactly (kept local rather than exported/shared,
// since it is a two-line date-math primitive, not shared business logic --
// only the proximity WINDOW constant is reused, per DIV-004's instruction
// not to re-derive that).
function daysBetweenDates(a: string, b: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / msPerDay,
  );
}

export type ImportReconciliationRow = Readonly<{
  id: string;
  physicalRowNumber: number;
  rowClass:
    "portfolio_security_definition" | "transaction" | "blank" | "unsupported";
  normalized: NormalizedImportRow;
  fingerprint: string;
  targetPortfolioId?: string | null;
  targetPortfolioSecurityId?: string | null;
}>;

export type ImportPreviewPortfolio = Readonly<{
  id: string;
  name: string;
  homeCurrencyCode: string;
  historyCompleteFrom?: string | null;
}>;

export type ImportPreviewSecurityCandidate = Readonly<{
  id: string;
  portfolioId: string;
  sourceSymbol: string;
  sourceExchangeAlias: string | null;
  sourceCurrencyCode: string;
  securityId: string | null;
}>;

export type ImportPreviewMappingDecision = Readonly<{
  kind: "portfolio" | "security" | "currency" | "transaction_type" | "fx";
  sourceKey: string;
  scope: "row" | "batch" | "user_future";
  targetId?: string | null;
  targetValue?: string | null;
}>;

export type ImportReconciliationIssue = Readonly<{
  code:
    | "PORTFOLIO_MAPPING_REQUIRED"
    | "PORTFOLIO_MAPPING_INVALID"
    | "SECURITY_MAPPING_REQUIRED"
    | "SECURITY_MAPPING_AMBIGUOUS"
    | "FX_DIRECTION_REQUIRED"
    | "FX_RATE_INCOMPLETE"
    | "DUPLICATE_ROW"
    | "OVERSELL"
    | "INCOMPLETE_HISTORY"
    | "ROW_UNSUPPORTED"
    | "DIVIDEND_NEAR_EXISTING_ENTRY"
    // DIV-016 part C: advisory, preview-only disclosure of the reconciliation
    // this batch's commit would apply (PROPOSED) or could not safely decide
    // (AMBIGUOUS) -- see `ImportPreviewDividendReconciliationCandidate`'s doc
    // comment for scope and `domain/imports/review.ts` for why these codes,
    // like `DIVIDEND_NEAR_EXISTING_ENTRY`, are excluded from `previewVersion`.
    | "DIVIDEND_RECONCILIATION_PROPOSED"
    | "DIVIDEND_RECONCILIATION_AMBIGUOUS"
    // DIV-016 part C, review round 1 B1 (BLOCKING): a row whose OWN
    // cross-batch identity was already committed in a PRIOR import can
    // never actually reconcile (only a row THIS batch actually inserts can
    // supersede a manual record) -- this code states that truth instead of
    // a false `DIVIDEND_RECONCILIATION_PROPOSED` promise. See the matching
    // block's own comment in `createImportReconciliationPreview` below.
    | "DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE";
  severity: "error" | "warning" | "info";
  rowId?: string;
  physicalRowNumber?: number;
  sourceKey?: string;
  message: string;
}>;

// DIV-004: an existing (already-persisted, pre-this-batch) owner-entered
// dividend fact used to warn the reviewer that an incoming CSV dividend row
// looks like a probable duplicate BEFORE they commit it -- never a hard
// block, since it is only a proximity heuristic, not a certain duplicate
// (matching the FRANKING_ON_NON_DIVIDEND precedent for a non-blocking
// dividend-row warning). Deliberately excludes previously IMPORTED rows: an
// imported-vs-imported near-match is cross-batch dedupe's job (the
// `source_reference` idempotency key at commit time), not this warning's.
export type ImportPreviewExistingDividendEntry = Readonly<{
  portfolioSecurityId: string;
  paymentDate: string;
}>;

// DIV-016 part C: an existing OWNER-TYPED, non-superseded manual dividend
// record (`dividend_manual_records`, `import_batch_id IS NULL AND
// superseded_by_record_id IS NULL`) eligible to be matched and SUPERSEDED by
// an incoming Sharesight payout row. Deliberately narrower than
// `ImportPreviewExistingDividendEntry` above: `dividend_receipts` rows are
// never reconciliation candidates (only a manually entered fact can be
// superseded, per the DIV-016 owner ruling), and this shape carries the
// comparable cash amount the AMOUNT leg of the matching rule needs (see
// `domain/imports/dividend-reconciliation.ts`), not just security+date.
export type ImportPreviewDividendReconciliationCandidate = Readonly<{
  id: string;
  portfolioSecurityId: string;
  paymentDate: string;
  totalCashDecimal: string | null;
  sharesDecimal: string | null;
  dividendPerShareDecimal: string | null;
}>;

export type ImportReconciliationPreview = Readonly<{
  ready: boolean;
  counts: Readonly<{
    transactionCreates: number;
    dividendCreates: number;
    candidateCreates: number;
    skips: number;
    unresolved: number;
  }>;
  projectedQuantities: Readonly<Record<string, string>>;
  unresolvedCandidates: readonly ImportPreviewSecurityCandidate[];
  // DIV-016 part C: advisory disclosure of the safe (unambiguous) proposed
  // reconciliations this batch's rows resolve to against
  // `input.reconciliationCandidates` -- see that field's doc comment for
  // scope. Always `[]` when `reconciliationCandidates` is omitted (never
  // fabricates a match without candidate evidence). Excluded from
  // `previewVersion` by `domain/imports/review.ts` -- see its doc comment.
  proposedReconciliations: readonly Readonly<{
    rowId: string;
    physicalRowNumber: number;
    manualRecordId: string;
    portfolioSecurityId: string;
    paymentDate: string;
  }>[];
  resolvedTargets: Readonly<
    Record<
      string,
      Readonly<{
        portfolioId: string;
        portfolioSecurityId: string | null;
        fxDirection: "native_to_home" | "home_to_native" | null;
      }>
    >
  >;
  issues: readonly ImportReconciliationIssue[];
}>;

export type ImportReconciliationInput = Readonly<{
  rows: readonly ImportReconciliationRow[];
  portfolios: readonly ImportPreviewPortfolio[];
  securityCandidates: readonly ImportPreviewSecurityCandidate[];
  decisions?: readonly ImportPreviewMappingDecision[];
  existingFingerprints?: ReadonlySet<string>;
  existingQuantities?: Readonly<Record<string, string>>;
  // DIV-004: existing owner-entered manual records (no `import_batch_id`)
  // and receipts, loaded by the caller, used to warn on a probable
  // near-duplicate dividend row before commit -- see
  // `ImportPreviewExistingDividendEntry`'s doc comment for scope.
  existingDividendEntries?: readonly ImportPreviewExistingDividendEntry[];
  // DIV-016 part C: existing manual dividend rows eligible for reconciliation
  // -- see `ImportPreviewDividendReconciliationCandidate`'s doc comment.
  reconciliationCandidates?: readonly ImportPreviewDividendReconciliationCandidate[];
  // DIV-016 part C, review round 1 B1 (BLOCKING): the set of
  // `${portfolioId}::${sourceReference}` composite keys ALREADY committed
  // to `dividend_manual_records` from a PRIOR import (any batch) -- the
  // EXACT identity `db/repositories/import-commit.ts`'s dividend branch
  // checks before it ever reaches the supersede step. A row whose own
  // computed `import-fingerprint:<fingerprint>` identity is in this set can
  // never actually insert (the cross-batch idempotency short-circuit fires
  // first), so it is excluded from the reconciliation matching pool
  // entirely -- see `createImportReconciliationPreview`'s own comment at
  // the `freshRows`/`alreadyImportedRows` split for why.
  existingDividendSourceReferences?: ReadonlySet<string>;
}>;

function decisionFor(
  decisions: readonly ImportPreviewMappingDecision[],
  kind: ImportPreviewMappingDecision["kind"],
  sourceKey: string,
  rowKey?: string,
): ImportPreviewMappingDecision | undefined {
  return [...decisions]
    .filter(
      (decision) =>
        decision.kind === kind &&
        (decision.sourceKey === sourceKey ||
          (decision.scope === "row" && decision.sourceKey === rowKey)),
    )
    .sort((left, right) => {
      const rank = { row: 0, batch: 1, user_future: 2 } as const;
      return rank[left.scope] - rank[right.scope];
    })[0];
}

function portfolioFor(
  row: ImportReconciliationRow,
  portfolios: readonly ImportPreviewPortfolio[],
  decisions: readonly ImportPreviewMappingDecision[],
): ImportPreviewPortfolio | null {
  const source = row.normalized.portfolio ?? "";
  const decision = decisionFor(decisions, "portfolio", source, row.id);
  if (decision?.targetId) {
    return (
      portfolios.find((portfolio) => portfolio.id === decision.targetId) ?? null
    );
  }
  if (row.targetPortfolioId !== undefined && row.targetPortfolioId !== null) {
    return (
      portfolios.find((portfolio) => portfolio.id === row.targetPortfolioId) ??
      null
    );
  }
  const matches = portfolios.filter(
    (portfolio) => normalized(portfolio.name) === normalized(source),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function securityKey(
  portfolioId: string,
  row: ImportReconciliationRow,
): string {
  const normalizedRow = row.normalized;
  return [
    portfolioId,
    normalized(normalizedRow.symbol ?? ""),
    normalized(normalizedRow.exchange ?? ""),
    normalized(normalizedRow.currency ?? ""),
  ].join("|");
}

export function createImportReconciliationPreview(
  input: ImportReconciliationInput,
): ImportReconciliationPreview {
  const decisions = input.decisions ?? [];
  const existingFingerprints = input.existingFingerprints ?? new Set<string>();
  const issues: ImportReconciliationIssue[] = [];
  const unresolvedCandidates: ImportPreviewSecurityCandidate[] = [];
  const unresolvedCandidateIds = new Set<string>();
  const projectedQuantities: Record<string, string> = {};
  const resolvedTargets: Record<
    string,
    {
      portfolioId: string;
      portfolioSecurityId: string | null;
      fxDirection: "native_to_home" | "home_to_native" | null;
    }
  > = {};
  const holdings = new Map<string, string>();
  const seen = new Set(existingFingerprints);
  const resolvedRows: Array<{
    row: ImportReconciliationRow;
    portfolio: ImportPreviewPortfolio;
    membershipId: string;
  }> = [];
  let transactionCreates = 0;
  let dividendCreates = 0;
  let candidateCreates = 0;
  let skips = 0;
  let unresolved = 0;

  for (const row of [...input.rows].sort((left, right) =>
    left.physicalRowNumber === right.physicalRowNumber
      ? left.id.localeCompare(right.id)
      : left.physicalRowNumber - right.physicalRowNumber,
  )) {
    if (row.rowClass === "blank") {
      skips += 1;
      continue;
    }
    if (row.rowClass === "unsupported") {
      unresolved += 1;
      issues.push({
        code: "ROW_UNSUPPORTED",
        severity: "error",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        message: "This row cannot be previewed until its format is supported.",
      });
      continue;
    }
    if (seen.has(row.fingerprint)) {
      skips += 1;
      issues.push({
        code: "DUPLICATE_ROW",
        severity: "warning",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        message:
          "This row duplicates an existing staged or committed row and will be skipped.",
      });
      continue;
    }
    seen.add(row.fingerprint);

    const portfolio = portfolioFor(row, input.portfolios, decisions);
    if (!portfolio) {
      unresolved += 1;
      issues.push({
        code:
          row.targetPortfolioId !== undefined
            ? "PORTFOLIO_MAPPING_INVALID"
            : "PORTFOLIO_MAPPING_REQUIRED",
        severity: "error",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        sourceKey: row.normalized.portfolio ?? "",
        message: "Select one of your portfolios before previewing this row.",
      });
      continue;
    }

    const isCash = row.normalized.cashEvent !== null;
    // BRK-010: a totals-mode Sharesight payout row's own cash currency is a
    // property of the CASH EVENT, not the security's identity (see
    // `db/repositories/security-resolution.ts`'s `linkResolvedSecurity` doc
    // comment for the matching resolution-time ruling) -- computed here,
    // ahead of its other use further down, so the candidate match below can
    // ignore currency for exactly this row shape. Narrowly scoped to
    // totals-mode (`totalCashDecimal` set) rather than every dividend row:
    // a CSV per-share dividend row has no established FX mechanism at all
    // (this task's `import-commit.ts` fix is likewise totals-mode-only), so
    // its pre-existing currency-matched candidate behaviour is unchanged.
    const isTotalsModeDividend =
      row.normalized.type === "dividend" &&
      (row.normalized.totalCashDecimal ?? null) !== null;
    let membershipId: string | null = null;
    if (!isCash) {
      const key = securityKey(portfolio.id, row);
      const decision = decisionFor(decisions, "security", key, row.id);
      const candidates = input.securityCandidates.filter(
        (candidate) =>
          candidate.portfolioId === portfolio.id &&
          normalized(candidate.sourceSymbol) ===
            normalized(row.normalized.symbol ?? "") &&
          normalized(candidate.sourceExchangeAlias ?? "") ===
            normalized(row.normalized.exchange ?? "") &&
          (isTotalsModeDividend ||
            normalized(candidate.sourceCurrencyCode) ===
              normalized(row.normalized.currency ?? "")),
      );
      const selectedTargetId =
        decision?.targetId ?? row.targetPortfolioSecurityId ?? null;
      membershipId =
        selectedTargetId ?? candidates[0]?.id ?? `candidate:${key}`;
      if (selectedTargetId) {
        const selectedCandidate = input.securityCandidates.find(
          (candidate) =>
            candidate.id === selectedTargetId &&
            candidate.portfolioId === portfolio.id,
        );
        if (!selectedCandidate || selectedCandidate.securityId === null) {
          unresolved += 1;
          issues.push({
            code: "SECURITY_MAPPING_REQUIRED",
            severity: "error",
            rowId: row.id,
            physicalRowNumber: row.physicalRowNumber,
            sourceKey: key,
            message:
              "The selected security mapping is not owned by this portfolio.",
          });
          continue;
        }
      } else if (candidates.length > 1) {
        unresolved += 1;
        issues.push({
          code: "SECURITY_MAPPING_AMBIGUOUS",
          severity: "error",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: key,
          message:
            "More than one owned security candidate matches; ticker alone is not enough.",
        });
        continue;
      } else if (
        candidates.length === 0 ||
        candidates[0]?.securityId === null
      ) {
        if (
          candidates.length === 0 &&
          !unresolvedCandidateIds.has(membershipId)
        ) {
          candidateCreates += 1;
        }
        unresolved += 1;
        const candidate = {
          id: membershipId,
          portfolioId: portfolio.id,
          sourceSymbol: row.normalized.symbol ?? "",
          sourceExchangeAlias: row.normalized.exchange,
          sourceCurrencyCode: row.normalized.currency ?? "",
          securityId: null,
        };
        if (!unresolvedCandidateIds.has(candidate.id)) {
          unresolvedCandidateIds.add(candidate.id);
          unresolvedCandidates.push(candidate);
        }
        issues.push({
          code: "SECURITY_MAPPING_REQUIRED",
          severity: "error",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: key,
          message: "Resolve this private security candidate before committing.",
        });
        continue;
      }
    }

    // Dividend rows never resolve FX at import time: `dividend_manual_records`
    // stores native per-share amounts only and DIV-001's read-time
    // derivation, not the importer, is responsible for any base-currency
    // conversion. `Purchase Exchange Rate` is unused/ignored on these rows.
    const isDividend = row.normalized.type === "dividend";

    // DIV-004: a NON-BLOCKING proximity warning (mirrors FRANKING_ON_NON_
    // DIVIDEND -- readiness/commit are unaffected) when an incoming dividend
    // row falls within DIV-001's matching window of an EXISTING owner-typed
    // manual record or receipt for the SAME resolved security. By this
    // point `membershipId` (when non-null) is always a genuine, already-
    // resolved portfolio-security id -- every unresolved-security path above
    // already issued an error and `continue`d -- so this never fires for a
    // row still awaiting security resolution.
    if (
      isDividend &&
      membershipId !== null &&
      row.normalized.localTradeDate !== null
    ) {
      const paymentDate = row.normalized.localTradeDate;
      const nearExisting = (input.existingDividendEntries ?? []).some(
        (entry) =>
          entry.portfolioSecurityId === membershipId &&
          Math.abs(daysBetweenDates(entry.paymentDate, paymentDate)) <=
            PROXIMITY_WINDOW_DAYS,
      );
      if (nearExisting) {
        issues.push({
          code: "DIVIDEND_NEAR_EXISTING_ENTRY",
          severity: "warning",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: membershipId,
          message: `This dividend is within ${PROXIMITY_WINDOW_DAYS} days of an existing entry already recorded for this security -- check it is not a duplicate before committing.`,
        });
      }
    }

    let fxDirection: "native_to_home" | "home_to_native" | null = null;
    if (
      !isDividend &&
      row.normalized.purchaseExchangeRate !== null &&
      row.normalized.currency !== portfolio.homeCurrencyCode
    ) {
      const fxKey = `${row.normalized.currency}->${portfolio.homeCurrencyCode}`;
      const fxDecision = decisionFor(decisions, "fx", fxKey, row.id);
      if (
        fxDecision?.targetValue !== "native_to_home" &&
        fxDecision?.targetValue !== "home_to_native"
      ) {
        unresolved += 1;
        issues.push({
          code: "FX_DIRECTION_REQUIRED",
          severity: "error",
          rowId: row.id,
          physicalRowNumber: row.physicalRowNumber,
          sourceKey: fxKey,
          message:
            "Confirm whether the supplied exchange rate converts native currency to home currency or is inverse.",
        });
      } else {
        fxDirection = fxDecision.targetValue;
      }
    } else if (
      !isDividend &&
      row.normalized.type !== null &&
      row.normalized.currency !== portfolio.homeCurrencyCode &&
      row.normalized.purchaseExchangeRate === null
    ) {
      issues.push({
        code: "FX_RATE_INCOMPLETE",
        severity: "warning",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        message:
          "No purchase exchange rate is available; native facts remain importable but home-currency basis is incomplete.",
      });
    }

    if (
      !issues.some(
        (issue) => issue.rowId === row.id && issue.severity === "error",
      )
    ) {
      resolvedTargets[row.id] = {
        portfolioId: portfolio.id,
        portfolioSecurityId: membershipId,
        fxDirection,
      };
    }

    resolvedRows.push({
      row,
      portfolio,
      membershipId:
        membershipId ?? `cash:${portfolio.id}:${row.normalized.currency ?? ""}`,
    });
    if (row.rowClass === "transaction") {
      if (isDividend) {
        dividendCreates += 1;
      } else {
        transactionCreates += 1;
      }
    }
  }

  for (const item of resolvedRows) {
    const row = item.row;
    if (
      row.rowClass !== "transaction" ||
      row.normalized.cashEvent !== null ||
      row.normalized.type === "dividend"
    )
      continue;
    const quantity = row.normalized.sharesOwned;
    if (quantity === null || row.normalized.type === null) continue;
    const current =
      holdings.get(item.membershipId) ??
      input.existingQuantities?.[item.membershipId] ??
      "0";
    if (row.normalized.type === "buy") {
      holdings.set(item.membershipId, add(current, quantity));
      continue;
    }
    const next = subtract(current, quantity);
    if (next === null) {
      unresolved += 1;
      issues.push({
        code: "OVERSELL",
        severity: "error",
        rowId: row.id,
        physicalRowNumber: row.physicalRowNumber,
        sourceKey: item.membershipId,
        message:
          "The sell quantity exceeds the quantity available in this preview; add opening history or correct the mapping.",
      });
      holdings.set(item.membershipId, "0");
    } else {
      holdings.set(item.membershipId, next);
    }
  }

  for (const [membershipId, quantity] of holdings) {
    projectedQuantities[membershipId] = quantity;
  }

  for (const portfolio of input.portfolios) {
    const firstSell = resolvedRows.find(
      ({ row, portfolio: rowPortfolio }) =>
        rowPortfolio.id === portfolio.id && row.normalized.type === "sell",
    );
    if (firstSell && portfolio.historyCompleteFrom === null) {
      issues.push({
        code: "INCOMPLETE_HISTORY",
        severity: "warning",
        rowId: firstSell.row.id,
        physicalRowNumber: firstSell.row.physicalRowNumber,
        message:
          "This preview contains a sell without a declared opening-history boundary; completeness remains unresolved.",
      });
    }
  }

  // DIV-016 part C: advisory-only preview disclosure of the reconciliation
  // this batch's commit would apply. Built from `resolvedRows` (rows that
  // already cleared portfolio/security resolution, in the SAME shape
  // `resolvedTargets` above reflects) rather than re-walking `input.rows`,
  // so a dividend row's `membershipId` here is always the identical,
  // genuinely-resolved portfolio-security id commit-time reconciliation
  // will use. Never blocks readiness (`PROPOSED`/`AMBIGUOUS`/`ALREADY_
  // IMPORTED_MANUAL_DUPLICATE` are `info`/`warning`, never `error`) --
  // reconciliation is a commit-time decision, not a precondition for
  // staging.
  //
  // B1 (review round 1 BLOCKING fix): a row whose OWN cross-batch identity
  // (`import-fingerprint:<fingerprint>`, the exact `source_reference`
  // `db/repositories/import-commit.ts`'s dividend branch checks against
  // `dividend_manual_records` BEFORE it ever reaches the supersede step)
  // already exists from a PRIOR import never actually inserts a new row --
  // the commit loop's pre-existing cross-batch idempotency short-circuit
  // fires first and `continue`s. Proposing a reconciliation for such a row
  // was a FALSE PROMISE: the owner would read "committing will supersede
  // the manual record," commit, and get neither -- a real double count left
  // silently in place. Fixed at the root: `dividendReconciliationRows` is
  // split into `freshRows` (eligible to actually insert and therefore
  // actually reconcile) and `alreadyImportedRows` (dedupe-bound, excluded
  // from the matching pool ENTIRELY -- so they can also never wrongly
  // consume/poison a manual candidate that a sibling fresh row could
  // otherwise have cleanly, unambiguously matched). Ruling (ORCHESTRATOR,
  // ambiguous-preview-vs-commit review B1): "Reconciliation supersedes ONLY
  // via rows the CURRENT batch actually inserts."
  const dividendReconciliationRowsAll = resolvedRows
    .filter(
      ({ row }) =>
        row.rowClass === "transaction" &&
        row.normalized.type === "dividend" &&
        row.normalized.cashEvent === null &&
        row.normalized.localTradeDate !== null,
    )
    .map(({ row, portfolio, membershipId }) => ({
      rowId: row.id,
      physicalRowNumber: row.physicalRowNumber,
      portfolioId: portfolio.id,
      portfolioSecurityId: membershipId,
      paymentDate: row.normalized.localTradeDate as string,
      sourceReference: `import-fingerprint:${row.fingerprint}`,
      cashTotalDecimal: computeDividendCashTotal({
        totalCashDecimal: row.normalized.totalCashDecimal ?? null,
        sharesDecimal: row.normalized.sharesOwned,
        dividendPerShareDecimal: row.normalized.costPerShare,
      }),
    }))
    .filter(
      (entry): entry is typeof entry & { cashTotalDecimal: string } =>
        entry.cashTotalDecimal !== null,
    );
  const existingDividendSourceReferences =
    input.existingDividendSourceReferences ?? new Set<string>();
  const freshRows = dividendReconciliationRowsAll.filter(
    (row) =>
      !existingDividendSourceReferences.has(
        `${row.portfolioId}::${row.sourceReference}`,
      ),
  );
  const alreadyImportedRows = dividendReconciliationRowsAll.filter((row) =>
    existingDividendSourceReferences.has(
      `${row.portfolioId}::${row.sourceReference}`,
    ),
  );
  const reconciliationCandidates = (input.reconciliationCandidates ?? []).map(
    (candidate) => ({
      id: candidate.id,
      portfolioSecurityId: candidate.portfolioSecurityId,
      paymentDate: candidate.paymentDate,
      cashTotalDecimal: computeDividendCashTotal({
        totalCashDecimal: candidate.totalCashDecimal,
        sharesDecimal: candidate.sharesDecimal,
        dividendPerShareDecimal: candidate.dividendPerShareDecimal,
      }),
    }),
  );
  const dividendCandidatesWithCash = reconciliationCandidates.filter(
    (candidate): candidate is typeof candidate & { cashTotalDecimal: string } =>
      candidate.cashTotalDecimal !== null,
  );
  const dividendReconciliation = computeDividendReconciliation(
    freshRows,
    dividendCandidatesWithCash,
  );
  const rowById = new Map(freshRows.map((row) => [row.rowId, row]));
  const proposedReconciliations = dividendReconciliation.matches.map(
    (match) => {
      const source = rowById.get(match.rowId)!;
      return {
        rowId: match.rowId,
        physicalRowNumber: source.physicalRowNumber,
        manualRecordId: match.manualRecordId,
        portfolioSecurityId: source.portfolioSecurityId,
        paymentDate: source.paymentDate,
      };
    },
  );
  for (const match of proposedReconciliations) {
    issues.push({
      code: "DIVIDEND_RECONCILIATION_PROPOSED",
      severity: "info",
      rowId: match.rowId,
      physicalRowNumber: match.physicalRowNumber,
      sourceKey: match.manualRecordId,
      message:
        "This Sharesight dividend matches an existing manually entered record for the same security and payment date -- committing will supersede the manual record so the distribution is not double-counted.",
    });
  }
  for (const rowId of dividendReconciliation.ambiguousRowIds) {
    const source = rowById.get(rowId);
    if (!source) continue;
    issues.push({
      code: "DIVIDEND_RECONCILIATION_AMBIGUOUS",
      severity: "warning",
      rowId,
      physicalRowNumber: source.physicalRowNumber,
      sourceKey: source.portfolioSecurityId,
      message:
        "This dividend matches more than one existing entry (or an existing entry matches more than one incoming dividend) closely enough to reconcile automatically -- nothing will be linked automatically; check which record is correct before committing.",
    });
  }
  // B1 fix: a dedupe-bound row (its own source_reference already committed
  // from a PRIOR import) that WOULD otherwise have matched a manual
  // candidate gets the TRUTH instead of a false PROPOSED promise -- this
  // distribution already exists both as a previously-imported row and as a
  // manual row, and stays double-counted until the owner acts (delete the
  // manual row -- it is a deletable head -- or reverse the earlier batch and
  // re-import). Checked directly against the matching predicate (security +
  // payment date + tolerance), not through `computeDividendReconciliation`'s
  // ambiguity machinery -- this row can never actually reconcile regardless
  // of how many candidates it resembles, so "would it match at least one"
  // is the only relevant question.
  for (const row of alreadyImportedRows) {
    const wouldHaveMatched = dividendCandidatesWithCash.some(
      (candidate) =>
        candidate.portfolioSecurityId === row.portfolioSecurityId &&
        candidate.paymentDate === row.paymentDate &&
        cashTotalsWithinTolerance(
          row.cashTotalDecimal,
          candidate.cashTotalDecimal,
        ),
    );
    if (!wouldHaveMatched) continue;
    issues.push({
      code: "DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE",
      severity: "warning",
      rowId: row.rowId,
      physicalRowNumber: row.physicalRowNumber,
      sourceKey: row.portfolioSecurityId,
      message:
        "This distribution was already imported in a previous batch AND exists as a manually entered record -- it remains double-counted. This commit will not reconcile them (only rows this batch actually inserts can supersede a manual record). Delete the manual record, or reverse the earlier import batch and re-import, to resolve it.",
    });
  }

  return {
    ready: !issues.some((issue) => issue.severity === "error"),
    counts: {
      transactionCreates,
      dividendCreates,
      candidateCreates,
      skips,
      unresolved,
    },
    projectedQuantities,
    unresolvedCandidates,
    proposedReconciliations,
    resolvedTargets,
    issues,
  };
}
