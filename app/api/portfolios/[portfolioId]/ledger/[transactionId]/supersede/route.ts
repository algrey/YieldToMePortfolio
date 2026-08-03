import { supersedeManualLedgerAction } from "../../../../../../manual-ledger-actions.ts";
import { createManualLedgerTransactionPost } from "../../../../../../manual-ledger-route.ts";

export const POST = createManualLedgerTransactionPost(
  supersedeManualLedgerAction,
);
