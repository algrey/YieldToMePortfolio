import Link from "next/link";
import { notFound } from "next/navigation";
import { loadAuthenticatedWorkspace } from "../../../../authenticated-workspace";
import { ManualLedgerEntry } from "../../../../components/manual-ledger-entry";
import { createManualLedgerMutationKeyRepository } from "../../../../../db/repositories/manual-ledger-keys";
import {
  loadOwnedManualLedgerOptions,
  type ManualLedgerOptions,
} from "../../../../../db/repositories/manual-ledger-options";
import { getAuthenticatedSqlContext } from "../../../../portfolio-actions";
import {
  MANUAL_LEDGER_TYPES,
  type ManualLedgerType,
} from "../../../../manual-ledger-contract";

type ManualLedgerEntryPageProps = {
  params: Promise<{ portfolioId: string }>;
  searchParams: Promise<{ type?: string }>;
};

// UI-005E follow-up: the shell's "Add holding" shortcut prefills the entry
// type via a query param; anything unrecognised (or absent) falls back to
// the form's existing "buy" default rather than trusting the raw string.
function initialEntryType(
  raw: string | undefined,
): ManualLedgerType | undefined {
  return (MANUAL_LEDGER_TYPES as readonly string[]).includes(raw ?? "")
    ? (raw as ManualLedgerType)
    : undefined;
}

export default async function ManualLedgerEntryPage({
  params,
  searchParams,
}: ManualLedgerEntryPageProps) {
  const { portfolioId } = await params;
  const query = await searchParams;
  const initialType = initialEntryType(query.type);
  const workspace = await loadAuthenticatedWorkspace(portfolioId);

  if (workspace.status === "unavailable") {
    return (
      <main className="manual-workflow-placeholder">
        <section className="empty-state" aria-labelledby="ledger-unavailable">
          <p className="eyebrow">Private ledger</p>
          <h1 id="ledger-unavailable">Manual entry unavailable</h1>
          <p>
            The owned portfolio could not be verified. No portfolio data or
            financial form is shown.
          </p>
        </section>
      </main>
    );
  }

  if (workspace.activePortfolio === null) notFound();

  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) {
    return (
      <main className="manual-workflow-placeholder">
        <section
          className="empty-state"
          aria-labelledby="ledger-options-unavailable"
        >
          <p className="eyebrow">Private ledger</p>
          <h1 id="ledger-options-unavailable">Manual entry unavailable</h1>
          <p>
            The owned ledger options could not be loaded. No mutation form is
            shown.
          </p>
          <Link href={`/portfolio/${portfolioId}/details`}>
            Return to portfolio details
          </Link>
        </section>
      </main>
    );
  }
  let options: ManualLedgerOptions;
  let initialIdempotencyKey: string;
  try {
    options = await loadOwnedManualLedgerOptions(
      context.client,
      context.userId,
      portfolioId,
    );
    const issued = await createManualLedgerMutationKeyRepository(
      context.client,
    ).issue(context.userId, portfolioId, "create", null);
    if (!issued) throw new Error("manual_ledger_key_unavailable");
    initialIdempotencyKey = issued.key;
  } catch {
    return (
      <main className="manual-workflow-placeholder">
        <section
          className="empty-state"
          aria-labelledby="ledger-options-unavailable"
        >
          <p className="eyebrow">Private ledger</p>
          <h1 id="ledger-options-unavailable">Manual entry unavailable</h1>
          <p>
            The owned ledger options could not be loaded. No mutation form is
            shown.
          </p>
          <Link href={`/portfolio/${portfolioId}/details`}>
            Return to portfolio details
          </Link>
        </section>
      </main>
    );
  }
  return (
    <ManualLedgerEntry
      portfolioId={portfolioId}
      baseCurrencyCode={workspace.activePortfolio.baseCurrencyCode}
      options={options}
      initialIdempotencyKey={initialIdempotencyKey}
      initialType={initialType}
    />
  );
}
