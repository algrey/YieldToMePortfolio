import { reverseImportAction } from "../../../../../import-reversal-actions.ts";
import { createImportReversalPost } from "../../../../../import-reversal-route.ts";

export const POST = createImportReversalPost(reverseImportAction);
