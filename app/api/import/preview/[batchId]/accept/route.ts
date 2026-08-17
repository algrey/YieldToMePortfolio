import { acceptImportAction } from "../../../../../import-accept-actions.ts";
import { createImportAcceptPost } from "../../../../../import-accept-route.ts";

export const POST = createImportAcceptPost(acceptImportAction);
