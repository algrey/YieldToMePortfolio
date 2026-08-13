import type { NormalizedImportRow } from "./strict-versioned-parser.ts";

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
    | "ROW_UNSUPPORTED";
  severity: "error" | "warning" | "info";
  rowId?: string;
  physicalRowNumber?: number;
  sourceKey?: string;
  message: string;
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
          normalized(candidate.sourceCurrencyCode) ===
            normalized(row.normalized.currency ?? ""),
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
    resolvedTargets,
    issues,
  };
}
