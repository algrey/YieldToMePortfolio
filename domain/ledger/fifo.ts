const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;
const DEFAULT_ALLOCATION_SCALE = 8;

type Decimal = {
  coefficient: bigint;
  scale: number;
};

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

function parseDecimal(value: string): Decimal | null {
  if (!DECIMAL_PATTERN.test(value)) {
    return null;
  }

  const [whole, fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function normalizeDecimal(value: Decimal): string {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }

  if (scale === 0) {
    return coefficient.toString();
  }

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
  if (leftCoefficient < rightCoefficient) {
    return null;
  }

  return { coefficient: leftCoefficient - rightCoefficient, scale };
}

function compare(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * powerOfTen(scale - left.scale);
  const rightCoefficient = right.coefficient * powerOfTen(scale - right.scale);
  return leftCoefficient === rightCoefficient
    ? 0
    : leftCoefficient < rightCoefficient
      ? -1
      : 1;
}

function signedDifference(left: Decimal, right: Decimal): string {
  if (compare(left, right) >= 0) {
    return normalizeDecimal(subtract(left, right)!);
  }
  return `-${normalizeDecimal(subtract(right, left)!)}`;
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
  scale: number,
): Decimal | null {
  if (denominator.coefficient === 0n || scale < 0 || scale > 18) {
    return null;
  }

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

function positiveDecimal(value: string): Decimal | null {
  const parsed = parseDecimal(value);
  return parsed && parsed.coefficient > 0n ? parsed : null;
}

function zeroOrPositiveDecimal(value: string): Decimal | null {
  const parsed = parseDecimal(value);
  return parsed && parsed.coefficient >= 0n ? parsed : null;
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
    remainingBasisBaseDecimal: normalizeDecimal(add(add(cost, fee), tax)),
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
  return Number.isInteger(scale) && scale >= 0 && scale <= 18;
}

function allocateTotal(
  total: string | null,
  matchedQuantity: Decimal,
  saleQuantity: Decimal,
  final: boolean,
  allocated: Decimal,
  scale: number,
): { value: string | null; nextAllocated: Decimal } {
  if (total === null) {
    return { value: null, nextAllocated: allocated };
  }

  const parsedTotal = zeroOrPositiveDecimal(total);
  if (!parsedTotal) {
    return { value: null, nextAllocated: allocated };
  }

  if (final) {
    const remainder = subtract(parsedTotal, allocated);
    return remainder
      ? { value: normalizeDecimal(remainder), nextAllocated: parsedTotal }
      : { value: null, nextAllocated: allocated };
  }

  const portion = divideRounded(
    multiply(parsedTotal, matchedQuantity),
    saleQuantity,
    scale,
  );
  if (!portion) {
    return { value: null, nextAllocated: allocated };
  }

  return {
    value: normalizeDecimal(portion),
    nextAllocated: add(allocated, portion),
  };
}

export function allocateFifoSale(
  lots: FifoLot[],
  sale: FifoSaleInput,
  allocationScale = DEFAULT_ALLOCATION_SCALE,
): FifoAllocationResult {
  const saleQuantity = positiveDecimal(sale.quantityDecimal);
  if (!saleQuantity || !validateScale(allocationScale)) {
    return {
      ok: false,
      reason: saleQuantity ? "invalid_scale" : "invalid_decimal",
      allocations: [],
      remainingLots: [...lots],
      matchedQuantityDecimal: "0",
      unmatchedQuantityDecimal: sale.quantityDecimal,
    };
  }

  const orderedLots = lots.slice().sort(compareLots);
  const matches: Array<{ lot: FifoLot; quantity: Decimal }> = [];
  let remainingSale = saleQuantity;
  let matchedQuantity: Decimal = { coefficient: 0n, scale: 0 };

  for (const lot of orderedLots) {
    if (remainingSale.coefficient === 0n) {
      break;
    }
    const openQuantity = positiveDecimal(lot.openQuantityDecimal);
    if (!openQuantity) {
      continue;
    }
    const alignedScale = Math.max(openQuantity.scale, remainingSale.scale);
    const quantityAtScale =
      openQuantity.coefficient * powerOfTen(alignedScale - openQuantity.scale);
    const remainingAtScale =
      remainingSale.coefficient *
      powerOfTen(alignedScale - remainingSale.scale);
    const matchedAtScale =
      quantityAtScale <= remainingAtScale ? quantityAtScale : remainingAtScale;
    const matched = { coefficient: matchedAtScale, scale: alignedScale };
    const nextRemaining = remainingAtScale - matchedAtScale;
    remainingSale = { coefficient: nextRemaining, scale: alignedScale };
    matchedQuantity = add(matchedQuantity, matched);
    matches.push({ lot, quantity: matched });
  }

  const unmatched = normalizeDecimal(remainingSale);
  if (remainingSale.coefficient > 0n) {
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
  let allocatedBasis: Decimal = { coefficient: 0n, scale: 0 };
  let allocatedProceeds: Decimal = { coefficient: 0n, scale: 0 };
  let allocatedFees: Decimal = { coefficient: 0n, scale: 0 };
  let allocatedTaxes: Decimal = { coefficient: 0n, scale: 0 };
  const nextLots = orderedLots.map((lot) => ({ ...lot }));

  matches.forEach(({ lot, quantity }, index) => {
    const isFinal = index === matches.length - 1;
    const matchedLot = nextLots.find((candidate) => candidate.id === lot.id)!;
    const openQuantity = positiveDecimal(lot.openQuantityDecimal)!;
    const remainingQuantity = subtract(openQuantity, quantity)!;
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
          { coefficient: 0n, scale: 0 },
          allocationScale,
        );
        basis = basisAllocation.value;
      }
    }

    if (basis !== null) {
      const basisDecimal = parseDecimal(basis)!;
      allocatedBasis = add(allocatedBasis, basisDecimal);
      matchedLot.remainingBasisBaseDecimal = normalizeDecimal(
        subtract(parseDecimal(lot.remainingBasisBaseDecimal!)!, basisDecimal)!,
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

    const status: BasisStatus =
      lot.basisStatus === "complete" &&
      (sale.proceedsStatus ?? "complete") === "complete"
        ? "complete"
        : lot.basisStatus === "incomplete_fx" ||
            sale.proceedsStatus === "incomplete_fx"
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
        feeAllocation.value === null
          ? { coefficient: 0n, scale: 0 }
          : parseDecimal(feeAllocation.value)!;
      const tax =
        taxAllocation.value === null
          ? { coefficient: 0n, scale: 0 }
          : parseDecimal(taxAllocation.value)!;
      if (proceeds) {
        const net = subtract(subtract(proceeds, fee)!, tax)!;
        gain = signedDifference(net, parseDecimal(basis)!);
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
  if (!numerator || !denominator) {
    return null;
  }

  return lots.map((lot) => {
    const quantity = positiveDecimal(lot.openQuantityDecimal);
    if (!quantity) {
      return { ...lot };
    }
    const adjusted = divideRounded(
      multiply(quantity, numerator),
      denominator,
      18,
    );
    return adjusted
      ? { ...lot, openQuantityDecimal: normalizeDecimal(adjusted) }
      : { ...lot };
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
