export type ValidityDatedMapping = {
  id: string;
  validFrom: string;
  validTo: string | null;
};

export type MappingConflict = {
  conflictingMappingId: string;
  reason: "overlapping-validity";
};

/**
 * Date-only validity intervals are inclusive. A null end date is open-ended.
 * Database constraints protect each interval's shape; this service rule protects
 * against overlapping ownership of an identifier or provider symbol.
 */
export function findValidityConflict(
  candidate: ValidityDatedMapping,
  existing: readonly ValidityDatedMapping[],
): MappingConflict | null {
  for (const mapping of existing) {
    if (mapping.id === candidate.id) {
      continue;
    }

    const candidateEndsBeforeMapping =
      candidate.validTo !== null && candidate.validTo < mapping.validFrom;
    const mappingEndsBeforeCandidate =
      mapping.validTo !== null && mapping.validTo < candidate.validFrom;

    if (!candidateEndsBeforeMapping && !mappingEndsBeforeCandidate) {
      return {
        conflictingMappingId: mapping.id,
        reason: "overlapping-validity",
      };
    }
  }

  return null;
}
