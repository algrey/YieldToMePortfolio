import { createManualLedgerAction } from "../../../../manual-ledger-actions.ts";
import { createManualLedgerPortfolioPost } from "../../../../manual-ledger-route.ts";

export const POST = createManualLedgerPortfolioPost(createManualLedgerAction);
