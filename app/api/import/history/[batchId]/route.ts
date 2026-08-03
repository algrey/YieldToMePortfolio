import { loadImportBatchHistoryAction } from "../../../../import-history-actions.ts";
import { createImportBatchHistoryGet } from "../../../../import-history-route.ts";

export const GET = createImportBatchHistoryGet(loadImportBatchHistoryAction);
