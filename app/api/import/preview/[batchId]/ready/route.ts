import { markImportReadyAction } from "../../../../../import-actions";
import { createImportReadyPost } from "../../../../../import-ready-route";

export const POST = createImportReadyPost(markImportReadyAction);
