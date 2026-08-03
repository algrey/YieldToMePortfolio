import {
  DECIMAL_LIMITS,
  addDecimal,
  allocateProportional,
  compareDecimal,
  divideDecimal,
  formatDecimalExact,
  formatDecimalTrimmed,
  fromInteger,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";

const DEFAULT_ALLOCATION_SCALE = DECIMAL_LIMITS.allocationScale;
const ZERO = fromInteger(0n);

export type BasisStatus = "complete" | "incomplete_fx" | "incomplete_basis";

export type FifoLotInput = {
  id: string;
  acquiredAt: string;
  openingTransactionId: string;
  quantityDecimal: string;
  costBasisBaseDecimal: string | null;
  acquisitionFeeBaseDecimal: string | null;
  acquisitionTaxBaseDecimal: string | null;
  basisStatus?: BasisStatus;
};

export type FifoLot = {
  id: string;
  acquiredAt: string;
  openingTransactionId: string;
  openQuantityDecimal: string;
  remainingBasisBaseDecimal: string | null;
  basisStatus: BasisStatus;
};

export type FifoSaleInput = {
  transactionId: string;
  quantityDecimal: string;
  netProceedsBaseDecimal: string | null;
  feeBaseDecimal: string | null;
  taxBaseDecimal: string | null;
  proceedsStatus?: BasisStatus;
};

export type FifoAllocation = {
  saleTransactionId: string;
  lotId: string;
  allocationSequence: number;
  quantityDecimal: string;
  baseBasisDecimal: string | null;
  netProceedsBaseDecimal: string | null;
  feeBaseDecimal: string | null;
  taxBaseDecimal: string | null;
  baseRealisedGainDecimal: string | null;
  basisStatus: BasisStatus;
};

export type FifoAllocationSuccess = {
  ok: true;
  allocations: FifoAllocation[];
  remainingLots: FifoLot[];
  matchedQuantityDecimal: string;
  unmatchedQuantityDecimal: "0";
};

export type FifoAllocationFailure = {
  ok: false;
  reason: "invalid_decimal" | "invalid_scale" | "oversell";
  allocations: FifoAllocation[];
  remainingLots: FifoLot[];
  matchedQuantityDecimal: string;
  unmatchedQuantityDecimal: string;
};

export type FifoAllocationResult =
  FifoAllocationSuccess | FifoAllocationFailure;

export type FifoSplitInput = {
  numeratorDecimal: string;
  denominatorDecimal: string;
};

export type FifoEvent =
  | {
      kind: "buy";
      eventId: string;
      effectiveAt: string;
      lot: FifoLotInput;
    }
  | {
      kind: "sell";
      eventId: string;
      effectiveAt: string;
      sale: FifoSaleInput;
    }
  | {
      kind: "split";
      eventId: string;
      effectiveAt: string;
      split: FifoSplitInput;
    }
  | {
      kind: "reversal";
      eventId: string;
      effectiveAt: string;
      reversesEventId: string;
    };

export type FifoRebuildSuccess = {
  ok: true;
  allocations: FifoAllocation[];
  remainingLots: FifoLot[];
};

export type FifoRebuildFailure = {
  ok: false;
  reason: FifoAllocationFailure["reason"];
  eventId: string;
  allocations: FifoAllocation[];
  remainingLots: FifoLot[];
};

export type FifoRebuildResult = FifoRebuildSuccess | FifoRebuildFailure;

function normalizeDecimal(value: DecimalFraction): string {
  return formatDecimalExact(value);
}

function positiveDecimal(value: string): DecimalFraction | null {
  try {
    const parsed = parseDecimal(value);
    return compareDecimal(parsed, ZERO) > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function zeroOrPositiveDecimal(value: string): DecimalFraction | null {
  try {
    const parsed = parseDecimal(value);
    return compareDecimal(parsed, ZERO) >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function statusForLot(input: FifoLotInput): BasisStatus {
  if (input.basisStatus) {
    return input.basisStatus;
  }
  return input.costBasisBaseDecimal === null ||
    input.acquisitionFeeBaseDecimal === null ||
    input.acquisitionTaxBaseDecimal === null
    ? "incomplete_basis"
    : "complete";
}

function statusForSale(input: FifoSaleInput): BasisStatus {
  if (input.proceedsStatus) {
    return input.proceedsStatus;
  }

  return input.netProceedsBaseDecimal === null
    ? "incomplete_basis"
    : "complete";
}

export function createFifoLot(input: FifoLotInput): FifoLot | null {
  const quantity = positiveDecimal(input.quantityDecimal);
  if (!quantity) {
    return null;
  }

  const status = statusForLot(input);
  if (status !== "complete") {
    return {
      id: input.id,
      acquiredAt: input.acquiredAt,
      openingTransactionId: input.openingTransactionId,
      openQuantityDecimal: normalizeDecimal(quantity),
      remainingBasisBaseDecimal: null,
      basisStatus: status,
    };
  }

  const cost = zeroOrPositiveDecimal(input.costBasisBaseDecimal ?? "");
  const fee = zeroOrPositiveDecimal(input.acquisitionFeeBaseDecimal ?? "");
  const tax = zeroOrPositiveDecimal(input.acquisitionTaxBaseDecimal ?? "");
  if (!cost || !fee || !tax) {
    return null;
  }

  return {
    id: input.id,
    acquiredAt: input.acquiredAt,
    openingTransactionId: input.openingTransactionId,
    openQuantityDecimal: normalizeDecimal(quantity),
    remainingBasisBaseDecimal: normalizeDecimal(
      addDecimal(addDecimal(cost, fee), tax),
    ),
    basisStatus: "complete",
  };
}

function compareLots(left: FifoLot, right: FifoLot): number {
  return (
    left.acquiredAt.localeCompare(right.acquiredAt) ||
    left.openingTransactionId.localeCompare(right.openingTransactionId) ||
    left.id.localeCompare(right.id)
  );
}

function validateScale(scale: number): boolean {
  return (
    Number.isSafeInteger(scale) &&
    scale >= 0 &&
    scale <= DECIMAL_LIMITS.allocationScale
  );
}

function allocateTotal(
  total: string | null,
  matchedQuantity: DecimalFraction,
  saleQuantity: DecimalFraction,
  final: boolean,
  allocated: DecimalFraction,
  scale: number,
): { value: string | null; nextAllocated: DecimalFraction } {
  if (total === null) {
    return { value: null, nextAllocated: allocated };
  }

  const parsedTotal = zeroOrPositiveDecimal(total);
  if (!parsedTotal) {
    return { value: null, nextAllocated: allocated };
  }

  const allocation = allocateProportional({
    totalDecimal: normalizeDecimal(parsedTotal),
    partDecimal: normalizeDecimal(matchedQuantity),
    denominatorDecimal: normalizeDecimal(saleQuantity),
    allocatedDecimal: normalizeDecimal(allocated),
    isFinal: final,
    scale,
  });
  if (!allocation.ok) {
    return { value: null, nextAllocated: allocated };
  }

  return {
    value: allocation.valueDecimal,
    nextAllocated: parseDecimal(allocation.nextAllocatedDecimal),
  };
}

export function allocateFifoSale(
  lots: FifoLot[],
  sale: FifoSaleInput,
  allocationScale: number = DEFAULT_ALLOCATION_SCALE,
): FifoAllocationResult {
  const saleQuantity = positiveDecimal(sale.quantityDecimal);
  const invalidLot = lots.some(
    (lot) =>
      positiveDecimal(lot.openQuantityDecimal) === null ||
      (lot.remainingBasisBaseDecimal !== null &&
        zeroOrPositiveDecimal(lot.remainingBasisBaseDecimal) === null),
  );
  const invalidSaleAmount = [
    sale.netProceedsBaseDecimal,
    sale.feeBaseDecimal,
    sale.taxBaseDecimal,
  ].some((value) => value !== null && zeroOrPositiveDecimal(value) === null);
  if (
    !saleQuantity ||
    invalidLot ||
    invalidSaleAmount ||
    !validateScale(allocationScale)
  ) {
    return {
      ok: false,
      reason:
        saleQuantity && !invalidLot && !invalidSaleAmount
          ? "invalid_scale"
          : "invalid_decimal",
      allocations: [],
      remainingLots: [...lots],
      matchedQuantityDecimal: "0",
      unmatchedQuantityDecimal: sale.quantityDecimal,
    };
  }

  const orderedLots = lots.slice().sort(compareLots);
  const matches: Array<{ lot: FifoLot; quantity: DecimalFraction }> = [];
  let remainingSale = saleQuantity;
  let matchedQuantity = ZERO;

  for (const lot of orderedLots) {
    if (compareDecimal(remainingSale, ZERO) === 0) {
      break;
    }
    const openQuantity = positiveDecimal(lot.openQuantityDecimal);
    if (!openQuantity) {
      continue;
    }
    const matched =
      compareDecimal(openQuantity, remainingSale) <= 0
        ? openQuantity
        : remainingSale;
    remainingSale = subtractDecimal(remainingSale, matched);
    matchedQuantity = addDecimal(matchedQuantity, matched);
    matches.push({ lot, quantity: matched });
  }

  const unmatched = normalizeDecimal(remainingSale);
  if (compareDecimal(remainingSale, ZERO) > 0) {
    return {
      ok: false,
      reason: "oversell",
      allocations: [],
      remainingLots: orderedLots,
      matchedQuantityDecimal: normalizeDecimal(matchedQuantity),
      unmatchedQuantityDecimal: unmatched,
    };
  }

  const allocations: FifoAllocation[] = [];
  let allocatedProceeds = ZERO;
  let allocatedFees = ZERO;
  let allocatedTaxes = ZERO;
  const nextLots = orderedLots.map((lot) => ({ ...lot }));

  matches.forEach(({ lot, quantity }, index) => {
    const isFinal = index === matches.length - 1;
    const matchedLot = nextLots.find((candidate) => candidate.id === lot.id)!;
    const openQuantity = positiveDecimal(lot.openQuantityDecimal)!;
    const remainingQuantity = subtractDecimal(openQuantity, quantity);
    matchedLot.openQuantityDecimal = normalizeDecimal(remainingQuantity);

    let basis: string | null = null;
    if (lot.remainingBasisBaseDecimal !== null) {
      const lotBasis =
        positiveDecimal(lot.remainingBasisBaseDecimal) ??
        zeroOrPositiveDecimal(lot.remainingBasisBaseDecimal);
      if (lotBasis) {
        const basisAllocation = allocateTotal(
          lot.remainingBasisBaseDecimal,
          quantity,
          openQuantity,
          false,
          ZERO,
          allocationScale,
        );
        basis = basisAllocation.value;
      }
    }

    if (basis !== null) {
      const basisDecimal = parseDecimal(basis)!;
      matchedLot.remainingBasisBaseDecimal = normalizeDecimal(
        subtractDecimal(
          parseDecimal(lot.remainingBasisBaseDecimal!),
          basisDecimal,
        ),
      );
    }

    const feeAllocation = allocateTotal(
      sale.feeBaseDecimal,
      quantity,
      saleQuantity,
      isFinal,
      allocatedFees,
      allocationScale,
    );
    allocatedFees = feeAllocation.nextAllocated;
    const proceedsAllocation = allocateTotal(
      sale.netProceedsBaseDecimal,
      quantity,
      saleQuantity,
      isFinal,
      allocatedProceeds,
      allocationScale,
    );
    allocatedProceeds = proceedsAllocation.nextAllocated;
    const taxAllocation = allocateTotal(
      sale.taxBaseDecimal,
      quantity,
      saleQuantity,
      isFinal,
      allocatedTaxes,
      allocationScale,
    );
    allocatedTaxes = taxAllocation.nextAllocated;

    const saleStatus = statusForSale(sale);
    const status: BasisStatus =
      lot.basisStatus === "complete" && saleStatus === "complete"
        ? "complete"
        : lot.basisStatus === "incomplete_fx" || saleStatus === "incomplete_fx"
          ? "incomplete_fx"
          : "incomplete_basis";
    let gain: string | null = null;
    if (
      status === "complete" &&
      proceedsAllocation.value !== null &&
      basis !== null
    ) {
      const proceeds = zeroOrPositiveDecimal(proceedsAllocation.value);
      const fee =
        feeAllocation.value === null ? ZERO : parseDecimal(feeAllocation.value);
      const tax =
        taxAllocation.value === null ? ZERO : parseDecimal(taxAllocation.value);
      if (proceeds) {
        const net = subtractDecimal(subtractDecimal(proceeds, fee), tax);
        gain = normalizeDecimal(subtractDecimal(net, parseDecimal(basis)));
      }
    }

    allocations.push({
      saleTransactionId: sale.transactionId,
      lotId: lot.id,
      allocationSequence: index + 1,
      quantityDecimal: normalizeDecimal(quantity),
      baseBasisDecimal: basis,
      netProceedsBaseDecimal: proceedsAllocation.value,
      feeBaseDecimal: feeAllocation.value,
      taxBaseDecimal: taxAllocation.value,
      baseRealisedGainDecimal: gain,
      basisStatus: status,
    });
  });

  return {
    ok: true,
    allocations,
    remainingLots: nextLots.filter((lot) => lot.openQuantityDecimal !== "0"),
    matchedQuantityDecimal: normalizeDecimal(matchedQuantity),
    unmatchedQuantityDecimal: "0",
  };
}

export function applyFifoSplit(
  lots: FifoLot[],
  split: FifoSplitInput,
): FifoLot[] | null {
  const numerator = positiveDecimal(split.numeratorDecimal);
  const denominator = positiveDecimal(split.denominatorDecimal);
  if (
    !numerator ||
    !denominator ||
    lots.some((lot) => positiveDecimal(lot.openQuantityDecimal) === null)
  ) {
    return null;
  }

  return lots.map((lot) => {
    const quantity = positiveDecimal(lot.openQuantityDecimal)!;
    const adjusted = roundDecimal(
      divideDecimal(multiplyDecimal(quantity, numerator), denominator),
      DECIMAL_LIMITS.allocationScale,
    );
    return {
      ...lot,
      openQuantityDecimal: formatDecimalTrimmed(
        adjusted,
        DECIMAL_LIMITS.allocationScale,
      ),
    };
  });
}

export function rebuildFifo(events: FifoEvent[]): FifoRebuildResult {
  const reversed = new Set(
    events
      .filter(
        (event): event is Extract<FifoEvent, { kind: "reversal" }> =>
          event.kind === "reversal",
      )
      .map((event) => event.reversesEventId),
  );
  const activeEvents = events
    .filter(
      (event) => event.kind !== "reversal" && !reversed.has(event.eventId),
    )
    .sort(
      (left, right) =>
        left.effectiveAt.localeCompare(right.effectiveAt) ||
        left.eventId.localeCompare(right.eventId),
    );
  let lots: FifoLot[] = [];
  let allocations: FifoAllocation[] = [];

  for (const event of activeEvents) {
    if (event.kind === "buy") {
      const lot = createFifoLot(event.lot);
      if (!lot) {
        return {
          ok: false,
          reason: "invalid_decimal",
          eventId: event.eventId,
          allocations,
          remainingLots: lots,
        };
      }
      lots.push(lot);
      continue;
    }
    if (event.kind === "split") {
      const splitLots = applyFifoSplit(lots, event.split);
      if (!splitLots) {
        return {
          ok: false,
          reason: "invalid_decimal",
          eventId: event.eventId,
          allocations,
          remainingLots: lots,
        };
      }
      lots = splitLots;
      continue;
    }

    if (event.kind === "reversal") {
      continue;
    }

    const result = allocateFifoSale(lots, event.sale);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        eventId: event.eventId,
        allocations: [...allocations, ...result.allocations],
        remainingLots: result.remainingLots,
      };
    }
    allocations = [...allocations, ...result.allocations];
    lots = result.remainingLots;
  }

  return { ok: true, allocations, remainingLots: lots };
}
