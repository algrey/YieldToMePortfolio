import { setImportRowExclusionAction } from "../../../../../import-actions";
import { createImportRowExclusionPost } from "../../../../../import-row-exclusion-route";

export const POST = createImportRowExclusionPost(setImportRowExclusionAction);
