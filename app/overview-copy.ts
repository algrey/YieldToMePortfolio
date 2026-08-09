import type {
  OwnedOverviewData,
  OwnedOverviewPoint,
} from "./components/portfolio-shell";

export function overviewFormulaTotal(current: OwnedOverviewPoint): string {
  return current.value === null
    ? "Total value unavailable."
    : `${current.value} known value.`;
}

export function overviewStateCopy(
  data: OwnedOverviewData,
  current: OwnedOverviewPoint,
): string | null {
  const issueReasons = data.coverage.issues.map((issue) => issue.reason);
  const hasPriceFxLimitation = issueReasons.some((reason) =>
    /price|fx|session/i.test(reason),
  );
  const hasBasisLimitation = issueReasons.some((reason) =>
    /basis/i.test(reason),
  );
  const hasQuantityLimitation = issueReasons.some((reason) =>
    /quantity/i.test(reason),
  );
  const hasHistoryLimitation = issueReasons.some((reason) =>
    /history|ledger/i.test(reason),
  );
  if (data.status === "stale") {
    return "Last-known values are retained, but one or more observations are outside the freshness policy.";
  }
  if (data.status === "partial") {
    if (hasPriceFxLimitation) {
      return "Known value excludes components without usable price, FX, or session coverage. See coverage details.";
    }
    if (hasBasisLimitation) {
      return "Known value is retained, but basis coverage is incomplete. See coverage details.";
    }
    if (hasQuantityLimitation) {
      return "Known value is retained, but quantity validation limits completeness. See coverage details.";
    }
    if (hasHistoryLimitation) {
      return "Known value is retained, but history coverage is incomplete. See coverage details.";
    }
    return "Known value is retained with partial calculation coverage. See coverage details.";
  }
  if (data.status === "incomplete") {
    return current.value === null
      ? "The published calculation retained component facts, but the portfolio total is unavailable because coverage is incomplete."
      : "The current value is known, but the published calculation has incomplete coverage.";
  }
  if (data.status === "unavailable") {
    return "Published valuation data could not be loaded.";
  }
  return null;
}
