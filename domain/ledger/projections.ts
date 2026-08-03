import {
  rebuildFifo,
  type BasisStatus,
  type FifoEvent,
  type FifoLotInput,
  type FifoRebuildResult,
} from "./fifo.ts";

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;
const PROJECTION_SCALE = 18;

type Decimal = { coefficient: bigint; scale: number };

export type ProjectionLedgerTransaction = {
  id: string;
  portfolioSecurityId: string | null;
  type: string;
  status: string;
  tradeAt: string;
  quantityDecimal: string | null;
  unitPriceDecimal: string | null;
  grossAmountDecimal: string | null;
  feeAmountDecimal: string;
  taxAmountDecimal: string;
  fxRateToBaseDecimal: string | null;
  reversesTransactionId: string | null;
};

export type ProjectionLot = {
  id: string;
  portfolioSecurityId: string;
  openingTransactionId: string;
  acquiredAt: string;
  originalQuantityDecimal: string;
  openQuantityDecimal: string;
  nativeBasisDecimal: string | null;
  baseBasisDecimal: string | null;
  basisStatus: BasisStatus;
  status: "open" | "closed" | "incomplete";
};

export type ProjectionAllocation = {
  id: string;
  portfolioSecurityId: string;
  sellTransactionId: string;
  taxLotId: string;
  allocationSequence: number;
  matchedQuantityDecimal: string;
  allocatedBaseBasisDecimal: string | null;
  baseNetProceedsDecimal: string | null;
  feeBaseDecimal: string | null;
  taxBaseDecimal: string | null;
  baseRealisedGainDecimal: string | null;
  basisStatus: BasisStatus;
};

export type ProjectionHolding = {
  id: string;
  portfolioSecurityId: string;
  quantityDecimal: string;
  nativeOpenBasisDecimal: string | null;
  baseOpenBasisDecimal: string | null;
  averageBaseCostDecimal: string | null;
  completeness: "complete" | "partial" | "incomplete";
};

export type ProjectionBuildSuccess = {
  ok: true;
  lots: ProjectionLot[];
  allocations: ProjectionAllocation[];
  holdings: ProjectionHolding[];
  reconciliation: {
    holdingQuantityEqualsOpenLots: true;
    allocationQuantityEqualsSales: true;
  };
};

export type ProjectionBuildFailure = {
  ok: false;
  reason: "invalid_decimal" | "invalid_scale" | "oversell";
  eventId: string;
};

export type ProjectionBuildResult =
  ProjectionBuildSuccess | ProjectionBuildFailure;

type SecurityEvent = {
  event: FifoEvent;
  transaction: ProjectionLedgerTransaction;
  nativeBasisDecimal: string | null;
  basisStatus: BasisStatus;
};

type NativeLot = {
  id: string;
  openQuantityDecimal: string;
  nativeBasisDecimal: string | null;
};

function parseDecimal(value: string): Decimal | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
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

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * powerOfTen(scale - left.scale) +
      right.coefficient * powerOfTen(scale - right.scale),
    scale,
  };
}

function subtract(left: Decimal, right: Decimal): Decimal | null {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * powerOfTen(scale - left.scale);
  const rightCoefficient = right.coefficient * powerOfTen(scale - right.scale);
  if (leftCoefficient < rightCoefficient) return null;
  return { coefficient: leftCoefficient - rightCoefficient, scale };
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return {
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  };
}

function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = remainder * 2n;
  if (
    doubled > denominator ||
    (doubled === denominator && quotient % 2n !== 0n)
  ) {
    return quotient + 1n;
  }
  return quotient;
}

function divideRounded(
  numerator: Decimal,
  denominator: Decimal,
  scale = PROJECTION_SCALE,
): Decimal | null {
  if (denominator.coefficient === 0n) return null;
  const exponent = scale + denominator.scale - numerator.scale;
  const scaledNumerator =
    exponent >= 0
      ? numerator.coefficient * powerOfTen(exponent)
      : numerator.coefficient / powerOfTen(-exponent);
  return {
    coefficient: roundHalfEven(scaledNumerator, denominator.coefficient),
    scale,
  };
}

function positive(value: string | null): Decimal | null {
  const parsed = value === null ? null : parseDecimal(value);
  return parsed && parsed.coefficient > 0n ? parsed : null;
}

function nonNegative(value: string): Decimal | null {
  const parsed = parseDecimal(value);
  return parsed && parsed.coefficient >= 0n ? parsed : null;
}

function sum(values: Array<string | null>): string | null {
  let total: Decimal = { coefficient: 0n, scale: 0 };
  for (const value of values) {
    if (value === null) return null;
    const parsed = nonNegative(value);
    if (!parsed) return null;
    total = add(total, parsed);
  }
  return normalize(total);
}

function multiplyStrings(left: string, right: string): string | null {
  const parsedLeft = nonNegative(left);
  const parsedRight = nonNegative(right);
  return parsedLeft && parsedRight
    ? normalize(multiply(parsedLeft, parsedRight))
    : null;
}

function basisStatus(
  nativeBasisDecimal: string | null,
  fxRateToBaseDecimal: string | null,
): BasisStatus {
  if (nativeBasisDecimal === null) return "incomplete_basis";
  if (fxRateToBaseDecimal === null) return "incomplete_fx";
  return positive(fxRateToBaseDecimal) === null
    ? "incomplete_basis"
    : "complete";
}

function nativeBasis(transaction: ProjectionLedgerTransaction): string | null {
  const gross =
    transaction.grossAmountDecimal ??
    (transaction.quantityDecimal && transaction.unitPriceDecimal
      ? multiplyStrings(
          transaction.quantityDecimal,
          transaction.unitPriceDecimal,
        )
      : null);
  if (gross === null) return null;
  return sum([
    gross,
    transaction.feeAmountDecimal,
    transaction.taxAmountDecimal,
  ]);
}

function baseAmount(
  nativeAmount: string | null,
  fxRateToBaseDecimal: string | null,
): string | null {
  return nativeAmount === null || fxRateToBaseDecimal === null
    ? null
    : multiplyStrings(nativeAmount, fxRateToBaseDecimal);
}

function eventForTransaction(
  transaction: ProjectionLedgerTransaction,
): SecurityEvent | ProjectionBuildFailure | null {
  if (transaction.status !== "posted" && transaction.status !== "reversed") {
    return null;
  }
  if (transaction.reversesTransactionId !== null) {
    return {
      event: {
        kind: "reversal",
        eventId: transaction.id,
        effectiveAt: transaction.tradeAt,
        reversesEventId: transaction.reversesTransactionId,
      },
      transaction,
      nativeBasisDecimal: null,
      basisStatus: "complete",
    };
  }
  if (transaction.portfolioSecurityId === null) return null;

  if (transaction.type === "buy") {
    const quantity = positive(transaction.quantityDecimal);
    if (!quantity) {
      return { ok: false, reason: "invalid_decimal", eventId: transaction.id };
    }
    const native = nativeBasis(transaction);
    const status = basisStatus(native, transaction.fxRateToBaseDecimal);
    const gross =
      transaction.grossAmountDecimal ??
      (transaction.unitPriceDecimal
        ? multiplyStrings(normalize(quantity), transaction.unitPriceDecimal)
        : null);
    const lot: FifoLotInput = {
      id: transaction.id,
      acquiredAt: transaction.tradeAt,
      openingTransactionId: transaction.id,
      quantityDecimal: normalize(quantity),
      costBasisBaseDecimal:
        status === "complete"
          ? baseAmount(gross, transaction.fxRateToBaseDecimal)
          : null,
      acquisitionFeeBaseDecimal:
        status === "complete"
          ? baseAmount(
              transaction.feeAmountDecimal,
              transaction.fxRateToBaseDecimal,
            )
          : null,
      acquisitionTaxBaseDecimal:
        status === "complete"
          ? baseAmount(
              transaction.taxAmountDecimal,
              transaction.fxRateToBaseDecimal,
            )
          : null,
      basisStatus: status,
    };
    return {
      event: {
        kind: "buy",
        eventId: transaction.id,
        effectiveAt: transaction.tradeAt,
        lot,
      },
      transaction,
      nativeBasisDecimal: native,
      basisStatus: status,
    };
  }

  if (transaction.type === "sell") {
    const quantity = positive(transaction.quantityDecimal);
    if (!quantity) {
      return { ok: false, reason: "invalid_decimal", eventId: transaction.id };
    }
    const gross =
      transaction.grossAmountDecimal ??
      (transaction.unitPriceDecimal
        ? multiplyStrings(normalize(quantity), transaction.unitPriceDecimal)
        : null);
    if (gross === null || nonNegative(gross) === null) {
      return { ok: false, reason: "invalid_decimal", eventId: transaction.id };
    }
    const proceedsStatus: BasisStatus =
      transaction.fxRateToBaseDecimal === null
        ? "incomplete_fx"
        : positive(transaction.fxRateToBaseDecimal) === null
          ? "incomplete_basis"
          : "complete";
    return {
      event: {
        kind: "sell",
        eventId: transaction.id,
        effectiveAt: transaction.tradeAt,
        sale: {
          transactionId: transaction.id,
          quantityDecimal: normalize(quantity),
          netProceedsBaseDecimal: baseAmount(
            gross,
            transaction.fxRateToBaseDecimal,
          ),
          feeBaseDecimal: baseAmount(
            transaction.feeAmountDecimal,
            transaction.fxRateToBaseDecimal,
          ),
          taxBaseDecimal: baseAmount(
            transaction.taxAmountDecimal,
            transaction.fxRateToBaseDecimal,
          ),
          proceedsStatus,
        },
      },
      transaction,
      nativeBasisDecimal: null,
      basisStatus: proceedsStatus,
    };
  }

  if (transaction.type === "split") {
    const numerator = positive(transaction.quantityDecimal);
    const denominator = positive(transaction.unitPriceDecimal);
    if (!numerator || !denominator) {
      return { ok: false, reason: "invalid_decimal", eventId: transaction.id };
    }
    return {
      event: {
        kind: "split",
        eventId: transaction.id,
        effectiveAt: transaction.tradeAt,
        split: {
          numeratorDecimal: normalize(numerator),
          denominatorDecimal: normalize(denominator),
        },
      },
      transaction,
      nativeBasisDecimal: null,
      basisStatus: "complete",
    };
  }

  return null;
}

function activeSecurityEvents(events: SecurityEvent[]): SecurityEvent[] {
  const reversed = new Set(
    events
      .filter((entry) => entry.event.kind === "reversal")
      .map((entry) =>
        entry.event.kind === "reversal" ? entry.event.reversesEventId : "",
      ),
  );
  return events
    .filter(
      (entry) =>
        entry.event.kind === "reversal" || !reversed.has(entry.event.eventId),
    )
    .filter((entry) => entry.event.kind !== "reversal")
    .sort(
      (left, right) =>
        left.event.effectiveAt.localeCompare(right.event.effectiveAt) ||
        left.event.eventId.localeCompare(right.event.eventId),
    );
}

function updateNativeLots(
  events: SecurityEvent[],
  fifo: FifoRebuildResult,
): Map<string, NativeLot> {
  const nativeLots = new Map<string, NativeLot>();
  const active = activeSecurityEvents(events);
  for (const entry of active) {
    if (entry.event.kind === "buy") {
      nativeLots.set(entry.event.lot.id, {
        id: entry.event.lot.id,
        openQuantityDecimal: entry.event.lot.quantityDecimal,
        nativeBasisDecimal: entry.nativeBasisDecimal,
      });
      continue;
    }
    if (entry.event.kind === "split") {
      const numerator = positive(entry.event.split.numeratorDecimal);
      const denominator = positive(entry.event.split.denominatorDecimal);
      if (!numerator || !denominator) continue;
      for (const lot of nativeLots.values()) {
        const quantity = positive(lot.openQuantityDecimal);
        const adjusted = quantity
          ? divideRounded(multiply(quantity, numerator), denominator)
          : null;
        if (adjusted) lot.openQuantityDecimal = normalize(adjusted);
      }
      continue;
    }
    if (entry.event.kind !== "sell") continue;
    const sale = fifo.allocations.filter(
      (allocation) => allocation.saleTransactionId === entry.transaction.id,
    );
    for (const allocation of sale) {
      const lot = nativeLots.get(allocation.lotId);
      if (!lot) continue;
      const openQuantity = positive(lot.openQuantityDecimal);
      const matchedQuantity = positive(allocation.quantityDecimal);
      if (!openQuantity || !matchedQuantity) continue;
      if (lot.nativeBasisDecimal !== null) {
        const basis = nonNegative(lot.nativeBasisDecimal);
        const allocated = basis
          ? divideRounded(multiply(basis, matchedQuantity), openQuantity)
          : null;
        if (basis && allocated) {
          const remaining = subtract(basis, allocated);
          lot.nativeBasisDecimal = remaining ? normalize(remaining) : null;
        } else {
          lot.nativeBasisDecimal = null;
        }
      }
      const remainingQuantity = subtract(openQuantity, matchedQuantity);
      if (remainingQuantity)
        lot.openQuantityDecimal = normalize(remainingQuantity);
    }
  }
  return nativeLots;
}

function buildSecurity(
  securityId: string,
  entries: SecurityEvent[],
):
  | {
      lots: ProjectionLot[];
      allocations: ProjectionAllocation[];
      holding: ProjectionHolding;
    }
  | ProjectionBuildFailure {
  const fifo = rebuildFifo(entries.map((entry) => entry.event));
  if (!fifo.ok) {
    return { ok: false, reason: fifo.reason, eventId: fifo.eventId };
  }
  const nativeLots = updateNativeLots(entries, fifo);
  const remainingById = new Map(fifo.remainingLots.map((lot) => [lot.id, lot]));
  const lots = entries
    .filter(
      (
        entry,
      ): entry is SecurityEvent & {
        event: Extract<FifoEvent, { kind: "buy" }>;
      } => entry.event.kind === "buy",
    )
    .map((entry) => {
      const remaining = remainingById.get(entry.event.lot.id);
      const native = nativeLots.get(entry.event.lot.id);
      const openQuantity = remaining?.openQuantityDecimal ?? "0";
      const isOpen = openQuantity !== "0";
      return {
        id: entry.event.lot.id,
        portfolioSecurityId: securityId,
        openingTransactionId: entry.transaction.id,
        acquiredAt: entry.transaction.tradeAt,
        originalQuantityDecimal: entry.event.lot.quantityDecimal,
        openQuantityDecimal: openQuantity,
        nativeBasisDecimal: isOpen ? (native?.nativeBasisDecimal ?? null) : "0",
        baseBasisDecimal: isOpen
          ? (remaining?.remainingBasisBaseDecimal ?? null)
          : "0",
        basisStatus: entry.basisStatus,
        status: !isOpen
          ? "closed"
          : entry.basisStatus === "complete"
            ? "open"
            : "incomplete",
      } satisfies ProjectionLot;
    });
  const allocations = fifo.allocations.map(
    (allocation) =>
      ({
        id: `${allocation.saleTransactionId}:${allocation.allocationSequence}`,
        portfolioSecurityId: securityId,
        sellTransactionId: allocation.saleTransactionId,
        taxLotId: allocation.lotId,
        allocationSequence: allocation.allocationSequence,
        matchedQuantityDecimal: allocation.quantityDecimal,
        allocatedBaseBasisDecimal: allocation.baseBasisDecimal,
        baseNetProceedsDecimal: allocation.netProceedsBaseDecimal,
        feeBaseDecimal: allocation.feeBaseDecimal,
        taxBaseDecimal: allocation.taxBaseDecimal,
        baseRealisedGainDecimal: allocation.baseRealisedGainDecimal,
        basisStatus: allocation.basisStatus,
      }) satisfies ProjectionAllocation,
  );
  const openLots = lots.filter((lot) => lot.openQuantityDecimal !== "0");
  const quantityDecimal =
    sum(openLots.map((lot) => lot.openQuantityDecimal)) ?? "0";
  const openLotQuantityMatchesHolding =
    quantityDecimal ===
    (sum([...nativeLots.values()].map((lot) => lot.openQuantityDecimal)) ??
      "0");
  const unmatchedSale = activeSecurityEvents(entries).find((entry) => {
    if (entry.event.kind !== "sell") return false;
    const allocatedQuantity = sum(
      fifo.allocations
        .filter(
          (allocation) => allocation.saleTransactionId === entry.transaction.id,
        )
        .map((allocation) => allocation.quantityDecimal),
    );
    return allocatedQuantity !== entry.event.sale.quantityDecimal;
  });
  if (!openLotQuantityMatchesHolding || unmatchedSale) {
    return {
      ok: false,
      reason: "invalid_decimal",
      eventId: unmatchedSale?.transaction.id ?? securityId,
    };
  }
  const nativeOpenBasisDecimal = sum(
    openLots.map((lot) => lot.nativeBasisDecimal),
  );
  const baseOpenBasisDecimal = sum(openLots.map((lot) => lot.baseBasisDecimal));
  const quantity = positive(quantityDecimal);
  const averageBaseCostDecimal =
    quantity && baseOpenBasisDecimal !== null
      ? (() => {
          const base = nonNegative(baseOpenBasisDecimal);
          const average = base ? divideRounded(base, quantity) : null;
          return average ? normalize(average) : null;
        })()
      : null;
  const completeness = openLots.some((lot) => lot.basisStatus !== "complete")
    ? "incomplete"
    : "complete";
  return {
    lots,
    allocations,
    holding: {
      id: `holding:${securityId}`,
      portfolioSecurityId: securityId,
      quantityDecimal,
      nativeOpenBasisDecimal,
      baseOpenBasisDecimal,
      averageBaseCostDecimal,
      completeness,
    },
  };
}

export function buildLedgerProjections(
  transactions: ProjectionLedgerTransaction[],
): ProjectionBuildResult {
  const bySecurity = new Map<string, SecurityEvent[]>();
  for (const transaction of transactions) {
    const entry = eventForTransaction(transaction);
    if (entry === null) continue;
    if ("ok" in entry) return entry;
    if (entry.transaction.portfolioSecurityId === null) continue;
    const entries = bySecurity.get(entry.transaction.portfolioSecurityId) ?? [];
    entries.push(entry);
    bySecurity.set(entry.transaction.portfolioSecurityId, entries);
  }

  const lots: ProjectionLot[] = [];
  const allocations: ProjectionAllocation[] = [];
  const holdings: ProjectionHolding[] = [];
  for (const [securityId, entries] of [...bySecurity.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const result = buildSecurity(securityId, entries);
    if ("ok" in result) return result;
    lots.push(...result.lots);
    allocations.push(...result.allocations);
    holdings.push(result.holding);
  }

  return {
    ok: true,
    lots,
    allocations,
    holdings,
    reconciliation: {
      holdingQuantityEqualsOpenLots: true,
      allocationQuantityEqualsSales: true,
    },
  };
}
